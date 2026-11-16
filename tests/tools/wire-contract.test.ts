/**
 * @fileoverview Pins the wire contract every tool in this server advertises and
 * answers on — the surface a client sees, as opposed to the domain behavior the
 * per-tool suites cover. Three properties are asserted here because the
 * framework, not this server, decides them, and a framework upgrade that
 * changes any of them changes what callers must send and can parse:
 *
 *   1. Tool input objects are strict — an undeclared key is rejected by name
 *      rather than stripped.
 *   2. No tool declares an `error` field on `output` or `enrichment`; that key
 *      is the failure envelope's on the wire.
 *   3. Both consumption paths carry the same information — `structuredContent`
 *      and `content[]` — on success, on enrichment, and on a failure the handler
 *      declares. An input rejected before the handler runs is the exception, and
 *      is scoped where it is asserted below.
 *
 * @module tests/tools/wire-contract.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { getDebtTool } from '@/mcp-server/tools/definitions/get-debt.tool.js';
import { getExchangeRatesTool } from '@/mcp-server/tools/definitions/get-exchange-rates.tool.js';
import { getInterestRatesTool } from '@/mcp-server/tools/definitions/get-interest-rates.tool.js';
import { listDatasetsTool } from '@/mcp-server/tools/definitions/list-datasets.tool.js';
import { queryDatasetTool } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { initFiscalDataService } from '@/services/fiscal-data/fiscal-data-service.js';

/** Every tool this server registers, with the name it is called by. */
const ALL_TOOLS = [
  { name: 'treasury_list_datasets', def: listDatasetsTool },
  { name: 'treasury_query_dataset', def: queryDatasetTool },
  { name: 'treasury_get_debt', def: getDebtTool },
  { name: 'treasury_get_interest_rates', def: getInterestRatesTool },
  { name: 'treasury_get_exchange_rates', def: getExchangeRatesTool },
  { name: 'treasury_dataframe_describe', def: dataframeDescribeTool },
  { name: 'treasury_dataframe_query', def: dataframeQueryTool },
  { name: 'treasury_dataframe_drop', def: dataframeDropTool },
];

/** The text of every `content[]` block a tool call produced, joined. */
function contentText(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type?: string; text?: string }[];
  return blocks.map((b) => b.text ?? '').join('\n');
}

describe('tool input objects are strict', () => {
  it.each(ALL_TOOLS)('$name rejects an undeclared root key by name', ({ def }) => {
    const parsed = def.input.safeParse({ notAParameter: 'x' });

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find((i) => i.code === 'unrecognized_keys');
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual([]);
    expect(issue?.message).toContain('notAParameter');
  });

  /**
   * Root-level strictness does not reach into a nested object, so a filter
   * condition carries its own. The stakes are higher here than at the root: a
   * stripped key inside a filter is a narrowing the caller believes they asked
   * for, and the rows come back looking like an answer.
   */
  it('treasury_query_dataset rejects an undeclared key inside a filter condition', () => {
    const parsed = queryDatasetTool.input.safeParse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      filters: [{ field: 'record_date', operator: 'eq', value: '2026-01-02', mode: 'exact' }],
    });

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find((i) => i.code === 'unrecognized_keys');
    expect(issue?.message).toContain('mode');
    expect(issue?.path).toEqual(['filters', 0]);
  });

  it('leaves a well-formed filter condition intact', () => {
    const parsed = queryDatasetTool.input.safeParse({
      endpoint: '/v2/accounting/od/debt_to_penny',
      filters: [{ field: 'record_date', operator: 'eq', value: '2026-01-02' }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.filters).toEqual([
      { field: 'record_date', operator: 'eq', value: '2026-01-02' },
    ]);
  });
});

/**
 * Wording that promises a deadline moves with use. A negation such as "queries
 * do not extend it" has no preposition or trigger after the verb, so it passes.
 */
