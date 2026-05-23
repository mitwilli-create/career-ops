/**
 * scripts/agents/regression-guard/lib/tier-router.mjs
 *
 * Explicit T0/T1/T2/T3/T4/T5 tier dispatcher for the regression-guard agent.
 *
 * Tiers (from dealbreaker-final § Audit Item 2):
 *   T0 — Free, deterministic (file scans, git log, json shape diffs)
 *   T1 — Cheap heuristics (lexical regex, line-by-line checks)
 *   T2 — Sonnet 4.6 synthesis ($3/$15 per 1M tokens — narrative + adjudication)
 *   T3 — Sonnet 4.6 deep adversarial sweep (multi-turn, ~$1-3 per call)
 *   T4 — Gemini 3.1 Pro Preview ingest with Sonnet fallback (long-context)
 *   T5 — Opus 4.7 verdict (highest-quality adjudication, used sparingly)
 *
 * STATUS: scaffolded 2026-05-23 as part of the Q5 lib-split. The actual
 * runtime tier dispatch lives inline in the orchestrator (runScheduled,
 * runDeep, runDeepMultiSession) for v1.0/v1.1. This module exports the
 * tier enum + a `routeByCostBudget()` helper that future v1.2 work can use
 * to make tier decisions data-driven (look at budget remaining + finding
 * severity + signal-quality).
 *
 * See dealbreaker-final § Audit Item 2 — tier-router for the full design.
 */

export const TIERS = Object.freeze({
  T0: 'T0', // free, deterministic
  T1: 'T1', // cheap heuristics
  T2: 'T2', // Sonnet synthesis
  T3: 'T3', // Sonnet adversarial
  T4: 'T4', // Gemini ingest with Sonnet fallback
  T5: 'T5', // Opus verdict
});

/**
 * Route to the cheapest tier that can produce useful signal given the
 * current budget envelope. Day-1 returns T0/T1 only — T2-T5 are explicit
 * opt-ins via flags (--deep, --synthesize).
 *
 * @param {object} opts
 * @param {number} opts.budgetRemainingUsd
 * @param {string} opts.findingSeverity   'CRIT' | 'HIGH' | 'MED' | 'LOW'
 * @returns {string} a TIERS.* value
 */
export function routeByCostBudget({ budgetRemainingUsd = 0, findingSeverity = 'LOW' } = {}) {
  // Day-1 conservative default — all scheduled mode runs at T0/T1.
  // v1.2 will route higher tiers when budget allows + severity warrants.
  if (budgetRemainingUsd < 0.5) return TIERS.T0;
  if (findingSeverity === 'LOW' || findingSeverity === 'MED') return TIERS.T1;
  return TIERS.T1;
}
