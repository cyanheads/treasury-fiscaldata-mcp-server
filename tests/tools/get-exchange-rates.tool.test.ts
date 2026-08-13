/**
 * @fileoverview Tests for treasury_get_exchange_rates tool.
 * @module tests/tools/get-exchange-rates.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterCondition, FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

vi.mock('@/services/fiscal-data/fiscal-data-service.js', () => ({
  getFiscalDataService: vi.fn(),
  initFiscalDataService: vi.fn(),
}));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn().mockReturnValue(undefined),
  initCanvasBridge: vi.fn(),
  maybeRegisterDataframe: vi.fn().mockResolvedValue({}),
}));

import { getExchangeRatesTool } from '@/mcp-server/tools/definitions/get-exchange-rates.tool.js';
import { maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';
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

/**
 * Countries whose most recent published rate falls in different quarters. A
 * country that stops reporting individually keeps its last row rather than
 * dropping out, so a single country filter can span years. Ordered newest-first
 * to mirror the API's `sort=-record_date`.
 */
const MIXED_DATE_ROWS: RateRow[] = [
  {
    record_date: '2026-06-30',
    country: 'Japan',
    currency: 'Yen',
    country_currency_desc: 'Japan-Yen',
    exchange_rate: '162.38',
    effective_date: '2026-06-30',
  },
  {
    record_date: '2026-06-30',
    country: 'Korea',
    currency: 'Won',
    country_currency_desc: 'Korea-Won',
    exchange_rate: '1550.88',
    effective_date: '2026-06-30',
  },
  {
    record_date: '2025-03-31',
    country: 'France',
    currency: 'Euro',
    country_currency_desc: 'France-Euro',
    exchange_rate: '0.924',
    effective_date: '2025-03-31',
  },
  {
    record_date: '2025-03-31',
    country: 'Germany',
    currency: 'Euro',
    country_currency_desc: 'Germany-Euro',
    exchange_rate: '0.924',
    effective_date: '2025-03-31',
  },
];

/**
 * One quarter carrying both shapes that put more than one row under a country —
 * an amended rate (same currency, later effective_date) and a country with two
 * legal-tender currencies — plus a country whose newest row is an older quarter.
 * Ordered as the API orders it: an amendment follows the rate it replaces, so
 * the first row seen for a currency is the superseded one.
 */
const AMENDED_QUARTER_ROWS: RateRow[] = [
  {
    record_date: '2026-06-30',
    country: 'Bolivia',
    currency: 'Boliviano',
    country_currency_desc: 'Bolivia-Boliviano',
    exchange_rate: '6.85',
    effective_date: '2026-06-30',
  },
  {
    record_date: '2026-06-30',
    country: 'Bolivia',
    currency: 'Boliviano',
    country_currency_desc: 'Bolivia-Boliviano',
    exchange_rate: '10.35',
    effective_date: '2026-07-15',
  },
  {
    record_date: '2026-06-30',
    country: 'Cuba',
    currency: 'Chavito',
    country_currency_desc: 'Cuba-Chavito',
    exchange_rate: '1.0',
    effective_date: '2026-06-30',
  },
  {
    record_date: '2026-06-30',
    country: 'Cuba',
    currency: 'Peso',
    country_currency_desc: 'Cuba-Peso',
    exchange_rate: '24.0',
    effective_date: '2026-06-30',
  },
  {
    record_date: '2025-03-31',
    country: 'Germany',
    currency: 'Euro',
    country_currency_desc: 'Germany-Euro',
    exchange_rate: '0.924',
    effective_date: '2025-03-31',
  },
];

/** The rate reported for one currency label, or undefined when it is absent. */
function rateFor(
  rates: { country_currency_desc: string; exchange_rate: string }[],
  label: string,
): string | undefined {
  return rates.find((r) => r.country_currency_desc === label)?.exchange_rate;
}

/**
 * Serve `rows` the way the API does — applying the country filter upstream, so a
 * filtered call and an unfiltered call receive genuinely different row sets
 * rather than the same one twice.
 */
