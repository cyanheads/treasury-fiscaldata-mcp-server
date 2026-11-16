/**
 * @fileoverview HTTP service for the US Treasury Fiscal Data API.
 * Handles query construction, response parsing, and error classification —
 * including telling a rejected query from a missing endpoint, which the API
 * answers with the same 404. The API is keyless; all endpoints share the same
 * query grammar.
 * @module services/fiscal-data/fiscal-data-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpStatusToErrorCode, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { FilterCondition, FiscalDataEnvelope } from './types.js';

/** Root of every Fiscal Data endpoint path. Exported so the catalog verifier probes the same host. */
export const BASE_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

/** One HTTP exchange, headers and body, before it is abandoned as a transient failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Everything one tool call's requests may spend together: every attempt,
 * backoff, and probe of the `fetchPage` calls that pass the same `budgetStart`;
 * a call that passes none gets a budget of its own. MCP clients abandon a
 * request at 60 s; the remainder is left for the handler's own work and the
 * transport.
 */
const FETCH_DEADLINE_MS = 50_000;

const INVALID_FIELD_HINT =
  'Replace each unknown name with one of the field names this error lists for the endpoint.';
/** The legacy 400 body names the unknown field and lists none; a bare query lists them all. */
const INVALID_FIELD_400_HINT =
  'Call treasury_query_dataset on this endpoint with page_size 1 and no fields, filters, or sort; its field_labels and table header name every field the endpoint has. Replace the unknown name with one of them.';
/**
 * What is left once every name exists and every sort field is selected. A
 * merely malformed value matches nothing instead of failing, the generic tool's
 * operator is an enum, and that tool refuses a comma inside a value before
 * sending, so none of those is worth pointing at: the caller finds the
 * expression by elimination.
 */
const INVALID_FILTER_HINT =
  'Resend without sort, then with one filter at a time, to find the expression the API refuses.';
const PAGE_OUT_OF_RANGE_HINT =
  'Request a page within total_pages, which the API reports alongside total_count for this query.';
const SORT_FIELD_NOT_SELECTED_HINT = 'Add each sort field to fields, or omit fields.';
const COMMA_IN_FILTER_VALUE_HINT =
  'Remove the comma: write numbers without thousands separators (1000, not 1,000). A text value that itself contains a comma cannot be matched exactly; filter on another field.';

const HTML_DOCUMENT = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/** The API's JSON error body; only the message is read. */
const ApiErrorBodySchema = z.object({ message: z.string() });

/** A bare request's answer, read for its `meta.labels` keys: one per field the endpoint has. */
const FieldLabelsSchema = z.object({
  meta: z.object({ labels: z.record(z.string(), z.unknown()) }),
});

/** The selection and page one request asks for, and the budget it draws on. */
interface PageOptions {
  /**
   * Epoch ms the tool invocation began. Calls passing the same value share one
   * {@link FETCH_DEADLINE_MS} budget; a call without it starts a budget of its own.
   */
  budgetStart?: number | undefined;
  fields?: string[] | undefined;
  filters?: FilterCondition[] | undefined;
  pageNumber?: number | undefined;
  pageSize?: number | undefined;
  sort?: string | undefined;
}

/** An HTTP answer with its body already read. */
interface Exchange {
  body: string;
  ok: boolean;
  status: number;
}

export class FiscalDataService {
  /** Build the filter= query-string segment from an array of conditions. */
  buildFilterParam(filters: FilterCondition[]): string {
    return filters
      .map((f) => {
        if (f.operator === 'in') {
          const vals = Array.isArray(f.value) ? f.value : [f.value];
          return `${f.field}:in:(${vals.join(',')})`;
        }
        const val = Array.isArray(f.value) ? f.value[0] : f.value;
        return `${f.field}:${f.operator}:${val}`;
      })
      .join(',');
  }

