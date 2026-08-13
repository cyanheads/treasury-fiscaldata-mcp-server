/**
 * @fileoverview Tests for treasury_query_dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

// Mock the service module — must be hoisted before imports
vi.mock('@/services/fiscal-data/fiscal-data-service.js', () => ({
  getFiscalDataService: vi.fn(),
  initFiscalDataService: vi.fn(),
}));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn().mockReturnValue(undefined),
  initCanvasBridge: vi.fn(),
}));

import { queryDatasetTool } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

function makeEnvelope(
  data: Record<string, string>[],
  totalCount = data.length,
): FiscalDataEnvelope {
  return {
    data,
    meta: {
      count: data.length,
      labels: { record_date: 'Record Date', tot_pub_debt_out_amt: 'Total Public Debt' },
      dataTypes: { record_date: 'DATE', tot_pub_debt_out_amt: 'CURRENCY' },
      dataFormats: {},
      'total-count': totalCount,
      'total-pages': Math.max(1, Math.ceil(totalCount / 100)),
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  };
}

function rejectWith(error: unknown) {
  vi.mocked(getFiscalDataService).mockReturnValue({
    fetchPage: vi.fn().mockRejectedValue(error),
    buildFilterParam: vi.fn().mockReturnValue(''),
  } as unknown as ReturnType<typeof getFiscalDataService>);
}

/** An endpoint absent from the embedded catalog, which triggers the soft-catalog notice. */
const OFF_CATALOG_ENDPOINT = '/v9/not/in/catalog';

/** Install a canvas bridge whose registration succeeds under `tableName`. */
function useBridge(tableName: string) {
  const registerDataframe = vi.fn().mockResolvedValue({
    tableName,
    rowCount: 1,
    expiresAt: '2026-08-13T00:00:00.000Z',
    columnSchema: [],
  });
  vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as unknown as ReturnType<
    typeof getCanvasBridge
  >);
  return registerDataframe;
}

