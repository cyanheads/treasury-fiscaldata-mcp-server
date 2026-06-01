/**
 * @fileoverview Bridge-layer SQL gate additions on top of the framework's
 * read-only gate. Denies access to DuckDB system catalogs so callers cannot
 * enumerate every df_<id> on the shared canvas.
 * @module services/canvas-bridge/sql-gate-extras
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

const FORBIDDEN_CATALOG_PATTERNS: ReadonlyArray<RegExp> = [
  /\binformation_schema\b/i,
  /\bpg_catalog\b/i,
  /\bsqlite_master\b/i,
  /\bduckdb_[a-z_]+\b/i,
  // DuckDB pragma table-valued functions that expose internal metadata.
  // These are not in the framework's denied-function list because they lower
  // into generic plan operators, so we catch them here by name.
  /\bpragma_database_size\b/i,
  /\bwhich_secret\b/i,
];

function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.|"")*"/g, '""');
}

/**
 * Reject SELECTs that reference DuckDB system catalogs. Throws
 * `ValidationError` with `data.reason = 'system_catalog_access'`.
 */
export function assertNoSystemCatalogAccess(sql: string): void {
  const stripped = stripStringLiterals(sql);
  for (const pattern of FORBIDDEN_CATALOG_PATTERNS) {
    const match = stripped.match(pattern);
    if (match) {
      throw validationError(`SQL references a denied system catalog: ${match[0]}.`, {
        reason: 'system_catalog_access',
        catalog: match[0],
        recovery: {
          hint: 'Query only df_<id> tables. Use treasury_dataframe_describe to list available dataframes.',
        },
      });
    }
  }
}
