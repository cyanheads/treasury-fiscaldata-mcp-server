/**
 * @fileoverview The canvas bridge over a real DuckDB DataCanvas: one shared
 * canvas per tenant under concurrent stagings, a dead canvas's records purged
 * rather than listed, no canvas minted to describe, drop, or sweep, fixed table
 * deadlines, and the SQL and `register_as` names the canvas gate refuses.
 * Expiry runs on a fake `Date` that drives the registry clock, the bridge's
 * deadlines, and the `ctx.state` TTL on `canvas-id` together — never a sleep.
 * @module tests/services/canvas-bridge.test
 */

import { tmpdir } from 'node:os';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasBridge, maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';

type Ctx = ReturnType<typeof createMockContext>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = '2026-11-01T00:00:00.000Z';

const opened: DataCanvas[] = [];

/** A canvas whose registry reads the (fake) wall clock, with the sweeper off. */
function makeCanvas(absoluteCapMs = 7 * DAY): DataCanvas {
  const provider = new DuckdbProvider({
    defaultRowLimit: 1000,
    exportRootPath: tmpdir(),
    memoryLimitMb: 64,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(
    provider,
    { ttlMs: DAY, absoluteCapMs, maxCanvasesPerTenant: 50, sweeperIntervalMs: 0 },
    () => Date.now(),
  );
  const canvas = new DataCanvas(provider, registry);
  opened.push(canvas);
  return canvas;
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function stage(bridge: CanvasBridge, ctx: Ctx, k = 0): Promise<string> {
  const registered = await bridge.registerDataframe(ctx, {
    rows: [{ record_date: '2026-01-02', value: String(k) }],
    sourceTool: 'treasury_query_dataset',
    queryParams: { k },
  });
  expect(registered?.tableName).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
  return registered!.tableName;
}

/** `OK` when a bridge query reaches the table, otherwise the refusal's reason. */
async function reach(bridge: CanvasBridge, ctx: Ctx, table: string): Promise<string> {
  try {
    await bridge.query(ctx, `SELECT COUNT(*) AS n FROM ${table}`);
    return 'OK';
  } catch (error) {
    return String((error as McpError).data?.reason ?? (error as Error).message);
  }
}

async function listed(bridge: CanvasBridge, ctx: Ctx): Promise<string[]> {
  return (await bridge.describe(ctx)).map((meta) => meta.tableName).sort();
}

/** Every provenance key the tenant's state holds. */
async function recordKeys(ctx: Ctx): Promise<string[]> {
  return (await ctx.state.list('df-meta/')).items.map((item) => item.key).sort();
}

beforeEach(() => {
  vi.stubEnv('CANVAS_TTL_MS', undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});

afterEach(async () => {
  const ctx = createMockContext();
  for (const canvas of opened.splice(0)) await canvas.shutdown(ctx);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('one shared canvas per tenant', () => {
  it('lands five concurrent first stagings on one canvas that query reaches and describe lists', async () => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();

    const tables = await Promise.all([0, 1, 2, 3, 4].map((k) => stage(bridge, ctx, k)));

    expect(await Promise.all(tables.map((t) => reach(bridge, ctx, t)))).toEqual(
      Array(5).fill('OK'),
    );
    expect(await listed(bridge, ctx)).toEqual([...tables].sort());
    expect(canvas.countForTenant(ctx)).toBe(1);
  });

  it('lands concurrent stagings after the absolute cap on one new canvas and lists only those', async () => {
    const canvas = makeCanvas(2 * DAY);
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();

    const first = await stage(bridge, ctx, 9);
    advance(23 * HOUR);
    expect(await reach(bridge, ctx, first)).toBe('OK');
    advance(23 * HOUR);
    const late = await stage(bridge, ctx, 8);
    advance(2 * HOUR + 1000); // past the 48h cap, before `late`'s own deadline

    const fresh = await Promise.all([0, 1, 2, 3, 4].map((k) => stage(bridge, ctx, k)));

    /**
     * Read before any query or describe: `late` is short of its own deadline,
     * so only the purge on replacement removes its record here. A query's sweep
     * would not, and describe's orphan delete would hide a missing purge.
     */
    expect(await recordKeys(ctx)).toEqual(fresh.map((t) => `df-meta/${t}`).sort());
    expect(await Promise.all(fresh.map((t) => reach(bridge, ctx, t)))).toEqual(Array(5).fill('OK'));
    expect(await listed(bridge, ctx)).toEqual([...fresh].sort());
    expect(await reach(bridge, ctx, late)).toBe('missing_table');
  });

  it('keeps resolving a canvas id already stored under canvas-id', async () => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();
    const existing = await canvas.acquire(undefined, ctx);
    await ctx.state.set('canvas-id', existing.canvasId);

    const table = await stage(bridge, ctx, 7);

    expect((await existing.query(`SELECT value FROM ${table}`)).rows).toEqual([{ value: '7' }]);
    expect(canvas.countForTenant(ctx)).toBe(1);
  });
});

describe("a dead canvas's records are deleted, not listed", () => {
  it('purges them once the canvas passes its absolute cap before a table deadline', async () => {
    const bridge = new CanvasBridge(makeCanvas(2 * DAY));
    const ctx = createMockContext();

    const first = await stage(bridge, ctx, 1);
    advance(20 * HOUR);
    expect(await reach(bridge, ctx, first)).toBe('OK');
    advance(20 * HOUR);
    const late = await stage(bridge, ctx, 2);
    expect((await bridge.describe(ctx)).map((m) => [m.tableName, m.expiresAt])).toEqual([
      [late, '2026-11-03T16:00:00.000Z'],
    ]);
    advance(8 * HOUR + 1000); // the canvas reached its 48h cap; `late` is 16h short of its deadline

    expect(await bridge.describe(ctx)).toEqual([]);
    expect(await recordKeys(ctx)).toEqual([]);
    expect(await reach(bridge, ctx, late)).toBe('missing_table');
  });

  it('purges records a previous process left in persistent state', async () => {
    const ctx = createMockContext();
    const table = await stage(new CanvasBridge(makeCanvas()), ctx, 1);

    const restarted = new CanvasBridge(makeCanvas());

    expect(await restarted.describe(ctx)).toEqual([]);
    expect(await recordKeys(ctx)).toEqual([]);
    expect(await reach(restarted, ctx, table)).toBe('missing_table');
  });
});

describe('describe, drop, and the expiry sweep mint no canvas', () => {
  it('leaves a tenant with no canvas without one', async () => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();

    expect(await bridge.describe(ctx)).toEqual([]);
    expect(await bridge.describe(ctx, 'df_ABCDE_FGHIJ')).toEqual([]);
    expect(await bridge.drop(ctx, 'df_ABCDE_FGHIJ')).toBe(false);
    expect(canvas.countForTenant(ctx)).toBe(0);
    expect(await ctx.state.get('canvas-id')).toBeNull();
  });

  it('sweeps the expired records of a dead canvas without minting a replacement', async () => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();
    await stage(bridge, ctx, 1);
    advance(DAY + HOUR); // the canvas idled out and the table passed its deadline
    // The registry counts the dead canvas until its sweeper runs, which is off here.
    const canvases = canvas.countForTenant(ctx);

    expect(await bridge.describe(ctx)).toEqual([]);
    expect(await recordKeys(ctx)).toEqual([]);
    expect(await ctx.state.get('canvas-id')).toBeNull();
    expect(canvas.countForTenant(ctx)).toBe(canvases);
  });
});

describe('table expiry', () => {
  it('keeps a table deadline fixed at staging when the table is queried', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const registered = await bridge.registerDataframe(ctx, {
      rows: [{ value: '1' }],
      sourceTool: 'treasury_get_debt',
      queryParams: {},
    });
    expect(registered?.expiresAt).toBe('2026-11-02T00:00:00.000Z');

    advance(HOUR);
    expect(await reach(bridge, ctx, registered!.tableName)).toBe('OK');

    expect((await bridge.describe(ctx)).map((m) => m.expiresAt)).toEqual([
      '2026-11-02T00:00:00.000Z',
    ]);
  });

  it('drops a table past its own deadline while newer tables on the live canvas stay', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const older = await stage(bridge, ctx, 1);
    advance(HOUR);
    expect(await reach(bridge, ctx, older)).toBe('OK');
    advance(12 * HOUR);
    const newer = await stage(bridge, ctx, 2);
    advance(11 * HOUR + 1000); // `older` is past its deadline; the canvas was touched 11h ago

    // The query's own sweep drops `older` — no describe has run to do it first.
    expect(await reach(bridge, ctx, older)).toBe('missing_table');
    expect(await recordKeys(ctx)).toEqual([`df-meta/${newer}`]);
    expect(await listed(bridge, ctx)).toEqual([newer]);
    expect(await reach(bridge, ctx, newer)).toBe('OK');
  });

  it('expires a table at its deadline, not one moment after', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const table = await stage(bridge, ctx, 1); // deadline 2026-11-02T00:00:00.000Z
    advance(12 * HOUR);
    expect(await reach(bridge, ctx, table)).toBe('OK'); // keeps the canvas alive past the deadline

    advance(12 * HOUR - 1);
    expect(await reach(bridge, ctx, table)).toBe('OK');
    advance(1);
    expect(new Date().toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(await reach(bridge, ctx, table)).toBe('missing_table');
  });

  /**
   * Two tables, `older` past its deadline and `newer` short of it, on a canvas
   * kept alive between them. Each path below runs with no describe before it,
   * so describe's sweep cannot stand in for the path's own.
   */
  async function oneExpiredOneLive(): Promise<{
    bridge: CanvasBridge;
    canvas: DataCanvas;
    ctx: Ctx;
    older: string;
    newer: string;
  }> {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();
    const older = await stage(bridge, ctx, 1);
    advance(13 * HOUR);
    const newer = await stage(bridge, ctx, 2);
    advance(11 * HOUR + 1000);
    return { bridge, canvas, ctx, older, newer };
  }

  /** Table names on the tenant's live canvas, read without going through the bridge. */
  async function onCanvas(canvas: DataCanvas, ctx: Ctx): Promise<string[]> {
    const live = await canvas.acquire((await ctx.state.get<string>('canvas-id'))!, ctx);
    return (await live.describe({ kind: 'table' })).map((t) => t.name).sort();
  }

  it('sweeps an expired table when another is staged', async () => {
    const { bridge, canvas, ctx, older, newer } = await oneExpiredOneLive();

    const third = await stage(bridge, ctx, 3);

    expect(await recordKeys(ctx)).toEqual([`df-meta/${newer}`, `df-meta/${third}`].sort());
    expect(await onCanvas(canvas, ctx)).not.toContain(older);
  });

  it('sweeps an expired table when another is dropped', async () => {
    const { bridge, canvas, ctx, older, newer } = await oneExpiredOneLive();
    expect(await onCanvas(canvas, ctx)).toEqual([newer, older].sort());

    expect(await bridge.drop(ctx, newer)).toBe(true);

    expect(await recordKeys(ctx)).toEqual([]);
    expect(await onCanvas(canvas, ctx)).toEqual([]);
  });

  it('carries truncated and maxRows from staging through describe', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const capped = await bridge.registerDataframe(ctx, {
      rows: [{ value: '1' }, { value: '2' }],
      sourceTool: 'treasury_get_debt',
      queryParams: {},
      truncated: true,
      maxRows: 2,
    });
    advance(1000);
    const whole = await stage(bridge, ctx, 1);

    expect((await bridge.describe(ctx)).map((m) => [m.tableName, m.truncated, m.maxRows])).toEqual([
      [whole, false, undefined],
      [capped!.tableName, true, 2],
    ]);
  });
});

