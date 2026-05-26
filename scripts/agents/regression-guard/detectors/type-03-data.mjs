/**
 * scripts/agents/regression-guard/detectors/type-03-data.mjs
 *
 * Type 3: Data integrity (counts + key shape).
 *
 * Detects:
 *   - applications.md row-count regression (HIGH if dropped > 3)
 *   - network-database.json connection shrinkage (MED if dropped > 5%)
 *   - cost-trace-implausible-entry: any single polish-cost-trace entry > $50
 *     (HIGH) — catches the per-1k-vs-per-1M math bug (bug-2026-05-25-227)
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * cost-trace detector added 2026-05-26 (bug-2026-05-25-227).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';
import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

const COST_TRACE_IMPLAUSIBLE_THRESHOLD_USD = 50;

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

  // cost-trace implausibility check — runs WITHOUT baseline (structural guard).
  // Flags any single polish-cost-trace entry with cost_usd > $50, which indicates
  // the per-1k-vs-per-1M math bug (bug-2026-05-25-227: $44/1k instead of $15-75/1M).
  // This is always live, not gated on baseline expiry.
  const dataDir = join(REPO_ROOT, 'data');
  if (existsSync(dataDir)) {
    try {
      const traceFiles = readdirSync(dataDir)
        .filter(f => /^polish-cost-trace-\d{4}-\d{2}-\d{2}\.json$/.test(f));
      for (const fname of traceFiles) {
        const fpath = join(dataDir, fname);
        let raw;
        try { raw = readFileSync(fpath, 'utf-8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec;
          try { rec = JSON.parse(trimmed); } catch { continue; }
          const cost = Number(rec?.cost_usd);
          if (!Number.isFinite(cost) || cost <= COST_TRACE_IMPLAUSIBLE_THRESHOLD_USD) continue;
          const model = rec?.model || 'unknown';
          const tokens = rec?.total_tokens ?? 'unknown';
          findings.push({
            type: 3, severity: 'HIGH', confidence: 'HIGH',
            subtype: 'cost-trace-implausible-entry',
            file: `data/${fname}`,
            summary: `cost-trace entry ${fname} has cost_usd=$${cost} (model=${model}, tokens=${tokens}) — likely per-1k-vs-per-1M math bug`,
            citation: { path: fpath, mode: 'hash_only', hash: hashCite(`${fname}:${rec?.timestamp_iso}:${cost}`) },
            remediation: 'Replace cost-trace file with polish-cost-trace-corrected-*.json counterpart, or recompute cost_usd at per-1M pricing.',
          });
          break; // one finding per file is enough to surface the issue
        }
      }
    } catch { /* directory read failure — not a regression-guard concern */ }
  }

  return findings;
}
