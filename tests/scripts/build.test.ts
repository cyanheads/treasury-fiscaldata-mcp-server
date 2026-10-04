/**
 * @fileoverview Build boundary tests for declarations, aliases, external packages, and type errors.
 * @module tests/scripts/build.test
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeExecutable } from '../helpers/node-executable.js';

describe('build command', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'treasury-build-'));
    mkdirSync(join(cwd, 'scripts'));
    mkdirSync(join(cwd, 'src'));
    cpSync(resolve('scripts/build.ts'), join(cwd, 'scripts/build.ts'));
    symlinkSync(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'build-fixture', version: '1.0.0', type: 'module' }),
    );
    writeFileSync(
      join(cwd, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          declaration: true,
          rootDir: 'src',
          outDir: 'dist',
          paths: { '@/*': ['./src/*'] },
        },
        include: ['src/**/*.ts'],
      }),
    );
    writeFileSync(join(cwd, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json' }));
    writeFileSync(
      join(cwd, 'src/index.ts'),
      "#!/usr/bin/env node\nimport { z } from 'zod';\nimport { value } from '@/value.js';\nconsole.log(z.number().parse(value));\nexport { value } from './value.js';\n",
    );
    writeFileSync(join(cwd, 'src/value.ts'), 'export const value: number = 42;\n');
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('emits declarations and executable ESM with resolved aliases and external packages', () => {
    const result = spawnSync('bun', ['run', 'scripts/build.ts'], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = readFileSync(join(cwd, 'dist/index.js'), 'utf8');
    expect(output).toMatch(/^#!\/usr\/bin\/env node/);
    expect(output).toMatch(/from ["']zod["']/);
    expect(output).not.toContain('@/');
    expect(readFileSync(join(cwd, 'dist/index.d.ts'), 'utf8')).toContain("'./value.js'");
    expect(readFileSync(join(cwd, 'dist/value.d.ts'), 'utf8')).toContain('value: number');
    for (const runtime of [nodeExecutable(), 'bun']) {
      const run = spawnSync(runtime, [join(cwd, 'dist/index.js')], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('42');
    }
  });

  it('fails on type errors before producing executable output', () => {
    writeFileSync(join(cwd, 'src/value.ts'), "export const value: number = 'wrong';\n");
    const result = spawnSync('bun', ['run', 'scripts/build.ts'], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('not assignable');
    expect(existsSync(join(cwd, 'dist/index.js'))).toBe(false);
  });
});
