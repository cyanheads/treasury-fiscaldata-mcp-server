# Treasury Fiscal Data MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `treasury_list_datasets` | Browse the catalog of available Fiscal Data datasets with endpoints, field names, and update cadence | `category` (optional filter), `search` (optional keyword) | `readOnlyHint`, `idempotentHint` |
| `treasury_query_dataset` | Generic parameterized query against any dataset by endpoint path — fields, filters, sort, pagination, and optional DataCanvas spillover for large results | `endpoint`, `fields[]`, `filters[]`, `sort`, `page_size`, `page_number`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_debt` | National debt (Debt to the Penny) — latest, a specific date, or a time series with DataCanvas for multi-year pulls | `mode` (`latest`\|`date`\|`series`), `date`, `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_interest_rates` | Average interest rates Treasury pays by security type (Bills, Notes, Bonds, TIPS, FRN) — latest snapshot or time series | `security_type` (optional filter), `mode` (`latest`\|`series`), `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
| `treasury_get_exchange_rates` | Official Treasury reporting exchange rates for one or more currencies — most recently published quarter or historical series. These are statutory rates for federal USD reporting, not market rates. | `countries[]` (optional), `mode` (`latest`\|`series`), `start_date`, `end_date`, `canvas_id` | `readOnlyHint`, `idempotentHint` |
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
- Pagination: `page[size]` (default 100, hard ceiling 10,000 — above it the API returns 400, not a clamped page), `page[number]`
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
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas for large time-series results. Unset resolves to `none`: the data tools still answer, capped and with an enrichment notice saying the rows could not be staged and naming the variable, and `treasury_dataframe_describe` / `treasury_dataframe_query` fail closed with `canvas_unavailable` naming it too. |
| `CANVAS_TTL_MS` | No | Override DataCanvas default TTL (24h). |

No API key env var — the API is fully keyless.

---

## Implementation Order

