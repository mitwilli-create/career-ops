/**
 * scripts/agents/regression-guard/detectors/type-08-performance.mjs
 *
 * Type 8: Performance regression (log-stat diff).
 *
 * Day-1 stub: future detector will diff p50/p95 latencies from
 * ~/Library/Logs/career-ops/*.log heartbeat / scan / batch timings.
 * Currently baseline-build only (no findings fired).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

export function detectType8Performance(state) {
  const findings = [];
  // Day-1 stub: scan ~/Library/Logs/career-ops/*.log for "timeout" / "took Xms" patterns
  // The substantive day-1 detector is wall-clock diffs on heartbeat / scan / batch logs.
  const baseline = loadBaseline('performance');
  if (baseline && !baselineExpired(baseline)) {
    // Future: diff p50/p95 latencies. Day-1 baseline-build only.
  }
  return findings;
}
