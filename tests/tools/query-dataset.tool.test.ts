/**
 * @fileoverview Tests for treasury_query_dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('queryDatasetTool', () => {
  beforeEach(() => {
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      filters: [{ field: 'record_date', operator: 'eq', value: '2026-05-01' }],
    });
    const result = await queryDatasetTool.handler(input, ctx);
    expect(result.applied_filters).toBe('record_date:eq:2026-05-01');
  });

  it('throws invalid_endpoint when service throws (404 HTML)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockRejectedValue(
        validationError('Endpoint does not exist.', {
          reason: 'invalid_endpoint',
          endpoint: '/bad',
        }),
      ),
      buildFilterParam: vi.fn(),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({ endpoint: '/v1/bad/endpoint' });
    await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_endpoint' },
    });
  });

  it('throws invalid_field when service throws (bad field name)', async () => {
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockRejectedValue(
        validationError("Invalid field: Field 'bogus_field' does not exist.", {
          reason: 'invalid_field',
        }),
      ),
      buildFilterParam: vi.fn().mockReturnValue(''),
    } as unknown as ReturnType<typeof getFiscalDataService>);

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
    const { validationError } = await import('@cyanheads/mcp-ts-core/errors');
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockRejectedValue(
        validationError("Invalid filter operator: Operator ':like:' is not supported.", {
          reason: 'invalid_filter',
        }),
      ),
      buildFilterParam: vi.fn().mockReturnValue(''),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({
      endpoint: '/v2/accounting/od/debt_to_penny',
    });
    await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_filter' },
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
