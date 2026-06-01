/**
 * @fileoverview Tests for treasury_list_datasets tool.
 * @module tests/tools/list-datasets.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listDatasetsTool } from '@/mcp-server/tools/definitions/list-datasets.tool.js';

describe('listDatasetsTool', () => {
  it('returns all datasets when no filter is provided', async () => {
    const ctx = createMockContext();
    const input = listDatasetsTool.input.parse({});
    const result = await listDatasetsTool.handler(input, ctx);

    expect(result.datasets.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.datasets.length);
    const first = result.datasets[0];
    expect(first).toHaveProperty('endpoint');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('category');
    expect(first).toHaveProperty('fields');
    expect(first).toHaveProperty('update_cadence');
  });

  it('filters by category', async () => {
    const ctx = createMockContext();
    const input = listDatasetsTool.input.parse({ category: 'debt' });
    const result = await listDatasetsTool.handler(input, ctx);

    expect(result.datasets.length).toBeGreaterThan(0);
    for (const ds of result.datasets) {
      expect(ds.category).toBe('debt');
    }
  });

  it('filters by search keyword (case-insensitive)', async () => {
    const ctx = createMockContext();
    const input = listDatasetsTool.input.parse({ search: 'debt' });
    const result = await listDatasetsTool.handler(input, ctx);

    expect(result.total).toBe(result.datasets.length);
    for (const ds of result.datasets) {
      const combined = `${ds.name} ${ds.description}`.toLowerCase();
      expect(combined).toContain('debt');
    }
  });

  it('returns empty array for search with no matches', async () => {
    const ctx = createMockContext();
    const input = listDatasetsTool.input.parse({ search: 'xyzzy_no_match_12345' });
    const result = await listDatasetsTool.handler(input, ctx);

    expect(result.datasets).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('formats output completely', () => {
    const result = {
      total: 1,
      datasets: [
        {
          endpoint: '/v2/accounting/od/debt_to_penny',
          name: 'Debt to the Penny',
          description: 'Daily national debt data.',
          category: 'debt',
          update_cadence: 'Daily',
          fields: [
            { name: 'record_date', label: 'Record Date', type: 'DATE' },
            { name: 'tot_pub_debt_out_amt', label: 'Total Public Debt', type: 'CURRENCY' },
          ],
        },
      ],
    };
    const blocks = listDatasetsTool.format!(result);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Debt to the Penny');
    expect(text).toContain('/v2/accounting/od/debt_to_penny');
    expect(text).toContain('record_date');
    expect(text).toContain('Daily');
  });

  it('formats empty result', () => {
    const result = { total: 0, datasets: [] };
    const blocks = listDatasetsTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No matching datasets');
  });
});
