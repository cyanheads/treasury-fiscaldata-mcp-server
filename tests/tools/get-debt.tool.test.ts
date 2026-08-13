/**
 * @fileoverview Tests for treasury_get_debt tool.
 * @module tests/tools/get-debt.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

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

/** Upstream page size the series fetch requests — the API's documented ceiling. */
const SERIES_PAGE_SIZE = 10_000;
/** Rows the series fetch stops at across all pages. */
const SERIES_MAX_ROWS = 50_000;
/** Series rows returned inline. */
const SERIES_PREVIEW_LIMIT = 20;

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
      labels: { record_date: 'Record Date', tot_pub_debt_out_amt: 'Total Debt' },
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

/** A fetchPage that serves `totalCount` records in SERIES_PAGE_SIZE-sized pages. */
function pagedFetchPage(totalCount: number) {
  return vi.fn(
    (_ctx: unknown, _endpoint: string, opts: { pageSize?: number; pageNumber?: number }) => {
      const pageSize = opts.pageSize ?? 100;
      const startIndex = ((opts.pageNumber ?? 1) - 1) * pageSize;
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
      data: { reason: 'no_data_for_date' },
    });
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
      data: { recovery?: { hint?: string } };
    };

    expect(String(error.data.recovery?.hint)).toContain('business day');
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
});
