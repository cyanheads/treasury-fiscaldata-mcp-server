/**
 * @fileoverview Dependency-check integration fixtures exercise the devcheck command and Knip config.
 * @module tests/scripts/dependency-check.test
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('dependency check', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'treasury-deps-'));
    for (const file of [
      'src',
      'scripts',
      'tests',
      'dist',
      'package.json',
      'tsconfig.json',
      'vitest.config.ts',
      'knip.jsonc',
      'bunfig.toml',
    ]) {
      cpSync(resolve(file), join(cwd, file), { recursive: true });
    }
    symlinkSync(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function check() {
    return spawnSync('bun', ['run', 'scripts/devcheck.ts', '--only', 'Unused Dependencies'], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  it('accepts the declared source, scripts, and test dependencies', () => {
    const result = check();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('fails for an unused declared dependency', () => {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    manifest.dependencies['unused-fixture-dependency'] = '1.0.0';
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    const result = check();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('unused-fixture-dependency');
  });

  it.each(['src/unregistered.ts', 'tests/unregistered.test.ts', 'scripts/unregistered.ts'])(
    'fails for a missing dependency even in disconnected %s',
    (file) => {
      writeFileSync(
        join(cwd, file),
        "import { missing } from 'missing-fixture-dependency';\nconsole.log(missing);\n",
      );
      const result = check();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('missing-fixture-dependency');
    },
  );
});