describe('describe order', () => {
  it('lists tables newest first', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const staged: string[] = [];
    for (const k of [1, 2, 3, 4]) {
      staged.push(await stage(bridge, ctx, k));
      advance(HOUR);
    }

    expect((await bridge.describe(ctx)).map((m) => m.tableName)).toEqual(staged.reverse());
  });
});

describe('provenance records', () => {
  it('records an all-nullable VARCHAR schema for staged Treasury rows', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const schema = [
      { name: 'record_date', type: 'VARCHAR', nullable: true },
      { name: 'value', type: 'VARCHAR', nullable: true },
    ];

    const registered = await bridge.registerDataframe(ctx, {
      rows: [
        { record_date: '2026-01-02', value: '12.50' },
        { record_date: '2026-01-05', value: 'null' },
      ],
      sourceTool: 'treasury_query_dataset',
      queryParams: {},
    });

    expect(registered?.columnSchema).toEqual(schema);
    expect((await bridge.describe(ctx)).map((m) => m.columnSchema)).toEqual([schema]);
  });

  it('reads records past the first page of 100', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const kept = await stage(bridge, ctx, 1);
    const [meta] = await bridge.describe(ctx);
    // Records past their deadline whose tables were never staged — 150 is two pages.
    await Promise.all(
      Array.from({ length: 150 }, (_, i) => {
        const tableName = `df_PAGE0_${String(i).padStart(5, '0')}`;
        return ctx.state.set(`df-meta/${tableName}`, {
          ...meta!,
          tableName,
          expiresAt: '2026-10-31T23:59:59.999Z',
        });
      }),
    );
    expect(await recordKeys(ctx)).toHaveLength(151);

    expect((await bridge.describe(ctx)).map((m) => m.tableName)).toEqual([kept]);
    expect(await recordKeys(ctx)).toEqual([`df-meta/${kept}`]);
  });

  it('stages nothing and writes no record when the canvas refuses the rows', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const options = {
      rows: [{ 'not an identifier': '1' }],
      sourceTool: 'treasury_query_dataset',
      queryParams: {},
    };

    expect(await bridge.registerDataframe(ctx, options)).toBeUndefined();
    expect(await maybeRegisterDataframe(ctx, bridge, options.rows, options)).toEqual({});

    expect(await recordKeys(ctx)).toEqual([]);
    expect(await bridge.describe(ctx)).toEqual([]);
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({ level: 'warning', msg: 'Dataframe registration failed' }),
    );
  });
});

