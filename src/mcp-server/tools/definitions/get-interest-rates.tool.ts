/**
 * @fileoverview Average interest rates Treasury pays on outstanding securities
 * by type — marketable issues, non-marketable series, and aggregate totals.
 * Updated monthly. Two modes: latest snapshot or time series.
 * @module mcp-server/tools/definitions/get-interest-rates
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createEndpointFetcher,
  type EndpointFetcher,
  type PageOptions,
} from '@/mcp-server/tools/endpoint-fetcher.js';
import { markdownValue, quotedNotice } from '@/mcp-server/tools/markdown-encoding.js';
import { getCanvasBridge, maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';

const RATES_ENDPOINT = '/v2/accounting/od/avg_interest_rates';

/**
 * Rows per request. The API's ceiling is 10,000 — `page[size]` above it is
 * rejected outright (the 404 every rejected query gets) rather than clamped —
 * and the whole corpus is 4,993 records, so one page reaches every matched set
 * this endpoint can produce.
 */
const SERIES_PAGE_SIZE = 10_000;

/**
 * Rows fetched for mode=latest. A month is a bounded set: the largest single
 * record_date in the corpus holds 17 rows, against 22 distinct security
 * descriptions ever published. The page is sorted newest-first and the month is
 * taken from it, so any bound above the widest month returns it whole.
 */
const LATEST_PAGE_SIZE = 100;

/**
 * Series rows returned inline. The cap is unconditional — the full history is
 * 4,993 records, which renders past a megabyte across `structuredContent` and
 * `content[]` combined, whether or not a canvas absorbed the remainder.
 */
const SERIES_PREVIEW_LIMIT = 20;

/**
 * Record count and date span for one security type across the whole dataset, or
 * undefined when no record carries that name. Two one-row probes rather than a
 * full pull, so the cost stays flat as the corpus grows.
 */
async function securityTypeSpan(
  fetchRates: EndpointFetcher,
  securityType: string,
): Promise<{ records: number; oldest: string; newest: string } | undefined> {
  const probe: PageOptions = {
    filters: [{ field: 'security_desc', operator: 'eq', value: securityType }],
    fields: ['record_date'],
    pageSize: 1,
  };
  const [newest, oldest] = await Promise.all([
    fetchRates({ ...probe, sort: '-record_date' }),
    fetchRates({ ...probe, sort: 'record_date' }),
  ]);
  const records = newest.meta['total-count'];
  if (records === 0) return;
  return {
    records,
    newest: newest.data[0]?.['record_date'] ?? '',
    oldest: oldest.data[0]?.['record_date'] ?? '',
  };
}

/** The security types the most recently published month carries. */
async function currentSecurityTypes(
  fetchRates: EndpointFetcher,
): Promise<{ asOf: string; types: string[] }> {
  const page = await fetchRates({
    fields: ['record_date', 'security_desc'],
    sort: '-record_date',
    pageSize: LATEST_PAGE_SIZE,
  });
  const asOf = page.data[0]?.['record_date'] ?? '';
  const types = [
    ...new Set(page.data.filter((r) => r['record_date'] === asOf).map((r) => r['security_desc'])),
  ].filter((desc): desc is string => Boolean(desc));
  return { asOf, types };
}

/**
 * Why a request could not be answered, when the failure is the upstream's
 * availability — its budget ran out, or the API was down — rather than
 * anything about the request. Undefined for every other failure.
 */
function unavailableBecause(error: unknown): string | undefined {
  if (!(error instanceof McpError)) return;
  if (error.code === JsonRpcErrorCode.Timeout) {
    return "the Fiscal Data API did not answer within this call's time budget";
  }
  if (error.code === JsonRpcErrorCode.ServiceUnavailable) {
    return 'the Fiscal Data API was unavailable';
  }
  return;
}

/**
 * Guidance for a query that matched nothing, read off the data rather than a
 * vocabulary written down here. Which security types Treasury publishes is not
 * fixed — Foreign Series was published through March 2026, Special Purpose
 * Vehicle first appeared in 2020 — so a list compiled at authoring time is
 * wrong the moment upstream moves, and being right about it is the whole
 * service this notice performs.
 */
