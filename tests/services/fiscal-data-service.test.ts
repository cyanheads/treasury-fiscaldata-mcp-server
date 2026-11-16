/**
 * @fileoverview Tests for FiscalDataService — response classification, the
 * bare probe that tells a rejected query from a missing endpoint, the request
 * timeout that bounds one exchange (headers and body), and the deadline that
 * bounds every attempt together.
 * @module tests/services/fiscal-data-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';
import {
  type Answer,
  delayed,
  envelopeBody,
  hang,
  htmlPage,
  jsonOk,
  labelsOk,
  notFoundText,
  probeUrl,
} from '../helpers/fiscal-data-upstream.js';

const ENDPOINT = '/v2/accounting/od/debt_to_penny';
const REQUEST_TIMEOUT_MS = 30_000;

type FetchArgs = Parameters<typeof fetch>;

/**
 * A JSON error body in the API's legacy rejection shape. The API no longer
 * sends it for a rejected query — those get `notFoundText`'s bare 404 — so the
 * 400 tests pin the branch that still classifies it, and the other statuses use
 * it as a generic JSON error body.
 */
function errorBody(status: number, message?: string) {
  return new Response(
    JSON.stringify({ error: 'Invalid Query Param', ...(message && { message }) }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * The legacy 400 shape's message for a page past the end, as the API sent it
 * before it answered such a page with a bare 404.
 */
const OUT_OF_RANGE_MESSAGE =
  'Invalid query parameter: Page #9999 is out of range. For more information, please see the documentation.';

/** The error a call rejected with, typed for assertions. Fails loudly if it resolves. */
function rejectionOf<T>(call: Promise<T>): Promise<McpError> {
  return call.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (err: unknown) => err as McpError,
  );
}

/**
 * Upstream that answers headers immediately and then holds the body open,
 * erroring the stream only once the request signal aborts. This is the shape a
 * stalled transfer actually produces: `fetch` resolves at headers, and the
 * pending `.text()` rejects with the abort reason.
 */
function stallingBodyFetch() {
  return vi.fn((_input: FetchArgs[0], init?: FetchArgs[1]) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        const fail = () =>
          controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
}

/** Upstream that never sends headers — rejects only when the signal aborts. */
function stallingHeadersFetch() {
  return vi.fn((_input: FetchArgs[0], init?: FetchArgs[1]) => hang(init));
}

const PROBE_URL = probeUrl(ENDPOINT);

/** Every field debt_to_penny carries, as its live `meta.labels` keys list them. */
const DEBT_FIELDS = [
  'record_date',
  'debt_held_public_amt',
  'intragov_hold_amt',
  'tot_pub_debt_out_amt',
  'src_line_nbr',
  'record_fiscal_year',
  'record_fiscal_quarter',
  'record_calendar_year',
  'record_calendar_quarter',
  'record_calendar_month',
  'record_calendar_day',
];

const INVALID_FIELD_HINT =
  'Replace each unknown name with one of the field names this error lists for the endpoint.';

const SORT_FIELD_NOT_SELECTED_HINT = 'Add each sort field to fields, or omit fields.';

const answer =
  (make: () => Response): Answer =>
  () =>
    Promise.resolve(make());

/** Upstream that answers the probe URL with `probe` and every other request with `query`. */
function upstream(query: Answer, probe: Answer) {
  return vi.fn((input: FetchArgs[0], init?: FetchArgs[1]) =>
    String(input) === PROBE_URL ? probe(init) : query(init),
  );
}

/** For each request a fetch mock received, in order: was it the probe? */
function probeFlags(fetchMock: ReturnType<typeof upstream>) {
  return fetchMock.mock.calls.map((call) => String(call[0]) === PROBE_URL);
}

/** Installs an upstream that 404s every query, as it does a rejected one; the probe gets `probe`. */
function rejectedQuery(probe: Answer) {
  const fetchMock = upstream(answer(notFoundText), probe);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const debtLabels = answer(() => labelsOk(DEBT_FIELDS));

describe('FiscalDataService.buildFilterParam', () => {
  it('renders scalar and "in" conditions', () => {
    const svc = new FiscalDataService();
    expect(
      svc.buildFilterParam([
        { field: 'record_date', operator: 'gte', value: '2026-01-01' },
        { field: 'security_desc', operator: 'in', value: ['Bills', 'Notes'] },
      ]),
    ).toBe('record_date:gte:2026-01-01,security_desc:in:(Bills,Notes)');
  });
});

/**
 * The API reads a comma inside a filter value as the start of another
 * condition: `record_date:eq:2024-01-03,src_line_nbr:eq:1` answers with the
 * rows of a query the caller never wrote, and `tot_pub_debt_out_amt:gt:1,000`
 * answers 503. Every tool's filters pass through `fetchPage`.
 */
describe('FiscalDataService.fetchPage — a comma inside a filter value', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, Parameters<FiscalDataService['fetchPage']>[2], string, string]>([
    [
      'a single value',
      { filters: [{ field: 'tot_pub_debt_out_amt', operator: 'gt', value: '1,000' }] },
      'tot_pub_debt_out_amt',
      '1,000',
    ],
    [
      'a member of an "in" list, behind a filter without one',
      {
        filters: [
          { field: 'record_date', operator: 'gte', value: '2026-01-01' },
          {
            field: 'security_desc',
            operator: 'in',
            value: ['Treasury Bills', 'Treasury Bills,record_date:gte:2026-01-01'],
          },
        ],
      },
      'security_desc',
      'Treasury Bills,record_date:gte:2026-01-01',
    ],
  ])(
    'refuses %s as invalid_filter without sending a request',
    async (_label, options, field, value) => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonOk(envelopeBody([]))));
      vi.stubGlobal('fetch', fetchMock);

      const error = await rejectionOf(
        new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, options),
      );

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(
        `Filter value ${JSON.stringify(value)} for field "${field}" contains a comma; the API reads a comma inside a value as the start of another condition, so no value can contain one.`,
      );
      expect(error.data).toEqual({
        reason: 'invalid_filter',
        endpoint: ENDPOINT,
        field,
        value,
        recovery: {
          hint: 'Remove the comma: write numbers without thousands separators (1000, not 1,000). A text value that itself contains a comma cannot be matched exactly; filter on another field.',
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('FiscalDataService.fetchPage — response classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed envelope on a 200 JSON response', async () => {
    const rows = [{ record_date: '2026-08-11', tot_pub_debt_out_amt: '39180000000000.00' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonOk(envelopeBody(rows)))),
    );

    const envelope = await new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
      pageSize: 1,
    });

    expect(envelope.data).toEqual(rows);
    expect(envelope.meta['total-count']).toBe(1);
  });

  it('sends fields, filters, sort, and page params on the query string', async () => {
    const fetchMock = vi.fn((_input: FetchArgs[0], _init?: FetchArgs[1]) =>
      Promise.resolve(jsonOk(envelopeBody([]))),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
      fields: ['record_date'],
      filters: [{ field: 'record_date', operator: 'gte', value: '2026-01-01' }],
      sort: '-record_date',
      pageSize: 10_000,
      pageNumber: 3,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname.endsWith(ENDPOINT)).toBe(true);
    expect(url.searchParams.get('fields')).toBe('record_date');
    expect(url.searchParams.get('filter')).toBe('record_date:gte:2026-01-01');
    expect(url.searchParams.get('sort')).toBe('-record_date');
    expect(url.searchParams.get('page[size]')).toBe('10000');
    expect(url.searchParams.get('page[number]')).toBe('3');
  });

  it('classifies a 404 HTML response as invalid_endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<!DOCTYPE html><html><body>Not found</body></html>', {
            status: 404,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
    );

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), '/v2/nope', {}),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_endpoint', endpoint: '/v2/nope' },
    });
  });

  it('rejects HTML masquerading as a 200 JSON response without retrying', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html></html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {}),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unparseable 200 body without retrying', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonOk('{ not json')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {}),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The API once rejected a query with a 400 JSON body whose message named the
 * fault (`errorBody`); it now answers every rejected query with a bare 404,
 * classified by the probe below. The branch that reads the 400's message stays
 * in case the shape returns. Each pattern needs both of its terms, and a
 * message that matches none fails fast by its status.
 */
describe('FiscalDataService.fetchPage — the legacy 400 rejection shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies a 400 unknown-field body as invalid_field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(errorBody(400, "Invalid query parameter: Field 'nope' does not exist.")),
      ),
    );

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['nope'] }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_field' },
    });
  });

  /**
   * That body names the unknown field and lists none, so the probe route's
   * "the field names this error lists" would point at nothing.
   */
  it('tells a 400 unknown-field caller where the field names are', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(errorBody(400, "Invalid query parameter: Field 'nope' does not exist.")),
      ),
    );

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['nope'] }),
    );

    const hint = String((error.data as { recovery?: { hint?: string } }).recovery?.hint);
    expect(hint).not.toBe(INVALID_FIELD_HINT);
    expect(hint).toContain('treasury_query_dataset');
    expect(hint).toContain('page_size 1');
  });

  it('classifies a 400 unsupported-operator body as invalid_filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          errorBody(400, "Invalid query parameter: Operator ':like:' is not supported."),
        ),
      ),
    );

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {}),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_filter' },
    });
  });

  it('classifies a malformed filter expression as invalid_filter', async () => {
    /**
     * A filter whose value is missing tokenizes upstream as an operator fault —
     * the API names the operator even though the expression, not the operator,
     * is what it rejected.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          errorBody(
            400,
            "Invalid query parameter: Operator 'Invalid Filter Format' is not supported. For more information, please see the documentation.",
          ),
        ),
      ),
    );

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {}),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_filter' },
    });
  });

  it('classifies a 400 out-of-range page as page_out_of_range', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errorBody(400, OUT_OF_RANGE_MESSAGE)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { pageNumber: 9999 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'page_out_of_range', endpoint: ENDPOINT },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('points an out-of-range page at total_pages rather than at a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(errorBody(400, OUT_OF_RANGE_MESSAGE))),
    );

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { pageNumber: 9999 }),
    );

    const hint = String((error.data as { recovery?: { hint?: string } }).recovery?.hint);
    expect(hint).toContain('total_pages');
    expect(error.message).not.toContain('failed after');
  });

  it.each([
    [
      'names a field without saying it does not exist',
      "Invalid query parameter: Field 'nope' is deprecated.",
    ],
    [
      'says something does not exist without naming a field',
      "Invalid query parameter: Endpoint 'nope' does not exist.",
    ],
    [
      'names a page without saying it is out of range',
      'Invalid query parameter: Page size 20000 is too large.',
    ],
    [
      'says something is out of range without naming a page',
      'Invalid query parameter: Value 99999 is out of range.',
    ],
  ])('leaves a 400 that %s unclassified, failing fast by its status', async (_label, message) => {
    const fetchMock = vi.fn(() => Promise.resolve(errorBody(400, message)));
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {}),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { status: 400, endpoint: ENDPOINT },
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.message).toBe(`Fiscal Data API error: ${message}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FiscalDataService.fetchPage — a 404 on a query is classified by a bare probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no probe when the query succeeds', async () => {
    const fetchMock = upstream(
      answer(() => jsonOk(envelopeBody([]))),
      debtLabels,
    );
    vi.stubGlobal('fetch', fetchMock);

    await new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
      fields: ['record_date'],
      filters: [{ field: 'record_date', operator: 'gte', value: '2026-01-01' }],
      sort: '-record_date',
      pageNumber: 2,
    });

    expect(probeFlags(fetchMock)).toEqual([false]);
  });

  it('reads a 404 on a request with no fields, filter, sort, or later page as a missing path, without a probe', async () => {
    const fetchMock = rejectedQuery(debtLabels);

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), '/v2/nope', {
        pageSize: 1,
        pageNumber: 1,
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_endpoint', endpoint: '/v2/nope' },
    });
    expect(probeFlags(fetchMock)).toEqual([false]);
  });

  it('names each unknown field and lists every field the endpoint has', async () => {
    const fetchMock = rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date', 'field_does_not_exist', 'also_missing'],
        pageSize: 1,
      }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_field', endpoint: ENDPOINT, recovery: { hint: INVALID_FIELD_HINT } },
    });
    expect(error.message).toContain('"field_does_not_exist", "also_missing"');
    expect(error.message).not.toContain('"record_date"');
    expect(error.message).toContain(`${DEBT_FIELDS.length} fields: ${DEBT_FIELDS.join(', ')}.`);
    expect(probeFlags(fetchMock)).toEqual([false, true]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(PROBE_URL);
  });

  it.each<[string, Parameters<FiscalDataService['fetchPage']>[2], string]>([
    ['a filter', { filters: [{ field: 'nope', operator: 'eq', value: '1' }] }, 'nope'],
    ['a descending sort term', { sort: '-nope' }, 'nope'],
    ['the second of two sort terms', { sort: 'record_date,-nope' }, 'nope'],
    [
      'a sort prefixed with "+", which the API does not strip',
      { sort: '+record_date' },
      '+record_date',
    ],
    ['an empty fields entry', { fields: ['', 'record_date'] }, ''],
  ])('names an unknown field in %s', async (_label, options, unknown) => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, options),
    );

    expect(error).toMatchObject({ data: { reason: 'invalid_field' } });
    expect(error.message).toContain(`: ${JSON.stringify(unknown)}.`);
  });

  it('names an unknown name once, however many parts of the query send it', async () => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['nope', 'nope'],
        filters: [{ field: 'nope', operator: 'eq', value: '1' }],
        sort: '-nope',
      }),
    );

    expect(error.message).toContain(
      `Unknown field name on endpoint "${ENDPOINT}": "nope". The endpoint has`,
    );
  });

  it('lists every field of an endpoint that has 114 of them', async () => {
    const fields = Array.from({ length: 114 }, (_, i) => `field_${String(i + 1).padStart(3, '0')}`);
    rejectedQuery(answer(() => labelsOk(fields)));

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['nope'] }),
    );

    expect(error.message).toContain(`114 fields: ${fields.join(', ')}.`);
  });

  it('reads a later page whose every name exists as page_out_of_range', async () => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date'],
        filters: [{ field: 'record_date', operator: 'eq', value: '2024-01-02' }],
        pageSize: 1,
        pageNumber: 2,
      }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'page_out_of_range', endpoint: ENDPOINT },
    });
    expect(String((error.data as { recovery?: { hint?: string } }).recovery?.hint)).toContain(
      'total_pages',
    );
  });

  it('reads a later page with nothing else in the query as page_out_of_range, after a probe', async () => {
    const fetchMock = rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { pageNumber: 2 }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'page_out_of_range', endpoint: ENDPOINT },
    });
    expect(probeFlags(fetchMock)).toEqual([false, true]);
  });

  /**
   * The API returns only the fields a query selects and sorts only by those:
   * `fields=record_date&sort=-tot_pub_debt_out_amt` answers 404, and the same
   * query with `tot_pub_debt_out_amt` selected answers 200.
   */
  it('reads a sort field the query does not select as sort_field_not_selected', async () => {
    const fetchMock = rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date'],
        sort: '-tot_pub_debt_out_amt',
      }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'sort_field_not_selected',
        endpoint: ENDPOINT,
        recovery: { hint: SORT_FIELD_NOT_SELECTED_HINT },
      },
    });
    expect(error.message).toBe(
      'Sort field "tot_pub_debt_out_amt" is not among the requested fields; the API sorts only by fields it returns.',
    );
    expect(probeFlags(fetchMock)).toEqual([false, true]);
  });

  it('names every sort field the query does not select, once each', async () => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date'],
        sort: '-tot_pub_debt_out_amt,record_date,debt_held_public_amt,tot_pub_debt_out_amt',
      }),
    );

    expect(error.message).toBe(
      'Sort fields "tot_pub_debt_out_amt", "debt_held_public_amt" are not among the requested fields; the API sorts only by fields it returns.',
    );
  });

  it.each<[string, Parameters<FiscalDataService['fetchPage']>[2], string]>([
    [
      'an unknown sort name, which fails as invalid_field first',
      { fields: ['record_date'], sort: '-nope' },
      'invalid_field',
    ],
    [
      'a later page, which the unselected sort field explains first',
      { fields: ['record_date'], sort: '-tot_pub_debt_out_amt', pageNumber: 2 },
      'sort_field_not_selected',
    ],
    [
      'a filter, which the unselected sort field explains first',
      {
        fields: ['record_date'],
        filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }],
        sort: 'tot_pub_debt_out_amt',
      },
      'sort_field_not_selected',
    ],
    [
      'a sort field the query does select',
      {
        fields: ['record_date'],
        filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }],
        sort: '-record_date',
      },
      'invalid_filter',
    ],
    [
      'a sort with no fields selected, which returns every field',
      { sort: '-tot_pub_debt_out_amt' },
      'invalid_filter',
    ],
  ])('classifies a rejected query with %s', async (_label, options, reason) => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, options),
    );

    expect(error).toMatchObject({ data: { reason } });
  });

  it('reads page 1 whose every name exists as invalid_filter', async () => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }],
        sort: '-record_date',
      }),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_filter', endpoint: ENDPOINT },
    });
    expect(String((error.data as { recovery?: { hint?: string } }).recovery?.hint)).not.toMatch(
      /field name/i,
    );
  });

  /**
   * The generic query tool takes the operator as an enum and refuses a comma
   * inside a value before sending, so neither can be what the API refused: the
   * hint leads the caller to the expression by elimination.
   */
  it('points invalid_filter at finding the refused expression, not at operators or commas', async () => {
    rejectedQuery(debtLabels);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        filters: [{ field: 'record_date', operator: 'gte', value: '2024-01-01' }],
        sort: '-record_date',
      }),
    );

    expect(error).toMatchObject({ data: { reason: 'invalid_filter' } });
    const hint = String((error.data as { recovery?: { hint?: string } }).recovery?.hint);
    expect(hint).toContain('one filter at a time');
    expect(hint).not.toMatch(/operator|comma/i);
  });

  it('reads a 404 on the probe as a missing path', async () => {
    const fetchMock = rejectedQuery(answer(notFoundText));

    await expect(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date'],
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_endpoint', endpoint: ENDPOINT },
    });
    expect(probeFlags(fetchMock)).toEqual([false, true]);
  });
});

