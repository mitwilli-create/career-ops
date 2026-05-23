/**
 * scripts/agents/regression-guard/detectors/type-04-pipeline.mjs
 *
 * Type 4: Pipeline regression (structural-shape diff on state files).
 *
 * Detects missing top-level keys in data/pipeline-process-state.json
 * compared against the most recent baseline.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';
import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

export function detectType4Pipeline(state) {
  const findings = [];
  const baseline = loadBaseline('pipeline-state');
  if (baseline && !baselineExpired(baseline)) {
    const psPath = join(REPO_ROOT, 'data/pipeline-process-state.json');
    if (existsSync(psPath)) {
      try {
        const ps = JSON.parse(readFileSync(psPath, 'utf-8'));
        const prevKeys = new Set(baseline.data?.topLevelKeys || []);
        const currKeys = new Set(Object.keys(ps || {}));
        const missing = [...prevKeys].filter(k => !currKeys.has(k));
        if (missing.length > 0) {
          findings.push({
            type: 4, severity: 'MED', confidence: 'HIGH',
            subtype: 'pipeline-state-key-removed',
            file: 'data/pipeline-process-state.json',
            summary: `pipeline-process-state.json missing prev keys: ${missing.join(', ')}`,
            citation: { path: psPath, mode: 'hash_only', hash: hashCite(missing.join(',')) },
          });
        }
      } catch { /* malformed state file */ }
    }
  }
  return findings;
}
