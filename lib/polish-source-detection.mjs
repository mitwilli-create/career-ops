/**
 * lib/polish-source-detection.mjs — Detect source state for polish-loop artifacts.
 *
 * Bug context (2026-05-25, Worker C of pre-apply-followup sprint):
 *   apply-pack-polish previously failed any pack where `tailored-cv.pdf`
 *   existed but `tailored-cv.md` did not, throwing
 *   `error: 'no-source-and-no-generator'` and aborting the cv-tailored
 *   phase. Other artifacts in the same pack could not polish even though
 *   their inputs were present.
 *
 *   This helper inspects the file state for one artifact and returns a
 *   verdict the caller can act on:
 *     - 'has-md'             → .md source present, proceed normally
 *     - 'pdf-only'           → .pdf without .md (cv-tailored: skip the
 *                              phase with a warning so other artifacts can
 *                              proceed)
 *     - 'has-generator'      → .md missing but a regenerator agent can
 *                              produce it (impact-doc/references/referrals)
 *     - 'missing-actionable' → nothing present, no generator; surface an
 *                              actionable suggestion to the operator
 *
 *   The caller (polish-loop) is responsible for the action; this helper is
 *   pure inspection so it can be tested in isolation.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

// Artifact kinds for which polish CAN regenerate from agents (other artifacts
// have no regenerator and would surface as 'missing-actionable').
const ARTIFACTS_WITH_GENERATOR = new Set(['impact-doc', 'references', 'referrals']);

// Companion file maps for each artifact — the .pdf or alternate file that
// indicates "this was generated previously but the .md source is gone."
// Only cv-tailored has this scenario in production; other artifacts are
// purely markdown.
const COMPANION_FILES = {
  'cv-tailored': ['tailored-cv.pdf'],
};

/**
 * Detect source state for one artifact in one pack.
 *
 * @param {object} opts
 * @param {string} opts.packSlug   The pack directory slug (e.g. "044-anthropic-...")
 * @param {string} opts.kind       Artifact kind (cv-tailored / cover-letter / etc.)
 * @param {string} opts.srcFile    Source filename (tailored-cv.md / cover-letter.md / etc.)
 * @param {string} [opts.root]     Override repo root (test injection)
 * @returns {{
 *   state: 'has-md' | 'pdf-only' | 'has-generator' | 'missing-actionable',
 *   actionable_suggestion?: string,
 *   files_present: { md: boolean, companion: string[] }
 * }}
 */
export function detectPolishSource(opts) {
  const root = opts?.root || DEFAULT_ROOT;
  const packSlug = opts?.packSlug;
  const kind = opts?.kind;
  const srcFile = opts?.srcFile;
  if (!packSlug || !kind || !srcFile) {
    return {
      state: 'missing-actionable',
      actionable_suggestion: 'detectPolishSource: packSlug, kind, srcFile all required',
      files_present: { md: false, companion: [] },
    };
  }
  const packDir = join(root, 'apply-pack', packSlug);
  const mdPath = join(packDir, srcFile);
  const mdPresent = existsSync(mdPath);

  // Detect companion files (cv-tailored only has .pdf as companion)
  const companions = COMPANION_FILES[kind] || [];
  const companionPresent = companions.filter(f => existsSync(join(packDir, f)));

  // STATE: .md exists → normal polish
  if (mdPresent) {
    return {
      state: 'has-md',
      files_present: { md: true, companion: companionPresent },
    };
  }

  // STATE: .md missing + .pdf present (cv-tailored specifically)
  if (!mdPresent && companionPresent.length > 0) {
    return {
      state: 'pdf-only',
      actionable_suggestion:
        `Found ${companionPresent.join(', ')} but no ${srcFile}. ` +
        `Run cv-tailor agent (POST /api/build-pack-stage with stage='cv-tailor') ` +
        `or scripts/cv-assemble-tailored.mjs to (re)generate the .md source, ` +
        `then re-run polish.`,
      files_present: { md: false, companion: companionPresent },
    };
  }

  // STATE: .md missing + regenerator agent available
  if (!mdPresent && ARTIFACTS_WITH_GENERATOR.has(kind)) {
    return {
      state: 'has-generator',
      files_present: { md: false, companion: companionPresent },
    };
  }

  // STATE: .md missing + no companion + no generator
  return {
    state: 'missing-actionable',
    actionable_suggestion:
      `No ${srcFile} found and no generator available for kind=${kind}. ` +
      `Run the upstream agent that produces this artifact (e.g., ` +
      `cv-tailor for cv-tailored, cover-letter for cover-letter), ` +
      `or regenerate the apply-pack via build-apply-packs.mjs.`,
    files_present: { md: false, companion: companionPresent },
  };
}

/**
 * Build a structured "phase skipped" record for polish-loop bookkeeping.
 * Mirrors the shape `perArtifact[conf.kind] = { ... }` uses elsewhere in
 * apply-pack-polish.mjs.
 *
 * @param {string} kind
 * @param {string} state
 * @param {string} [suggestion]
 * @returns {object}
 */
export function buildSkippedArtifactRecord(kind, state, suggestion) {
  return {
    confidence: 0,
    rounds_used: 0,
    total_rounds_across_outer: 0,
    adversarial_findings: [],
    cost_usd: 0,
    duration_ms: 0,
    converged: false,
    early_abandoned: false,
    abandoned: false,
    abandon_reason: null,
    confidence_history: [],
    error: null,
    skipped: true,
    skip_reason: state,
    actionable_suggestion: suggestion || null,
    trace_path: null,
  };
}

// Test-only export
export const _internal = { COMPANION_FILES, ARTIFACTS_WITH_GENERATOR };
