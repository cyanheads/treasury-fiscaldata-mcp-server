/**
 * @fileoverview Adapter between Treasury Fiscal Data tools and the framework
 * DataCanvas primitive. Holds one shared canvas per tenant, generates
 * `df_XXXXX_XXXXX` table names, derives all-nullable schemas (Treasury API
 * returns sparse data with "null" strings), tracks per-table TTL + provenance
 * in `ctx.state`, and lazy-sweeps expired tables on every public op.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { assertNoSystemCatalogAccess } from './sql-gate-extras.js';

/** Per-table provenance + TTL metadata persisted in `ctx.state`. */
export interface DataframeMeta {
  columnSchema: ColumnSchema[];
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
const CANVAS_ID_KEY = 'canvas-id';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Force all columns nullable — Treasury data is sparse. */
function deriveAllNullableSchema(rows: Record<string, unknown>[]): ColumnSchema[] {
  return inferSchemaFromRows(rows).map((col) => ({ ...col, nullable: true }));
}

export class CanvasBridge {
  constructor(private readonly canvas: DataCanvas) {}

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
      await this.sweepExpired(ctx);
      const instance = await this.acquireSharedCanvas(ctx);
      const tableName = this.mintTableName();
      const schema = deriveAllNullableSchema(options.rows);

      const result = await instance.registerTable(tableName, options.rows, { schema });

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
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

  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
    if (tableName) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    assertNoSystemCatalogAccess(sql);
    await this.sweepExpired(ctx);
    const instance = await this.acquireSharedCanvas(ctx);

    const registerAs = options.registerAs;
    const result = await instance.query(sql, {
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(registerAs !== undefined && { registerAs }),
      signal: ctx.signal,
    });

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      meta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool ?? 'treasury_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: false,
        maxRows: undefined,
        columnSchema: result.columns.map((name) => ({
          name,
          type: 'VARCHAR',
          nullable: true,
        })),
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
    }

    return meta ? { result, meta } : { result };
  }

  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;
      instance ??= await this.acquireSharedCanvas(ctx).catch(() => undefined);
      if (instance) {
        try {
          await instance.drop(meta.tableName);
        } catch (error) {
          ctx.log.warning('TTL sweep drop failed', {
            tableName: meta.tableName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired dataframe swept', {
        tableName: meta.tableName,
        expiredAt: meta.expiresAt,
      });
    }
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

  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, ctx);
      } catch {
        await ctx.state.delete(CANVAS_ID_KEY);
      }
    }
    const instance = await this.canvas.acquire(undefined, ctx);
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
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