async function emptyResultGuidance(
  ctx: Context,
  fetchRates: EndpointFetcher,
  query: { mode: 'latest' | 'series'; securityType: string; hasDateRange: boolean },
): Promise<string> {
  const { mode, securityType, hasDateRange } = query;

  if (!securityType) {
    return mode === 'series'
      ? 'No interest rate records found in that date range. Records are end-of-month — widen start_date/end_date to cover a month end.'
      : 'No interest rate records found.';
  }

  /**
   * A real security type may simply not have been published across the months
   * requested. The probe is unbounded by date, so it separates that from a name
   * the dataset has never held — and the span it returns is what makes "widen
   * the range" actionable.
   *
   * The condition is a range having been sent, not the mode. Latest mode sends
   * none; so does a series given neither bound, and there the main fetch has
   * already run this exact unbounded filter and matched nothing — the probe
   * would re-ask a question upstream just answered, and an empty match has no
   * dates to report back.
   */
  if (hasDateRange) {
    const span = await securityTypeSpan(fetchRates, securityType);
    if (span) {
      return `No records for security_type="${securityType}" in that date range. That type has ${span.records} records, running ${span.oldest} to ${span.newest} (end-of-month) — widen start_date/end_date to cover it.`;
    }
  }

  const segments = [
    `No records for security_type="${securityType}" — no record in this dataset carries that name.`,
  ];

  /**
   * The listing is the one request here that settles nothing: the answer — an
   * empty match — and the verdict on the name are already in hand, and it only
   * adds the names on offer. An upstream that is down or out of budget costs
   * that list, not the answer. Any other failure, and the caller's own
   * cancellation, still end the call.
   */
  let listing: { asOf: string; types: string[] };
  try {
    listing = await currentSecurityTypes(fetchRates);
  } catch (error) {
    const because = ctx.signal.aborted ? undefined : unavailableBecause(error);
    if (!because) throw error;
    ctx.log.warning('Security-type listing failed; answering without it', { because });
    segments.push(
      `The security types the most recent month carries could not be fetched — ${because}. Call treasury_get_interest_rates with mode=latest and no security_type to list them.`,
    );
    return segments.join(' ');
  }

  const { asOf, types } = listing;
  if (types.length > 0) {
    segments.push(`Security types in the most recent month (${asOf}): ${types.join(', ')}.`);
    segments.push(
      'Types Treasury no longer publishes are absent from that list and still reachable — filtering on one returns its last published month.',
    );
  }
  return segments.join(' ');
}