describe('FiscalDataService.fetchPage — a probe that cannot answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Runs a rejected query through the whole retry ladder without real waiting. */
  async function settle() {
    const settled = rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['nope'] }),
    );
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    return await settled;
  }

  it.each<[string, Answer]>([
    ['a 400', answer(() => errorBody(400, 'Invalid query parameter: something.'))],
    ['a 403 bot-check page', answer(() => htmlPage(403))],
    ['a 429', answer(() => errorBody(429))],
    ['a 500', answer(() => errorBody(500))],
    ['a 503 outage page', answer(() => htmlPage(503))],
    [
      'a 200 HTML page',
      answer(
        () =>
          new Response('<!DOCTYPE html><html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    ],
    ['a 200 body that is not JSON', answer(() => jsonOk('{ not json'))],
    ['a 200 body without meta.labels', answer(() => jsonOk('{"data":[]}'))],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('reports %s as a retryable ServiceUnavailable for a rejected query', async (_, probe) => {
    const fetchMock = rejectedQuery(probe);

    const error = await settle();

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { endpoint: ENDPOINT, retryable: true },
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.message).toContain(`rejected the query on endpoint "${ENDPOINT}"`);
    // The ladder repeats the whole query-and-probe cycle: four attempts, two requests each.
    expect(error.message).toContain('failed after 4 attempts');
    expect(probeFlags(fetchMock)).toEqual([false, true, false, true, false, true, false, true]);
  });

  /**
   * Every name exists, the page is the first, and nothing else was sent: no
   * part of the request is one the API rejects, so the 404 is not a verdict on
   * it, and naming a filter or sort the caller never sent would send them after
   * nothing.
   */
  it('retries a fields-only page-1 query whose every name exists instead of blaming a filter it never sent', async () => {
    const fetchMock = rejectedQuery(debtLabels);

    const settled = rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        fields: ['record_date'],
        pageSize: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const error = await settled;

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { endpoint: ENDPOINT, retryable: true },
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.message).not.toContain('rejected the filter or sort');
    expect(error.message).toContain('failed after 4 attempts');
    expect(probeFlags(fetchMock)).toEqual([false, true, false, true, false, true, false, true]);
  });

  it('retries a probe that outlasts the 30 s request timeout, then classifies from the next answer', async () => {
    let probes = 0;
    const fetchMock = rejectedQuery((init) =>
      ++probes === 1 ? hang(init) : Promise.resolve(labelsOk(DEBT_FIELDS)),
    );

    const settled = rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['nope'] }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(probeFlags(fetchMock)).toEqual([false, true]);

    // The 30 s timer, then at most 625 ms of jittered backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(error).toMatchObject({ data: { reason: 'invalid_field' } });
    expect(probeFlags(fetchMock)).toEqual([false, true, false, true]);
  });

  it('rethrows a caller cancellation that lands during the probe, unchanged and unretried', async () => {
    const fetchMock = rejectedQuery(hang);
    const controller = new AbortController();

    const settled = new FiscalDataService()
      .fetchPage(createMockContext({ signal: controller.signal }), ENDPOINT, { fields: ['nope'] })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(probeFlags(fetchMock)).toEqual([false, true]);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await settled;

    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(McpError);
    expect(probeFlags(fetchMock)).toEqual([false, true]);
  });
});

