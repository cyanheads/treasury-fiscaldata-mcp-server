/**
 * @fileoverview Browse the embedded catalog of available Treasury Fiscal Data
 * endpoints with field names, descriptions, and update cadence. No upstream
 * network calls — serves from a static catalog bundled with the server.
 * @module mcp-server/tools/definitions/list-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { DATASETS } from '@/services/fiscal-data/datasets.js';
import type { DatasetCategory } from '@/services/fiscal-data/types.js';

export const listDatasetsTool = tool('treasury_list_datasets', {
  title: 'List Treasury Fiscal Data Datasets',
  description:
    'Browse the catalog of available US Treasury Fiscal Data API endpoints. Returns endpoint paths, field names, descriptions, and update cadence for each dataset. Use this tool before treasury_query_dataset to discover the correct endpoint path and field names — a typo in either causes a 400 error from the API. The catalog covers debt, interest rates, exchange rates, revenue/spending, savings bonds, and securities datasets.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    category: z
      .enum([
        'debt',
        'interest_rates',
        'exchange_rates',
        'revenue_spending',
        'savings_bonds',
        'securities',
        'other',
      ])
      .optional()
      .describe(
        'Filter by category. Omit to list all datasets. Options: debt, interest_rates, exchange_rates, revenue_spending, savings_bonds, securities, other.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Keyword filter against dataset name and description (case-insensitive substring match). Useful for narrowing 80+ datasets when the category is uncertain.',
      ),
  }),

  output: z.object({
    datasets: z
      .array(
        z
          .object({
            endpoint: z
              .string()
              .describe(
                'Endpoint path to pass to treasury_query_dataset (e.g., "/v2/accounting/od/debt_to_penny"). Include the leading slash.',
              ),
            name: z.string().describe('Human-readable dataset name.'),
            description: z.string().describe('What this dataset contains and when it is updated.'),
            category: z
              .string()
              .describe(
                'Broad category: debt, interest_rates, exchange_rates, revenue_spending, savings_bonds, securities, other.',
              ),
            fields: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .describe('Field name as used in fields= and filter= parameters.'),
                    label: z.string().describe('Human-readable label.'),
                    type: z
                      .string()
                      .describe(
                        'Data type (DATE, CURRENCY, PERCENTAGE, STRING, INTEGER, NUMBER, etc.).',
                      ),
                  })
                  .describe('One field available on this endpoint.'),
              )
              .describe('Fields available on this endpoint.'),
            update_cadence: z
              .string()
              .describe('How often the data is updated (e.g., "Daily", "Monthly", "Quarterly").'),
          })
          .describe('One dataset entry.'),
      )
      .describe('Matching datasets.'),
    total: z.number().describe('Total matching datasets.'),
  }),

  async handler(input, ctx) {
    let results = input.category
      ? DATASETS.filter((d) => d.category === (input.category as DatasetCategory))
      : DATASETS;

    if (input.search?.trim()) {
      const needle = input.search.trim().toLowerCase();
      results = results.filter(
        (d) =>
          d.name.toLowerCase().includes(needle) || d.description.toLowerCase().includes(needle),
      );
    }

    ctx.log.info('Dataset catalog listed', {
      category: input.category,
      search: input.search,
      count: results.length,
    });

    return {
      datasets: results.map((d) => ({
        endpoint: d.endpoint,
        name: d.name,
        description: d.description,
        category: d.category,
        fields: d.fields,
        update_cadence: d.update_cadence,
      })),
      total: results.length,
    };
  },

  format: (result) => {
    if (result.datasets.length === 0) {
      return [{ type: 'text', text: 'No matching datasets.' }];
    }
    const lines: string[] = [`**${result.total} dataset(s):**\n`];
    for (const ds of result.datasets) {
      lines.push(`### ${ds.name}`);
      lines.push(`**Endpoint:** \`${ds.endpoint}\``);
      lines.push(`**Category:** ${ds.category} | **Updated:** ${ds.update_cadence}`);
      lines.push(ds.description);
      const fieldList = ds.fields.map((f) => `\`${f.name}\` (${f.type}) — ${f.label}`).join(', ');
      lines.push(`**Fields:** ${fieldList}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