describe('queryDatasetTool', () => {
  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReset().mockReturnValue(undefined);
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi
        .fn()
        .mockResolvedValue(
          makeEnvelope([{ record_date: '2026-05-01', tot_pub_debt_out_amt: '36000000000000.00' }]),
        ),
      buildFilterParam: vi.fn().mockReturnValue(''),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns rows and metadata for valid input', async () => {
    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
    });
    const result = await queryDatasetTool.handler(input, ctx);

    expect(result.endpoint).toBe('/v2/accounting/od/debt_to_penny');
    expect(result.data).toHaveLength(1);
    expect(result.total_count).toBe(1);
    expect(result.page_number).toBe(1);
    expect(result.page_size).toBe(100);
  });

  it('applies defaults for page_size and page_number', async () => {
    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
    });
    const result = await queryDatasetTool.handler(input, ctx);
    expect(result.page_size).toBe(100);
    expect(result.page_number).toBe(1);
  });

  it('returns empty data with enrichment notice on zero results', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeEnvelope([], 0)),
      buildFilterParam: vi.fn().mockReturnValue(''),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      filters: [{ field: 'record_date', operator: 'eq', value: '2026-01-01' }],
    });
    const result = await queryDatasetTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(result.total_count).toBe(0);
  });

  it('includes applied_filters in output when filters are provided', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeEnvelope([])),
      buildFilterParam: vi.fn().mockReturnValue('record_date:eq:2026-05-01'),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      filters: [{ field: 'record_date', operator: 'eq', value: '2026-05-01' }],
    });
    const result = await queryDatasetTool.handler(input, ctx);
    expect(result.applied_filters).toBe('record_date:eq:2026-05-01');
  });

  describe('filter value validation', () => {
    /** Parse a single-filter input, returning the Zod result. */
    function parseFilter(value: unknown) {
      return queryDatasetTool.input.safeParse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        filters: [{ field: 'record_date', operator: 'eq', value }],
      });
    }

    it('accepts a scalar value and an "in" list', () => {
      expect(parseFilter('2026-05-01').success).toBe(true);
      expect(parseFilter(['Bills', 'Notes']).success).toBe(true);
    });

    it('rejects an empty scalar value, naming the value rather than the operator', () => {
      const parsed = parseFilter('');
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(message).toMatch(/value cannot be empty/i);
      expect(message).not.toMatch(/operator/i);
    });

    it('rejects an empty "in" list', () => {
      const parsed = parseFilter([]);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toMatch(/empty/i);
    });

    it('rejects an empty string inside an "in" list', () => {
      const parsed = parseFilter(['Japan', '']);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toMatch(/empty/i);
    });
  });

  it('throws invalid_endpoint when service throws (404 HTML)', async () => {
    rejectWith(
      validationError('Endpoint does not exist.', {
        reason: 'invalid_endpoint',
        endpoint: '/bad',
      }),
    );

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({ endpoint: '/v1/bad/endpoint' });
    await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_endpoint' },
    });
  });

  it('throws invalid_field when service throws (bad field name)', async () => {
    rejectWith(
      validationError("Invalid field: Field 'bogus_field' does not exist.", {
        reason: 'invalid_field',
      }),
    );

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      fields: ['bogus_field'],
    });
    await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_field' },
    });
  });

  it('throws invalid_filter when service throws (unsupported operator)', async () => {
    rejectWith(
      validationError("Invalid filter operator: Operator ':like:' is not supported.", {
        reason: 'invalid_filter',
      }),
    );

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
    });
    await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_filter' },
    });
  });

  describe('rerouted service errors', () => {
    /** The declared hint for a reason — the contract is the source of truth. */
    function declaredRecovery(reason: string): string | undefined {
      return queryDatasetTool.errors?.find((entry) => entry.reason === reason)?.recovery;
    }

    it.each([
      ['invalid_endpoint', 'Endpoint does not exist.'],
      ['invalid_field', "Invalid field: Field 'nope' does not exist."],
      ['invalid_filter', "Invalid filter operator: Operator ':like:' is not supported."],
      ['page_out_of_range', 'Page out of range: Page #9999 is out of range.'],
    ])('carries the declared recovery hint for %s', async (reason, message) => {
      rejectWith(validationError(message, { reason }));

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
      });
      await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
        message,
        data: {
          reason,
          endpoint: '/v2/accounting/od/debt_to_penny',
          recovery: { hint: declaredRecovery(reason) },
        },
      });
    });

    it('chains the originating service error as the cause', async () => {
      const original = validationError('Endpoint does not exist.', { reason: 'invalid_endpoint' });
      rejectWith(original);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({ endpoint: '/v1/bad/endpoint' });
      let caught: unknown;
      try {
        await queryDatasetTool.handler(input, ctx);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error | undefined)?.cause).toBe(original);
    });

    it('sends an out-of-range page back to total_pages, which this tool returns', async () => {
      rejectWith(
        validationError('Page out of range: Page #9999 is out of range.', {
          reason: 'page_out_of_range',
        }),
      );

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        page_number: 9999,
      });
      const error = (await Promise.resolve(queryDatasetTool.handler(input, ctx)).catch(
        (err: unknown) => err,
      )) as {
        data: { recovery?: { hint?: string } };
      };

      expect(String(error.data.recovery?.hint)).toContain('total_pages');
      expect(Object.keys(queryDatasetTool.output.shape)).toContain('total_pages');
    });

    it('lets an unmapped service error bubble unchanged', async () => {
      const original = serviceUnavailable('Fiscal Data API error: upstream exploded.', {
        status: 503,
      });
      rejectWith(original);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
      });
      await expect(queryDatasetTool.handler(input, ctx)).rejects.toBe(original);
    });
  });

  describe('enrichment notices', () => {
    it('warns that an endpoint is absent from the catalog', async () => {
      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({ endpoint: OFF_CATALOG_ENDPOINT });
      await queryDatasetTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain(OFF_CATALOG_ENDPOINT);
      expect(notice).toContain('treasury_list_datasets');
    });

    it('says why a query matched nothing', async () => {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeEnvelope([], 0)),
        buildFilterParam: vi.fn().mockReturnValue(''),
      } as unknown as ReturnType<typeof getFiscalDataService>);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
      });
      await queryDatasetTool.handler(input, ctx);

      expect(String(getEnrichment(ctx).notice)).toContain('No rows matched');
    });

    it('keeps the catalog warning when the query also matched nothing', async () => {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeEnvelope([], 0)),
        buildFilterParam: vi.fn().mockReturnValue(''),
      } as unknown as ReturnType<typeof getFiscalDataService>);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({ endpoint: OFF_CATALOG_ENDPOINT });
      await queryDatasetTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('not found in the local catalog');
      expect(notice).toContain('No rows matched');
    });

    it('stays silent when a catalogued endpoint returns rows and nothing was staged', async () => {
      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
      });
      await queryDatasetTool.handler(input, ctx);

      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });
  });

  describe('canvas staging disclosure', () => {
    it('names the staged table and both dataframe tools', async () => {
      useBridge('df_QRYDS_00001');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: 'stage-it',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(result.canvas_id).toBe('df_QRYDS_00001');
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('df_QRYDS_00001');
      expect(notice).toContain('treasury_dataframe_describe');
      expect(notice).toContain('treasury_dataframe_query');
      // describe comes first — the schema is unreadable without it.
      expect(notice.indexOf('treasury_dataframe_describe')).toBeLessThan(
        notice.indexOf('treasury_dataframe_query'),
      );
    });

    it('discloses staging even when the page returned inline in full', async () => {
      useBridge('df_QRYDS_00002');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: 'stage-it',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(result.data).toHaveLength(result.total_count);
      expect(String(getEnrichment(ctx).notice)).toContain('df_QRYDS_00002');
    });

    it('composes the catalog warning with the staging pointer', async () => {
      useBridge('df_QRYDS_00003');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: OFF_CATALOG_ENDPOINT,
        canvas_id: 'stage-it',
      });
      await queryDatasetTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('not found in the local catalog');
      expect(notice).toContain('df_QRYDS_00003');
    });

    it('explains the absent canvas_id when the canvas is unavailable', async () => {
      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: 'stage-it',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(notice).toContain('whole page');
    });

    it('explains a registration that returned no table', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue({
        registerDataframe: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<typeof getCanvasBridge>);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: 'stage-it',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(String(getEnrichment(ctx).notice)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    });

    it('stays silent about staging when none was requested', async () => {
      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
      });
      await queryDatasetTool.handler(input, ctx);

      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('does not stage an empty page', async () => {
      const registerDataframe = useBridge('df_QRYDS_00004');
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeEnvelope([], 0)),
        buildFilterParam: vi.fn().mockReturnValue(''),
      } as unknown as ReturnType<typeof getFiscalDataService>);

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: 'stage-it',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(registerDataframe).not.toHaveBeenCalled();
      expect(result.canvas_id).toBeUndefined();
      expect(String(getEnrichment(ctx).notice)).not.toContain('df_');
    });

    it('treats an empty-string canvas_id as no request to stage', async () => {
      const registerDataframe = useBridge('df_QRYDS_00005');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        canvas_id: '',
      });
      const result = await queryDatasetTool.handler(input, ctx);

      expect(registerDataframe).not.toHaveBeenCalled();
      expect(result.canvas_id).toBeUndefined();
    });
  });

  it('formats output with page_size', () => {
    const result = {
      endpoint: '/v2/accounting/od/debt_to_penny',
      data: [{ record_date: '2026-05-01', tot_pub_debt_out_amt: '36000000000000.00' }],
      total_count: 1,
      total_pages: 1,
      page_number: 1,
      page_size: 100,
      field_labels: { record_date: 'Record Date', tot_pub_debt_out_amt: 'Total Public Debt' },
    };
    const blocks = queryDatasetTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('page_size 100');
    expect(text).toContain('/v2/accounting/od/debt_to_penny');
    expect(text).toContain('2026-05-01');
  });

  it('formats empty data', () => {
    const result = {
      endpoint: '/v2/accounting/od/debt_to_penny',
      data: [],
      total_count: 0,
      total_pages: 0,
      page_number: 1,
      page_size: 100,
      field_labels: {},
    };
    const blocks = queryDatasetTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('page_size 100');
  });
});
