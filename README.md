<div align="center">
  <h1>@cyanheads/treasury-fiscaldata-mcp-server</h1>
  <p><b>Query US Treasury national debt, interest rates, exchange rates, and fiscal datasets via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/treasury-fiscaldata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/treasury-fiscaldata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/treasury-fiscaldata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/treasury-fiscaldata-mcp-server/releases/latest/download/treasury-fiscaldata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=treasury-fiscaldata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdHJlYXN1cnktZmlzY2FsZGF0YS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22treasury-fiscaldata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ftreasury-fiscaldata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://treasury-fiscaldata.caseyjhand.com/mcp](https://treasury-fiscaldata.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools for querying the US Treasury Fiscal Data API, plus two for SQL analytics over DuckDB-backed DataCanvas dataframes:

| Tool | Description |
|:-----|:------------|
| `treasury_list_datasets` | Browse the curated catalog of 17 Treasury Fiscal Data endpoints with field names, descriptions, and update cadence |
| `treasury_query_dataset` | Query any Treasury Fiscal Data endpoint by path, field list, filters, sort, and page — with optional DataCanvas spill |
| `treasury_get_debt` | Fetch national debt (Debt to the Penny) — latest record, specific date, or date-range series with optional DataCanvas spill |
| `treasury_get_interest_rates` | Average interest rates Treasury pays on outstanding securities by type (Bills, Notes, Bonds, TIPS, FRN) |
| `treasury_get_exchange_rates` | Official Treasury statutory exchange rates for ~130 countries, published quarterly |
| `treasury_dataframe_describe` | List DataCanvas dataframes materialized by the treasury_* tools with schema, row count, and TTL |
| `treasury_dataframe_query` | Run a single-statement SELECT against DataCanvas dataframes using standard DuckDB SQL |

### `treasury_list_datasets`

Browse the embedded catalog of available Treasury Fiscal Data endpoints. No network calls — serves from a static catalog bundled with the server.

- Filter by category: `debt`, `interest_rates`, `exchange_rates`, `revenue_spending`, `savings_bonds`, `securities`, `other`
- Keyword search against dataset name and description (case-insensitive substring)
- Returns endpoint paths, field names, types, and update cadence
- Use this first to get the exact endpoint path and field names before calling `treasury_query_dataset`

---

### `treasury_query_dataset`

Generic parameterized query against any Treasury Fiscal Data endpoint.

- Filter syntax: `{ field, operator, value }` where operator is `eq`, `gt`, `gte`, `lt`, `lte`, `in`
- Multiple filters ANDed together
- Pagination via `page_size` (1–10000) and `page_number`
- Sort by any field, descending with `-` prefix (e.g. `-record_date`)
- All response values are strings per the API contract — including numeric and date fields; `"null"` means no value
- Pass `canvas_id` to register results into a named DataCanvas dataframe for SQL via `treasury_dataframe_query` (requires `CANVAS_PROVIDER_TYPE=duckdb`)

---

### `treasury_get_debt`

Convenience tool for national debt (Debt to the Penny) — total public debt outstanding broken into publicly-held debt and intragovernmental holdings.

- `mode=latest` — most recent business-day record
- `mode=date` — specific business day (YYYY-MM-DD; API only records debt on market-open days)
- `mode=series` — date range, sorted newest-first; auto-spills to DataCanvas when the series exceeds 500 rows
- Records go back to 1993-01-04

---

### `treasury_get_interest_rates`

Average interest rates the Treasury pays on outstanding securities. Updated monthly (end-of-month records).

- Covers Bills, Notes, Bonds, TIPS, Floating Rate Notes (FRN), and aggregate marketable/non-marketable totals
- `mode=latest` — most recent month's rates for all or one security type
- `mode=series` — time-range history; auto-spills to DataCanvas when results exceed 200 rows

---

### `treasury_get_exchange_rates`

Official Treasury statutory reporting exchange rates for ~130 countries, published quarterly (March 31, June 30, Sep 30, Dec 31).

- Rate expressed as foreign currency units per 1 USD (e.g. Japan-Yen 159.41 means 1 USD = 159.41 JPY)
- These are **not** market exchange rates — required by US federal agencies for foreign-currency-to-USD conversions in official reporting
- Filter to one or more countries by exact name; omit for all ~130 countries in a quarter
- `mode=series` auto-spills to DataCanvas when results exceed 500 rows (~18,800 rows full history)

---

### `treasury_dataframe_describe` / `treasury_dataframe_query`

In-conversation SQL analytics over the dataframes that `treasury_query_dataset`, `treasury_get_debt`, `treasury_get_interest_rates`, and `treasury_get_exchange_rates` materialize on a shared DuckDB-backed DataCanvas. Each data-returning call with `canvas_id` adds a `df_XXXXX_XXXXX` handle; pass that handle to `treasury_dataframe_query` for joins, aggregates, window functions, and CTEs — standard DuckDB SQL.

- **Read-only.** Writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the SQL gate. System catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied at the bridge layer.
- **All Treasury columns are VARCHAR.** CAST to `DECIMAL` or `DATE` for arithmetic and date comparisons.
- **`register_as` chaining.** `treasury_dataframe_query` can persist its result as a new dataframe with a fresh TTL for multi-step analysis.
- **Per-table TTL.** Dataframes age on their own clock (default 24h, override with `CANVAS_TTL_MS`).
- Requires `CANVAS_PROVIDER_TYPE=duckdb`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Structured output schemas with automatic formatting for human-readable display
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Structured logging with request-scoped context
- STDIO and Streamable HTTP transports

Treasury-specific:

- Curated catalog of 17 Treasury Fiscal Data endpoints with field metadata — no discovery round-trip required. Pass any endpoint path directly to `treasury_query_dataset` to access datasets not in the catalog.
- Convenience tools for the three most-queried datasets (national debt, interest rates, exchange rates)
- Full generic access to any Fiscal Data endpoint via `treasury_query_dataset`
- DataCanvas integration: large time-series pulls register as `df_<id>` dataframes queryable via DuckDB SQL
- No API keys required — the US Treasury Fiscal Data API is free and public

Agent-friendly output:

- Filter expression echo (`applied_filters`) so agents can verify what was sent to the API
- Field-label maps on query results (`field_labels`) map raw field names to human-readable labels
- Enrichment notices on empty results and partial-country mismatches guide the next tool call
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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Set to `duckdb` to enable DataCanvas SQL via `treasury_dataframe_*` tools. Set to `none` to disable (e.g. on Cloudflare Workers). | `duckdb` |
| `CANVAS_TTL_MS` | Per-table TTL for DataCanvas dataframes in milliseconds. | `86400000` (24h) |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js/Bun only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) spans and metrics. | `false` |

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
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t treasury-fiscaldata-mcp-server .
docker run --rm -e CANVAS_PROVIDER_TYPE=duckdb -p 3010:3010 treasury-fiscaldata-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/treasury-fiscaldata-mcp-server`. DuckDB native modules are pre-built in the build stage and copied to the production stage — no extra build tools required at runtime. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — 5 data tools + 2 DataCanvas tools. |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