describe('describe lists only tables a query can reach', () => {
  it('deletes a record whose table is no longer on the live canvas', async () => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();
    const gone = await stage(bridge, ctx, 1);
    const kept = await stage(bridge, ctx, 2);
    // A record outliving its table — what a staging that committed to a canvas
    // just before it was replaced leaves behind.
    const live = await canvas.acquire((await ctx.state.get<string>('canvas-id'))!, ctx);
    await live.drop(gone);

    expect(await listed(bridge, ctx)).toEqual([kept]);
    expect(await recordKeys(ctx)).toEqual([`df-meta/${kept}`]);
  });

  it('keeps the record of a table that commits while describe is reading provenance', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const before = await stage(bridge, ctx, 1);
    const list = ctx.state.list.bind(ctx.state);
    let during: string | undefined;
    vi.spyOn(ctx.state, 'list').mockImplementationOnce(async (...args) => {
      during = await stage(bridge, ctx, 2);
      return await list(...args);
    });

    await bridge.describe(ctx);

    expect(during).toBeDefined();
    expect(await recordKeys(ctx)).toEqual([`df-meta/${before}`, `df-meta/${during}`].sort());
    expect(await listed(bridge, ctx)).toEqual([before, during!].sort());
    expect(await reach(bridge, ctx, during!)).toBe('OK');
  });
});

