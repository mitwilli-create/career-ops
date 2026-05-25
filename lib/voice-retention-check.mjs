// Voice retention sub-check for the pre-apply-check orchestrator.
//
// Wraps two existing primitives:
//   - lib/voice-rules-gate.mjs   → 12 programmatic voice rules (free, fast)
//   - lib/ai-detection-gate.mjs  → Pangram v3 + GPTZero + Originality (deep, paid)
//
// Default mode: rule-gate only (free, sub-second). The dealbreaker default
// since AI-detection calls cost $0.04-0.16/each and most pre-apply-checks
// don't need that signal — voice rules catch the most common AI-tells already.
//
// Deep mode (opts.deep === true): adds Pangram v3 with thresholds from
// dealbreaker-final § Impasse #3 corroborated finding 32:
//   - fraction_ai > 0.7         → fail
//   - fraction_ai_assisted > 0.4 → caveats
// Other detector results (gptzero, originality) are surfaced but don't
// drive status — Pangram is the canonical signal per the 2026-05-19 + 2026-05-24
// AI-detection-hardener consensus.
//
// Score is clamped consistent with status: status='fail' → score ≤ 0.3,
// 'caveats' → score ≤ 0.7. Without this clamping, a rule-pass + Pangram-fail
// could surface as score:0.95 + status:'fail', misleading the readiness UI.

import { runVoiceRulesGate as _runVoiceRulesGate } from './voice-rules-gate.mjs';
import { checkText as _checkText } from './ai-detection-gate.mjs';

const PANGRAM_FAIL_THRESHOLD = 0.7;
const PANGRAM_CAVEATS_THRESHOLD = 0.4;
const MIN_TEXT_LENGTH = 200;
const PROSE_ARTIFACT_KEYS = ['cover_letter', 'cv'];
const STATUS_PRIORITY = { pass: 0, caveats: 1, fail: 2 };

/**
 * @param {object} input
 * @param {string} [input.slug]
 * @param {string} [input.jdText]
 * @param {Record<string, string>} input.artifacts - {cv?, cover_letter?, ...}
 * @param {object} [input.opts]
 * @param {boolean} [input.opts.deep=false] - enable Pangram AI-detection layer
 * @param {number} [input.opts.budgetUsd=0.05] - per-call budget for AI-detection
 * @param {function} [input.opts.runVoiceRulesGate] - inject for tests
 * @param {function} [input.opts.checkText] - inject for tests
 * @returns {Promise<{status, score, rule_failures, fraction_*, signal_quality, deep_used, artifacts_checked, error?}>}
 */