function serveRows(rows: RateRow[], totalCount?: number) {
  vi.mocked(getFiscalDataService).mockReturnValue({
    fetchPage: vi.fn(
      (_ctx: unknown, _endpoint: string, options?: { filters?: FilterCondition[] }) => {
        const countryFilter = options?.filters?.find((f) => f.field === 'country');
        const wanted = countryFilter
          ? new Set(
              Array.isArray(countryFilter.value) ? countryFilter.value : [countryFilter.value],
            )
          : undefined;
        const matched = wanted ? rows.filter((r) => wanted.has(r.country)) : rows;
        return Promise.resolve(makeRatesEnvelope(matched, totalCount ?? matched.length));
      },
    ),
  } as unknown as ReturnType<typeof getFiscalDataService>);
}

/**
 * Serve `rows` the way the API does, honouring the bounds as well as the
 * filters: sort newest-first, apply country and record_date filters upstream,
 * then slice by page[size]/page[number]. A fake that ignores the bounds cannot
 * show a fetch that stopped short of its own match.
 */
function pagedFetchPage(rows: RateRow[]) {
  return vi.fn(
    (
      _ctx: unknown,
      _endpoint: string,
      opts: { filters?: FilterCondition[]; pageSize?: number; pageNumber?: number } = {},
    ) => {
      let matched = [...rows].sort((a, b) => b.record_date.localeCompare(a.record_date));
      for (const f of opts.filters ?? []) {
        const value = String(f.value);
        if (f.field === 'country') {
          const wanted = new Set(Array.isArray(f.value) ? f.value : [f.value]);
          matched = matched.filter((r) => wanted.has(r.country));
        } else if (f.field === 'record_date' && f.operator === 'eq') {
          matched = matched.filter((r) => r.record_date === value);
        } else if (f.field === 'record_date' && f.operator === 'gte') {
          matched = matched.filter((r) => r.record_date >= value);
        } else if (f.field === 'record_date' && f.operator === 'lte') {
          matched = matched.filter((r) => r.record_date <= value);
        }
      }
      const pageSize = opts.pageSize ?? 100;
      const start = ((opts.pageNumber ?? 1) - 1) * pageSize;
      return Promise.resolve(
        makeRatesEnvelope(matched.slice(start, start + pageSize), matched.length),
      );
    },
  );
}

function usePaged(rows: RateRow[]) {
  const fetchPage = pagedFetchPage(rows);
  vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
    typeof getFiscalDataService
  >);
  return fetchPage;
}

/** `count` distinct currencies published under one quarter-end date. */
function quarterRows(recordDate: string, count: number, prefix = 'C'): RateRow[] {
  return Array.from({ length: count }, (_, i) => ({
    record_date: recordDate,
    country: `${prefix}${i}`,
    currency: 'Unit',
    country_currency_desc: `${prefix}${i}-Unit`,
    exchange_rate: `${i + 1}.5`,
    effective_date: recordDate,
  }));
}

/** Run mode=latest against the amended-quarter fixture. */
async function latestOver(rows: RateRow[], countries?: string[]) {
  serveRows(rows);
  const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
  const input = getExchangeRatesTool.input.parse({
    mode: 'latest',
    ...(countries && { countries }),
  });
  return await getExchangeRatesTool.handler(input, ctx);
}

