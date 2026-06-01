/**
 * @fileoverview National debt (Debt to the Penny) convenience tool. Returns
 * total public debt outstanding broken into publicly-held debt and
 * intragovernmental holdings. Three modes: latest, a specific date, or a
 * date-range series with optional DataCanvas spillover.
 * @module mcp-server/tools/definitions/get-debt
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const DEBT_ENDPOINT = '/v2/accounting/od/debt_to_penny';
const DEBT_FIELDS = [
  'record_date',
  'tot_pub_debt_out_amt',
  'debt_held_public_amt',
  'intragov_hold_amt',
];

export const getDebtTool = tool('treasury_get_debt', {
  title: 'Get National Debt',
  description:
    'Fetch national debt (Debt to the Penny) — total public debt outstanding broken into publicly-held debt and intragovernmental holdings. Three modes: "latest" returns the most recent business day\'s record; "date" returns the record for a specific date (must be a business day — the API only records debt on days markets are open); "series" returns a date range and optionally spills results to DataCanvas for SQL analysis via treasury_dataframe_query. Records go back to 1993-01-04. As of 2026-05-28 the total debt is approximately $39.18T.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  errors: [
    {
      reason: 'no_data_for_date',
      code: JsonRpcErrorCode.NotFound,
      when: 'No debt record exists for the requested date (API returns HTTP 200 with empty data[], not 404 — total-count is 0)',
      recovery:
        'Fiscal Data only records debt on business days from 1993-01-04 onward. Try the nearest business day, or use mode=series with a date range.',
    },
  ],

  input: z.object({
    mode: z
      .enum(['latest', 'date', 'series'])
      .default('latest')
      .describe(
        '"latest" returns the most recent day\'s record. "date" returns the record for a specific date. "series" returns a date range — use with start_date and end_date.',
      ),
    date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 date (YYYY-MM-DD) for mode=date. Must be a business day; the API only records debt on days the market is open.',
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'ISO 8601 start date for mode=series (inclusive). Fiscal Data has daily debt records back to 1993-01-04.',
      ),
    end_date: z
      .string()
      .optional()
      .describe('ISO 8601 end date for mode=series (inclusive). Defaults to today.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas table name (df_XXXXX_XXXXX) to register series results into for SQL analysis. When provided, or when the series exceeds 500 rows, the full result is registered and the name is returned in canvas_id. Use treasury_dataframe_query to run SQL against it. Requires CANVAS_PROVIDER_TYPE=duckdb.',
      ),
  }),

  output: z.object({
    record_date: z
      .string()
      .describe('Date of this debt record (YYYY-MM-DD). For series mode, the most recent date.'),
    total_debt: z
      .string()
      .describe(
        'Total public debt outstanding in USD (string — convert as needed). Example: "39176301795549.40".',
      ),
    debt_held_public: z
      .string()
      .describe('Debt held by the public (external creditors, Fed, foreign governments) in USD.'),
    intragovernmental_holdings: z
      .string()
      .describe(
        'Intragovernmental holdings (debt owed to federal trust funds, Social Security, etc.) in USD.',
      ),
    series: z
      .array(
        z
          .object({
            record_date: z.string().describe('Date of this record (YYYY-MM-DD).'),
            total_debt: z.string().describe('Total public debt outstanding in USD.'),
            debt_held_public: z.string().describe('Debt held by the public in USD.'),
            intragovernmental_holdings: z.string().describe('Intragovernmental holdings in USD.'),
          })
          .describe('One daily debt record.'),
      )
      .optional()
      .describe('All records for mode=series (may be truncated when spilled to canvas).'),
    total_records: z.number().optional().describe('Total matching records for mode=series.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas table name when series was spilled. Use treasury_dataframe_query to run SQL.',
      ),
    canvas_expires_at: z.string().optional().describe('ISO 8601 expiry for the canvas dataframe.'),
  }),

  async handler(input, ctx) {
    const svc = getFiscalDataService();

    if (input.mode === 'latest') {
      const envelope = await svc.fetchPage(ctx, DEBT_ENDPOINT, {
        fields: DEBT_FIELDS,
        sort: '-record_date',
        pageSize: 1,
      });
      const row = envelope.data[0];
      if (!row || envelope.meta['total-count'] === 0) {
        throw ctx.fail('no_data_for_date', 'No debt records found.', {
          ...ctx.recoveryFor('no_data_for_date'),
        });
      }
      return {
        record_date: row['record_date'] ?? '',
        total_debt: row['tot_pub_debt_out_amt'] ?? '',
        debt_held_public: row['debt_held_public_amt'] ?? '',
        intragovernmental_holdings: row['intragov_hold_amt'] ?? '',
      };
    }

    if (input.mode === 'date') {
      if (!input.date?.trim()) {
        throw ctx.fail('no_data_for_date', 'mode=date requires a date parameter (YYYY-MM-DD).', {
          ...ctx.recoveryFor('no_data_for_date'),
        });
      }
      const envelope = await svc.fetchPage(ctx, DEBT_ENDPOINT, {
        fields: DEBT_FIELDS,
        filters: [{ field: 'record_date', operator: 'eq', value: input.date }],
      });
      const row = envelope.data[0];
      if (!row || envelope.meta['total-count'] === 0) {
        throw ctx.fail(
          'no_data_for_date',
          `No debt record for ${input.date}. The API only records debt on business days.`,
          { date: input.date, ...ctx.recoveryFor('no_data_for_date') },
        );
      }
      return {
        record_date: row['record_date'] ?? '',
        total_debt: row['tot_pub_debt_out_amt'] ?? '',
        debt_held_public: row['debt_held_public_amt'] ?? '',
        intragovernmental_holdings: row['intragov_hold_amt'] ?? '',
      };
    }

    // mode === 'series'
    const seriesOpts: Parameters<typeof svc.fetchPage>[2] = {
      fields: DEBT_FIELDS,
      sort: '-record_date',
      pageSize: 10000,
    };
    if (input.start_date?.trim()) {
      seriesOpts.filters = [{ field: 'record_date', operator: 'gte', value: input.start_date }];
    }
    if (input.end_date?.trim()) {
      const existingFilters = seriesOpts.filters ?? [];
      seriesOpts.filters = [
        ...existingFilters,
        { field: 'record_date', operator: 'lte', value: input.end_date },
      ];
    }

    const envelope = await svc.fetchPage(ctx, DEBT_ENDPOINT, seriesOpts);

    const totalRecords = envelope.meta['total-count'];
    ctx.log.info('Debt series fetched', { totalRecords, rows: envelope.data.length });

    const mapped = envelope.data.map((row) => ({
      record_date: row['record_date'] ?? '',
      total_debt: row['tot_pub_debt_out_amt'] ?? '',
      debt_held_public: row['debt_held_public_amt'] ?? '',
      intragovernmental_holdings: row['intragov_hold_amt'] ?? '',
    }));

    // Spill to canvas when canvas_id is provided or series > 500 rows
    const shouldSpill =
      (input.canvas_id !== undefined && input.canvas_id !== '') || totalRecords > 500;

    const { canvasId, canvasExpiresAt } = shouldSpill
      ? await maybeRegisterDataframe(ctx, getCanvasBridge(), envelope.data, {
          rows: envelope.data,
          sourceTool: 'treasury_get_debt',
          queryParams: { mode: input.mode, start_date: input.start_date, end_date: input.end_date },
        })
      : {};

    const preview = mapped.slice(0, 20);
    const latestRow = mapped[0];

    return {
      record_date: latestRow?.record_date ?? '',
      total_debt: latestRow?.total_debt ?? '',
      debt_held_public: latestRow?.debt_held_public ?? '',
      intragovernmental_holdings: latestRow?.intragovernmental_holdings ?? '',
      series: preview,
      total_records: totalRecords,
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Record Date:** ${result.record_date}`);
    lines.push(`**Total Debt:** $${result.total_debt}`);
    lines.push(`**Debt Held by Public:** $${result.debt_held_public}`);
    lines.push(`**Intragovernmental Holdings:** $${result.intragovernmental_holdings}`);
    if (result.total_records !== undefined) {
      lines.push(`\n**Series:** ${result.total_records} total records`);
      if (result.canvas_id) {
        lines.push(
          `**Canvas:** \`${result.canvas_id}\` (expires ${result.canvas_expires_at ?? 'unknown'})`,
        );
      }
      if (result.series?.length) {
        lines.push('');
        lines.push('| Date | Total Debt | Held Public | Intragovernmental |');
        lines.push('| --- | --- | --- | --- |');
        for (const r of result.series) {
          lines.push(
            `| ${r.record_date} | $${r.total_debt} | $${r.debt_held_public} | $${r.intragovernmental_holdings} |`,
          );
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