  /**
   * Fetch one page from a Fiscal Data endpoint. Transient failures are retried
   * within what is left of the {@link FETCH_DEADLINE_MS} budget that began at
   * `options.budgetStart`, which expires as a `Timeout` with reason
   * `retry_deadline_exceeded` — without sending a request when nothing is
   * left. A caller cancellation is rethrown as it arrived. A failure is
   * classified by status, never by content type:
   * - 404 → `invalid_endpoint` for a request with no fields, filter, sort, or
   *   later page; otherwise a bare probe decides ({@link classifyRejectedQuery})
   * - 4xx JSON `{"error":…,"message":…}` naming a field, an operator, or a page
   *   → `invalid_field` / `invalid_filter` / `page_out_of_range`
   * - 5xx → retryable `ServiceUnavailable`; any other 4xx → that status's code
   * - 200 with `data: []` → the envelope (the caller checks total-count)
   */
  async fetchPage(
    ctx: Context,
    endpoint: string,
    options: PageOptions = {},
  ): Promise<FiscalDataEnvelope> {
    assertNoCommaInFilterValues(endpoint, options.filters);
    const url = this.buildUrl(endpoint, options);
    const now = Date.now();
    const spentMs = now - (options.budgetStart ?? now);
    const deadlineMs = FETCH_DEADLINE_MS - spentMs;
    if (deadlineMs <= 0) {
      ctx.signal.throwIfAborted();
      throw timeout(
        `Fiscal Data request for endpoint "${endpoint}" was not sent: earlier requests in this tool call spent its ${FETCH_DEADLINE_MS}ms budget.`,
        {
          reason: 'retry_deadline_exceeded',
          deadlineMs: 0,
          elapsedMs: 0,
          retryAttempts: 0,
          endpoint,
        },
      );
    }
    ctx.log.debug('Fetching Fiscal Data', { endpoint });

    return await withRetry(
      async ({ signal }) => {
        const response = await this.exchange(url, endpoint, signal);
        if (!response.ok) throw await this.rejection(response, endpoint, options, signal);
        return parseEnvelope(response.body, endpoint);
      },
      {
        /**
         * `withRetry` names this operation and the deadline it was given when
         * the deadline expires. A later call's deadline is the remainder of the
         * tool call's budget, so the label names that budget, or the remainder
         * reads as a per-request limit.
         */
        operation:
          spentMs > 0
            ? `Fiscal Data request for endpoint "${endpoint}" (${spentMs}ms into this tool call's ${FETCH_DEADLINE_MS}ms budget)`
            : `Fiscal Data request for endpoint "${endpoint}"`,
        baseDelayMs: 500,
        deadlineMs,
        signal: ctx.signal,
      },
    );
  }

