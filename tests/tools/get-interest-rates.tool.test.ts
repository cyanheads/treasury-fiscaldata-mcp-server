/**
 * @fileoverview Tests for treasury_get_interest_rates tool.
 * @module tests/tools/get-interest-rates.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';
import {
  type Answer,
  delayed,
  envelopeBody,
  hang,
  jsonOk,
  labelsFor,
  labelsOk,
  notFoundText,
  unselectedSortTerms,
} from '../helpers/fiscal-data-upstream.js';
import {
  contentText,
  HOSTILE_VALUE,
  readBlockquotes,
  readParagraphs,
  readTables,
} from '../helpers/markdown-read-back.js';

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

const RATES_ENDPOINT = '/v2/accounting/od/avg_interest_rates';

type RateRow = {
  record_date: string;
  security_type_desc: string;
  security_desc: string;
  avg_interest_rate_amt: string;
};

/** Every field the endpoint answers an unselected request with, as `meta.labels` keys. */
const RATES_FIELDS = [
  'record_date',
  'security_type_desc',
  'security_desc',
  'avg_interest_rate_amt',
  'src_line_nbr',
];
const RATES_LABELS = labelsFor(RATES_FIELDS);

/** A response body as the API sends it: `meta.labels` keyed by every field. */
function ratesBody(rows: Record<string, string>[], totalCount = rows.length): string {
  return envelopeBody(rows, totalCount, RATES_FIELDS);
}

