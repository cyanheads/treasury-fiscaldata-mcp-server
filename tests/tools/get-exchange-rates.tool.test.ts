/**
 * @fileoverview Tests for treasury_get_exchange_rates tool.
 * @module tests/tools/get-exchange-rates.tool.test
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

import { getExchangeRatesTool } from '@/mcp-server/tools/definitions/get-exchange-rates.tool.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

type RateRow = {
  record_date: string;
  country: string;
  currency: string;
  country_currency_desc: string;
  exchange_rate: string;
  effective_date: string;
};

function makeRatesEnvelope(rows: RateRow[], totalCount = rows.length): FiscalDataEnvelope {
  return {
    data: rows as Record<string, string>[],
    meta: {
      count: rows.length,
      labels: { country: 'Country', exchange_rate: 'Exchange Rate' },
      dataTypes: { record_date: 'DATE', exchange_rate: 'NUMBER' },
      dataFormats: {},
      'total-count': totalCount,
      'total-pages': 1,
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  };
}

const SAMPLE_ROWS: RateRow[] = [
  {
    record_date: '2026-03-31',
    country: 'Japan',
    currency: 'Yen',
    country_currency_desc: 'Japan-Yen',
    exchange_rate: '159.41',
    effective_date: '2026-03-31',
  },
  {
    record_date: '2026-03-31',
    country: 'Germany',
    currency: 'Euro',
    country_currency_desc: 'Germany-Euro',
    exchange_rate: '0.92',
    effective_date: '2026-03-31',
  },
];

describe('getExchangeRatesTool', () => {
  beforeEach(() => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(SAMPLE_ROWS)),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns latest quarter rates', async () => {
    const ctx = createMockContext();
    const input = getExchangeRatesTool.input.parse({ mode: 'latest' });
    const result = await getExchangeRatesTool.handler(input, ctx);

    expect(result.as_of_date).toBe('2026-03-31');
    expect(result.rates.length).toBeGreaterThan(0);
    const first = result.rates[0];
    expect(first).toHaveProperty('country');
    expect(first).toHaveProperty('currency');
    expect(first).toHaveProperty('country_currency_desc');
    expect(first).toHaveProperty('exchange_rate');
    expect(first).toHaveProperty('record_date');
    expect(result.note).toBeTruthy();
  });

  it('filters to specific countries', async () => {
    const japanRow = SAMPLE_ROWS.filter((r) => r.country === 'Japan');
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(japanRow)),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getExchangeRatesTool.input.parse({
      mode: 'latest',
      countries: ['Japan'],
    });
    const result = await getExchangeRatesTool.handler(input, ctx);

    expect(result.rates).toHaveLength(1);
    expect(result.rates[0]?.country).toBe('Japan');
    expect(result.rates[0]?.exchange_rate).toBe('159.41');
    expect(result.rates[0]?.country_currency_desc).toBe('Japan-Yen');
  });

  it('throws country_not_found when requested country returns no records', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope([], 0)),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
    const input = getExchangeRatesTool.input.parse({
      mode: 'latest',
      countries: ['Nonexistentland'],
    });
    await expect(getExchangeRatesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'country_not_found' },
    });
  });

  it('populates country_currency_desc as empty string for sparse upstream data', async () => {
    // Sparse payload — country_currency_desc absent
    const sparseRows = [
      {
        record_date: '2026-03-31',
        country: 'Japan',
        currency: 'Yen',
        // country_currency_desc intentionally absent
        exchange_rate: '159.41',
        effective_date: '2026-03-31',
      },
    ];
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(sparseRows as RateRow[])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext();
    const input = getExchangeRatesTool.input.parse({ mode: 'latest' });
    const result = await getExchangeRatesTool.handler(input, ctx);

    // Should coerce to empty string rather than undefined
    expect(result.rates[0]?.country_currency_desc).toBe('');
  });

  it('formats output with country_currency_desc column', () => {
    const result = {
      as_of_date: '2026-03-31',
      effective_date: '2026-03-31',
      rates: [
        {
          country: 'Japan',
          currency: 'Yen',
          country_currency_desc: 'Japan-Yen',
          exchange_rate: '159.41',
          record_date: '2026-03-31',
        },
      ],
      total_records: 1,
      note: 'Official reporting rates, not market rates.',
    };
    const blocks = getExchangeRatesTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Japan');
    expect(text).toContain('Japan-Yen');
    expect(text).toContain('159.41');
    expect(text).toContain('2026-03-31');
  });

  it('formats empty rates', () => {
    const result = {
      as_of_date: '',
      effective_date: '',
      rates: [],
      total_records: 0,
      note: 'Official reporting rates.',
    };
    const blocks = getExchangeRatesTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No records');
  });
});
