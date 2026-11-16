/**
 * @fileoverview Tests for treasury_get_debt tool.
 * @module tests/tools/get-debt.tool.test
 */

import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';
import {
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
  readParagraphs,
  readTables,
} from '../helpers/markdown-read-back.js';

vi.mock('@/services/fiscal-data/fiscal-data-service.js', () => ({
  getFiscalDataService: vi.fn(),
  initFiscalDataService: vi.fn(),
}));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn().mockReturnValue(undefined),
  initCanvasBridge: vi.fn(),
  maybeRegisterDataframe: vi.fn().mockResolvedValue({}),
}));

import { getDebtTool } from '@/mcp-server/tools/definitions/get-debt.tool.js';
import { maybeRegisterDataframe } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const DEBT_ENDPOINT = '/v2/accounting/od/debt_to_penny';
/** Upstream page size the series fetch requests — the API's documented ceiling. */
const SERIES_PAGE_SIZE = 10_000;
/** Rows the series fetch stops at across all pages. */
const SERIES_MAX_ROWS = 50_000;
/** Series rows returned inline. */
const SERIES_PREVIEW_LIMIT = 20;
/** The fields every debt request selects, and so the labels every answer carries. */
const DEBT_FIELDS = [
  'record_date',
  'tot_pub_debt_out_amt',
  'debt_held_public_amt',
  'intragov_hold_amt',
];
const DEBT_LABELS = labelsFor(DEBT_FIELDS);

/** A response body as the API sends it: `meta.labels` keyed by every selected field. */
function debtBody(rows: Record<string, string>[], totalCount = rows.length): string {
  return envelopeBody(rows, totalCount, DEBT_FIELDS);
}

function makeDebtEnvelope(
  rows: {
    record_date: string;
    tot_pub_debt_out_amt: string;
    debt_held_public_amt: string;
    intragov_hold_amt: string;
  }[],
  totalCount = rows.length,
): FiscalDataEnvelope {
  return {
    data: rows as Record<string, string>[],
    meta: {
      count: rows.length,
      labels: DEBT_LABELS,
      dataTypes: { record_date: 'DATE', tot_pub_debt_out_amt: 'CURRENCY' },
      dataFormats: {},
      'total-count': totalCount,
      'total-pages': Math.max(1, Math.ceil(totalCount / SERIES_PAGE_SIZE)),
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

/** Descending daily records — `index` is globally unique across pages. */
function makeRows(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    ...SAMPLE_ROW,
    record_date: new Date(Date.UTC(2026, 7, 11) - (startIndex + i) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    tot_pub_debt_out_amt: `${39_180_000_000_000 - (startIndex + i)}.00`,
  }));
}

/**
 * A fetchPage that serves `totalCount` records in SERIES_PAGE_SIZE-sized pages.
 * A page past the end rejects as the service does: the API answers it with the
 * 404 every rejected query gets, never an empty 200. Page 1 of an empty match
 * is the one empty answer.
 */
function pagedFetchPage(totalCount: number) {
  return vi.fn(
    (_ctx: unknown, _endpoint: string, opts: { pageSize?: number; pageNumber?: number }) => {
      const pageNumber = opts.pageNumber ?? 1;
      const pageSize = opts.pageSize ?? 100;
      const startIndex = (pageNumber - 1) * pageSize;
      if (pageNumber > 1 && startIndex >= totalCount) {
        return Promise.reject(
          validationError(
            `Page ${pageNumber} is past the last page of this query's results on endpoint "${DEBT_ENDPOINT}".`,
            { reason: 'page_out_of_range', endpoint: DEBT_ENDPOINT },
          ),
        );
      }
      const remaining = Math.max(0, totalCount - startIndex);
      return Promise.resolve(
        makeDebtEnvelope(makeRows(Math.min(pageSize, remaining), startIndex), totalCount),
      );
    },
  );
}

function useSeries(totalCount: number) {
  const fetchPage = pagedFetchPage(totalCount);
  vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
    typeof getFiscalDataService
  >);
  return fetchPage;
}