1. Config skeleton — `server-config.ts` (minimal, no API keys)
2. `fiscalDataService` — `fetchPage()` method, response envelope types, filter builder, 404 HTML detection
3. Embedded dataset catalog (`datasets.ts`) — static map of `{ endpoint, name, description, category, fields[] }`
4. `treasury_list_datasets` — read-only, no upstream calls
5. `treasury_query_dataset` — generic wrapper, registering the page on the canvas bridge when applicable
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
    .describe('Keyword filter against dataset name and description (case-insensitive substring match). Useful for narrowing results when the category is uncertain.'),
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
    // Both arms carry a min-length guard: an empty scalar serializes to a
    // trailing-colon expression the API rejects as a bad *operator*, and an
    // empty list or member serializes to something the API accepts and then
    // does not apply as written.
    value: z.union([z.string().min(1, '…'), z.array(z.string().min(1, '…')).min(1, '…')])
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
    .describe('Set any non-empty value to stage this page as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Omit to receive results inline only. Requires CANVAS_PROVIDER_TYPE=duckdb on the server.'),
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
  canvas_id: z.string().optional().describe('DuckDB table name (df_XXXXX_XXXXX) holding this page. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.'),
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
  {
    reason: 'page_out_of_range',
    code: JsonRpcErrorCode.ValidationError,
    when: 'page_number is past the last page of the matched set — API returns JSON {"error":"Invalid Query Param","message":"...Page #N is out of range..."}',
    recovery: 'Request a page_number within total_pages, which this tool returns on every successful response.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

**DataCanvas note:** registration goes through this server's own `canvasBridge.registerDataframe`, not the framework's `spillover()` helper — the bridge is what mints the `df_XXXXX_XXXXX` name, derives an all-nullable schema, and records per-table TTL and provenance in `ctx.state`. The caller's `canvas_id` is a request to stage, never the name.

**Enrichment:** `notice` (guidance for an off-catalog endpoint, a staged table, staging that was requested and produced none, or an empty match — composed into one string, since the field is last-wins) and `totalCount` (the full match behind this page).

---

### `treasury_get_debt`

**Purpose:** National debt (Debt to the Penny). Returns total public debt outstanding, broken into publicly-held debt and intragovernmental holdings. Three modes: `latest` (most recent daily record), `date` (a specific date), or `series` (a date range). A series stages to DataCanvas when `canvas_id` is set or the match exceeds 500 rows, and returns at most 20 rows inline regardless.

**Upstream:** `GET /v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt&sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `debt_held_public_amt` (CURRENCY), `intragov_hold_amt` (CURRENCY), `tot_pub_debt_out_amt` (CURRENCY), `src_line_nbr` (INTEGER), plus fiscal/calendar year/quarter/month/day fields.

**Input schema:**
```ts
z.object({
  mode: z.enum(['latest', 'date', 'series']).default('latest')
    .describe('"latest" returns the most recent day\'s record. "date" returns the record for a specific date. "series" returns a date range — use with start_date and end_date.'),
  date: z.string().optional()
    .describe('ISO 8601 date (YYYY-MM-DD) for mode=date. Must be a business day; the API only records debt on days the market is open.'),
  start_date: z.string().optional()
    .describe('ISO 8601 start date for mode=series (inclusive). Fiscal Data has daily debt records back to 1993-04-01.'),
  end_date: z.string().optional()
    .describe('ISO 8601 end date for mode=series (inclusive). Defaults to today.'),
  canvas_id: z.string().optional()
    .describe('Set any non-empty value to stage mode=series results as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. Staging also happens on its own when the range matches more than 500 rows. The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Requires CANVAS_PROVIDER_TYPE=duckdb.'),
})
```

**Output schema:**
```ts
z.object({
  record_date: z.string().describe('Date of this debt record (YYYY-MM-DD).'),
  total_debt: z.string().describe('Total public debt outstanding in USD, as a plain decimal string — no separators, no currency symbol, two decimal places. Convert as needed.'),
  debt_held_public: z.string().describe('Debt held by the public (external creditors, Fed, foreign govts) in USD.'),
  intragovernmental_holdings: z.string().describe('Intragovernmental holdings (debt owed to federal trust funds, Social Security, etc.) in USD.'),
  // for series mode:
  series: z.array(z.object({
    record_date: z.string(),
    total_debt: z.string(),
    debt_held_public: z.string(),
    intragovernmental_holdings: z.string(),
  })).optional().describe('Inline preview of the mode=series records — at most 20 rows, newest first. Compare series.length against retrieved_records to detect the cap.'),
  total_records: z.number().optional().describe('Records matching the date range upstream. Exceeds retrieved_records when the match is larger than the series row bound.'),
  retrieved_records: z.number().optional().describe('Records actually fetched across every page, and the row count of the canvas table when one was registered. Never larger than total_records.'),
  canvas_id: z.string().optional().describe('DuckDB table name (df_XXXXX_XXXXX) holding the full retrieved series. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.'),
  canvas_expires_at: z.string().optional(),
})
```

Three counts, not one, because they can genuinely disagree: `total_records` is what the API matched, `retrieved_records` is what paging actually walked (bounded at 50,000 rows), and `series.length` is what fits inline (bounded at 20). Collapsing any pair would let the response claim rows it never fetched.

**Enrichment:**
```ts
enrichment: {
  truncated: z.boolean().optional()
    .describe('True when the inline series array holds fewer rows than were retrieved.'),
  shown: z.number().optional().describe('Series rows returned inline.'),
  cap: z.number().optional().describe('The preview cap applied to the inline series array.'),
  notice: z.string().optional()
    .describe('Guidance when the inline series is a preview, when the series was staged as a DataCanvas table, or when paging stopped before the full matched set.'),
}
```

`truncated()` writes `notice` too, so the handler composes every segment into one string and flushes once — `truncated()` when the inline array is short, plain `notice()` otherwise. A staged series that fit inline in full still emits the pointer; it just must not also claim truncation.

**Errors:**
```ts
errors: [
  {
    reason: 'no_data_for_date',
    code: JsonRpcErrorCode.NotFound,
    when: 'No debt record exists for the requested date (API returns HTTP 200 with empty data[], not 404 — service layer must detect total-count: 0)',
    recovery: 'Fiscal Data only records debt on business days from 1993-04-01 onward. Try the nearest business day, or use mode=series with a date range.',
  },
]
```

> **Implementation note:** "No data for date" is NOT an HTTP 4xx — the API returns `200 OK` with `{"data":[],"meta":{"total-count":0,...}}`. The service layer must detect `total-count === 0` and surface this as the `no_data_for_date` error, not rely on HTTP status.

> **Coverage bound:** the earliest `debt_to_penny` record is `1993-04-01` — nothing exists before it, and 1993 holds 191 records, about nine months of business days. Every surface that names the bound says `1993-04-01`.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_get_interest_rates`

**Purpose:** Average interest rates Treasury pays on its outstanding securities, by security type. Answers "what is the government's cost of borrowing?" Covers Bills, Notes, Bonds, TIPS, Floating Rate Notes, and aggregate marketable/non-marketable totals. Updated monthly (end-of-month records). Two modes: `latest` (most recent month's rates for all or one security type) and `series` (time history for a security type).

**Upstream:** `GET /v2/accounting/od/avg_interest_rates?sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `security_type_desc` (STRING: `"Marketable"` | `"Non-marketable"` | `"Interest-bearing Debt"`), `security_desc` (STRING: `"Treasury Bills"`, `"Treasury Notes"`, `"Treasury Bonds"`, `"Treasury Inflation-Protected Securities (TIPS)"`, `"Treasury Floating Rate Notes (FRN)"`, plus aggregates `"Total Marketable"`, `"Total Non-marketable"`, `"Total Interest-bearing Debt"`), `avg_interest_rate_amt` (PERCENTAGE as string, e.g., `"3.696"`), `src_line_nbr` (INTEGER).

> **Filtering note:** The `security_type` input parameter filters on `security_desc` (not `security_type_desc`). The Zod enum values must match `security_desc` exactly (e.g., `"Total Interest-bearing Debt"`, not `"Interest-bearing Debt"`). The `security_type_desc` field is a broader category and cannot be used alone to reach individual security types.

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
    .describe('Set any non-empty value to stage mode=series results as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. Staging also happens on its own when a series matches more than 200 rows. The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Requires CANVAS_PROVIDER_TYPE=duckdb.'),
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
  })).describe('Interest rate records, newest first. Whole in mode=latest — a month is a bounded set. In mode=series an inline preview of at most 20 rows; compare its length against total_records to detect the cap, and reach the rest through canvas_id when one is returned.'),
  total_records: z.number().describe('In mode=latest, the number of rows in rates. In mode=series, the full upstream match — larger than rates.length whenever the preview cap applied.'),
  canvas_id: z.string().optional().describe('DuckDB table name (df_XXXXX_XXXXX) holding the staged series. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.'),
  canvas_expires_at: z.string().optional(),
})
```

**Enrichment:** `truncated` / `shown` / `cap` for the inline preview, and `notice` — the empty-result guidance below, the preview disclosure, and the staging state, composed into one string because the field is last-wins. The empty-result guidance cannot co-occur with the others: an empty match returns before staging is considered.

**Bounds.** `mode=series` fetches one page of 10,000, which covers the whole 4,993-row corpus; `mode=latest` fetches 100 and keeps the newest `record_date`, against an all-time widest month of 17 rows and 22 distinct `security_desc` values ever published. The inline `rates` array is capped at 20 in series mode **unconditionally** — not only when a canvas absorbed the remainder, since the default install has no canvas and used to return the entire fetched page.

**Errors:** Baseline errors only (upstream 5xx, timeout). No domain errors — if `security_type` doesn't match, API returns empty rows; handler surfaces `total_records: 0` with an enrichment notice listing valid security descriptions. The notice names only the constraints the query actually carried: a date range is sent in series mode alone, so latest mode never blames one.

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`

---

### `treasury_get_exchange_rates`

**Purpose:** Official Treasury reporting exchange rates — the rates US federal agencies are required to use when converting foreign currency to USD for official reporting. Published quarterly. These are **not market exchange rates** and not suitable for financial transaction pricing. Use for federal reporting compliance, inter-agency reconciliation, or auditing foreign-currency transactions in government financial statements.

Mode `latest` returns the most recently published quarter — never a fixed date, since a new quarter lands on Treasury's schedule. Exchange rate is expressed as foreign currency units per 1 USD (a Japan-Yen rate of 159.41 means 1 USD = 159.41 JPY).

**Upstream:** `GET /v1/accounting/od/rates_of_exchange?sort=-record_date`

**Verified fields from live API:** `record_date` (DATE), `country` (STRING), `currency` (STRING), `country_currency_desc` (STRING, format "Country-Currency", e.g., "Japan-Yen"), `exchange_rate` (NUMBER as string), `effective_date` (DATE), `src_line_nbr` (INTEGER).

**`effective_date` is not a copy of `record_date`.** Treasury amends a published quarter by reissuing a currency's rate under the same `record_date` with a later `effective_date`, so a recent quarter carries several distinct effective dates and can gain more after it is published. So `record_date` alone does not identify the operative rate, and a single top-level date cannot describe the set.

**Total rows:** ~19,000 (full history, earliest `record_date` 2001-03-31). A recent quarter holds ~170 rows across ~165 countries — more rows than countries, because a country can hold two legal tenders at once (Cuba-Chavito and Cuba-Peso) and because amendments add rows.

**Input schema:**
```ts
z.object({
  mode: z.enum(['latest', 'series']).default('latest')
    .describe('"latest" returns the most recently published quarter\'s rates. "series" returns a date range of quarterly reports.'),
  countries: z.array(z.string()).optional()
    .describe('Filter to specific countries by exact country name (e.g., ["Japan", "Germany", "France"]). Case-sensitive, matches the "country" field. Omit for every country in the quarter (~165).'),
  start_date: z.string().optional()
    .describe('ISO 8601 start date for mode=series. Rates are published end-of-quarter (March 31, June 30, Sep 30, Dec 31).'),
  end_date: z.string().optional()
    .describe('ISO 8601 end date for mode=series.'),
  canvas_id: z.string().optional()
    .describe('Set any non-empty value to stage mode=series results as a DataCanvas table for SQL analysis — the value only requests staging; the server picks the table name. Staging also happens on its own when a series matches more than 500 rows, which multi-year multi-country pulls do (~19,000 rows for the full history). The assigned name (df_XXXXX_XXXXX) comes back in the output canvas_id; pass it to treasury_dataframe_describe, then treasury_dataframe_query. Requires CANVAS_PROVIDER_TYPE=duckdb.'),
})
```

**Output schema:**
```ts
z.object({
  as_of_date: z.string().describe('Most recent quarter-end record_date among the returned rows (YYYY-MM-DD). Not necessarily a date every row shares — check mixed_record_dates.'),
  effective_date: z.string().describe('Effective date of the as_of_date row (YYYY-MM-DD). Every row carries its own effective_date; this one does not describe the rest.'),
  mixed_record_dates: z.boolean().describe("True when the retrieved rows were not all published on as_of_date — including rows past the inline preview. Read each row's record_date rather than applying the top-level date to the set."),
  rates: z.array(z.object({
    country: z.string(),
    currency: z.string(),
    country_currency_desc: z.string().describe('"Country-Currency" combined label (e.g., "Japan-Yen"). Use for in= filter values.'),
    exchange_rate: z.string().describe('Foreign currency units per 1 USD. A value of 159.41 for Japan-Yen means 1 USD = 159.41 JPY.'),
    record_date: z.string().describe('Quarter-end record date this rate was published under (YYYY-MM-DD).'),
    effective_date: z.string().describe('Date this rate takes effect (YYYY-MM-DD). Later than record_date when Treasury amends a rate mid-quarter.'),
  })).describe('Exchange rates for the requested countries/quarter, newest first. Whole in mode=latest — a quarter is a bounded set. In mode=series an inline preview of at most 20 rows; compare its length against retrieved_records to detect the cap, and reach the rest through canvas_id when one is returned.'),
  total_records: z.number().describe('In mode=latest, the number of rows in rates. In mode=series, the full upstream match — larger than rates.length whenever the preview cap applied, and larger than retrieved_records when paging stopped first.'),
  retrieved_records: z.number().optional().describe('Rows actually fetched for mode=series across every page, and the row count of the canvas table when one was registered. Never larger than total_records.'),
  note: z.string().describe('Contextual note reminding that these are official reporting rates, not market rates.'),
  canvas_id: z.string().optional().describe('DuckDB table name (df_XXXXX_XXXXX) holding the staged series. Pass it to treasury_dataframe_describe for the column schema, then use it as the FROM target in treasury_dataframe_query SQL. Absent when nothing was staged.'),
  canvas_expires_at: z.string().optional(),
})
```

**Selection in `latest` mode.** Rows collapse to one per `country_currency_desc` — greatest `record_date`, then greatest `effective_date`. The identity is the currency, not the country: keying on country would drop one of a two-currency country outright rather than pick a newer version of it. Selection is explicit rather than trusting row order within a date, which the API does not document as meaningful, and no clock is read — an amendment published ahead of its effective date is still returned, with its `effective_date` disclosing when it takes hold.

An unfiltered `latest` narrows to the newest published quarter first; a country filter deliberately does not, so a country that stopped being published individually keeps its last rate instead of vanishing. That is why the returned rows can straddle quarters, why `mixed_record_dates` exists, and why `format()` withholds the single `**As of:**` header when it is set. A `series` spanning quarters sets the flag too, but earns no notice — a date range is the shape the caller asked for.

**Fetching.** An unfiltered `latest` costs two calls: a one-row probe names the newest `record_date`, then the real fetch filters on that date. A quarter is a bounded set — 170 to 201 rows across the last ten published, trending up — so a fixed slice of the newest rows silently drops whichever row falls past it, and nothing downstream can tell. Asking for the quarter by date bounds the fetch by the quarter itself, against the API's own 10,000-row page ceiling. A country filter takes one call and no date filter, since the point is to keep a country's last published rate. `series` walks `page[number]` to 50,000 rows, because the full history is ~19,000 against that 10,000 ceiling; `retrieved_records` reports what the walk reached.

**Enrichment:** `truncated` / `shown` / `cap` for the inline preview, and `notice` — unmatched country names, the preview disclosure, the staging state, a bounded fetch, and the mixed-date disclosure, composed into one string because the field is last-wins. The inline `rates` array is capped at 20 in series mode **unconditionally**, not only when a canvas absorbed the remainder.

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
    .describe('Persist the result as a new dataframe under this exact name, to chain analyses. The name is used verbatim — any name works, and a df_ prefix keeps it consistent with the tables the data tools mint. Echoed back in registered_as.'),
  preview: z.number().int().min(0).max(10000).optional()
    .describe('Rows in the immediate response. Defaults to row_limit and may not exceed it. Set lower when using register_as.'),
  row_limit: z.number().int().min(1).max(10000).default(1000)
    .describe('Hard cap on rows in the response. Default 1000, max 10000.'),
})
```

`preview` may never exceed `row_limit` — the canvas rejects that pair outright. So whenever `preview` is supplied it is the binding cap, and truncation guidance must name it rather than `row_limit`; at equality both have to move together.

The two caps truncate differently and only one is visible in the row arithmetic. `preview` trims the returned rows and leaves `row_count` exact, so `row_count > rows.length` detects it. `row_limit` bounds the query itself, so it produces exactly that many rows and `row_count === rows.length` — indistinguishable from a table holding exactly `row_limit` rows. The canvas reads one row past the cap and reports `truncated` on its `QueryResult`; that flag is the only signal, and it drives `row_count_capped`. Guidance for it names `row_limit` and `register_as`, never `preview`, which cannot move a cap it already sits at or below.

**Output schema:**
```ts
z.object({
  columns: z.array(z.string()),
  row_count: z.number().describe('Rows the query produced, up to row_limit. Exceeds rows.length when preview returned fewer. Read with row_count_capped: when that is true this number is row_limit itself, and the size of the full result is not in this response.'),
  row_count_capped: z.boolean().describe('True when the query matched more rows than row_limit, so row_count is that cap rather than a total. False means row_count is exact — including when it happens to equal row_limit.'),
  rows: z.array(z.record(z.string(), z.unknown())),
  registered_as: z.string().optional(),
  expires_at: z.string().optional(),
})
```

**Enrichment (reaches both structuredContent and content[] automatically):**
```ts
enrichment: {
  notice: z.string().optional()
    .describe('Guidance when the query returned no rows, or when results were capped by preview or row_limit.'),
  truncated: z.boolean().optional()
    .describe('True when the returned rows were capped below the full result set.'),
  shown: z.number().optional()
    .describe('Number of rows returned in this response.'),
  cap: z.number().optional()
    .describe('The row cap that was applied — preview when supplied, otherwise row_limit.'),
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
  {
    reason: 'missing_table',
    code: JsonRpcErrorCode.NotFound,
    when: 'A df_<id> table named in the SQL is not on the canvas — its TTL expired, it was dropped, or it was never registered',
    recovery: 'Call treasury_dataframe_describe to list live tables, or re-stage the rows by passing canvas_id to treasury_query_dataset, treasury_get_debt, treasury_get_interest_rates, or treasury_get_exchange_rates.',
  },
  {
    reason: 'invalid_query_bounds',
    code: JsonRpcErrorCode.ValidationError,
    when: 'preview exceeds row_limit, or row_limit exceeds the row ceiling this server allows',
    recovery: 'Keep preview at or below row_limit, and keep row_limit within the ceiling this server allows.',
  },
]
```

`missing_table` and `invalid_query_bounds` originate in the framework canvas layer, whose own messages and hints name in-process methods (`registerTable()`, `describe()`) and framework field names (`rowLimit`). The handler reroutes both through `ctx.fail`, replacing message and hint with this server's tool and parameter names — an MCP client can reach those, and cannot reach the framework's.

> **Implementation note (mirrors secedgar gold standard):** Use `ctx.enrich.notice(...)` in the handler for empty-result and row-cap conditions — not `format()` text — so the notice reaches both `structuredContent` (Claude Code) and `content[]` (Claude Desktop) automatically. Check `result.rowCount === 0`, then `result.truncated` (the `row_limit` cap), then `result.rowCount > result.rows.length` (the `preview` cap) after executing — in that order, since a `row_limit`-capped result satisfies neither of the arithmetic tests. `register_as` is forwarded to the canvas provider verbatim: neither this server's bridge nor the framework's `CanvasInstance.query()` checks it against the `df_XXXXX_XXXXX` shape, so its description must not assert one.

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
  &page[size]=N        # default 100; 10,000 max (400 above it)
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
    "total-count": 8369,
    "total-pages": 4185
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
- **400 (bad field, operator, or out-of-range page):** Returns JSON `{"error":"Invalid Query Param","message":"..."}` — parse as a structured validation error, not an HTML page. Three message patterns are recognized: `Field 'X' does not exist` → `invalid_field`, `Operator ':op:' is not supported` → `invalid_filter`, `Page #N is out of range` → `page_out_of_range`.
- **Empty results (date/country not found):** Returns `200 OK` with `{"data":[],"meta":{"total-count":0,...}}`. NOT a 4xx. Service layer must check `meta["total-count"] === 0` to surface domain-level not-found conditions.

**Retry classification.** The status class decides retryability; the message patterns above only pick a more specific reason. A 4xx carries the framework's `httpStatusToErrorCode` mapping, which `withRetry` treats as terminal — except 408/425/429, where waiting is the remedy. Everything else stays `ServiceUnavailable` and keeps its retry budget. Message matching must never be what decides whether to retry: a fourth 400 message pattern nobody has seen yet still fails fast.

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
| 2 | `GET /v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt&filter=...&sort=-record_date&page[size]=10000&page[number]=N` | Walk pages until the match is exhausted or 50,000 rows are held |
| 3 | If `canvas_id` was set or `total-count` > 500: `canvasBridge.registerDataframe()` over every retrieved row | Register dataframe |
| 4 | Return inline preview (first 20 rows) + `canvas_id` + `total_records` + `retrieved_records` | Response |

One API call covers most series queries — 10,000 is the API's hard `page[size]` ceiling (above it the request is rejected, not clamped), and the whole daily history is still under 8,500 rows. Paging exists for the case where a filter is absent or a future history outgrows one page; it stops at 50,000 rows and reports `retrieved_records` below `total_records` rather than claiming rows it never fetched.

### `treasury_query_dataset` (generic, canvas)

| # | Action | Purpose |
|:--|:-------|:--------|
| 1 | Validate `endpoint` against the embedded catalog (optional, warn-not-block) | Catch typos early |
| 2 | Build `fields=`, `filter=`, `sort=` from structured inputs | Translation layer |
| 3 | `GET {endpoint}?...&page[size]={page_size}&page[number]={page_number}` | Fetch one page |
| 4 | If `canvas_id` is non-empty and the page has rows: register via `canvasBridge.registerDataframe()` | Canvas registration |
| 5 | Return rows, metadata, assigned table name | Response |

---

## Known Limitations

- **No programmatic dataset catalog.** The API has no `/datasets` discovery endpoint — the catalog must be embedded as static data in the server and maintained as Treasury adds datasets. The embedded catalog covers 17 curated endpoints out of the ~80 the API documents, and may drift as Treasury adds datasets; anything outside it is still reachable by passing the path to `treasury_query_dataset`.
- **All values are strings.** The API returns every value (including dates, numbers, currencies) as a JSON string. All parsing and type conversion is the consumer's responsibility. `"null"` is a string, not JSON null. Verified: MTS table 5 `current_fytd_gross_outly_amt` returns `"null"` for many rows.
- **Empty results ≠ 404.** Filtering for a date with no data (weekend, holiday) or an unrecognized country/security returns `200 OK` with `data:[]` and `meta["total-count"]:0`. Service layer must detect this pattern explicitly — it cannot rely on HTTP status codes for "not found" domain conditions.
- **`CURRENCY0` dataType variant.** Some endpoints (e.g., `operating_cash_balance`) use `CURRENCY0` in `meta.dataTypes` (whole-dollar amounts, no cents). The service layer and embedded catalog should handle this alongside `CURRENCY`.
- **`links` values are fragments, not absolute URLs.** `meta["total-count"]` and `meta["total-pages"]` are the reliable pagination signals.
- **Exchange rate dates.** Every `record_date` on `rates_of_exchange` is a quarter end; `filter=record_date:eq:2026-02-15` returns empty. `effective_date` is not so constrained — an amendment carries a mid-quarter one.
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

**Rationale:** Treasury data is inherently time-series. Debt history from 1993 is ~8,400 rows and grows every business day; full exchange rate history is ~19,000 rows; a multi-security multi-year interest rate series can be 4,000+ rows. These are non-trivial to reason about inline but straightforward with SQL (`SELECT record_date, CAST(tot_pub_debt_out_amt AS DECIMAL) AS debt FROM df_xxxxx WHERE record_date >= '2020-01-01' ORDER BY record_date`). DataCanvas earns its keep here. However, for typical queries (latest debt, this quarter's FX rates, current month's interest rates), results are small enough to inline — canvas is additive, not required.

**Implementation note (as built):** registration goes through this server's own `canvasBridge.registerDataframe`, not `api-canvas`'s `spillover()` helper — the bridge owns `df_XXXXX_XXXXX` minting, the all-nullable schema Treasury's sparse "null" strings require, and per-table TTL and provenance in `ctx.state`. Staging triggers: the convenience tools stage on a non-empty `canvas_id` **or** on a row threshold (500 for debt and exchange rates, 200 for interest rates); `treasury_query_dataset` stages only on an explicit `canvas_id`, since the generic tool cannot judge result size without a count query first.

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

### 10. Retryability keys on the HTTP status class, never on the error message

**Decision:** `FiscalDataService.fetchPage` derives the thrown error's code from the response status (`httpStatusToErrorCode` for 4xx, `ServiceUnavailable` otherwise) and lets `withRetry`'s code-based predicate follow from it. Message pattern matching only selects a more specific `reason`.

**Rationale:** The 400 message patterns are an open set — Fiscal Data returns one for bad fields, one for bad operators, one for out-of-range pages, and there is no published list. When retryability was decided by which patterns matched, every unmatched 400 defaulted to `ServiceUnavailable` and burned the full retry budget on a rejection the API would never reverse; the caller waited seconds for a verdict available on the first response and then read `(failed after 4 attempts)`, which reads like an upstream flake. Keying on the status class means an unrecognized 400 fails fast on its own, so adding a fourth message pattern is a reason refinement rather than a retry fix.

### 11. Recovery hints name only what the caller can reach

**Decision:** Every declared `recovery` hint and every `ctx.enrich` guidance string names an MCP tool on this server or an input parameter of the tool that was just called. Errors originating in the framework are rerouted through `ctx.fail` with both message and hint rewritten; guidance that varies by request state branches on what the caller actually sent.

**Rationale:** A hint the caller cannot act on is worse than none — it costs a round trip and reads as authoritative. Three shapes recur: a framework hint naming in-process methods (`registerTable()`, `describe()`) that no MCP client can call; a hint naming the remedy the caller already applied (advising `canvas_id` to someone who passed `canvas_id`, or explaining business days to someone who omitted `date` entirely); and a hint naming the wrong lever (advising `row_limit` when `preview` is the smaller, binding cap). Each is caught by asking one question of the string: from the caller's seat, is the thing it names reachable, and is it the thing that actually bound?

### 12. No hard-coded "as of" figure anywhere in the surface

**Decision:** No hard-coded "as of" figure anywhere in the surface. Descriptions carry scope and cadence; the values come from calling the tool.

**Rationale:** A dated snapshot in a `tools/list` string goes stale on the upstream's own publication schedule — daily for debt, monthly for interest rates, quarterly for exchange rates — and an agent that reads one plans against a number the very next call disproves.

### 13. A response that is incomplete says so, on both consumption paths

**Decision:** Every path that can return less than it matched discloses it. A fetch bounded by a page size or a row bound reports what it retrieved beside the upstream match (`retrieved_records` against `total_records`); an inline array capped below what was retrieved calls `ctx.enrich.truncated`; a query capped by `row_limit` sets `row_count_capped`; staging that was requested and produced no table says why. Where a bound can be removed rather than disclosed, it is: `treasury_get_exchange_rates` asks for the newest quarter by its own date instead of taking a fixed slice of the newest rows, and walks pages for a series rather than stopping at one.

**Rationale:** Silent incompleteness is the worst failure this surface can have, because the caller cannot detect it and the response looks authoritative. Three shapes produced it. A fixed fetch bound sized against a set that grows past it — a 200-row page against a quarter that reached 201, dropping a currency with nothing in the response to say so. A cap applied only on the branch that had somewhere to put the remainder — `canvasId ? rows.slice(0, 20) : rows` returns everything when no canvas is configured, which is the default install. And a cap the row arithmetic cannot see — `row_limit` produces exactly the rows it permits, so `row_count > rows.length` never fires and 1,000 rows of 19,000 read as complete. The test each of them fails: from the response alone, can the caller tell a complete answer from a truncated one? Disclosure has to reach both `structuredContent` and `content[]`, which is why it rides `ctx.enrich` or an output field rendered by `format()`, never `format()` text alone.
