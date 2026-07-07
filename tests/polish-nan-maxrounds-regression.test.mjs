#!/usr/bin/env node
/**
 * tests/polish-nan-maxrounds-regression.test.mjs
 *
 * Regression test for the 2026-07-07 blind-review BUG 2 (row 2756 Relativity
 * Space): the apply-pack polish confidence scorer returned 0.000 across every
 * artifact despite healthy L2 voice-rules scores (~0.80), forcing a spurious
 * REJECTED verdict on genuinely-good drafts.
 *
 * Root cause — a NaN maxRounds silently defeating the round loop:
 *   scripts/agents/apply-pack-polish.mjs computed
 *     maxRounds = opts.maxRoundsPerArtifact ?? Number(process.env.POLISH_MAX_ROUNDS) ?? 6
 *   When POLISH_MAX_ROUNDS was unset, `Number(undefined)` is NaN and `??` does
 *   NOT catch NaN (only null/undefined) — so maxRounds became NaN. That NaN
 *   reached lib/polish-loop.mjs where `while (rounds < NaN)` is always false,
 *   so ZERO rounds ran, the council never scored the artifact, bestConfidence
 *   stayed at its init 0, and Math.min(0, l2Score) drove the summary to 0.000.
 *   The run log's `"max_rounds_per_artifact":null` (JSON serializes NaN → null)
 *   was the fingerprint.
 *
 * Coverage:
 *   T1. lib defense — polishArtifact with opts.maxRounds=NaN coerces to the
 *       default and RUNS rounds (total_rounds_across_outer > 0, confidence > 0,
 *       abandon_reason !== 'zero-rounds-ran').
 *   T2. lib telemetry — a genuinely zero-round run (opts.maxRounds=0) surfaces
 *       abandoned:true + abandon_reason:'zero-rounds-ran' instead of a silent
 *       confidence:0 that reads as a real REJECT.
 *   T3. orchestrator root cause — with POLISH_MAX_ROUNDS unset, runPolishPack
 *       passes a FINITE maxRounds (=== 6) + maxRoundsPerArtifact to the
 *       polish loop, never NaN.
 *
 * No live API calls — opts.callCouncil / opts.polishArtifact /
 * opts.harvestPolishSignals / opts.checkPackCoherence DI hooks deliver canned
 * responses.
 *
 * Usage: node tests/polish-nan-maxrounds-regression.test.mjs
 * Exits 0 on pass; 1 on any failure.
 */

import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polishArtifact } from '../lib/polish-loop.mjs';
import { runPolishPack } from '../scripts/agents/apply-pack-polish.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.error(`✗ ${name}`); if (detail !== undefined) console.error('  detail:', detail); fail++; }
}

// A converging fake council: healthy critic/author/adjudicator/adversarial
// responses so a real round produces a non-zero confidence.
function convergingCouncil({ models }) {
  const m = models[0] || '';
  let content = '{}';
  if (m.includes('haiku')) content = JSON.stringify({ score: 0.9, gaps: [], concrete_rewrites: [] });
  else if (m.includes('sonnet')) content = JSON.stringify({ merged_artifact_text: 'Polished body.', author_self_score: 0.9, accepted_rewrites: [], rejected_rewrites: [] });
  else if (m.includes('opus')) content = JSON.stringify({ final_artifact_text: 'Polished body.', weighted_confidence: 0.88, remaining_concerns: [] });
  else content = JSON.stringify({ passes: true, blocking_findings: [], voice_drift_score: 0.1, overclaim_count: 0 });
  return Promise.resolve({ results: [{ content }], report: { totalCost: 0.001 } });
}

const baseInput = {
  artifactKind: 'impact-doc',
  artifactText: 'Some source text.',
  signals: {}, cvText: '', articleDigest: '', voiceBrief: '',
};
const baseOpts = {
  targetConfidence: 0.85, outerRetries: 1, skipGates: true, skipRound5: true,
  earlyAbandonDisabled: true, callCouncil: convergingCouncil,
};

