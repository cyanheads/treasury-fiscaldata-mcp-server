/**
 * @fileoverview Tests for FiscalDataService — response classification and the
 * request deadline that bounds the whole exchange (headers and body).
 * @module tests/services/fiscal-data-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

const ENDPOINT = '/v2/accounting/od/debt_to_penny';
const DEADLINE_MS = 30_000;

type FetchArgs = Parameters<typeof fetch>;

function envelopeBody(rows: Record<string, string>[]) {
  return JSON.stringify({
    data: rows,
    meta: {
      count: rows.length,
      labels: {},
      dataTypes: {},
      dataFormats: {},
      'total-count': rows.length,
      'total-pages': 1,
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  });
}

function jsonOk(body: string) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The API's error envelope, verbatim shape, for any non-2xx status. */
function errorBody(status: number, message?: string) {
  return new Response(
    JSON.stringify({ error: 'Invalid Query Param', ...(message && { message }) }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** Verified live against `page[number]=99999` on the debt endpoint. */
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
  return vi.fn(
    (_input: FetchArgs[0], init?: FetchArgs[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

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

describe('FiscalDataService.fetchPage — request deadline', () => {
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
    await vi.advanceTimersByTimeAsync(8 * DEADLINE_MS);

    expect(await settled).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  it('classifies a body-phase deadline expiry as Timeout', async () => {
    const fetchMock = stallingBodyFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {
      pageSize: 10_000,
    });
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(8 * DEADLINE_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(String((error as Error).message)).toContain(ENDPOINT);
  });

  it('retries a deadline expiry as a transient failure and reports exhaustion', async () => {
    const fetchMock = stallingBodyFetch();
    vi.stubGlobal('fetch', fetchMock);

    const pending = new FiscalDataService().fetchPage(createMockContext(), ENDPOINT, {});
    const settled = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(8 * DEADLINE_MS);

    const error = await settled;
    expect(String((error as Error).message)).toContain('failed after 4 attempts');
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

    // Nothing may fire after the exchange completes.
    await vi.advanceTimersByTimeAsync(4 * DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
