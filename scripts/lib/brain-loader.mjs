/**
 * scripts/lib/brain-loader.mjs
 *
 * Parses `~/.claude/knowledge/brain/*.md` brain docs (EF rules, tone-safety,
 * bug-class-catalog, etc.) and extracts machine-readable rules for memory
 * regression detection.
 *
 * Designed as a SHARED library so future agents (omega-steward,
 * system-maintainer, etc.) can also read brain-doc rules through the
 * same contract.
 *
 * STATUS: scaffolded 2026-05-23 as part of the Q5 lib-split. Brain docs
 * use prose-with-imperative-bullets format; the structured rule-extraction
 * is v1.2 work. For now this module exports a no-op `loadAllBrainRules()`
 * that returns []. Type 7 (memory) detection in v1.0/v1.1 fires
 * env-shadow-on-lazy-dotenv directly via lexical scan; the structured
 * rule-loader approach via this module replaces that in v1.2.
 *
 * See dealbreaker-final § Audit Item 7 — brain-loader scaffolding.
 */

/**
 * Load all rules from the brain dir.
 * @returns {Array<{rule_id, rule_text, source_path, category}>}
 */
export function loadAllBrainRules() {
  // TODO v1.2: parse `~/.claude/knowledge/brain/*.md` for structured
  // imperative blocks (EF rules, bug-class entries, etc.). Day-1 returns
  // empty — Type 7 detection uses the direct lexical-scan approach in
  // scripts/agents/regression-guard/detectors/type-07-memory.mjs.
  return [];
}

/**
 * Load brain rules under a specific category (e.g., 'bug-class', 'ef-rules').
 * @returns {Array<{rule_id, rule_text, source_path}>}
 */
export function loadBrainRulesByCategory(category) {
  // TODO v1.2: filter loadAllBrainRules() by category.
  void category;
  return [];
}
