# Treasury Fiscal Data MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `treasury_list_datasets` | Browse the catalog of available Fiscal Data datasets with endpoints, field names, and update cadence | `category` (optional filter), `search` (optional keyword) | `readOnlyHint`, `idempotentHint` |
| `treasury_query_dataset` | Generic parameterized query against any dataset by endpoint path — fields, filters, sort, pagination, and optional DataCanvas spillover for large results | `endpoint`, `fields[]`, `filters[]`, `sort`, `page_size`, `page_number`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_debt` | National debt (Debt to the Penny) — latest, a specific date, or a time series with DataCanvas for multi-year pulls | `mode` (`latest`\|`date`\|`series`), `date`, `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_interest_rates` | Average interest rates Treasury pays by security type (Bills, Notes, Bonds, TIPS, FRN) — latest snapshot or time series | `security_type` (optional filter), `mode` (`latest`\|`series`), `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_exchange_rates` | Official Treasury reporting exchange rates for one or more currencies — latest quarter or historical series. These are statutory rates for federal USD reporting, not market rates. | `countries[]` (optional), `mode` (`latest`\|`series`), `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_dataframe_describe` | List DataCanvas dataframes materialized by treasury tools — schema, row count, TTL, and source params | `name` (optional, filter to one) | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |
| `treasury_dataframe_query` | Run a SELECT against DataCanvas dataframes registered by treasury data tools | `sql`, `register_as`, `preview`, `row_limit` | `readOnlyHint`, `idempotentHint`, `openWorldHint: false` |

---

## Overview

The US Treasury Fiscal Data API is the authoritative source for the federal government's financial books — national debt, interest cost, official exchange rates, federal revenue and outlays, and 80+ other datasets under a single uniform query grammar. Every endpoint shares the same `fields` / `filter` / `sort` / pagination interface. The API is keyless.

This server wraps that API for LLM access: convenience tools for the three headline questions agents ask most (debt, interest rates, exchange rates), one generic query tool for the long tail, and a DataCanvas surface for multi-year time-series analysis.

**Audience:** economic and policy analysts, journalists, fintech/civic-tech builders, agents answering "what's the national debt?" or "what does Treasury pay in interest?" or "what exchange rate should I use for federal reporting?"

---

## Requirements

- Keyless API — no auth credentials required; no user-facing API key env var needed
- Read-only; all upstream requests are GET
- Base URL: `https://api.fiscaldata.treasury.gov/services/api/fiscal_service`
- Filter syntax: `filter=col:op:value[,col:op:value...]` — operators: `eq`, `gt`, `gte`, `lt`, `lte`, `in`; `in` takes a parenthesized comma-separated list
- All API response values are strings (including nulls, returned as the string `"null"`)
- Pagination: `page[size]` (default 100, no published hard ceiling — 10,000 is safe), `page[number]`
- Response envelope: `{ data: [...], meta: { count, labels, dataTypes, dataFormats, "total-count", "total-pages" }, links: { self, first, prev, next, last } }`
- No programmatic dataset catalog API — the endpoint list is static and must be embedded in the server
- DataCanvas for time-series results that exceed practical inline budgets (multi-year daily debt history, full exchange rate history)
- 404 errors (invalid endpoint path) return HTML (not JSON) — service layer must detect via `Content-Type: text/html` and convert to `invalid_endpoint`
- 400 errors (bad field name, unsupported operator) return JSON `{"error":"Invalid Query Param","message":"..."}` — parse as structured validation error
- "Not found" for domain data (no record for a date, no match for a country) returns `200 OK` with `data:[]` and `meta["total-count"]:0` — NOT a 4xx

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `fiscalDataService` | Treasury Fiscal Data REST API | All tools |
| `canvasBridge` | Framework DataCanvas | `treasury_query_dataset`, `treasury_get_debt`, `treasury_get_interest_rates`, `treasury_get_exchange_rates`, `treasury_dataframe_describe`, `treasury_dataframe_query` |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas for large time-series results. Without it, canvas tools degrade gracefully (not an error; canvas tools are additive). |
| `CANVAS_TTL_MS` | No | Override DataCanvas default TTL (24h). |

No API key env var — the API is fully keyless.

---

## Implementation Order

1. Config skeleton — `server-config.ts` (minimal, no API keys)
2. `fiscalDataService` — `fetchPage()` method, response envelope types, filter builder, 404 HTML detection
3. Embedded dataset catalog (`datasets.ts`) — static map of `{ endpoint, name, description, category, fields[] }`
4. `treasury_list_datasets` — read-only, no upstream calls
5. `treasury_query_dataset` — generic wrapper, with `spillover()` to canvas when applicable
6. `treasury_get_debt` — convenience over `debt_to_penny`
7. `treasury_get_interest_rates` — convenience over `avg_interest_rates`
8. `treasury_get_exchange_rates` — convenience over `rates_of_exchange`
9. Canvas bridge accessor + `treasury_dataframe_describe` + `treasury_dataframe_query`
10. `createApp()` integration + server instructions

