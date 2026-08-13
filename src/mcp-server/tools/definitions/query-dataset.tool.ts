/**
 * @fileoverview Generic parameterized query against any Treasury Fiscal Data
 * endpoint. Translates structured inputs into the API's fields/filter/sort/
 * pagination grammar and optionally registers results on DataCanvas.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { DATASETS } from '@/services/fiscal-data/datasets.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';
import type { FilterCondition } from '@/services/fiscal-data/types.js';

export const queryDatasetTool = tool('treasury_query_dataset', {
  title: 'Query Treasury Fiscal Data Dataset',
  description:
    'Query any Treasury Fiscal Data endpoint by path, field list, filters, sort, and page. Call treasury_list_datasets first to get the correct endpoint path and exact field names — a typo in either causes a 400. Filter syntax: each condition is { field, operator, value } where operator is eq/gt/gte/lt/lte/in (e.g., record_date:gte:2024-01-01). Multiple conditions are ANDed together. All response values are strings per the API contract, including numbers and dates; "null" (string) means no value. Supply canvas_id to stage the page result as a DataCanvas table — read its column schema with treasury_dataframe_describe, then run SQL over it with treasury_dataframe_query (requires CANVAS_PROVIDER_TYPE=duckdb on the server).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty, a field typo is suspected, the endpoint was not found in the catalog, or staging was requested.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total rows matching the query across all pages — discloses that this page is a subset.',
      ),
  },

  errors: [
    {
      reason: 'invalid_endpoint',
      code: JsonRpcErrorCode.NotFound,
      when: 'The endpoint path does not exist (API returns 404 HTML)',
      recovery: 'Call treasury_list_datasets to find the correct endpoint path.',
    },
    {
      reason: 'invalid_field',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field name in fields= or filter= does not exist on this endpoint — API returns JSON {"error":"Invalid Query Param","message":"...Field \'X\' does not exist..."}',
      recovery: 'Call treasury_list_datasets with the endpoint to see the available field names.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The filter expression uses an unsupported operator — API returns JSON {"error":"Invalid Query Param","message":"...Operator \':op:\' is not supported..."}',
      recovery:
        'Supported operators: eq, gt, gte, lt, lte, in. Dates use YYYY-MM-DD. Check field names against treasury_list_datasets.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page_number is past the last page of the matched set — API returns JSON {"error":"Invalid Query Param","message":"...Page #N is out of range..."}',
      recovery:
        'Request a page_number within total_pages, which this tool returns on every successful response.',
    },
  ],

  input: z.object({
    endpoint: z
      .string()
      .describe(
        'Endpoint path returned by treasury_list_datasets (e.g., "/v2/accounting/od/debt_to_penny"). Include the leading slash.',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Fields to return. Omit to return all fields. Specify field names exactly as listed by treasury_list_datasets — a typo causes a 400.',
      ),
    filters: z
      .array(
        z
          .object({
            field: z.string().describe('Field name to filter on.'),
            operator: z
              .enum(['eq', 'gt', 'gte', 'lt', 'lte', 'in'])
              .describe('Comparison operator. "in" matches any value in the provided list.'),
            /**
             * Emptiness is caught here rather than upstream. An empty value
             * serializes to a trailing-colon expression (`record_date:eq:`) the
             * API rejects as an unsupported *operator*, sending the caller after
             * a token that was never wrong; an empty list serializes to
             * `field:in:()` and an empty member to `field:in:(Japan,)`, both of
             * which the API accepts and then does not apply as written.
             */
            value: z
              .union([
                z
                  .string()
                  .min(1, 'Filter value cannot be empty — supply the value to compare against.')
                  .describe('Single filter value. Dates use YYYY-MM-DD format.'),
                z
                  .array(
                    z
                      .string()
                      .min(
                        1,
                        'Filter value list cannot contain an empty entry — remove it or supply its value.',
                      ),
                  )
                  .min(1, 'Filter value list cannot be empty — supply at least one value.')
                  .describe('List of values for "in" operator.'),
              ])
              .describe(
                'Filter value. For "in", pass an array of strings. Dates use YYYY-MM-DD format.',
              ),
          })
          .describe('One filter condition.'),
      )
      .optional()
      .describe(
        'Filter conditions (ANDed together). Multiple filters on different fields are combined in one filter= parameter.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort expression: field name optionally prefixed with "-" for descending (e.g., "-record_date" for newest-first).',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(100)
      .describe(
        'Rows per page. Default 100. Raise to 10000 to minimize round trips for small datasets. For large time-series pulls, use canvas_id with treasury_dataframe_query instead.',
      ),
    page_number: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page to fetch (1-indexed). Check total_pages in the response to know if more pages exist.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Set any non-empty value to stage this page as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Omit to receive results inline only. Requires CANVAS_PROVIDER_TYPE=duckdb on the server.',
      ),
  }),

  output: z.object({
    endpoint: z.string().describe('Endpoint that was queried.'),
    data: z
      .array(z.record(z.string(), z.string()))
      .describe(
        'Rows returned. All values are strings per API contract — including numeric and date fields. Convert in the calling context. Null values appear as the string "null".',
      ),
    total_count: z.number().describe('Total rows matching the query (across all pages).'),
    total_pages: z.number().describe('Total pages at the current page_size.'),
    page_number: z.number().describe('Current page (1-indexed).'),
    page_size: z.number().describe('Rows per page.'),
    field_labels: z
      .record(z.string(), z.string())
      .describe('Human-readable label for each returned field.'),
    applied_filters: z
      .string()
      .optional()
      .describe('Filter expression sent to the API, for verification.'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DuckDB table name (df_XXXXX_XXXXX) holding this page. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.',
      ),
    canvas_expires_at: z.string().optional().describe('ISO 8601 expiry for the canvas dataframe.'),
  }),

  async handler(input, ctx) {
    const svc = getFiscalDataService();

    /**
     * One flush at the end — `ctx.enrich.notice` is last-wins, so an earlier
     * call would be erased by a later one. Three sources can fire on the same
     * request: an off-catalog endpoint, a staged canvas table, and an empty
     * match.
     */
    const noticeSegments: string[] = [];

    // Soft catalog check — warn but don't block if endpoint isn't in the catalog
    if (!DATASETS.some((d) => d.endpoint === input.endpoint)) {
      noticeSegments.push(
        `Endpoint "${input.endpoint}" was not found in the local catalog. The request was sent to the API anyway; treasury_list_datasets covers the curated set and will not list this endpoint's field names.`,
      );
    }

    const filters: FilterCondition[] = (input.filters ?? []).map((f) => ({
      field: f.field,
      operator: f.operator,
      value: f.value,
    }));

    const appliedFilters = filters.length ? svc.buildFilterParam(filters) : undefined;

    const fetchOpts: Parameters<typeof svc.fetchPage>[2] = {
      pageSize: input.page_size,
      pageNumber: input.page_number,
    };
    if (input.fields?.length) fetchOpts.fields = input.fields;
    if (filters.length) fetchOpts.filters = filters;
    if (input.sort?.trim()) fetchOpts.sort = input.sort;

    let envelope: Awaited<ReturnType<typeof svc.fetchPage>>;
    try {
      envelope = await svc.fetchPage(ctx, input.endpoint, fetchOpts);
    } catch (err) {
      /**
       * Re-route service-layer classification errors through ctx.fail so
       * data.reason is typed against the declared contract and the JSON-RPC
       * error code matches what the contract advertises. ctx.fail builds the
       * wire error from exactly the data argument given, so the contract's
       * recovery hint and the endpoint that failed are forwarded explicitly —
       * nothing carries over from the caught error on its own.
       */
      if (!(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      if (
        reason === 'invalid_endpoint' ||
        reason === 'invalid_field' ||
        reason === 'invalid_filter' ||
        reason === 'page_out_of_range'
      ) {
        throw ctx.fail(
          reason,
          err.message,
          { endpoint: input.endpoint, ...ctx.recoveryFor(reason) },
          { cause: err },
        );
      }
      throw err;
    }

    const totalCount = envelope.meta['total-count'];
    const totalPages = envelope.meta['total-pages'];
    const fieldLabels = envelope.meta.labels ?? {};

    ctx.log.info('Dataset queried', {
      endpoint: input.endpoint,
      totalCount,
      rows: envelope.data.length,
    });

    // Disclose the full match count so the agent knows this page is a subset.
    ctx.enrich.total(totalCount);

    // Canvas registration when canvas_id is provided
    let canvasId: string | undefined;
    let canvasExpiresAt: string | undefined;

    if (input.canvas_id !== undefined && input.canvas_id !== '') {
      const bridge = getCanvasBridge();
      const registered =
        bridge && envelope.data.length > 0
          ? await bridge.registerDataframe(ctx, {
              rows: envelope.data,
              sourceTool: 'treasury_query_dataset',
              queryParams: {
                endpoint: input.endpoint,
                fields: input.fields,
                filters: input.filters,
                sort: input.sort,
                page_size: input.page_size,
                page_number: input.page_number,
              },
            })
          : undefined;
      if (registered) {
        canvasId = registered.tableName;
        canvasExpiresAt = registered.expiresAt;
        noticeSegments.push(
          `Staged this page's ${envelope.data.length} rows as table "${canvasId}". Read its column schema with treasury_dataframe_describe, then query it with treasury_dataframe_query — every column is VARCHAR, so CAST to DECIMAL or DATE for arithmetic.`,
        );
      } else if (envelope.data.length > 0) {
        /**
         * Staging was asked for and no table came back. Without a word here the
         * response is a page of rows and an absent `canvas_id`, which reads as
         * the tool ignoring the parameter. An empty page needs no such line —
         * the zero-match guidance below already covers it.
         */
        noticeSegments.push(
          'Staging was requested but no table was created — DataCanvas requires CANVAS_PROVIDER_TYPE=duckdb on the server. The rows returned are the whole page.',
        );
      }
    }

    if (totalCount === 0) {
      noticeSegments.push(
        `No rows matched the query on endpoint "${input.endpoint}". ` +
          'If filtering by date, ensure it is a business day in YYYY-MM-DD format. ' +
          'Check field names with treasury_list_datasets.',
      );
    }

    if (noticeSegments.length > 0) ctx.enrich.notice(noticeSegments.join(' '));

    return {
      endpoint: input.endpoint,
      data: envelope.data,
      total_count: totalCount,
      total_pages: totalPages,
      page_number: input.page_number,
      page_size: input.page_size,
      field_labels: fieldLabels,
      ...(appliedFilters !== undefined && { applied_filters: appliedFilters }),
      ...(canvasId !== undefined && { canvas_id: canvasId }),
      ...(canvasExpiresAt !== undefined && { canvas_expires_at: canvasExpiresAt }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Endpoint:** \`${result.endpoint}\``);
    lines.push(
      `**Rows:** ${result.data.length} of ${result.total_count} total (page ${result.page_number}/${result.total_pages}, page_size ${result.page_size})`,
    );
    if (result.applied_filters) {
      lines.push(`**Filter:** \`${result.applied_filters}\``);
    }
    if (result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` (expires ${result.canvas_expires_at ?? 'unknown'})`,
      );
    }
    if (result.data.length === 0) {
      lines.push('\n_No rows returned._');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    // Table header
    const cols = Object.keys(result.data[0] ?? {});
    const headers = cols.map((c) => result.field_labels[c] ?? c);
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
    for (const row of result.data) {
      const cells = cols.map((c) => {
        const v = row[c];
        return v === 'null' ? '' : (v ?? '');
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
