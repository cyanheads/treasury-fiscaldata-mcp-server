/**
 * @fileoverview Tests for treasury_get_interest_rates tool.
 * @module tests/tools/get-interest-rates.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

vi.mock('@/services/fiscal-data/fiscal-data-service.js', () => ({
  getFiscalDataService: vi.fn(),
  initFiscalDataService: vi.fn(),
}));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>();
  return {
    ...actual,
    getCanvasBridge: vi.fn().mockReturnValue(undefined),
    initCanvasBridge: vi.fn(),
  };
});

import { getInterestRatesTool } from '@/mcp-server/tools/definitions/get-interest-rates.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
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

/** Install a service whose every fetchPage answers `envelope`, and hand back the spy. */
function useService(envelope: FiscalDataEnvelope) {
  const fetchPage = vi.fn().mockResolvedValue(envelope);
  vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
    typeof getFiscalDataService
  >);
  return fetchPage;
}

/** Install a service that answers each fetchPage call from `envelopes` in order. */
function useServiceSequence(envelopes: FiscalDataEnvelope[]) {
  const fetchPage = vi.fn();
  for (const envelope of envelopes) fetchPage.mockResolvedValueOnce(envelope);
  vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
    typeof getFiscalDataService
  >);
  return fetchPage;
}

/** Install a canvas bridge whose registration succeeds under `tableName`. */
function useBridge(tableName: string, rowCount: number) {
  const registerDataframe = vi.fn().mockResolvedValue({
    tableName,
    rowCount,
    expiresAt: '2026-06-02T00:00:00.000Z',
    columnSchema: [],
  });
  vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as unknown as ReturnType<
    typeof getCanvasBridge
  >);
  return registerDataframe;
}

/** A series envelope whose upstream match exceeds the 200-row auto-spill threshold. */
function makeSeriesEnvelope(rows: RateRow[], totalCount: number): FiscalDataEnvelope {
  return {
    ...makeRatesEnvelope(rows),
    meta: { ...makeRatesEnvelope(rows).meta, 'total-count': totalCount },
  };
}