---

## Tool Specifications

### `treasury_list_datasets`

**Purpose:** Browse the catalog of all available Fiscal Data endpoints. Returns the endpoint path, dataset name, description, update cadence, and field list. Required context for `treasury_query_dataset` — agents need the path and field names to construct a useful generic query.

**Upstream:** No network calls. Returns from an embedded static catalog (`datasets.ts`) bundled with the server. The catalog is curated from the official API documentation endpoint table.

**Input schema:**
```ts
z.object({
  category: z.enum([
    'debt', 'interest_rates', 'exchange_rates', 'revenue_spending',
    'savings_bonds', 'securities', 'other'
  ]).optional()
    .describe('Filter by category. Omit to list all datasets.'),
  search: z.string().optional()
    .describe('Keyword filter against dataset name and description (case-insensitive substring match). Useful for narrowing 80+ datasets when the category is uncertain.'),
})
```

**Output schema:**
```ts
z.object({
  datasets: z.array(z.object({
    endpoint: z.string().describe('Endpoint path to pass to treasury_query_dataset (e.g., "/v2/accounting/od/debt_to_penny").'),
    name: z.string().describe('Human-readable dataset name.'),
    description: z.string().describe('What this dataset contains and when it is updated.'),
    category: z.string().describe('Broad category: debt, interest_rates, exchange_rates, revenue_spending, savings_bonds, securities, other.'),
    fields: z.array(z.object({
      name: z.string().describe('Field name as used in fields= and filter= parameters.'),
      label: z.string().describe('Human-readable label.'),
      type: z.string().describe('Data type (DATE, CURRENCY, PERCENTAGE, STRING, INTEGER, NUMBER, etc.).'),
    })).describe('Fields available on this endpoint.'),
    update_cadence: z.string().describe('How often the data is updated (e.g., "Daily", "Monthly", "Quarterly").'),
  })).describe('Matching datasets.'),
  total: z.number().describe('Total matching datasets.'),
})
```

