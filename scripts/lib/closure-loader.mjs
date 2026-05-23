/**
 * scripts/lib/closure-loader.mjs
 *
 * Parses .claude/audit/<dir>/notes-<NN>.md closure documents and extracts
 * machine-readable invariants for regression detection.
 *
 * Designed as a SHARED library so future agents (omega-steward,
 * system-maintainer, etc.) can also read closure invariants through the
 * same contract.
 *
 * STATUS: scaffolded 2026-05-23 as part of the Q5 lib-split. The closure
 * documents currently use human-prose invariants (no machine-readable
 * structured markers yet). The actual parser is v1.2 work — for now this
 * module exports a no-op `loadAllClosureInvariants()` that returns [].
 * Type 6 (closure) detection in v1.0/v1.1 fires Pattern B directly via
 * filesystem scan (Finder " 2.<ext>" signature); the structured-closure
 * approach via this module replaces that with proper invariant tracking
 * in v1.2.
 *
 * See dealbreaker-final § Audit Item 6 — closure-loader scaffolding.
 */

/**
 * Load all closure invariants from the audit dir.
 * @returns {Array<{closure_id, invariant, source_path}>}
 */
export function loadAllClosureInvariants() {
  // TODO v1.2: parse .claude/audit/closure-<id>/notes-<NN>.md for structured
  // invariant blocks. Day-1 returns empty — Type 6 detection uses the
  // direct filesystem-scan approach in
  // scripts/agents/regression-guard/detectors/type-06-closure.mjs.
  return [];
}

/**
 * Load invariants for a specific closure id (e.g., 'closure-08').
 * @returns {Array<{invariant, source_path}>}
 */
export function loadClosureInvariants(closureId) {
  // TODO v1.2: parse the named closure dir + extract invariants.
  void closureId;
  return [];
}
