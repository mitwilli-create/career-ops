/**
 * scripts/agents/regression-guard/detectors/type-02-ui.mjs
 *
 * Type 2: UI structural drift.
 *
 * Detects dashboard/index.html size changes (>25% drift) + hard ceiling
 * violations (>15 MB triggers Pattern C inline-payload-bloat CRIT).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';
import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

export function detectType2Ui(state) {
  const findings = [];
  const idxPath = join(REPO_ROOT, 'dashboard/index.html');
  if (existsSync(idxPath)) {
    const stats = statSync(idxPath);
    const baseline = loadBaseline('ui-dashboard-bytes');
    if (baseline && !baselineExpired(baseline)) {
      const prevBytes = baseline.data?.bytes || 0;
      const driftPct = prevBytes > 0 ? ((stats.size - prevBytes) / prevBytes) * 100 : 0;
      if (Math.abs(driftPct) > 25) {
        findings.push({
          type: 2,
          severity: Math.abs(driftPct) > 50 ? 'HIGH' : 'MED',
          confidence: 'HIGH',
          subtype: 'dashboard-size-drift',
          file: 'dashboard/index.html',
          summary: `dashboard/index.html size changed ${driftPct.toFixed(1)}% (${prevBytes} → ${stats.size})`,
          citation: { path: idxPath, mode: 'hash_only', hash: hashCite(`size=${stats.size}`) },
        });
      }
    }
    // Hard ceiling from inline-payload-bloat bug class
    if (stats.size > 15 * 1024 * 1024) {
      findings.push({
        type: 2, severity: 'CRIT', confidence: 'HIGH',
        subtype: 'inline-payload-bloat',
        file: 'dashboard/index.html',
        summary: `dashboard/index.html exceeds 15MB hard ceiling (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
        citation: { path: idxPath, mode: 'hash_only', hash: hashCite(`size=${stats.size}`) },
      });
    }
  }
  return findings;
}