// ── T1 — NaN maxRounds no longer zeroes the loop ──────────────────────────
{
  const r = await polishArtifact({ ...baseInput, opts: { ...baseOpts, maxRounds: NaN } });
  check('T1a NaN maxRounds runs rounds (total_rounds > 0)', r.total_rounds_across_outer > 0, r.total_rounds_across_outer);
  check('T1b NaN maxRounds yields a real confidence (> 0)', r.confidence > 0, r.confidence);
  check('T1c NaN maxRounds is not flagged zero-rounds-ran', r.abandon_reason !== 'zero-rounds-ran', r.abandon_reason);
}

// ── T2 — a genuine zero-round run is surfaced, not silent ─────────────────
{
  const r = await polishArtifact({ ...baseInput, opts: { ...baseOpts, maxRounds: 0 } });
  check('T2a zero-round run reports total_rounds === 0', r.total_rounds_across_outer === 0, r.total_rounds_across_outer);
  check('T2b zero-round run sets abandoned:true', r.abandoned === true, r.abandoned);
  check('T2c zero-round run reason === zero-rounds-ran', r.abandon_reason === 'zero-rounds-ran', r.abandon_reason);
}

// ── T3 — orchestrator passes a FINITE maxRounds when env unset ────────────
{
  const prevEnv = process.env.POLISH_MAX_ROUNDS;
  delete process.env.POLISH_MAX_ROUNDS;

  const slug = `zzz-polish-nan-maxrounds-test-${Date.now()}`;
  const applyPackDir = join(REPO_ROOT, 'apply-pack', slug);
  const dataPackDir = join(REPO_ROOT, 'data', 'apply-packs', slug);
  mkdirSync(applyPackDir, { recursive: true });
  mkdirSync(dataPackDir, { recursive: true });
  writeFileSync(join(applyPackDir, 'tailored-cv.md'), '# CV\n- mock proof', 'utf-8');

  let captured = null;
  const spyPolishArtifact = async (arg) => {
    captured = arg.opts;
    return {
      artifact_kind: arg.artifactKind, final_artifact_text: arg.artifactText, confidence: 0.9,
      rounds_used: 1, total_rounds_across_outer: 1, converged: true, early_abandoned: false,
      abandoned: false, abandon_reason: null, confidence_history: [], adversarial_findings: [],
      cost_usd: 0, duration_ms: 1, combined_final_confidence: 0.9, combined_gate_status: 'PASS',
      combined_gate_reasons: [],
    };
  };

  try {
    await runPolishPack({
      artifacts: ['cv'],
      packInfoOverride: { slug, company: 'TestCorp', role: 'TestRole', rowId: 9999, url: 'https://example.com/job' },
      installSignalHandlers: false,
      harvestPolishSignals: async () => ({ meta: { cost_usd: 0, cache: 'miss' }, hiring_manager_priorities: [], dealbreaker_pruned: [] }),
      polishArtifact: spyPolishArtifact,
      checkPackCoherence: async () => ({ final_recommendation: 'APPROVED', blocking_issues: [], per_artifact_confidence: { 'cv-tailored': 0.9 }, cross_coherence: {}, diff_narrative: '', meta: { generated_at: new Date().toISOString() } }),
    });
    check('T3a orchestrator captured polish opts', captured !== null, captured);
    check('T3b maxRounds passed to loop is finite (not NaN)', captured && Number.isFinite(captured.maxRounds), captured?.maxRounds);
    check('T3c maxRounds default === 6 when env unset', captured && captured.maxRounds === 6, captured?.maxRounds);
    check('T3d maxRoundsPerArtifact passed to loop is finite', captured && Number.isFinite(captured.maxRoundsPerArtifact), captured?.maxRoundsPerArtifact);
  } finally {
    if (prevEnv !== undefined) process.env.POLISH_MAX_ROUNDS = prevEnv;
    try { rmSync(applyPackDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dataPackDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
