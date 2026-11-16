/**
 * @fileoverview Generic parameterized query against any Treasury Fiscal Data
 * endpoint. Translates structured inputs into the API's fields/filter/sort/
 * pagination grammar and optionally registers results on DataCanvas.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { codeLiteral, markdownValue, quotedNotice } from '@/mcp-server/tools/markdown-encoding.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { DATASETS } from '@/services/fiscal-data/datasets.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';
import type { FilterCondition } from '@/services/fiscal-data/types.js';

export const queryDatasetTool = tool('treasury_query_dataset', {
  title: 'Query Treasury Fiscal Data Dataset',
  description:
    'Query any Treasury Fiscal Data endpoint by path, field list, filters, sort, and page. Call treasury_list_datasets first to get the correct endpoint path and exact field names; a field name the endpoint lacks fails with an error listing every field it has. Filter syntax: each condition is { field, operator, value } where operator is eq/gt/gte/lt/lte/in (e.g., record_date:gte:2024-01-01). Multiple conditions are ANDed together. All response values are strings per the API contract, including numbers and dates; "null" (string) means no value. Supply canvas_id to stage the page result as a DataCanvas table — read its column schema with treasury_dataframe_describe, then run SQL over it with treasury_dataframe_query (requires CANVAS_PROVIDER_TYPE=duckdb on the server).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty, the endpoint was not found in the catalog, or staging was requested.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total rows matching the query across all pages — discloses that this page is a subset.',
      ),
  },
  enrichmentTrailer: { notice: { render: quotedNotice } },

  errors: [
    {
      reason: 'invalid_endpoint',
      code: JsonRpcErrorCode.NotFound,
      when: 'The endpoint path does not exist — the API answers 404 to the request, and again to a bare request for the same path when the query carried fields, filters, sort, or a later page',
      recovery: 'Call treasury_list_datasets to find the correct endpoint path.',
    },
    {
      reason: 'invalid_field',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A name in fields, a filter, or sort does not exist on this endpoint; the message names each unknown name and lists every field the endpoint has',
      recovery:
        'Replace each unknown name with one of the field names this error lists for the endpoint.',
    },
    {
      reason: 'sort_field_not_selected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'fields is set and leaves out a sort field — the API returns only the selected fields and sorts only by those, so it rejects the query',
      recovery: 'Add each sort field to fields, or omit fields.',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter value contains a comma, which the API reads as the start of another condition, so the call is refused before any request; or the API rejected a page-1 query with a filter or sort whose every field name exists on the endpoint and whose sort fields are all selected, so the filter or sort expression itself was refused',
      recovery:
        'Remove any comma from filter values: the API reads one as the start of another condition (write 1000, not 1,000). If none has one, resend without sort, then with one filter at a time, to find the expression the API refuses.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page_number is past the last page of the matched set — the API rejects the query although every field name in it exists',
      recovery:
        'Request a page_number within total_pages, which this tool returns on every successful response.',
    },
  ],

  input: z.object({
    endpoint: z
      .string()
      .describe(
        'Endpoint path returned by treasury_list_datasets (e.g., "/v2/accounting/od/debt_to_penny"). The leading slash is optional.',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Fields to return. Omit to return all fields. Specify field names exactly as listed by treasury_list_datasets; an unknown name fails with an error listing every field the endpoint has. A selection returns the distinct combinations of its fields, so total_count and total_pages count those combinations rather than the records behind them.',
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
             * API rejects as a malformed filter, and `invalid_filter`'s hint
             * sends the caller after the operator, a token that was never
             * wrong; an empty list serializes to
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
                'Filter value. For "in", pass an array of strings. Dates use YYYY-MM-DD format. A value cannot contain a comma: the API reads one as the start of another condition.',
              ),
          })
          /**
           * Strict for the same reason the root is: a key this object does not
           * declare is a filter the caller believes they set, and stripping it
           * hands back rows the filter never narrowed. Root-level strictness
           * does not reach a nested object, so it is marked here.
           */
          .strict()
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
        'Sort expression: field name optionally prefixed with "-" for descending (e.g., "-record_date" for newest-first). When fields is set, include each sort field in it — the API sorts only by fields it returns.',
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
    total_count: z
      .number()
      .describe(
        'Total rows matching the query (across all pages). With fields set, each row is a distinct combination of those fields, so this counts combinations, not records.',
      ),
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
     * Whitespace around a name and a missing leading slash have one reading
     * each, and neither survives the request as sent: the API strips no
     * whitespace from a name, and a path without its slash runs into the base
     * URL. Everything below — the catalog check, the request, the echoed
     * endpoint, the staged provenance — reads the normalized values. Filter
     * values pass through as sent.
     */
    const endpoint = withLeadingSlash(input.endpoint.trim());
    const fields = input.fields?.map((name) => name.trim());
    const filters: FilterCondition[] | undefined = input.filters?.map((f) => ({
      field: f.field.trim(),
      operator: f.operator,
      value: f.value,
    }));
    const sort = input.sort
      ?.split(',')
      .map((term) => term.trim())
      .join(',');

    /**
     * One flush at the end — `ctx.enrich.notice` is last-wins, so an earlier
     * call would be erased by a later one. Three sources can fire on the same
     * request: an off-catalog endpoint, a staged canvas table, and an empty
     * match.
     */
    const noticeSegments: string[] = [];

    // Soft catalog check — warn but don't block if endpoint isn't in the catalog
    if (!DATASETS.some((d) => d.endpoint === endpoint)) {
      noticeSegments.push(
        `Endpoint "${endpoint}" was not found in the local catalog. The request was sent to the API anyway; treasury_list_datasets covers the curated set and will not list this endpoint's field names.`,
      );
    }

    const appliedFilters = filters?.length ? svc.buildFilterParam(filters) : undefined;

    const fetchOpts: Parameters<typeof svc.fetchPage>[2] = {
      pageSize: input.page_size,
      pageNumber: input.page_number,
    };
    if (fields?.length) fetchOpts.fields = fields;
    if (filters?.length) fetchOpts.filters = filters;
    if (sort) fetchOpts.sort = sort;

    let envelope: Awaited<ReturnType<typeof svc.fetchPage>>;
    try {
      envelope = await svc.fetchPage(ctx, endpoint, fetchOpts);
    } catch (err) {
      /**
       * Re-route service-layer classification errors through ctx.fail so
       * data.reason is typed against the declared contract and the JSON-RPC
       * error code matches what the contract advertises. Explicit recovery
       * forwards preserve the server's tested direct-handler contract.
       */
      if (!(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      const data = { endpoint };
      const cause = { cause: err };
      switch (reason) {
        case 'invalid_endpoint':
          throw ctx.fail(
            'invalid_endpoint',
            err.message,
            { ...data, ...ctx.recoveryFor('invalid_endpoint') },
            cause,
          );
        case 'invalid_field':
          /**
           * The service's hint wins here alone: the API's legacy 400 names the
           * unknown field but lists none, so the contract's "names this error
           * lists" would point at nothing, and that route's hint says where the
           * names are. The probe route's hint is the contract's own.
           */
          throw ctx.fail(
            'invalid_field',
            err.message,
            {
              ...data,
              ...(err.data?.recovery
                ? { recovery: err.data.recovery }
                : ctx.recoveryFor('invalid_field')),
            },
            cause,
          );
        case 'invalid_filter':
          throw ctx.fail(
            'invalid_filter',
            err.message,
            { ...data, ...ctx.recoveryFor('invalid_filter') },
            cause,
          );
        case 'page_out_of_range':
          throw ctx.fail(
            'page_out_of_range',
            err.message,
            { ...data, ...ctx.recoveryFor('page_out_of_range') },
            cause,
          );
        case 'sort_field_not_selected':
          throw ctx.fail(
            'sort_field_not_selected',
            err.message,
            { ...data, ...ctx.recoveryFor('sort_field_not_selected') },
            cause,
          );
      }
      throw err;
    }

    const totalCount = envelope.meta['total-count'];
    const totalPages = envelope.meta['total-pages'];
    const fieldLabels = envelope.meta.labels ?? {};

    ctx.log.info('Dataset queried', {
      endpoint,
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
                endpoint,
                fields,
                filters,
                sort,
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

    /**
     * An unknown field name never reaches here — the API rejects it and the
     * service reports `invalid_field` — so an empty match is about values.
     */
    if (totalCount === 0) {
      noticeSegments.push(
        `No rows matched the query on endpoint "${endpoint}". If filtering, check the values: dates use YYYY-MM-DD, an eq date matches only a day the dataset has a record for (gte/lte cover a range), and text values must match exactly.`,
      );
    }

    if (noticeSegments.length > 0) ctx.enrich.notice(noticeSegments.join(' '));

    return {
      endpoint,
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
    lines.push(`**Endpoint:** ${codeLiteral(result.endpoint)}`);
    lines.push(
      `**Rows:** ${result.data.length} of ${result.total_count} total (page ${result.page_number}/${result.total_pages}, page_size ${result.page_size})`,
    );
    if (result.applied_filters) {
      lines.push(`**Filter:** ${codeLiteral(result.applied_filters)}`);
    }
    if (result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` (expires ${result.canvas_expires_at ?? 'unknown'})`,
      );
    }
    if (result.data.length === 0) lines.push('\n_No rows returned._');
    /**
     * The header names each field — what a caller passes back in `fields`,
     * `filters`, and `sort`, and what keys every row in `structuredContent` —
     * beside the label upstream gives it. An empty page still carries
     * `field_labels`, so its fields are listed as a header with no rows.
     */
    const cols = Object.keys(result.data[0] ?? result.field_labels);
    if (cols.length === 0) return [{ type: 'text', text: lines.join('\n') }];
    const header = cols.map((field) => {
      const label = result.field_labels[field];
      return label && label !== field
        ? `${markdownValue(label)} (${markdownValue(field)})`
        : markdownValue(field);
    });
    lines.push('');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
    for (const row of result.data) {
      // The upstream's "null" sentinel renders as itself, as structuredContent carries it.
      const cells = cols.map((c) => markdownValue(row[c] ?? ''));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** The API's form of an endpoint path: one leading slash, which the base URL lacks. */
function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
