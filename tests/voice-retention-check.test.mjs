#!/usr/bin/env node
/**
 * tests/voice-retention-check.test.mjs
 *
 * Fixture tests for lib/voice-retention-check.mjs (Step 3 of pre-apply-check
 * deepening). Mocks both underlying primitives (runVoiceRulesGate + checkText)
 * via opts injection — no live API calls.
 *
 * Covers:
 *   T1 rule-gate PASS on both artifacts → status:'pass', score high
 *   T2 critical rule failure on cover_letter → status:'fail'
 *   T3 WARN verdict → status:'caveats'
 *   T4 empty artifacts → status:'unavailable'
 *   T5 short text (signal_quality WEAK) → status:'unavailable'
 *   T6 deep=false (default) → no Pangram call, fraction_* null
 *   T7 deep=true + Pangram detects AI (fraction_ai > 0.7) → status:'fail',
 *      score clamped ≤ 0.3
 *   T8 deep=true + Pangram caveats (fraction_ai_assisted > 0.4) → status:'caveats',
 *      score clamped ≤ 0.7
 *   T9 deep=true but checkText throws → rule-gate verdict still drives status
 *
 * Usage:  node tests/voice-retention-check.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import { voiceRetentionCheck, _internal } from '../lib/voice-retention-check.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail !== undefined) {
      try { console.error('  detail:', JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// ── Mock factories ──────────────────────────────────────────────────────────

function mockRuleGate({ verdict = 'PASS', score = null, critical = [], soft = [], signalQuality = 'GOOD' } = {}) {
  return () => ({
    text_length: 1500,
    rules: {},
    rollup: {
      verdict,
      score: score ?? (verdict === 'PASS' ? 0.92 : verdict === 'WARN' ? 0.7 : 0.4),
      critical_failures: critical,
      soft_violations: soft,
      signal_quality: signalQuality,
    },
    checked_at: new Date().toISOString(),
  });
}

function mockCheckText({ ai = 0.05, assisted = 0.10, human = 0.85 } = {}) {
  return async () => ({
    passes: ai <= 0.7,
    gptzero_prob: ai * 0.8,
    originality_prob: ai * 0.7,
    fraction_human: human,
    fraction_ai_assisted: assisted,
    fraction_ai: ai,
    verdict: ai > 0.7 ? 'FAIL' : (assisted > 0.4 ? 'WARN' : 'PASS'),
    cost_usd_estimate: 0.04,
    from_cache: false,
  });
}

const SAMPLE_LONG_TEXT = 'a'.repeat(800);
const SAMPLE_SHORT_TEXT = 'short';
const ARTIFACTS_OK = { cv: SAMPLE_LONG_TEXT, cover_letter: SAMPLE_LONG_TEXT };

// ── T1: rule-gate PASS on both artifacts → status:'pass' ──────────────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-001',
    artifacts: ARTIFACTS_OK,
    opts: { runVoiceRulesGate: mockRuleGate({ verdict: 'PASS', score: 0.92 }) },
  });
  check('T1 rule-PASS → status:pass', r.status === 'pass', r);
  check('T1 rule-PASS → score 0.92', r.score === 0.92, r);
  check('T1 rule-PASS → rule_failures empty', r.rule_failures.length === 0, r.rule_failures);
  check('T1 rule-PASS → deep_used:false', r.deep_used === false, r);
  check('T1 rule-PASS → both artifacts checked',
        r.artifacts_checked.includes('cv') && r.artifacts_checked.includes('cover_letter'),
        r.artifacts_checked);
}

// ── T2: critical rule failure on cover_letter → status:'fail' ────────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-002',
    artifacts: ARTIFACTS_OK,
    opts: {
      runVoiceRulesGate: mockRuleGate({
        verdict: 'FAIL',
        score: 0.45,
        critical: ['rule_10_banned_vocab'],
      }),
    },
  });
  check('T2 critical-rule → status:fail', r.status === 'fail', r);
  check('T2 critical-rule → score clamped ≤ 0.3', r.score <= 0.3, r);
  check('T2 critical-rule → rule_failures contains banned_vocab',
        r.rule_failures.some(f => /banned_vocab/.test(f.rule)),
        r.rule_failures);
}

// ── T3: WARN verdict → status:'caveats' ───────────────────────────────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-003',
    artifacts: ARTIFACTS_OK,
    opts: {
      runVoiceRulesGate: mockRuleGate({
        verdict: 'WARN',
        score: 0.68,
        soft: ['rule_11_hedge_words'],
      }),
    },
  });
  check('T3 WARN → status:caveats', r.status === 'caveats', r);
  check('T3 WARN → score clamped ≤ 0.7', r.score <= 0.7, r);
  check('T3 WARN → rule_failures lists soft violation',
        r.rule_failures.some(f => /hedge_words/.test(f.rule)),
        r.rule_failures);
}

// ── T4: empty artifacts → status:'unavailable' ────────────────────────────
{
  const r1 = await voiceRetentionCheck({ slug: 'test-voice-004a', artifacts: {} });
  check('T4 empty artifacts → status:unavailable', r1.status === 'unavailable', r1);

  const r2 = await voiceRetentionCheck({ slug: 'test-voice-004b', artifacts: null });
  check('T4 null artifacts → status:unavailable', r2.status === 'unavailable', r2);

  const r3 = await voiceRetentionCheck({
    slug: 'test-voice-004c',
    artifacts: { cv: 'short', cover_letter: SAMPLE_SHORT_TEXT },
  });
  check('T4 short artifacts → status:unavailable',
        r3.status === 'unavailable',
        r3);
}

// ── T5: signal_quality WEAK → status:'unavailable' ───────────────────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-005',
    artifacts: ARTIFACTS_OK,
    opts: {
      runVoiceRulesGate: mockRuleGate({ verdict: 'PASS', score: 0.95, signalQuality: 'WEAK' }),
    },
  });
  check('T5 signal_quality:WEAK → status:unavailable', r.status === 'unavailable', r);
  check('T5 signal_quality:WEAK echoed in result', r.signal_quality === 'WEAK', r);
}

// ── T6: deep=false (default) → no Pangram, fraction_* null ───────────────
{
  let checkTextCalled = false;
  const r = await voiceRetentionCheck({
    slug: 'test-voice-006',
    artifacts: ARTIFACTS_OK,
    opts: {
      runVoiceRulesGate: mockRuleGate({ verdict: 'PASS' }),
      checkText: async () => { checkTextCalled = true; return mockCheckText({ ai: 0.1 })(); },
    },
  });
  check('T6 deep=false → checkText NOT called', checkTextCalled === false, { checkTextCalled });
  check('T6 deep=false → deep_used:false', r.deep_used === false, r);
  check('T6 deep=false → fraction_ai null', r.fraction_ai === null, r);
}

// ── T7: deep=true + Pangram detects AI (fraction_ai > 0.7) → fail ────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-007',
    artifacts: ARTIFACTS_OK,
    opts: {
      deep: true,
      runVoiceRulesGate: mockRuleGate({ verdict: 'PASS', score: 0.95 }),
      checkText: mockCheckText({ ai: 0.85, assisted: 0.10, human: 0.05 }),
    },
  });
  check('T7 Pangram-fail → status:fail (overrides rule-PASS)', r.status === 'fail', r);
  check('T7 Pangram-fail → score clamped ≤ 0.3', r.score <= 0.3, r);
  check('T7 Pangram-fail → fraction_ai surfaced', r.fraction_ai === 0.85, r);
  check('T7 Pangram-fail → rule_failures includes Pangram entry FIRST',
        r.rule_failures.length > 0 && /Pangram/.test(r.rule_failures[0].rule),
        r.rule_failures);
  check('T7 Pangram-fail → deep_used:true', r.deep_used === true, r);
}

// ── T8: deep=true + Pangram caveats (assisted > 0.4) → caveats ───────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-008',
    artifacts: ARTIFACTS_OK,
    opts: {
      deep: true,
      runVoiceRulesGate: mockRuleGate({ verdict: 'PASS', score: 0.90 }),
      checkText: mockCheckText({ ai: 0.15, assisted: 0.50, human: 0.35 }),
    },
  });
  check('T8 Pangram-caveats → status:caveats', r.status === 'caveats', r);
  check('T8 Pangram-caveats → score clamped ≤ 0.7', r.score <= 0.7, r);
  check('T8 Pangram-caveats → fraction_ai_assisted surfaced',
        r.fraction_ai_assisted === 0.50, r);
  check('T8 Pangram-caveats → rule_failures has assisted mention',
        r.rule_failures.some(f => /fraction_ai_assisted/.test(f.rule)),
        r.rule_failures);
}

// ── T9: deep=true but checkText throws → rule-gate verdict drives ────────
{
  const r = await voiceRetentionCheck({
    slug: 'test-voice-009',
    artifacts: ARTIFACTS_OK,
    opts: {
      deep: true,
      runVoiceRulesGate: mockRuleGate({ verdict: 'PASS', score: 0.91 }),
      checkText: async () => { throw new Error('Pangram rate-limit'); },
    },
  });
  check('T9 detection-throws → status falls back to rule-PASS', r.status === 'pass', r);
  check('T9 detection-throws → score reflects rule-gate (no clamp)', r.score === 0.91, r);
  check('T9 detection-throws → deep_used:true (was attempted)', r.deep_used === true, r);
}

// ── T10: _internal contract sanity ────────────────────────────────────────
{
  check('T10 PANGRAM_FAIL_THRESHOLD=0.7', _internal.PANGRAM_FAIL_THRESHOLD === 0.7, _internal);
  check('T10 PANGRAM_CAVEATS_THRESHOLD=0.4', _internal.PANGRAM_CAVEATS_THRESHOLD === 0.4, _internal);
  check('T10 MIN_TEXT_LENGTH=200', _internal.MIN_TEXT_LENGTH === 200, _internal);
}

// ── Final report ─────────────────────────────────────────────────────────
console.log('');
console.log(`voice-retention-check: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  ✗ ${f.name}`);
  process.exit(1);
}
process.exit(0);
