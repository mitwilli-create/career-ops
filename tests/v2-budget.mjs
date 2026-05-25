#!/usr/bin/env node
/**
 * tests/v2-budget.mjs — unit tests for lib/v2-budget.mjs
 *
 * PR #9 of 10 (v2 autonomous-remediation pipeline, 2026-05-25).
 * No external dependencies. Writes minimal JSONL fixtures to the real
 * data/ spend files for isolation testing, then restores them.
 *
 * Run: node tests/v2-budget.mjs
 * Expected: all tests PASS, process exits 0.
 */

import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import {
  existsSync, writeFileSync, unlinkSync, readFileSync,
} from 'node:fs';

// ── Test harness ──────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    _passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    _failed++;
  }
}

// ── Import module under test ──────────────────────────────────────────────

import {
  getTodaySpend,
  checkV2Budget,
  recordV2VerifySpend,
  spendFilePaths,
  BUDGET_USD_CAP,
} from '../lib/v2-budget.mjs';

const [RG_SPEND, BR_SPEND, VV_SPEND] = spendFilePaths();

// ── Helpers ───────────────────────────────────────────────────────────────

function backupFile(path) {
  if (existsSync(path)) return readFileSync(path, 'utf-8');
  return null;
}

function restoreFile(path, backup) {
  if (backup === null) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    writeFileSync(path, backup);
  }
}

// Write a spend record to a ledger file (append).
function appendSpend(filePath, date, usd) {
  const rec = JSON.stringify({ date, usd, timestamp: new Date().toISOString() });
  writeFileSync(filePath, (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '') + rec + '\n');
}

// PT date derived from a UTC ms timestamp (same logic as lib/v2-budget.mjs).
function ptDateFromMs(ms) {
  const ptOffset = -7 * 60 * 60 * 1000;
  const d = new Date(ms + ptOffset);
  return d.toISOString().slice(0, 10);
}

// ── Tests ──────────────────────────────────────────────────────────────────

// ─ Group 1: BUDGET_USD_CAP constant ──────────────────────────────────────
console.log('\n── lib/v2-budget.mjs unit tests ──');
console.log('\n  Group 1: BUDGET_USD_CAP constant');

test('BUDGET_USD_CAP is a positive number', () => {
  ok(typeof BUDGET_USD_CAP === 'number', 'should be a number');
  ok(BUDGET_USD_CAP > 0, 'should be positive');
});

test('BUDGET_USD_CAP does not exceed $1000 safety clamp', () => {
  ok(BUDGET_USD_CAP <= 1000, 'should not exceed $1000');
});

test('BUDGET_USD_CAP is $300 by default (no V2_BUDGET_USD env var in test env)', () => {
  if (!process.env.V2_BUDGET_USD) {
    strictEqual(BUDGET_USD_CAP, 300, 'default should be $300');
  } else {
    console.log(`  (skipped — V2_BUDGET_USD=${process.env.V2_BUDGET_USD} is set)`);
    _passed++; _failed--; // Cancel the test count delta
  }
});

// ─ Group 2: getTodaySpend ─────────────────────────────────────────────────
console.log('\n  Group 2: getTodaySpend()');

const b2_rg = backupFile(RG_SPEND);
const b2_br = backupFile(BR_SPEND);
const b2_vv = backupFile(VV_SPEND);
if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);

const TODAY_PT = ptDateFromMs(Date.now());
const YESTERDAY_PT = ptDateFromMs(Date.now() - 24 * 60 * 60 * 1000);

test('returns 0 when no spend files exist', () => {
  strictEqual(getTodaySpend(), 0);
});

test('sums spend from regression-guard-spend.jsonl', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, 5.50);
  appendSpend(RG_SPEND, TODAY_PT, 3.25);
  const spend = getTodaySpend();
  ok(Math.abs(spend - 8.75) < 0.001, `expected ~8.75, got ${spend}`);
});

test('sums spend from bug-resolver-spend.jsonl', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
  appendSpend(BR_SPEND, TODAY_PT, 20.00);
  const spend = getTodaySpend();
  ok(Math.abs(spend - 20.00) < 0.001, `expected ~20.00, got ${spend}`);
});

test('sums spend from v2-verify-spend.jsonl', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
  if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);
  appendSpend(VV_SPEND, TODAY_PT, 1.50);
  const spend = getTodaySpend();
  ok(Math.abs(spend - 1.50) < 0.001, `expected ~1.50, got ${spend}`);
});

test('sums spend across all 3 files', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
  if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, 10.00);
  appendSpend(BR_SPEND, TODAY_PT, 50.00);
  appendSpend(VV_SPEND, TODAY_PT, 2.50);
  const spend = getTodaySpend();
  ok(Math.abs(spend - 62.50) < 0.001, `expected ~62.50, got ${spend}`);
});

