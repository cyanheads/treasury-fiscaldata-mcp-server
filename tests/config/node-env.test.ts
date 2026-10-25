/**
 * @fileoverview Built entry point loads .env on Node and Bun before deciding tool availability.
 * @module tests/config/node-env.test
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExecutable } from '../helpers/node-executable.js';

describe.each(['node', 'bun'])('%s .env startup', (runtime) => {
  const executable = runtime === 'node' ? nodeExecutable() : runtime;

  it('reports invalid framework configuration through the startup banner', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'treasury-env-'));
    try {
      const result = spawnSync(executable, [resolve('dist/index.js')], {
        cwd,
        input: '',
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          MCP_HTTP_PORT: '1.5',
          MCP_TRANSPORT_TYPE: 'stdio',
          OTEL_ENABLED: 'false',
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Configuration error — server failed to start');
      expect(result.stderr).toContain('MCP_HTTP_PORT');
      expect(result.stderr).not.toContain('at parseConfig');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { value: undefined, enabled: true },
    { value: '', enabled: true },
    { value: '   ', enabled: true },
    { value: `\${CANVAS_PROVIDER_TYPE}`, enabled: true },
    { value: 'none', enabled: false },
    { value: 'duckdb', enabled: true },
  ])('resolves the canvas provider from .env: $value', ({ value, enabled }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'treasury-env-'));
    try {
      writeFileSync(
        join(cwd, '.env'),
        value === undefined ? '' : `CANVAS_PROVIDER_TYPE="${value}"\n`,
      );
      const result = spawnSync(executable, [resolve('dist/index.js')], {
        cwd,
        input: '',
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          MCP_TRANSPORT_TYPE: 'stdio',
          MCP_AUTH_MODE: 'none',
          MCP_LOG_LEVEL: 'info',
          OTEL_ENABLED: 'false',
          STORAGE_PROVIDER_TYPE: 'in-memory',
          LOGS_DIR: join(cwd, 'logs'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const logs = readFileSync(join(cwd, 'logs', 'combined.log'), 'utf8');
      expect(logs.includes('Creating DuckDB canvas provider')).toBe(enabled);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('enables dataframe drop from .env without an exported shell flag', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'treasury-env-'));
    try {
      writeFileSync(
        join(cwd, '.env'),
        'TREASURY_DATAFRAME_DROP_ENABLED=true\nCANVAS_PROVIDER_TYPE=duckdb\n',
      );
      const result = spawnSync(executable, [resolve('dist/index.js')], {
        cwd,
        input: '',
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          MCP_TRANSPORT_TYPE: 'stdio',
          MCP_AUTH_MODE: 'none',
          MCP_LOG_LEVEL: 'info',
          OTEL_ENABLED: 'false',
          STORAGE_PROVIDER_TYPE: 'in-memory',
          LOGS_DIR: join(cwd, 'logs'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const records = readFileSync(join(cwd, 'logs', 'combined.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const initialized = records.find((record) =>
        record.msg?.startsWith('Core services constructed'),
      );
      expect(initialized, JSON.stringify(records)).toBeDefined();
      expect(initialized.tools).toContain('treasury_dataframe_drop');
      expect(initialized.disabledTools ?? []).not.toContain('treasury_dataframe_drop');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