function makeRatesEnvelope(rows: RateRow[]): FiscalDataEnvelope {
  return {
    data: rows as Record<string, string>[],
    meta: {
      count: rows.length,
      labels: RATES_LABELS,
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
    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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

    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: 'Foreign Series' }),
        ctx,
      );

      expect(result.as_of_date).toBe('2026-03-31');
      expect(result.rates[0]?.security_desc).toBe('Foreign Series');
    });

    it('treats a blank security_type as no filter, the way form clients send it', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: '' }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]).not.toHaveProperty('filters');
      expect(result.rates).toHaveLength(SAMPLE_ROWS.length);
    });

    it('treats a whitespace-only security_type as no filter', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: ' \t ' }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]).not.toHaveProperty('filters');
    });

    it('filters on the security_type with its surrounding whitespace trimmed', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: '  Treasury Bills\t' }),
        ctx,
      );

      expect(fetchPage.mock.calls[0]?.[2]?.filters).toEqual([
        { field: 'security_desc', operator: 'eq', value: 'Treasury Bills' },
      ]);
    });

    it('stages the trimmed security_type as the query that produced the table', async () => {
      useService(makeSeriesEnvelope(SAMPLE_ROWS, 250));
      const registerDataframe = useBridge('df_RATES_TRIMD', 3);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: ' Treasury Notes ',
          start_date: '2026-01-31',
        }),
        ctx,
      );

      expect(registerDataframe.mock.calls[0]?.[1]?.queryParams).toMatchObject({
        security_type: 'Treasury Notes',
      });
    });

    it('stages no security_type when the filter was blank', async () => {
      useService(makeSeriesEnvelope(SAMPLE_ROWS, 250));
      const registerDataframe = useBridge('df_RATES_BLANK', 3);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: '  ',
          start_date: '2026-01-31',
        }),
        ctx,
      );

      expect(registerDataframe.mock.calls[0]?.[1]?.queryParams.security_type).toBeUndefined();
    });

    it.each<[string, Record<string, string>, string[]]>([
      ['a whitespace-only start_date', { start_date: '  ', end_date: '2026-04-30' }, ['lte']],
      ['a whitespace-only end_date', { start_date: '2026-01-31', end_date: '\t' }, ['gte']],
      ['both bounds whitespace-only', { start_date: ' ', end_date: ' ' }, []],
    ])('sends only the supplied series bounds for %s', async (_label, bounds, operators) => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'series', ...bounds }),
        ctx,
      );

      const filters = (fetchPage.mock.calls[0]?.[2]?.filters ?? []) as { operator: string }[];
      expect(filters.map((f) => f.operator)).toEqual(operators);
    });

    it('carries the security filter alongside the date bounds in series mode', async () => {
      const fetchPage = useService(makeRatesEnvelope(SAMPLE_ROWS));
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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

    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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

    it('skips the span probe when a series carries no date bounds at all', async () => {
      /**
       * The probe separates "your range missed it" from "no record holds that
       * name", and only a range can be the former. With neither bound set the
       * main fetch already ran this exact unbounded filter and matched nothing,
       * so the probe re-asks a question upstream has answered — and it cannot
       * answer differently, since an empty match has no dates to report.
       */
      const fetchPage = vi.fn(
        async (_ctx: unknown, _endpoint: string, opts?: { fields?: string[] }) =>
          opts?.fields?.includes('security_desc')
            ? monthEnvelope('2026-04-30', CURRENT_MONTH)
            : makeRatesEnvelope([]),
      );
      vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
        typeof getFiscalDataService
      >);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'series', security_type: 'Nonexistent Series' }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('carries that name');
      expect(notice).toContain('Treasury Bills');
      // No range was requested, so the guidance must not send the caller to widen one.
      expect(notice).not.toContain('widen start_date');
      // One fetch for the query, one for the current month's types. No probes.
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('names the types the current month carries when no record holds the name', async () => {
      useServiceSequence([
        makeRatesEnvelope([]),
        makeRatesEnvelope([]),
        makeRatesEnvelope([]),
        monthEnvelope('2026-07-31', CURRENT_MONTH),
      ]);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(getInterestRatesTool.input.parse({ mode: 'latest' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).not.toContain('date range');
      expect(notice).not.toContain('start_date');
    });

    it('points at the range when a series matched nothing and no type was filtered', async () => {
      useEmpty();
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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

    it('lists only the newest month when the listing page reaches into an older one', async () => {
      /**
       * The listing page holds the newest rows whatever their month, so one
       * page spans a month boundary whenever the newest month is short — a type
       * published only in the older month is not current.
       */
      useServiceSequence([
        makeRatesEnvelope([]),
        makeRatesEnvelope([
          ...monthEnvelope('2026-07-31', ['Treasury Bills', 'Federal Financing Bank']).data,
          ...monthEnvelope('2026-06-30', ['Treasury Bills', 'Foreign Series']).data,
        ] as RateRow[]),
      ]);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({ mode: 'latest', security_type: 'Treasury Bils' }),
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('(2026-07-31): Treasury Bills, Federal Financing Bank.');
      expect(notice).not.toContain('Foreign Series');
      expect(notice).not.toContain('2026-06-30');
    });

    it('lists every sort term in the fields of each request it sends', async () => {
      const fetchPage = useServiceSequence([
        makeRatesEnvelope(SAMPLE_ROWS),
        makeRatesEnvelope([]),
        probeEnvelope('2026-03-31', 0),
        probeEnvelope('2001-01-31', 0),
        monthEnvelope('2026-07-31', CURRENT_MONTH),
      ]);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(getInterestRatesTool.input.parse({ mode: 'latest' }), ctx);
      await getInterestRatesTool.handler(
        getInterestRatesTool.input.parse({
          mode: 'series',
          security_type: 'Treasury Bils',
          start_date: '2026-01-31',
        }),
        ctx,
      );

      expect(fetchPage).toHaveBeenCalledTimes(5);
      expect(unselectedSortTerms(fetchPage.mock.calls)).toEqual([]);
    });

    /**
     * The listing runs after the answer — an empty match — has arrived, and
     * only adds the names on offer to guidance that already says the name is
     * unknown. Losing it to an unavailable upstream costs that list, not the
     * answer.
     */
    describe('when the current-month listing cannot be fetched', () => {
      const NOPE = { mode: 'latest', security_type: 'Nope Bills' } as const;

      function useListingFailure(error: unknown) {
        const fetchPage = vi
          .fn()
          .mockResolvedValueOnce(makeRatesEnvelope([]))
          .mockRejectedValueOnce(error);
        vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
          typeof getFiscalDataService
        >);
        return fetchPage;
      }

      it('returns the empty answer and says the list was unavailable', async () => {
        useListingFailure(
          serviceUnavailable('Fiscal Data API returned HTTP 503.', {
            status: 503,
            endpoint: RATES_ENDPOINT,
            retryable: true,
          }),
        );
        const ctx = createMockContext({ errors: getInterestRatesTool.errors });

        const result = await getInterestRatesTool.handler(
          getInterestRatesTool.input.parse(NOPE),
          ctx,
        );

        expect(result).toEqual({ as_of_date: '', rates: [], total_records: 0 });
        const notice = String(getEnrichment(ctx).notice);
        expect(notice).toContain('no record in this dataset carries that name');
        expect(notice).toContain('could not be fetched');
        expect(notice).toContain('unavailable');
        expect(notice).toContain('mode=latest');
      });

      it('rethrows the failure when the caller cancelled the call', async () => {
        const controller = new AbortController();
        const fetchPage = vi
          .fn()
          .mockResolvedValueOnce(makeRatesEnvelope([]))
          .mockImplementationOnce(() => {
            controller.abort();
            return Promise.reject(timeout('Fiscal Data request was cancelled.'));
          });
        vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
          typeof getFiscalDataService
        >);
        const ctx = createMockContext({
          errors: getInterestRatesTool.errors,
          signal: controller.signal,
        });

        await expect(
          getInterestRatesTool.handler(getInterestRatesTool.input.parse(NOPE), ctx),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          message: 'Fiscal Data request was cancelled.',
        });
        expect(getEnrichment(ctx)).not.toHaveProperty('notice');
      });

      it('fails loudly when the listing names a field the API dropped', async () => {
        const drift = validationError(
          `Unknown field name on endpoint "${RATES_ENDPOINT}": "security_desc". The endpoint has 2 fields: record_date, security_description.`,
          { reason: 'invalid_field', endpoint: RATES_ENDPOINT },
        );
        useListingFailure(drift);
        const ctx = createMockContext({ errors: getInterestRatesTool.errors });

        const error = await Promise.resolve(
          getInterestRatesTool.handler(getInterestRatesTool.input.parse(NOPE), ctx),
        ).catch((err: unknown) => err);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.InternalError,
          message: drift.message,
          data: { reason: 'upstream_schema_changed', endpoint: RATES_ENDPOINT },
          cause: drift,
        });
      });
    });
  });

  it('maps security_type_desc to security_type in output', async () => {
    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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
        labels: RATES_LABELS,
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

    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBe('df_RATES_00001');
      expect(result.canvas_expires_at).toBe('2026-06-02T00:00:00.000Z');
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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(
        seriesInput({ canvas_id: 'stage-it' }),
        ctx,
      );

      expect(result.canvas_id).toBe('df_RATES_00002');
      expect(String(getEnrichment(ctx).notice)).toContain('df_RATES_00002');
    });

    it('explains the absent canvas_id when staging was triggered but unavailable', async () => {
      useBigSeries();
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('could not be staged');
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    });

    it('stays silent when staging was never in play', async () => {
      useBigSeries(3);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('leaves the empty-result guidance as the only notice', async () => {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeRatesEnvelope([])),
      } as unknown as ReturnType<typeof getFiscalDataService>);
      useBridge('df_RATES_00003', 0);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      const result = await getInterestRatesTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(result.rates).toHaveLength(20);
      expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 20, cap: 20 });
    });

    it('names the missing canvas rather than telling the caller to pass canvas_id', async () => {
      useSeries(monthlyRows(40), 4993);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(notice).toContain('120 retrieved rows');
      expect(notice).not.toContain('Pass canvas_id');
    });

    it('offers canvas_id when staging was never attempted', async () => {
      useSeries(monthlyRows(40), 120);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

      await getInterestRatesTool.handler(seriesInput(), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Pass canvas_id');
      expect(notice).not.toContain('could not be staged');
    });

    it('caps and names the table when a canvas did absorb the rest', async () => {
      useSeries(monthlyRows(40), 4993);
      useBridge('df_RATES_CAPPD', 120);
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
      const ctx = createMockContext({ errors: getInterestRatesTool.errors });

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
        labels: RATES_LABELS,
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

    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
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

  /**
   * `content[]` is read through a real Markdown parse and compared with the
   * values `structuredContent` carries — a client renders the text, so the
   * rendered value is the one that has to match.
   */
  describe('content[] read-back', () => {
    type Result = Parameters<NonNullable<typeof getInterestRatesTool.format>>[0];
    type Rate = Result['rates'][number];

    function render(rates: Rate[]): string {
      return contentText(
        getInterestRatesTool.format!({
          as_of_date: rates[0]?.record_date ?? '',
          rates,
          total_records: rates.length,
        }),
      );
    }

    const benign: Rate[] = SAMPLE_ROWS.map((r) => ({
      record_date: r.record_date,
      security_type: r.security_type_desc,
      security_desc: r.security_desc,
      avg_interest_rate_pct: r.avg_interest_rate_amt,
    }));

    it('reads every rate cell back as the row value, in its own column', () => {
      const [table] = readTables(render(benign));

      expect(table?.rows).toEqual(
        benign.map((r) => [
          r.record_date,
          r.security_type,
          r.security_desc,
          `${r.avg_interest_rate_pct}%`,
        ]),
      );
    });

    it('reads the as-of date back after its label', () => {
      expect(readParagraphs(render(benign))[0]).toContain(
        `As of:⟦strong_close⟧ ${benign[0]?.record_date}`,
      );
    });

    const hostile: Rate[] = [
      {
        record_date: `${HOSTILE_VALUE} date`,
        security_type: `${HOSTILE_VALUE} type`,
        security_desc: `${HOSTILE_VALUE} desc`,
        avg_interest_rate_pct: `${HOSTILE_VALUE} rate`,
      },
    ];

    it('reads hostile rate cells back exactly, each in its own column', () => {
      const [table] = readTables(render(hostile));
      const [r] = hostile;

      expect(table?.rows).toEqual([
        [r?.record_date, r?.security_type, r?.security_desc, `${r?.avg_interest_rate_pct}%`],
      ]);
    });

    /**
     * The API reports a value it does not have as the string "null", and
     * structuredContent carries that string as is — so content[] renders it as
     * the bare word, since a percent sign after it states a rate of "null".
     */
    it('reads the upstream "null" sentinel back in every cell as structuredContent carries it', async () => {
      const nullRow: RateRow = {
        record_date: '2026-07-31',
        security_type_desc: 'null',
        security_desc: 'null',
        avg_interest_rate_amt: 'null',
      };
      useService(makeRatesEnvelope([nullRow]));

      const result = await runToolContract(getInterestRatesTool, { mode: 'latest' });
      const payload = result.structuredContent as Result;

      expect(payload.rates).toEqual([
        {
          record_date: '2026-07-31',
          security_type: 'null',
          security_desc: 'null',
          avg_interest_rate_pct: 'null',
        },
      ]);
      expect(readTables(contentText(result.content))[0]?.rows).toEqual([
        ['2026-07-31', 'null', 'null', 'null'],
      ]);
    });

    it('reads a hostile as-of date back exactly after its label', () => {
      expect(readParagraphs(render(hostile))[0]).toContain(
        `As of:⟦strong_close⟧ ${hostile[0]?.record_date}\n`,
      );
    });

    it('reads the notice back as structuredContent carries it, caller and upstream text included', async () => {
      const securityType = `${HOSTILE_VALUE} type`;
      const upstreamDesc = `${HOSTILE_VALUE} upstream`;
      useServiceSequence([
        makeRatesEnvelope([]),
        makeRatesEnvelope([
          {
            record_date: '2026-07-31',
            security_type_desc: 'Marketable',
            security_desc: upstreamDesc,
            avg_interest_rate_amt: '3.500',
          },
        ]),
      ]);

      const result = await runToolContract(getInterestRatesTool, {
        mode: 'latest',
        security_type: securityType,
      });
      const notice = (result.structuredContent as { notice: string }).notice;

      expect(notice).toContain(securityType.trim());
      expect(notice).toContain(upstreamDesc);
      expect(readBlockquotes(contentText(result.content))).toEqual([notice]);
    });
  });
});

/**
 * The service module is mocked above; this block puts the real service back
 * behind the accessor and stubs only `fetch`, so the empty-result guidance's
 * follow-up requests run through the service's own timers and the one 50 s
 * budget the main fetch began.
 */
describe('empty-result guidance through the real service, under one fetch budget', () => {
  const BUDGET_MS = 50_000;
  const emptyAfter = (delayMs: number) => delayed(delayMs, () => jsonOk(ratesBody([])));

  /** The four requests the empty-result path can send, told apart by their query. */
  type Request = 'main' | 'newest' | 'oldest' | 'listing';
  function requestOf(url: URL): Request {
    if (url.searchParams.get('page[size]') === '1') {
      return url.searchParams.get('sort') === 'record_date' ? 'oldest' : 'newest';
    }
    return url.searchParams.has('filter') ? 'main' : 'listing';
  }

  /** Stub `fetch` with one answer per request kind; hand back the spy. */
  function serve(answers: Record<Request, Answer>) {
    const fetchMock = vi.fn(
      (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        answers[requestOf(new URL(String(request)))](init),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** Start the call, then show it unsettled 1 ms before the budget and settled on it. */
  async function settlesAtBudget(
    input: z.input<typeof getInterestRatesTool.input>,
    fetchMock: Mock,
    requests: number,
  ) {
    let settled = false;
    const pending = runToolContract(getInterestRatesTool, input).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    return await pending;
  }

  const SERIES_INPUT = {
    mode: 'series',
    security_type: 'Treasury Nopes',
    start_date: '2024-01-01',
  } as const;

  beforeEach(async () => {
    vi.useFakeTimers();
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * The span probes decide which guidance applies, so a stalled one still fails
   * the call — on the budget the main fetch began. A budget per request would
   * let a probe run its own 50 s after the main fetch answered, past the
   * client's 60 s cutoff. In the second case the newest-first probe answers, so
   * only the oldest-first probe's own budget can hold the call open.
   */
  it.each<[string, Record<Request, Answer>, number]>([
    [
      'the main fetch matches nothing after 25 s and both span probes stall',
      { main: emptyAfter(25_000), newest: hang, oldest: hang, listing: hang },
      3,
    ],
    [
      'the main fetch matches nothing after 10 s, the newest-first probe answers after 26 s, and the oldest-first probe stalls',
      { main: emptyAfter(10_000), newest: emptyAfter(26_000), oldest: hang, listing: hang },
      // The stalled probe's 30 s request timer fires once (at 40 s) and its retry stalls too.
      4,
    ],
  ])('settles at 50 s when %s', async (_label, answers, requests) => {
    const fetchMock = serve(answers);

    const result = await settlesAtBudget(SERIES_INPUT, fetchMock, requests);

    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: { reason?: string } };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(contentText(result.content)).toContain(error.message);
  });

  /**
   * The current-month listing is the last request and adds only the names on
   * offer; the empty answer and the verdict on the name are already in hand
   * when it stalls. The call settles on the same budget, with the answer.
   */
  it.each<[string, z.input<typeof getInterestRatesTool.input>, Record<Request, Answer>, number]>([
    [
      'mode=latest matches nothing after 29 s and the listing would answer after 22 s',
      { mode: 'latest', security_type: 'Nope Bills' },
      {
        main: emptyAfter(29_000),
        newest: hang,
        oldest: hang,
        listing: delayed(22_000, () => jsonOk(ratesBody([]))),
      },
      2,
    ],
    [
      'the main fetch and span probes match nothing after 10 s and 15 s and the listing stalls',
      SERIES_INPUT,
      {
        main: emptyAfter(10_000),
        newest: emptyAfter(15_000),
        oldest: emptyAfter(15_000),
        listing: hang,
      },
      4,
    ],
  ])('answers at 50 s, without the listing, when %s', async (_label, input, answers, requests) => {
    const fetchMock = serve(answers);

    const result = await settlesAtBudget(input, fetchMock, requests);

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      as_of_date: string;
      rates: unknown[];
      total_records: number;
      notice: string;
    };
    expect(payload).toMatchObject({ as_of_date: '', rates: [], total_records: 0 });
    expect(payload.notice).toContain(`security_type="${input.security_type}"`);
    expect(payload.notice).toContain('no record in this dataset carries that name');
    expect(payload.notice).toContain('could not be fetched');
    expect(payload.notice).toContain('time budget');
    expect(readBlockquotes(contentText(result.content))).toEqual([payload.notice]);
  });
});

/**
 * Every field name this tool sends — in `fields`, a filter, or `sort` — is
 * fixed in its source, so an unknown-field rejection is the API's schema moving
 * under it. The real service runs behind a stubbed `fetch`: any request
 * carrying a query 404s, and the bare probe that classifies it lists the
 * fields the endpoint has now.
 */
describe('a field the API dropped, through the real service', () => {
  /** The endpoint after a rename: security_desc is gone. */
  const CURRENT_FIELDS = [
    'record_date',
    'security_type_desc',
    'security_description',
    'avg_interest_rate_amt',
  ];
  const HINT = `Query ${RATES_ENDPOINT} with treasury_query_dataset; omit fields to see the fields it has now.`;

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
    vi.stubGlobal(
      'fetch',
      vi.fn((request: Parameters<typeof fetch>[0]) => {
        const params = new URL(String(request)).searchParams;
        return Promise.resolve(
          params.has('filter') || params.has('sort') ? notFoundText() : labelsOk(CURRENT_FIELDS),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, z.input<typeof getInterestRatesTool.input>]>([
    ['mode=latest', { mode: 'latest', security_type: 'Treasury Bills' }],
    ['mode=series', { mode: 'series', security_type: 'Treasury Bills', start_date: '2024-01-31' }],
  ])('reports upstream_schema_changed in %s', async (_label, input) => {
    const result = await runToolContract(getInterestRatesTool, input);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: {
        reason: 'upstream_schema_changed',
        endpoint: RATES_ENDPOINT,
        recovery: { hint: HINT },
      },
    });
    expect(error.message).toContain('"security_desc"');
    expect(error.message).toContain(RATES_ENDPOINT);
    expect(error.message).toContain(CURRENT_FIELDS.join(', '));

    const paragraphs = readParagraphs(contentText(result.content));
    expect(paragraphs).toContain(`Error: ${error.message}`);
    expect(paragraphs).toContain(`Recovery: ${HINT}`);
  });
});

/**
 * The API reads a comma in a filter value as the start of another condition,
 * so the service refuses such a value before any request. The caller wrote no
 * filter, only security_type and dates, so the refusal names the input and the
 * value it carried. A comma followed by a valid condition is the case that
 * matters most: the API would have answered it with a narrower match.
 */
describe('a comma in an input, through the real service', () => {
  const HINT =
    'Send security_type as one exact security_desc name and start_date/end_date as plain YYYY-MM-DD dates; no filter value can carry a comma. Omit security_type to see the names on offer.';
  let fetchMock: Mock;

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
    fetchMock = vi.fn(() => Promise.resolve(jsonOk(ratesBody([]))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, string, z.input<typeof getInterestRatesTool.input>]>([
    [
      'security_type',
      'Treasury Bills,record_date:gte:2026-01-01',
      { mode: 'latest', security_type: 'Treasury Bills,record_date:gte:2026-01-01' },
    ],
    ['start_date', '2026-01-01,x:eq:1', { mode: 'series', start_date: '2026-01-01,x:eq:1' }],
    [
      'end_date',
      '2026-04-30,x:eq:1',
      { mode: 'series', start_date: '2026-01-01', end_date: '2026-04-30,x:eq:1' },
    ],
  ])('refuses a comma in %s before any request, naming it', async (param, value, input) => {
    const result = await runToolContract(getInterestRatesTool, input);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: `${param} value "${value}" contains a comma, so the call was refused before any request: the API reads a comma inside a filter value as the start of another condition.`,
      data: {
        reason: 'invalid_filter',
        endpoint: RATES_ENDPOINT,
        input: param,
        value,
        recovery: { hint: HINT },
      },
    });
    expect(error.data).not.toHaveProperty('field');
    const paragraphs = readParagraphs(contentText(result.content));
    expect(paragraphs).toContain(`Error: ${error.message}`);
    expect(paragraphs).toContain(`Recovery: ${HINT}`);
  });

  it("carries the service's refusal as the cause", async () => {
    const ctx = createMockContext({ errors: getInterestRatesTool.errors });
    const input = getInterestRatesTool.input.parse({
      mode: 'latest',
      security_type: 'Treasury Bills,record_date:gte:2026-01-01',
    });

    const error = await Promise.resolve(getInterestRatesTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      data: { reason: 'invalid_filter', input: 'security_type' },
      cause: {
        data: {
          reason: 'invalid_filter',
          field: 'security_desc',
          value: 'Treasury Bills,record_date:gte:2026-01-01',
        },
      },
    });
  });
});

/**
 * A 200 is checked too. A request that selects no fields gets every field the
 * endpoint has in `meta.labels`, so each field this tool reads from a row has
 * to be there; a request that selects some gets labels for those alone, so
 * only they are checked.
 */
describe('a 200 that no longer lists a field this tool reads, through the real service', () => {
  const HINT = `Query ${RATES_ENDPOINT} with treasury_query_dataset; omit fields to see the fields it has now.`;
  const ROW: RateRow = {
    record_date: '2026-04-30',
    security_type_desc: 'Marketable',
    security_desc: 'Treasury Bills',
    avg_interest_rate_amt: '4.2',
  };

  /** The API's answer to `url`: labels for the selected fields, or for every field when none is selected. */
  function answerFor(url: URL, rows: RateRow[], allLabels: Record<string, string>) {
    const selected = url.searchParams.get('fields')?.split(',');
    const labels = selected
      ? Object.fromEntries(selected.map((f) => [f, `Label for ${f}`]))
      : allLabels;
    const projected = rows.map((r) =>
      selected ? Object.fromEntries(selected.map((f) => [f, r[f as keyof RateRow]])) : { ...r },
    );
    const body = JSON.parse(envelopeBody(projected)) as FiscalDataEnvelope;
    return jsonOk(JSON.stringify({ ...body, meta: { ...body.meta, labels } }));
  }

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports upstream_schema_changed when avg_interest_rate_amt is gone', async () => {
    const { avg_interest_rate_amt: _gone, ...remaining } = RATES_LABELS;
    vi.stubGlobal(
      'fetch',
      vi.fn((request: Parameters<typeof fetch>[0]) =>
        Promise.resolve(answerFor(new URL(String(request)), [ROW], remaining)),
      ),
    );

    const result = await runToolContract(getInterestRatesTool, { mode: 'latest' });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: `Field "avg_interest_rate_amt" this tool reads is gone from endpoint "${RATES_ENDPOINT}". The response lists 4 fields: record_date, security_type_desc, security_desc, src_line_nbr.`,
      data: {
        reason: 'upstream_schema_changed',
        endpoint: RATES_ENDPOINT,
        recovery: { hint: HINT },
      },
    });
    const paragraphs = readParagraphs(contentText(result.content));
    expect(paragraphs).toContain(`Error: ${error.message}`);
    expect(paragraphs).toContain(`Recovery: ${HINT}`);
  });

  /**
   * The span probes select record_date alone, so their labels carry nothing
   * else; reading them against every field the tool reads would fail every
   * empty-result call.
   */
  it('checks a request that selects fields against those fields alone', async () => {
    const fetchMock = vi.fn((request: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(request));
      return Promise.resolve(
        answerFor(url, url.searchParams.has('fields') ? [ROW] : [], RATES_LABELS),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runToolContract(getInterestRatesTool, {
      mode: 'series',
      security_type: 'Treasury Bills',
      start_date: '2030-01-01',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total_records: 0, rates: [] });
    const selections = fetchMock.mock.calls.map(([request]) =>
      new URL(String(request)).searchParams.get('fields'),
    );
    expect(selections).toContain('record_date');
  });
});