test('excludes entries from yesterday', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
  if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);
  appendSpend(RG_SPEND, YESTERDAY_PT, 99.99);
  appendSpend(RG_SPEND, TODAY_PT, 5.00);
  const spend = getTodaySpend();
  ok(Math.abs(spend - 5.00) < 0.001, `expected ~5.00, got ${spend}`);
});

test('skips malformed lines gracefully', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
  if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);
  writeFileSync(RG_SPEND, '{"date":"' + TODAY_PT + '","usd":3.00}\n{"broken":true\n{"date":"' + TODAY_PT + '","usd":2.00}\n');
  const spend = getTodaySpend();
  ok(Math.abs(spend - 5.00) < 0.001, `expected ~5.00 (skipping malformed), got ${spend}`);
});

restoreFile(RG_SPEND, b2_rg);
restoreFile(BR_SPEND, b2_br);
restoreFile(VV_SPEND, b2_vv);

// ─ Group 3: checkV2Budget ─────────────────────────────────────────────────
console.log('\n  Group 3: checkV2Budget()');

const b3_rg = backupFile(RG_SPEND);
const b3_br = backupFile(BR_SPEND);
const b3_vv = backupFile(VV_SPEND);
if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
if (existsSync(BR_SPEND)) unlinkSync(BR_SPEND);
if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);

test('returns ok:true when no spend exists', () => {
  const result = checkV2Budget();
  strictEqual(result.ok, true);
  strictEqual(result.spent, 0);
  strictEqual(result.cap, BUDGET_USD_CAP);
  ok(result.remaining > 0);
});

test('returns ok:true when spent is below cap', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, 10.00);
  const result = checkV2Budget();
  strictEqual(result.ok, true);
  ok(result.spent < result.cap);
});

test('returns ok:false when spent is exactly at cap', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, BUDGET_USD_CAP);
  const result = checkV2Budget();
  strictEqual(result.ok, false);
  ok(result.abortReason && result.abortReason.includes('exhausted'));
});

test('returns ok:false when spent exceeds cap', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, BUDGET_USD_CAP + 50);
  const result = checkV2Budget();
  strictEqual(result.ok, false);
});

test('returns ok:false when estimatedNextPhase would exceed cap', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, BUDGET_USD_CAP - 5); // $5 remaining
  const result = checkV2Budget({ estimatedNextPhase: 10.00 }); // $10 next phase
  strictEqual(result.ok, false);
  ok(result.abortReason && result.abortReason.includes('would be exceeded'));
});

test('returns ok:true when estimatedNextPhase fits within remaining', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  appendSpend(RG_SPEND, TODAY_PT, BUDGET_USD_CAP - 50); // $50 remaining
  const result = checkV2Budget({ estimatedNextPhase: 20.00 });
  strictEqual(result.ok, true);
});

test('remaining field is correct', () => {
  if (existsSync(RG_SPEND)) unlinkSync(RG_SPEND);
  const spentToday = 123.45;
  appendSpend(RG_SPEND, TODAY_PT, spentToday);
  const result = checkV2Budget();
  const expectedRemaining = BUDGET_USD_CAP - spentToday;
  ok(Math.abs(result.remaining - expectedRemaining) < 0.01,
    `expected remaining ~${expectedRemaining.toFixed(2)}, got ${result.remaining.toFixed(2)}`);
});

restoreFile(RG_SPEND, b3_rg);
restoreFile(BR_SPEND, b3_br);
restoreFile(VV_SPEND, b3_vv);

// ─ Group 4: recordV2VerifySpend ────────────────────────────────────────────
console.log('\n  Group 4: recordV2VerifySpend()');

const b4_vv = backupFile(VV_SPEND);
if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);

test('writes a record to v2-verify-spend.jsonl', () => {
  recordV2VerifySpend({ usd: 0.25, phase: 'canary-check', label: 'test' });
  ok(existsSync(VV_SPEND), 'v2-verify-spend.jsonl should exist after first write');
  const raw = readFileSync(VV_SPEND, 'utf-8').trim();
  const rec = JSON.parse(raw);
  strictEqual(rec.usd, 0.25);
  strictEqual(rec.phase, 'canary-check');
  strictEqual(rec.source, 'v2-verify-subset');
});

test('record is picked up by getTodaySpend()', () => {
  if (existsSync(VV_SPEND)) unlinkSync(VV_SPEND);
  recordV2VerifySpend({ usd: 1.75, phase: 'test-phase' });
  // Must match today's PT date
  const spend = getTodaySpend();
  // Only VV_SPEND has data; should be 1.75 (RG+BR are absent or restored)
  ok(spend >= 1.75, `expected at least 1.75, got ${spend}`);
});

test('throws when usd is not a number', () => {
  let threw = false;
  try {
    recordV2VerifySpend({ usd: 'not-a-number', phase: 'x' });
  } catch (e) {
    threw = true;
  }
  ok(threw, 'should throw when usd is not a number');
});

restoreFile(VV_SPEND, b4_vv);

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n── Results: ${_passed} passed, ${_failed} failed ──\n`);
if (_failed > 0) process.exit(1);
