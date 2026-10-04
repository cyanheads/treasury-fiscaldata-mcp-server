/**
 * @fileoverview Environment normalization and dataframe feature gate tests.
 * @module tests/config/server-config.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

async function config(ttl: string | undefined) {
  vi.resetModules();
  vi.stubEnv('CANVAS_TTL_MS', ttl);
  return (await import('@/config/server-config.js')).getServerConfig();
}

describe('server configuration', () => {
  it('preserves the existing TTL conversion and default', async () => {
    expect((await config(undefined)).datasetTtlSeconds).toBe(86400);
    expect((await config('90000')).datasetTtlSeconds).toBe(90);
  });

  it('normalizes blank and unsubstituted TTL values', async () => {
    for (const value of ['', ' ', `\${CANVAS_TTL_MS}`]) {
      expect((await config(value)).datasetTtlSeconds).toBe(86400);
    }
  });

  it('disables dataframe drop by default and parses its explicit opt-in', async () => {
    vi.stubEnv('TREASURY_DATAFRAME_DROP_ENABLED', undefined);
    expect((await config(undefined)).dataframeDropEnabled).toBe(false);
    vi.stubEnv('TREASURY_DATAFRAME_DROP_ENABLED', 'true');
    expect((await config(undefined)).dataframeDropEnabled).toBe(true);
    vi.stubEnv('TREASURY_DATAFRAME_DROP_ENABLED', 'false');
    expect((await config(undefined)).dataframeDropEnabled).toBe(false);
  });

  it('names malformed TTL settings in its configuration error', async () => {
    await expect(config('nope')).rejects.toThrow('CANVAS_TTL_MS');
    await expect(config('59000')).rejects.toThrow('CANVAS_TTL_MS');
  });
});
