<div align="center">
  <h1>@cyanheads/treasury-fiscaldata-mcp-server</h1>
  <p><b>Query US Treasury national debt, interest rates, exchange rates, and fiscal datasets via MCP.</b>
  <div>8 Tools · dataframe drop is opt-in</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/treasury-fiscaldata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/treasury-fiscaldata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/treasury-fiscaldata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/treasury-fiscaldata-mcp-server/releases/latest/download/treasury-fiscaldata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=treasury-fiscaldata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdHJlYXN1cnktZmlzY2FsZGF0YS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22treasury-fiscaldata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ftreasury-fiscaldata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://treasury-fiscaldata.caseyjhand.com/mcp](https://treasury-fiscaldata.caseyjhand.com/mcp)

</div>

---

## Overview

US Treasury Fiscal Data — national debt, interest rates, exchange rates, and other fiscal datasets. Browse a curated catalog of 17 endpoints, query any endpoint directly, or stage large pulls as DuckDB dataframes for SQL analysis, from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `treasury_list_datasets` | Browse the curated catalog of 17 Treasury Fiscal Data endpoints with field names, descriptions, and update cadence |
| `treasury_query_dataset` | Query any Treasury Fiscal Data endpoint by path, field list, filters, sort, and page — with optional DataCanvas spill |
| `treasury_get_debt` | Fetch national debt (Debt to the Penny) — latest record, specific date, or date-range series with optional DataCanvas spill |
| `treasury_get_interest_rates` | Average interest rates Treasury pays on outstanding securities by type — marketable issues, non-marketable series, and aggregate totals |
| `treasury_get_exchange_rates` | Official Treasury statutory exchange rates for ~165 countries, published quarterly |
| `treasury_dataframe_describe` | List DataCanvas dataframes materialized by the treasury_* tools with schema, row count, and TTL |
| `treasury_dataframe_query` | Run a single-statement SELECT against DataCanvas dataframes using standard DuckDB SQL |
| `treasury_dataframe_drop` | Delete a staged dataframe and its provenance (disabled unless `TREASURY_DATAFRAME_DROP_ENABLED=true`) |

## Capability reference

### `treasury_list_datasets` <sub>tool</sub>

- Filter by category (`debt`, `interest_rates`, `exchange_rates`, `revenue_spending`, `savings_bonds`, `securities`, `other`) or keyword search.
- Returns endpoint paths, fields, types, and update cadence from a bundled catalog, with no network call.

---

### `treasury_query_dataset` <sub>tool</sub>

- Query an endpoint with `{ field, operator, value }` filters (`eq`, `gt`, `gte`, `lt`, `lte`, `in`), sort, and pagination: `page_size` 1–10000 (default 100), `page_number` starts at 1.
- Returns rows, field labels, `total_count`, and `total_pages`; error reasons are `invalid_endpoint`, `invalid_field`, `invalid_filter`, and `page_out_of_range`.
- Pass `canvas_id` to stage the page for SQL analysis; the returned `canvas_id` is the assigned table name.

---

### `treasury_get_debt` <sub>tool</sub>

- `mode=latest` returns the newest business-day record; `mode=date` accepts a YYYY-MM-DD date; `mode=series` accepts a date range. Coverage begins 1993-04-01.
- Returns debt totals and a 20-row series preview; compare `retrieved_records` with `total_records`. A missing date returns `no_data_for_date`.
- Series staging starts above 500 rows or on request via `canvas_id`; paging stops at 50,000 rows.

---

### `treasury_get_interest_rates` <sub>tool</sub>

- `mode=latest` returns the newest month's rates, optionally filtered by `security_type`; `mode=series` accepts a date range.
- Rates are percentages, with available security types disclosed when a filter matches nothing; the series preview holds at most 20 rows.
- Series staging starts above 200 rows or on request via `canvas_id`.

---

### `treasury_get_exchange_rates` <sub>tool</sub>

