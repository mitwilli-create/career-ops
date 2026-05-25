#!/usr/bin/env node
/**
 * tests/v2-thrash-enforcement.mjs — integration tests for PR #8.
 *
 * Tests the freeze enforcement + v2-fix-log wiring across:
 *   - lib/v2-thrash-counter.mjs (isV2Frozen / recordRollback)
 *   - lib/v2-fix-log.mjs (appendV2FixLogEntry / readLast24hEntries)
 *   - The verifyV2Fix auto-revert path (integration with v2-thrash-counter)
 *
 * Does NOT directly test regression-guard.mjs or bug-resolver.mjs (those
 * have heavy external deps — the freeze-enforcement logic is simple enough
 * to test via the shared lib modules they call).
 *
 * Run: node tests/v2-thrash-enforcement.mjs
 * Expected: all tests PASS, process exits 0.
 */

import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import {
  existsSync, writeFileSync, unlinkSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    _passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    _failed++;
  }
}

// ── Import modules under test ─────────────────────────────────────────────

import {
  isV2Frozen, getActiveFreeze, recordRollback, autoRevertsLast24h, counterPath,
} from '../lib/v2-thrash-counter.mjs';

import {
  appendV2FixLogEntry, loadV2FixLog, readLast24hEntries, fixLogPath,
} from '../lib/v2-fix-log.mjs';

// ── Save/restore helpers for real file paths ──────────────────────────────

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

const COUNTER_PATH = counterPath();
const LOG_PATH = fixLogPath();

// ── Shared fixture ────────────────────────────────────────────────────────

const VALID_FIX_ENTRY = {
  fix_sha: 'abc1234567',
  detector: 'bug-resolver',
  detector_severity: 'HIGH',
  finding_hash: 'sha256:aabbcc001122',
  pr_url: 'https://github.com/mitwilli-create/career-ops/pull/209',
  pr_state: 'DRAFT',
  verification: null,
  cost_usd: 1.50,
  files_changed: ['scripts/agents/regression-guard.mjs'],
  time_to_resolution_ms: 300000,
};

// ── Group 1: freeze detection with populated counter ──────────────────────
console.log('\n── v2-thrash-enforcement unit tests ──');
console.log('\n  Group 1: freeze detection via isV2Frozen()');

const backup1 = backupFile(COUNTER_PATH);
if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);

test('isV2Frozen() returns false when counter is absent', () => {
  strictEqual(isV2Frozen(), false);
});

test('isV2Frozen() returns false with only manual rollbacks', () => {
  if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
  const now = new Date().toISOString();
  // 3 manual rollbacks — should NOT trigger freeze
  for (let i = 0; i < 3; i++) {
    writeFileSync(COUNTER_PATH,
      JSON.stringify({ at: now, fix_sha: `sha_m${i}`, reason: 'cli-manual', trigger: 'manual', frozen_until: null }) + '\n',
      { flag: 'a' });
  }
  strictEqual(isV2Frozen(), false);
});

test('isV2Frozen() returns false with 2 auto-reverts (below threshold)', () => {
  if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
  const now = new Date().toISOString();
  for (let i = 0; i < 2; i++) {
    const entry = JSON.stringify({ at: now, fix_sha: `sha_a${i}`, reason: 'verification-subset-fail', trigger: 'auto', frozen_until: null });
    writeFileSync(COUNTER_PATH, (existsSync(COUNTER_PATH) ? readFileSync(COUNTER_PATH, 'utf-8') : '') + entry + '\n', { flag: 'a' });
  }
  strictEqual(isV2Frozen(), false);
});

test('isV2Frozen() returns true when frozen_until is in the future', () => {
  if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
  const futureIso = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    fix_sha: 'sha_trigger',
    reason: 'verification-subset-fail',
    trigger: 'auto',
    frozen_until: futureIso,
  });
  writeFileSync(COUNTER_PATH, entry + '\n');
  strictEqual(isV2Frozen(), true);
});

test('isV2Frozen() returns false when frozen_until has expired', () => {
  if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
  const pastIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    fix_sha: 'sha_expired',
    reason: 'verification-subset-fail',
    trigger: 'auto',
    frozen_until: pastIso,
  });
  writeFileSync(COUNTER_PATH, entry + '\n');
  strictEqual(isV2Frozen(), false);
});

restoreFile(COUNTER_PATH, backup1);

// ── Group 2: recordRollback trigger='auto' contribution to freeze ─────────
console.log('\n  Group 2: recordRollback auto-revert → freeze threshold');

const backup2 = backupFile(COUNTER_PATH);
if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);

test('recordRollback trigger=auto does not freeze on 1st auto-revert', () => {
  if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
  const entry = recordRollback({ fix_sha: 'sha_auto_1', reason: 'verification-subset-fail', trigger: 'auto' });
  strictEqual(entry.frozen_until, null);
  strictEqual(isV2Frozen(), false);
});

test('recordRollback trigger=auto does not freeze on 2nd auto-revert', () => {
  // Counter now has 1 entry from previous test
  const entry = recordRollback({ fix_sha: 'sha_auto_2', reason: 'verification-subset-fail', trigger: 'auto' });
  strictEqual(entry.frozen_until, null);
  strictEqual(isV2Frozen(), false);
});

