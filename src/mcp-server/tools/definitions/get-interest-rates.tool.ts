/**
 * @fileoverview Average interest rates Treasury pays on outstanding securities
 * by type. Covers Bills, Notes, Bonds, TIPS, FRN, and aggregate totals.
 * Updated monthly. Two modes: latest snapshot or time series.
 * @module mcp-server/tools/definitions/get-interest-rates
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCanvasBridge, maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const RATES_ENDPOINT = '/v2/accounting/od/avg_interest_rates';

/**
 * Rows per request. The API's ceiling is 10,000 — `page[size]` above it is
 * rejected outright rather than clamped — and the whole corpus is 4,993 records,
 * so one page reaches every matched set this endpoint can produce.
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

const SECURITY_DESCS = [
  'Treasury Bills',
  'Treasury Notes',
  'Treasury Bonds',
  'Treasury Inflation-Protected Securities (TIPS)',
  'Treasury Floating Rate Notes (FRN)',
  'Total Marketable',
  'Total Non-marketable',
  'Total Interest-bearing Debt',
] as const;

export const getInterestRatesTool = tool('treasury_get_interest_rates', {
  title: 'Get Treasury Interest Rates',
  description:
    'Average interest rates Treasury pays on its outstanding securities by security type. Answers "what is the government\'s cost of borrowing?" Covers Bills, Notes, Bonds, TIPS, Floating Rate Notes, and aggregate marketable/non-marketable totals. Rates are percentages, not basis points. Updated monthly (end-of-month records). Mode "latest" returns the most recent month\'s rates for all or one security type; "series" returns a time history, staging the result as a DataCanvas table when canvas_id is set or the range matches more than 200 rows — read the table\'s column schema with treasury_dataframe_describe, then run SQL over it with treasury_dataframe_query.',
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
        'Guidance when no records match (lists valid security types, or notes the empty date range), when the inline series is a preview, or when the series was staged as a DataCanvas table.',
      ),
  },

  input: z.object({
    mode: z
      .enum(['latest', 'series'])
      .default('latest')
      .describe('"latest" returns the most recent month\'s rates. "series" returns a time range.'),
    security_type: z
      .enum(SECURITY_DESCS)
      .optional()
      .describe(
        'Filter to one security type. Omit for all types. Use the exact string — the API does exact-match filtering on security_desc.',
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
    const svc = getFiscalDataService();

    const ratesOpts: Parameters<typeof svc.fetchPage>[2] = {
      sort: '-record_date',
      pageSize: input.mode === 'latest' ? LATEST_PAGE_SIZE : SERIES_PAGE_SIZE,
    };

    if (input.security_type?.trim()) {
      ratesOpts.filters = [{ field: 'security_desc', operator: 'eq', value: input.security_type }];
    }

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

    const envelope = await svc.fetchPage(ctx, RATES_ENDPOINT, ratesOpts);

    const totalRecords = envelope.meta['total-count'];

    if (totalRecords === 0) {
      /**
       * Name every constraint the query actually carried. A date range is only
       * sent in series mode, and a filtered security type is not the suspect
       * when a range is also in play — blaming either one alone sends the caller
       * to check something that was never the problem.
       */
      const inRange = input.mode === 'series' ? ' in that date range' : '';
      const rangeHint =
        input.mode === 'series'
          ? ' Records are end-of-month — widen start_date/end_date to cover a month end.'
          : '';
      ctx.enrich.notice(
        input.security_type
          ? `No records found for security_type="${input.security_type}"${inRange}. Valid values: ${SECURITY_DESCS.join(', ')}.${rangeHint}`
          : `No interest rate records found${inRange}.${rangeHint}`,
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
            security_type: input.security_type,
            start_date: input.start_date,
            end_date: input.end_date,
          },
        })
      : {};

    /**
     * The cap is unconditional, so the disclosure keys on the arithmetic rather
     * than on a canvas being present: the inline array is short whenever fewer
     * rows come back than were retrieved, and a default install — where
     * CANVAS_PROVIDER_TYPE is unset and nothing absorbs the remainder — is
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
    lines.push(`**As of:** ${result.as_of_date}`);
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
      lines.push(
        `| ${r.record_date} | ${r.security_type} | ${r.security_desc} | ${r.avg_interest_rate_pct}% |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