describe('getInterestRatesTool', () => {
  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReset().mockReturnValue(undefined);
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

  describe('security_type filter', () => {
    it('sends an exact-match security_desc filter in latest mode', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: 'Treasury Bills' }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]).toMatchObject({
        filters: [{ field: 'security_desc', operator: 'eq', value: 'Treasury Bills' }],
      });
    });

    it('reaches a non-marketable security type the enum used to reject', async () => {
      const ffb: RateRow = {
        record_date: '2026-07-31',
        security_type_desc: 'Marketable',
        security_desc: 'Federal Financing Bank',
        avg_interest_rate_amt: '2.383',
      };
      const fetchPage = useService(makeRatesEnvelope([ffb]));
      const ctx = createMockContext();

      const input = getInterestRatesTool.input.parse({
        mode: 'latest',
        security_type: 'Federal Financing Bank',
      });
      const result = await getInterestRatesTool.handler(input, ctx);

      expect(fetchPage.mock.calls[0]?.[2]).toMatchObject({
        filters: [{ field: 'security_desc', operator: 'eq', value: 'Federal Financing Bank' }],
      });
      expect(result.rates).toEqual([
        {
          record_date: '2026-07-31',
          security_type: 'Marketable',
          security_desc: 'Federal Financing Bank',
          avg_interest_rate_pct: '2.383',
        },
      ]);
      const text = (getInterestRatesTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Federal Financing Bank');
      expect(text).toContain('2.383%');
    });

    it('reaches a security type retired from the current month', async () => {
      const foreignSeries: RateRow = {
        record_date: '2026-03-31',
        security_type_desc: 'Non-marketable',
        security_desc: 'Foreign Series',
        avg_interest_rate_amt: '4.150',
      };
      useService(makeRatesEnvelope([foreignSeries]));
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: 'Foreign Series' }),
        ctx,
      );

      expect(result.as_of_date).toBe('2026-03-31');
      expect(result.rates[0]?.security_desc).toBe('Foreign Series');
    });

    it('treats a blank security_type as no filter, the way form clients send it', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: '' }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]).not.toHaveProperty('filters');
      expect(result.rates).toHaveLength(SAMPLE_ROWS.length);
    });

    it('carries the security filter alongside the date bounds in series mode', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: 'Treasury Notes',
          start_date: '2026-01-31',
          end_date: '2026-04-30',
        }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]).toMatchObject({
        filters: [
          { field: 'security_desc', operator: 'eq', value: 'Treasury Notes' },
          { field: 'record_date', operator: 'gte', value: '2026-01-31' },
          { field: 'record_date', operator: 'lte', value: '2026-04-30' },
        ],
      });
    });
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

  describe('empty-result guidance', () => {
    function useEmpty() {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope([])),
      } as unknown as ReturnType<typeof getFiscalDataService>);
    }

    /** One record_date's worth of rows, one per security type. */
    function monthEnvelope(recordDate: string, descs: string[]): FiscalDataEnvelope {
      return makeRatesEnvelope(
        descs.map((desc) => ({
          record_date: recordDate,
          security_type_desc: 'Non-marketable',
          security_desc: desc,
          avg_interest_rate_amt: '3.500',
        })),
      );
    }

    /** A one-row probe answer carrying `total` as the upstream match count. */
    function probeEnvelope(recordDate: string, total: number): FiscalDataEnvelope {
      return makeSeriesEnvelope(
        [
          {
            record_date: recordDate,
            security_type_desc: 'Non-marketable',
            security_desc: 'Foreign Series',
            avg_interest_rate_amt: '4.150',
          },
        ],
        total,
      );
    }

    const CURRENT_MONTH = ['Treasury Bills', 'Federal Financing Bank', 'Government Account Series'];

    it('names the date range as the suspect when the security type has records elsewhere', async () => {
      const fetchPage = useServiceSequence([
        makeRatesEnvelope([]),
        probeEnvelope('2026-03-31', 303),
        probeEnvelope('2001-01-31', 303),
      ]);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: 'Foreign Series',
          start_date: '2026-06-01',
          end_date: '2026-08-31',
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Foreign Series');
      expect(notice).toContain('303 records');
      expect(notice).toContain('2001-01-31 to 2026-03-31');
      expect(notice).toContain('start_date');
      // The type is real — the guidance must never say otherwise.
      expect(notice).not.toContain('carries that name');
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('probes the whole dataset for the type, unbounded by the requested range', async () => {
      const fetchPage = useServiceSequence([
        makeRatesEnvelope([]),
        probeEnvelope('2026-03-31', 303),
        probeEnvelope('2001-01-31', 303),
      ]);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: 'Foreign Series',
          start_date: '2026-06-01',
          end_date: '2026-08-31',
        }),
        ctx,
      );

      const securityOnly = [{ field: 'security_desc', operator: 'eq', value: 'Foreign Series' }];
      expect(fetchPage.mock.calls[1]?.[2]).toMatchObject({
        filters: securityOnly,
        sort: '-record_date',
        pageSize: 1,
      });
      expect(fetchPage.mock.calls[2]?.[2]).toMatchObject({
        filters: securityOnly,
        sort: 'record_date',
        pageSize: 1,
      });
    });

    it('names the types the current month carries when no record holds the name', async () => {
      useServiceSequence([
        makeRatesEnvelope([]),
        makeRatesEnvelope([]),
        makeRatesEnvelope([]),
        monthEnvelope('2026-07-31', CURRENT_MONTH),
      ]);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: 'Treasury Bils',
          start_date: '2026-01-31',
          end_date: '2026-07-31',
        }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('no record in this dataset carries that name');
      expect(notice).toContain('2026-07-31');
      for (const desc of CURRENT_MONTH) expect(notice).toContain(desc);
      // The name is wrong, so the range was never the problem.
      expect(notice).not.toContain('widen start_date');
    });

    it('lists the current month rather than a vocabulary compiled at authoring time', async () => {
      useServiceSequence([makeRatesEnvelope([]), monthEnvelope('2026-07-31', CURRENT_MONTH)]);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: 'Treasury Bils' }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Federal Financing Bank');
      expect(notice).toContain('Government Account Series');
      expect(notice).toContain('no longer publishes');
      // Latest mode sends no date range, so it has none to blame.
      expect(notice).not.toContain('start_date');
    });

    it('does not blame a date range in latest mode, where none was sent', async () => {
      useEmpty();
      const ctx = createMockContext();

      await getInterestRatesTool.handler(getInterestRatesTool.input.parse({ mode: 'latest' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).not.toContain('date range');
      expect(notice).not.toContain('start_date');
    });

    it('points at the range when a series matched nothing and no type was filtered', async () => {
      useEmpty();
      const ctx = createMockContext();

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          start_date: '2099-01-01',
          end_date: '2099-12-31',
        }),
        ctx,
      );

      expect(String(getEnrichment(ctx).notice)).toContain('start_date');
    });
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

  describe('canvas staging disclosure', () => {
    function useBigSeries(totalCount = 250) {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeSeriesEnvelope(SAMPLE_ROWS, totalCount)),
      } as unknown as ReturnType<typeof getFiscalDataService>);
    }

    function seriesInput(extra: Record<string, unknown> = {}) {
      return getInterestRatesTool.input.parse({
        mode: 'series',
        start_date: '2026-01-31',
        end_date: '2026-04-30',
        ...extra,
      });
    }

    it('names the staged table and both dataframe tools', async () => {
      useBigSeries();
      useBridge('df_RATES_00001', 3);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBe('df_RATES_00001');
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('df_RATES_00001');
      expect(notice).toContain('treasury_dataframe_describe');
      expect(notice).toContain('treasury_dataframe_query');
      expect(notice.indexOf('treasury_dataframe_describe')).toBeLessThan(
        notice.indexOf('treasury_dataframe_query'),
      );
    });

    it('discloses staging requested by canvas_id below the auto-spill threshold', async () => {
      useBigSeries(3);
      useBridge('df_RATES_00002', 3);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(
        seriesInput({ canvas_id: 'stage-it' }),
        ctx,
      );

      expect(result.canvas_id).toBe('df_RATES_00002');
      expect(String(getEnrichment(ctx).notice)).toContain('df_RATES_00002');
    });

    it('explains the absent canvas_id when staging was triggered but unavailable', async () => {
      useBigSeries();
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('could not be staged');
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    });

    it('stays silent when staging was never in play', async () => {
      useBigSeries(3);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('leaves the empty-result guidance as the only notice', async () => {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope([])),
      } as unknown as ReturnType<typeof getFiscalDataService>);
      useBridge('df_RATES_00003', 0);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('No interest rate records found');
      expect(notice).not.toContain('df_RATES_00003');
    });
  });

  describe('inline series cap', () => {
    /** A month of rows per record_date, newest first, spanning `months` months. */
    function monthlyRows(months: number): RateRow[] {
      return Array.from({ length: months }, (_, m) =>
        SECURITY_SAMPLE.map((desc) => ({
          record_date: `2026-${String(12 - (m % 12)).padStart(2, '0')}-28`,
          security_type_desc: 'Marketable',
          security_desc: desc,
          avg_interest_rate_amt: '3.500',
        })),
      ).flat();
    }

    const SECURITY_SAMPLE = ['Treasury Bills', 'Treasury Notes', 'Treasury Bonds'];

    function useSeries(rows: RateRow[], totalCount = rows.length) {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeSeriesEnvelope(rows, totalCount)),
      } as unknown as ReturnType<typeof getFiscalDataService>);
    }

    function seriesInput(extra: Record<string, unknown> = {}) {
      return getInterestRatesTool.input.parse({
        mode: 'series',
        start_date: '2001-01-31',
        end_date: '2026-07-31',
        ...extra,
      });
    }

    it('caps the inline series when no canvas is configured', async () => {
      /**
       * The default install: CANVAS_PROVIDER_TYPE unset, so nothing absorbs the
       * remainder and every fetched row used to come back inline.
       */
      useSeries(monthlyRows(40), 4993);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(result.rates).toHaveLength(20);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 20, cap: 20 });
    });

    it('names the missing canvas rather than telling the caller to pass canvas_id', async () => {
      useSeries(monthlyRows(40), 4993);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(notice).toContain('120 retrieved rows');
      expect(notice).not.toContain('Pass canvas_id');
    });

    it('offers canvas_id when staging was never attempted', async () => {
      useSeries(monthlyRows(40), 120);
      const ctx = createMockContext();

      await getInterestRatesTool.handler(seriesInput(), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Pass canvas_id');
      expect(notice).not.toContain('could not be staged');
    });

    it('caps and names the table when a canvas did absorb the rest', async () => {
      useSeries(monthlyRows(40), 4993);
      useBridge('df_RATES_CAPPD', 120);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.rates).toHaveLength(20);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('df_RATES_CAPPD');
      expect(notice).toContain('Showing 20 of 120');
    });

    it('leaves latest mode whole — a month is a bounded set', async () => {
      const oneMonth: RateRow[] = Array.from({ length: 17 }, (_, i) => ({
        record_date: '2026-07-31',
        security_type_desc: 'Marketable',
        security_desc: `Security ${i}`,
        avg_interest_rate_amt: '3.500',
      }));
      useSeries(oneMonth, 4993);
      const ctx = createMockContext();

      const result = await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest' }),
        ctx,
      );

      expect(result.rates).toHaveLength(17);
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
    });

    it('reports the cap in the text block without a canvas to point at', () => {
      const text = (
        getInterestRatesTool.format!({
          as_of_date: '2026-07-31',
          rates: [
            {
              record_date: '2026-07-31',
              security_type: 'Marketable',
              security_desc: 'Treasury Bills',
              avg_interest_rate_pct: '3.696',
            },
          ],
          total_records: 4993,
        })[0] as { text: string }
      ).text;

      expect(text).toContain('showing 1 of 4993');
    });
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
