#!/usr/bin/env node
/**
 * tests/pre-apply-spend-tracker.test.mjs
 *
 * Fixture tests for lib/pre-apply-spend-tracker.mjs (Step 7 cost-governance).
 * Uses a temp dir so tests don't pollute the worktree's real data/.
 */

import { recordSpend, getDailySpend, estimatePreApplyCost, _internal } from '../lib/pre-apply-spend-tracker.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(tmpdir(), 'pre-apply-spend-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
mkdirSync(join(TMP_ROOT, 'data'), { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('✓ ' + name); pass++; }
  else {
    console.error('✗ ' + name);
    if (detail !== undefined) {
      try { console.error('  detail:', JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// ── T1: getDailySpend on empty disk → zero state ──────────────────────────
{
  const r = getDailySpend(TMP_ROOT);
  check('T1 empty disk → total_usd=0', r.total_usd === 0, r);
  check('T1 empty disk → call_count=0', r.call_count === 0, r);
  check('T1 empty disk → warn=false', r.warn === false, r);
  check('T1 default threshold=2', r.threshold === 2, r);
}

// ── T2: recordSpend → appended + total reflects ──────────────────────────
{
  const r = recordSpend(TMP_ROOT, 0.045, { slug: 'test-1', deep: false });
  check('T2 single record → total_usd=0.045', r.total_usd === 0.045, r);
  check('T2 single record → call_count=1', r.call_count === 1, r);
  check('T2 single record → warn=false (under threshold)', r.warn === false, r);
}

// ── T3: multiple records sum correctly ────────────────────────────────────
{
  recordSpend(TMP_ROOT, 0.045, { slug: 'test-2' });
  recordSpend(TMP_ROOT, 0.045, { slug: 'test-3' });
  const r = getDailySpend(TMP_ROOT);
  // T2 already recorded 0.045 → total now 0.135
  check('T3 multiple records → total_usd=0.135', Math.abs(r.total_usd - 0.135) < 1e-9, r);
  check('T3 multiple records → call_count=3', r.call_count === 3, r);
  check('T3 still under $2 threshold → warn=false', r.warn === false, r);
}

// ── T4: warn triggers at threshold ────────────────────────────────────────
// Bump up past $2.
{
  for (let i = 0; i < 45; i++) recordSpend(TMP_ROOT, 0.045);
  const r = getDailySpend(TMP_ROOT);
  check('T4 over threshold → warn=true', r.warn === true, r);
  check('T4 over threshold → total > 2', r.total_usd > 2, r);
}

// ── T5: estimatePreApplyCost matrix ───────────────────────────────────────
{
  // All sub-checks ran successfully + deep voice off
  const r1 = estimatePreApplyCost({
    checks: {
      hm: { status: 'pass', score: 0.85 },
      ats: { status: 'pass', score: 0.9 },
      voice: { status: 'pass', score: 1.0, deep_used: false },
    },
  });
  check('T5a pass + voice rule-only → ~$0.045 (HM only)', r1 === 0.045, r1);

  // HM unavailable → no charge for HM
  const r2 = estimatePreApplyCost({
    checks: {
      hm: { status: 'unavailable' },
      ats: { status: 'pass', score: 0.7 },
      voice: { status: 'pass', score: 1.0 },
    },
  });
  check('T5b HM unavailable → $0', r2 === 0, r2);

  // Deep voice on → HM + Pangram
  const r3 = estimatePreApplyCost({
    checks: {
      hm: { status: 'pass', score: 0.85 },
      ats: { status: 'pass', score: 0.9 },
      voice: { status: 'pass', score: 1.0, deep_used: true },
    },
  });
  check('T5c HM + deep voice → ~$0.145', r3 === 0.145, r3);

  // All unavailable → free
  const r4 = estimatePreApplyCost({
    checks: {
      hm: { status: 'unavailable' },
      ats: { status: 'unavailable' },
      voice: { status: 'unavailable' },
    },
  });
  check('T5d all unavailable → $0', r4 === 0, r4);

  // No checks (defensive) → $0
  const r5 = estimatePreApplyCost(null);
  check('T5e null result → $0', r5 === 0, r5);
}

// ── T6: malformed file → graceful zero ────────────────────────────────────
{
  // Already wrote files in T2-T4 — read from fresh temp instead.
  const TMP2 = join(tmpdir(), 'pre-apply-spend-malformed-' + Date.now());
  mkdirSync(join(TMP2, 'data'), { recursive: true });
  const path = _internal._spendPath(TMP2, _internal._todayISO());
  // Write malformed JSON
  await import('node:fs').then(fs => fs.writeFileSync(path, 'not valid json {{{'));
  const r = getDailySpend(TMP2);
  check('T6 malformed file → graceful zero state', r.total_usd === 0 && r.call_count === 0, r);
  try { rmSync(TMP2, { recursive: true, force: true }); } catch {}
}

// ── T7: env var threshold override ────────────────────────────────────────
{
  const orig = process.env.PRE_APPLY_DAILY_WARN_USD;
  process.env.PRE_APPLY_DAILY_WARN_USD = '5.5';
  // Need to re-import to pick up env? Actually the helper reads env each call.
  const r = getDailySpend(TMP_ROOT);
  check('T7 env threshold=5.5 honored', r.threshold === 5.5, r);
  // Restore
  if (orig === undefined) delete process.env.PRE_APPLY_DAILY_WARN_USD;
  else process.env.PRE_APPLY_DAILY_WARN_USD = orig;
}

// ── Cleanup ──────────────────────────────────────────────────────────────
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}

console.log('');
console.log('pre-apply-spend-tracker: ' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  ✗ ' + f.name);
  process.exit(1);
}
process.exit(0);
