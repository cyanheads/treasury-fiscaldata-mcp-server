/**
 * @fileoverview Average interest rates Treasury pays on outstanding securities
 * by type. Covers Bills, Notes, Bonds, TIPS, FRN, and aggregate totals.
 * Updated monthly. Two modes: latest snapshot or time series.
 * @module mcp-server/tools/definitions/get-interest-rates
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const RATES_ENDPOINT = '/v2/accounting/od/avg_interest_rates';

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
    'Average interest rates Treasury pays on its outstanding securities by security type. Answers "what is the government\'s cost of borrowing?" Covers Bills, Notes, Bonds, TIPS, Floating Rate Notes, and aggregate marketable/non-marketable totals. Updated monthly (end-of-month records). Mode "latest" returns the most recent month\'s rates for all or one security type; "series" returns a time history. As of 2026-04-30: Bills 3.696%, Notes 3.230%, Bonds 3.403%, TIPS 1.068%, FRN 3.764%, Total Interest-bearing Debt 3.340%.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no records match — lists valid security types or notes the empty date range.',
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
        'DataCanvas table name (df_XXXXX_XXXXX) to register series results into for SQL analysis. When provided, or when mode=series and results exceed 200 rows, the result is registered and canvas_id is returned. Use treasury_dataframe_query to query it. Requires CANVAS_PROVIDER_TYPE=duckdb.',
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
      .describe('Interest rate records.'),
    total_records: z.number().describe('Total matching records.'),
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

    const ratesOpts: Parameters<typeof svc.fetchPage>[2] = {
      sort: '-record_date',
      pageSize: input.mode === 'latest' ? 100 : 10000,
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
      ctx.enrich.notice(
        input.security_type
          ? `No records found for security_type="${input.security_type}". Valid values: ${SECURITY_DESCS.join(', ')}.`
          : 'No interest rate records found for the specified date range.',
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
    let canvasId: string | undefined;
    let canvasExpiresAt: string | undefined;
    const shouldSpill =
      input.mode === 'series' &&
      ((input.canvas_id !== undefined && input.canvas_id !== '') || totalRecords > 200);

    if (shouldSpill) {
      const bridge = getCanvasBridge();
      if (bridge && envelope.data.length > 0) {
        const registered = await bridge.registerDataframe(ctx, {
          rows: envelope.data,
          sourceTool: 'treasury_get_interest_rates',
          queryParams: {
            mode: input.mode,
            security_type: input.security_type,
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
    const truncated =
      result.canvas_id && result.rates.length < result.total_records
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
