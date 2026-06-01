/**
 * @fileoverview Run a SELECT query against DataCanvas dataframes registered by
 * Treasury Fiscal Data tools. Standard DuckDB SQL with joins, aggregates,
 * window functions, and CTEs. System catalogs are denied at the bridge layer.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeQueryTool = tool('treasury_dataframe_query', {
  title: 'Query Treasury Dataframes',
  description:
    'Run a single-statement SELECT against DataCanvas dataframes registered by treasury_query_dataset, treasury_get_debt, treasury_get_interest_rates, and treasury_get_exchange_rates. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied at the bridge layer. All Treasury dataframe columns are VARCHAR — CAST to DECIMAL or DATE for arithmetic and date comparisons. Use treasury_dataframe_describe to list available table names and column schemas before querying.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query returned no rows, or when results were capped by row_limit.',
      ),
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'CANVAS_PROVIDER_TYPE is not set to duckdb',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable DataCanvas.',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL references a denied DuckDB system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*)',
      recovery:
        'Query only df_<id> tables. Use treasury_dataframe_describe to list available dataframes.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL is not a SELECT, contains DDL/DML, or uses disallowed table functions',
      recovery:
        'Only SELECT statements are permitted. Reference dataframes by name from treasury_dataframe_describe.',
    },
  ],

  input: z.object({
    sql: z
      .string()
      .min(1)
      .describe(
        'Single-statement SELECT against df_<id> tables. All values in Treasury dataframes are VARCHAR (strings) per the API contract — CAST to DECIMAL or DATE for arithmetic and date comparisons. Example: SELECT record_date, CAST(tot_pub_debt_out_amt AS DECIMAL) AS debt FROM df_xxxxx ORDER BY record_date DESC LIMIT 10.',
      ),
    register_as: z
      .string()
      .optional()
      .describe(
        'Persist result as a new dataframe. Use to chain analyses. The name must match df_XXXXX_XXXXX format or be a fresh df_<id>.',
      ),
    preview: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(
        'Rows in the immediate response. Defaults to row_limit. Set lower when using register_as.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe('Hard cap on rows in the response. Default 1000, max 10000.'),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe('Total rows the query produced (may exceed rows.length when capped).'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized rows, bounded by preview / row_limit.'),
    registered_as: z
      .string()
      .optional()
      .describe('Set when register_as was supplied and the new dataframe was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe('ISO 8601 expiry timestamp for the newly registered dataframe, when applicable.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    // Catch SQL gate errors from the bridge (system_catalog_access) and from
    // the framework canvas layer (non_select_statement, multi_statement,
    // denied_function, etc.) and surface them as typed contract reasons.
    let queryOutput: Awaited<ReturnType<typeof bridge.query>>;
    try {
      queryOutput = await bridge.query(ctx, input.sql, {
        ...(input.register_as !== undefined && { registerAs: input.register_as }),
        ...(input.preview !== undefined && { preview: input.preview }),
        rowLimit: input.row_limit,
        sourceTool: 'treasury_dataframe_query',
        queryParams: { sql: input.sql },
      });
    } catch (err) {
      const reason = (err as { data?: { reason?: string } }).data?.reason;
      const msg = err instanceof Error ? err.message : String(err);
      if (reason === 'system_catalog_access') {
        throw ctx.fail('system_catalog_access', msg);
      }
      // Map all framework SQL gate violations (non_select_statement,
      // multi_statement, denied_function, denied_function_in_plan,
      // plan_operator_not_allowed, identifier_shape, etc.) to invalid_sql.
      const SQL_GATE_REASONS = new Set([
        'non_select_statement',
        'multi_statement',
        'denied_function',
        'denied_function_in_plan',
        'plan_operator_not_allowed',
        'identifier_empty',
        'identifier_shape',
        'identifier_reserved',
      ]);
      if (reason !== undefined && SQL_GATE_REASONS.has(reason)) {
        throw ctx.fail('invalid_sql', msg);
      }
      throw err;
    }

    const { result, meta } = queryOutput;

    ctx.log.info('Dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Verify dataframe names (use treasury_dataframe_describe) and check your WHERE conditions. Remember all Treasury columns are VARCHAR — use CAST for comparisons.',
      );
    } else if (result.rowCount > result.rows.length) {
      ctx.enrich.notice(
        `Showing ${result.rows.length} of ${result.rowCount} rows (capped). Use register_as to persist the full result, or raise row_limit (max 10000).`,
      );
    }

    return {
      columns: result.columns,
      row_count: result.rowCount,
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as \`${result.registered_as}\` (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }
    const cappedNote =
      result.row_count > result.rows.length
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    lines.push(`**${result.row_count} rows**${cappedNote}\n`);

    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const header = `| ${result.columns.join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v.replace(/\|/g, '\\|');
        if (typeof v === 'object') return JSON.stringify(v).replace(/\|/g, '\\|');
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