  /**
   * One HTTP exchange, bounded by {@link REQUEST_TIMEOUT_MS} and by `signal` —
   * the retry deadline and the caller's cancellation together. The timer stays
   * armed until the body has been read: `fetch` resolves at headers, so an
   * upstream that stalls mid-body would otherwise hold the request open.
   */
  private async exchange(url: string, endpoint: string, signal: AbortSignal): Promise<Exchange> {
    const controller = new AbortController();
    /**
     * Abort with a held `TimeoutError` rather than a bare abort: `fetch` and the
     * body stream reject with the abort *reason*, so identity separates this
     * timer (classified `Timeout`, which `withRetry` retries) from the retry
     * deadline or a caller cancellation (rethrown untouched for `withRetry`,
     * which reports the one and passes the other through).
     */
    const timeoutReason = new DOMException(
      `Fiscal Data request exceeded ${REQUEST_TIMEOUT_MS}ms.`,
      'TimeoutError',
    );
    const timer = setTimeout(() => controller.abort(timeoutReason), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, controller.signal]),
        headers: { Accept: 'application/json' },
      });
      return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.reason === timeoutReason) {
        throw timeout(
          `Fiscal Data request for endpoint "${endpoint}" exceeded ${REQUEST_TIMEOUT_MS}ms.`,
          { endpoint },
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The error for a non-2xx answer. */
  private async rejection(
    response: Exchange,
    endpoint: string,
    options: PageOptions,
    signal: AbortSignal,
  ): Promise<McpError> {
    const { status } = response;
    if (status === 404) {
      return carriesQuery(options)
        ? await this.classifyRejectedQuery(endpoint, options, signal)
        : invalidEndpoint(endpoint);
    }

    const parsed = ApiErrorBodySchema.safeParse(parseJson(response.body));
    const msg = parsed.success && parsed.data.message !== '' ? parsed.data.message : undefined;
    if (msg && status < 500) {
      const classified = classifyQueryParamMessage(msg, endpoint);
      if (classified) return classified;
    }

    /**
     * The status class decides retryability; the message patterns above only
     * pick a more specific reason. A 4xx is the API's verdict on the request as
     * written, so it carries a client-error code that `withRetry` treats as
     * terminal — except 408/425/429, which the status map keeps transient
     * because waiting is exactly the remedy. A 5xx, an outage page included,
     * keeps its retry budget.
     */
    const message = msg
      ? `Fiscal Data API error: ${msg}`
      : `Fiscal Data API returned HTTP ${status} for endpoint "${endpoint}".`;
    if (status >= 500) return serviceUnavailable(message, { status, endpoint, retryable: true });
    return new McpError(
      httpStatusToErrorCode(status) ?? JsonRpcErrorCode.ServiceUnavailable,
      message,
      { status, endpoint },
    );
  }

  /**
   * The API answers a rejected query — an unknown name in `fields`, a filter, or
   * `sort`, a sort field `fields` leaves out, or a page past the end — with the
   * same 404 it gives a missing path. One bare request to the same path tells
   * them apart: a 404 there means the path is missing, and a 200 lists every
   * field the endpoint has in `meta.labels`, catalogued or not. The verdicts
   * then run from the most specific fault to the least: an unknown name, an
   * unselected sort field, a later page, and last the filter or sort expression
   * — or, when page 1 carried only `fields`, a transient 404, since nothing in
   * that request is one the API rejects. The probe shares the attempt's signal
   * and its own request timer and is never retried on its own: one that cannot
   * answer is a transient failure of the attempt, which `withRetry` repeats
   * within the fetch deadline.
   */
  private async classifyRejectedQuery(
    endpoint: string,
    options: PageOptions,
    signal: AbortSignal,
  ): Promise<McpError> {
    const probeUrl = `${BASE_URL}${endpoint}?${new URLSearchParams({ 'page[size]': '1' })}`;
    let probe: Exchange;
    try {
      probe = await this.exchange(probeUrl, endpoint, signal);
    } catch (error) {
      // A caller cancellation or the expired deadline — withRetry's to report.
      if (signal.aborted) throw error;
      const ownTimeout = error instanceof McpError && error.code === JsonRpcErrorCode.Timeout;
      return probeFailed(
        endpoint,
        ownTimeout ? `no answer within ${REQUEST_TIMEOUT_MS}ms` : 'the request failed',
        error,
      );
    }

    if (probe.status === 404) return invalidEndpoint(endpoint);
    if (probe.status !== 200) return probeFailed(endpoint, `HTTP ${probe.status}`);

    const labels = FieldLabelsSchema.safeParse(parseJson(probe.body));
    const fields = labels.success ? Object.keys(labels.data.meta.labels) : [];
    if (fields.length === 0) {
      return probeFailed(
        endpoint,
        HTML_DOCUMENT.test(probe.body) ? 'an HTML page instead of JSON' : 'no field list',
      );
    }

    const known = new Set(fields);
    const unknown = [...new Set(requestedNames(options))].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return validationError(
        `Unknown field name${unknown.length > 1 ? 's' : ''} on endpoint "${endpoint}": ${unknown.map((name) => JSON.stringify(name)).join(', ')}. The endpoint has ${fields.length} fields: ${fields.join(', ')}.`,
        { reason: 'invalid_field', endpoint, recovery: { hint: INVALID_FIELD_HINT } },
      );
    }
    const unselected = unselectedSortFields(options);
    if (unselected.length > 0) {
      const names = unselected.map((name) => JSON.stringify(name)).join(', ');
      return validationError(
        `${unselected.length > 1 ? `Sort fields ${names} are` : `Sort field ${names} is`} not among the requested fields; the API sorts only by fields it returns.`,
        {
          reason: 'sort_field_not_selected',
          endpoint,
          recovery: { hint: SORT_FIELD_NOT_SELECTED_HINT },
        },
      );
    }
    if ((options.pageNumber ?? 1) > 1) {
      return validationError(
        `Page ${options.pageNumber} is past the last page of this query's results on endpoint "${endpoint}".`,
        { reason: 'page_out_of_range', endpoint, recovery: { hint: PAGE_OUT_OF_RANGE_HINT } },
      );
    }
    // Names that all exist on page 1 with no filter or sort leave nothing the API rejects: a transient 404.
    if (!options.filters?.length && !options.sort) {
      return serviceUnavailable(
        `The Fiscal Data API answered 404 for a query on endpoint "${endpoint}" whose every field name exists and that asks for nothing else.`,
        { endpoint, retryable: true },
      );
    }
    return validationError(
      `The Fiscal Data API rejected the filter or sort on endpoint "${endpoint}". Every field name in the query exists there, so the expression itself was refused.`,
      { reason: 'invalid_filter', endpoint, recovery: { hint: INVALID_FILTER_HINT } },
    );
  }

  /** Build a full URL from an endpoint path and query parameters. */
  private buildUrl(endpoint: string, options: PageOptions): string {
    const params = new URLSearchParams();

    if (options.fields?.length) {
      params.set('fields', options.fields.join(','));
    }
    if (options.filters?.length) {
      params.set('filter', this.buildFilterParam(options.filters));
    }
    if (options.sort) {
      params.set('sort', options.sort);
    }
    const pageSize = options.pageSize ?? 100;
    const pageNumber = options.pageNumber ?? 1;
    params.set('page[size]', String(pageSize));
    params.set('page[number]', String(pageNumber));

    const qs = params.toString();
    return `${BASE_URL}${endpoint}${qs ? `?${qs}` : ''}`;
  }
}