describe('FiscalDataService.fetchPage — one deadline across attempts, backoff, and the probe', () => {
  /** MCP clients abandon a request at 60 s; the whole failure path has to settle first. */
  const BUDGET_MS = 50_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each<[string, () => ReturnType<typeof vi.fn>]>([
    ['every request stalls before headers', () => upstream(hang, hang)],
    ['every request stalls mid-body', () => stallingBodyFetch()],
    ['the query 404s at once and every probe stalls', () => upstream(answer(notFoundText), hang)],
    [
      'the query 404s after 29.9 s and every probe stalls',
      () => upstream(delayed(29_900, notFoundText), hang),
    ],
  ])('settles at the 50 s budget, never later, when %s', async (_label, makeFetch) => {
    vi.stubGlobal('fetch', makeFetch());

    let settled = false;
    const pending = rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, { fields: ['record_date'] }),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    const error = await pending;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: BUDGET_MS, elapsedMs: BUDGET_MS },
    });
    // A call with a budget of its own has no earlier spend to name.
    expect(error.message).toMatch(
      new RegExp(
        `^Fiscal Data request for endpoint "${ENDPOINT}" exceeded its ${BUDGET_MS}ms retry deadline after \\d+ attempts?\\.$`,
      ),
    );
  });
});

/**
 * A tool that chains requests — pages of a series, a probe before the fetch —
 * passes the instant it began as `budgetStart`, and every call draws on one
 * 50 s budget, so the tool call settles before the client's 60 s cutoff.
 */