function seriesInput(extra: Record<string, unknown> = {}) {
  return getDebtTool.input.parse({
    mode: 'series',
    start_date: '1993-04-01',
    end_date: '2026-08-11',
    ...extra,
  });
}

/** The selection a recorded fetchPage call asked for. */
type PageOpts = { fields?: string[]; sort?: string };

/** The first debt record, whose held-by-public and intragovernmental split upstream reports as "null". */
const FIRST_RECORD = {
  record_date: '1993-04-01',
  tot_pub_debt_out_amt: '4225873987843.44',
  debt_held_public_amt: 'null',
  intragov_hold_amt: 'null',
};

describe('getDebtTool', () => {
  beforeEach(() => {
    vi.mocked(maybeRegisterDataframe).mockReset().mockResolvedValue({});
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([SAMPLE_ROW])),
    } as unknown as ReturnType<typeof getFiscalDataService>);
  });

  it('returns latest debt record', async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'latest' });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.record_date).toBe('2026-05-28');
    expect(result.total_debt).toBe('39180000000000.00');
    expect(result.debt_held_public).toBe('28500000000000.00');
    expect(result.intragovernmental_holdings).toBe('6780000000000.00');
  });

  it('returns debt record for a specific date', async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date', date: '2026-05-28' });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.record_date).toBe('2026-05-28');
    expect(result.total_debt).toBeDefined();
  });

  it('throws no_data_for_date when mode=date and date is missing', async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date' });
    await expect(getDebtTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_date' },
    });
  });

  it('treats a whitespace-only date as missing and sends no request', async () => {
    const fetchPage = vi.fn();
    vi.mocked(getFiscalDataService).mockReturnValue({ fetchPage } as unknown as ReturnType<
      typeof getFiscalDataService
    >);
    const ctx = createMockContext({ errors: getDebtTool.errors });

    await expect(
      getDebtTool.handler(getDebtTool.input.parse({ mode: 'date', date: ' \t ' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_data_for_date',
        recovery: { hint: expect.stringContaining('mode=latest') },
      },
    });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('asks for the missing date instead of explaining business days', async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date' });
    const error = (await Promise.resolve(getDebtTool.handler(input, ctx)).catch(
      (err: unknown) => err,
    )) as {
      data: { recovery?: { hint?: string } };
    };

    const hint = String(error.data.recovery?.hint);
    expect(hint).toContain('date');
    expect(hint).toContain('mode=latest');
    expect(hint).not.toContain('business day');
  });

  it('keeps the business-day guidance when a date was supplied but has no record', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date', date: '2026-01-03' });
    const error = (await Promise.resolve(getDebtTool.handler(input, ctx)).catch(
      (err: unknown) => err,
    )) as {
      data: { date?: string; recovery?: { hint?: string } };
    };

    expect(String(error.data.recovery?.hint)).toContain('business day');
    expect(error.data.date).toBe('2026-01-03');
  });

  it('throws no_data_for_date when API returns empty results for mode=latest', async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope([])),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'latest' });
    await expect(getDebtTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
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
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_date', date: '2026-01-01' },
    });
  });

  it.each<[string, Record<string, string>, string[]]>([
    ['a whitespace-only start_date', { start_date: '  ', end_date: '2026-08-11' }, ['lte']],
    ['a whitespace-only end_date', { start_date: '1993-04-01', end_date: '\t' }, ['gte']],
    ['both bounds whitespace-only', { start_date: ' ', end_date: ' ' }, []],
  ])('sends only the supplied bounds for %s', async (_label, bounds, operators) => {
    const fetchPage = useSeries(5);
    const ctx = createMockContext({ errors: getDebtTool.errors });

    await getDebtTool.handler(getDebtTool.input.parse({ mode: 'series', ...bounds }), ctx);

    const opts = fetchPage.mock.calls[0]?.[2] as { filters?: { operator: string }[] } | undefined;
    expect((opts?.filters ?? []).map((f) => f.operator)).toEqual(operators);
  });

  it('lists every sort term in the fields of each request it sends', async () => {
    const fetchPage = useSeries(25_000);
    const ctx = createMockContext({ errors: getDebtTool.errors });

    await getDebtTool.handler(getDebtTool.input.parse({ mode: 'latest' }), ctx);
    await getDebtTool.handler(getDebtTool.input.parse({ mode: 'date', date: '2026-08-11' }), ctx);
    await getDebtTool.handler(seriesInput(), ctx);

    expect(fetchPage).toHaveBeenCalledTimes(5);
    expect(fetchPage.mock.calls.every((call) => (call[2] as PageOpts).fields?.length)).toBe(true);
    expect(unselectedSortTerms(fetchPage.mock.calls)).toEqual([]);
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

    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({
      mode: 'series',
      start_date: '2026-05-27',
      end_date: '2026-05-28',
    });
    const result = await getDebtTool.handler(input, ctx);

    expect(result.series).toBeDefined();
    expect(result.total_records).toBe(2);
  });

  describe('series paging', () => {
    it('requests one page when the matched set fits in it', async () => {
      const fetchPage = useSeries(8369);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.total_records).toBe(8369);
      expect(result.retrieved_records).toBe(8369);
    });

    it('walks every page of a matched set larger than one page', async () => {
      const fetchPage = useSeries(25_000);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'df_ABCDE_FGHIJ' }), ctx);

      expect(fetchPage).toHaveBeenCalledTimes(3);
      expect(fetchPage.mock.calls.map((call) => call[2].pageNumber)).toEqual([1, 2, 3]);
      for (const call of fetchPage.mock.calls) {
        expect(call[2].pageSize).toBe(SERIES_PAGE_SIZE);
      }
      expect(result.retrieved_records).toBe(25_000);
      expect(result.total_records).toBe(25_000);

      // Rows past the first page must reach the staged set, not just the count.
      const staged = vi.mocked(maybeRegisterDataframe).mock.calls[0]?.[2] ?? [];
      expect(staged).toHaveLength(25_000);
      expect(staged.at(SERIES_PAGE_SIZE)).toEqual(makeRows(1, SERIES_PAGE_SIZE)[0]);
      expect(staged.at(-1)).toEqual(makeRows(1, 24_999)[0]);
    });

    it('stops at the row bound and reports what it actually retrieved', async () => {
      const fetchPage = useSeries(120_000);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'df_ABCDE_FGHIJ' }), ctx);

      expect(fetchPage).toHaveBeenCalledTimes(SERIES_MAX_ROWS / SERIES_PAGE_SIZE);
      expect(result.total_records).toBe(120_000);
      expect(result.retrieved_records).toBe(SERIES_MAX_ROWS);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain(String(SERIES_MAX_ROWS));
      expect(notice).toContain('120000');

      // The staged dataframe must not claim the rows it never fetched.
      const options = vi.mocked(maybeRegisterDataframe).mock.calls[0]?.[3];
      expect(options?.rows).toHaveLength(SERIES_MAX_ROWS);
      expect(options?.truncated).toBe(true);
      expect(options?.maxRows).toBe(SERIES_MAX_ROWS);
    });

    /**
     * A match that fills its last page exactly leaves nothing past it, and the
     * API answers a page past the end with a 404, not an empty page — so the
     * walk has to stop on the count it already holds rather than ask.
     */
    it.each([
      [SERIES_PAGE_SIZE, 1],
      [2 * SERIES_PAGE_SIZE, 2],
    ])('sends no past-end request when %i matches fill whole pages', async (total, pages) => {
      const fetchPage = useSeries(total);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'df_ABCDE_FGHIJ' }), ctx);

      expect(fetchPage).toHaveBeenCalledTimes(pages);
      expect(result.retrieved_records).toBe(total);
      expect(result.total_records).toBe(total);
      expect(vi.mocked(maybeRegisterDataframe).mock.calls[0]?.[2]).toHaveLength(total);
    });

    it('marks a fully-retrieved staged dataframe as untruncated', async () => {
      useSeries(25_000);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(seriesInput({ canvas_id: 'df_ABCDE_FGHIJ' }), ctx);

      expect(vi.mocked(maybeRegisterDataframe).mock.calls[0]?.[3]).toMatchObject({
        truncated: false,
      });
    });

    it('leaves latest and date modes on a single unpaged request', async () => {
      const fetchPage = useSeries(8369);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(getDebtTool.input.parse({ mode: 'latest' }), ctx);
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(fetchPage.mock.calls[0]?.[2].pageSize).toBe(1);

      fetchPage.mockClear();
      await getDebtTool.handler(getDebtTool.input.parse({ mode: 'date', date: '2026-08-11' }), ctx);
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(fetchPage.mock.calls[0]?.[2].pageNumber).toBeUndefined();
    });
  });

  describe('series preview disclosure', () => {
    it('discloses that the inline series is a preview when no canvas is registered', async () => {
      useSeries(100);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(result.series).toHaveLength(SERIES_PREVIEW_LIMIT);
      expect(result.retrieved_records).toBe(100);
      expect(getEnrichment(ctx)).toMatchObject({
        truncated: true,
        shown: SERIES_PREVIEW_LIMIT,
        cap: SERIES_PREVIEW_LIMIT,
      });
      expect(String(getEnrichment(ctx).notice)).toContain('20 of 100');
    });

    it('offers canvas_id only when no staging was attempted', async () => {
      useSeries(100);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(seriesInput(), ctx);

      expect(String(getEnrichment(ctx).notice)).toContain('Pass canvas_id');
    });

    it('does not tell a caller who passed canvas_id to pass canvas_id', async () => {
      useSeries(100);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'df_ABCDE_FGHIJ' }), ctx);

      // Staging was requested and came back empty — the canvas is not available.
      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).not.toContain('Pass canvas_id');
      expect(notice).toContain('start_date');
    });

    it('does not offer canvas_id when the auto-spill threshold already tried it', async () => {
      useSeries(5000);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBeUndefined();
      expect(String(getEnrichment(ctx).notice)).not.toContain('Pass canvas_id');
    });

    it('points at the canvas table when the full set was staged', async () => {
      useSeries(5000);
      vi.mocked(maybeRegisterDataframe).mockResolvedValue({
        canvasId: 'df_ABCDE_FGHIJ',
        canvasExpiresAt: '2026-08-12T00:00:00.000Z',
      });
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(result.canvas_id).toBe('df_ABCDE_FGHIJ');
      expect(result.series).toHaveLength(SERIES_PREVIEW_LIMIT);
      expect(String(getEnrichment(ctx).notice)).toContain('df_ABCDE_FGHIJ');
    });

    it('names both dataframe tools alongside the staged table', async () => {
      useSeries(5000);
      vi.mocked(maybeRegisterDataframe).mockResolvedValue({
        canvasId: 'df_ABCDE_FGHIJ',
        canvasExpiresAt: '2026-08-12T00:00:00.000Z',
      });
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(seriesInput(), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('treasury_dataframe_describe');
      expect(notice).toContain('treasury_dataframe_query');
      expect(notice.indexOf('treasury_dataframe_describe')).toBeLessThan(
        notice.indexOf('treasury_dataframe_query'),
      );
    });

    it('discloses staging even when the whole series fit inline', async () => {
      useSeries(5);
      vi.mocked(maybeRegisterDataframe).mockResolvedValue({
        canvasId: 'df_SHORT_SERIE',
        canvasExpiresAt: '2026-08-12T00:00:00.000Z',
      });
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      expect(result.series).toHaveLength(5);
      expect(result.canvas_id).toBe('df_SHORT_SERIE');
      expect(String(getEnrichment(ctx).notice)).toContain('df_SHORT_SERIE');
    });

    it('says the canvas is unavailable when a short series was asked to stage', async () => {
      useSeries(5);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      expect(result.canvas_id).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(notice).not.toContain('Pass canvas_id');
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
    });

    it('does not claim truncation when the staged series was returned in full', async () => {
      useSeries(5);
      vi.mocked(maybeRegisterDataframe).mockResolvedValue({
        canvasId: 'df_SHORT_SERIE',
        canvasExpiresAt: '2026-08-12T00:00:00.000Z',
      });
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(seriesInput({ canvas_id: 'stage-it' }), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).not.toHaveProperty('truncated');
      expect(enrichment).not.toHaveProperty('shown');
      expect(enrichment).not.toHaveProperty('cap');
    });

    it('stays silent when the whole series fits inline', async () => {
      useSeries(5);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(result.series).toHaveLength(5);
      expect(result.retrieved_records).toBe(5);
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('stays silent at exactly the preview cap', async () => {
      useSeries(SERIES_PREVIEW_LIMIT);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(result.series).toHaveLength(SERIES_PREVIEW_LIMIT);
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
    });

    it('returns an empty series without a spurious disclosure', async () => {
      const fetchPage = useSeries(0);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      const result = await getDebtTool.handler(seriesInput(), ctx);

      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(result.series).toEqual([]);
      expect(result.total_records).toBe(0);
      expect(result.retrieved_records).toBe(0);
      expect(result.record_date).toBe('');
      expect(getEnrichment(ctx)).not.toHaveProperty('truncated');
      expect(maybeRegisterDataframe).not.toHaveBeenCalled();
    });

    it('says why an empty range came back empty', async () => {
      useSeries(0);
      const ctx = createMockContext({ errors: getDebtTool.errors });

      await getDebtTool.handler(seriesInput(), ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('business day');
      expect(notice).toContain('start_date');
    });

    it('renders an empty series as absence, not as a bare dollar sign', () => {
      const blocks = getDebtTool.format!({
        record_date: '',
        total_debt: '',
        debt_held_public: '',
        intragovernmental_holdings: '',
        series: [],
        total_records: 0,
        retrieved_records: 0,
      });
      const text = (blocks[0] as { text: string }).text;

      expect(text).not.toContain('$');
      expect(text).toContain('No debt record');
      expect(text).toContain('0 total records');
    });

    it('renders the preview cap in the formatted text', () => {
      const blocks = getDebtTool.format!({
        record_date: '2026-08-11',
        total_debt: '39180000000000.00',
        debt_held_public: '28500000000000.00',
        intragovernmental_holdings: '6780000000000.00',
        series: makeRows(SERIES_PREVIEW_LIMIT).map((r) => ({
          record_date: r.record_date,
          total_debt: r.tot_pub_debt_out_amt,
          debt_held_public: r.debt_held_public_amt,
          intragovernmental_holdings: r.intragov_hold_amt,
        })),
        total_records: 8369,
        retrieved_records: 8369,
      });
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('8369 total records');
      expect(text).toContain('showing 20 of 8369');
    });

    it('renders the retrieved span when paging stopped short of the match', () => {
      const blocks = getDebtTool.format!({
        record_date: '2026-08-11',
        total_debt: '39180000000000.00',
        debt_held_public: '28500000000000.00',
        intragovernmental_holdings: '6780000000000.00',
        series: [],
        total_records: 120_000,
        retrieved_records: SERIES_MAX_ROWS,
      });
      const text = (blocks[0] as { text: string }).text;

      expect(text).toContain('120000 total records');
      expect(text).toContain('50000');
    });

    it('renders no preview note when the series is complete', () => {
      const blocks = getDebtTool.format!({
        record_date: '2026-08-11',
        total_debt: '39180000000000.00',
        debt_held_public: '28500000000000.00',
        intragovernmental_holdings: '6780000000000.00',
        series: makeRows(3).map((r) => ({
          record_date: r.record_date,
          total_debt: r.tot_pub_debt_out_amt,
          debt_held_public: r.debt_held_public_amt,
          intragovernmental_holdings: r.intragov_hold_amt,
        })),
        total_records: 3,
        retrieved_records: 3,
      });
      const text = (blocks[0] as { text: string }).text;

      expect(text).not.toContain('showing');
    });
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

  /**
   * `content[]` is read through a real Markdown parse and compared with the
   * values `structuredContent` carries — a client renders the text, so the
   * rendered value is the one that has to match.
   */
  describe('content[] read-back', () => {
    type Result = Parameters<NonNullable<typeof getDebtTool.format>>[0];
    type SeriesRow = NonNullable<Result['series']>[number];

    function render(series: SeriesRow[]): string {
      const [latest] = series;
      return contentText(
        getDebtTool.format!({
          record_date: latest?.record_date ?? '',
          total_debt: latest?.total_debt ?? '',
          debt_held_public: latest?.debt_held_public ?? '',
          intragovernmental_holdings: latest?.intragovernmental_holdings ?? '',
          series,
          total_records: series.length,
          retrieved_records: series.length,
        }),
      );
    }

    const benign: SeriesRow[] = [
      {
        record_date: '2026-05-28',
        total_debt: '39180000000000.00',
        debt_held_public: '28500000000000.00',
        intragovernmental_holdings: '6780000000000.00',
      },
      {
        record_date: '2026-05-27',
        total_debt: '39170000000000.00',
        debt_held_public: '28490000000000.00',
        intragovernmental_holdings: '6770000000000.00',
      },
    ];

    it('reads every series cell back as the row value, in its own column', () => {
      const [table] = readTables(render(benign));

      expect(table?.rows).toEqual(
        benign.map((r) => [
          r.record_date,
          `$${r.total_debt}`,
          `$${r.debt_held_public}`,
          `$${r.intragovernmental_holdings}`,
        ]),
      );
    });

    it('reads the latest record back after its labels', () => {
      const [first] = readParagraphs(render(benign));
      const latest = benign[0]!;

      expect(first).toContain(`Record Date:⟦strong_close⟧ ${latest.record_date}`);
      expect(first).toContain(`Total Debt:⟦strong_close⟧ $${latest.total_debt}`);
      expect(first).toContain(`Debt Held by Public:⟦strong_close⟧ $${latest.debt_held_public}`);
      expect(first).toContain(
        `Intragovernmental Holdings:⟦strong_close⟧ $${latest.intragovernmental_holdings}`,
      );
    });

    const hostile: SeriesRow[] = [
      {
        record_date: `${HOSTILE_VALUE} date`,
        total_debt: `${HOSTILE_VALUE} total`,
        debt_held_public: `${HOSTILE_VALUE} public`,
        intragovernmental_holdings: `${HOSTILE_VALUE} intragov`,
      },
    ];

    it('reads hostile series cells back exactly, each in its own column', () => {
      const [table] = readTables(render(hostile));
      const [r] = hostile;

      expect(table?.rows).toEqual([
        [
          r?.record_date,
          `$${r?.total_debt}`,
          `$${r?.debt_held_public}`,
          `$${r?.intragovernmental_holdings}`,
        ],
      ]);
    });

    it('reads hostile values back exactly after their labels', () => {
      const [first] = readParagraphs(render(hostile));
      const [r] = hostile;

      expect(first).toContain(`Record Date:⟦strong_close⟧ ${r?.record_date}\n`);
      expect(first).toContain(`Total Debt:⟦strong_close⟧ $${r?.total_debt}\n`);
      expect(first).toContain(`Debt Held by Public:⟦strong_close⟧ $${r?.debt_held_public}\n`);
      expect(first).toContain(
        `Intragovernmental Holdings:⟦strong_close⟧ $${r?.intragovernmental_holdings}`,
      );
    });

    /**
     * The API reports an amount it does not have as the string "null" — the
     * first record, 1993-04-01, has no public/intragovernmental split.
     * structuredContent carries that string as is, so content[] renders it as
     * the bare word: a dollar sign in front of it states an amount of "null".
     */
    describe('the upstream "null" sentinel', () => {
      function useRows(rows: Record<string, string>[]) {
        vi.mocked(getFiscalDataService).mockReturnValue({
          fetchPage: vi.fn().mockResolvedValue(makeDebtEnvelope(rows as never)),
        } as unknown as ReturnType<typeof getFiscalDataService>);
      }

      it('reads a null amount back after its label as structuredContent carries it', async () => {
        useRows([FIRST_RECORD]);

        const result = await runToolContract(getDebtTool, { mode: 'date', date: '1993-04-01' });
        const payload = result.structuredContent as Result;

        expect(payload).toMatchObject({
          total_debt: '4225873987843.44',
          debt_held_public: 'null',
          intragovernmental_holdings: 'null',
        });
        expect(readParagraphs(contentText(result.content))[0]?.split('\n')).toEqual([
          `⟦strong_open⟧Record Date:⟦strong_close⟧ ${payload.record_date}`,
          `⟦strong_open⟧Total Debt:⟦strong_close⟧ $${payload.total_debt}`,
          `⟦strong_open⟧Debt Held by Public:⟦strong_close⟧ ${payload.debt_held_public}`,
          `⟦strong_open⟧Intragovernmental Holdings:⟦strong_close⟧ ${payload.intragovernmental_holdings}`,
        ]);
      });

      it('reads null series cells back as structuredContent carries them', async () => {
        const nextDay = { ...FIRST_RECORD, record_date: '1993-04-02' };
        useRows([nextDay, FIRST_RECORD]);

        const result = await runToolContract(getDebtTool, {
          mode: 'series',
          start_date: '1993-04-01',
          end_date: '1993-04-02',
        });
        const payload = result.structuredContent as Result;

        expect(payload.series?.map((r) => r.debt_held_public)).toEqual(['null', 'null']);
        expect(readTables(contentText(result.content))[0]?.rows).toEqual([
          ['1993-04-02', '$4225873987843.44', 'null', 'null'],
          ['1993-04-01', '$4225873987843.44', 'null', 'null'],
        ]);
      });
    });
  });
});

/**
 * The service module is mocked above; this block puts the real service back
 * behind the accessor and stubs only `fetch`, so the series walk's requests run
 * through the service's own timers and its one 50 s budget.
 */
describe('series paging through the real service, under one fetch budget', () => {
  const BUDGET_MS = 50_000;

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
   * Pages 1-3 each answer after 10 s with a full page of a 50,000-row match;
   * page 4 never answers. A budget per page would let page 4 run to 80 s, past
   * the client's 60 s cutoff.
   */
  it('settles at 50 s when the walk stalls on its fourth page', async () => {
    const fullPage = debtBody(makeRows(SERIES_PAGE_SIZE), SERIES_MAX_ROWS);
    const fetchMock = vi.fn(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        Number(new URL(String(input)).searchParams.get('page[number]')) <= 3
          ? delayed(10_000, () => jsonOk(fullPage))(init)
          : hang(init),
    );
    vi.stubGlobal('fetch', fetchMock);

    let settled = false;
    const pending = runToolContract(getDebtTool, {
      mode: 'series',
      start_date: '1993-04-01',
      end_date: '2026-08-11',
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const result = await pending;
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: { reason?: string } };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(contentText(result.content)).toContain(error.message);
  });
});

/**
 * Every field name this tool sends is fixed in its source, so an unknown-field
 * rejection is the API's schema moving under it. The real service runs behind
 * a stubbed `fetch`: the query 404s, and the bare probe that classifies it
 * lists the fields the endpoint has now.
 */
describe('a field the API dropped, through the real service', () => {
  /** The endpoint after a rename: debt_held_public_amt is gone. */
  const CURRENT_FIELDS = [
    'record_date',
    'tot_pub_debt_out_amt',
    'debt_public_amt',
    'intragov_hold_amt',
  ];
  const HINT = `Query ${DEBT_ENDPOINT} with treasury_query_dataset; omit fields to see the fields it has now.`;

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
    vi.stubGlobal(
      'fetch',
      vi.fn((request: Parameters<typeof fetch>[0]) =>
        Promise.resolve(
          new URL(String(request)).searchParams.has('fields')
            ? notFoundText()
            : labelsOk(CURRENT_FIELDS),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['latest', { mode: 'latest' }],
    ['date', { mode: 'date', date: '2026-08-11' }],
    ['series', { mode: 'series', start_date: '2026-01-02' }],
  ] as const)('reports upstream_schema_changed in mode=%s', async (_mode, input) => {
    const result = await runToolContract(getDebtTool, input);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: {
        reason: 'upstream_schema_changed',
        endpoint: DEBT_ENDPOINT,
        recovery: { hint: HINT },
      },
    });
    expect(error.message).toContain('"debt_held_public_amt"');
    expect(error.message).toContain(DEBT_ENDPOINT);
    expect(error.message).toContain(CURRENT_FIELDS.join(', '));

    const paragraphs = readParagraphs(contentText(result.content));
    expect(paragraphs).toContain(`Error: ${error.message}`);
    expect(paragraphs).toContain(`Recovery: ${HINT}`);
  });
});

/**
 * The API reads a comma inside a filter value as the start of another
 * condition, so the service refuses such a value before any request. The
 * caller wrote no filter — only dates — so the refusal names the date input and
 * the value it carried.
 */
describe('a comma in a date, through the real service', () => {
  let fetchMock: Mock;

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
    fetchMock = vi.fn(() => Promise.resolve(jsonOk(debtBody([SAMPLE_ROW]))));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const HINT =
    'Send date, start_date, and end_date as plain YYYY-MM-DD dates (e.g. 2026-05-28); no filter value can carry a comma.';

  it.each([
    ['date', '2026-05-28,x:eq:1', { mode: 'date', date: '2026-05-28,x:eq:1' }],
    ['start_date', '2026-05-01,x:eq:1', { mode: 'series', start_date: '2026-05-01,x:eq:1' }],
    [
      'end_date',
      '2026-05-31,1',
      { mode: 'series', start_date: '2026-05-01', end_date: '2026-05-31,1' },
    ],
  ] as const)(
    'refuses a comma in %s before any request, naming it',
    async (param, value, input) => {
      const result = await runToolContract(getDebtTool, input);

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
          endpoint: DEBT_ENDPOINT,
          input: param,
          value,
          recovery: { hint: HINT },
        },
      });
      expect(error.data).not.toHaveProperty('field');
      const paragraphs = readParagraphs(contentText(result.content));
      expect(paragraphs).toContain(`Error: ${error.message}`);
      expect(paragraphs).toContain(`Recovery: ${HINT}`);
    },
  );

  it("carries the service's refusal as the cause", async () => {
    const ctx = createMockContext({ errors: getDebtTool.errors });
    const input = getDebtTool.input.parse({ mode: 'date', date: '2026-05-28,x:eq:1' });

    const error = await Promise.resolve(getDebtTool.handler(input, ctx)).catch((e: unknown) => e);

    expect(error).toMatchObject({
      data: { reason: 'invalid_filter', input: 'date' },
      cause: {
        data: { reason: 'invalid_filter', field: 'record_date', value: '2026-05-28,x:eq:1' },
      },
    });
  });
});