const RENEWAL_CLAIM =
  /sliding|renew|refresh|reset|touched|kept alive|keeps? (?:it |the table )?alive|extend(?:s|ed)? (?:on|by|with|each|every|whenever)\b|\b(?:on|with|after|by) (?:each|every) (?:query|use|read|access|call)/i;

/**
 * A staged table's deadline is set once, at staging, and the shared canvas can
 * take the table with it earlier. A schema promising renewal by use tells a
 * caller an actively queried table cannot expire under it.
 */
describe('advertised table expiry', () => {
  it.each([
    'refreshed on each query',
    'a sliding expiry window',
    'renewed by use',
    'extended on every read',
    'each query resets the deadline',
    'touched on every access',
    'the deadline moves with each query',
    'kept alive while it is queried',
  ])('recognizes %j as a renewal claim', (wording) => {
    expect(wording).toMatch(RENEWAL_CLAIM);
  });

  it('passes the fixed-deadline wording, negation included', () => {
    expect('fixed when it was staged; queries do not extend it').not.toMatch(RENEWAL_CLAIM);
  });

  it('describes expires_at on treasury_dataframe_describe as fixed at staging', () => {
    const advertised = z
      .object({
        properties: z.object({
          dataframes: z.object({
            items: z.object({
              properties: z.object({ expires_at: z.object({ description: z.string() }) }),
            }),
          }),
        }),
      })
      .parse(z.toJSONSchema(dataframeDescribeTool.output));

    expect(advertised.properties.dataframes.items.properties.expires_at.description).toBe(
      'ISO 8601 time this table expires, fixed when it was staged; queries do not extend it. A server restart, or the shared canvas reaching its maximum lifetime, can remove the table sooner.',
    );
  });

  it.each(ALL_TOOLS)('$name never advertises expiry as renewed by use', ({ def }) => {
    const advertised = JSON.stringify([
      def.description,
      z.toJSONSchema(def.input),
      z.toJSONSchema(def.output),
    ]);

    expect(advertised).not.toMatch(RENEWAL_CLAIM);
  });
});

describe('`error` is reserved for the failure envelope', () => {
  it.each(ALL_TOOLS)('$name declares no `error` output field', ({ def }) => {
    expect(Object.keys(def.output.shape)).not.toContain('error');
  });

  it.each(ALL_TOOLS)('$name declares no `error` enrichment field', ({ def }) => {
    expect(Object.keys(def.enrichment ?? {})).not.toContain('error');
  });
});

/**
 * Scoped to the framework's handler wrapper, which is what `runToolContract`
 * drives. Over a real transport an undeclared key never reaches the wrapper:
 * `@modelcontextprotocol/server` validates arguments first and answers with a
 * text-only `isError` result carrying no `structuredContent` at all. That is
 * spec-legal — an error result is exempt from `outputSchema` — and the key is
 * still named in the text. So the guarantee a client can rely on for a rejected
 * argument is the `content[]` half; the envelope below is the wrapper's shape,
 * not a promise about the wire.
 */
describe('a rejected input fails through the handler wrapper', () => {
  it('names the offending key in the text a client reads', async () => {
    const result = await runToolContract(listDatasetsTool, { categoryy: 'debt' } as never);

    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain('categoryy');
    const envelope = result.structuredContent as { error?: { message?: string } };
    expect(envelope.error?.message).toContain('categoryy');
  });

  it('carries no success payload alongside the failure', async () => {
    const result = await runToolContract(listDatasetsTool, { categoryy: 'debt' } as never);

    expect(Object.keys(result.structuredContent ?? {})).toEqual(['error']);
  });
});