- Quarterly official reporting rates in foreign currency units per 1 USD. Filter `countries` by exact name; `mode=latest` returns one current row per currency and `mode=series` accepts a date range.
- Each row carries `record_date` and `effective_date`; `mixed_record_dates` flags a result spanning quarters. Series previews hold 20 rows; `retrieved_records` discloses progress against `total_records`.
- Series staging starts above 500 rows or on request via `canvas_id`; paging stops at 50,000 rows.
- `country_not_found` error when a requested country has no records

---

### `treasury_dataframe_describe` <sub>tool</sub>

- Omit `name` to list the tenant's active dataframes, or supply one exact table name.
- Returns provenance, created/expiry timestamps, row count, and column schema; `truncated` / `max_rows` disclose a capped source pull.
- Table expiry defaults to 24h after staging, configurable with `CANVAS_TTL_MS`.

---

### `treasury_dataframe_query` <sub>tool</sub>

- Accepts one read-only SELECT; `row_limit` defaults to 1000 (max 10000) and `preview` may not exceed it. System catalogs, external-file functions, and SQL mutations are denied.
- Returns rows and `row_count_capped`; errors distinguish `canvas_unavailable`, `system_catalog_access`, `invalid_sql`, `missing_table`, and `invalid_query_bounds`.
- `register_as` materializes the full result as a new dataframe with a fresh TTL.

---

### `treasury_dataframe_drop` <sub>tool</sub>

- Accepts the exact `name` from `treasury_dataframe_describe`, a data tool's `canvas_id`, or query's `registered_as`; deletes that table and its provenance for the tenant.
- Returns `name` and `dropped: true`; an absent or expired table returns `missing_table` with guidance to list active tables.
- Disabled by default. Set `TREASURY_DATAFRAME_DROP_ENABLED=true` and `CANVAS_PROVIDER_TYPE=duckdb` to make it callable; the HTTP landing page shows the disabled tool and enable hint otherwise.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Fiscal Data-specific:

- All API values are strings; `"null"` means no value. Treasury dataframe columns are VARCHAR — CAST to DECIMAL or DATE for arithmetic and date comparisons. DataCanvas requires `CANVAS_PROVIDER_TYPE=duckdb`; configured canvas tools report `canvas_unavailable` otherwise.
- Curated catalog of 17 endpoints with field metadata — no discovery round-trip required; pass any endpoint path directly to `treasury_query_dataset` for datasets outside the catalog
- Convenience tools for the three most-queried datasets — national debt, interest rates, exchange rates
- DataCanvas integration: large pulls register as `df_<id>` dataframes queryable via DuckDB SQL, with automatic staging thresholds per tool
- No API key required — the US Treasury Fiscal Data API is free and public

Agent-friendly output:

- Provenance: filter-expression echo (`applied_filters`) and field-label maps (`field_labels`) let agents verify what was sent and read raw field names
- Enrichment notices: empty-result guidance, partial-country mismatches, canvas staging confirmations, and truncated-series warnings all name the next tool call
- Graceful truncation: series and query results carry `truncated` / `retrieved_records` / `row_count_capped` fields instead of silently dropping rows
- Canvas provenance: source tool, original query parameters, row count, and column schema surfaced by `treasury_dataframe_describe`

## Getting started

### Public Hosted Instance

A public instance is available at `https://treasury-fiscaldata.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "treasury-fiscaldata-mcp-server": {
      "type": "streamable-http",
      "url": "https://treasury-fiscaldata.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "treasury-fiscaldata-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/treasury-fiscaldata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "treasury-fiscaldata-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/treasury-fiscaldata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "treasury-fiscaldata-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/treasury-fiscaldata-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### DataCanvas SQL workflow

For large time-series pulls or multi-dataset analysis, use the DataCanvas SQL workflow:

1. **Set `CANVAS_PROVIDER_TYPE=duckdb`** in your server environment.
2. **Call a data tool with a `canvas_id`** — e.g., `treasury_get_debt` with `mode=series` and a `canvas_id` value, or `treasury_query_dataset` with `canvas_id`. The tool registers the results as a `df_XXXXX_XXXXX` dataframe and returns the table name.
3. **Inspect the schema** with `treasury_dataframe_describe` — lists column names, types (all VARCHAR for Treasury data), row count, and TTL.
4. **Query with SQL** via `treasury_dataframe_query` — standard DuckDB SELECT with joins, aggregates, window functions, and CTEs. CAST VARCHAR columns to DECIMAL or DATE for arithmetic.

```sql
-- Example: debt trend over the last year, month-end records only
SELECT
  record_date,
  CAST(tot_pub_debt_out_amt AS DECIMAL) / 1e12 AS total_debt_trillions
