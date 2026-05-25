#!/usr/bin/env node
// tests/v2-thrash-counter.mjs
//
// Smoke tests for lib/v2-thrash-counter.mjs (PR #5 of 10 in v2).
// Tests the FSM/threshold logic. The CLI side (v2-rollback.mjs) is
// integration-tested by running it dry-run.
//
// Side-effect-safe: snapshots + restores data/v2-rollback-counter.jsonl.

import {
  readFileSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs';

import {
  loadCounter,
  autoRevertsLast24h,
  isV2Frozen,
  getActiveFreeze,
  recordRollback,
  counterPath,
} from '../lib/v2-thrash-counter.mjs';

const PATH = counterPath();
let passed = 0;
let failed = 0;
const fails = [];

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    fails.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function snapshot() {
  return existsSync(PATH) ? readFileSync(PATH, 'utf-8') : null;
}
function restore(snap) {
  if (snap === null) {
    if (existsSync(PATH)) unlinkSync(PATH);
  } else {
    writeFileSync(PATH, snap);
  }
}
function clear() {
  writeFileSync(PATH, '');
}

console.log('[v2-thrash-counter tests] snapshotting + running...\n');
const snap = snapshot();

try {
  // ─── Test 1: empty state ─────────────────────────────────────────────────
  console.log('Test 1: empty state');
  clear();
  assert(loadCounter().length === 0, '1a: empty counter loads as empty array');
  assert(autoRevertsLast24h().length === 0, '1b: 0 auto-reverts when empty');
  assert(isV2Frozen() === false, '1c: not frozen when empty');
  assert(getActiveFreeze() === null, '1d: no active freeze when empty');

  // ─── Test 2: manual rollback doesn't trigger freeze ──────────────────────
  console.log('\nTest 2: manual rollbacks don\'t count toward freeze (Q6)');
  clear();
  recordRollback({ fix_sha: 'abc1', reason: 'cli-manual', trigger: 'manual' });
  recordRollback({ fix_sha: 'abc2', reason: 'cli-manual', trigger: 'manual' });
  recordRollback({ fix_sha: 'abc3', reason: 'cli-manual', trigger: 'manual' });
  recordRollback({ fix_sha: 'abc4', reason: 'cli-manual', trigger: 'manual' });
  assert(loadCounter().length === 4, '2a: 4 manual entries written');
  assert(autoRevertsLast24h().length === 0,
    '2b: autoRevertsLast24h ignores manual entries');
  assert(isV2Frozen() === false,
    '2c: 4 manual reverts in 24h do NOT trigger freeze');

  // ─── Test 3: auto-revert 1 + 2 don't freeze; 3rd freezes ────────────────
  console.log('\nTest 3: 3rd auto-revert in 24h triggers freeze');
  clear();
  const e1 = recordRollback({ fix_sha: 'auto1', reason: 'verification-subset-fail', trigger: 'auto' });
  assert(e1.frozen_until === null, '3a: 1st auto-revert does not freeze');
  assert(isV2Frozen() === false, '3b: still not frozen after 1st');

  const e2 = recordRollback({ fix_sha: 'auto2', reason: 'verification-subset-fail', trigger: 'auto' });
  assert(e2.frozen_until === null, '3c: 2nd auto-revert does not freeze');
  assert(isV2Frozen() === false, '3d: still not frozen after 2nd');

  const e3 = recordRollback({ fix_sha: 'auto3', reason: 'verification-subset-fail', trigger: 'auto' });
  assert(e3.frozen_until !== null, '3e: 3rd auto-revert SETS frozen_until');
  assert(isV2Frozen() === true, '3f: now frozen after 3rd');
  const active = getActiveFreeze();
  assert(active !== null && active.fix_sha === 'auto3',
    '3g: getActiveFreeze returns the 3rd entry');
  // Verify freeze duration is ~24h from now
  const freezeMs = new Date(e3.frozen_until).getTime();
  const expectedMs = Date.now() + 24 * 3600 * 1000;
  assert(Math.abs(freezeMs - expectedMs) < 5000,
    '3h: frozen_until is approximately now + 24h');

  // ─── Test 4: mixed manual + auto ─────────────────────────────────────────
  console.log('\nTest 4: mixed manual + auto — only auto counts');
  clear();
  recordRollback({ fix_sha: 'm1', reason: 'cli-manual', trigger: 'manual' });
  recordRollback({ fix_sha: 'a1', reason: 'verification-subset-fail', trigger: 'auto' });
  recordRollback({ fix_sha: 'm2', reason: 'cli-manual', trigger: 'manual' });
  recordRollback({ fix_sha: 'a2', reason: 'verification-subset-fail', trigger: 'auto' });
  recordRollback({ fix_sha: 'm3', reason: 'cli-manual', trigger: 'manual' });
  assert(loadCounter().length === 5, '4a: 5 total entries');
  assert(autoRevertsLast24h().length === 2,
    '4b: 2 auto entries counted');
  assert(isV2Frozen() === false,
    '4c: 2 auto + 3 manual does not freeze');

  // Now the 3rd auto should freeze
  const e = recordRollback({ fix_sha: 'a3', reason: 'verification-subset-fail', trigger: 'auto' });
  assert(e.frozen_until !== null, '4d: 3rd auto triggers freeze even with manual entries mixed in');
  assert(isV2Frozen() === true, '4e: now frozen');

  // ─── Test 5: validation ──────────────────────────────────────────────────
  console.log('\nTest 5: input validation');
  let threw = false;
  try { recordRollback({ fix_sha: '', reason: 'test', trigger: 'auto' }); } catch { threw = true; }
  assert(threw, '5a: empty fix_sha throws');

  threw = false;
  try { recordRollback({ fix_sha: 'x', reason: '', trigger: 'auto' }); } catch { threw = true; }
  assert(threw, '5b: empty reason throws');

  threw = false;
  try { recordRollback({ fix_sha: 'x', reason: 'r', trigger: 'BOGUS' }); } catch { threw = true; }
  assert(threw, '5c: trigger other than auto|manual throws');

  threw = false;
  try { recordRollback({ fix_sha: 'x', reason: 'r', trigger: 'auto' }); } catch { threw = true; }
  assert(!threw, '5d: valid recordRollback does not throw');

  // ─── Test 6: stale freeze (in past) doesn't count ────────────────────────
  console.log('\nTest 6: expired freeze auto-unfreezes');
  clear();
  // Manually append an entry whose frozen_until is in the past
  const expiredEntry = {
    at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
    fix_sha: 'old1',
    reason: 'verification-subset-fail',
    trigger: 'auto',
    frozen_until: new Date(Date.now() - 1000).toISOString(), // 1s ago
  };
  writeFileSync(PATH, JSON.stringify(expiredEntry) + '\n');
  assert(isV2Frozen() === false,
    '6a: expired frozen_until → not frozen (auto-unfreezes)');
  assert(getActiveFreeze() === null,
    '6b: no active freeze when expiry passed');
} finally {
  restore(snap);
  console.log(`\n[v2-thrash-counter tests] restored ${PATH}`);
}

console.log(`\n[v2-thrash-counter tests] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
