/**
 * @fileoverview Tests for treasury_dataframe_query tool.
 * @module tests/tools/dataframe-query.tool.test
 */

import { tmpdir } from 'node:os';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contentText,
  HOSTILE_VALUE,
  readParagraphs,
  readTables,
} from '../helpers/markdown-read-back.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/**
 * A bridge query result. `rowCount` above `rows.length` is a preview-capped
 * result; `truncated` is what the canvas sets when `row_limit` bound the query
 * itself, in which case `rowCount` equals that limit rather than the true total.
 */
function makeQueryResult(
  rows: Record<string, unknown>[],
  rowCount = rows.length,
  columns = ['record_date', 'debt'],
  truncated?: boolean,
) {
  return {
    result: {
      columns,
      rowCount,
      rows,
      tableName: undefined,
      ...(truncated !== undefined && { truncated }),
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

/** The declared hint for a reason — the contract is the source of truth. */
function declaredRecovery(reason: string): string | undefined {
  return dataframeQueryTool.errors?.find((entry) => entry.reason === reason)?.recovery;
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
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'system_catalog_access' },
    });
  });

  it('throws invalid_sql when SQL is not a SELECT (framework gate reason)', async () => {
    rejectWith(
      validationError('Canvas query must be SELECT.', {
        reason: 'non_select_statement',
        statementType: 'UNKNOWN',
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

    /**
     * The bridge refuses a register_as name spelled like a DuckDB metadata view
     * before anything is staged, under the same reason as catalog-reading SQL.
     * Its own hint — choose another name — is the remedy; the contract's, which
     * points at the SQL, is not.
     */
    it('carries the bridge hint for a refused register_as name on both surfaces', async () => {
      const { CanvasBridge } = await vi.importActual<
        typeof import('@/services/canvas-bridge/canvas-bridge.js')
      >('@/services/canvas-bridge/canvas-bridge.js');
      const bridge = new CanvasBridge({} as unknown as DataCanvas);
      vi.mocked(getCanvasBridge).mockReturnValue(bridge);
      const input = { sql: 'SELECT record_date FROM df_ABCDE_FGHIJ', register_as: 'pg_tables' };
      const refusal = (await bridge
        .query(createMockContext(), input.sql, { registerAs: input.register_as })
        .catch((err: unknown) => err)) as { data: { recovery: { hint: string } } };
      const hint = refusal.data.recovery.hint;

      const result = await runToolContract(dataframeQueryTool, input);

      expect(hint).toContain('register_as');
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'system_catalog_access', recovery: { hint } } },
      });
      expect(readParagraphs(contentText(result.content))).toContain(`Recovery: ${hint}`);
    });

    it.each([
      ['non_select_statement', 'Canvas query must be SELECT.'],
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
      const original = validationError('Canvas query must be SELECT.', {
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

    it('re-stages through the convenience tools only in the mode that stages', () => {
      /**
       * treasury_get_debt, treasury_get_interest_rates, and
       * treasury_get_exchange_rates stage a table only in mode=series; passing
       * canvas_id to any other mode stages nothing, so the hint has to say so.
       */
      expect(declaredRecovery('missing_table')).toContain(
        'treasury_get_debt, treasury_get_interest_rates, or treasury_get_exchange_rates with mode=series',
      );
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
        code: number;
        message: string;
        data: { reason?: string; recovery?: { hint?: string } };
      };

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_query_bounds');
      expect(error.message).toBe('preview (2000) may not exceed row_limit (1000).');
      expect(String(error.data.recovery?.hint)).toBe(declaredRecovery('invalid_query_bounds'));
    });

    it('restates a row_limit over the canvas ceiling in this tool parameter names', async () => {
      rejectWith(
        validationError('rowLimit must be a positive safe integer no greater than 1000.', {
          reason: 'invalid_query_bounds',
          field: 'rowLimit',
        }),
      );

      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_ABCDE_FGHIJ',
        row_limit: 5000,
      });

      await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'row_limit (5000) exceeds the row ceiling this server allows.',
        data: {
          reason: 'invalid_query_bounds',
          recovery: { hint: declaredRecovery('invalid_query_bounds') },
        },
      });
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

  describe('row_limit as the binding cap', () => {
    /**
     * The default call against an oversized dataframe: `row_limit` bounds the
     * query, so the canvas returns exactly that many rows and reports the cap as
     * `rowCount`. Nothing in the row arithmetic separates this from a table that
     * holds exactly `row_limit` rows — only the canvas `truncated` flag does.
     */
    function useRowLimitBound(rowLimit = 1000, shown = rowLimit) {
      resolveWith(
        makeQueryResult(
          Array.from({ length: shown }, (_, i) => ({ record_date: `row-${i}` })),
          rowLimit,
          ['record_date'],
          true,
        ),
      );
    }

    it('marks the count as capped when row_limit bound the query', async () => {
      useRowLimitBound(1000);
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      const result = await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' }),
        ctx,
      );

      expect(result.row_count).toBe(1000);
      expect(result.rows).toHaveLength(1000);
      expect(result.row_count_capped).toBe(true);
    });

    it('discloses the cap and names row_limit and register_as as the levers', async () => {
      useRowLimitBound(1000);
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' }),
        ctx,
      );

      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 1000, cap: 1000 });
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('row_limit');
      expect(notice).toContain('register_as');
    });

    it('names preview as well when it also bound the inline rows', async () => {
      useRowLimitBound(1000, 10);
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({
          sql: 'SELECT * FROM df_ABCDE_FGHIJ',
          preview: 10,
          row_limit: 1000,
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('matched more than row_limit');
      expect(notice).toContain('raise preview (currently 10)');
      expect(getEnrichment(ctx)).toMatchObject({ shown: 10, cap: 10 });
    });

    it('leaves an exact result alone at the same row count', async () => {
      resolveWith(
        makeQueryResult(
          Array.from({ length: 1000 }, (_, i) => ({ record_date: `row-${i}` })),
          1000,
          ['record_date'],
        ),
      );
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      const result = await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_ABCDE_FGHIJ' }),
        ctx,
      );

      expect(result.row_count_capped).toBe(false);
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('reports an exact count on the register_as path, which counts the table', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue({
        query: vi.fn().mockResolvedValue({
          result: {
            columns: ['record_date'],
            rowCount: 19_000,
            rows: [{ record_date: '2026-06-30' }],
            tableName: 'df_FULL0_RESLT',
          },
          meta: {
            tableName: 'df_FULL0_RESLT',
            sourceTool: 'treasury_dataframe_query',
            queryParams: { sql: 'SELECT * FROM df_ABCDE_FGHIJ' },
            createdAt: '2026-08-12T10:00:00.000Z',
            expiresAt: '2026-08-13T10:00:00.000Z',
            rowCount: 19_000,
            truncated: false,
            maxRows: undefined,
            columnSchema: [{ name: 'record_date', type: 'VARCHAR', nullable: true }],
          },
        }),
      } as unknown as ReturnType<typeof getCanvasBridge>);
      const ctx = createMockContext({ tenantId: 'test-tenant', errors: dataframeQueryTool.errors });

      const result = await dataframeQueryTool.handler(
        dataframeQueryTool.input.parse({
          sql: 'SELECT * FROM df_ABCDE_FGHIJ',
          register_as: 'df_FULL0_RESLT',
          preview: 1,
        }),
        ctx,
      );

      expect(result.row_count).toBe(19_000);
      expect(result.row_count_capped).toBe(false);
      expect(String(getEnrichment(ctx).notice)).toContain('preview');
    });

    it('renders the cap in the text block, not just the structured output', () => {
      const text = (
        dataframeQueryTool.format!({
          columns: ['record_date'],
          row_count: 1000,
          row_count_capped: true,
          rows: Array.from({ length: 1000 }, (_, i) => ({ record_date: `row-${i}` })),
        })[0] as { text: string }
      ).text;

      expect(text).toContain('row_limit');
      expect(text).not.toMatch(/^\*\*1000 rows\*\*$/m);
    });
  });

  it('formats output table', () => {
    const result = {
      columns: ['record_date', 'debt'],
      row_count: 1,
      row_count_capped: false,
      rows: [{ record_date: '2026-05-28', debt: '39180000000000.00' }],
    };
    const blocks = dataframeQueryTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('record_date');
    expect(text).toContain('2026-05-28');
    expect(text).toContain('1 rows');
  });

  it('formats empty result', () => {
    const result = { columns: ['record_date'], row_count: 0, row_count_capped: false, rows: [] };
    const blocks = dataframeQueryTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 rows');
    expect(text).toContain('No rows');
  });

  /**
   * `content[]` is read through a real Markdown parse and compared with the
   * values `structuredContent` carries — a client renders the text, so the
   * rendered value is the one that has to match.
   */
  describe('content[] read-back', () => {
    function render(columns: string[], rows: Record<string, unknown>[]): string {
      return contentText(
        dataframeQueryTool.format!({
          columns,
          row_count: rows.length,
          row_count_capped: false,
          rows,
        }),
      );
    }

    it('reads the column names back as the header and every cell as the row value', () => {
      const columns = ['record_date', 'debt', 'n', 'meta'];
      const rows = [
        { record_date: '2026-05-28', debt: '39180000000000.00', n: 3, meta: { a: 1 } },
        { record_date: '2026-05-27', debt: null, n: 2.5, meta: [1, 2] },
      ];
      const [table] = readTables(render(columns, rows));

      expect(table?.header).toEqual(columns);
      expect(table?.rows).toEqual([
        ['2026-05-28', '39180000000000.00', '3', '{"a":1}'],
        ['2026-05-27', '', '2.5', '[1,2]'],
      ]);
    });

    it('reads a hostile column name and cell back exactly, in their own column', () => {
      const column = `${HOSTILE_VALUE} col`;
      const object = { q: HOSTILE_VALUE };
      const [table] = readTables(
        render(['id', column, 'obj'], [{ id: '1', [column]: HOSTILE_VALUE, obj: object }]),
      );

      expect(table?.header).toEqual(['id', column, 'obj']);
      expect(table?.rows).toEqual([['1', HOSTILE_VALUE, JSON.stringify(object)]]);
    });

    it('leaves structuredContent byte-identical to the dataframe row', async () => {
      const rows = [{ v: HOSTILE_VALUE }];
      resolveWith(makeQueryResult(rows, 1, ['v']));

      const result = await runToolContract(dataframeQueryTool, {
        sql: 'SELECT v FROM df_ABCDE_FGHIJ',
      });

      expect((result.structuredContent as { rows: unknown[] }).rows).toEqual(rows);
      expect(readTables(contentText(result.content))[0]?.rows).toEqual([[HOSTILE_VALUE]]);
    });
  });
});

