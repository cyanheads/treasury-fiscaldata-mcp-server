/**
 * @fileoverview Tests for treasury_get_debt tool.
 * @module tests/tools/get-debt.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

vi.mock('@/services/fiscal-data/fiscal-data-service.js', () => ({
  getFiscalDataService: vi.fn(),
  initFiscalDataService: vi.fn(),
}));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn().mockReturnValue(undefined),
  initCanvasBridge: vi.fn(),
}));

import { getDebtTool } from '@/mcp-server/tools/definitions/get-debt.tool.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

function makeDebtEnvelope(
  rows: {
    record_date: string;
    tot_pub_debt_out_amt: string;
    debt_held_public_amt: string;
    intragov_hold_amt: string;
  }[],
): FiscalDataEnvelope {
  return {
    data: rows as Record<string, string>[],
    meta: {
      count: rows.length,
      labels: { record_date: 'Record Date', tot_pub_debt_out_amt: 'Total Debt' },
      dataTypes: { record_date: 'DATE', tot_pub_debt_out_amt: 'CURRENCY' },
      dataFormats: {},
      'total-count': rows.length,
      'total-pages': 1,
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  };
}

const SAMPLE_ROW = {
  record_date: '2026-05-28',
  tot_pub_debt_out_amt: '39180000000000.00',
  debt_held_public_amt: '28500000000000.00',
  intragov_hold_amt: '6780000000000.00',
};

describe('getDebtTool', () => {
  beforeEach(() => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([SAMPLE_ROW])),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns latest debt record', async () => {
    const ctx = createMockContext();
    const input = getDebtTool.input.parse({ mode: 'latest' });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.record_date).toBe('2026-05-28');
    expect(result.total_debt).toBe('39180000000000.00');
    expect(result.debt_held_public).toBe('28500000000000.00');
    expect(result.intragovernmental_holdings).toBe('6780000000000.00');
  });

  it('returns debt record for a specific date', async () => {
    const ctx = createMockContext();
    const input = getDebtTool.input.parse({ mode: 'date', date: '2026-05-28' });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.record_date).toBe('2026-05-28');
    expect(result.total_debt).toBeDefined();
  });

  it('throws no_data_for_date when mode=date and date is missing', async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date' });
    await expect(getDebtTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data_for_date' },
    });
  });

  it('throws no_data_for_date when API returns empty results for mode=latest', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'latest' });
    await expect(getDebtTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data_for_date' },
    });
  });

  it('throws no_data_for_date when API returns empty results for mode=date', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date', date: '2026-01-01' });
    await expect(getDebtTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data_for_date' },
    });
  });

  it('returns series data with multiple rows', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(
        makeDebtEnvelope([
          { ...SAMPLE_ROW, record_date: '2026-05-28' },
          { ...SAMPLE_ROW, record_date: '2026-05-27', tot_pub_debt_out_amt: '39170000000000.00' },
        ]),
      ),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getDebtTool.input.parse({
      mode: 'series',
      start_date: '2026-05-27',
      end_date: '2026-05-28',
    });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.series).toBeDefined();
    expect(result.total_records).toBe(2);
  });

  it('formats output with all required fields', () => {
    const result = {
      record_date: '2026-05-28',
      total_debt: '39180000000000.00',
      debt_held_public: '28500000000000.00',
      intragovernmental_holdings: '6780000000000.00',
    };
    const blocks = getDebtTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2026-05-28');
    expect(text).toContain('39180000000000.00');
    expect(text).toContain('28500000000000.00');
    expect(text).toContain('6780000000000.00');
  });

  it('formats series output with table', () => {
    const result = {
      record_date: '2026-05-28',
      total_debt: '39180000000000.00',
      debt_held_public: '28500000000000.00',
      intragovernmental_holdings: '6780000000000.00',
      series: [
        {
          record_date: '2026-05-28',
          total_debt: '39180000000000.00',
          debt_held_public: '28500000000000.00',
          intragovernmental_holdings: '6780000000000.00',
        },
      ],
      total_records: 1,
    };
    const blocks = getDebtTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 total records');
    expect(text).toContain('2026-05-28');
  });
});
