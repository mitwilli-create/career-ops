/**
 * scripts/agents/regression-guard/detectors/type-03-data.mjs
 *
 * Type 3: Data integrity (counts + key shape).
 *
 * Detects:
 *   - applications.md row-count regression (HIGH if dropped > 3)
 *   - network-database.json connection shrinkage (MED if dropped > 5%)
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';
import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

export function detectType3Data(state) {
  const findings = [];
  const baseline = loadBaseline('data-integrity');
  if (baseline && !baselineExpired(baseline)) {
    const prev = baseline.data || {};
    // applications.md row count
    const applPath = join(REPO_ROOT, 'data/applications.md');
    if (existsSync(applPath)) {
      const lines = readFileSync(applPath, 'utf-8').split('\n');
      const rowCount = lines.filter(l => /^\|\s*\d+\s*\|/.test(l)).length;
      if (typeof prev.applications_rows === 'number') {
        const drift = rowCount - prev.applications_rows;
        if (drift < -3) {
          findings.push({
            type: 3, severity: 'HIGH', confidence: 'HIGH',
            subtype: 'applications-row-loss',
            file: 'data/applications.md',
            summary: `applications.md row count dropped by ${-drift} (${prev.applications_rows} → ${rowCount})`,
            citation: { path: applPath, mode: 'hash_only', hash: hashCite(`rows=${rowCount}`) },
          });
        }
      }
    }
    // network-database.json connection count
    const ndbPath = join(REPO_ROOT, 'data/network-database.json');
    if (existsSync(ndbPath) && typeof prev.network_connections === 'number') {
      try {
        const ndb = JSON.parse(readFileSync(ndbPath, 'utf-8'));
        const conns = Array.isArray(ndb?.connections) ? ndb.connections.length :
          (typeof ndb?.metadata?.total_connections === 'number' ? ndb.metadata.total_connections : 0);
        const driftPct = prev.network_connections > 0 ? ((conns - prev.network_connections) / prev.network_connections) * 100 : 0;
        if (driftPct < -5) {
          findings.push({
            type: 3, severity: 'MED', confidence: 'HIGH',
            subtype: 'network-db-shrinkage',
            file: 'data/network-database.json',
            summary: `network-database.json connections dropped ${driftPct.toFixed(1)}% (${prev.network_connections} → ${conns})`,
            citation: { path: ndbPath, mode: 'hash_only', hash: hashCite(`conns=${conns}`) },
          });
        }
      } catch { /* malformed JSON is itself a finding, but handled by Type 1 */ }
    }
  }
  return findings;
}