describe('a declared failure reaches both surfaces', () => {
  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  });

  it('publishes the contract reason and recovery hint in structuredContent', async () => {
    const result = await runToolContract(dataframeDescribeTool, {});

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      error?: {
        code?: number;
        message?: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    };
    expect(envelope.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.error?.data?.reason).toBe('canvas_unavailable');
    expect(envelope.error?.data?.recovery?.hint).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(envelope.error?.message).toContain('DataCanvas is not configured');
  });

  /**
   * A client that forwards only `content[]` sees no `data.reason` at all, so the
   * recovery hint has to be rendered into the text too — otherwise the agent is
   * told the call failed and nothing about what to do next.
   */
  it('renders the same message and hint into content[]', async () => {
    const text = contentText(await runToolContract(dataframeDescribeTool, {}));

    expect(text).toContain('DataCanvas is not configured');
    expect(text).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('reports the same reason from treasury_dataframe_query', async () => {
    const result = await runToolContract(dataframeQueryTool, { sql: 'SELECT 1' });

    const envelope = result.structuredContent as { error?: { data?: { reason?: string } } };
    expect(result.isError).toBe(true);
    expect(envelope.error?.data?.reason).toBe('canvas_unavailable');
  });
});

/**
 * The framework keeps a captured upstream error body off client envelopes, so
 * the Fiscal Data API's own explanation reaches a caller only through the
 * error message this server builds from it.
 *
 * The fixture is the API's legacy rejection shape — HTTP 400 with
 * `{"error":"Invalid Query Param","message":"…"}`. The live API no longer
 * answers an unknown field this way; the test keeps the server reading that
 * shape should it come back.
 */
describe("the upstream's rejection text reaches both surfaces", () => {
  const UPSTREAM_MESSAGE = "Invalid query parameter: Field 'field_does_not_exist' does not exist.";

  beforeEach(() => {
    initFiscalDataService();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: 'Invalid Query Param', message: UPSTREAM_MESSAGE }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the API message in structuredContent and content[]', async () => {
    const result = await runToolContract(queryDatasetTool, {
      endpoint: '/v2/accounting/od/debt_to_penny',
      fields: ['field_does_not_exist'],
      page_size: 1,
    });

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      error?: { message?: string; data?: { reason?: string } };
    };
    expect(envelope.error?.data?.reason).toBe('invalid_field');
    expect(envelope.error?.message).toBe(`Invalid field: ${UPSTREAM_MESSAGE}`);
    expect(contentText(result)).toContain(UPSTREAM_MESSAGE);
  });
});

describe('a success reaches both surfaces', () => {
  it('carries the domain payload in structuredContent and the render in content[]', async () => {
    const result = await runToolContract(listDatasetsTool, { category: 'debt' });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as { datasets?: unknown[]; total?: number };
    expect(payload.datasets?.length).toBeGreaterThan(0);
    expect(payload.total).toBe(payload.datasets?.length);
    expect(contentText(result)).toContain('/v2/accounting/od/debt_to_penny');
  });

  it('leaves no `error` key on a successful result', async () => {
    const result = await runToolContract(listDatasetsTool, {});

    expect(result.structuredContent).not.toHaveProperty('error');
  });

  it('renders absence as absence rather than an empty table', async () => {
    const result = await runToolContract(listDatasetsTool, { search: 'xyzzy_no_match_12345' });

    expect((result.structuredContent as { total?: number }).total).toBe(0);
    expect(contentText(result)).toContain('No matching datasets.');
  });
});

describe('enrichment reaches both surfaces', () => {
  it('publishes an empty-result notice in structuredContent and in the content trailer', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      query: vi.fn().mockResolvedValue({
        result: { columns: ['record_date'], rowCount: 0, rows: [], tableName: undefined },
      }),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const result = await runToolContract(dataframeQueryTool, {
      sql: 'SELECT record_date FROM df_ABCDE_FGHIJ',
    });

    const payload = result.structuredContent as { notice?: string; row_count?: number };
    expect(payload.row_count).toBe(0);
    expect(payload.notice).toContain('treasury_dataframe_describe');
    expect(contentText(result)).toContain('treasury_dataframe_describe');
  });
});
