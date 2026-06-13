/**
 * @fileoverview Unit tests for assertNoSystemCatalogAccess in sql-gate-extras.
 * @module services/canvas-bridge/sql-gate-extras.test
 */

import { describe, expect, it } from 'vitest';
import { assertNoSystemCatalogAccess } from './sql-gate-extras.js';

/**
 * This gate now covers only the residual DuckDB metadata functions the
 * framework's `denySystemCatalogs` + unconditional `pragma_*`/table-function
 * deny-list does not reach. System catalogs (information_schema, pg_catalog,
 * sqlite_master, duckdb_*) and pragma functions are the framework gate's
 * responsibility and are exercised in its own suite.
 */
describe('assertNoSystemCatalogAccess', () => {
  it.each([
    ['which_secret', "SELECT * FROM which_secret('s3://bucket/', 'S3')"],
    ['which_secret bare', 'SELECT * FROM which_secret()'],
    // Confirm string-literal stripping does not hide a function reference after a literal
    ['which_secret after literal', "SELECT 'x', * FROM which_secret()"],
  ])('blocks %s', (_label, sql) => {
    expect(() => assertNoSystemCatalogAccess(sql)).toThrow();
  });

  it.each([
    ['normal df_ table', 'SELECT * FROM df_ABCDE_FGHIJ'],
    ['df_ with join', 'SELECT a.x, b.y FROM df_AAA_BBB a JOIN df_CCC_DDD b ON a.id = b.id'],
    ['df_ with aggregate', 'SELECT COUNT(*), SUM(CAST(x AS DECIMAL)) FROM df_TEST_01'],
    ['df_ with CTE', 'WITH t AS (SELECT x FROM df_ABCDE) SELECT * FROM t'],
    // Framework gate (not this module) handles catalogs — this module lets them pass
    ['information_schema (framework gate handles)', 'SELECT * FROM information_schema.tables'],
    // Function name inside a string literal — data, not a call — must NOT be blocked
    ['which_secret in string literal', "SELECT 'which_secret' AS name FROM df_TEST"],
  ])('allows %s', (_label, sql) => {
    expect(() => assertNoSystemCatalogAccess(sql)).not.toThrow();
  });
});
