#!/usr/bin/env node
/**
 * tests/pre-apply-orchestrator.test.mjs
 *
 * Fixture tests for lib/pre-apply-orchestrator.mjs (Step 1 of pre-apply-check
 * deepening, per .claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md).
 *
 * Covers the 3 dealbreaker-required cases:
 *   T1 — Happy path: all-pass → overall_status:'ready', score:1.0
 *   T2 — HM-required rule: HM unavailable + ATS+voice pass → 'incomplete', score:0.5
 *   T3 — Promise.allSettled partial failure: HM throws + ATS+voice pass → 'incomplete'
 *
 * Plus additional invariants:
 *   T4 — All-fail → 'fail'
 *   T5 — HM-fail dominates (overrides ATS+voice pass) → 'fail'
 *   T6 — HM-pass + ATS-caveats → 'caveats', suggestion lists missing keywords
 *   T7 — All-unavailable via default fallbacks (no opts) → 'unavailable'
 *   T8 — Empty slug → throws
 *   T9 — CHECK_WEIGHTS sum to 1.0
 *
 * No live API calls — sub-checks are mocked via opts.{hmFn, atsFn, voiceFn}.
 *
 * Usage:  node tests/pre-apply-orchestrator.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import { composePreApplyCheck, _internal } from '../lib/pre-apply-orchestrator.mjs';

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

// Mock factories — return async functions matching the sub-check contract.
const mockReturn = (shape) => async () => shape;
const mockReject = (msg) => async () => { throw new Error(msg); };

// ── T1 (dealbreaker-required): Happy path — all pass ─────────────────────
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-001',
    jdText: 'sample JD text',
    artifacts: { cv: 'sample' },
    opts: {
      hmFn: mockReturn({ status: 'pass', score: 1.0, signals: ['ai-platform'], gaps: [] }),
      atsFn: mockReturn({ status: 'pass', score: 1.0, matched_keywords: ['ai', 'platform'], missing_keywords: [] }),
      voiceFn: mockReturn({ status: 'pass', score: 1.0, rule_failures: [] }),
    },
  });
  check('T1 happy → overall_status:ready', r.overall_status === 'ready', r);
  check('T1 happy → readiness_score:1.0', r.readiness_score === 1.0, r);
  check('T1 happy → checks.hm.status:pass', r.checks.hm.status === 'pass', r.checks.hm);
  check('T1 happy → no suggestions', r.suggestions.length === 0, r.suggestions);
  check('T1 happy → slug echoed', r.slug === 'test-pack-001', r);
  check('T1 happy → _computed_at is ISO string',
        typeof r._computed_at === 'string' && r._computed_at.endsWith('Z'),
        r._computed_at);
}

// ── T2 (dealbreaker-required): HM unavailable → incomplete ───────────────
// GPT-5's load-bearing critique: HM is REQUIRED for 'ready'. Without HM,
// max status is 'incomplete' even when ATS + voice pass cleanly.
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-002',
    opts: {
      hmFn: mockReturn({ status: 'unavailable', error: 'no hm-intel file' }),
      atsFn: mockReturn({ status: 'pass', score: 1.0 }),
      voiceFn: mockReturn({ status: 'pass', score: 1.0 }),
    },
  });
  check('T2 HM-unavail → overall_status:incomplete', r.overall_status === 'incomplete', r);
  check('T2 HM-unavail → readiness_score:0.5 (ATS 0.3 + voice 0.2)', r.readiness_score === 0.5, r);
  check('T2 HM-unavail → suggestion to run hm-research',
        r.suggestions.some(s => s.dimension === 'hm' && /hiring-manager-research/.test(s.action)),
        r.suggestions);
  check('T2 HM-unavail → hm-research suggestion has cost estimate',
        r.suggestions.some(s => s.dimension === 'hm' && typeof s.est_cost_usd === 'number' && s.est_cost_usd > 0),
        r.suggestions);
}

// ── T3 (dealbreaker-required): Promise.allSettled partial failure ────────
// HM throws Error; allSettled MUST NOT drop ATS+voice results.
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-003',
    opts: {
      hmFn: mockReject('hm-intel JSON malformed'),
      atsFn: mockReturn({ status: 'pass', score: 0.8 }),
      voiceFn: mockReturn({ status: 'pass', score: 1.0 }),
    },
  });
  check('T3 HM-throws → overall_status:incomplete', r.overall_status === 'incomplete', r);
  check('T3 HM-throws → checks.hm.status:error', r.checks.hm.status === 'error', r.checks.hm);
  check('T3 HM-throws → checks.hm.error captures the throw',
        /malformed/.test(r.checks.hm.error || ''), r.checks.hm);
  check('T3 HM-throws → ATS+voice survive (allSettled invariant)',
        r.checks.ats.status === 'pass' && r.checks.voice.status === 'pass',
        { ats: r.checks.ats, voice: r.checks.voice });
  // ATS 0.8 × 0.3 + voice 1.0 × 0.2 = 0.24 + 0.20 = 0.44
  check('T3 HM-throws → readiness_score:0.44 (weighted partial)',
        r.readiness_score === 0.44, r);
}

// ── T4 (additional): All-fail → fail ─────────────────────────────────────
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-004',
    opts: {
      hmFn: mockReturn({ status: 'fail', score: 0 }),
      atsFn: mockReturn({ status: 'fail', score: 0 }),
      voiceFn: mockReturn({ status: 'fail', score: 0 }),
    },
  });
  check('T4 all-fail → overall_status:fail', r.overall_status === 'fail', r);
  check('T4 all-fail → readiness_score:0', r.readiness_score === 0, r);
}

// ── T5 (additional): HM-fail dominates ATS+voice pass ────────────────────
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-005',
    opts: {
      hmFn: mockReturn({ status: 'fail', score: 0.2 }),
      atsFn: mockReturn({ status: 'pass', score: 1.0 }),
      voiceFn: mockReturn({ status: 'pass', score: 1.0 }),
    },
  });
  check('T5 HM-fail dominates → overall_status:fail', r.overall_status === 'fail', r);
}

// ── T6 (additional): HM-pass + ATS-caveats → caveats with keyword hints ──
{
  const r = await composePreApplyCheck({
    slug: 'test-pack-006',
    opts: {
      hmFn: mockReturn({ status: 'pass', score: 1.0 }),
      atsFn: mockReturn({
        status: 'caveats',
        score: 0.7,
        missing_keywords: ['kubernetes', 'terraform', 'eks'],
      }),
      voiceFn: mockReturn({ status: 'pass', score: 1.0 }),
    },
  });
  check('T6 ATS-caveats → overall_status:caveats', r.overall_status === 'caveats', r);
  check('T6 ATS-caveats → suggestion lists missing keywords',
        r.suggestions.some(s => s.dimension === 'ats' && /kubernetes/.test(s.action)),
        r.suggestions);
}

// ── T7 (additional): Default fallbacks (no opts) → unavailable ───────────
// Sub-check libs don't exist yet — _safeImport* must return stub functions
// that emit {status:'unavailable'}. Tests the dynamic-import fallback path.
{
  const r = await composePreApplyCheck({ slug: 'test-pack-007' });
  check('T7 default fallbacks → overall_status:unavailable',
        r.overall_status === 'unavailable', r);
  check('T7 default fallbacks → all check statuses:unavailable',
        r.checks.hm.status === 'unavailable'
          && r.checks.ats.status === 'unavailable'
          && r.checks.voice.status === 'unavailable',
        r.checks);
  // Each unavailable check must surface a non-empty error message so the
  // UI can show *why* the check came back unavailable. We don't pin the
  // specific text — as Step 2/3 sub-check libs ship, the message evolves
  // from the stub "not yet implemented" to the real check's own
  // unavailable-reason (e.g., voice: "no prose artifacts of length >= 200").
  check('T7 unavailable checks include non-empty error messages',
        typeof r.checks.hm.error === 'string' && r.checks.hm.error.length > 0
          && typeof r.checks.ats.error === 'string' && r.checks.ats.error.length > 0
          && typeof r.checks.voice.error === 'string' && r.checks.voice.error.length > 0,
        r.checks);
}

// ── T8 (additional): Empty slug → throws ─────────────────────────────────
{
  let threw = false;
  let msg = '';
  try { await composePreApplyCheck({ slug: '' }); }
  catch (err) { threw = true; msg = err.message; }
  check('T8 empty slug → throws with "slug" in message',
        threw && /slug/.test(msg), { threw, msg });
}

// ── T9 (additional): CHECK_WEIGHTS contract ──────────────────────────────
{
  const w = _internal.CHECK_WEIGHTS;
  const sum = w.hm + w.ats + w.voice;
  check('T9 CHECK_WEIGHTS sum to 1.0', Math.abs(sum - 1.0) < 1e-9, { weights: w, sum });
  check('T9 HM weight dominates (0.5)', w.hm === 0.5, w);
}

// ── Final report ─────────────────────────────────────────────────────────
console.log('');
console.log(`pre-apply-orchestrator: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  ✗ ${f.name}`);
  process.exit(1);
}
process.exit(0);