describe('FiscalDataService.fetchPage — one budget across the calls of a tool invocation', () => {
  const BUDGET_MS = 50_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives a later call only what the earlier ones left', async () => {
    let requests = 0;
    const fetchMock = vi.fn((_input: FetchArgs[0], init?: FetchArgs[1]) =>
      ++requests === 1 ? delayed(30_000 - 1, () => jsonOk(envelopeBody([])))(init) : hang(init),
    );
    vi.stubGlobal('fetch', fetchMock);
    const svc = new FiscalDataService();
    const ctx = createMockContext();
    const budgetStart = Date.now();

    let settled = false;
    const pending = rejectionOf(
      (async () => {
        await svc.fetchPage(ctx, ENDPOINT, { pageNumber: 1, budgetStart });
        return await svc.fetchPage(ctx, ENDPOINT, { pageNumber: 2, budgetStart });
      })(),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    const error = await pending;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: BUDGET_MS - 30_000 + 1 },
    });
    /**
     * The later call's retry deadline is the budget's remainder, so the message
     * names the tool call's budget too; the remainder alone reads as a
     * per-request limit.
     */
    expect(error.message).toBe(
      `Fiscal Data request for endpoint "${ENDPOINT}" (29999ms into this tool call's ${BUDGET_MS}ms budget) exceeded its 20001ms retry deadline after 1 attempt.`,
    );
  });

  it('sends nothing once the budget is spent, failing as the same Timeout', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonOk(envelopeBody([]))));
    vi.stubGlobal('fetch', fetchMock);

    const error = await rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
        budgetStart: Date.now() - BUDGET_MS,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 0, endpoint: ENDPOINT },
    });
    expect(error.message).toContain(ENDPOINT);
  });

  it('rethrows a caller cancellation over a spent budget, unchanged and unsent', async () => {
    const fetchMock = vi.fn((_input: FetchArgs[0], init?: FetchArgs[1]) => hang(init));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const error = await new FiscalDataService()
      .fetchPage(createMockContext({ signal: controller.signal }), ENDPOINT, {
        budgetStart: Date.now() - BUDGET_MS,
      })
      .catch((err: unknown) => err);

    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rethrows a caller cancellation inside a shared budget unchanged', async () => {
    const fetchMock = vi.fn((_input: FetchArgs[0], init?: FetchArgs[1]) => hang(init));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const settled = new FiscalDataService()
      .fetchPage(createMockContext({ signal: controller.signal }), ENDPOINT, {
        budgetStart: Date.now() - 40_000,
      })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await settled;

    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(McpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FiscalDataService.fetchPage — retry decision by status class', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Drives `withRetry` past its full backoff budget without real waiting. */
  async function settle(fetchMock: ReturnType<typeof vi.fn>, options = {}) {
    vi.stubGlobal('fetch', fetchMock);
    const settled = rejectionOf(
      new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, options),
    );
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    return await settled;
  }

  it('retries a 5xx and reports exhaustion', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errorBody(503)));

    const error = await settle(fetchMock);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(error.message).toContain('failed after 4 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  /** The message patterns pick a reason for a 4xx only; a 5xx keeps its retry budget. */
  it('retries a 503 whose JSON message names an operator, never reading it as invalid_filter', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        errorBody(503, "Invalid query parameter: Operator ':like:' is not supported."),
      ),
    );

    const error = await settle(fetchMock);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, endpoint: ENDPOINT, retryable: true },
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.message).toContain('failed after 4 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a 503 HTML outage page as a retryable ServiceUnavailable, never a missing endpoint', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(htmlPage(503)));

    const error = await settle(fetchMock, { fields: ['record_date'] });

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503, endpoint: ENDPOINT, retryable: true },
    });
    expect(error.data).not.toHaveProperty('reason');
    expect(error.message).toContain('failed after 4 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports a 4xx HTML page by its status, never as a missing endpoint', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(htmlPage(403)));

    const error = await settle(fetchMock);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden, data: { status: 403 } });
    expect(error.data).not.toHaveProperty('reason');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on a 400 whose message matches no known pattern', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(errorBody(400, 'Invalid query parameter: something the server dislikes.')),
    );

    const error = await settle(fetchMock);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    expect(error.message).not.toContain('failed after');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on a 4xx with no parseable error body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('nope', { status: 403, headers: { 'content-type': 'text/csv' } }),
      ),
    );

    const error = await settle(fetchMock);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden, data: { status: 403 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a 429, which clears on its own', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errorBody(429)));

    const error = await settle(fetchMock);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('FiscalDataService.fetchPage — request timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('classifies a header-phase deadline expiry as Timeout', async () => {
    const fetchMock = stallingHeadersFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {});
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(8 * REQUEST_TIMEOUT_MS);

    expect(await settled).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  it('classifies a body-phase deadline expiry as Timeout', async () => {
    const fetchMock = stallingBodyFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
      pageSize: 10_000,
    });
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(8 * REQUEST_TIMEOUT_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(String((error as Error).message)).toContain(ENDPOINT);
  });

  it('retries a request that outlasts its timeout as transient, within the one fetch budget', async () => {
    const fetchMock = stallingBodyFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {});
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(8 * REQUEST_TIMEOUT_MS);

    // The first attempt times out at 30 s; the retry runs into the 50 s budget.
    expect(await settled).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', retryAttempts: 2 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a caller-initiated abort distinct from a deadline expiry', async () => {
    const fetchMock = stallingHeadersFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const pending = new FiscalDataService().fetchPage(
      createMockContext({ signal: controller.signal }),
      ENDPOINT,
      {},
    );
    const settled = pending.catch((err: unknown) => err);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const error = await settled;
    expect((error as Error).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(McpError);
    // The caller cancelled — withRetry short-circuits instead of burning attempts.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not arm a stale deadline once the body has been read', async () => {
    const rows = [{ record_date: '2026-08-11' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonOk(envelopeBody(rows)))),
    );

    const envelope = await new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {});
    expect(envelope.data).toEqual(rows);

    // Nothing may fire after the exchange completes — neither timer nor fetch budget.
    await vi.advanceTimersByTimeAsync(4 * REQUEST_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
