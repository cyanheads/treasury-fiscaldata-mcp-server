/**
 * @fileoverview Run a SELECT query against DataCanvas dataframes registered by
 * Treasury Fiscal Data tools. Standard DuckDB SQL with joins, aggregates,
 * window functions, and CTEs. System catalogs are denied at the bridge layer.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { SQL_GATE_REASONS } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/**
 * Every reason the framework's read-only SQL gate can reject a statement with,
 * taken from the framework rather than restated, so the reroute below cannot
 * drift out of sync with the gate it is translating.
 */
const GATE_REASONS: ReadonlySet<string> = new Set(Object.values(SQL_GATE_REASONS));

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
        'Guidance when the query returned no rows, or when results were capped by preview or row_limit.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the returned rows were capped below the full result set.'),
    shown: z.number().optional().describe('Number of rows returned in this response.'),
    cap: z
      .number()
      .optional()
      .describe('The row cap that was applied — preview when supplied, otherwise row_limit.'),
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
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'A df_<id> table named in the SQL is not on the canvas — its TTL expired, it was dropped, or it was never registered',
      recovery:
        'Call treasury_dataframe_describe to list live tables, or re-stage the rows by passing canvas_id to treasury_query_dataset, treasury_get_debt, treasury_get_interest_rates, or treasury_get_exchange_rates.',
    },
    {
      reason: 'invalid_query_bounds',
      code: JsonRpcErrorCode.ValidationError,
      when: 'preview exceeds row_limit, or row_limit exceeds the row ceiling this server allows',
      recovery:
        'Keep preview at or below row_limit, and keep row_limit within the ceiling this server allows.',
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
        'Rows in the immediate response. Defaults to row_limit and may not exceed it. Set lower when using register_as.',
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
      /**
       * Surface gate violations — from this server's bridge and from the
       * framework canvas layer — as typed contract reasons. ctx.fail builds the
       * wire error from exactly the data argument given, so each branch forwards
       * the contract's recovery hint explicitly — the caught error's own data
       * does not carry over.
       */
      if (!(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      const msg = err.message;
      if (reason === 'system_catalog_access') {
        throw ctx.fail(
          'system_catalog_access',
          msg,
          { ...ctx.recoveryFor('system_catalog_access') },
          { cause: err },
        );
      }
      /**
       * A vanished table is the likeliest failure this tool has — names are
       * minted at random, expire on a TTL, and do not survive a restart. The
       * framework's own message and hint point at registerTable() and
       * describe(), in-process methods no MCP client can call, so both the
       * message and the hint are rewritten here in terms of this server's tools.
       */
      if (reason === 'missing_table') {
        const tableName = typeof err.data?.tableName === 'string' ? err.data.tableName : undefined;
        throw ctx.fail(
          'missing_table',
          tableName
            ? `Canvas table "${tableName}" is not on the canvas. It expired, was dropped, or was never registered.`
            : 'A canvas table named in this query is not on the canvas. It expired, was dropped, or was never registered.',
          { ...(tableName !== undefined && { tableName }), ...ctx.recoveryFor('missing_table') },
          { cause: err },
        );
      }
      /**
       * The canvas validates its bounds under the framework's own field names
       * (`rowLimit`, `preview`); restate the violation using the parameter names
       * the caller actually supplied.
       */
      if (reason === 'invalid_query_bounds') {
        throw ctx.fail(
          'invalid_query_bounds',
          err.data?.field === 'preview'
            ? `preview (${input.preview}) may not exceed row_limit (${input.row_limit}).`
            : `row_limit (${input.row_limit}) exceeds the row ceiling this server allows.`,
          { ...ctx.recoveryFor('invalid_query_bounds') },
          { cause: err },
        );
      }
      /**
       * Collapse every remaining framework gate reason onto invalid_sql, keeping
       * the specific one as `canvas_reason`. Deriving the set from the framework's
       * own SQL_GATE_REASONS is what keeps a newly-added reason inside the
       * contract: a hand-copied list silently drops it back through the rethrow
       * below, uncontracted and without a recovery hint. That is how the gate's
       * own `invalid_sql` — a SELECT-shaped statement that fails to prepare —
       * used to escape.
       */
      if (typeof reason === 'string' && GATE_REASONS.has(reason)) {
        throw ctx.fail(
          'invalid_sql',
          msg,
          { canvas_reason: reason, ...ctx.recoveryFor('invalid_sql') },
          { cause: err },
        );
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
      /**
       * Name the cap that actually bound. `preview` may never exceed `row_limit`
       * — the canvas rejects that pair outright — so whenever it is supplied it
       * is the lower of the two, and raising `row_limit` on its own moves
       * nothing. At equality both have to move together.
       */
      const raise =
        input.preview === undefined
          ? 'raise row_limit (max 10000)'
          : input.preview < input.row_limit
            ? `raise preview (currently ${input.preview}, up to row_limit ${input.row_limit})`
            : `raise preview and row_limit together (both ${input.row_limit}, max 10000)`;
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap: input.preview ?? input.row_limit,
        guidance: `Showing ${result.rows.length} of ${result.rowCount} rows (capped). Use register_as to persist the full result, or ${raise}.`,
      });
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
