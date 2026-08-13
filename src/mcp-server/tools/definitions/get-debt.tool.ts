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

/**
 * Rows per series request. This is the API's ceiling, not a preference —
 * `page[size]` above 10000 is rejected outright ("Expected an integer between 1
 * and 10000"), not clamped, so a larger matched set has to be walked with
 * `page[number]`.
 */
const SERIES_PAGE_SIZE = 10_000;

/**
 * Rows the series fetch will walk to across all pages. Debt to the Penny holds
 * one record per business day — 8,369 today, growing ~250/year — so this is over
 * a century of headroom on a full-range request while bounding the worst case at
 * five sequential upstream calls. When a matched set exceeds it, the response
 * reports what was retrieved rather than the count it did not reach.
 */
const SERIES_MAX_ROWS = 50_000;

/**
 * Series rows returned inline. The cap is unconditional: the full daily range
 * is 8,369 records today, which renders to ~1.7 MB across `structuredContent`
 * and `content[]` combined — far past what any caller can read in one response.
 * Everything above the cap is reachable through the canvas table instead.
 */
const SERIES_PREVIEW_LIMIT = 20;

export const getDebtTool = tool('treasury_get_debt', {
  title: 'Get National Debt',
  description:
    'Fetch national debt (Debt to the Penny) — total public debt outstanding broken into publicly-held debt and intragovernmental holdings. Three modes: "latest" returns the most recent business day\'s record; "date" returns the record for a specific date (must be a business day — the API only records debt on days markets are open); "series" returns a date range and optionally spills results to DataCanvas for SQL analysis via treasury_dataframe_query. Records go back to 1993-01-04. As of 2026-05-28 the total debt is approximately $39.18T.',
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
        'Guidance when the inline series is a preview, or when paging stopped before the full matched set.',
      ),
  },

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
      .describe(
        `Inline preview of the mode=series records — at most ${SERIES_PREVIEW_LIMIT} rows, newest first. Compare series.length against retrieved_records to detect the cap; the full retrieved set is reachable through canvas_id when one is returned.`,
      ),
    total_records: z
      .number()
      .optional()
      .describe(
        'Records matching the date range upstream. Exceeds retrieved_records when the match is larger than the series row bound.',
      ),
    retrieved_records: z
      .number()
      .optional()
      .describe(
        'Records actually fetched for mode=series across every page, and the row count of the canvas table when one was registered. Never larger than total_records.',
      ),
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
        /**
         * Nothing was looked up, so the contract's business-day guidance would
         * answer a question the caller never asked. Point at the input they
         * omitted instead.
         */
        throw ctx.fail('no_data_for_date', 'mode=date requires a date parameter (YYYY-MM-DD).', {
          recovery: {
            hint: 'Supply date as YYYY-MM-DD, or switch to mode=latest for the most recent record.',
          },
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
      pageSize: SERIES_PAGE_SIZE,
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

    /**
     * Walk `page[number]` until the matched set is exhausted or the row bound is
     * reached. `total-count` is upstream truth about the match, not about what
     * this loop retrieved — the two are reported separately below so nothing
     * claims a count it never fetched.
     */
    const rows: Record<string, string>[] = [];
    let totalRecords = 0;
    for (let pageNumber = 1; rows.length < SERIES_MAX_ROWS; pageNumber++) {
      const envelope = await svc.fetchPage(ctx, DEBT_ENDPOINT, { ...seriesOpts, pageNumber });
      totalRecords = envelope.meta['total-count'];
      rows.push(...envelope.data);
      if (envelope.data.length < SERIES_PAGE_SIZE || rows.length >= totalRecords) break;
    }

    const retrievedRecords = rows.length;
    const incomplete = retrievedRecords < totalRecords;
    ctx.log.info('Debt series fetched', { totalRecords, retrievedRecords, incomplete });

    // Spill to canvas when canvas_id is provided or series > 500 rows
    const shouldSpill =
      (input.canvas_id !== undefined && input.canvas_id !== '') || totalRecords > 500;

    const { canvasId, canvasExpiresAt } = shouldSpill
      ? await maybeRegisterDataframe(ctx, getCanvasBridge(), rows, {
          rows,
          sourceTool: 'treasury_get_debt',
          queryParams: { mode: input.mode, start_date: input.start_date, end_date: input.end_date },
          truncated: incomplete,
          ...(incomplete && { maxRows: SERIES_MAX_ROWS }),
        })
      : {};

    const preview = rows.slice(0, SERIES_PREVIEW_LIMIT).map((row) => ({
      record_date: row['record_date'] ?? '',
      total_debt: row['tot_pub_debt_out_amt'] ?? '',
      debt_held_public: row['debt_held_public_amt'] ?? '',
      intragovernmental_holdings: row['intragov_hold_amt'] ?? '',
    }));
    const latestRow = preview[0];

    /**
     * Disclose on the arithmetic, not on canvas presence: the inline array is
     * short whenever fewer rows are returned than were retrieved, whether or not
     * a canvas absorbed the rest. One flush — `ctx.enrich.notice` is last-wins,
     * so a second call would erase the first.
     */
    if (retrievedRecords === 0) {
      ctx.enrich.notice(
        'No debt records matched the requested range. Debt to the Penny is recorded on business days only — widen start_date/end_date, or use mode=latest for the most recent record.',
      );
    } else if (preview.length < retrievedRecords) {
      const segments = [`Showing ${preview.length} of ${retrievedRecords} retrieved rows inline.`];
      /**
       * Three states, not two: staging can be un-attempted, attempted and
       * staged, or attempted and unavailable. `shouldSpill` carries what was
       * asked for, so the last state stops advising a caller to pass the
       * canvas_id they already passed — or that the row threshold passed for them.
       */
      segments.push(
        canvasId
          ? `The full retrieved set is registered as ${canvasId} — query it with treasury_dataframe_query.`
          : shouldSpill
            ? 'The full retrieved set could not be staged — DataCanvas requires CANVAS_PROVIDER_TYPE=duckdb on the server. Narrow start_date/end_date to bring the range inline.'
            : 'Pass canvas_id (requires CANVAS_PROVIDER_TYPE=duckdb) to reach the full set with treasury_dataframe_query, or narrow start_date/end_date.',
      );
      if (incomplete) {
        segments.push(
          `Paging stops at ${SERIES_MAX_ROWS} rows, so ${retrievedRecords} of ${totalRecords} matching records were retrieved — narrow start_date/end_date to reach the remainder.`,
        );
      }
      ctx.enrich.truncated({
        shown: preview.length,
        cap: SERIES_PREVIEW_LIMIT,
        guidance: segments.join(' '),
      });
    }

    return {
      record_date: latestRow?.record_date ?? '',
      total_debt: latestRow?.total_debt ?? '',
      debt_held_public: latestRow?.debt_held_public ?? '',
      intragovernmental_holdings: latestRow?.intragovernmental_holdings ?? '',
      series: preview,
      total_records: totalRecords,
      retrieved_records: retrievedRecords,
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    /**
     * A series can match nothing, in which case every amount is empty. Rendering
     * them anyway prints `**Total Debt:** $`, which reads as a value rather than
     * as absence.
     */
    if (result.record_date) {
      lines.push(`**Record Date:** ${result.record_date}`);
      lines.push(`**Total Debt:** $${result.total_debt}`);
      lines.push(`**Debt Held by Public:** $${result.debt_held_public}`);
      lines.push(`**Intragovernmental Holdings:** $${result.intragovernmental_holdings}`);
    } else {
      lines.push('_No debt record matched._');
    }
    if (result.total_records !== undefined) {
      lines.push(`\n**Series:** ${result.total_records} total records`);
      if (result.retrieved_records !== undefined) {
        const shown = result.series?.length ?? 0;
        const previewNote =
          shown < result.retrieved_records
            ? ` (showing ${shown} of ${result.retrieved_records})`
            : '';
        lines.push(`**Retrieved:** ${result.retrieved_records} rows${previewNote}`);
      }
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
