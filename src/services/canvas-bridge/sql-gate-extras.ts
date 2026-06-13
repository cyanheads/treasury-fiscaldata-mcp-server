/**
 * @fileoverview Bridge-layer SQL gate addition on top of the framework's
 * read-only gate. The framework denies DuckDB system catalogs
 * (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) via
 * `denySystemCatalogs: true` on the canvas query, and denies the whole
 * `pragma_*` namespace plus file/db-scanner table functions unconditionally.
 * This module covers the one residual the framework's deny-list does not:
 * `which_secret()`, which would otherwise lower into a generic scan operator
 * and slip through.
 * @module services/canvas-bridge/sql-gate-extras
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

// DuckDB metadata functions the framework gate does not deny: `which_secret()`
// is not in the framework's table-function deny-list and is not a `pragma_*` /
// `duckdb_*` name, so it lowers into a generic scan operator and slips through.
// Denied by name as defense-in-depth.
const FORBIDDEN_METADATA_PATTERNS: ReadonlyArray<RegExp> = [/\bwhich_secret\b/i];

function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.|"")*"/g, '""');
}

/**
 * Reject SELECTs that reference DuckDB metadata functions the framework gate
 * misses (currently `which_secret`). Throws `ValidationError` with
 * `data.reason = 'system_catalog_access'` — the same reason the framework's
 * `denySystemCatalogs` gate uses, so the tool's contract handling is uniform.
 */
export function assertNoSystemCatalogAccess(sql: string): void {
  const stripped = stripStringLiterals(sql);
  for (const pattern of FORBIDDEN_METADATA_PATTERNS) {
    const match = stripped.match(pattern);
    if (match) {
      throw validationError(`SQL references a denied DuckDB metadata function: ${match[0]}.`, {
        reason: 'system_catalog_access',
        catalog: match[0],
        recovery: {
          hint: 'Query only df_<id> tables. Use treasury_dataframe_describe to list available dataframes.',
        },
      });
    }
  }
}
