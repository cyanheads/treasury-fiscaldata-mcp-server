/**
 * @fileoverview Tests for treasury_get_interest_rates tool.
 * @module tests/tools/get-interest-rates.tool.test
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

import { getInterestRatesTool } from '@/mcp-server/tools/definitions/get-interest-rates.tool.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

type RateRow = {
  record_date: string;
  security_type_desc: string;
  security_desc: string;
  avg_interest_rate_amt: string;
};

function makeRatesEnvelope(rows: RateRow[]): FiscalDataEnvelope {
  return {
    data: rows as Record<string, string>[],
    meta: {
      count: rows.length,
      labels: { record_date: 'Record Date', security_desc: 'Security Description' },
      dataTypes: { record_date: 'DATE', avg_interest_rate_amt: 'PERCENTAGE' },
      dataFormats: {},
      'total-count': rows.length,
      'total-pages': 1,
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  };
}

const SAMPLE_ROWS: RateRow[] = [
  {
    record_date: '2026-04-30',
    security_type_desc: 'Marketable',
    security_desc: 'Treasury Bills',
    avg_interest_rate_amt: '3.696',
  },
  {
    record_date: '2026-04-30',
    security_type_desc: 'Marketable',
    security_desc: 'Treasury Notes',
    avg_interest_rate_amt: '3.230',
  },
  {
    record_date: '2026-04-30',
    security_type_desc: 'Interest-bearing Debt',
    security_desc: 'Total Interest-bearing Debt',
    avg_interest_rate_amt: '3.340',
  },
];

describe('getInterestRatesTool', () => {
  beforeEach(() => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(SAMPLE_ROWS)),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns latest rates for all security types', async () => {
    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({ mode: 'latest' });
    const result = await getInterestRatesTool.handler(input, ctx);

    expect(result.as_of_date).toBe('2026-04-30');
    expect(result.rates.length).toBeGreaterThan(0);
    const first = result.rates[0];
    expect(first).toHaveProperty('record_date');
    expect(first).toHaveProperty('security_type');
    expect(first).toHaveProperty('security_desc');
    expect(first).toHaveProperty('avg_interest_rate_pct');
  });

  it('filters to a single security type in latest mode', async () => {
    const billsRows = SAMPLE_ROWS.filter((r) => r.security_desc === 'Treasury Bills');
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(billsRows)),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({
      mode: 'latest',
      security_type: 'Treasury Bills',
    });
    const result = await getInterestRatesTool.handler(input, ctx);

    expect(result.rates[0]?.security_desc).toBe('Treasury Bills');
    expect(result.rates[0]?.avg_interest_rate_pct).toBe('3.696');
  });

  it('returns empty rates with enrichment notice for zero results', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope([])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({
      mode: 'series',
      start_date: '2099-01-01',
      end_date: '2099-12-31',
    });
    const result = await getInterestRatesTool.handler(input, ctx);
    expect(result.rates).toHaveLength(0);
    expect(result.total_records).toBe(0);
  });

  it('maps security_type_desc to security_type in output', async () => {
    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({ mode: 'latest' });
    const result = await getInterestRatesTool.handler(input, ctx);

    const totalRow = result.rates.find((r) => r.security_desc === 'Total Interest-bearing Debt');
    expect(totalRow?.security_type).toBe('Interest-bearing Debt');
  });

  it('formats output with security_type column', () => {
    const result = {
      as_of_date: '2026-04-30',
      rates: [
        {
          record_date: '2026-04-30',
          security_type: 'Marketable',
          security_desc: 'Treasury Bills',
          avg_interest_rate_pct: '3.696',
        },
      ],
      total_records: 1,
    };
    const blocks = getInterestRatesTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2026-04-30');
    expect(text).toContain('Marketable');
    expect(text).toContain('Treasury Bills');
    expect(text).toContain('3.696%');
  });

  it('formats empty rates result', () => {
    const result = { as_of_date: '', rates: [], total_records: 0 };
    const blocks = getInterestRatesTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No records');
  });

  it('total_records in latest mode reflects rows returned, not full API count', async () => {
    // The API returns total-count=4945 (full dataset) but only 3 rows in this fetch
    const envelope: FiscalDataEnvelope = {
      data: SAMPLE_ROWS as Record<string, string>[],
      meta: {
        count: 3,
        labels: {},
        dataTypes: {},
        dataFormats: {},
        'total-count': 4945, // full API dataset count
        'total-pages': 1,
      },
      links: { self: '', first: null, prev: null, next: null, last: null },
    };
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(envelope),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({ mode: 'latest' });
    const result = await getInterestRatesTool.handler(input, ctx);

    // Must reflect actual rows returned, not the 4945 API total
    expect(result.total_records).toBe(SAMPLE_ROWS.length);
    expect(result.total_records).not.toBe(4945);
  });

  it('series with canvas returns at most 20 rows inline when canvas is registered', async () => {
    // Build 25 rows across 2 months — more than the 20-row preview cap
    const manyRows: RateRow[] = Array.from({ length: 25 }, (_, i) => ({
      record_date: i < 13 ? '2026-04-30' : '2026-03-31',
      security_type_desc: 'Marketable',
      security_desc: 'Treasury Bills',
      avg_interest_rate_amt: '3.696',
    }));
    const bigEnvelope: FiscalDataEnvelope = {
      data: manyRows as Record<string, string>[],
      meta: {
        count: 25,
        labels: {},
        dataTypes: {},
        dataFormats: {},
        'total-count': 250, // > 200 threshold → triggers canvas spill logic
        'total-pages': 1,
      },
      links: { self: '', first: null, prev: null, next: null, last: null },
    };

    // Provide a working canvas bridge so canvasId is set after registration
    const { getCanvasBridge } = await import('@/services/canvas-bridge/canvas-bridge.js');
    vi.mocked(getCanvasBridge).mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_TEST_0001',
        rowCount: 25,
        expiresAt: '2026-06-02T00:00:00.000Z',
        columnSchema: [],
      }),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(bigEnvelope),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getInterestRatesTool.input.parse({
      mode: 'series',
      start_date: '2026-03-01',
      end_date: '2026-04-30',
      canvas_id: 'df_TEST_0001',
    });
    const result = await getInterestRatesTool.handler(input, ctx);

    // When canvas was registered, inline preview must be capped at 20
    expect(result.canvas_id).toBe('df_TEST_0001');
    expect(result.rates.length).toBeLessThanOrEqual(20);
    // total_records reflects the full count from API
    expect(result.total_records).toBe(250);
  });
});
