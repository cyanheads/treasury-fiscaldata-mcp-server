/**
 * @fileoverview Server-specific configuration for Treasury Fiscal Data API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  /** Per-table TTL for canvas-registered dataframes, in seconds. */
  datasetTtlSeconds: z.coerce
    .number()
    .transform((milliseconds) => Math.floor(milliseconds / 1000))
    .pipe(z.number().int().min(60))
    .default(86400)
    .describe('Per-table TTL for canvas-registered dataframes, in seconds.'),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe('Enable the tool that drops staged Treasury dataframes.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    datasetTtlSeconds: 'CANVAS_TTL_MS',
    dataframeDropEnabled: 'TREASURY_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