describe('query mints a canvas on demand', () => {
  it('runs SQL that names no staged table for a tenant with no canvas', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    const { result, meta } = await bridge.query(ctx, 'SELECT 1 AS one');

    expect(result.rows).toEqual([{ one: 1 }]);
    expect(meta).toBeUndefined();
  });

  it('registers a register_as result for a tenant with no canvas and lists it', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    const { meta } = await bridge.query(ctx, 'SELECT 1 AS one', { registerAs: 'df_one' });

    expect(meta?.tableName).toBe('df_one');
    expect(await listed(bridge, ctx)).toEqual(['df_one']);
    expect(await reach(bridge, ctx, 'df_one')).toBe('OK');
  });
});

describe('a register_as record carries the column types the canvas holds', () => {
  const SQL =
    "SELECT CAST(tot AS DECIMAL(20,2)) AS amt, 1 AS one, record_date FROM (SELECT '12.5' AS tot, '2026-01-02' AS record_date)";
  const COLUMNS = [
    { name: 'amt', type: 'VARCHAR', engineType: 'DECIMAL(20,2)', nullable: true },
    { name: 'one', type: 'INTEGER', engineType: 'INTEGER', nullable: true },
    { name: 'record_date', type: 'VARCHAR', engineType: 'VARCHAR', nullable: true },
  ];

  it('records the type tag and the exact engine type of every column', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    const { meta } = await bridge.query(ctx, SQL, { registerAs: 'df_typed' });

    expect(meta?.columnSchema).toEqual(COLUMNS);
    expect((await bridge.describe(ctx, 'df_typed')).map((m) => m.columnSchema)).toEqual([COLUMNS]);
  });

  it('writes no record for a table dropped before its types were read', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    // What a concurrent drop of the new name between the two calls leaves.
    vi.spyOn(DuckdbProvider.prototype, 'describe').mockResolvedValueOnce([]);

    await expect(bridge.query(ctx, SQL, { registerAs: 'df_typed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table', tableName: 'df_typed' },
    });
    expect(await recordKeys(ctx)).toEqual([]);
  });
});

