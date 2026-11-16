/**
 * @fileoverview Tests for treasury_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { tmpdir } from 'node:os';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentText, parseMarkdown, readInlines } from '../helpers/markdown-read-back.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import type { DataframeMeta } from '@/services/canvas-bridge/canvas-bridge.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const SAMPLE_META: DataframeMeta = {
  tableName: 'df_ABCDE_FGHIJ',
  sourceTool: 'treasury_get_debt',
  queryParams: { mode: 'series', start_date: '2026-01-01' },
  createdAt: '2026-05-28T10:00:00.000Z',
  expiresAt: '2026-05-29T10:00:00.000Z',
  rowCount: 100,
  truncated: false,
  maxRows: undefined,
  columnSchema: [
    { name: 'record_date', type: 'VARCHAR', nullable: true },
    { name: 'tot_pub_debt_out_amt', type: 'VARCHAR', nullable: true },
  ],
};

describe('dataframeDescribeTool', () => {
  it('throws canvas_unavailable when bridge is not configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: dataframeDescribeTool.errors,
    });
    const input = dataframeDescribeTool.input.parse({});
    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('lists active dataframes when canvas is configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([SAMPLE_META]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: dataframeDescribeTool.errors,
    });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    const df = result.dataframes[0];
    expect(df?.name).toBe('df_ABCDE_FGHIJ');
    expect(df?.source_tool).toBe('treasury_get_debt');
    expect(df?.row_count).toBe(100);
    expect(df?.truncated).toBe(false);
    expect(df?.column_schema).toEqual([
      { name: 'record_date', type: 'VARCHAR', nullable: true },
      { name: 'tot_pub_debt_out_amt', type: 'VARCHAR', nullable: true },
    ]);
  });

  it.each([
    [{ name: '  df_ABCDE_FGHIJ  ' }, 'df_ABCDE_FGHIJ'],
    [{ name: 'df_ABCDE_FGHIJ' }, 'df_ABCDE_FGHIJ'],
    [{ name: '   ' }, undefined],
    [{}, undefined],
  ])('asks the bridge for %j as %j', async (raw, requested) => {
    const describeTables = vi.fn().mockResolvedValue([]);
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: describeTables,
    } as unknown as ReturnType<typeof getCanvasBridge>);
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });

    await dataframeDescribeTool.handler(dataframeDescribeTool.input.parse(raw), ctx);

    expect(describeTables).toHaveBeenCalledExactlyOnceWith(ctx, requested);
  });

  it('reports truncation, its cap, and an unrecorded nullable on both surfaces', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([
        {
          ...SAMPLE_META,
          truncated: true,
          maxRows: 5000,
          columnSchema: [{ name: 'record_date', type: 'VARCHAR' }],
        },
        { ...SAMPLE_META, tableName: 'df_KLMNO_PQRST', truncated: true, maxRows: undefined },
      ]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const result = await runToolContract(dataframeDescribeTool, {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          truncated: true,
          max_rows: 5000,
          column_schema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
        },
        { name: 'df_KLMNO_PQRST', truncated: true },
      ],
    });
    expect(
      (result.structuredContent as { dataframes: { max_rows?: number }[] }).dataframes[1]?.max_rows,
    ).toBeUndefined();
    const lines = readInlines(contentText(result.content));
    expect(lines).toContain('Rows: 100 (truncated at 5000)');
    expect(lines).toContain('Rows: 100 (truncated)');
    expect(lines).toContain('Columns: record_date:VARCHAR (nullable:true)');
  });

  it('reports a recorded engine type in place of the type tag', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([
        {
          ...SAMPLE_META,
          columnSchema: [
            { name: 'amt', type: 'VARCHAR', engineType: 'DECIMAL(20,2)', nullable: true },
            { name: 'record_date', type: 'VARCHAR', nullable: true },
          ],
        },
      ]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const result = await runToolContract(dataframeDescribeTool, {});

    expect(result.structuredContent).toMatchObject({
      dataframes: [
        {
          column_schema: [
            { name: 'amt', type: 'DECIMAL(20,2)', nullable: true },
            { name: 'record_date', type: 'VARCHAR', nullable: true },
          ],
        },
      ],
    });
    expect(readInlines(contentText(result.content))).toContain(
      'Columns: amt:DECIMAL(20,2) (nullable:true), record_date:VARCHAR (nullable:true)',
    );
  });

  it('returns empty array when no dataframes are registered', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: dataframeDescribeTool.errors,
    });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(0);
  });

  it('filters to a named dataframe when name is provided', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([SAMPLE_META]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: dataframeDescribeTool.errors,
    });
    const input = dataframeDescribeTool.input.parse({ name: 'df_ABCDE_FGHIJ' });
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    expect(result.dataframes[0]?.name).toBe('df_ABCDE_FGHIJ');
  });

  it('formats output with nullable column info', () => {
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'treasury_get_debt',
          query_params: { mode: 'series' },
          created_at: '2026-05-28T10:00:00.000Z',
          expires_at: '2026-05-29T10:00:00.000Z',
          row_count: 100,
          truncated: false,
          max_rows: undefined,
          column_schema: [
            { name: 'record_date', type: 'VARCHAR', nullable: true },
            { name: 'tot_pub_debt_out_amt', type: 'VARCHAR', nullable: false },
          ],
        },
      ],
    };
    const blocks = dataframeDescribeTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABCDE_FGHIJ');
    expect(text).toContain('nullable:true');
    expect(text).toContain('nullable:false');
    expect(text).toContain('treasury_get_debt');
    expect(text).toContain('100');
  });

  it('omits query params the source tool was never given', () => {
    /**
     * The source tools hand their whole input through as query params, so an
     * optional one that was never supplied arrives as an undefined value.
     * Rendering it prints `security_type=undefined`, which reads as a filter the
     * dataframe was built with.
     */
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'treasury_get_interest_rates',
          query_params: {
            mode: 'series',
            security_type: undefined,
            start_date: '2026-01-01',
            end_date: undefined,
          },
          created_at: '2026-05-28T10:00:00.000Z',
          expires_at: '2026-05-29T10:00:00.000Z',
          row_count: 100,
          truncated: false,
          max_rows: undefined,
          column_schema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
        },
      ],
    };
    const text = (dataframeDescribeTool.format!(result)[0] as { text: string }).text;

    expect(text).not.toContain('undefined');
    expect(text).toContain('mode="series"');
    expect(text).toContain('start_date="2026-01-01"');
  });

  it('keeps a param whose value is genuinely null', () => {
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'treasury_query_dataset',
          query_params: { sort: null },
          created_at: '2026-05-28T10:00:00.000Z',
          expires_at: '2026-05-29T10:00:00.000Z',
          row_count: 1,
          truncated: false,
          max_rows: undefined,
          column_schema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
        },
      ],
    };
    const text = (dataframeDescribeTool.format!(result)[0] as { text: string }).text;

    expect(text).toContain('sort=null');
  });

  it('drops the params line entirely when every param is unset', () => {
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'treasury_get_debt',
          query_params: { start_date: undefined, end_date: undefined },
          created_at: '2026-05-28T10:00:00.000Z',
          expires_at: '2026-05-29T10:00:00.000Z',
          row_count: 1,
          truncated: false,
          max_rows: undefined,
          column_schema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
        },
      ],
    };
    const text = (dataframeDescribeTool.format!(result)[0] as { text: string }).text;

    expect(text).not.toContain('- Params:');
  });

  it('formats empty state', () => {
    const result = { dataframes: [] };
    const blocks = dataframeDescribeTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active dataframes');
  });
});

