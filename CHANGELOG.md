# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-08-13

treasury_get_exchange_rates collapses mode=latest on the currency and pages its full series; inline series arrays, row_limit-capped queries, and unavailable staging now disclose themselves; empty filter values are rejected at the schema

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-08-12

treasury_get_debt pages the full debt series and discloses its inline preview, rerouted errors carry their declared recovery hints, and 4xx responses stop burning the retry budget — on mcp-ts-core ^0.11.5 and TypeScript 7

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9 — check-dependency-specifiers + plugin-manifest packaging gates, ctx.content collector, fresh-scaffold devcheck guards; @duckdb/node-api and @types/node bumps

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6 — total-count disclosure, slimmer SQL gate, Docker healthcheck, display-identity fields

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-04

Correct catalog endpoint count — 17 curated endpoints, not 80+

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-02

Public hosted endpoint — https://treasury-fiscaldata.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-01 · 🛡️ Security

Initial public release — 7 Treasury Fiscal Data tools with DataCanvas SQL, security hardening of SQL gate, Dockerfile duckdb native binary fix, and metadata/plugin polish

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-31

Initial scaffold from @cyanheads/mcp-ts-core