/** `text` parsed as JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

/** A 200's body as the response envelope. */
function parseEnvelope(body: string, endpoint: string): FiscalDataEnvelope {
  // An HTML page masquerading as success.
  if (HTML_DOCUMENT.test(body)) {
    throw serviceUnavailable('Fiscal Data API returned HTML instead of JSON.', {
      endpoint,
      retryable: false,
    });
  }
  const envelope = parseJson(body);
  if (envelope === undefined) {
    throw serviceUnavailable('Failed to parse Fiscal Data API response.', {
      endpoint,
      retryable: false,
    });
  }
  return envelope as FiscalDataEnvelope;
}

/**
 * Whether the request carries anything the API can reject while the path
 * itself exists. Mirrors what {@link FiscalDataService.buildUrl} sends.
 */
function carriesQuery(options: PageOptions): boolean {
  return (
    Boolean(options.fields?.length || options.filters?.length || options.sort) ||
    (options.pageNumber ?? 1) > 1
  );
}

/**
 * Refuse a filter value carrying a comma, before any request. The API reads a
 * comma inside a value as the start of another condition, so no value can
 * carry one: `record_date:eq:2024-01-03,src_line_nbr:eq:1` answers with the
 * rows of a query the caller never wrote, and `tot_pub_debt_out_amt:gt:1,000`
 * fails upstream. Every tool builds its filters through `fetchPage`, so caller
 * values the convenience tools pass into filters are checked here too.
 */
