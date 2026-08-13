/**
 * @fileoverview Tests for the catalog verifier's diff and reporting logic.
 * The probe that reads live field metadata is the verifier's only network
 * dependency; everything asserted here is fed a probe result directly.
 * @module tests/scripts/verify-catalog.test
 */

import { describe, expect, it } from 'vitest';
import {
  auditEntry,
  type CatalogFinding,
  isBlocking,
  type ProbeResult,
  renderReport,
} from '../../scripts/verify-catalog.js';
import type { DatasetEntry } from '../../src/services/fiscal-data/types.js';

function entry(endpoint: string, fieldNames: string[], name = 'Sample Dataset'): DatasetEntry {
  return {
    endpoint,
    name,
    description: 'Sample.',
    category: 'other',
    update_cadence: 'Monthly',
    fields: fieldNames.map((n) => ({ name: n, label: n, type: 'STRING' })),
  };
}

const live = (fields: string[]): ProbeResult => ({ ok: true, fields });

describe('auditEntry', () => {
  it('reports nothing when every listed field exists and nothing upstream is missed', () => {
    const finding = auditEntry(
      entry('/v2/accounting/od/debt_to_penny', ['record_date', 'tot_pub_debt_out_amt']),
      live(['record_date', 'tot_pub_debt_out_amt']),
    );

    expect(finding.absent).toEqual([]);
    expect(finding.unlisted).toEqual([]);
    expect(finding.unreachable).toBeUndefined();
    expect(isBlocking(finding)).toBe(false);
  });

  it('names every listed field the endpoint does not have', () => {
    const finding = auditEntry(
      entry('/v1/accounting/mts/mts_table_1', [
        'record_date',
        'item_desc',
        'current_fytd_gross_outly_amt',
      ]),
      live(['record_date', 'classification_desc']),
    );

    expect(finding.absent).toEqual(['item_desc', 'current_fytd_gross_outly_amt']);
    expect(isBlocking(finding)).toBe(true);
  });

  it('names the fields upstream carries that the catalog omits', () => {
    const finding = auditEntry(
      entry('/v1/accounting/od/rates_of_exchange', ['record_date', 'exchange_rate']),
      live(['record_date', 'exchange_rate', 'effective_date', 'record_fiscal_year']),
    );

    expect(finding.unlisted).toEqual(['effective_date', 'record_fiscal_year']);
  });

  it('does not block on under-listing alone — fields= is optional, so it costs discoverability', () => {
    const finding = auditEntry(
      entry('/v1/accounting/od/rates_of_exchange', ['record_date']),
      live(['record_date', 'effective_date']),
    );

    expect(finding.unlisted).toEqual(['effective_date']);
    expect(isBlocking(finding)).toBe(false);
  });

  it('blocks on an endpoint that could not be read, and skips the field diff', () => {
    const finding = auditEntry(entry('/v1/debt/top/top_state', ['record_date', 'state_nm']), {
      ok: false,
      error: 'HTTP 404',
    });

    expect(finding.unreachable).toBe('HTTP 404');
    expect(finding.absent).toEqual([]);
    expect(finding.unlisted).toEqual([]);
    expect(isBlocking(finding)).toBe(true);
  });

  it('reports both halves of the drift on one entry at once', () => {
    const finding = auditEntry(
      entry('/v1/accounting/dts/operating_cash_balance', [
        'record_date',
        'open_mon_bal',
        'close_today_bal',
      ]),
      live(['record_date', 'open_month_bal', 'close_today_bal', 'open_fiscal_year_bal']),
    );

    expect(finding.absent).toEqual(['open_mon_bal']);
    expect(finding.unlisted).toEqual(['open_month_bal', 'open_fiscal_year_bal']);
  });

  it('carries the entry name through, so the report names the dataset a caller would have picked', () => {
    const finding = auditEntry(
      entry('/v1/debt/top/top_state', ['record_date'], 'Treasury Offset Program'),
      { ok: false, error: 'HTTP 404' },
    );

    expect(finding.name).toBe('Treasury Offset Program');
    expect(finding.endpoint).toBe('/v1/debt/top/top_state');
  });
});

describe('renderReport', () => {
  const findings: CatalogFinding[] = [
    { endpoint: '/v2/accounting/od/debt_to_penny', name: 'Debt', absent: [], unlisted: [] },
    {
      endpoint: '/v1/debt/top/top_state',
      name: 'Offsets',
      unreachable: 'HTTP 404',
      absent: [],
      unlisted: [],
    },
    {
      endpoint: '/v1/accounting/dts/operating_cash_balance',
      name: 'Cash',
      absent: ['open_mon_bal'],
      unlisted: ['open_month_bal'],
    },
  ];

  it('names each broken endpoint, its dataset, and the failing detail', () => {
    const report = renderReport(findings);

    expect(report).toContain('/v1/debt/top/top_state');
    expect(report).toContain('HTTP 404');
    expect(report).toContain('/v1/accounting/dts/operating_cash_balance');
    expect(report).toContain('open_mon_bal');
    expect(report).toContain('open_month_bal');
  });

  it('counts what passed against what was checked', () => {
    expect(renderReport(findings)).toContain('1/3');
  });

  it('says so plainly when every entry resolves', () => {
    const clean = renderReport([findings[0] as CatalogFinding]);

    expect(clean).toContain('1/1');
    expect(clean).not.toContain('open_mon_bal');
  });

  it('renders an empty catalog without inventing a finding', () => {
    expect(renderReport([])).toContain('0/0');
  });
});
