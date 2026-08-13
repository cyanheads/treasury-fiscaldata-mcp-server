/**
 * @fileoverview Tests for the packaging linter's description-parity check.
 * @module tests/scripts/lint-packaging.test
 */

import { describe, expect, it } from 'vitest';
import { checkDescriptionParity } from '../../scripts/lint-packaging.js';

/**
 * Deliberately not this package's real description — the check is generic, and
 * coupling the fixture to the shipped string would make an unrelated copy edit
 * look like a regression here. `lint:packaging` is what compares the real files.
 */
const CANONICAL = 'Do the thing, then the other thing, via MCP.';

describe('checkDescriptionParity', () => {
  it('fails when server.json disagrees with package.json', () => {
    const errors = checkDescriptionParity(CANONICAL, {
      description: 'MCP server for US Treasury Fiscal Data — debt, interest rates, and spending.',
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('server.json');
    expect(errors[0]).toContain('package.json');
  });

  it('quotes both strings so the drift is visible without opening the files', () => {
    const stale = 'Stale registry description.';
    const message = checkDescriptionParity(CANONICAL, { description: stale })[0] ?? '';

    expect(message).toContain(stale);
    expect(message).toContain(CANONICAL);
  });

  it('passes when the two agree', () => {
    expect(checkDescriptionParity(CANONICAL, { description: CANONICAL })).toEqual([]);
  });

  it('fails when server.json carries no description at all', () => {
    expect(checkDescriptionParity(CANONICAL, {})).toHaveLength(1);
  });

  it('treats a whitespace-only package.json description as nothing to compare against', () => {
    expect(checkDescriptionParity('   ', { description: CANONICAL })).toEqual([]);
  });

  it('skips cleanly when server.json is absent', () => {
    expect(checkDescriptionParity(CANONICAL, undefined)).toEqual([]);
  });

  it('skips cleanly when package.json has no description', () => {
    expect(checkDescriptionParity(undefined, { description: 'anything' })).toEqual([]);
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(checkDescriptionParity(` ${CANONICAL} `, { description: `${CANONICAL}\n` })).toEqual([]);
  });
});
