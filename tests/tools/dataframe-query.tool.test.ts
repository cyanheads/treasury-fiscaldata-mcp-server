/**
 * @fileoverview Tests for treasury_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/** A bridge query result. `rowCount` above `rows.length` is a capped result. */
function makeQueryResult(
  rows: Record<string, unknown>[],
  rowCount = rows.length,
  columns = ['record_date', 'debt'],
) {
  return {
    result: {
      columns,
      rowCount,
      rows,
      tableName: undefined,
    },
  };
}

function rejectWith(error: unknown) {
  vi.mocked(getCanvasBridge).mockReturnValue({
    query: vi.fn().mockRejectedValue(error),
  } as unknown as ReturnType<typeof getCanvasBridge>);
}

function resolveWith(queryResult: ReturnType<typeof makeQueryResult>) {
  vi.mocked(getCanvasBridge).mockReturnValue({
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as ReturnType<typeof getCanvasBridge>);
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
    rejectWith(
      validationError('SQL references a denied system catalog: information_schema.', {
        reason: 'system_catalog_access',
        catalog: 'information_schema',
      }),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'system_catalog_access' },
    });
  });

  it('throws invalid_sql when SQL is not a SELECT (framework gate reason)', async () => {
    rejectWith(
      validationError('Canvas query must be SELECT; got INSERT.', {
        reason: 'non_select_statement',
        statementType: 'INSERT',
      }),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: "INSERT INTO df_ABCDE_FGHIJ VALUES ('x')",
    });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('throws invalid_sql when SQL uses a denied table function (framework gate reason)', async () => {
    rejectWith(
      validationError('Canvas query references disallowed table function: read_csv.', {
        reason: 'denied_function',
        function: 'read_csv',
      }),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: "SELECT * FROM read_csv('/etc/passwd')" });
    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_sql' },
    });
  });

  it('returns query results when bridge is configured', async () => {
    const mockRows = [{ record_date: '2026-05-28', debt: '39180000000000.00' }];
    resolveWith(makeQueryResult(mockRows));

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT record_date, tot_pub_debt_out_amt AS debt FROM df_ABCDE_FGHIJ LIMIT 1',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.columns).toContain('record_date');
  });

  it('surfaces enrichment notice for zero-row results', async () => {
    resolveWith(makeQueryResult([]));

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
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
    // Fewer rows than rowCount — capped.
    resolveWith(makeQueryResult(manyRows, 1000));

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
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

    const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT record_date FROM df_ABCDE_FGHIJ LIMIT 1',
      register_as: 'df_NEW01_TABLE',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_NEW01_TABLE');
    expect(result.expires_at).toBeDefined();
  });

  describe('rerouted canvas errors', () => {
    /** The declared hint for a reason — the contract is the source of truth. */
    function declaredRecovery(reason: string): string | undefined {
      return dataframeQueryTool.errors?.find((entry) => entry.reason === reason)?.recovery;
    }

    it('carries the declared recovery hint for system_catalog_access', async () => {
      rejectWith(
        validationError('SQL references a denied system catalog: information_schema.', {
          reason: 'system_catalog_access',
          catalog: 'information_schema',
        }),
      );

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM information_schema.tables',
      });
      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'system_catalog_access',
          recovery: { hint: declaredRecovery('system_catalog_access') },
        },
      });
    });

    it.each([
      ['non_select_statement', 'Canvas query must be SELECT; got INSERT.'],
      ['multi_statement', 'Canvas query must be a single statement.'],
      ['denied_function', 'Canvas query references disallowed table function: read_csv.'],
      ['identifier_shape', 'Canvas identifier has an unsupported shape.'],
      // The framework's own reason for a SELECT-shaped statement that fails to
      // prepare (unknown column/function) — same string as this tool's contract
      // reason, and previously the one gate reason that escaped the reroute.
      ['invalid_sql', 'Canvas query failed to prepare: Referenced column "nope" not found.'],
    ])('maps gate reason %s to invalid_sql with a recovery hint', async (reason, message) => {
      rejectWith(validationError(message, { reason }));

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT nope FROM df_ABCDE_FGHIJ' });
      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
        message,
        data: {
          reason: 'invalid_sql',
          canvas_reason: reason,
          recovery: { hint: declaredRecovery('invalid_sql') },
        },
      });
    });

    it('chains the originating canvas error as the cause', async () => {
      const original = validationError('Canvas query must be SELECT; got INSERT.', {
        reason: 'non_select_statement',
      });
      rejectWith(original);

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: "INSERT INTO df_ABCDE_FGHIJ VALUES ('x')",
      });
      let caught: unknown;
      try {
        await dataframeQueryTool.handler(input, ctx);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error | undefined)?.cause).toBe(original);
    });

    /** A missing table, exactly as the framework canvas layer raises it. */
    function missingTableError() {
      return notFound(
        'Canvas table "df_ABCDE_FGHIJ" does not exist. The table may have expired or been dropped — re-stage it or call describe() to inspect the canvas.',
        {
          reason: 'missing_table',
          tableName: 'df_ABCDE_FGHIJ',
          recovery: {
            hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
          },
        },
      );
    }

    it('keeps a missing table inside the declared contract as NotFound', async () => {
      rejectWith(missingTableError());

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' });
      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'missing_table',
          tableName: 'df_ABCDE_FGHIJ',
          recovery: { hint: declaredRecovery('missing_table') },
        },
      });
      expect(dataframeQueryTool.errors?.map((entry) => entry.reason)).toContain('missing_table');
    });

    it('replaces the framework hint with remedies an MCP client can reach', async () => {
      rejectWith(missingTableError());

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' });
      const error = (await Promise.resolve(dataframeQueryTool.handler(input, ctx)).catch(
        (err: unknown) => err,
      )) as {
        message: string;
        data: { recovery?: { hint?: string } };
      };

      const hint = String(error.data.recovery?.hint);
      expect(hint).toContain('treasury_dataframe_describe');
      expect(hint).toContain('canvas_id');
      expect(hint).not.toContain('registerTable()');
      expect(hint).not.toContain('describe()');
      // The framework's own message names describe() too — it must not survive either.
      expect(error.message).not.toContain('describe()');
    });

    it('chains the originating missing-table error as the cause', async () => {
      const original = missingTableError();
      rejectWith(original);

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' });
      const caught = await Promise.resolve(dataframeQueryTool.handler(input, ctx)).catch(
        (err: unknown) => err,
      );
      expect((caught as Error).cause).toBe(original);
    });

    it('restates a canvas bound violation in this tool parameter names', async () => {
      rejectWith(
        validationError('preview must be a non-negative safe integer no greater than rowLimit.', {
          reason: 'invalid_query_bounds',
          field: 'preview',
        }),
      );

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_ABCDE_FGHIJ',
        preview: 2000,
        row_limit: 1000,
      });
      const error = (await Promise.resolve(dataframeQueryTool.handler(input, ctx)).catch(
        (err: unknown) => err,
      )) as {
        message: string;
        data: { reason?: string; recovery?: { hint?: string } };
      };

      expect(error.data.reason).toBe('invalid_query_bounds');
      expect(error.message).toContain('row_limit');
      expect(error.message).not.toContain('rowLimit');
      expect(String(error.data.recovery?.hint)).toBe(declaredRecovery('invalid_query_bounds'));
    });
  });

  describe('truncation guidance', () => {
    /** A result capped below its true row count, so `truncated()` fires. */
    function useCappedResult() {
      resolveWith(makeQueryResult([{ record_date: '2026-05-28' }], 9000, ['record_date']));
    }

    it('names row_limit when no preview was supplied', async () => {
      useCappedResult();
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ', row_limit: 500 }),
        ctx,
      );

      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, cap: 500 });
      expect(String(getEnrichment(ctx).notice)).toContain('row_limit');
    });

    it('names preview when preview is the binding cap', async () => {
      useCappedResult();
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({
          sql: 'SELECT * FROM df_ABCDE_FGHIJ',
          preview: 10,
          row_limit: 5000,
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(getEnrichment(ctx)).toMatchObject({ cap: 10 });
      expect(notice).toContain('preview');
      expect(notice).not.toMatch(/raise row_limit/);
    });

    it('names preview at the zero boundary, where nothing is shown', async () => {
      useCappedResult();
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ', preview: 0 }),
        ctx,
      );

      expect(getEnrichment(ctx)).toMatchObject({ cap: 0 });
      expect(String(getEnrichment(ctx).notice)).toContain('preview');
    });

    it('names both levers when preview and row_limit are equal', async () => {
      useCappedResult();
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({
          sql: 'SELECT * FROM df_ABCDE_FGHIJ',
          preview: 400,
          row_limit: 400,
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('preview');
      expect(notice).toContain('row_limit');
    });
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