/**
 * A table name, a source tool's parameters (a treasury_dataframe_query SQL
 * string among them), and a column name (a SQL alias) are text this server did
 * not write. content[] has to read back, under a real CommonMark parse, as the
 * values structuredContent carries — never as emphasis, a link, a code span, an
 * entity, or a line that starts a new block.
 */
describe('content[] reads back the values structuredContent carries', () => {
  it.each([
    'COUNT(*) … COUNT(*)',
    'SELECT COUNT(*) AS a, COUNT(*) AS b FROM df_x',
    'a_b_c',
    'a`b',
    '[x](y)',
    '&amp;',
    '  lead and trail  ',
    '*a* <b>x</b>',
    '# not a heading',
    'line\nbreak',
    'crlf\r\nbreak',
    'cr\rbreak',
    'backslash\\\nbefore a break',
  ])('%j as a table name, a query parameter, and a column name', async (value) => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([
        {
          ...SAMPLE_META,
          tableName: value,
          queryParams: { sql: value },
          columnSchema: [{ name: value, type: 'VARCHAR', nullable: true }],
        },
      ]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const result = await runToolContract(dataframeDescribeTool, {});

    const [df] = (
      result.structuredContent as {
        dataframes: {
          name: string;
          query_params: { sql: string };
          column_schema: { name: string }[];
        }[];
      }
    ).dataframes;
    expect([df?.name, df?.query_params.sql, df?.column_schema[0]?.name]).toEqual([
      value,
      value,
      value,
    ]);
    const text = contentText(result.content);
    expect(readInlines(text)).toEqual([
      '⟦strong_open⟧1 active dataframe(s):⟦strong_close⟧',
      df!.name,
      'Source: treasury_get_debt',
      'Rows: 100',
      'Created: 2026-05-28T10:00:00.000Z — Expires: 2026-05-29T10:00:00.000Z',
      `Params: sql=${JSON.stringify(df!.query_params.sql)}`,
      `Columns: ${df!.column_schema[0]!.name}:VARCHAR (nullable:true)`,
    ]);
    expect(parseMarkdown(text).filter((token) => token.type === 'heading_open')).toHaveLength(1);
  });
});

