/**
 * @fileoverview Bundle cleaning preserves the MCP SDK's runtime skills extension.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation', () => {
  it('strips development skills while preserving exported SDK runtime modules', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/example/dist/skills/runtime.js',
      'node_modules/example/node_modules/@scope/dependency/skills/guide/SKILL.md',
      'node_modules/example/skills/dist/ext/skills/guide.md',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/example/SKILL.md',
      'skills/treasury-analysis/SKILL.md',
    ];
    const removed = [
      'node_modules/example/node_modules/@scope/dependency/skills/guide/SKILL.md',
      'node_modules/example/skills/dist/ext/skills/guide.md',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/example/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(removed);
    expect(entries.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(removed);
  });
});
