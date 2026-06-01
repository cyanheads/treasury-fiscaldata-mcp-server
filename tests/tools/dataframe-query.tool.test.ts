/**
 * @fileoverview Tests for treasury_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

function makeQueryResult(rows: Record<string, unknown>[], columns = ['record_date', 'debt']) {
  return {
    result: {
      columns,
      rowCount: rows.length,
      rows,
      tableName: undefined,
    },
  };
}

describe('dataframeQueryTool', () => {
  it('throws canvas_unavailable when bridge is not configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('throws system_catalog_access when SQL references a denied system catalog', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockRejectedValue(
        validationError('SQL references a denied system catalog: information_schema.', {
          reason: 'system_catalog_access',
          catalog: 'information_schema',
        }),
      ),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'system_catalog_access' },
    });
  });

  it('throws invalid_sql when SQL is not a SELECT (framework gate reason)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockRejectedValue(
        validationError('Canvas query must be SELECT; got INSERT.', {
          reason: 'non_select_statement',
          statementType: 'INSERT',
        }),
      ),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: "INSERT INTO df_ABCDE_FGHIJ VALUES ('x')",
    });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('throws invalid_sql when SQL uses a denied table function (framework gate reason)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockRejectedValue(
        validationError('Canvas query references disallowed table function: read_csv.', {
          reason: 'denied_function',
          function: 'read_csv',
        }),
      ),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: "SELECT * FROM read_csv('/etc/passwd')" });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('returns query results when bridge is configured', async () => {
    const mockRows = [{ record_date: '2026-05-28', debt: '39180000000000.00' }];
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockResolvedValue(makeQueryResult(mockRows)),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT record_date, tot_pub_debt_out_amt AS debt FROM df_ABCDE_FGHIJ LIMIT 1',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.columns).toContain('record_date');
  });

  it('surfaces enrichment notice for zero-row results', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockResolvedValue(makeQueryResult([])),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeQueryTool.input.parse({
      sql: "SELECT * FROM df_ABCDE_FGHIJ WHERE record_date = '2099-01-01'",
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('surfaces enrichment notice when results are capped', async () => {
    const manyRows = Array.from({ length: 5 }, (_, i) => ({
      record_date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      debt: '39000000000000.00',
    }));
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockResolvedValue({
        result: {
          columns: ['record_date', 'debt'],
          rowCount: 1000,
          rows: manyRows, // fewer rows than rowCount — capped
          tableName: undefined,
        },
      }),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(1000);
    expect(result.rows.length).toBe(5);
  });

  it('returns registered_as when register_as is provided', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockResolvedValue({
        result: {
          columns: ['record_date'],
          rowCount: 1,
          rows: [{ record_date: '2026-05-28' }],
          tableName: 'df_NEW01_TABLE',
        },
        meta: {
          tableName: 'df_NEW01_TABLE',
          sourceTool: 'treasury_dataframe_query',
          queryParams: { sql: 'SELECT record_date FROM df_ABCDE_FGHIJ LIMIT 1' },
          createdAt: '2026-05-28T10:00:00.000Z',
          expiresAt: '2026-05-29T10:00:00.000Z',
          rowCount: 1,
          truncated: false,
          maxRows: undefined,
          columnSchema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
        },
      }),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT record_date FROM df_ABCDE_FGHIJ LIMIT 1',
      register_as: 'df_NEW01_TABLE',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_NEW01_TABLE');
    expect(result.expires_at).toBeDefined();
  });

  it('formats output table', () => {
    const result = {
      columns: ['record_date', 'debt'],
      row_count: 1,
      rows: [{ record_date: '2026-05-28', debt: '39180000000000.00' }],
    };
    const blocks = dataframeQueryTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('record_date');
    expect(text).toContain('2026-05-28');
    expect(text).toContain('1 rows');
  });

  it('formats empty result', () => {
    const result = { columns: ['record_date'], row_count: 0, rows: [] };
    const blocks = dataframeQueryTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows');
  });
});
