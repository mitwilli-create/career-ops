// Pre-apply-check orchestrator — composes 3 sub-checks (HM-match, ATS, voice
// retention) into a typed result per the dealbreaker-final spec at
// .claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md.
//
// Promise.allSettled (NOT .all) — sub-checks have heterogeneous failure modes
// (voice can fail when Pangram is rate-limited; ATS can fail on missing
// artifacts; HM can fail on missing/malformed hm-intel). All must surface
// independently; one failure must NOT discard the others' results.
//
// Hard rule: HM-match is REQUIRED for overall_status:'ready'. If HM errors or
// is unavailable, max overall_status is 'incomplete' even when ATS + voice
// pass. A green "ready" badge on undifferentiated dimensions alone is
// structurally meaningless.
//
// Sub-checks are dynamically imported with safe fallbacks. Until Step 2/3
// land lib/hm-match-check.mjs, lib/ats-check.mjs, lib/voice-retention-check.mjs,
// the orchestrator returns {status:'unavailable'} for missing sub-checks.
// Tests inject mocks via opts.{hmFn, atsFn, voiceFn}.

const CHECK_WEIGHTS = Object.freeze({ hm: 0.50, ats: 0.30, voice: 0.20 });

const VALID_OVERALL_STATUSES = Object.freeze([
  'ready', 'caveats', 'incomplete', 'unavailable', 'fail',
]);

const VALID_CHECK_STATUSES = Object.freeze([
  'pass', 'caveats', 'fail', 'unavailable', 'error',
]);

/**
 * Compose the 3 sub-checks into a typed pre-apply-check result.
 *
 * @param {object} input
 * @param {string} input.slug - Apply-pack slug (e.g., "048-anthropic-aaa-industries").
 * @param {string} [input.jdText] - Full job description text.
 * @param {object} [input.artifacts] - Map of artifact name → text (e.g., {cv, cover_letter}).
 * @param {object} [input.opts]
 * @param {function} [input.opts.hmFn] - Override HM sub-check (for tests).
 * @param {function} [input.opts.atsFn] - Override ATS sub-check (for tests).
 * @param {function} [input.opts.voiceFn] - Override voice sub-check (for tests).
 * @param {boolean} [input.opts.deep=false] - Enable deep voice (AI-detection layer).
 * @param {object} [input.opts.hmIntel] - Pre-loaded HM intel JSON (else loaded from disk by hmFn).
 * @returns {Promise<{overall_status, readiness_score, checks, suggestions, slug, _computed_at}>}
 */
