/**
 * @fileoverview Fake Fiscal Data API answers for tests that run the real
 * `FiscalDataService` behind a stubbed `fetch`. A pending answer rejects with
 * the request signal's reason once that signal aborts, as `fetch` does, so the
 * service's own timers, retry ladder, and deadline decide when a call settles.
 * @module tests/helpers/fiscal-data-upstream
 */

/** One upstream answer, given the request's init so it can watch the signal. */
export type Answer = (init?: Parameters<typeof fetch>[1]) => Promise<Response>;

/** Never sends headers — rejects with the signal's reason once the request is aborted. */
export const hang: Answer = (init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Answers with `make()` `delayMs` after the request, unless the request is aborted first. */
export function delayed(delayMs: number, make: () => Response): Answer {
  return (init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), delayMs);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
}

/** `meta.labels` as the API sends it for `fields`. */
export function labelsFor(fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f, `Label for ${f}`]));
}

/**
 * A response envelope carrying `rows`, its `total-count` reporting `totalCount`.
 * `labelFields` keys `meta.labels`; the default lists none.
 */
export function envelopeBody(
  rows: Record<string, string>[],
  totalCount = rows.length,
  labelFields: readonly string[] = [],
): string {
  return JSON.stringify({
    data: rows,
    meta: {
      count: rows.length,
      labels: labelsFor(labelFields),
      dataTypes: {},
      dataFormats: {},
      'total-count': totalCount,
      'total-pages': Math.max(1, Math.ceil(totalCount / Math.max(1, rows.length))),
    },
    links: { self: '', first: null, prev: null, next: null, last: null },
  });
}

export function jsonOk(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

const API_ROOT = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

/** The bare request that classifies a rejected query: same path, one row, nothing else. */
export function probeUrl(endpoint: string): string {
  return `${API_ROOT}${endpoint}?page%5Bsize%5D=1`;
}

/**
 * What the API answers for a missing path and for every rejected query alike —
 * an unknown field, filter, or sort name, or a page past the end.
 */
export function notFoundText(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** An error page from the CDN in front of the API (outage or bot check). */
export function htmlPage(status: number): Response {
  return new Response('<!DOCTYPE html><html><body>Service Unavailable</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** A bare request's 200: one row, and `meta.labels` keyed by every field the endpoint has. */
export function labelsOk(fields: string[]): Response {
  return jsonOk(
    JSON.stringify({
      data: [Object.fromEntries(fields.map((f) => [f, 'null']))],
      meta: {
        count: 1,
        labels: labelsFor(fields),
        dataTypes: {},
        dataFormats: {},
        'total-count': 8369,
        'total-pages': 8369,
      },
      links: { self: '', first: null, prev: null, next: null, last: null },
    }),
  );
}

/**
 * Every sort term a recorded `fetchPage` call sends that its own `fields` leaves
 * out. The API answers such a request with a 404, so the list must stay empty.
 */
export function unselectedSortTerms(calls: readonly (readonly unknown[])[]): string[] {
  return calls.flatMap((call) => {
    const opts = call[2] as { fields?: string[]; sort?: string } | undefined;
    if (!opts?.sort || !opts.fields?.length) return [];
    const fields = opts.fields;
    return opts.sort
      .split(',')
      .map((term) => term.replace(/^-/, ''))
      .filter((name) => !fields.includes(name));
  });
}
