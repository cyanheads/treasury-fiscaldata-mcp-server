/**
 * @fileoverview Tests for treasury_query_dataset tool.
 * @module tests/tools/query-dataset.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';
import {
  envelopeBody,
  hang,
  jsonOk,
  labelsOk,
  notFoundText,
  probeUrl,
} from '../helpers/fiscal-data-upstream.js';
import {
  contentText,
  HOSTILE_VALUE,
  readBlockquotes,
  readParagraphs,
  readTables,
} from '../helpers/markdown-read-back.js';

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

  it("returns the envelope's page count and field labels, and discloses the full match", async () => {
    vi.mocked(getFiscalDataService).mockReturnValue({
      fetchPage: vi
        .fn()
        .mockResolvedValue(
          makeEnvelope([{ record_date: '2026-05-01', tot_pub_debt_out_amt: '1.00' }], 250),
        ),
      buildFilterParam: vi.fn().mockReturnValue(''),
    } as unknown as ReturnType<typeof getFiscalDataService>);

    const ctx = createMockContext({ errors: queryDatasetTool.errors });
    const input = queryDatasetTool.input.parse({ endpoint: '/v2/accounting/od/debt_to_penny' });
    const result = await queryDatasetTool.handler(input, ctx);

    expect(result.total_count).toBe(250);
    expect(result.total_pages).toBe(3);
    expect(result.field_labels).toEqual({
      record_date: 'Record Date',
      tot_pub_debt_out_amt: 'Total Public Debt',
    });
    expect(getEnrichment(ctx).totalCount).toBe(250);
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

  /**
   * Each of these inputs has one clear reading, so the handler sends that
   * reading. Untrimmed, `sort: "record_date, -tot_pub_debt_out_amt"` failed as
   * an unknown field named `" -tot_pub_debt_out_amt"`, and the listed name a
   * caller copies back drops the "-" and flips the sort.
   */
  describe('input normalization', () => {
    const DEBT = '/v2/accounting/od/debt_to_penny';

    function useService() {
      const fetchPage = vi
        .fn()
        .mockResolvedValue(
          makeEnvelope([{ record_date: '2026-05-01', tot_pub_debt_out_amt: '1' }]),
        );
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage,
        buildFilterParam: vi.fn().mockReturnValue(''),
      } as unknown as ReturnType<typeof getFiscalDataService>);
      return fetchPage;
    }

    it('trims each field, filter field, and sort term, keeping each "-"', async () => {
      const fetchPage = useService();
      const registerDataframe = useBridge('df_QRYDS_00006');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: DEBT,
        fields: [' record_date ', 'tot_pub_debt_out_amt\t'],
        filters: [{ field: ' record_date', operator: 'gte', value: '2024-01-01' }],
        sort: 'record_date, -tot_pub_debt_out_amt ',
        canvas_id: 'stage-it',
      });
      await queryDatasetTool.handler(input, ctx);

      const normalized = {
        fields: ['record_date', 'tot_pub_debt_out_amt'],
        filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }],
        sort: 'record_date,-tot_pub_debt_out_amt',
      };
      expect(fetchPage).toHaveBeenCalledWith(ctx, DEBT, {
        pageSize: 100,
        pageNumber: 1,
        ...normalized,
      });
      // The staged table's provenance records the query that was sent.
      expect(registerDataframe).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({
          queryParams: { endpoint: DEBT, ...normalized, page_size: 100, page_number: 1 },
        }),
      );
    });

    it.each([
      ['without its leading slash', 'v2/accounting/od/debt_to_penny'],
      ['inside whitespace', '  /v2/accounting/od/debt_to_penny\n'],
      ['inside whitespace and without its leading slash', ' v2/accounting/od/debt_to_penny '],
    ])('reads an endpoint %s as the catalogued path', async (_label, endpoint) => {
      const fetchPage = useService();

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const result = await queryDatasetTool.handler(
        queryDatasetTool.input.parse({ endpoint }),
        ctx,
      );

      expect(fetchPage).toHaveBeenCalledWith(ctx, DEBT, expect.anything());
      expect(result.endpoint).toBe(DEBT);
      // The catalog check sees the normalized path, so it raises no off-catalog notice.
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });

    it('names the normalized path in a rerouted error', async () => {
      rejectWith(validationError('Endpoint does not exist.', { reason: 'invalid_endpoint' }));

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({ endpoint: ' v9/not/in/catalog' });

      await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_endpoint', endpoint: OFF_CATALOG_ENDPOINT },
      });
    });
  });

  it('throws invalid_endpoint when service throws (404)', async () => {
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

    const SERVICE_ERRORS = [
      ['invalid_endpoint', 'Endpoint does not exist.'],
      ['invalid_field', "Invalid field: Field 'nope' does not exist."],
      ['invalid_filter', "Invalid filter operator: Operator ':like:' is not supported."],
      ['page_out_of_range', 'Page out of range: Page #9999 is out of range.'],
      [
        'sort_field_not_selected',
        'Sort field "tot_pub_debt_out_amt" is not among the requested fields; the API sorts only by fields it returns.',
      ],
    ] as const;

    it.each(SERVICE_ERRORS)(
      'carries the declared recovery hint for %s',
      async (reason, message) => {
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
      },
    );

    it.each(SERVICE_ERRORS)(
      'chains the originating service error as the cause for %s',
      async (reason, message) => {
        const original = validationError(message, { reason });
        rejectWith(original);

        const ctx = createMockContext({ errors: queryDatasetTool.errors });
        const input = queryDatasetTool.input.parse({ endpoint: '/v1/bad/endpoint' });
        const caught = await Promise.resolve(queryDatasetTool.handler(input, ctx)).catch(
          (err: unknown) => err,
        );

        expect(caught).toMatchObject({ data: { reason } });
        expect((caught as Error).cause).toBe(original);
      },
    );

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

    it('declares the replace-the-name hint for invalid_field', () => {
      expect(declaredRecovery('invalid_field')).toBe(
        'Replace each unknown name with one of the field names this error lists for the endpoint.',
      );
    });

    it('keeps invalid_filter off field names, which fail as invalid_field instead', () => {
      expect(declaredRecovery('invalid_filter')).not.toMatch(/field name/i);
    });

    /**
     * `operator` is an enum on this tool's input, so the operator is the one
     * token of a filter that cannot be what the API refused.
     */
    /**
     * One hint covers both routes to invalid_filter: the service's refusal of a
     * comma inside a value, then an expression the API itself refused. The
     * operator is an enum here, so it is never the cause.
     */
    it('points invalid_filter at a comma first, then at finding the refused expression', () => {
      expect(declaredRecovery('invalid_filter')).toMatch(/^Remove any comma from filter values/);
      expect(declaredRecovery('invalid_filter')).toContain('one filter at a time');
      expect(declaredRecovery('invalid_filter')).not.toMatch(/operator/i);
    });

    it('declares the add-it-to-fields hint for sort_field_not_selected', () => {
      expect(declaredRecovery('sort_field_not_selected')).toBe(
        'Add each sort field to fields, or omit fields.',
      );
    });

    /**
     * The API's earlier 400 shape names the unknown field but lists none, so the
     * contract's "names this error lists" would point at nothing; the service's
     * own hint for that route says where the field names are.
     */
    it("forwards the service's invalid_field hint over the contract's", async () => {
      const hint =
        'Call treasury_query_dataset on this endpoint with page_size 1 and nothing else.';
      rejectWith(
        validationError("Invalid field: Field 'nope' does not exist.", {
          reason: 'invalid_field',
          recovery: { hint },
        }),
      );

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        fields: ['nope'],
      });
      await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_field', recovery: { hint } },
      });
    });

    it.each(SERVICE_ERRORS.filter(([reason]) => reason !== 'invalid_field'))(
      "keeps the contract's hint over a service hint for %s",
      async (reason, message) => {
        rejectWith(
          validationError(message, { reason, recovery: { hint: 'A weaker service hint.' } }),
        );

        const ctx = createMockContext({ errors: queryDatasetTool.errors });
        const input = queryDatasetTool.input.parse({
          endpoint: '/v2/accounting/od/debt_to_penny',
          page_number: 9999,
        });
        await expect(queryDatasetTool.handler(input, ctx)).rejects.toMatchObject({
          data: { reason, recovery: { hint: declaredRecovery(reason) } },
        });
      },
    );
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

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('No rows matched');
      expect(notice).not.toMatch(/field name/i);
      expect(notice).toContain('YYYY-MM-DD');
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

    it("records the query, filters included, in the staged table's provenance", async () => {
      const registerDataframe = useBridge('df_QRYDS_00007');

      const ctx = createMockContext({ errors: queryDatasetTool.errors });
      const input = queryDatasetTool.input.parse({
        endpoint: '/v2/accounting/od/debt_to_penny',
        fields: ['record_date'],
        filters: [{ field: 'record_date', operator: 'in', value: ['2024-01-02', '2024-01-03'] }],
        sort: '-record_date',
        page_size: 50,
        page_number: 2,
        canvas_id: 'stage-it',
      });
      await queryDatasetTool.handler(input, ctx);

      expect(registerDataframe).toHaveBeenCalledWith(ctx, {
        rows: [{ record_date: '2026-05-01', tot_pub_debt_out_amt: '36000000000000.00' }],
        sourceTool: 'treasury_query_dataset',
        queryParams: {
          endpoint: '/v2/accounting/od/debt_to_penny',
          fields: ['record_date'],
          filters: [{ field: 'record_date', operator: 'in', value: ['2024-01-02', '2024-01-03'] }],
          sort: '-record_date',
          page_size: 50,
          page_number: 2,
        },
      });
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

  it('describes an unknown field as an error that lists the fields, never as a 400', () => {
    expect(queryDatasetTool.description).not.toMatch(/\b400\b/);
    expect(queryDatasetTool.input.shape.fields.description).not.toMatch(/\b400\b/);
    expect(queryDatasetTool.input.shape.fields.description).toContain('listing every field');
  });

  /**
   * Live, `fields=record_calendar_year` on debt_to_penny reports a total-count
   * of 34 against 8,433 records: a selection returns its distinct combinations.
   */
  it('says a field selection returns distinct rows, and what total_count then counts', () => {
    expect(queryDatasetTool.input.shape.fields.description).toMatch(/distinct combination/);
    expect(queryDatasetTool.output.shape.total_count.description).toMatch(/distinct combination/);
  });

  it('describes the leading slash as optional and a sort field as one fields must include', () => {
    const { endpoint, sort } = queryDatasetTool.input.shape;
    expect(endpoint.description).toContain('The leading slash is optional.');
    expect(endpoint.description).not.toContain('Include the leading slash');
    expect(sort.description).toContain('the API sorts only by fields it returns');
  });

  it('says a filter value cannot contain a comma, and declares that refusal under invalid_filter', () => {
    const value = queryDatasetTool.input.shape.filters.unwrap().element.shape.value;
    expect(value.description).toContain('A value cannot contain a comma');
    const invalidFilter = queryDatasetTool.errors?.find((e) => e.reason === 'invalid_filter');
    expect(invalidFilter?.when).toMatch(/comma/);
    expect(invalidFilter?.when).toMatch(/before any request/);
  });

  /**
   * `content[]` is read through a real Markdown parse and compared with the
   * values `structuredContent` carries — a client renders the text, so the
   * rendered value is the one that has to match.
   */
  describe('content[] read-back', () => {
    type Result = Parameters<NonNullable<typeof queryDatasetTool.format>>[0];
    const base = {
      endpoint: '/v2/accounting/od/debt_to_penny',
      total_count: 2,
      total_pages: 1,
      page_number: 1,
      page_size: 100,
      field_labels: { record_date: 'Record Date', tot_pub_debt_out_amt: 'Total Public Debt' },
    } satisfies Omit<Result, 'data'>;

    function render(result: Result): string {
      return contentText(queryDatasetTool.format!(result));
    }

    it('reads every cell back as the row value, in its own column', () => {
      const data = [
        { record_date: '2026-05-01', tot_pub_debt_out_amt: '36000000000000.00' },
        { record_date: '2026-04-30', tot_pub_debt_out_amt: '35990000000000.00' },
      ];
      const [table] = readTables(render({ ...base, data }));

      expect(table?.rows).toEqual(data.map((row) => [row.record_date, row.tot_pub_debt_out_amt]));
    });

    it('reads a hostile cell and header back exactly, in their own column', () => {
      const field = 'x|y *z*';
      const data = [{ record_date: '2026-05-01', [field]: HOSTILE_VALUE }];
      const [table] = readTables(
        render({
          ...base,
          data,
          field_labels: { record_date: 'Record Date', [field]: HOSTILE_VALUE },
        }),
      );

      expect(table?.header).toEqual(['Record Date (record_date)', `${HOSTILE_VALUE} (${field})`]);
      expect(table?.rows).toEqual([['2026-05-01', HOSTILE_VALUE]]);
    });

    /**
     * Callers pass field names back in `fields`, `filters`, and `sort`, and
     * `structuredContent` keys every row by them — so the header names each
     * field, beside the label upstream gives it.
     */
    it('names each field beside its label in the header', () => {
      const data = [{ record_date: '2026-05-01', tot_pub_debt_out_amt: '36000000000000.00' }];
      const [table] = readTables(render({ ...base, data }));

      expect(table?.header).toEqual([
        'Record Date (record_date)',
        'Total Public Debt (tot_pub_debt_out_amt)',
      ]);
    });

    /** Live, the 1993-04-01 debt record carries `debt_held_public_amt: "null"`. */
    it('reads a "null" cell back as "null", the value structuredContent carries', () => {
      const data = [
        { record_date: '1993-04-01', debt_held_public_amt: 'null' },
        { record_date: '1993-04-02', debt_held_public_amt: '' },
      ];
      const [table] = readTables(
        render({
          ...base,
          data,
          field_labels: {
            record_date: 'Record Date',
            debt_held_public_amt: 'Debt Held by the Public',
          },
        }),
      );

      expect(table?.rows).toEqual(data.map((row) => [row.record_date, row.debt_held_public_amt]));
    });

    it('names a field alone when upstream gives it no label of its own', () => {
      const data = [{ record_date: '2026-05-01', src_line_nbr: '1' }];
      const [table] = readTables(
        render({ ...base, data, field_labels: { record_date: 'Record Date' } }),
      );

      expect(table?.header).toEqual(['Record Date (record_date)', 'src_line_nbr']);
    });

    it('lists the fields of an empty page, which carries field_labels and no rows', () => {
      const text = render({ ...base, data: [], total_count: 0 });
      const [table] = readTables(text);

      expect(text).toContain('No rows returned');
      expect(table).toEqual({
        header: ['Record Date (record_date)', 'Total Public Debt (tot_pub_debt_out_amt)'],
        rows: [],
      });
    });

    it('reads a backtick-bearing endpoint and filter back as whole code spans', () => {
      const endpoint = '/v1/x`y';
      const filter = 'country:eq:Cote D`Ivoire';
      const [first] = readParagraphs(
        render({ ...base, endpoint, applied_filters: filter, data: [] }),
      );

      expect(first).toContain(`Endpoint:⟦strong_close⟧ ⟦code_inline:${endpoint}⟧`);
      expect(first).toContain(`Filter:⟦strong_close⟧ ⟦code_inline:${filter}⟧`);
    });

    it('reads the notice back as structuredContent carries it, caller text included', async () => {
      vi.mocked(getFiscalDataService).mockReturnValue({
        fetchPage: vi.fn().mockResolvedValue(makeEnvelope([], 0)),
        buildFilterParam: vi.fn().mockReturnValue(''),
      } as unknown as ReturnType<typeof getFiscalDataService>);
      const endpoint = `/v9/${HOSTILE_VALUE}`;

      const result = await runToolContract(queryDatasetTool, { endpoint });
      const notice = (result.structuredContent as { notice: string }).notice;

      expect(notice).toContain(endpoint);
      expect(readBlockquotes(contentText(result.content))).toEqual([notice]);
    });
  });
});