FROM df_xxxxx
WHERE CAST(record_date AS DATE) >= CURRENT_DATE - INTERVAL 1 YEAR
ORDER BY record_date DESC
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — the US Treasury Fiscal Data API is free and public.
- For DataCanvas SQL: `CANVAS_PROVIDER_TYPE=duckdb` (DuckDB is bundled as `@duckdb/node-api`).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/treasury-fiscaldata-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd treasury-fiscaldata-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env as needed — no required vars; CANVAS_PROVIDER_TYPE=duckdb to enable SQL
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` for dataframe describe/query and for drop when enabled. With `none`, callable canvas tools return `canvas_unavailable`; drop stays off the tool list unless separately enabled. | `none` |
| `CANVAS_TTL_MS` | Per-table TTL for DataCanvas dataframes in milliseconds. | `86400000` (24h) |
| `TREASURY_DATAFRAME_DROP_ENABLED` | Register `treasury_dataframe_drop` as callable. Also requires `CANVAS_PROVIDER_TYPE=duckdb`. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `auto`, `stateful`, or `stateless`. Setting it overrides the server's own declaration; leaving it unset falls through to that declaration, not to the schema default. | `stateless` (declared in `src/index.ts`) |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js/Bun only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call arguments and results, redacted by key name. Secrets inside free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Byte cap for each logged failed-call payload. | `16384` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) spans and metrics. | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint for traces and metrics. | Unset |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit OTLP log endpoint; the base endpoint does not enable log export. | Unset |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild

  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck         # Lint, format, typecheck, security
  bun run test             # Vitest test suite
  bun run lint:mcp         # Validate MCP definitions against spec
  bun run lint:deps        # Detect unused and missing dependencies with Knip
  bun run verify:catalog   # Probe every catalog endpoint and field against the live API
  ```

  `verify:catalog` makes live Fiscal Data requests and runs separately from `devcheck` and the test suite. Run it after editing `src/services/fiscal-data/datasets.ts` and before a release.

  Builds type-check and emit declarations with TypeScript, then use Bun to bundle server code as Node-compatible ESM in `dist/index.js`. Package dependencies remain external, including the framework and DuckDB native bindings. The installed server runs on Node or Bun; building from source requires Bun. Dependency checks use `knip.jsonc` to cover source, scripts, and tests.

### Docker

```sh
docker build -t treasury-fiscaldata-mcp-server .
docker run --rm -e CANVAS_PROVIDER_TYPE=duckdb -p 3010:3010 treasury-fiscaldata-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/treasury-fiscaldata-mcp-server`. A native build-host dependency stage cross-installs DuckDB bindings for the target architecture, preserves the release-age and security checks, and removes unused musl bindings. OpenTelemetry peers are installed at the framework's declared ranges — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — 5 data tools + 3 DataCanvas tools, including opt-in drop. |
| `src/services/fiscal-data/` | Treasury Fiscal Data API client, embedded endpoint catalog, and types. |
| `src/services/canvas-bridge/` | Adapter over the framework DataCanvas: `df_<id>` minting, per-table TTL, system-catalog SQL deny. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- All Treasury API values are strings — validate and CAST in downstream SQL; never fabricate missing fields
- Register new tools via the arrays in `src/index.ts`

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