describe('getExchangeRatesTool', () => {
  beforeEach(() => {
    vi.mocked(maybeRegisterDataframe).mockReset().mockResolvedValue({});
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope(SAMPLE_ROWS)),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns latest quarter rates', async () => {
    const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
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

    const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
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

    const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
    const input = getExchangeRatesTool.input.parse({ mode: 'latest' });
    const result = await getExchangeRatesTool.handler(input, ctx);

    // Should coerce to empty string rather than undefined
    expect(result.rates[0]?.country_currency_desc).toBe('');
  });

  describe('mixed record dates', () => {
    it('reports every returned row as sharing one date when they do', async () => {
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({ mode: 'latest' });
      const result = await getExchangeRatesTool.handler(input, ctx);

      expect(result.mixed_record_dates).toBe(false);
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('flags a country filter whose rows land in different quarters', async () => {
      serveRows(MIXED_DATE_ROWS);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({
        mode: 'latest',
        countries: ['Japan', 'Germany', 'France', 'Korea'],
      });
      const result = await getExchangeRatesTool.handler(input, ctx);

      expect(result.as_of_date).toBe('2026-06-30');
      expect(result.mixed_record_dates).toBe(true);
      expect(result.rates.map((r) => r.record_date)).toEqual([
        '2026-06-30',
        '2026-06-30',
        '2025-03-31',
        '2025-03-31',
      ]);
    });

    it('discloses the span and points at the per-row date', async () => {
      serveRows(MIXED_DATE_ROWS);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({
        mode: 'latest',
        countries: ['Japan', 'Germany', 'France', 'Korea'],
      });
      await getExchangeRatesTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('2025-03-31');
      expect(notice).toContain('2026-06-30');
      expect(notice).toContain('record_date');
    });

    it('composes the missing-country and mixed-date disclosures into one notice', async () => {
      serveRows(MIXED_DATE_ROWS);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({
        mode: 'latest',
        countries: ['Japan', 'Germany', 'France', 'Korea', 'Atlantis'],
      });
      await getExchangeRatesTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Atlantis');
      expect(notice).toContain('2025-03-31');
    });

    it('carries a row effective_date that its record_date does not imply', async () => {
      /**
       * Treasury amends a rate mid-quarter by republishing it under the same
       * record_date with a later effective_date. The amended row is the one that
       * survives, and its effective_date is the only field that says the rate is
       * not the plain quarter-end one — a top-level date cannot express it.
       */
      const result = await latestOver(AMENDED_QUARTER_ROWS, ['Bolivia']);

      expect(result.mixed_record_dates).toBe(false);
      expect(result.as_of_date).toBe('2026-06-30');
      expect(result.rates[0]?.record_date).toBe('2026-06-30');
      expect(result.rates[0]?.effective_date).toBe('2026-07-15');
    });

    it('flags a series spanning quarters without a redundant notice', async () => {
      serveRows(MIXED_DATE_ROWS);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({
        mode: 'series',
        start_date: '2025-01-01',
        end_date: '2026-06-30',
      });
      const result = await getExchangeRatesTool.handler(input, ctx);

      expect(result.mixed_record_dates).toBe(true);
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('reports an empty result as unmixed', async () => {
      serveRows([], 0);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({ mode: 'latest' });
      const result = await getExchangeRatesTool.handler(input, ctx);

      expect(result.rates).toHaveLength(0);
      expect(result.as_of_date).toBe('');
      expect(result.mixed_record_dates).toBe(false);
    });
  });

  describe('one row per currency in latest mode', () => {
    it('reports the amended rate, not the one it superseded', async () => {
      const result = await latestOver(AMENDED_QUARTER_ROWS, ['Bolivia']);

      expect(result.rates).toHaveLength(1);
      expect(result.rates[0]?.exchange_rate).toBe('10.35');
      expect(result.rates[0]?.effective_date).toBe('2026-07-15');
    });

    it('drops the superseded rate from the unfiltered quarter too', async () => {
      const result = await latestOver(AMENDED_QUARTER_ROWS);

      expect(result.rates.map((r) => r.exchange_rate)).not.toContain('6.85');
      expect(rateFor(result.rates, 'Bolivia-Boliviano')).toBe('10.35');
    });

    it('agrees with the unfiltered call about every currency it returns', async () => {
      const unfiltered = await latestOver(AMENDED_QUARTER_ROWS);
      const filtered = await latestOver(AMENDED_QUARTER_ROWS, ['Bolivia', 'Cuba']);

      for (const label of ['Bolivia-Boliviano', 'Cuba-Chavito', 'Cuba-Peso']) {
        expect(rateFor(filtered.rates, label)).toBe(rateFor(unfiltered.rates, label));
      }
      // Agreeing on the superseded rate would satisfy the loop above.
      expect(rateFor(filtered.rates, 'Bolivia-Boliviano')).toBe('10.35');
    });

    it('keeps both of a country two legal-tender currencies', async () => {
      const filtered = await latestOver(AMENDED_QUARTER_ROWS, ['Cuba']);

      expect(rateFor(filtered.rates, 'Cuba-Chavito')).toBe('1.0');
      expect(rateFor(filtered.rates, 'Cuba-Peso')).toBe('24.0');
    });

    it('still returns a country whose newest rate predates the quarter', async () => {
      const filtered = await latestOver(AMENDED_QUARTER_ROWS, ['Bolivia', 'Cuba', 'Germany']);

      expect(rateFor(filtered.rates, 'Germany-Euro')).toBe('0.924');
      expect(
        filtered.rates.find((r) => r.country_currency_desc === 'Germany-Euro')?.record_date,
      ).toBe('2025-03-31');
      expect(filtered.mixed_record_dates).toBe(true);
    });

    it('leaves a series spanning an amendment intact', async () => {
      serveRows(AMENDED_QUARTER_ROWS);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const input = getExchangeRatesTool.input.parse({
        mode: 'series',
        start_date: '2025-01-01',
        end_date: '2026-06-30',
      });
      const result = await getExchangeRatesTool.handler(input, ctx);

      expect(result.rates).toHaveLength(AMENDED_QUARTER_ROWS.length);
      expect(result.rates.map((r) => r.exchange_rate)).toContain('6.85');
      expect(result.rates.map((r) => r.exchange_rate)).toContain('10.35');
    });
  });

  describe('canvas staging disclosure', () => {
    /** A series call whose upstream match crosses the 500-row auto-spill threshold. */
    function seriesInput(extra: Record<string, unknown> = {}) {
      return getExchangeRatesTool.input.parse({
        mode: 'series',
        start_date: '2020-01-01',
        end_date: '2026-06-30',
        ...extra,
      });
    }

    function stagedAs(tableName: string) {
      vi.mocked(maybeRegisterDataframe).mockResolvedValue({
        canvasId: tableName,
        canvasExpiresAt: '2026-08-13T00:00:00.000Z',
      });
    }

    it('names the staged table and both dataframe tools', async () => {
      serveRows(MIXED_DATE_ROWS, 900);
      stagedAs('df_FXSER_00001');

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const result = await getExchangeRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBe('df_FXSER_00001');
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('df_FXSER_00001');
      expect(notice).toContain('treasury_dataframe_describe');
      expect(notice).toContain('treasury_dataframe_query');
      expect(notice.indexOf('treasury_dataframe_describe')).toBeLessThan(
        notice.indexOf('treasury_dataframe_query'),
      );
    });

    it('discloses staging requested by canvas_id below the auto-spill threshold', async () => {
      serveRows(MIXED_DATE_ROWS);
      stagedAs('df_FXSER_00002');

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const result = await getExchangeRatesTool.handler(
        seriesInput({ canvas_id: 'stage-it' }),
        ctx,
      );

      expect(result.canvas_id).toBe('df_FXSER_00002');
      expect(String(getEnrichment(ctx).notice)).toContain('df_FXSER_00002');
    });

    it('composes the missing-country warning with the staging pointer', async () => {
      serveRows(MIXED_DATE_ROWS, 900);
      stagedAs('df_FXSER_00003');

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      await getExchangeRatesTool.handler(
        seriesInput({ countries: ['Japan', 'Germany', 'Atlantis'] }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Atlantis');
      expect(notice).toContain('df_FXSER_00003');
    });

    it('explains the absent canvas_id when staging was triggered but unavailable', async () => {
      serveRows(MIXED_DATE_ROWS, 900);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const result = await getExchangeRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('could not be staged');
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    });

    it('stays silent when staging was never in play', async () => {
      serveRows(MIXED_DATE_ROWS);

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const result = await getExchangeRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('never stages a latest-mode call', async () => {
      serveRows(MIXED_DATE_ROWS, 900);
      stagedAs('df_FXSER_00004');

      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });
      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'latest', canvas_id: 'stage-it' }),
        ctx,
      );

      expect(maybeRegisterDataframe).not.toHaveBeenCalled();
      expect(result.canvas_id).toBeUndefined();
      expect(String(getEnrichment(ctx).notice)).not.toContain('df_FXSER_00004');
    });
  });

  describe('the newest quarter is fetched whole', () => {
    /**
     * A quarter larger than any single fixed slice of the newest rows. The
     * 2025-03-31 report reached 201 currencies, and the count trends up as
     * currencies are added.
     */
    const OVERSIZED = [...quarterRows('2026-06-30', 201), ...quarterRows('2026-03-31', 180, 'P')];

    it('returns every currency in the quarter, not the first pageful of them', async () => {
      usePaged(OVERSIZED);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'latest' }),
        ctx,
      );

      expect(result.rates).toHaveLength(201);
      expect(result.rates.every((r) => r.record_date === '2026-06-30')).toBe(true);
      expect(result.total_records).toBe(201);
    });

    it('asks the API for the quarter by date rather than for the newest N rows', async () => {
      const fetchPage = usePaged(OVERSIZED);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      await getExchangeRatesTool.handler(getExchangeRatesTool.input.parse({ mode: 'latest' }), ctx);

      const [probe, main] = fetchPage.mock.calls;
      expect(probe?.[2]).toMatchObject({ pageSize: 1, sort: '-record_date' });
      expect(main?.[2]?.filters).toContainEqual({
        field: 'record_date',
        operator: 'eq',
        value: '2026-06-30',
      });
      expect(main?.[2]?.pageSize).toBe(10_000);
    });

    it('leaves a country filter unpinned to the newest quarter', async () => {
      const fetchPage = usePaged([
        ...quarterRows('2026-06-30', 3),
        {
          record_date: '2025-03-31',
          country: 'Germany',
          currency: 'Euro',
          country_currency_desc: 'Germany-Euro',
          exchange_rate: '0.924',
          effective_date: '2025-03-31',
        },
      ]);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'latest', countries: ['C0', 'Germany'] }),
        ctx,
      );

      // One call only — the probe exists to pin an unfiltered quarter.
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(fetchPage.mock.calls[0]?.[2]?.filters).not.toContainEqual(
        expect.objectContaining({ field: 'record_date' }),
      );
      expect(rateFor(result.rates, 'Germany-Euro')).toBe('0.924');
    });

    it('says so when a country filter matched more rows than the fetch retrieved', async () => {
      serveRows(MIXED_DATE_ROWS, 12_000);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({
          mode: 'latest',
          countries: ['Japan', 'Germany', 'France', 'Korea'],
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('12000');
      expect(notice).toContain('fewer countries');
    });
  });

  describe('inline series cap', () => {
    /** A multi-quarter series bigger than the inline cap. */
    const LONG_SERIES = [
      ...quarterRows('2026-06-30', 30),
      ...quarterRows('2026-03-31', 30),
      ...quarterRows('2025-12-31', 30),
    ];

    function longSeriesInput(extra: Record<string, unknown> = {}) {
      return getExchangeRatesTool.input.parse({
        mode: 'series',
        start_date: '2025-01-01',
        end_date: '2026-06-30',
        ...extra,
      });
    }

    it('caps the inline series when no canvas is configured', async () => {
      usePaged(LONG_SERIES);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(longSeriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(result.rates).toHaveLength(20);
      expect(result.retrieved_records).toBe(90);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 20, cap: 20 });
      expect(String(getEnrichment(ctx).notice)).toContain('Showing 20 of 90');
    });

    it('names the missing canvas when staging was requested and unavailable', async () => {
      usePaged(LONG_SERIES);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      await getExchangeRatesTool.handler(longSeriesInput({ canvas_id: 'stage-it' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(notice).not.toContain('Pass canvas_id');
    });

    it('offers canvas_id when staging was never attempted', async () => {
      usePaged(LONG_SERIES);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      await getExchangeRatesTool.handler(longSeriesInput(), ctx);

      expect(String(getEnrichment(ctx).notice)).toContain('Pass canvas_id');
    });

    it('flags mixed record dates from the retrieved set, not the preview', async () => {
      /**
       * The first 20 rows of a quarter-sorted series all share the newest
       * quarter, so a flag read off the preview reports a single-quarter set for
       * a series that spans three.
       */
      usePaged(LONG_SERIES);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(longSeriesInput(), ctx);

      expect(new Set(result.rates.map((r) => r.record_date))).toEqual(new Set(['2026-06-30']));
      expect(result.mixed_record_dates).toBe(true);
    });

    it('leaves latest mode whole — a quarter is a bounded set', async () => {
      usePaged([...quarterRows('2026-06-30', 40), ...quarterRows('2026-03-31', 40, 'P')]);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'latest' }),
        ctx,
      );

      expect(result.rates).toHaveLength(40);
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
    });

    it('reports the cap in the text block without a canvas to point at', () => {
      const text = (
        getExchangeRatesTool.format!({
          as_of_date: '2026-06-30',
          effective_date: '2026-06-30',
          mixed_record_dates: false,
          rates: [
            {
              country: 'Japan',
              currency: 'Yen',
              country_currency_desc: 'Japan-Yen',
              exchange_rate: '162.38',
              record_date: '2026-06-30',
              effective_date: '2026-06-30',
            },
          ],
          total_records: 900,
          note: 'Official reporting rates, not market rates.',
        })[0] as { text: string }
      ).text;

      expect(text).toContain('showing 1 of 900');
    });
  });

  describe('series paging', () => {
    it('walks past the page ceiling to reach the whole match', async () => {
      const rows = [...quarterRows('2026-06-30', 6_000), ...quarterRows('2026-03-31', 6_000, 'P')];
      const fetchPage = usePaged(rows);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'series', start_date: '2001-03-31' }),
        ctx,
      );

      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls.map((c) => c[2]?.pageNumber)).toEqual([1, 2]);
      expect(result.retrieved_records).toBe(12_000);
      expect(result.total_records).toBe(12_000);
    });

    it('reports what it retrieved when the match outruns the row bound', async () => {
      serveRows(MIXED_DATE_ROWS, 900);
      const ctx = createMockContext({ errors: getExchangeRatesTool.errors });

      const result = await getExchangeRatesTool.handler(
        getExchangeRatesTool.input.parse({ mode: 'series', start_date: '2001-03-31' }),
        ctx,
      );

      expect(result.retrieved_records).toBe(4);
      expect(result.total_records).toBe(900);
      expect(String(getEnrichment(ctx).notice)).toContain('4 of 900');

      const text = (getExchangeRatesTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Retrieved:** 4 rows');
    });
  });

  it('formats output with country_currency_desc column', () => {
    const result = {
      as_of_date: '2026-03-31',
      effective_date: '2026-03-31',
      mixed_record_dates: false,
      rates: [
        {
          country: 'Japan',
          currency: 'Yen',
          country_currency_desc: 'Japan-Yen',
          exchange_rate: '159.41',
          record_date: '2026-03-31',
          effective_date: '2026-03-31',
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

  it('stamps a single as-of header when every row shares the date', () => {
    const result = {
      as_of_date: '2026-03-31',
      effective_date: '2026-03-31',
      mixed_record_dates: false,
      rates: [
        {
          country: 'Japan',
          currency: 'Yen',
          country_currency_desc: 'Japan-Yen',
          exchange_rate: '159.41',
          record_date: '2026-03-31',
          effective_date: '2026-03-31',
        },
      ],
      total_records: 1,
      note: 'Official reporting rates, not market rates.',
    };
    const text = (getExchangeRatesTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**As of:** 2026-03-31 (effective 2026-03-31)');
  });

  it('withholds the as-of header when the rows do not share a date', () => {
    const result = {
      as_of_date: '2026-06-30',
      effective_date: '2026-06-30',
      mixed_record_dates: true,
      rates: [
        {
          country: 'Japan',
          currency: 'Yen',
          country_currency_desc: 'Japan-Yen',
          exchange_rate: '162.38',
          record_date: '2026-06-30',
          effective_date: '2026-06-30',
        },
        {
          country: 'Germany',
          currency: 'Euro',
          country_currency_desc: 'Germany-Euro',
          exchange_rate: '0.924',
          record_date: '2025-03-31',
          effective_date: '2025-03-31',
        },
      ],
      total_records: 2,
      note: 'Official reporting rates, not market rates.',
    };
    const text = (getExchangeRatesTool.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('**As of:**');
    expect(text).toContain('2026-06-30');
    expect(text).toContain('2025-03-31');
  });

  it('formats a per-row effective date that differs from its record date', () => {
    const result = {
      as_of_date: '2026-06-30',
      effective_date: '2026-06-30',
      mixed_record_dates: false,
      rates: [
        {
          country: 'Bolivia',
          currency: 'Boliviano',
          country_currency_desc: 'Bolivia-Boliviano',
          exchange_rate: '10.35',
          record_date: '2026-06-30',
          effective_date: '2026-07-15',
        },
      ],
      total_records: 1,
      note: 'Official reporting rates, not market rates.',
    };
    const text = (getExchangeRatesTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('2026-07-15');
  });

  it('formats empty rates', () => {
    const result = {
      as_of_date: '',
      effective_date: '',
      mixed_record_dates: false,
      rates: [],
      total_records: 0,
      note: 'Official reporting rates.',
    };
    const blocks = getExchangeRatesTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No records');
  });
});