function assertNoCommaInFilterValues(endpoint: string, filters: FilterCondition[] | undefined) {
  for (const { field, value } of filters ?? []) {
    const withComma = (Array.isArray(value) ? value : [value]).find((v) => v.includes(','));
    if (withComma === undefined) continue;
    throw validationError(
      `Filter value ${JSON.stringify(withComma)} for field ${JSON.stringify(field)} contains a comma; the API reads a comma inside a value as the start of another condition, so no value can contain one.`,
      {
        reason: 'invalid_filter',
        endpoint,
        field,
        value: withComma,
        recovery: { hint: COMMA_IN_FILTER_VALUE_HINT },
      },
    );
  }
}

/** Every field name the request sends: `fields`, each filter's field, each sort field. */
function requestedNames(options: PageOptions): string[] {
  return [
    ...(options.fields ?? []),
    ...(options.filters ?? []).map((f) => f.field),
    ...sortFields(options.sort),
  ];
}

/**
 * Each sort term less its "-", as sent: the API strips no other prefix and no
 * whitespace, so a term carrying either names a field the endpoint lacks.
 */
function sortFields(sort: string | undefined): string[] {
  return sort ? sort.split(',').map((term) => term.replace(/^-/, '')) : [];
}

/**
 * The sort fields a request with `fields` set does not select, once each. The
 * API returns only the selected fields and sorts only by those, so it rejects
 * such a query; with no `fields` every field is returned and any sort holds.
 */
function unselectedSortFields(options: PageOptions): string[] {
  if (!options.fields?.length) return [];
  const selected = new Set(options.fields);
  return [...new Set(sortFields(options.sort))].filter((name) => !selected.has(name));
}

function invalidEndpoint(endpoint: string): McpError {
  return validationError(
    `Endpoint "${endpoint}" does not exist. Call treasury_list_datasets to find the correct endpoint path.`,
    {
      reason: 'invalid_endpoint',
      endpoint,
      recovery: { hint: 'Call treasury_list_datasets to find the correct endpoint path.' },
    },
  );
}

/** A rejected query whose probe could not say why; `withRetry` repeats the attempt. */
function probeFailed(endpoint: string, detail: string, cause?: unknown): McpError {
  return serviceUnavailable(
    `The Fiscal Data API rejected the query on endpoint "${endpoint}" (HTTP 404), and the check of whether that endpoint exists did not complete (${detail}).`,
    { endpoint, retryable: true },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The reason a 4xx JSON error message names, from the API's earlier rejection
 * shape: `{"error":"Invalid Query Param","message":"…"}`.
 */
function classifyQueryParamMessage(msg: string, endpoint: string): McpError | undefined {
  if (/field/i.test(msg) && /does not exist/i.test(msg)) {
    return validationError(`Invalid field: ${msg}`, {
      reason: 'invalid_field',
      endpoint,
      recovery: { hint: INVALID_FIELD_400_HINT },
    });
  }
  if (/operator/i.test(msg)) {
    return validationError(`Invalid filter operator: ${msg}`, {
      reason: 'invalid_filter',
      endpoint,
      recovery: { hint: INVALID_FILTER_HINT },
    });
  }
  if (/page/i.test(msg) && /out of range/i.test(msg)) {
    return validationError(`Page out of range: ${msg}`, {
      reason: 'page_out_of_range',
      endpoint,
      recovery: { hint: PAGE_OUT_OF_RANGE_HINT },
    });
  }
  return;
}

// ── init/accessor pattern ────────────────────────────────────────────────────

let _service: FiscalDataService | undefined;

export function initFiscalDataService(): void {
  _service = new FiscalDataService();
}

export function getFiscalDataService(): FiscalDataService {
  if (!_service) {
    throw new Error('FiscalDataService not initialized — call initFiscalDataService() in setup()');
  }
  return _service;
}
