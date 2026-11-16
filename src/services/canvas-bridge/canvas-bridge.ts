/**
 * @fileoverview Adapter between Treasury Fiscal Data tools and the framework
 * DataCanvas primitive. Keeps one shared canvas per tenant through
 * `DataCanvas.acquireShared`, generates `df_XXXXX_XXXXX` table names, stages
 * rows under the framework's inferred all-nullable schema (Treasury API returns
 * sparse data with "null" strings), records a `register_as` table's column
 * types as the canvas holds them, tracks per-table expiry + provenance in
 * `ctx.state`, and lazy-sweeps expired tables on every public op.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  assertNoSystemCatalogs,
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  type DescribedColumn,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Per-table provenance + expiry metadata persisted in `ctx.state`. */
export interface DataframeMeta {
  /**
   * The schema a staged table was registered with, or for a `register_as`
   * table the canvas's own description of it. That adds `engineType`, the type
   * exactly as DuckDB spells it (`DECIMAL(20,2)`); the `type` tag beside it
   * only approximates (`VARCHAR`).
   */
  columnSchema: DescribedColumn[];
  createdAt: string;
  expiresAt: string;
  maxRows: number | undefined;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  truncated: boolean;
}

export interface RegisterDataframeResult {
  columnSchema: ColumnSchema[];
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

export interface RegisterDataframeOptions {
  maxRows?: number;
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  sourceTool: string;
  truncated?: boolean;
}

export interface BridgeQueryOptions {
  preview?: number;
  queryParams?: Record<string, unknown>;
  registerAs?: string;
  rowLimit?: number;
  sourceTool?: string;
}

const META_PREFIX = 'df-meta/';
/** The `ctx.state` key holding the tenant's canvas id — unchanged since 0.4.0, so stored ids keep resolving. */
const CANVAS_ID_KEY = 'canvas-id';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A new record's creation time and its expiry, one configured TTL later. */
function recordWindow(): Pick<DataframeMeta, 'createdAt' | 'expiresAt'> {
  const now = Date.now();
  return {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + getServerConfig().datasetTtlSeconds * 1000).toISOString(),
  };
}

/**
 * Refuse a `register_as` name the canvas gate refuses in SQL — a DuckDB system
 * catalog or internal metadata view (`duckdb_tables`, `pg_class`, …). A table
 * under such a name is unreachable, since every query naming it is refused,
 * and `duckdb_columns` / `duckdb_views` also break the canvas's own describe
 * and later `register_as` calls for the whole tenant. Runs before any canvas is
 * resolved, so a refused call stages nothing.
 */
function assertRegisterableName(name: string): void {
  try {
    assertNoSystemCatalogs(name);
  } catch (error) {
    throw validationError(
      `register_as "${name}" names a DuckDB system catalog, so every query reading the table would be refused. Choose another name.`,
      {
        reason: 'system_catalog_access',
        registerAs: name,
        recovery: {
          hint: 'Choose another name for register_as — a df_ prefix keeps it consistent with the tables the data tools stage.',
        },
      },
      { cause: error },
    );
  }
}

export class CanvasBridge {
  private readonly canvas: DataCanvas;

  constructor(canvas: DataCanvas) {
    this.canvas = canvas;
  }

  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult | undefined> {
    if (options.rows.length === 0) {
      ctx.log.debug('Skipping dataframe registration — no rows', {
        sourceTool: options.sourceTool,
      });
      return;
    }

    try {
      const instance = await this.stagingCanvas(ctx);
      await this.sweepExpired(ctx, instance);
      const tableName = this.mintTableName();
      // Every inferred column is nullable; Treasury data is sparse.
      const schema = inferSchemaFromRows(options.rows);

      const result = await instance.registerTable(tableName, options.rows, { schema });

      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        ...recordWindow(),
        rowCount: result.rowCount,
        truncated: options.truncated ?? false,
        maxRows: options.maxRows,
        columnSchema: schema,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);

      ctx.log.info('Dataframe registered', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });

      return {
        tableName: result.tableName,
        rowCount: result.rowCount,
        expiresAt: meta.expiresAt,
        columnSchema: schema,
      };
    } catch (error) {
      ctx.log.warning('Dataframe registration failed', {
        error: error instanceof Error ? error.message : String(error),
        sourceTool: options.sourceTool,
      });
      return;
    }
  }

  /**
   * List the tables a query can reach, newest first. With no live canvas
   * nothing is staged. A record whose table is no longer on the canvas is
   * deleted: the records are read before the canvas's table list, so a table
   * committing in between has its table listed too and keeps its record.
   */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    const instance = await this.liveCanvas(ctx);
    if (!instance) return [];
    const records = await this.sweepExpired(ctx, instance);
    const onCanvas = new Set(
      (await instance.describe({ kind: 'table', signal: ctx.signal })).map((t) => t.name),
    );

    const live: DataframeMeta[] = [];
    const orphaned: string[] = [];
    for (const { key, meta } of records) {
      if (onCanvas.has(meta.tableName)) live.push(meta);
      else orphaned.push(key);
    }
    if (orphaned.length > 0) await ctx.state.deleteMany(orphaned);

    return live
      .filter((meta) => tableName === undefined || meta.tableName === tableName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    const registerAs = options.registerAs;
    if (registerAs !== undefined) assertRegisterableName(registerAs);
    const instance = await this.stagingCanvas(ctx);
    await this.sweepExpired(ctx, instance);

    const result = await instance.query(sql, {
      denySystemCatalogs: true,
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(registerAs !== undefined && { registerAs }),
      signal: ctx.signal,
    });

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      // The SELECT decides the column types, so read them off the new table.
      const [table] = await instance.describe({
        tableName: result.tableName,
        kind: 'table',
        signal: ctx.signal,
      });
      if (!table) {
        throw notFound(
          `Canvas table "${result.tableName}" was dropped before its record was written.`,
          { reason: 'missing_table', tableName: result.tableName },
        );
      }
      meta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool ?? 'treasury_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        ...recordWindow(),
        rowCount: result.rowCount,
        truncated: false,
        maxRows: undefined,
        columnSchema: table.columns,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
    }

    return meta ? { result, meta } : { result };
  }

  /** Remove a tenant's staged table and its matching provenance record. */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    const instance = await this.liveCanvas(ctx);
    if (!instance) return false;
    await this.sweepExpired(ctx, instance);
    const dropped = await instance.drop(tableName);
    await ctx.state.delete(`${META_PREFIX}${tableName}`);
    return dropped;
  }

  /** The tenant's canvas, minted once when none is live. Records kept for a dead canvas go first. */
  private stagingCanvas(ctx: Context): Promise<CanvasInstance> {
    return this.canvas.acquireShared(ctx, {
      stateKey: CANVAS_ID_KEY,
      onReplace: () => this.purgeRecords(ctx),
    });
  }

  /** The tenant's live canvas, or `undefined` — never mints. */
  private liveCanvas(ctx: Context): Promise<CanvasInstance | undefined> {
    return this.canvas.acquireShared(ctx, {
      stateKey: CANVAS_ID_KEY,
      create: false,
      onReplace: () => this.purgeRecords(ctx),
    });
  }

  /**
   * Delete every provenance record by key. Runs when no live canvas holds the
   * tenant's tables — after the absolute cap the stored id has expired with the
   * canvas, so the dead id is not always known, and nothing else could hold a
   * record. Idempotent: `acquireShared` re-runs it after a failure.
   */
  private async purgeRecords(ctx: Context): Promise<void> {
    const keys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) keys.push(key);
    if (keys.length > 0) await ctx.state.deleteMany(keys);
  }

  /**
   * Drop the tables on `instance` whose records are past their deadline and
   * delete those records. Reads every record before dropping anything; returns
   * the records it left in place.
   */
  private async sweepExpired(
    ctx: Context,
    instance: CanvasInstance,
  ): Promise<{ key: string; meta: DataframeMeta }[]> {
    const nowIso = new Date().toISOString();
    const records: { key: string; meta: DataframeMeta }[] = [];
    for await (const record of this.iterateMeta(ctx)) records.push(record);

    const live: { key: string; meta: DataframeMeta }[] = [];
    for (const record of records) {
      const { key, meta } = record;
      if (meta.expiresAt > nowIso) {
        live.push(record);
        continue;
      }
      try {
        await instance.drop(meta.tableName);
      } catch (error) {
        ctx.log.warning('TTL sweep drop failed', {
          tableName: meta.tableName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired dataframe swept', {
        tableName: meta.tableName,
        expiredAt: meta.expiresAt,
      });
    }
    return live;
  }

  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  private mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }
}

let _bridge: CanvasBridge | undefined;

export function initCanvasBridge(canvas: DataCanvas | undefined): void {
  _bridge = canvas ? new CanvasBridge(canvas) : undefined;
}

export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}

/**
 * Register rows on the canvas bridge when conditions are met. Returns
 * `{ canvasId, canvasExpiresAt }` when registered, or `{}` when skipped
 * (bridge absent, no rows, or registration fails gracefully).
 */
export async function maybeRegisterDataframe(
  ctx: Context,
  bridge: CanvasBridge | undefined,
  rows: Record<string, unknown>[],
  opts: RegisterDataframeOptions,
): Promise<{ canvasId?: string; canvasExpiresAt?: string }> {
  if (!bridge || rows.length === 0) return {};
  const registered = await bridge.registerDataframe(ctx, opts);
  if (!registered) return {};
  return { canvasId: registered.tableName, canvasExpiresAt: registered.expiresAt };
}
