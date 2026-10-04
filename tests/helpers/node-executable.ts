/**
 * @fileoverview Resolve real Node for runtime tests when Bun prepends its node shim to PATH.
 * @module tests/helpers/node-executable
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Find a Node executable and reject Bun's node shim. Fail if Node is unavailable. */
export function nodeExecutable(): string {
  const executable = process.env.PATH?.split(delimiter)
    .map((directory) => join(directory, 'node'))
    .find(
      (candidate) =>
        existsSync(candidate) &&
        spawnSync(candidate, ['-p', 'Boolean(process.versions.node && !process.versions.bun)'], {
          encoding: 'utf8',
          timeout: 5000,
        }).stdout?.trim() === 'true',
    );
  if (!executable) throw new Error('Node.js is required for runtime tests.');
  return executable;
}