/**
 * The service module is mocked above for the handler-level tests; this block
 * puts the real service back behind the accessor and stubs only `fetch`, so the
 * 404 classification, its probe, and the fetch deadline run as in production.
 */
describe('rejected and stalled queries through the real service, on both surfaces', () => {
  const DEBT = '/v2/accounting/od/debt_to_penny';
  const PROBE_URL = probeUrl(DEBT);
  const DEBT_FIELDS = [
    'record_date',
    'debt_held_public_amt',
    'intragov_hold_amt',
    'tot_pub_debt_out_amt',
  ];
  const INVALID_FIELD_HINT =
    'Replace each unknown name with one of the field names this error lists for the endpoint.';

  type ErrorEnvelope = {
    error: {
      code: number;
      message: string;
      data: { reason?: string; retryable?: boolean; recovery?: { hint?: string } };
    };
  };

  /** Every query 404s, as the API answers a rejected one; the probe gets `probe()`. */
  function stubUpstream(probe: () => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(String(input) === PROBE_URL ? probe() : notFoundText()),
      ),
    );
  }

  beforeEach(async () => {
    const { FiscalDataService } = await vi.importActual<
      typeof import('@/services/fiscal-data/fiscal-data-service.js')
    >('@/services/fiscal-data/fiscal-data-service.js');
    vi.mocked(getFiscalDataService).mockReturnValue(new FiscalDataService());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists every field of a 114-field endpoint with the replace-the-name hint', async () => {
    const fields = Array.from({ length: 114 }, (_, i) => `field_${String(i + 1).padStart(3, '0')}`);
    stubUpstream(() => labelsOk(fields));

    const result = await runToolContract(queryDatasetTool, {
      endpoint: DEBT,
      fields: ['nope'],
      page_size: 1,
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_field', recovery: { hint: INVALID_FIELD_HINT } },
    });
    expect(error.message).toContain('"nope"');
    expect(error.message).toContain(`114 fields: ${fields.join(', ')}.`);
    const text = contentText(result.content);
    expect(text).toContain(`114 fields: ${fields.join(', ')}.`);
    expect(text).toContain(`Recovery: ${INVALID_FIELD_HINT}`);
    expect(text).toContain('reason invalid_field');
  });

  it.each<[string, JsonRpcErrorCode, z.input<typeof queryDatasetTool.input>, () => Response]>([
    [
      'invalid_endpoint',
      JsonRpcErrorCode.NotFound,
      { endpoint: DEBT, fields: ['record_date'] },
      notFoundText,
    ],
    [
      'page_out_of_range',
      JsonRpcErrorCode.ValidationError,
      { endpoint: DEBT, fields: ['record_date'], page_number: 2 },
      () => labelsOk(DEBT_FIELDS),
    ],
    [
      'page_out_of_range',
      JsonRpcErrorCode.ValidationError,
      { endpoint: DEBT, page_number: 2 },
      () => labelsOk(DEBT_FIELDS),
    ],
    [
      'invalid_filter',
      JsonRpcErrorCode.ValidationError,
      { endpoint: DEBT, filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }] },
      () => labelsOk(DEBT_FIELDS),
    ],
    [
      'sort_field_not_selected',
      JsonRpcErrorCode.ValidationError,
      { endpoint: DEBT, fields: ['record_date'], sort: '-tot_pub_debt_out_amt' },
      () => labelsOk(DEBT_FIELDS),
    ],
  ])('reroutes the probe verdict %s with its declared hint', async (reason, code, input, probe) => {
    stubUpstream(probe);

    const result = await runToolContract(queryDatasetTool, input);

    const hint = queryDatasetTool.errors?.find((entry) => entry.reason === reason)?.recovery;
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error).toMatchObject({ code, data: { reason, recovery: { hint } } });
    // The framework renders a `Recovery:` line only when the message lacks the hint.
    const text = contentText(result.content);
    expect(text).toContain(String(hint));
    expect(text).toContain(`reason ${reason}`);
  });

  it('passes a probe that cannot answer through as a retryable ServiceUnavailable, never a missing endpoint', async () => {
    vi.useFakeTimers();
    stubUpstream(
      () =>
        new Response('<!DOCTYPE html><html></html>', {
          status: 503,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const pending = runToolContract(queryDatasetTool, {
      endpoint: DEBT,
      fields: ['record_date'],
      page_size: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: true },
    });
    expect(error.data.reason).toBeUndefined();
    expect(error.message).toContain(`rejected the query on endpoint "${DEBT}"`);
    const text = contentText(result.content);
    expect(text).toContain(`rejected the query on endpoint "${DEBT}"`);
    expect(text).toContain('retryable');
  });

  it('retries a 404 on a fields-only page-1 query whose every name exists, blaming no filter', async () => {
    vi.useFakeTimers();
    stubUpstream(() => labelsOk(DEBT_FIELDS));

    const pending = runToolContract(queryDatasetTool, {
      endpoint: DEBT,
      fields: ['record_date'],
      page_size: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: true },
    });
    expect(error.data.reason).toBeUndefined();
    expect(error.message).toContain(`endpoint "${DEBT}" whose every field name exists`);
    expect(error.message).toContain('failed after 4 attempts');
    const text = contentText(result.content);
    expect(text).toContain(`endpoint "${DEBT}" whose every field name exists`);
    expect(text).not.toContain('filter or sort');
    expect(text).toContain('retryable');
  });

  it('sends the trimmed selection to the normalized path and echoes that path on both surfaces', async () => {
    const fetchMock = vi.fn((_input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        jsonOk(envelopeBody([{ record_date: '2024-01-02', tot_pub_debt_out_amt: '1.00' }])),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runToolContract(queryDatasetTool, {
      endpoint: ' v2/accounting/od/debt_to_penny ',
      fields: [' record_date', 'tot_pub_debt_out_amt '],
      filters: [{ field: 'record_date ', operator: 'gte', value: '2024-01-01' }],
      sort: 'record_date, -tot_pub_debt_out_amt',
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/services/api/fiscal_service${DEBT}`);
    expect(url.searchParams.get('fields')).toBe('record_date,tot_pub_debt_out_amt');
    expect(url.searchParams.get('filter')).toBe('record_date:gte:2024-01-01');
    expect(url.searchParams.get('sort')).toBe('record_date,-tot_pub_debt_out_amt');
    const payload = result.structuredContent as { endpoint: string; applied_filters?: string };
    expect(payload).toMatchObject({
      endpoint: DEBT,
      applied_filters: 'record_date:gte:2024-01-01',
    });
    // A catalogued path once normalized: no off-catalog notice on either surface.
    expect(payload).not.toHaveProperty('notice');
    const text = contentText(result.content);
    expect(readParagraphs(text)[0]).toContain(`⟦code_inline:${DEBT}⟧`);
    expect(text).not.toContain('not found in the local catalog');
  });

  it.each<[string, z.input<typeof queryDatasetTool.input>['filters'], string, string]>([
    [
      'a single value',
      [{ field: 'tot_pub_debt_out_amt', operator: 'gt', value: '1,000' }],
      'tot_pub_debt_out_amt',
      '1,000',
    ],
    [
      'an "in" member, under its trimmed field name',
      [{ field: ' country ', operator: 'in', value: ['Japan', 'Korea, South'] }],
      'country',
      'Korea, South',
    ],
  ])(
    'sends no request for %s holding a comma, and says why on both surfaces',
    async (_label, filters, field, value) => {
      const fetchMock = vi.fn((_input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(jsonOk(envelopeBody([]))),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await runToolContract(queryDatasetTool, { endpoint: DEBT, filters });

      expect(fetchMock).not.toHaveBeenCalled();
      const message = `Filter value "${value}" for field "${field}" contains a comma; the API reads a comma inside a value as the start of another condition, so no value can contain one.`;
      // The contract's one invalid_filter hint, comma first.
      const hint = String(
        queryDatasetTool.errors?.find((entry) => entry.reason === 'invalid_filter')?.recovery,
      );
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'invalid_filter', recovery: { hint } },
      });
      const paragraphs = readParagraphs(contentText(result.content));
      expect(paragraphs).toContain(`Error: ${message}`);
      expect(paragraphs).toContain(`Recovery: ${hint}`);
      expect(contentText(result.content)).toContain('reason invalid_filter');
    },
  );

  /**
   * The legacy 400 route names the unknown field but lists none, so the hint
   * has to say where the field names are rather than point at a list.
   */
  it('gives the 400 route a hint that says where the field names are', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'Invalid Query Param',
              message: "Invalid query parameter: Field 'nope' does not exist.",
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    const result = await runToolContract(queryDatasetTool, { endpoint: DEBT, fields: ['nope'] });

    const { error } = result.structuredContent as ErrorEnvelope;
    const hint = String(error.data.recovery?.hint);
    expect(error.data.reason).toBe('invalid_field');
    expect(hint).not.toBe(INVALID_FIELD_HINT);
    expect(hint).toContain('page_size 1');
    expect(contentText(result.content)).toContain(`Recovery: ${hint}`);
  });

  it('settles a request that never answers at the 50 s fetch budget', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        hang(init),
      ),
    );

    let settled = false;
    const pending = runToolContract(queryDatasetTool, { endpoint: DEBT, page_size: 1 }).finally(
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const result = await pending;
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(contentText(result.content)).toContain(error.message);
  });
});
