/**
 * @fileoverview Official Treasury reporting exchange rates — the statutory
 * rates US federal agencies must use when converting foreign currency to USD
 * for official reporting. Published quarterly. Not market rates.
 * @module mcp-server/tools/definitions/get-exchange-rates
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const RATES_ENDPOINT = '/v1/accounting/od/rates_of_exchange';

const RATE_NOTE =
  'These are official Treasury statutory reporting rates (foreign currency units per 1 USD), published quarterly. Required for federal agencies converting foreign-currency amounts to USD. Not market exchange rates — not suitable for financial transaction pricing.';

export const getExchangeRatesTool = tool('treasury_get_exchange_rates', {
  title: 'Get Treasury Exchange Rates',
  description:
    'Official Treasury reporting exchange rates for ~130 countries — the rates US federal agencies are required to use when converting foreign currency to USD for official reporting. Published quarterly (March 31, June 30, Sep 30, Dec 31). Rate is expressed as foreign currency units per 1 USD (e.g., Japan-Yen: 159.41 means 1 USD = 159.41 JPY). These are NOT market exchange rates and are not suitable for financial transaction pricing. The latest quarter available is 2026-03-31 (Q1 2026).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when a requested country was not found or returned no records.'),
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
        'Filter to specific countries by exact country name (e.g., ["Japan", "Germany", "France"]). Case-sensitive, matches the "country" field. Omit for all ~130 countries in the quarter.',
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
        'DataCanvas table name (df_XXXXX_XXXXX) to register series results into for SQL analysis. Useful when pulling multi-year history for many countries (~18,800 rows total). When provided, or when mode=series and results exceed 500 rows, the result is registered and canvas_id is returned. Use treasury_dataframe_query to query it. Requires CANVAS_PROVIDER_TYPE=duckdb.',
      ),
  }),

  output: z.object({
    as_of_date: z.string().describe('Quarter-end date of the most recent rates (YYYY-MM-DD).'),
    effective_date: z.string().describe('Effective date of the rates (same as record_date).'),
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
            record_date: z.string().describe('Quarter-end record date (YYYY-MM-DD).'),
          })
          .describe('One exchange rate record.'),
      )
      .describe('Exchange rates for the requested countries/quarter.'),
    total_records: z.number().describe('Total records returned.'),
    note: z
      .string()
      .describe(
        'Contextual note reminding that these are official reporting rates, not market rates.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas table name for series results. Use treasury_dataframe_query to run SQL.',
      ),
    canvas_expires_at: z.string().optional().describe('ISO 8601 expiry for the canvas dataframe.'),
  }),

  async handler(input, ctx) {
    const svc = getFiscalDataService();

    const filters: import('@/services/fiscal-data/types.js').FilterCondition[] = [];

    // Country filter using `in` operator for multi-country, `eq` for single
    const countries = (input.countries ?? []).filter(Boolean);
    if (countries.length === 1 && countries[0] !== undefined) {
      filters.push({ field: 'country', operator: 'eq' as const, value: countries[0] });
    } else if (countries.length > 1) {
      filters.push({ field: 'country', operator: 'in' as const, value: countries });
    }

    if (input.mode === 'series') {
      if (input.start_date?.trim()) {
        filters.push({
          field: 'record_date',
          operator: 'gte' as const,
          value: input.start_date,
        });
      }
      if (input.end_date?.trim()) {
        filters.push({
          field: 'record_date',
          operator: 'lte' as const,
          value: input.end_date,
        });
      }
    }

    const pageSize = input.mode === 'latest' ? 200 : 10000;
    const envelope = await svc.fetchPage(ctx, RATES_ENDPOINT, {
      filters: filters.length ? filters : undefined,
      sort: '-record_date',
      pageSize,
    });

    const totalCount = envelope.meta['total-count'];

    // Check for empty results when countries were specified
    if (countries.length > 0 && totalCount === 0) {
      throw ctx.fail(
        'country_not_found',
        `No exchange rate records found for: ${countries.join(', ')}. Country names must match exactly.`,
        { countries, ...ctx.recoveryFor('country_not_found') },
      );
    }

    let rows = envelope.data;
    let latestDate = rows[0]?.record_date ?? '';

    if (input.mode === 'latest') {
      if (countries.length > 0) {
        // When filtering by country, each country has its own last-record date — don't collapse
        // to a single date or countries with stale last-records silently drop out.
        // Deduplicate to the most-recent record per country instead.
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const c = r.country ?? '';
          if (seen.has(c)) return false;
          seen.add(c);
          return true;
        });
      } else if (latestDate) {
        // No country filter — all countries share a single latest quarter, safe to date-filter.
        rows = rows.filter((r) => r.record_date === latestDate);
      }
    } else if (rows[0]) {
      latestDate = rows[0].record_date ?? '';
    }

    // Check for partial mismatches (some countries returned, some absent) — run on full
    // envelope.data (pre-date-filter) so countries with older last-records aren't missed.
    if (countries.length > 1 && envelope.data.length > 0) {
      const returnedCountries = new Set(envelope.data.map((r) => r.country));
      const missing = countries.filter((c) => !returnedCountries.has(c));
      if (missing.length > 0) {
        ctx.enrich.notice(
          `The following countries were not found: ${missing.join(', ')}. ` +
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
    }));

    // Spill to canvas when canvas_id provided or large series
    let canvasId: string | undefined;
    let canvasExpiresAt: string | undefined;
    const shouldSpill =
      input.mode === 'series' &&
      ((input.canvas_id !== undefined && input.canvas_id !== '') || totalCount > 500);

    if (shouldSpill) {
      const bridge = getCanvasBridge();
      if (bridge && envelope.data.length > 0) {
        const registered = await bridge.registerDataframe(ctx, {
          rows: envelope.data,
          sourceTool: 'treasury_get_exchange_rates',
          queryParams: {
            mode: input.mode,
            countries: input.countries,
            start_date: input.start_date,
            end_date: input.end_date,
          },
        });
        if (registered) {
          canvasId = registered.tableName;
          canvasExpiresAt = registered.expiresAt;
        }
      }
    }

    const preview = canvasId ? mapped.slice(0, 20) : mapped;

    return {
      as_of_date: latestDate,
      effective_date: rows[0]?.effective_date ?? latestDate ?? '',
      rates: preview,
      total_records: input.mode === 'series' ? totalCount : rows.length,
      note: RATE_NOTE,
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**As of:** ${result.as_of_date} (effective ${result.effective_date})`);
    const truncated =
      result.canvas_id && result.rates.length < result.total_records
        ? ` (showing ${result.rates.length} of ${result.total_records})`
        : '';
    lines.push(`**Records:** ${result.total_records}${truncated}`);
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
    lines.push('| Country | Currency | Country-Currency | Rate (per 1 USD) | Date |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of result.rates) {
      lines.push(
        `| ${r.country} | ${r.currency} | ${r.country_currency_desc} | ${r.exchange_rate} | ${r.record_date} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