export const getInterestRatesTool = tool('treasury_get_interest_rates', {
  title: 'Get Treasury Interest Rates',
  description:
    'Average interest rates Treasury pays on its outstanding securities by security type. Answers "what is the government\'s cost of borrowing?" Covers every type Treasury reports — marketable issues, non-marketable series, and the aggregate totals — and which types it reports changes over the years, so omit security_type to see the ones a given period carries. Rates are percentages, not basis points. Updated monthly (end-of-month records). Mode "latest" returns the most recent month\'s rates for all or one security type; "series" returns a time history, staging the result as a DataCanvas table when canvas_id is set or the range matches more than 200 rows — read the table\'s column schema with treasury_dataframe_describe, then run SQL over it with treasury_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline series array holds fewer rows than were retrieved.'),
    shown: z.number().optional().describe('Series rows returned inline.'),
    cap: z.number().optional().describe('The preview cap applied to the inline series array.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no records match (where the requested security type does have records, or the types the most recent month carries — or why that list could not be fetched — or the empty date range), when the inline series is a preview, or when the series was staged as a DataCanvas table.',
      ),
  },
  enrichmentTrailer: { notice: { render: quotedNotice } },

  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'security_type, start_date, or end_date contains a comma, which the API would read as the start of another filter condition — the call is refused before any request',
      recovery:
        'Send security_type as one exact security_desc name and start_date/end_date as plain YYYY-MM-DD dates; no filter value can carry a comma. Omit security_type to see the names on offer.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_schema_changed',
      code: JsonRpcErrorCode.InternalError,
      when: 'The average-interest-rates endpoint no longer has a field this tool requests, or its response no longer lists a field this tool reads — the API renamed or dropped it',
      recovery: `Query ${RATES_ENDPOINT} with treasury_query_dataset; omit fields to see the fields it has now.`,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    mode: z
      .enum(['latest', 'series'])
      .default('latest')
      .describe('"latest" returns the most recent month\'s rates. "series" returns a time range.'),
    security_type: z
      .string()
      .optional()
      .describe(
        'Filter to one security type, matched exactly against the security_desc field — full case and punctuation, as in "Treasury Inflation-Protected Securities (TIPS)". Omit for every type in the period, which is how to read the set of types on offer; the response names them when a filter matches nothing.',
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 start date for mode=series (YYYY-MM-DD, must be end-of-month for meaningful results).',
      ),
    end_date: z
      .string()
      .optional()
      .describe('ISO 8601 end date for mode=series. Defaults to today.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Set any non-empty value to stage mode=series results as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. Staging also happens on its own when a series matches more than 200 rows. The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Requires CANVAS_PROVIDER_TYPE=duckdb.',
      ),
  }),

  output: z.object({
    as_of_date: z.string().describe('Most recent record date returned (YYYY-MM-DD).'),
    rates: z
      .array(
        z
          .object({
            record_date: z.string().describe('Record date (YYYY-MM-DD).'),
            security_type: z
              .string()
              .describe('Security type (Marketable, Non-marketable, Interest-bearing Debt).'),
            security_desc: z.string().describe('Security description (e.g., Treasury Bills).'),
            avg_interest_rate_pct: z
              .string()
              .describe(
                'Average interest rate as a percentage string (e.g., "3.696"). Not basis points.',
              ),
          })
          .describe('One interest rate record.'),
      )
      .describe(
        `Interest rate records, newest first. Whole in mode=latest — a month is a bounded set. In mode=series an inline preview of at most ${SERIES_PREVIEW_LIMIT} rows; compare its length against total_records to detect the cap, and reach the rest through canvas_id when one is returned.`,
      ),
    total_records: z
      .number()
      .describe(
        'In mode=latest, the number of rows in rates. In mode=series, the full upstream match — larger than rates.length whenever the preview cap applied.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DuckDB table name (df_XXXXX_XXXXX) holding the staged series. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.',
      ),
    canvas_expires_at: z.string().optional().describe('ISO 8601 expiry for the canvas dataframe.'),
  }),

  async handler(input, ctx) {
    const securityType = input.security_type?.trim() ?? '';

    // security_desc carries security_type; record_date carries start_date (gte) and end_date (lte).
    const fetchRates = createEndpointFetcher({
      ctx,
      endpoint: RATES_ENDPOINT,
      budgetStart: Date.now(),
      reads: ['record_date', 'security_type_desc', 'security_desc', 'avg_interest_rate_amt'],
      inputFor: (field, value) =>
        field === 'security_desc'
          ? 'security_type'
          : value === input.start_date
            ? 'start_date'
            : 'end_date',
    });

    const ratesOpts: PageOptions = {
      sort: '-record_date',
      pageSize: input.mode === 'latest' ? LATEST_PAGE_SIZE : SERIES_PAGE_SIZE,
    };

    if (securityType) {
      ratesOpts.filters = [{ field: 'security_desc', operator: 'eq', value: securityType }];
    }

    const hasDateRange =
      input.mode === 'series' && Boolean(input.start_date?.trim() || input.end_date?.trim());

    if (input.mode === 'series') {
      const seriesFilters = ratesOpts.filters ? [...ratesOpts.filters] : [];
      if (input.start_date?.trim()) {
        seriesFilters.push({ field: 'record_date', operator: 'gte', value: input.start_date });
      }
      if (input.end_date?.trim()) {
        seriesFilters.push({ field: 'record_date', operator: 'lte', value: input.end_date });
      }
      if (seriesFilters.length) ratesOpts.filters = seriesFilters;
    }

    const envelope = await fetchRates(ratesOpts);

    const totalRecords = envelope.meta['total-count'];

    if (totalRecords === 0) {
      /**
       * Name only the constraint that was actually the problem. A date range is
       * sent in series mode alone, and a security type that does hold records
       * elsewhere in the dataset is not the suspect when a range is also in
       * play — blaming either one blind sends the caller to check something
       * that was never wrong.
       */
      ctx.enrich.notice(
        await emptyResultGuidance(ctx, fetchRates, {
          mode: input.mode,
          securityType,
          hasDateRange,
        }),
      );
      return {
        as_of_date: '',
        rates: [],
        total_records: 0,
      };
    }

    // For latest mode, scope to the most-recent record_date only
    let rows = envelope.data;
    const asOfDate = rows[0]?.['record_date'] ?? '';

    if (input.mode === 'latest' && asOfDate) {
      rows = rows.filter((r) => r['record_date'] === asOfDate);
    }

    ctx.log.info('Interest rates fetched', {
      mode: input.mode,
      asOfDate,
      rows: rows.length,
      totalRecords,
    });

    const mapped = rows.map((r) => ({
      record_date: r['record_date'] ?? '',
      security_type: r['security_type_desc'] ?? '',
      security_desc: r['security_desc'] ?? '',
      avg_interest_rate_pct: r['avg_interest_rate_amt'] ?? '',
    }));

    // Spill to canvas when canvas_id provided or series > 200 rows
    const shouldSpill =
      input.mode === 'series' &&
      ((input.canvas_id !== undefined && input.canvas_id !== '') || totalRecords > 200);

    const { canvasId, canvasExpiresAt } = shouldSpill
      ? await maybeRegisterDataframe(ctx, getCanvasBridge(), envelope.data, {
          rows: envelope.data,
          sourceTool: 'treasury_get_interest_rates',
          queryParams: {
            mode: input.mode,
            security_type: securityType || undefined,
            start_date: input.start_date,
            end_date: input.end_date,
          },
        })
      : {};

    /**
     * The cap is unconditional, so the disclosure keys on the arithmetic rather
     * than on a canvas being present: the inline array is short whenever fewer
     * rows come back than were retrieved, and an install where
     * CANVAS_PROVIDER_TYPE=none and nothing absorbs the remainder is
     * exactly the case that needs saying so.
     *
     * A month is bounded (17 rows at its widest), so mode=latest returns whole.
     */
    const preview = input.mode === 'series' ? mapped.slice(0, SERIES_PREVIEW_LIMIT) : mapped;
    const previewIsShort = preview.length < mapped.length;

    /**
     * Both disclosures write the same `notice` key, so they are composed into
     * one string — `ctx.enrich.notice`, and the `notice` that
     * `ctx.enrich.truncated` writes, are last-wins.
     */
    const segments: string[] = [];
    if (previewIsShort) {
      segments.push(`Showing ${preview.length} of ${mapped.length} retrieved rows inline.`);
    }
    /**
     * Three states, not two: staging can be un-attempted, attempted and staged,
     * or attempted and unavailable. `shouldSpill` carries what was asked for, so
     * the last state stops advising a caller to pass the canvas_id they already
     * passed — or that the row threshold passed for them. The staged state is
     * disclosed even when nothing was held back: the handle in `canvas_id` is a
     * bare table name, and this is the only place the tools that read it are
     * named next to it.
     */
    if (canvasId) {
      segments.push(
        `The full retrieved set (${mapped.length} rows) is staged as table "${canvasId}". Read its column schema with treasury_dataframe_describe, then query it with treasury_dataframe_query — every column is VARCHAR, so CAST to DECIMAL or DATE for arithmetic.`,
      );
    } else if (shouldSpill) {
      segments.push(
        'The retrieved set could not be staged — DataCanvas requires CANVAS_PROVIDER_TYPE=duckdb on the server. Narrow start_date/end_date or filter security_type to bring the range inline.',
      );
    } else if (previewIsShort) {
      segments.push(
        'Pass canvas_id (requires CANVAS_PROVIDER_TYPE=duckdb) to reach the full set with treasury_dataframe_query, or narrow start_date/end_date.',
      );
    }

    if (segments.length > 0) {
      const guidance = segments.join(' ');
      if (previewIsShort) {
        ctx.enrich.truncated({ shown: preview.length, cap: SERIES_PREVIEW_LIMIT, guidance });
      } else {
        ctx.enrich.notice(guidance);
      }
    }

    return {
      as_of_date: asOfDate,
      rates: preview,
      total_records: input.mode === 'latest' ? rows.length : totalRecords,
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**As of:** ${markdownValue(result.as_of_date)}`);
    /**
     * Keyed on the arithmetic, not on a canvas being present — a preview is
     * short whether or not anything absorbed the rows it left out.
     */
    const truncated =
      result.rates.length < result.total_records
        ? ` (showing ${result.rates.length} of ${result.total_records})`
        : '';
    lines.push(`**Records:** ${result.total_records}${truncated}`);
    if (result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` (expires ${result.canvas_expires_at ?? 'unknown'})`,
      );
    }
    if (result.rates.length === 0) {
      lines.push('\n_No records._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    lines.push('| Date | Type | Security | Rate (%) |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of result.rates) {
      /**
       * Upstream reports a rate it does not have as the string "null", which
       * structuredContent carries as is; a percent sign after it would state a
       * rate of "null", so it renders as the bare word.
       */
      const rate =
        r.avg_interest_rate_pct === 'null'
          ? r.avg_interest_rate_pct
          : `${markdownValue(r.avg_interest_rate_pct)}%`;
      lines.push(
        `| ${markdownValue(r.record_date)} | ${markdownValue(r.security_type)} | ${markdownValue(r.security_desc)} | ${rate} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
