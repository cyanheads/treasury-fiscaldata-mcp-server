/**
 * @fileoverview Dataframe lifecycle and drop contracts against the real DuckDB boundary.
 * @module tests/tools/dataframe-drop.tool.test
 */
import { tmpdir } from 'node:os';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let canvas: DataCanvas;
let ctx: ReturnType<typeof createMockContext>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CANVAS_TTL_MS', undefined);
  vi.stubEnv('TREASURY_DATAFRAME_DROP_ENABLED', 'true');
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: tmpdir(),
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(provider, new CanvasRegistry(provider));
  ctx = createMockContext({ tenantId: 'drop-test' });
});

afterEach(async () => {
  await canvas.shutdown(ctx);
  vi.unstubAllEnvs();
});

async function bridge() {
  const module = await import('@/services/canvas-bridge/canvas-bridge.js');
  module.initCanvasBridge(canvas);
  return module.getCanvasBridge()!;
}

async function stage() {
  const service = await bridge();
  const registered = await service.registerDataframe(ctx, {
    rows: [{ amount: '42' }],
    sourceTool: 'treasury_query_dataset',
    queryParams: {},
  });
  expect(registered).toBeDefined();
  return { service, name: registered!.tableName };
}

describe('dataframe lifecycle', () => {
  it('stages, describes and queries rows through the existing bridge', async () => {
    const { service, name } = await stage();
    expect(await service.describe(ctx, name)).toMatchObject([{ tableName: name, rowCount: 1 }]);
    expect((await service.query(ctx, `SELECT amount FROM "${name}"`)).result.rows).toEqual([
      { amount: '42' },
    ]);
  });
});

describe('treasury_dataframe_drop', () => {
  it('keeps its definition disabled with an enable hint by default', async () => {
    vi.stubEnv('TREASURY_DATAFRAME_DROP_ENABLED', undefined);
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    expect(dataframeDropTool).toMatchObject({
      name: 'treasury_dataframe_drop',
      __mcpDisabled: { hint: 'TREASURY_DATAFRAME_DROP_ENABLED=true' },
    });
  });

  it('drops only the named table and its metadata, with equivalent response surfaces', async () => {
    const { service, name } = await stage();
    const other = await service.registerDataframe(ctx, {
      rows: [{ amount: '100' }],
      sourceTool: 'treasury_query_dataset',
      queryParams: {},
    });
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    expect(dataframeDropTool).not.toHaveProperty('__mcpDisabled');
    const seededTool: typeof dataframeDropTool = {
      ...dataframeDropTool,
      // Reuse the fixture's real storage so the contract call sees the staged table.
      handler: (input, context) =>
        dataframeDropTool.handler(input, { ...context, state: ctx.state }),
    };
    const result = await runToolContract(
      seededTool,
      { name },
      { context: { tenantId: 'drop-test' } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ name, dropped: true });
    expect(result.content).toEqual([
      { type: 'text', text: `Dropped dataframe ${name}. dropped: true` },
    ]);
    expect(await service.describe(ctx, name)).toEqual([]);
    await expect(service.query(ctx, `SELECT * FROM "${name}"`)).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
    expect(await service.describe(ctx, other!.tableName)).toHaveLength(1);
  });

  it('returns missing_table with actionable recovery on both surfaces', async () => {
    await bridge();
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    const result = await runToolContract(dataframeDropTool, { name: 'df_ABSENT' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32001,
        data: {
          reason: 'missing_table',
          recovery: { hint: expect.stringContaining('treasury_dataframe_describe') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('treasury_dataframe_describe');
  });

  it('returns canvas_unavailable with the configuration hint', async () => {
    const { initCanvasBridge } = await import('@/services/canvas-bridge/canvas-bridge.js');
    initCanvasBridge(undefined);
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    const result = await runToolContract(dataframeDropTool, { name: 'df_ABSENT' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_unavailable' } },
    });
    expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it.each(['', ' ', true, { name: 'df_test' }])(
    'rejects invalid names before deleting anything: %j',
    async (name) => {
      const { service, name: stagedName } = await stage();
      const { dataframeDropTool } = await import(
        '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
      );
      const result = await runToolContract(dataframeDropTool, { name } as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(JSON.stringify(result.content)).toContain('name');
      expect(await service.describe(ctx, stagedName)).toHaveLength(1);
    },
  );

  it('cannot drop a table from another tenant', async () => {
    const { service, name } = await stage();
    const { dataframeDropTool } = await import(
      '@/mcp-server/tools/definitions/dataframe-drop.tool.js'
    );
    const result = await runToolContract(
      dataframeDropTool,
      { name },
      { context: { tenantId: 'other' } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'missing_table' } },
    });
    expect(await service.describe(ctx, name)).toHaveLength(1);
  });
});
