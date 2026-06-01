/**
 * @fileoverview Unit tests for assertNoSystemCatalogAccess in sql-gate-extras.
 * @module services/canvas-bridge/sql-gate-extras.test
 */

import { describe, expect, it } from 'vitest';
import { assertNoSystemCatalogAccess } from './sql-gate-extras.js';

describe('assertNoSystemCatalogAccess', () => {
  it.each([
    ['information_schema', 'SELECT * FROM information_schema.tables'],
    ['information_schema qualified', 'SELECT * FROM system.information_schema.tables'],
    ['pg_catalog', 'SELECT * FROM pg_catalog.pg_tables'],
    ['sqlite_master', 'SELECT * FROM sqlite_master'],
    ['sqlite_master qualified', "SELECT name FROM main.sqlite_master WHERE type='table'"],
    ['duckdb_ prefix', 'SELECT * FROM duckdb_tables()'],
    ['duckdb_settings', 'SELECT * FROM duckdb_settings()'],
    ['duckdb_functions', 'SELECT * FROM duckdb_functions()'],
    ['pragma_database_size', 'SELECT * FROM pragma_database_size()'],
    ['which_secret', "SELECT * FROM which_secret('s3://bucket/', 'S3')"],
    // Confirm string-literal stripping does not hide the catalog name
    ['catalog name after literal', "SELECT 'x', * FROM information_schema.tables"],
  ])('blocks %s', (_label, sql) => {
    expect(() => assertNoSystemCatalogAccess(sql)).toThrow();
  });

  it.each([
    ['normal df_ table', 'SELECT * FROM df_ABCDE_FGHIJ'],
    ['df_ with join', 'SELECT a.x, b.y FROM df_AAA_BBB a JOIN df_CCC_DDD b ON a.id = b.id'],
    ['df_ with aggregate', 'SELECT COUNT(*), SUM(CAST(x AS DECIMAL)) FROM df_TEST_01'],
    ['df_ with CTE', 'WITH t AS (SELECT x FROM df_ABCDE) SELECT * FROM t'],
    // Catalog name inside a string literal — should NOT be blocked (it's data, not a table ref)
    ['catalog name in string literal', "SELECT 'information_schema' AS name FROM df_TEST"],
  ])('allows %s', (_label, sql) => {
    expect(() => assertNoSystemCatalogAccess(sql)).not.toThrow();
  });
});