/**
 * Through the real bridge and a DuckDB canvas: a table treasury_dataframe_query
 * registers keeps the types its SELECT produced, and describe has to report
 * those rather than the VARCHAR of the tables the data tools stage.
 */
describe('a register_as table on a real canvas', () => {
  const opened: DataCanvas[] = [];

  afterEach(async () => {
    for (const canvas of opened.splice(0)) await canvas.shutdown(createMockContext());
  });

  it('reports the column types its SELECT produced on both surfaces', async () => {
    const { CanvasBridge } = await vi.importActual<
      typeof import('@/services/canvas-bridge/canvas-bridge.js')
    >('@/services/canvas-bridge/canvas-bridge.js');
    const provider = new DuckdbProvider({
      defaultRowLimit: 1000,
      exportRootPath: tmpdir(),
      memoryLimitMb: 64,
      schemaSniffRows: 100,
    });
    const canvas = new DataCanvas(provider, new CanvasRegistry(provider));
    opened.push(canvas);
    const bridge = new CanvasBridge(canvas);
    vi.mocked(getCanvasBridge).mockReturnValue(bridge);
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    await bridge.query(ctx, "SELECT CAST('12.5' AS DECIMAL(20,2)) AS amt, 1 AS one", {
      registerAs: 'df_typed',
    });

    const result = await dataframeDescribeTool.handler(dataframeDescribeTool.input.parse({}), ctx);

    expect(result.dataframes.map((df) => [df.name, df.column_schema])).toEqual([
      [
        'df_typed',
        [
          { name: 'amt', type: 'DECIMAL(20,2)', nullable: true },
          { name: 'one', type: 'INTEGER', nullable: true },
        ],
      ],
    ]);
    expect(readInlines(contentText(dataframeDescribeTool.format!(result)))).toContain(
      'Columns: amt:DECIMAL(20,2) (nullable:true), one:INTEGER (nullable:true)',
    );
  });
});
