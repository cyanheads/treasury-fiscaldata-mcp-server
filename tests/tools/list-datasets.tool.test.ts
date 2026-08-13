/**
 * @fileoverview Tests for treasury_list_datasets tool.
 * @module tests/tools/list-datasets.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { listDatasetsTool } from '@/mcp-server/tools/definitions/list-datasets.tool.js';
import { DATASETS } from '@/services/fiscal-data/datasets.js';

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
    expect(blocks[0]?.type).toBe('text');
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

  /**
   * The catalog is what a caller copies an endpoint path and a field name out
   * of before calling treasury_query_dataset, so its own shape is a contract
   * independent of whether the values resolve upstream. Whether they resolve is
   * `bun run verify:catalog` — that one needs the network.
   */
  describe('catalog contract', () => {
    it('publishes one entry per endpoint, with no path repeated', () => {
      const paths = DATASETS.map((d) => d.endpoint);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it('publishes endpoint paths in the versioned, leading-slash form query_dataset takes', () => {
      for (const dataset of DATASETS) {
        expect(dataset.endpoint).toMatch(/^\/v[12](?:\/[a-z0-9_]+){2,}$/);
      }
    });

    it('publishes field names in the form the fields= and filter= params accept', () => {
      for (const dataset of DATASETS) {
        expect(dataset.fields.length).toBeGreaterThan(0);
        for (const field of dataset.fields) {
          expect(field.name).toMatch(/^[a-z][a-z0-9_]*$/);
          expect(field.label.trim()).not.toBe('');
          expect(field.type.trim()).not.toBe('');
        }
      }
    });

    it('never repeats a field name within an entry', () => {
      for (const dataset of DATASETS) {
        const names = dataset.fields.map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
      }
    });

    it('carries record_date on every entry — every date filter and sort keys off it', () => {
      for (const dataset of DATASETS) {
        expect(dataset.fields.map((f) => f.name)).toContain('record_date');
      }
    });

    it('assigns every entry a category the input enum accepts', async () => {
      const ctx = createMockContext();
      const categories = [...new Set(DATASETS.map((d) => d.category))];

      for (const category of categories) {
        const result = await listDatasetsTool.handler(
          listDatasetsTool.input.parse({ category }),
          ctx,
        );
        expect(result.total).toBeGreaterThan(0);
      }
      expect(
        categories.reduce((n, c) => n + DATASETS.filter((d) => d.category === c).length, 0),
      ).toBe(DATASETS.length);
    });

    it('renders every entry with its endpoint and every field name it publishes', () => {
      const result = {
        total: DATASETS.length,
        datasets: DATASETS.map((d) => ({ ...d, category: String(d.category) })),
      };
      const text = (listDatasetsTool.format!(result)[0] as { text: string }).text;

      for (const dataset of DATASETS) {
        expect(text).toContain(dataset.endpoint);
        for (const field of dataset.fields) expect(text).toContain(field.name);
      }
    });
  });
});