/**
 * The refusals above are stubs shaped like the canvas's. These run the real
 * bridge over a DuckDB canvas whose row ceiling is 1000, so what reaches the
 * reroute is what the gate and the bridge actually raise.
 */
describe('refusals from a real canvas', () => {
  const opened: DataCanvas[] = [];

  async function useRealBridge(): Promise<void> {
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
    vi.mocked(getCanvasBridge).mockReturnValue(new CanvasBridge(canvas));
  }

  afterEach(async () => {
    for (const canvas of opened.splice(0)) await canvas.shutdown(createMockContext());
  });

  it.each(['SELECT * FROM information_schema.tables', 'SELECT * FROM duckdb_tables()'])(
    'reports %s as system_catalog_access on both surfaces',
    async (sql) => {
      await useRealBridge();

      const result = await runToolContract(dataframeQueryTool, { sql });

      const hint = declaredRecovery('system_catalog_access');
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'system_catalog_access', recovery: { hint } },
        },
      });
      expect(readParagraphs(contentText(result.content))).toContain(`Recovery: ${hint}`);
    },
  );

  it('reports which_secret as invalid_sql, keeping the gate reason and message', async () => {
    await useRealBridge();

    const result = await runToolContract(dataframeQueryTool, {
      sql: "SELECT * FROM which_secret('s3://x/y', 's3')",
    });

    const message = 'Canvas query contains disallowed operators: WHICH_SECRET.';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: {
          reason: 'invalid_sql',
          canvas_reason: 'plan_operator_not_allowed',
          recovery: { hint: declaredRecovery('invalid_sql') },
        },
      },
    });
    expect(contentText(result.content)).toContain(message);
  });

  it.each([
    [{ row_limit: 5000 }, 'row_limit (5000) exceeds the row ceiling this server allows.'],
    [{ preview: 20, row_limit: 10 }, 'preview (20) may not exceed row_limit (10).'],
  ])('restates the bound %j in this tool parameter names', async (bounds, message) => {
    await useRealBridge();

    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1 AS one', ...bounds });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'invalid_query_bounds' },
      },
    });
    expect(contentText(result.content)).toContain(message);
  });
});
