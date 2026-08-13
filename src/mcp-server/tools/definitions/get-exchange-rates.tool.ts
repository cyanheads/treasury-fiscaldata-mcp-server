/**
 * @fileoverview Official Treasury reporting exchange rates — the statutory
 * rates US federal agencies must use when converting foreign currency to USD
 * for official reporting. Published quarterly. Not market rates.
 * @module mcp-server/tools/definitions/get-exchange-rates
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';
import type { FilterCondition } from '@/services/fiscal-data/types.js';

const RATES_ENDPOINT = '/v1/accounting/od/rates_of_exchange';

const RATE_NOTE =
  'These are official Treasury statutory reporting rates (foreign currency units per 1 USD), published quarterly. Required for federal agencies converting foreign-currency amounts to USD. Not market exchange rates — not suitable for financial transaction pricing.';

/**
 * Rows per request. This is the API's ceiling, not a preference — `page[size]`
 * above 10,000 is rejected outright ("Expected an integer between 1 and 10000"),
 * not clamped, so a larger matched set has to be walked with `page[number]`.
 */
const MAX_PAGE_SIZE = 10_000;

/**
 * Rows a series fetch will walk to across all pages. The published history is
 * ~19,000 rows growing ~700 a year, so a full-range pull already needs a second
 * page; this leaves decades of headroom while bounding the worst case at five
 * sequential upstream calls. When a matched set exceeds it, the response reports
 * what was retrieved rather than the count it did not reach.
 */
const SERIES_MAX_ROWS = 50_000;

/**
 * Series rows returned inline. The cap is unconditional: a multi-year pull runs
 * to thousands of rows, paid twice — once as `structuredContent` and again as
 * rendered `content[]` — whether or not a canvas absorbed the remainder.
 * mode=latest is left whole, because a quarter is a bounded set.
 */
const SERIES_PREVIEW_LIMIT = 20;

/** True when `candidate` is the later publication of the same currency's rate. */
function supersedes(candidate: Record<string, string>, held: Record<string, string>): boolean {
  const candidateDate = candidate.record_date ?? '';
  const heldDate = held.record_date ?? '';
  if (candidateDate !== heldDate) return candidateDate > heldDate;
  return (candidate.effective_date ?? '') > (held.effective_date ?? '');
}

/**
 * Collapse to one row per currency — the operative rate: newest `record_date`,
 * and within it the newest `effective_date`.
 *
 * The identity is the currency, not the country. A country can hold two legal
 * tenders at once (`Cuba-Chavito` at 1.0 and `Cuba-Peso` at 24.0 in the same
 * quarter), so keying on country name drops one outright rather than selecting a
 * newer version of it. Within one currency, Treasury amends a quarterly rate by
 * republishing it under the same `record_date` with a later `effective_date`, so
 * `record_date` alone does not identify the current rate — the later
 * `effective_date` supersedes.
 *
 * Selection is explicit rather than trusting the API's row order within a date,
 * which is not documented as meaningful. No clock is read: an amendment
 * published ahead of its effective date is still returned, and its
 * `effective_date` discloses when it takes hold. Consulting "now" would make the
 * same query answer differently over time.
 */
function operativeRatePerCurrency(rows: Record<string, string>[]): Record<string, string>[] {
  const byCurrency = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const currency = row.country_currency_desc ?? '';
    const held = byCurrency.get(currency);
    if (!held || supersedes(row, held)) byCurrency.set(currency, row);
  }
  return [...byCurrency.values()];
}

