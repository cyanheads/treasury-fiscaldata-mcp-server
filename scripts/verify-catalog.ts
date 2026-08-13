#!/usr/bin/env bun
/**
 * @fileoverview Catalog verifier — checks every entry in the embedded dataset
 * catalog against the live Treasury Fiscal Data API.
 *
 * `treasury_list_datasets` is the documented first step for every other tool,
 * and the recovery hints on `invalid_endpoint` and `invalid_field` both send a
 * caller back to it. So an entry that has drifted from upstream does not merely
 * fail — it fails and points at itself, and a caller following the hints loops.
 * Nothing else in the repo compares the static catalog to the live API, which
 * is why the drift accumulated silently in the first place.
 *
 * Two grades of finding:
 *   - **Blocking** — the endpoint does not answer, or the catalog publishes a
 *     field name the endpoint does not have. Either one is a query the caller
 *     cannot make; the API rejects a bad `fields=` name outright.
 *   - **Informational** — the endpoint carries fields the catalog omits.
 *     `fields=` is optional, so this costs discoverability rather than a call.
 *
 * Run deliberately: `bun run verify:catalog`. It is a network check, kept out
 * of the unit suite so tests stay offline and deterministic; the catalog's own
 * shape is pinned there instead (tests/tools/list-datasets.tool.test.ts).
 *
 * @module scripts/verify-catalog
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASETS } from '../src/services/fiscal-data/datasets.js';
import { BASE_URL } from '../src/services/fiscal-data/fiscal-data-service.js';
import type { DatasetEntry } from '../src/services/fiscal-data/types.js';

/** How many endpoints to probe at once — enough to be quick, gentle upstream. */
const CONCURRENCY = 4;

/** Field metadata read back from one endpoint, or why it could not be read. */
export type ProbeResult = { ok: true; fields: string[] } | { ok: false; error: string };

/** What the catalog and the live endpoint disagree about, for one entry. */
export interface CatalogFinding {
  /** Field names the catalog publishes that the endpoint does not have. */
  absent: string[];
  endpoint: string;
  name: string;
  /** Field names the endpoint has that the catalog does not publish. */
  unlisted: string[];
  /** Why the endpoint could not be read, when it could not be. */
  unreachable?: string;
}

/** Diff one catalog entry against the field names its endpoint reports. */
export function auditEntry(entry: DatasetEntry, probe: ProbeResult): CatalogFinding {
  const identity = { endpoint: entry.endpoint, name: entry.name };
  if (!probe.ok) return { ...identity, unreachable: probe.error, absent: [], unlisted: [] };

  const live = new Set(probe.fields);
  const listedNames = entry.fields.map((f) => f.name);
  const listed = new Set(listedNames);
  return {
    ...identity,
    absent: listedNames.filter((name) => !live.has(name)),
    unlisted: probe.fields.filter((name) => !listed.has(name)),
  };
}

/** A finding blocks when it names something a caller would be sent to and fail on. */
export function isBlocking(finding: CatalogFinding): boolean {
  return finding.unreachable !== undefined || finding.absent.length > 0;
}

/** Human-readable report — blocking findings first, then the omissions. */
export function renderReport(findings: CatalogFinding[]): string {
  const blocking = findings.filter(isBlocking);
  const lines = [
    `Catalog entries resolving cleanly: ${findings.length - blocking.length}/${findings.length}`,
  ];

  for (const finding of blocking) {
    lines.push('', `✗ ${finding.endpoint} — ${finding.name}`);
    if (finding.unreachable) lines.push(`    endpoint unreachable: ${finding.unreachable}`);
    if (finding.absent.length > 0) {
      lines.push(`    listed but absent upstream: ${finding.absent.join(', ')}`);
    }
    if (finding.unlisted.length > 0) {
      lines.push(`    present upstream, not listed: ${finding.unlisted.join(', ')}`);
    }
  }

  const omissions = findings.filter((f) => !isBlocking(f) && f.unlisted.length > 0);
  if (omissions.length > 0) {
    lines.push('', 'Fields present upstream that the catalog omits (discoverability only):');
    for (const finding of omissions) {
      lines.push(`  ${finding.endpoint}: ${finding.unlisted.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/** Read one endpoint's field names out of the response envelope's `meta.labels`. */
async function probeEndpoint(endpoint: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}?page[size]=1`, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, error: `request failed: ${(error as Error).message}` };
  }

  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

  const body = (await response.json()) as { meta?: { labels?: Record<string, string> } };
  const labels = body.meta?.labels;
  if (!labels) return { ok: false, error: 'response carried no meta.labels' };

  return { ok: true, fields: Object.keys(labels) };
}

async function main(): Promise<void> {
  const findings: CatalogFinding[] = [];

  for (let i = 0; i < DATASETS.length; i += CONCURRENCY) {
    const batch = DATASETS.slice(i, i + CONCURRENCY);
    findings.push(
      ...(await Promise.all(
        batch.map(async (entry) => auditEntry(entry, await probeEndpoint(entry.endpoint))),
      )),
    );
  }

  console.log(renderReport(findings));

  if (findings.some(isBlocking)) {
    console.error('\nCatalog verification failed — correct the entries above in datasets.ts.');
    process.exit(1);
  }
  console.log('\nCatalog verification OK.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
