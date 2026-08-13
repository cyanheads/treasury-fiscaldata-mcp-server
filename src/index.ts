#!/usr/bin/env node
/**
 * @fileoverview treasury-fiscaldata-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { dataframeDescribeTool } from './mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from './mcp-server/tools/definitions/dataframe-query.tool.js';
import { getDebtTool } from './mcp-server/tools/definitions/get-debt.tool.js';
import { getExchangeRatesTool } from './mcp-server/tools/definitions/get-exchange-rates.tool.js';
import { getInterestRatesTool } from './mcp-server/tools/definitions/get-interest-rates.tool.js';
import { listDatasetsTool } from './mcp-server/tools/definitions/list-datasets.tool.js';
import { queryDatasetTool } from './mcp-server/tools/definitions/query-dataset.tool.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initFiscalDataService } from './services/fiscal-data/fiscal-data-service.js';

/**
 * Server-level orientation, sent to clients on every `initialize`. One template
 * literal rather than concatenated fragments: each `+` join depended on a
 * hand-carried trailing space, and dropping one silently fused two words in the
 * string the model reads.
 */
const INSTRUCTIONS = `Use the treasury_* tools to query the US Treasury Fiscal Data API — national debt, interest rates, exchange rates, and other fiscal datasets.
Workflow: treasury_list_datasets to discover endpoint paths and field names for the curated catalog → treasury_query_dataset for any dataset (including endpoints not in the catalog, if you know the path). Convenience tools: treasury_get_debt / treasury_get_interest_rates / treasury_get_exchange_rates.
For large time-series pulls, pass canvas_id to stage the rows as a df_<id> table — read its column schema with treasury_dataframe_describe, then SQL it via treasury_dataframe_query.
All API values are strings — including numeric and date fields. Null values appear as the string "null".
Exchange rates are official Treasury reporting rates (foreign currency units per 1 USD), not market rates.
Debt records are business-days only since 1993-04-01. Interest rate records are end-of-month.`;

await createApp({
  name: 'treasury-fiscaldata-mcp-server',
  title: 'treasury-fiscaldata-mcp-server',
  tools: [
    listDatasetsTool,
    queryDatasetTool,
    getDebtTool,
    getInterestRatesTool,
    getExchangeRatesTool,
    dataframeDescribeTool,
    dataframeQueryTool,
  ],
  resources: [],
  prompts: [],
  instructions: INSTRUCTIONS,
  setup(core) {
    initFiscalDataService();
    initCanvasBridge(core.canvas);
  },
});