export const getExchangeRatesTool = tool('treasury_get_exchange_rates', {
  title: 'Get Treasury Exchange Rates',
  description:
    'Official Treasury reporting exchange rates for ~165 countries — the rates US federal agencies are required to use when converting foreign currency to USD for official reporting. Published quarterly (March 31, June 30, Sep 30, Dec 31); mode "latest" returns the most recently published quarter. Rate is expressed as foreign currency units per 1 USD (e.g., a Japan-Yen rate of 159.41 means 1 USD = 159.41 JPY). These are NOT market exchange rates and are not suitable for financial transaction pricing. Mode "series" stages the result as a DataCanvas table when canvas_id is set or the range matches more than 500 rows — read the table\'s column schema with treasury_dataframe_describe, then run SQL over it with treasury_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline rates array holds fewer rows than were retrieved.'),
    shown: z.number().optional().describe('Rate rows returned inline.'),
    cap: z.number().optional().describe('The preview cap applied to the inline rates array.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a requested country matched no records, when the inline series is a preview, when the series was staged as a DataCanvas table, or when the returned rows were published in more than one quarter.',
      ),
  },

  errors: [
    {
      reason: 'country_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more requested countries have no records — API returns HTTP 200 with empty data[]; total-count is 0 or fewer countries were returned than requested',
      recovery:
        'Use mode=latest without countries filter to list all available country names. Country names must match exactly (e.g., "Korea" not "South Korea"). Check spelling and case.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['latest', 'series'])
      .default('latest')
      .describe(
        '"latest" returns the most recently published quarter\'s rates. "series" returns a date range of quarterly reports.',
      ),
    countries: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific countries by exact country name (e.g., ["Japan", "Germany", "France"]). Case-sensitive, matches the "country" field. Omit for every country in the quarter (~165).',
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 start date for mode=series. Rates are published end-of-quarter (March 31, June 30, Sep 30, Dec 31).',
      ),
    end_date: z.string().optional().describe('ISO 8601 end date for mode=series.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Set any non-empty value to stage mode=series results as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. Staging also happens on its own when a series matches more than 500 rows, which multi-year multi-country pulls do (~19,000 rows for the full history). The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Requires CANVAS_PROVIDER_TYPE=duckdb.',
      ),
  }),

  output: z.object({
    as_of_date: z
      .string()
      .describe(
        'Most recent quarter-end record_date among the returned rows (YYYY-MM-DD). Not necessarily a date every row shares — check mixed_record_dates.',
      ),
    effective_date: z
      .string()
      .describe(
        'Effective date of the as_of_date row (YYYY-MM-DD). Every row carries its own effective_date; this one does not describe the rest.',
      ),
    mixed_record_dates: z
      .boolean()
      .describe(
        "True when the retrieved rows were not all published on as_of_date — including rows past the inline preview. Read each row's record_date rather than applying the top-level date to the set.",
      ),
    rates: z
      .array(
        z
          .object({
            country: z.string().describe('Country name.'),
            currency: z.string().describe('Currency name.'),
            country_currency_desc: z
              .string()
              .describe(
                '"Country-Currency" combined label (e.g., "Japan-Yen"). Use for in= filter values.',
              ),
            exchange_rate: z
              .string()
              .describe(
                'Foreign currency units per 1 USD. A value of 159.41 for Japan-Yen means 1 USD = 159.41 JPY.',
              ),
            record_date: z
              .string()
              .describe('Quarter-end record date this rate was published under (YYYY-MM-DD).'),
            effective_date: z
              .string()
              .describe(
                'Date this rate takes effect (YYYY-MM-DD). Later than record_date when Treasury amends a rate mid-quarter, in which case the quarter carries more than one row for the country.',
              ),
          })
          .describe('One exchange rate record.'),
      )
      .describe(
        `Exchange rates for the requested countries/quarter, newest first. Whole in mode=latest — a quarter is a bounded set. In mode=series an inline preview of at most ${SERIES_PREVIEW_LIMIT} rows; compare its length against retrieved_records to detect the cap, and reach the rest through canvas_id when one is returned.`,
      ),
    total_records: z
      .number()
      .describe(
        'In mode=latest, the number of rows in rates. In mode=series, the full upstream match — larger than rates.length whenever the preview cap applied, and larger than retrieved_records when paging stopped first.',
      ),
    retrieved_records: z
      .number()
      .optional()
      .describe(
        'Rows actually fetched for mode=series across every page, and the row count of the canvas table when one was registered. Never larger than total_records.',
      ),
    note: z
      .string()
      .describe(
        'Contextual note reminding that these are official reporting rates, not market rates.',
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

    const filters: FilterCondition[] = [];

    // Country filter using `in` operator for multi-country, `eq` for single
    const countries = (input.countries ?? []).filter(Boolean);
    if (countries.length === 1 && countries[0] !== undefined) {
      filters.push({ field: 'country', operator: 'eq', value: countries[0] });
    } else if (countries.length > 1) {
      filters.push({ field: 'country', operator: 'in', value: countries });
    }

    if (input.mode === 'series') {
      if (input.start_date?.trim()) {
        filters.push({ field: 'record_date', operator: 'gte', value: input.start_date });
      }
      if (input.end_date?.trim()) {
        filters.push({ field: 'record_date', operator: 'lte', value: input.end_date });
      }
    } else if (countries.length === 0) {
      /**
       * A quarter is a bounded set — 170 to 201 rows across the last ten
       * published ones, and trending up — but which quarter is newest is not
       * known until the API is asked. A one-row probe names it and the fetch
       * below asks for that date, so the page carries the quarter whole against
       * the API's own 10,000-row ceiling. Taking a fixed slice of the newest
       * rows instead drops whichever row falls past the slice, and no field in
       * the response can tell: total_records counts what survived the
       * per-currency collapse, not the upstream match.
       */
      const probe = await svc.fetchPage(ctx, RATES_ENDPOINT, {
        sort: '-record_date',
        pageSize: 1,
      });
      const newestDate = probe.data[0]?.record_date;
      if (newestDate) {
        filters.push({ field: 'record_date', operator: 'eq', value: newestDate });
      }
    }

    /**
     * A series walks `page[number]` until the match is exhausted or the row
     * bound is reached — the full published history is ~19,000 rows against a
     * 10,000-row page ceiling, so one page does not cover it. `total-count` is
     * upstream truth about the match, not about what was retrieved; the two are
     * reported separately below so nothing claims a count it never fetched.
     */
    const fetched: Record<string, string>[] = [];
    let totalCount = 0;
    if (input.mode === 'series') {
      for (let pageNumber = 1; fetched.length < SERIES_MAX_ROWS; pageNumber++) {
        const page = await svc.fetchPage(ctx, RATES_ENDPOINT, {
          filters: filters.length ? filters : undefined,
          sort: '-record_date',
          pageSize: MAX_PAGE_SIZE,
          pageNumber,
        });
        totalCount = page.meta['total-count'];
        fetched.push(...page.data);
        if (page.data.length < MAX_PAGE_SIZE || fetched.length >= totalCount) break;
      }
    } else {
      const page = await svc.fetchPage(ctx, RATES_ENDPOINT, {
        filters: filters.length ? filters : undefined,
        sort: '-record_date',
        pageSize: MAX_PAGE_SIZE,
      });
      totalCount = page.meta['total-count'];
      fetched.push(...page.data);
    }

    const retrievedRecords = fetched.length;
    const incomplete = retrievedRecords < totalCount;

    // Check for empty results when countries were specified
    if (countries.length > 0 && totalCount === 0) {
      throw ctx.fail(
        'country_not_found',
        `No exchange rate records found for: ${countries.join(', ')}. Country names must match exactly.`,
        { countries, ...ctx.recoveryFor('country_not_found') },
      );
    }

    let rows = fetched;
    const latestDate = fetched[0]?.record_date ?? '';

    if (input.mode === 'latest') {
      /**
       * The two paths select identically and differ only in what they consider.
       * Unfiltered, "latest" is the newest published quarter — the report as
       * Treasury issued it. A country filter widens that window rather than
       * narrowing it: a country whose rate stopped being published individually
       * keeps its last one instead of dropping out, so the rows can straddle
       * quarters. Either way the rows that remain are collapsed to the operative
       * rate per currency, so a filtered call and an unfiltered call never
       * disagree about a currency they both return.
       */
      const candidates =
        countries.length === 0 && latestDate
          ? rows.filter((r) => r.record_date === latestDate)
          : rows;
      rows = operativeRatePerCurrency(candidates);
    }

    /**
     * One flush at the end — `ctx.enrich.notice`, and the `notice` that
     * `ctx.enrich.truncated` writes, are last-wins, so a second call would erase
     * the first.
     */
    const noticeSegments: string[] = [];

    /**
     * Partial mismatches (some countries returned, some absent), read off the
     * whole retrieved set rather than the date-narrowed one so countries with
     * older last-records aren't missed. A bounded fetch makes absence
     * uninterpretable — a country past the last page looks identical to one that
     * does not exist — so the wording follows what the fetch can support.
     */
    if (countries.length > 1 && retrievedRecords > 0) {
      const returnedCountries = new Set(fetched.map((r) => r.country));
      const missing = countries.filter((c) => !returnedCountries.has(c));
      if (missing.length > 0) {
        noticeSegments.push(
          incomplete
            ? `The following countries are absent from the rows retrieved: ${missing.join(', ')}. Only ${retrievedRecords} of ${totalCount} matching records were fetched, so a country whose last published rate falls past that point is missing rather than unknown — request fewer countries per call, then check spelling ("Korea", not "South Korea").`
            : `The following countries were not found: ${missing.join(', ')}. ` +
                'Country names must match exactly (e.g., "Korea" not "South Korea"). ' +
                'Use mode=latest without countries filter to list all available names.',
        );
      }
    }

    ctx.log.info('Exchange rates fetched', {
      mode: input.mode,
      latestDate,
      rows: rows.length,
      totalCount,
    });

    const mapped = rows.map((r) => ({
      country: r.country ?? '',
      currency: r.currency ?? '',
      country_currency_desc: r.country_currency_desc ?? '',
      exchange_rate: r.exchange_rate ?? '',
      record_date: r.record_date ?? '',
      effective_date: r.effective_date ?? '',
    }));

    // Spill to canvas when canvas_id provided or large series
    const shouldSpill =
      input.mode === 'series' &&
      ((input.canvas_id !== undefined && input.canvas_id !== '') || totalCount > 500);

    const { canvasId, canvasExpiresAt } = shouldSpill
      ? await maybeRegisterDataframe(ctx, getCanvasBridge(), fetched, {
          rows: fetched,
          sourceTool: 'treasury_get_exchange_rates',
          queryParams: {
            mode: input.mode,
            countries: input.countries,
            start_date: input.start_date,
            end_date: input.end_date,
          },
          truncated: incomplete,
          ...(incomplete && { maxRows: SERIES_MAX_ROWS }),
        })
      : {};

    /**
     * The cap is unconditional, so the preview disclosure keys on the
     * arithmetic rather than on a canvas being present: the inline array is
     * short whenever fewer rows come back than were kept, and a default install
     * — CANVAS_PROVIDER_TYPE unset, nothing absorbing the remainder — is exactly
     * the case that needs saying so.
     */
    const preview = input.mode === 'series' ? mapped.slice(0, SERIES_PREVIEW_LIMIT) : mapped;
    const previewIsShort = preview.length < mapped.length;

    if (previewIsShort) {
      noticeSegments.push(`Showing ${preview.length} of ${mapped.length} retrieved rows inline.`);
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
      noticeSegments.push(
        `The full retrieved set (${retrievedRecords} rows) is staged as table "${canvasId}". Read its column schema with treasury_dataframe_describe, then query it with treasury_dataframe_query — every column is VARCHAR, so CAST to DECIMAL or DATE for arithmetic.`,
      );
    } else if (shouldSpill) {
      noticeSegments.push(
        'The retrieved set could not be staged — DataCanvas requires CANVAS_PROVIDER_TYPE=duckdb on the server. Narrow start_date/end_date or filter countries to bring the range inline.',
      );
    } else if (previewIsShort) {
      noticeSegments.push(
        'Pass canvas_id (requires CANVAS_PROVIDER_TYPE=duckdb) to reach the full set with treasury_dataframe_query, or narrow start_date/end_date.',
      );
    }

    /**
     * A bounded fetch, disclosed. Only two things can bound one: the row bound
     * that stops the series page walk, and — in latest mode — a country filter
     * whose whole history outruns a single page. The unfiltered latest path asks
     * for one quarter by date, which the page ceiling covers many times over.
     */
    if (incomplete) {
      noticeSegments.push(
        input.mode === 'series'
          ? `Retrieved ${retrievedRecords} of ${totalCount} matching records — paging stops at ${SERIES_MAX_ROWS} rows. Narrow start_date/end_date or countries to reach the remainder.`
          : `Retrieved ${retrievedRecords} of ${totalCount} matching records — one page holds at most ${MAX_PAGE_SIZE}. Request fewer countries per call so every one of them is reached.`,
      );
    }

    /**
     * `as_of_date` names the newest record_date retrieved, not one the whole set
     * shares: mode=latest keeps a country's last published rate even when that
     * rate predates the newest quarter, so the rows can straddle years. Report
     * the disagreement instead of stamping a single date over the table —
     * `mixed_record_dates` says the top-level date does not generalize, and each
     * row's own record_date and effective_date carry what does. Read off the
     * retrieved set, not the preview: a quarter-sorted series has one date
     * across its first 20 rows and several across the rest.
     */
    const recordDates = [...new Set(mapped.map((r) => r.record_date).filter(Boolean))].sort();
    const mixedRecordDates = recordDates.length > 1;

    /**
     * A series is asked for as a date range, so spanning quarters is the shape
     * the caller requested — the flag still reports it, but guidance would be
     * noise. In latest mode the span is the surprise.
     */
    if (mixedRecordDates && input.mode === 'latest') {
      noticeSegments.push(
        `Returned rows span record dates ${recordDates[0]} to ${recordDates.at(-1)}, so as_of_date covers only the newest of them. ` +
          "Read each row's record_date before comparing rates across countries — a country with no rate in the newest quarter keeps its last published one.",
      );
    }

    if (noticeSegments.length > 0) {
      const guidance = noticeSegments.join(' ');
      if (previewIsShort) {
        ctx.enrich.truncated({ shown: preview.length, cap: SERIES_PREVIEW_LIMIT, guidance });
      } else {
        ctx.enrich.notice(guidance);
      }
    }

    return {
      as_of_date: latestDate,
      effective_date: rows[0]?.effective_date ?? latestDate ?? '',
      mixed_record_dates: mixedRecordDates,
      rates: preview,
      total_records: input.mode === 'series' ? totalCount : rows.length,
      ...(input.mode === 'series' && { retrieved_records: retrievedRecords }),
      note: RATE_NOTE,
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    /**
     * "As of" reads as a stamp over every row below it — the one claim a
     * mixed-date set cannot make.
     */
    if (result.mixed_record_dates) {
      lines.push(
        `**Newest record date:** ${result.as_of_date} (effective ${result.effective_date})`,
      );
      lines.push(
        '**Mixed record dates:** the retrieved rows were published in different quarters — read the Record Date on each.',
      );
    } else {
      lines.push(`**As of:** ${result.as_of_date} (effective ${result.effective_date})`);
    }
    /**
     * Keyed on the arithmetic, not on a canvas being present — a preview is
     * short whether or not anything absorbed the rows it left out.
     */
    const truncated =
      result.rates.length < result.total_records
        ? ` (showing ${result.rates.length} of ${result.total_records})`
        : '';
    lines.push(`**Records:** ${result.total_records}${truncated}`);
    if (result.retrieved_records !== undefined) {
      lines.push(`**Retrieved:** ${result.retrieved_records} rows`);
    }
    lines.push(`_${result.note}_`);
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
    lines.push(
      '| Country | Currency | Country-Currency | Rate (per 1 USD) | Record Date | Effective Date |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of result.rates) {
      lines.push(
        `| ${r.country} | ${r.currency} | ${r.country_currency_desc} | ${r.exchange_rate} | ${r.record_date} | ${r.effective_date} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
