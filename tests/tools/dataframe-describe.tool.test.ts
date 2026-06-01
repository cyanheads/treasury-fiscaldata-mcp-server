/**
 * @fileoverview Tests for treasury_dataframe_describe tool.
 * @module tests/tools/dataframe-describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  initCanvasBridge: vi.fn(),
}));

import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import type { DataframeMeta } from '@/services/canvas-bridge/canvas-bridge.js';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const SAMPLE_META: DataframeMeta = {
  tableName: 'df_ABCDE_FGHIJ',
  sourceTool: 'treasury_get_debt',
  queryParams: { mode: 'series', start_date: '2026-01-01' },
  createdAt: '2026-05-28T10:00:00.000Z',
  expiresAt: '2026-05-29T10:00:00.000Z',
  rowCount: 100,
  truncated: false,
  maxRows: undefined,
  columnSchema: [
    { name: 'record_date', type: 'VARCHAR', nullable: true },
    { name: 'tot_pub_debt_out_amt', type: 'VARCHAR', nullable: true },
  ],
};

describe('dataframeDescribeTool', () => {
  it('throws canvas_unavailable when bridge is not configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: dataframeDescribeTool.errors,
    });
    const input = dataframeDescribeTool.input.parse({});
    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('lists active dataframes when canvas is configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([SAMPLE_META]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    const df = result.dataframes[0];
    expect(df?.name).toBe('df_ABCDE_FGHIJ');
    expect(df?.source_tool).toBe('treasury_get_debt');
    expect(df?.row_count).toBe(100);
    expect(df?.truncated).toBe(false);
    expect(df?.column_schema).toHaveLength(2);
    expect(df?.column_schema[0]?.nullable).toBe(true);
  });

  it('returns empty array when no dataframes are registered', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(0);
  });

  it('filters to a named dataframe when name is provided', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue({
      describe: vi.fn().mockResolvedValue([SAMPLE_META]),
    } as unknown as ReturnType<typeof getCanvasBridge>);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const input = dataframeDescribeTool.input.parse({ name: 'df_ABCDE_FGHIJ' });
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    expect(result.dataframes[0]?.name).toBe('df_ABCDE_FGHIJ');
  });

  it('formats output with nullable column info', () => {
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'treasury_get_debt',
          query_params: { mode: 'series' },
          created_at: '2026-05-28T10:00:00.000Z',
          expires_at: '2026-05-29T10:00:00.000Z',
          row_count: 100,
          truncated: false,
          max_rows: undefined,
          column_schema: [
            { name: 'record_date', type: 'VARCHAR', nullable: true },
            { name: 'tot_pub_debt_out_amt', type: 'VARCHAR', nullable: false },
          ],
        },
      ],
    };
    const blocks = dataframeDescribeTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABCDE_FGHIJ');
    expect(text).toContain('nullable:true');
    expect(text).toContain('nullable:false');
    expect(text).toContain('treasury_get_debt');
    expect(text).toContain('100');
  });

  it('formats empty state', () => {
    const result = { dataframes: [] };
    const blocks = dataframeDescribeTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active dataframes');
  });
});