describe('SQL the canvas gate refuses', () => {
  /**
   * Every call here binds — the binder refuses `which_secret()` with no
   * arguments on its own, which would pass without the gate. The reason and
   * the operator name are the gate's.
   */
  it.each([
    "SELECT * FROM which_secret('s3://bucket/', 'S3')",
    "SELECT 'x', * FROM WHICH_SECRET('s3://bucket/', 'S3')",
    "SELECT * FROM which_secret('s3://x/y', 's3')",
  ])('refuses %s as a disallowed plan operator', async (sql) => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    await expect(bridge.query(ctx, sql)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Canvas query contains disallowed operators: WHICH_SECRET.',
      data: { reason: 'plan_operator_not_allowed', operators: ['WHICH_SECRET'] },
    });
  });

  /**
   * The bridge sets `denySystemCatalogs`. Without it DuckDB still refuses
   * these, but as `plan_operator_not_allowed`, which the query tool would
   * report as invalid SQL rather than as catalog access.
   */
  it.each([
    ['SELECT * FROM information_schema.tables', 'information_schema'],
    ['SELECT * FROM duckdb_tables()', 'duckdb_tables'],
  ])('refuses %s as system catalog access', async (sql, catalog) => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    await expect(bridge.query(ctx, sql)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'system_catalog_access', catalog },
    });
  });

  it('still runs a query whose string literal spells which_secret', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    const { result } = await bridge.query(ctx, "SELECT 'which_secret' AS name");

    expect(result.rows).toEqual([{ name: 'which_secret' }]);
  });
});

/**
 * DuckDB's internal metadata views in the `system` catalog's `main` and
 * `pg_catalog` schemas — what `duckdb_views()` lists as internal on DuckDB
 * 2.0.0. The canvas gate refuses every later query that names one, and two
 * (`duckdb_columns`, `duckdb_views`) break the canvas's own describe and
 * `register_as` once a table takes their name.
 */
const INTERNAL_METADATA_VIEWS = [
  'duckdb_columns',
  'duckdb_constraints',
  'duckdb_databases',
  'duckdb_indexes',
  'duckdb_logs',
  'duckdb_schemas',
  'duckdb_tables',
  'duckdb_types',
  'duckdb_views',
  'pragma_database_list',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'pg_am',
  'pg_attrdef',
  'pg_attribute',
  'pg_class',
  'pg_collation',
  'pg_constraint',
  'pg_database',
  'pg_depend',
  'pg_description',
  'pg_enum',
  'pg_index',
  'pg_indexes',
  'pg_namespace',
  'pg_prepared_statements',
  'pg_proc',
  'pg_sequence',
  'pg_sequences',
  'pg_settings',
  'pg_tables',
  'pg_tablespace',
  'pg_type',
  'pg_views',
];

const CATALOG_NAMES = [...INTERNAL_METADATA_VIEWS, 'information_schema', 'pg_catalog'].flatMap(
  (name) => [name, name.toUpperCase(), `${name[0]!.toUpperCase()}${name.slice(1)}`],
);

describe('register_as names the canvas gate would refuse', () => {
  it('covers every internal view and both catalog schemas in three casings', () => {
    expect(CATALOG_NAMES).toHaveLength(38 * 3);
  });

  it.each(CATALOG_NAMES)('refuses %s before anything is staged', async (name) => {
    const canvas = makeCanvas();
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext();

    const error = await bridge.query(ctx, 'SELECT 1 AS one', { registerAs: name }).then(
      () => undefined,
      (e: unknown) => e as McpError,
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'system_catalog_access',
        recovery: { hint: expect.stringMatching(/another name.*df_/) },
      },
    });
    expect(error?.message).toContain(`"${name}"`);
    // The message alone still says what to do when a caller replaces the hint.
    expect(error?.message).toContain('Choose another name');
    expect(canvas.countForTenant(ctx)).toBe(0);
    expect(await ctx.state.get('canvas-id')).toBeNull();
  });

  it('leaves register_as and describe working on the canvas after a refused name', async () => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();
    const staged = await stage(bridge, ctx, 1);

    await expect(
      bridge.query(ctx, `SELECT * FROM ${staged}`, { registerAs: 'duckdb_views' }),
    ).rejects.toMatchObject({ data: { reason: 'system_catalog_access' } });

    const { meta } = await bridge.query(ctx, `SELECT * FROM ${staged}`, {
      registerAs: 'df_after',
    });
    expect(meta?.tableName).toBe('df_after');
    expect(await listed(bridge, ctx)).toEqual(['df_after', staged].sort());
  });

  it.each(['df_debt', 'tables', 'pg_tables_total'])('admits %s', async (name) => {
    const bridge = new CanvasBridge(makeCanvas());
    const ctx = createMockContext();

    const { meta } = await bridge.query(ctx, 'SELECT 1 AS one', { registerAs: name });

    expect(meta?.tableName).toBe(name);
    expect(await reach(bridge, ctx, name)).toBe('OK');
    expect(await listed(bridge, ctx)).toEqual([name]);
  });
});