/**
 * A 200 is checked too: every field this tool selects has to come back in
 * `meta.labels`, which the API sends on every answer, empty ones included. A
 * selected field missing from them is the schema moving under the tool, which
 * a row read would otherwise turn into an empty amount.
 */
describe('a 200 that no longer lists a field this tool reads, through the real service', () => {
  const HINT = `Query ${DEBT_ENDPOINT} with treasury_query_dataset; omit fields to see the fields it has now.`;

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'one selected field is missing',
      Object.fromEntries(Object.entries(DEBT_LABELS).filter(([f]) => f !== 'intragov_hold_amt')),
      `Field "intragov_hold_amt" this tool reads is gone from endpoint "${DEBT_ENDPOINT}". The response lists 3 fields: record_date, tot_pub_debt_out_amt, debt_held_public_amt.`,
    ],
    [
      'the response lists no fields',
      {},
      `Fields "record_date", "tot_pub_debt_out_amt", "debt_held_public_amt", "intragov_hold_amt" this tool reads are gone from endpoint "${DEBT_ENDPOINT}". The response lists no fields.`,
    ],
  ])('reports upstream_schema_changed when %s', async (_label, labels, message) => {
    const body = JSON.parse(envelopeBody([SAMPLE_ROW])) as FiscalDataEnvelope;
    const answer = JSON.stringify({ ...body, meta: { ...body.meta, labels } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonOk(answer))),
    );

    const result = await runToolContract(getDebtTool, { mode: 'latest' });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message,
      data: {
        reason: 'upstream_schema_changed',
        endpoint: DEBT_ENDPOINT,
        recovery: { hint: HINT },
      },
    });
    const paragraphs = readParagraphs(contentText(result.content));
    expect(paragraphs).toContain(`Error: ${error.message}`);
    expect(paragraphs).toContain(`Recovery: ${HINT}`);
  });
});