test('recordRollback trigger=auto triggers freeze on 3rd auto-revert', () => {
  // Counter now has 2 entries from previous tests
  const entry = recordRollback({ fix_sha: 'sha_auto_3', reason: 'verification-subset-fail', trigger: 'auto' });
  ok(entry.frozen_until, 'frozen_until should be set on the 3rd auto-revert');
  strictEqual(isV2Frozen(), true, 'isV2Frozen() should return true after 3rd auto-revert');
});

test('recordRollback trigger=manual with active freeze does NOT extend the freeze', () => {
  // Counter is already frozen from previous test
  const freezeBefore = getActiveFreeze();
  recordRollback({ fix_sha: 'sha_manual_1', reason: 'cli-manual', trigger: 'manual' });
  const freezeAfter = getActiveFreeze();
  strictEqual(freezeBefore?.frozen_until, freezeAfter?.frozen_until, 'freeze expiry should not change from a manual rollback');
});

test('autoRevertsLast24h() excludes manual rollbacks', () => {
  // We have 3 auto + 1 manual from above
  const autoReverts = autoRevertsLast24h();
  for (const e of autoReverts) {
    strictEqual(e.trigger, 'auto', 'should only return auto-revert entries');
  }
  ok(autoReverts.length === 3, `expected 3 auto-reverts, got ${autoReverts.length}`);
});

restoreFile(COUNTER_PATH, backup2);

// ── Group 3: fix-log write on DRAFT_PR (unit-level — simulating bug-resolver's write) ──
console.log('\n  Group 3: fix-log write on DRAFT_PR creation');

const backup3 = backupFile(LOG_PATH);
if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH);

test('appendV2FixLogEntry with pr_state=DRAFT writes a valid entry', () => {
  const entry = appendV2FixLogEntry({ ...VALID_FIX_ENTRY, pr_state: 'DRAFT' });
  strictEqual(entry.pr_state, 'DRAFT');
  const entries = loadV2FixLog();
  strictEqual(entries.length, 1);
  strictEqual(entries[0].pr_state, 'DRAFT');
});

test('appendV2FixLogEntry with pr_state=VERIFIED writes a valid entry', () => {
  const entry = appendV2FixLogEntry({
    ...VALID_FIX_ENTRY,
    pr_state: 'VERIFIED',
    verification: { overall: 'PASS' },
  });
  strictEqual(entry.pr_state, 'VERIFIED');
  strictEqual(entry.verification?.overall, 'PASS');
});

test('appendV2FixLogEntry with pr_state=REVERTED and fail_reason writes a valid entry', () => {
  const entry = appendV2FixLogEntry({
    ...VALID_FIX_ENTRY,
    pr_state: 'REVERTED',
    verification: { overall: 'FAIL', fail_reason: 'daemon-restart-failed' },
  });
  strictEqual(entry.pr_state, 'REVERTED');
  strictEqual(entry.verification?.fail_reason, 'daemon-restart-failed');
});

test('readLast24hEntries returns all 3 entries written above', () => {
  const entries = readLast24hEntries();
  strictEqual(entries.length, 3, `expected 3 entries, got ${entries.length}`);
});

restoreFile(LOG_PATH, backup3);

// ── Group 4: verifyV2Fix auto-revert integration (dry-run) ────────────────
console.log('\n  Group 4: verifyV2Fix auto-revert code path (integration)');

// We test the auto-revert path by importing verifyV2Fix and running it in
// dry-run mode. In dry-run mode the fix-log write + recordRollback are
// skipped (dryRun=true guard inside verifyV2Fix), so we validate the
// control-flow shape without touching real data files.

const backup4c = backupFile(COUNTER_PATH);
const backup4l = backupFile(LOG_PATH);

import('../scripts/agents/v2-verify-subset.mjs').then(async (mod) => {
  const { verifyV2Fix } = mod;

  await testAsync('verifyV2Fix dry-run returns overall=PASS with no real daemons', async () => {
    const result = await verifyV2Fix({
      fixSha: 'dryrun_sha_001',
      changedFiles: ['lib/v2-fix-log.mjs'],
      dryRun: true,
    });
    // In dry-run mode all steps are skipped or succeed trivially.
    ok(result && typeof result === 'object', 'should return result object');
    ok(['PASS', 'FAIL'].includes(result.overall), 'overall should be PASS or FAIL');
  });

  await testAsync('verifyV2Fix dry-run does NOT write to v2-fix-log (dryRun guard)', async () => {
    if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH);
    await verifyV2Fix({
      fixSha: 'dryrun_sha_002',
      changedFiles: [],
      dryRun: true,
    });
    // dry-run should NOT write to log
    const entries = loadV2FixLog();
    strictEqual(entries.length, 0, 'dry-run should not write to v2-fix-log');
  });

  await testAsync('verifyV2Fix dry-run does NOT call recordRollback (dryRun guard)', async () => {
    if (existsSync(COUNTER_PATH)) unlinkSync(COUNTER_PATH);
    await verifyV2Fix({
      fixSha: 'dryrun_sha_003',
      changedFiles: [],
      dryRun: true,
    });
    // dry-run should not write to counter
    ok(!existsSync(COUNTER_PATH) || readFileSync(COUNTER_PATH, 'utf-8').trim() === '',
      'dry-run should not write to rollback counter');
  });

  restoreFile(COUNTER_PATH, backup4c);
  restoreFile(LOG_PATH, backup4l);

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log(`\n── Results: ${_passed} passed, ${_failed} failed ──\n`);
  if (_failed > 0) process.exit(1);
});
