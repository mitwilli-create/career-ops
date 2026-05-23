/**
 * scripts/agents/regression-guard/lib/silent-period.mjs
 *
 * Per-type silent-period parser + tracker (Vector 4 self-regression defense).
 *
 * Silent-period gates: if no finding of type T has fired for >= D days
 * AND nothing in the corresponding watch-window changed, the agent assumes
 * the detector is broken (silent failure) and emits a CRIT.
 *
 * Configured via REGRESSION_GUARD_SILENT_PERIOD_DAYS_BY_TYPE CSV:
 *   code:7,closure:7,memory:7,data:7,ui:7,pipeline:14,behavioral:14,performance:14
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

export const DEFAULT_SILENT_PERIODS_CSV =
  'code:7,closure:7,memory:7,data:7,ui:7,pipeline:14,behavioral:14,performance:14';

export function parseSilentPeriods(csv) {
  const m = {};
  for (const pair of String(csv).split(',')) {
    const [k, v] = pair.split(':');
    const n = Number(v);
    if (k && Number.isFinite(n)) m[k.trim()] = n;
  }
  return m;
}