export async function voiceRetentionCheck({ slug, jdText, artifacts, opts = {} } = {}) {
  if (!artifacts || typeof artifacts !== 'object') {
    return { status: 'unavailable', error: 'no artifacts provided' };
  }

  const candidates = PROSE_ARTIFACT_KEYS.filter(k => {
    const v = artifacts[k];
    return typeof v === 'string' && v.length >= MIN_TEXT_LENGTH;
  });

  if (candidates.length === 0) {
    return {
      status: 'unavailable',
      error: `no prose artifacts (${PROSE_ARTIFACT_KEYS.join(' | ')}) of length >= ${MIN_TEXT_LENGTH}`,
    };
  }

  const runGate = opts.runVoiceRulesGate || _runVoiceRulesGate;
  const checkFn = opts.checkText || _checkText;

  const perArtifact = [];
  for (const key of candidates) {
    const text = artifacts[key];
    const ruleResult = runGate(text);
    let detection = null;
    let pangramStatus = null;
    if (opts.deep === true) {
      try {
        detection = await checkFn(text, { budgetUsd: opts.budgetUsd ?? 0.05 });
        if (typeof detection?.fraction_ai === 'number' && detection.fraction_ai > PANGRAM_FAIL_THRESHOLD) {
          pangramStatus = 'fail';
        } else if (typeof detection?.fraction_ai_assisted === 'number' && detection.fraction_ai_assisted > PANGRAM_CAVEATS_THRESHOLD) {
          pangramStatus = 'caveats';
        } else if (detection) {
          pangramStatus = 'pass';
        }
      } catch (err) {
        detection = { error: String(err?.message || err) };
        // Detection error → don't override rule-gate verdict; surface in pangram_error.
      }
    }
    perArtifact.push({ artifact: key, ruleResult, detection, pangramStatus });
  }

  // Roll up — worst-of-all artifacts.
  let worstStatus = 'pass';
  let worstScore = 1.0;
  const aggregatedFailures = [];
  let signalQuality = 'GOOD';
  let combinedDetection = null;

  for (const a of perArtifact) {
    const ruleVerdict = a.ruleResult.rollup.verdict; // PASS | WARN | FAIL
    const ruleStatus = ruleVerdict === 'PASS' ? 'pass' : (ruleVerdict === 'WARN' ? 'caveats' : 'fail');
    const artifactStatus = (a.pangramStatus && STATUS_PRIORITY[a.pangramStatus] > STATUS_PRIORITY[ruleStatus])
      ? a.pangramStatus
      : ruleStatus;

    if (STATUS_PRIORITY[artifactStatus] > STATUS_PRIORITY[worstStatus]) {
      worstStatus = artifactStatus;
    }
    if (a.ruleResult.rollup.score < worstScore) worstScore = a.ruleResult.rollup.score;
    if (a.ruleResult.rollup.signal_quality === 'WEAK') signalQuality = 'WEAK';

    // Pangram failures go FIRST (most actionable).
    if (a.pangramStatus === 'fail') {
      aggregatedFailures.unshift({
        rule: `AI-detection: Pangram fraction_ai > ${PANGRAM_FAIL_THRESHOLD} on ${a.artifact} — humanize the text`,
        severity: 'critical',
        artifact: a.artifact,
      });
    } else if (a.pangramStatus === 'caveats') {
      aggregatedFailures.push({
        rule: `AI-detection: Pangram fraction_ai_assisted > ${PANGRAM_CAVEATS_THRESHOLD} on ${a.artifact} — review for AI-tells`,
        severity: 'soft',
        artifact: a.artifact,
      });
    }

    for (const f of a.ruleResult.rollup.critical_failures) {
      aggregatedFailures.push({ rule: f, severity: 'critical', artifact: a.artifact });
    }
    for (const f of a.ruleResult.rollup.soft_violations.slice(0, 3)) {
      aggregatedFailures.push({ rule: f, severity: 'soft', artifact: a.artifact });
    }

    // Combined detection — surface the worst fraction_ai across artifacts.
    if (a.detection && typeof a.detection.fraction_ai === 'number') {
      if (!combinedDetection || (combinedDetection.fraction_ai ?? -1) < a.detection.fraction_ai) {
        combinedDetection = a.detection;
      }
    }
  }

  // Text too short for reliable voice analysis — surface unavailable rather
  // than misleading pass. signal_quality:'WEAK' propagates from rule gate.
  if (signalQuality === 'WEAK') {
    return {
      status: 'unavailable',
      error: 'text too short for reliable voice analysis (signal_quality:WEAK)',
      signal_quality: 'WEAK',
      artifacts_checked: candidates,
    };
  }

  // Clamp score consistent with status so the readiness UI doesn't show
  // status:'fail' + score:0.95 (which happens when Pangram catches AI but
  // rule gate passes).
  let finalScore = worstScore;
  if (worstStatus === 'fail') finalScore = Math.min(finalScore, 0.3);
  else if (worstStatus === 'caveats') finalScore = Math.min(finalScore, 0.7);
  finalScore = Math.round(finalScore * 100) / 100;

  return {
    status: worstStatus,
    score: finalScore,
    rule_failures: aggregatedFailures.slice(0, 8),
    fraction_human: combinedDetection?.fraction_human ?? null,
    fraction_ai_assisted: combinedDetection?.fraction_ai_assisted ?? null,
    fraction_ai: combinedDetection?.fraction_ai ?? null,
    signal_quality: signalQuality,
    deep_used: opts.deep === true,
    artifacts_checked: candidates,
  };
}

export const _internal = Object.freeze({
  PANGRAM_FAIL_THRESHOLD,
  PANGRAM_CAVEATS_THRESHOLD,
  MIN_TEXT_LENGTH,
  PROSE_ARTIFACT_KEYS,
  STATUS_PRIORITY,
});
