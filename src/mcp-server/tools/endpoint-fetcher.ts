/**
 * @fileoverview The request function each convenience tool sends every request
 * through. It binds the call's one fetch budget, reads the service's query
 * rejections as the tool's own, and checks that a 200 still lists the fields
 * the tool reads.
 * @module mcp-server/tools/endpoint-fetcher
 */

import type { Context, TypedFail } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type FiscalDataService,
  getFiscalDataService,
} from '@/services/fiscal-data/fiscal-data-service.js';
import type { FiscalDataEnvelope } from '@/services/fiscal-data/types.js';

/** What one request selects and pages; the fetcher adds the call's shared budget. */
export type PageOptions = Omit<
  NonNullable<Parameters<FiscalDataService['fetchPage']>[2]>,
  'budgetStart'
>;

/** One request to the tool's endpoint, on the call's one fetch budget. */
export type EndpointFetcher = (options: PageOptions) => Promise<FiscalDataEnvelope>;

interface EndpointFetcherOptions {
  /** Epoch ms the tool call began; every request draws on the budget that began then. */
  budgetStart: number;
  ctx: Context & { fail: TypedFail<'invalid_filter' | 'upstream_schema_changed'> };
  endpoint: string;
  /** The tool input a refused filter value on `field` came from. */
  inputFor: (field: string, value: string) => string;
  /** Every field the tool reads from a row of a request that selects no fields. */
  reads: readonly string[];
}

/**
 * Every field name, operator, and sort term a convenience tool sends is fixed in
 * its source; the caller supplies only values. So the service's `invalid_field`
 * is the API's schema moving, and becomes `upstream_schema_changed`. Its
 * `invalid_filter` naming a field and value is the pre-flight refusal of a
 * comma inside a value, and is re-raised naming the tool input the value came
 * from. Every other failure passes through.
 *
 * A 200 is read too: `meta.labels` lists every field a request selected, or
 * every field the endpoint has when it selected none, so each field the request
 * selected — else each in `reads` — must be there. A missing one is the schema
 * moving under a row read that would otherwise turn it into an empty value.
 */
export function createEndpointFetcher({
  budgetStart,
  ctx,
  endpoint,
  inputFor,
  reads,
}: EndpointFetcherOptions): EndpointFetcher {
  const svc = getFiscalDataService();
  return async (options) => {
    let envelope: FiscalDataEnvelope;
    try {
      envelope = await svc.fetchPage(ctx, endpoint, { ...options, budgetStart });
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      const { reason, field, value } = error.data ?? {};
      if (reason === 'invalid_field') {
        throw ctx.fail('upstream_schema_changed', error.message, { endpoint }, { cause: error });
      }
      if (reason === 'invalid_filter' && typeof field === 'string' && typeof value === 'string') {
        const input = inputFor(field, value);
        throw ctx.fail(
          'invalid_filter',
          `${input} value ${JSON.stringify(value)} contains a comma, so the call was refused before any request: the API reads a comma inside a filter value as the start of another condition.`,
          { endpoint, input, value },
          { cause: error },
        );
      }
      throw error;
    }

    const listed = Object.keys(envelope.meta?.labels ?? {});
    const required = options.fields?.length ? options.fields : reads;
    const missing = required.filter((name) => !listed.includes(name));
    if (missing.length > 0) {
      const names = missing.map((name) => JSON.stringify(name)).join(', ');
      const lead =
        missing.length > 1
          ? `Fields ${names} this tool reads are gone`
          : `Field ${names} this tool reads is gone`;
      const fieldList =
        listed.length > 0
          ? `The response lists ${listed.length} fields: ${listed.join(', ')}.`
          : 'The response lists no fields.';
      throw ctx.fail(
        'upstream_schema_changed',
        `${lead} from endpoint "${endpoint}". ${fieldList}`,
        {
          endpoint,
        },
      );
    }
    return envelope;
  };
}
