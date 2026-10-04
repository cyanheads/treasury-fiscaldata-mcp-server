/**
 * @fileoverview Opt-in removal of a staged Treasury dataframe and its provenance.
 * @module mcp-server/tools/definitions/dataframe-drop
 */
import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const definition = tool('treasury_dataframe_drop', {
  title: 'Drop Treasury Dataframe',
  description:
    'Delete one staged Treasury dataframe and its provenance from this tenant’s DataCanvas. Use the exact name returned as canvas_id by a data tool, registered_as by treasury_dataframe_query, or name by treasury_dataframe_describe. This removes local staged data only; it does not change Treasury data upstream. Requires CANVAS_PROVIDER_TYPE=duckdb and TREASURY_DATAFRAME_DROP_ENABLED=true.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    name: z
      .string()
      .min(1)
      .regex(/\S/)
      .describe(
        'Exact dataframe table name from treasury_dataframe_describe, a data tool’s canvas_id, or treasury_dataframe_query registered_as. Must contain at least one non-whitespace character.',
      ),
  }),
  output: z.object({
    name: z.string().describe('Name of the dataframe that was removed.'),
    dropped: z.boolean().describe('True when the dataframe was removed.'),
  }),
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not configured on this server',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable DataCanvas.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The named dataframe expired, was dropped, or does not exist for this tenant',
      recovery:
        'Call treasury_dataframe_describe to list the dataframes still available for this tenant.',
    },
  ],
  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge)
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    if (!(await bridge.drop(ctx, input.name))) {
      throw ctx.fail('missing_table', `Dataframe "${input.name}" does not exist for this tenant.`, {
        tableName: input.name,
      });
    }
    return { name: input.name, dropped: true };
  },
  format: (result) => [
    { type: 'text', text: `Dropped dataframe ${result.name}. dropped: ${result.dropped}` },
  ],
});

/** Advertise the disabled capability to operators without registering a callable tool. */
export const dataframeDropTool = getServerConfig().dataframeDropEnabled
  ? definition
  : disabledTool(definition, {
      reason: 'Dropping staged dataframes is disabled in this deployment.',
      hint: 'TREASURY_DATAFRAME_DROP_ENABLED=true',
    });