export async function composePreApplyCheck({ slug, jdText = '', artifacts = {}, opts = {} } = {}) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('composePreApplyCheck: slug (string) is required');
  }

  const hmFn = opts.hmFn || (await _safeImportHm());
  const atsFn = opts.atsFn || (await _safeImportAts());
  const voiceFn = opts.voiceFn || (await _safeImportVoice());

  const subInput = { slug, jdText, artifacts, opts };

  const settled = await Promise.allSettled([
    hmFn(subInput),
    atsFn(subInput),
    voiceFn(subInput),
  ]);

  const checks = {
    hm: _settledToCheck(settled[0]),
    ats: _settledToCheck(settled[1]),
    voice: _settledToCheck(settled[2]),
  };

  const overall_status = _computeOverallStatus(checks);
  const readiness_score = _computeReadinessScore(checks);
  const suggestions = _buildSuggestions(checks);

  return {
    overall_status,
    readiness_score,
    checks,
    suggestions,
    slug,
    _computed_at: new Date().toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _settledToCheck(settled) {
  if (settled.status === 'fulfilled') {
    const value = settled.value || {};
    const status = VALID_CHECK_STATUSES.includes(value.status) ? value.status : 'unavailable';
    return { ...value, status };
  }
  return {
    status: 'error',
    error: String(settled.reason?.message || settled.reason || 'unknown error'),
  };
}

function _computeOverallStatus(checks) {
  const statuses = [checks.hm.status, checks.ats.status, checks.voice.status];

  if (statuses.every(s => s === 'error' || s === 'fail')) return 'fail';
  if (statuses.every(s => s === 'unavailable')) return 'unavailable';

  // Hard rule per dealbreaker Impasse #3 + GPT-5's most load-bearing critique:
  // HM-match is REQUIRED for 'ready'.
  if (checks.hm.status === 'fail') return 'fail';
  if (checks.hm.status === 'error' || checks.hm.status === 'unavailable') return 'incomplete';
  if (checks.hm.status === 'caveats') return 'caveats';

  // HM passed. Now check ATS + voice.
  if (checks.ats.status === 'fail' || checks.voice.status === 'fail') return 'fail';
  if (checks.ats.status === 'caveats' || checks.voice.status === 'caveats') return 'caveats';
  if (
    checks.ats.status === 'unavailable' || checks.ats.status === 'error' ||
    checks.voice.status === 'unavailable' || checks.voice.status === 'error'
  ) return 'caveats';

  return 'ready';
}

// Weighted average against TOTAL weight (1.0). Unavailable/error checks
// contribute 0 — surfacing as a lower readiness_score that's consistent with
// overall_status (e.g., HM-unavailable + ATS+voice pass → ~0.5 score +
// 'incomplete' status, not a misleading ~1.0 score).
function _computeReadinessScore(checks) {
  let weightedSum = 0;
  for (const [dim, weight] of Object.entries(CHECK_WEIGHTS)) {
    const check = checks[dim];
    if (typeof check.score === 'number' && Number.isFinite(check.score)) {
      const clamped = Math.max(0, Math.min(1, check.score));
      weightedSum += clamped * weight;
    }
  }
  return Math.round(weightedSum * 100) / 100;
}

function _buildSuggestions(checks) {
  const suggestions = [];

  // HM
  if (checks.hm.status === 'fail' || checks.hm.status === 'caveats') {
    if (Array.isArray(checks.hm.gaps) && checks.hm.gaps.length) {
      for (const gap of checks.hm.gaps) {
        suggestions.push({ dimension: 'hm', action: String(gap), est_cost_usd: 0 });
      }
    } else {
      suggestions.push({
        dimension: 'hm',
        action: 'Strengthen artifact alignment to HM persona signals',
        est_cost_usd: 0,
      });
    }
  } else if (checks.hm.status === 'unavailable' || checks.hm.status === 'error') {
    suggestions.push({
      dimension: 'hm',
      action: 'Run hiring-manager-research to populate data/hm-intel/<slug>.json',
      est_cost_usd: 30,
    });
  }

  // ATS
  if (checks.ats.status === 'fail' || checks.ats.status === 'caveats') {
    if (Array.isArray(checks.ats.missing_keywords) && checks.ats.missing_keywords.length) {
      const top = checks.ats.missing_keywords.slice(0, 5).join(', ');
      suggestions.push({
        dimension: 'ats',
        action: `Add missing keywords to CV or cover letter: ${top}`,
        est_cost_usd: 0,
      });
    } else {
      suggestions.push({ dimension: 'ats', action: 'Improve keyword coverage', est_cost_usd: 0 });
    }
  }

  // Voice
  if (checks.voice.status === 'fail' || checks.voice.status === 'caveats') {
    if (Array.isArray(checks.voice.rule_failures) && checks.voice.rule_failures.length) {
      for (const failure of checks.voice.rule_failures.slice(0, 3)) {
        const label = (failure && (failure.name || failure.rule)) || String(failure);
        suggestions.push({ dimension: 'voice', action: `Voice rule: ${label}`, est_cost_usd: 0 });
      }
    } else {
      suggestions.push({ dimension: 'voice', action: 'Improve voice retention', est_cost_usd: 0 });
    }
  }

  return suggestions;
}

// ── Dynamic-import fallbacks ────────────────────────────────────────────────
// Until Step 2/3 land the real sub-check libs, return stubs emitting
// {status:'unavailable'}. Lets the orchestrator + tests merge + verify
// independently before sub-checks ship.

async function _safeImportHm() {
  try {
    const mod = await import('./hm-match-check.mjs');
    if (typeof mod.hmMatchCheck === 'function') return mod.hmMatchCheck;
  } catch (_) { /* not yet implemented */ }
  return async () => ({
    status: 'unavailable',
    error: 'lib/hm-match-check.mjs not yet implemented (Step 2)',
  });
}

async function _safeImportAts() {
  try {
    const mod = await import('./ats-check.mjs');
    if (typeof mod.atsCheck === 'function') return mod.atsCheck;
  } catch (_) { /* not yet implemented */ }
  return async () => ({
    status: 'unavailable',
    error: 'lib/ats-check.mjs not yet implemented (Step 2)',
  });
}

async function _safeImportVoice() {
  try {
    const mod = await import('./voice-retention-check.mjs');
    if (typeof mod.voiceRetentionCheck === 'function') return mod.voiceRetentionCheck;
  } catch (_) { /* not yet implemented */ }
  return async () => ({
    status: 'unavailable',
    error: 'lib/voice-retention-check.mjs not yet implemented (Step 3)',
  });
}

// Exposed for tests + documentation.
export const _internal = Object.freeze({
  CHECK_WEIGHTS,
  VALID_OVERALL_STATUSES,
  VALID_CHECK_STATUSES,
  _settledToCheck,
  _computeOverallStatus,
  _computeReadinessScore,
  _buildSuggestions,
});
