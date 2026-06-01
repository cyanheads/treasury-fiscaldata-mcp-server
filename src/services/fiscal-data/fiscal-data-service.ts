/**
 * @fileoverview HTTP service for the US Treasury Fiscal Data API.
 * Handles query construction, response parsing, and error classification.
 * The API is keyless; all endpoints share the same query grammar.
 * @module services/fiscal-data/fiscal-data-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { FilterCondition, FiscalDataEnvelope } from './types.js';

const BASE_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';
const DEFAULT_TIMEOUT_MS = 30_000;

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
   * Fetch one page from a Fiscal Data endpoint. Handles the three error shapes:
   * - HTML on 404 (invalid path) → throws with reason 'invalid_endpoint'
   * - JSON {"error":…} on 400 (bad field/operator) → throws with structured reason
   * - 200 with data:[] → returns the envelope (caller checks total-count)
   */
  async fetchPage(
    ctx: Context,
    endpoint: string,
    options: {
      fields?: string[] | undefined;
      filters?: FilterCondition[] | undefined;
      sort?: string | undefined;
      pageSize?: number | undefined;
      pageNumber?: number | undefined;
    } = {},
  ): Promise<FiscalDataEnvelope> {
    const url = this.buildUrl(endpoint, options);
    ctx.log.debug('Fetching Fiscal Data', { url });

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, {
            signal: ctx.signal
              ? AbortSignal.any([ctx.signal, controller.signal])
              : controller.signal,
            headers: { Accept: 'application/json' },
          });
        } finally {
          clearTimeout(timeoutId);
        }

        const contentType = response.headers.get('content-type') ?? '';

        // 404 returns HTML — detect by content-type before parsing
        if (!response.ok) {
          if (contentType.includes('text/html') || response.status === 404) {
            throw validationError(
              `Endpoint "${endpoint}" does not exist. Call treasury_list_datasets to find the correct endpoint path.`,
              {
                reason: 'invalid_endpoint',
                endpoint,
                recovery: {
                  hint: 'Call treasury_list_datasets to find the correct endpoint path.',
                },
              },
            );
          }
          // Attempt to parse JSON error body (400 responses)
          const text = await response.text();
          let parsed: { error?: string; message?: string } = {};
          try {
            parsed = JSON.parse(text) as { error?: string; message?: string };
          } catch {
            // fall through
          }
          if (parsed.message) {
            const msg = parsed.message;
            if (/field/i.test(msg) && /does not exist/i.test(msg)) {
              throw validationError(`Invalid field: ${msg}`, {
                reason: 'invalid_field',
                recovery: {
                  hint: 'Call treasury_list_datasets with the endpoint to see available field names.',
                },
              });
            }
            if (/operator/i.test(msg)) {
              throw validationError(`Invalid filter operator: ${msg}`, {
                reason: 'invalid_filter',
                recovery: {
                  hint: 'Supported operators: eq, gt, gte, lt, lte, in. Dates use YYYY-MM-DD.',
                },
              });
            }
            throw serviceUnavailable(`Fiscal Data API error: ${msg}`, {
              status: response.status,
              endpoint,
            });
          }
          throw serviceUnavailable(
            `Fiscal Data API returned HTTP ${response.status} for endpoint "${endpoint}".`,
            { status: response.status, endpoint },
          );
        }

        // Parse JSON — 200 response
        const text = await response.text();
        // Detect HTML masquerading as success
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('Fiscal Data API returned HTML instead of JSON.', {
            endpoint,
            retryable: false,
          });
        }

        let envelope: FiscalDataEnvelope;
        try {
          envelope = JSON.parse(text) as FiscalDataEnvelope;
        } catch {
          throw serviceUnavailable('Failed to parse Fiscal Data API response.', {
            endpoint,
            retryable: false,
          });
        }

        return envelope;
      },
      {
        operation: 'FiscalDataService.fetchPage',
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /** Build a full URL from an endpoint path and query parameters. */
  private buildUrl(
    endpoint: string,
    options: {
      fields?: string[] | undefined;
      filters?: FilterCondition[] | undefined;
      sort?: string | undefined;
      pageSize?: number | undefined;
      pageNumber?: number | undefined;
    },
  ): string {
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
