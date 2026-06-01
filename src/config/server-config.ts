/**
 * @fileoverview Server-specific configuration for Treasury Fiscal Data API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  /** Per-table TTL for canvas-registered dataframes, in seconds. */
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(86400)
    .describe('Per-table TTL for canvas-registered dataframes, in seconds.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    // CANVAS_TTL_MS is in milliseconds; convert to seconds for the dataframe bridge.
    datasetTtlSeconds: process.env.CANVAS_TTL_MS
      ? Math.floor(Number(process.env.CANVAS_TTL_MS) / 1000)
      : undefined,
  });
  return _config;
}