**Errors:**
- No domain errors — static data, never throws.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_query_dataset`

**Purpose:** Parameterized query against any Fiscal Data endpoint. Translates structured inputs into the API's `fields` / `filter` / `sort` / pagination grammar. Returns rows, metadata (total count, applied filters), and optionally spills large results to a DataCanvas table for SQL analysis. Use `treasury_list_datasets` first to discover the endpoint path and field names.

**Upstream:** `GET {base}/{endpoint}?fields=...&filter=...&sort=...&page[size]=...&page[number]=...`

**Input schema:**
```ts
z.object({
  endpoint: z.string()
    .describe('Endpoint path returned by treasury_list_datasets (e.g., "/v2/accounting/od/debt_to_penny"). Include the leading slash.'),
  fields: z.array(z.string()).optional()
    .describe('Fields to return. Omit to return all fields. Specify field names exactly as listed by treasury_list_datasets — a typo causes a 400.'),
  filters: z.array(z.object({
    field: z.string().describe('Field name to filter on.'),
    operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte', 'in'])
      .describe('Comparison operator. "in" matches any value in the provided list.'),
    value: z.union([z.string(), z.array(z.string())])
      .describe('Filter value. For "in", pass an array of strings. Dates use YYYY-MM-DD format.'),
  })).optional()
    .describe('Filter conditions (ANDed together). Multiple filters on different fields are combined in one filter= parameter.'),
  sort: z.string().optional()
    .describe('Sort expression: field name optionally prefixed with "-" for descending (e.g., "-record_date" for newest-first).'),
  page_size: z.number().int().min(1).max(10000).default(100)
    .describe('Rows per page. Default 100. Raise to 10000 to minimize round trips for small datasets. For large time-series pulls, use canvas_id with treasury_dataframe_query instead.'),
  page_number: z.number().int().min(1).default(1)
    .describe('Page to fetch (1-indexed). Check total_pages in the response to know if more pages exist.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas ID to spill results into for SQL analysis. Omit to receive results inline. Requires CANVAS_PROVIDER_TYPE=duckdb on the server. When provided, the full page result is registered as a dataframe and a canvas_id is returned for use with treasury_dataframe_query.'),
})
```

**Output schema:**
```ts
z.object({
  endpoint: z.string().describe('Endpoint that was queried.'),
  data: z.array(z.record(z.string(), z.string()))
    .describe('Rows returned. All values are strings per API contract — including numeric and date fields. Convert in the calling context. Null values appear as the string "null".'),
  total_count: z.number().describe('Total rows matching the query (across all pages).'),
  total_pages: z.number().describe('Total pages at the current page_size.'),
  page_number: z.number().describe('Current page (1-indexed).'),
  page_size: z.number().describe('Rows per page.'),
  field_labels: z.record(z.string(), z.string()).describe('Human-readable label for each returned field.'),
  applied_filters: z.string().optional().describe('Filter expression sent to the API, for verification.'),
  canvas_id: z.string().optional().describe('DataCanvas ID where this page is registered. Use with treasury_dataframe_query to run SQL.'),
  canvas_expires_at: z.string().optional().describe('ISO 8601 expiry for the canvas dataframe.'),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'invalid_endpoint',
    code: JsonRpcErrorCode.NotFound,
    when: 'The endpoint path does not exist (API returns 404 HTML)',
    recovery: 'Call treasury_list_datasets to find the correct endpoint path.',
  },
  {
    reason: 'invalid_field',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A field name in fields= or filter= does not exist on this endpoint — API returns JSON {"error":"Invalid Query Param","message":"...Field \'X\' does not exist..."} (not HTML)',
    recovery: 'Call treasury_list_datasets with the endpoint to see the available field names.',
  },
  {
    reason: 'invalid_filter',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The filter expression uses an unsupported operator — API returns JSON {"error":"Invalid Query Param","message":"...Operator \':{op}:\' is not supported..."} (not HTML)',
    recovery: 'Supported operators: eq, gt, gte, lt, lte, in. Dates use YYYY-MM-DD. Check field names against treasury_list_datasets.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

**DataCanvas note:** `spillover()` from `api-canvas` is the right helper — register the page result under the provided (or freshly minted) `canvas_id`, return a truncated inline preview alongside the canvas token.

---

### `treasury_get_debt`

**Purpose:** National debt (Debt to the Penny). Returns total public debt outstanding, broken into publicly-held debt and intragovernmental holdings. Three modes: `latest` (most recent daily record), `date` (a specific date), or `series` (a date range). Multi-year series automatically spills to DataCanvas when `canvas_id` is provided or result exceeds 500 rows.

**Upstream:** `GET /v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt&sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `debt_held_public_amt` (CURRENCY), `intragov_hold_amt` (CURRENCY), `tot_pub_debt_out_amt` (CURRENCY), `src_line_nbr` (INTEGER), plus fiscal/calendar year/quarter/month/day fields.

**Input schema:**
```ts
z.object({
  mode: z.enum(['latest', 'date', 'series']).default('latest')
    .describe('"latest" returns the most recent day\'s record. "date" returns the record for a specific date. "series" returns a date range — use with start_date and end_date. As of 2026-05-28 the total debt is ~$39.18T.'),
  date: z.string().optional()
    .describe('ISO 8601 date (YYYY-MM-DD) for mode=date. Must be a business day; the API only records debt on days the market is open.'),
  start_date: z.string().optional()
    .describe('ISO 8601 start date for mode=series (inclusive). Fiscal Data has daily debt records back to 1993-01-04.'),
  end_date: z.string().optional()
    .describe('ISO 8601 end date for mode=series (inclusive). Defaults to today.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas ID for series results. When provided (or auto-generated for series > 500 rows), the full result is registered for SQL analysis via treasury_dataframe_query.'),
})
```

**Output schema:**
```ts
z.object({
  record_date: z.string().describe('Date of this debt record (YYYY-MM-DD).'),
  total_debt: z.string().describe('Total public debt outstanding in USD (string — convert as needed). Example: "39176301795549.40".'),
  debt_held_public: z.string().describe('Debt held by the public (external creditors, Fed, foreign govts) in USD.'),
  intragovernmental_holdings: z.string().describe('Intragovernmental holdings (debt owed to federal trust funds, Social Security, etc.) in USD.'),
  // for series mode:
  series: z.array(z.object({
    record_date: z.string(),
    total_debt: z.string(),
    debt_held_public: z.string(),
    intragovernmental_holdings: z.string(),
  })).optional().describe('All records for mode=series (may be truncated when spilled to canvas).'),
  total_records: z.number().optional().describe('Total matching records for mode=series.'),
  canvas_id: z.string().optional().describe('DataCanvas ID when series was spilled. Use treasury_dataframe_query to run SQL.'),
  canvas_expires_at: z.string().optional(),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'no_data_for_date',
    code: JsonRpcErrorCode.NotFound,
    when: 'No debt record exists for the requested date (API returns HTTP 200 with empty data[], not 404 — service layer must detect total-count: 0)',
    recovery: 'Fiscal Data only records debt on business days from 1993-01-04 onward. Try the nearest business day, or use mode=series with a date range.',
  },
]
```

> **Implementation note:** "No data for date" is NOT an HTTP 4xx — the API returns `200 OK` with `{"data":[],"meta":{"total-count":0,...}}`. The service layer must detect `total-count === 0` and surface this as the `no_data_for_date` error, not rely on HTTP status.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_get_interest_rates`

**Purpose:** Average interest rates Treasury pays on its outstanding securities, by security type. Answers "what is the government's cost of borrowing?" Covers Bills, Notes, Bonds, TIPS, Floating Rate Notes, and aggregate marketable/non-marketable totals. Updated monthly (end-of-month records). Three modes: `latest` (most recent month's rates for all or one security type), or `series` (time history for a security type).

**Upstream:** `GET /v2/accounting/od/avg_interest_rates?sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `security_type_desc` (STRING: `"Marketable"` | `"Non-marketable"` | `"Interest-bearing Debt"`), `security_desc` (STRING: `"Treasury Bills"`, `"Treasury Notes"`, `"Treasury Bonds"`, `"Treasury Inflation-Protected Securities (TIPS)"`, `"Treasury Floating Rate Notes (FRN)"`, plus aggregates `"Total Marketable"`, `"Total Non-marketable"`, `"Total Interest-bearing Debt"`), `avg_interest_rate_amt` (PERCENTAGE as string, e.g., `"3.696"`), `src_line_nbr` (INTEGER).

> **Filtering note:** The `security_type` input parameter filters on `security_desc` (not `security_type_desc`). The Zod enum values must match `security_desc` exactly (e.g., `"Total Interest-bearing Debt"`, not `"Interest-bearing Debt"`). The `security_type_desc` field is a broader category and cannot be used alone to reach individual security types.

**As of 2026-04-30 (latest verified):** Bills 3.696%, Notes 3.230%, Bonds 3.403%, TIPS 1.068%, FRN 3.764%, Total Interest-bearing Debt 3.340%

**Input schema:**
```ts
z.object({
  mode: z.enum(['latest', 'series']).default('latest')
    .describe('"latest" returns the most recent month\'s rates. "series" returns a time range.'),
  security_type: z.enum([
    'Treasury Bills',
    'Treasury Notes',
    'Treasury Bonds',
    'Treasury Inflation-Protected Securities (TIPS)',
    'Treasury Floating Rate Notes (FRN)',
    'Total Marketable',
    'Total Non-marketable',
    'Total Interest-bearing Debt',
  ]).optional()
    .describe('Filter to one security type. Omit for all types. Use exact string — the API does exact-match filtering on security_desc.'),
  start_date: z.string().optional()
    .describe('ISO 8601 start date for mode=series (YYYY-MM-DD, must be end-of-month for meaningful results).'),
  end_date: z.string().optional()
    .describe('ISO 8601 end date for mode=series. Defaults to today.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas ID for series results exceeding 200 rows.'),
})
```

**Output schema:**
```ts
z.object({
  as_of_date: z.string().describe('Most recent record date returned (YYYY-MM-DD).'),
  rates: z.array(z.object({
    record_date: z.string(),
    security_type: z.string().describe('Security type (Marketable, Non-marketable, Interest-bearing Debt).'),
    security_desc: z.string().describe('Security description (e.g., Treasury Bills).'),
    avg_interest_rate_pct: z.string().describe('Average interest rate as a percentage string (e.g., "3.696"). Not basis points.'),
  })).describe('Interest rate records.'),
  total_records: z.number().describe('Total matching records.'),
  canvas_id: z.string().optional(),
  canvas_expires_at: z.string().optional(),
})
```

**Errors:** Baseline errors only (upstream 5xx, timeout). No domain errors — if `security_type` doesn't match, API returns empty rows; handler surfaces `total_records: 0` with an enrichment notice listing valid security descriptions.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_get_exchange_rates`

**Purpose:** Official Treasury reporting exchange rates — the rates US federal agencies are required to use when converting foreign currency to USD for official reporting. Published quarterly. These are **not market exchange rates** and not suitable for financial transaction pricing. Use for federal reporting compliance, inter-agency reconciliation, or auditing foreign-currency transactions in government financial statements.

The latest quarter available is 2026-03-31 (Q1 2026). Exchange rate is expressed as foreign currency units per 1 USD (e.g., Japan-Yen: 159.41 means 1 USD = 159.41 JPY).

**Upstream:** `GET /v1/accounting/od/rates_of_exchange?sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `country` (STRING), `currency` (STRING), `country_currency_desc` (STRING, format "Country-Currency", e.g., "Japan-Yen"), `exchange_rate` (NUMBER as string), `effective_date` (DATE, same as record_date in practice), `src_line_nbr` (INTEGER).

**Total rows:** ~18,800 (full history). ~130 countries per quarter. Quarterly cadence since at least 1956.

**Input schema:**
```ts
z.object({
  mode: z.enum(['latest', 'series']).default('latest')
    .describe('"latest" returns the most recently published quarter\'s rates. "series" returns a date range of quarterly reports.'),
  countries: z.array(z.string()).optional()
    .describe('Filter to specific countries by exact country name (e.g., ["Japan", "Germany", "France"]). Case-sensitive, matches the "country" field. Omit for all ~130 countries in the quarter.'),
  start_date: z.string().optional()
    .describe('ISO 8601 start date for mode=series. Rates are published end-of-quarter (March 31, June 30, Sep 30, Dec 31).'),
  end_date: z.string().optional()
    .describe('ISO 8601 end date for mode=series.'),
  canvas_id: z.string().optional()
    .describe('DataCanvas ID for series pulls (useful when pulling multi-year history for many countries).'),
})
```

**Output schema:**
```ts
z.object({
  as_of_date: z.string().describe('Quarter-end date of the most recent rates (YYYY-MM-DD).'),
  effective_date: z.string().describe('Effective date of the rates (same as record_date).'),
  rates: z.array(z.object({
    country: z.string(),
    currency: z.string(),
    country_currency_desc: z.string().describe('"Country-Currency" combined label (e.g., "Japan-Yen"). Use for in= filter values.'),
    exchange_rate: z.string().describe('Foreign currency units per 1 USD. A value of 159.41 for Japan-Yen means 1 USD = 159.41 JPY.'),
    record_date: z.string(),
  })).describe('Exchange rates for the requested countries/quarter.'),
  total_records: z.number(),
  note: z.string().describe('Contextual note reminding that these are official reporting rates, not market rates.'),
  canvas_id: z.string().optional(),
  canvas_expires_at: z.string().optional(),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'country_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'One or more requested countries have no records — API returns HTTP 200 with empty data[]; service layer must detect total-count: 0 or a partial match (some countries returned, some absent)',
    recovery: 'Use mode=latest without countries filter to list all available country names, or check spelling — country names must match exactly (e.g., "Korea" not "South Korea").',
  },
]
```

> **Implementation note:** Unmatched country filter returns `200 OK` with `{"data":[],"meta":{"total-count":0,...}}`. The service layer must check the response for empty/missing results per requested country. For multi-country requests with `in:()` filter, compare returned country set against requested countries to detect partial misses.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_dataframe_describe`

**Purpose:** List DataCanvas dataframes materialized by treasury data tools. Shows schema, row count, TTL, source tool, and query parameters for each active dataframe. Use before `treasury_dataframe_query` to discover table names and column types.

**Input schema:**
```ts
z.object({
  name: z.string().optional()
    .describe('Optional dataframe table name (df_XXXXX_XXXXX) to describe a single dataframe. Omit to list all active dataframes.'),
})
```

**Output schema:** (mirrors secedgar pattern)
```ts
z.object({
  dataframes: z.array(z.object({
    name: z.string().describe('Canvas table name (df_XXXXX_XXXXX).'),
    source_tool: z.string().describe('Treasury tool that produced this dataframe.'),
    query_params: z.record(z.string(), z.unknown()).describe('Input parameters the source tool was called with.'),
    created_at: z.string(),
    expires_at: z.string(),
    row_count: z.number(),
    truncated: z.boolean(),
    max_rows: z.number().optional(),
    column_schema: z.array(z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
    })),
  })),
})
```

**Errors:**
```ts
errors: [
  {
    reason: 'canvas_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CANVAS_PROVIDER_TYPE is not set to duckdb',
    recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable DataCanvas.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

### `treasury_dataframe_query`

**Purpose:** Run a SELECT query against DataCanvas dataframes registered by treasury data tools. Standard DuckDB SQL with joins, aggregates, window functions, and CTEs. Use `treasury_dataframe_describe` to list available table names and column schemas before querying.

**Input schema:**
```ts
z.object({
  sql: z.string().min(1)
    .describe('Single-statement SELECT against df_<id> tables. All values in Treasury dataframes are VARCHAR (strings) per the API contract — CAST to DECIMAL or DATE for arithmetic and date comparisons. Example: SELECT record_date, CAST(tot_pub_debt_out_amt AS DECIMAL) AS debt FROM df_xxxxx ORDER BY record_date DESC LIMIT 10.'),
  register_as: z.string().optional()
    .describe('Persist result as a new dataframe. Use to chain analyses.'),
  preview: z.number().int().min(0).max(10000).optional()
    .describe('Rows in the immediate response. Defaults to row_limit. Set lower when using register_as.'),
  row_limit: z.number().int().min(1).max(10000).default(1000)
    .describe('Hard cap on rows in the response. Default 1000, max 10000.'),
})
```

**Output schema:**
```ts
z.object({
  columns: z.array(z.string()),
  row_count: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  registered_as: z.string().optional(),
  expires_at: z.string().optional(),
})
```

**Enrichment (reaches both structuredContent and content[] automatically):**
```ts
enrichment: {
  notice: z.string().optional()
    .describe('Guidance when the query returned no rows, or when results were capped by row_limit.'),
}
```

**Errors:**
```ts
errors: [
  {
    reason: 'canvas_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CANVAS_PROVIDER_TYPE is not set to duckdb',
    recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable DataCanvas.',
  },
  {
    reason: 'system_catalog_access',
    code: JsonRpcErrorCode.ValidationError,
    when: 'SQL references a denied DuckDB system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*)',
    recovery: 'Query only df_<id> tables. Use treasury_dataframe_describe to list available dataframes.',
  },
  {
    reason: 'invalid_sql',
    code: JsonRpcErrorCode.ValidationError,
    when: 'SQL is not a SELECT, contains DDL/DML, or uses disallowed table functions',
    recovery: 'Only SELECT statements are permitted. Reference dataframes by name from treasury_dataframe_describe.',
  },
]
```

> **Implementation note (mirrors secedgar gold standard):** Use `ctx.enrich.notice(...)` in the handler for empty-result and row-cap conditions — not `format()` text — so the notice reaches both `structuredContent` (Claude Code) and `content[]` (Claude Desktop) automatically. Check `result.rowCount === 0` and `result.rowCount > result.rows.length` after executing. The `register_as` value must match `df_XXXXX_XXXXX` format or be a fresh agent-supplied df_<id>.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`

---

## Domain Mapping

| Noun | Operations | Tool |
|:-----|:-----------|:-----|
| Dataset catalog | list, search, filter | `treasury_list_datasets` |
| Any dataset | query (fields/filter/sort/paginate), spill to canvas | `treasury_query_dataset` |
| National debt | latest, by date, time series | `treasury_get_debt` |
| Interest rates | latest snapshot, time series, by security type | `treasury_get_interest_rates` |
| Exchange rates | latest quarter, time series, by country | `treasury_get_exchange_rates` |
| DataCanvas | describe tables, run SQL | `treasury_dataframe_describe`, `treasury_dataframe_query` |

---

## API Reference

### Query grammar (verified live)

```
GET {base}/{endpoint}
  ?fields=field1,field2,...
  &filter=col:op:value[,col:op:value]
  &sort=[-]fieldname
  &page[size]=N        # default 100; 10,000 is safe upper bound
  &page[number]=N      # 1-indexed
```

**Filter operators (verified):** `eq`, `gt`, `gte`, `lt`, `lte`, `in`
- `in` syntax: `field:in:(val1,val2,val3)`
- Multiple filters: comma-separated in one `filter=` parameter
- Invalid operator returns `{"error":"Invalid Query Param","message":"Invalid query parameter: Operator ':xxx:' is not supported."}`

**Response envelope:**
```json
{
  "data": [ /* rows — all values are strings */ ],
  "meta": {
    "count": 2,
    "labels": { "field": "Human Label" },
    "dataTypes": { "field": "DATE|CURRENCY|STRING|NUMBER|PERCENTAGE|INTEGER|YEAR|QUARTER|MONTH|DAY" },
    "dataFormats": { "field": "YYYY-MM-DD|$10.20|String|..." },
    "total-count": 8317,
    "total-pages": 4159
  },
  "links": {
    "self": "&page%5Bnumber%5D=1&page%5Bsize%5D=2",
    "first": "...", "prev": null, "next": "...", "last": "..."
  }
}
```

**Note:** `links` values are query-string fragments, not full URLs — `self`, `first`, etc. strip the base and endpoint. Pagination must be reconstructed from `meta["total-count"]` and `meta["total-pages"]`.

**Error shapes (verified live):**
- **404 (invalid endpoint path):** Returns HTML (not JSON). Service layer must detect `Content-Type: text/html` and convert to `invalid_endpoint` error.
- **400 (bad field or operator):** Returns JSON `{"error":"Invalid Query Param","message":"..."}` — parse as a structured validation error, not an HTML page.
- **Empty results (date/country not found):** Returns `200 OK` with `{"data":[],"meta":{"total-count":0,...}}`. NOT a 4xx. Service layer must check `meta["total-count"] === 0` to surface domain-level not-found conditions.

**Null values:** Returned as the string `"null"`. All value conversion must be defensive (`val === "null" ? null : val`).

### Key endpoints (verified live)

| Endpoint | Dataset | Update cadence | Notable fields |
|:---------|:--------|:---------------|:---------------|
| `/v2/accounting/od/debt_to_penny` | Debt to the Penny | Daily (business days) | `tot_pub_debt_out_amt`, `debt_held_public_amt`, `intragov_hold_amt` |
| `/v2/accounting/od/avg_interest_rates` | Avg Interest Rates | Monthly | `security_desc`, `security_type_desc`, `avg_interest_rate_amt` |
| `/v1/accounting/od/rates_of_exchange` | Rates of Exchange | Quarterly | `country`, `currency`, `exchange_rate`, `effective_date` |
| `/v1/accounting/mts/mts_table_5` | MTS Table 5 (Outlays by agency) | Monthly | `classification_desc`, `current_fytd_gross_outly_amt` |
| `/v1/accounting/mts/mts_table_4` | MTS Table 4 (Receipts) | Monthly | `classification_desc`, `current_fytd_gross_rcpt_amt` |
| `/v1/accounting/dts/operating_cash_balance` | DTS Cash Balance | Daily | TGA balance |

---

## Workflow Analysis

### `treasury_get_debt` (mode=series, canvas)

| # | Action | Purpose |
|:--|:-------|:--------|
| 1 | Build filter: `record_date:gte:{start_date},record_date:lte:{end_date}` | Date-scoped query |
| 2 | `GET /v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt&filter=...&sort=-record_date&page[size]=10000` | Fetch up to 10,000 rows in one call |
| 3 | If `total-count` > 500 and `canvas_id` provided (or total > 500): `spillover()` to canvas | Register dataframe |
| 4 | Return inline preview (first 20 rows) + `canvas_id` + total_records | Response |

One API call for most series queries (FY2026 has ~164 business days; a 5-year series is ~1,250 rows, one page at page_size=10000).

### `treasury_query_dataset` (generic, canvas)

| # | Action | Purpose |
|:--|:-------|:--------|
| 1 | Validate `endpoint` against the embedded catalog (optional, warn-not-block) | Catch typos early |
| 2 | Build `fields=`, `filter=`, `sort=` from structured inputs | Translation layer |
| 3 | `GET {endpoint}?...&page[size]={page_size}&page[number]={page_number}` | Fetch one page |
| 4 | If `canvas_id` provided: register rows via `spillover()` | Canvas registration |
| 5 | Return rows, metadata, canvas token | Response |

---

## Known Limitations

- **No programmatic dataset catalog.** The API has no `/datasets` discovery endpoint — the catalog must be embedded as static data in the server and maintained as Treasury adds datasets. The embedded catalog covers the documented set (~80 endpoints) but may drift over time.
- **All values are strings.** The API returns every value (including dates, numbers, currencies) as a JSON string. All parsing and type conversion is the consumer's responsibility. `"null"` is a string, not JSON null. Verified: MTS table 5 `current_fytd_gross_outly_amt` returns `"null"` for many rows.
- **Empty results ≠ 404.** Filtering for a date with no data (weekend, holiday) or an unrecognized country/security returns `200 OK` with `data:[]` and `meta["total-count"]:0`. Service layer must detect this pattern explicitly — it cannot rely on HTTP status codes for "not found" domain conditions.
- **`CURRENCY0` dataType variant.** Some endpoints (e.g., `operating_cash_balance`) use `CURRENCY0` in `meta.dataTypes` (whole-dollar amounts, no cents). The service layer and embedded catalog should handle this alongside `CURRENCY`.
- **`links` values are fragments, not absolute URLs.** `meta["total-count"]` and `meta["total-pages"]` are the reliable pagination signals.
- **Exchange rate dates.** The `rates_of_exchange` endpoint only contains quarter-end dates. There is no record for mid-quarter dates — `filter=record_date:eq:2026-02-15` returns empty.
- **`avg_interest_rates` security name matching.** The `filter=security_desc:eq:...` filter requires exact string matching including full capitalization and parenthetical qualifiers (e.g., "Treasury Inflation-Protected Securities (TIPS)"). Partial matches do not work — `lt`/`gt`/`gte`/`lte` are not meaningful for string fields.
- **Fiscal year vs. calendar year.** The US federal fiscal year runs Oct 1 – Sep 30. Records carry both `record_fiscal_year` and `record_calendar_year` fields. Agents asking "FY2025 spending" should filter on `record_fiscal_year:eq:2025`, not calendar year.
- **MTS tables are complex.** MTS has 9+ tables with hierarchical `parent_id`/`classification_id` structure. Summarizing federal spending/receipts requires understanding the table hierarchy. The generic `treasury_query_dataset` exposes them; `treasury_list_datasets` documents the key tables. No dedicated MTS convenience tool is included in v1 — the hierarchical structure makes a clean convenience wrapper complex and the `treasury_query_dataset` tool covers the access pattern.

---

## Decisions Log

### 1. No dedicated MTS convenience tool

**Decision:** `treasury_get_debt`, `treasury_get_interest_rates`, and `treasury_get_exchange_rates` cover the three headline convenience tools. Monthly Treasury Statement (revenue/outlays/deficit) is not wrapped in a convenience tool for v1.

**Rationale:** MTS data is spread across 9 hierarchical tables with `parent_id`/`classification_id` nesting and `data_type_cd`/`record_type_cd` codes that require interpreting. A truly useful "get the deficit" tool would need to know which table (MTS Table 1 for surplus/deficit, Table 5 for outlays, Table 4 for receipts), which `line_code_nbr` (e.g., 120 for net outlays total), and how to filter out subtotal rows. The complexity is non-trivial and the data is already reachable via `treasury_query_dataset`. Defer to v2 after field-testing reveals how agents actually approach deficit/spending queries.

### 2. DataCanvas: YES — for series queries on `treasury_query_dataset`, `treasury_get_debt`, `treasury_get_interest_rates`, `treasury_get_exchange_rates`

**Decision:** DataCanvas opt-in via `canvas_id` parameter on the four data tools, plus dedicated `treasury_dataframe_describe` and `treasury_dataframe_query` tools. Pattern mirrors secedgar exactly.

**Rationale:** Treasury data is inherently time-series. Debt history from 1993 is 8,317 rows; full exchange rate history is ~18,800 rows; a multi-security multi-year interest rate series can be 4,000+ rows. These are non-trivial to reason about inline but straightforward with SQL (`SELECT record_date, CAST(tot_pub_debt_out_amt AS DECIMAL) AS debt FROM df_xxxxx WHERE record_date >= '2020-01-01' ORDER BY record_date`). DataCanvas earns its keep here. However, for typical queries (latest debt, this quarter's FX rates, current month's interest rates), results are small enough to inline — canvas is additive, not required.

**Implementation note:** `spillover()` helper from `api-canvas` is the right primitive. The threshold for auto-spill vs. user-opt-in: convenience tools auto-spill when `canvas_id` is provided; `treasury_query_dataset` spills only when `canvas_id` is explicitly passed (the generic tool doesn't know result size upfront without a count query).

### 3. No programmatic catalog API — embedded static catalog

**Decision:** `treasury_list_datasets` serves from an embedded `datasets.ts` map, not a live API call.

**Rationale:** The Treasury API has no `/datasets` endpoint (verified — returns 404 HTML). The catalog is available only via the HTML documentation page. Embedding is the only option. The catalog is stable (Treasury rarely removes datasets; new datasets are added infrequently). A static catalog with a clear update path (sync against the API docs table) is preferable to scraping HTML on every request.

### 4. Exchange rate disambiguation — statutory vs. market rates

**Decision:** The tool is named `treasury_get_exchange_rates` (not "currency exchange" or "FX rates"). The description, `note` output field, and parameter descriptions all explicitly state: *these are official quarterly reporting rates required for federal USD conversion, not market exchange rates.*

**Rationale:** The `rates_of_exchange` dataset is the single most likely tool to be misused. An agent (or human) asking "what's the exchange rate for EUR/USD?" and using this answer for a financial transaction would get a quarterly rate that can be weeks stale and chosen for regulatory compliance, not price accuracy. The disambiguation is built into the tool's surface — not just documentation.

### 5. Filter operator list is exhaustive: `eq`, `gt`, `gte`, `lt`, `lte`, `in`

**Decision:** The six confirmed operators are the complete set. No `ne` (not equal), no `contains`, no regex.

**Rationale:** Verified by probing — an invalid operator returns `{"error":"Invalid Query Param","message":"Invalid query parameter: Operator ':xxx:' is not supported."}`. The official docs list the same six. The Zod enum on `treasury_query_dataset.filters[].operator` should be constrained to exactly these six.

### 6. All API values are strings — no server-side coercion

**Decision:** The `data` field in `treasury_query_dataset` output is typed as `z.record(z.string(), z.string())`. The convenience tools (`treasury_get_debt` etc.) return string amounts in their output schema, with field descriptions noting the string type.

**Rationale:** The API specification explicitly states all values are strings, including dates, numbers, and currencies. Coercing on the server (e.g., `parseFloat(row.tot_pub_debt_out_amt)`) risks precision loss on large CURRENCY values (the national debt has 14 significant digits — JavaScript floats only have 15–16). The DataCanvas path (via DuckDB) can CAST safely; inline callers should be aware of the string contract. The output description documents this clearly.

### 7. `treasury_query_dataset` does not paginate internally

**Decision:** The tool fetches one page per call (specified by `page_size` and `page_number`). It does not auto-paginate across all pages.

**Rationale:** Auto-pagination would be unbounded and could generate dozens of API calls for a large dataset. The `total_count` and `total_pages` in the response let the agent paginate explicitly if needed. For large result sets, the `canvas_id` approach (register one page into canvas, then SQL across it) is preferable. If an agent needs all pages in one call, it can iterate explicitly with `page_number` increments.

### 8. Empty-results detection is the not-found signal — not HTTP status

**Decision:** The `no_data_for_date` and `country_not_found` errors are detected by checking `meta["total-count"] === 0` in a 200 OK response, not by catching an HTTP 404 or 4xx.

**Rationale:** Verified live: filtering for a weekend date or an unrecognized country returns `HTTP 200` with `{"data":[],"meta":{"total-count":0,...}}`. The API only returns 404 HTML for genuinely missing endpoint paths (`invalid_endpoint`), and 400 JSON for bad fields/operators. Domain-level "not found" conditions always come back as successful responses with empty data. The service layer must handle three distinct error shapes: (1) HTML on 404 → `invalid_endpoint`, (2) JSON error object on 400 → `invalid_field`/`invalid_filter`, (3) `200 OK` with `total-count: 0` → domain not-found per caller.

### 9. `treasury_list_datasets` uses embedded catalog, not runtime validation of `treasury_query_dataset` endpoint input

**Decision:** `treasury_query_dataset` does a soft catalog check (warn in enrichment if endpoint not found in catalog) but does not hard-block on unrecognized endpoints.

**Rationale:** The catalog might be stale if Treasury adds new endpoints before a server update. Hard-blocking would break access to new endpoints. Instead: validate against the catalog for known typos, surface a warning notice, but let the request through. The API will return its own 404 HTML if the endpoint is genuinely invalid — the service layer converts that to an `invalid_endpoint` error.
