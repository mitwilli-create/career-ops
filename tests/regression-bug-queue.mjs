#!/usr/bin/env node
// tests/regression-bug-queue.mjs
//
// Smoke tests for the regression-guard → bug-resolver bridge (v2 Change #1).
// Self-contained: uses a temp queue file path via QUEUE_OVERRIDE env trick
// (no override implemented; instead we run against a snapshot of the real
// path, restore at end). Side-effect-free if run repeatedly.
//
// Coverage:
//   1  appendRegressionFinding writes eligible findings, skips ineligibles
//   2  dedup: same finding twice → only one entry written
//   3  appendRegressionFindings (bulk) returns correct counts
//   4  regressionFindingHash is stable across runs + ignores summary text
//   5  mapFindingToLedgerShape produces a bug-ledger-compatible shape
//   6  cross-fork-leak guard fires on inline sensitive-path markers
//   7  loadPendingRegressionEntries filters by state
//   8  updateRegressionEntry routes v2_pipeline_state correctly
//   9  unified-queue: loadUnifiedQueue merges + unwraps
//  10  unified-queue: updateUnifiedEntry routes rg-* to regression-queue,
//      bug-* to ledger
//
// Run: node tests/regression-bug-queue.mjs
// Exit: 0 = all pass, 1 = at least one fail
//
// IMPORTANT: this test MODIFIES data/regression-bug-queue.jsonl temporarily
// (snapshots + restores at end via try/finally). It does NOT touch
// data/bug-ledger.jsonl.

import {
  readFileSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRegressionQueue,
  loadPendingRegressionEntries,
  nextRegressionId,
  regressionFindingHash,
  isEligibleFinding,
  isImmediateInvocationFinding,
  mapFindingToLedgerShape,
  assertNoSensitiveInlineContent,
  appendRegressionFinding,
  appendRegressionFindings,
  updateRegressionEntry,
  isRegressionQueueId,
  queuePath,
} from '../lib/bug-resolver/regression-queue.mjs';

import {
  loadUnifiedQueue,
  updateUnifiedEntry,
  entrySource,
} from '../lib/bug-resolver/unified-queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const QUEUE_PATH = queuePath();

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
  if (existsSync(QUEUE_PATH)) {
    return readFileSync(QUEUE_PATH, 'utf-8');
  }
  return null;
}

function restore(snap) {
  if (snap === null) {
    if (existsSync(QUEUE_PATH)) unlinkSync(QUEUE_PATH);
  } else {
    writeFileSync(QUEUE_PATH, snap);
  }
}

function clearQueue() {
  writeFileSync(QUEUE_PATH, '');
}

// ─── Fixtures ──────────────────────────────────────────────────────────────
const FINDING_CRIT_CODE = {
  type: 1, severity: 'CRIT', confidence: 'HIGH',
  subtype: 'outer-template-unescape-suspect',
  file: 'scripts/build-dashboard.mjs',
  line: 12345,
  summary: 'single-backslash escape in inner JS string inside outer template',
  citation: { mode: 'hash_only', hash: 'sha256:aaaa1111' },
};

const FINDING_HIGH_UI = {
  type: 2, severity: 'HIGH', confidence: 'MED',
  subtype: 'ui-structural-drift',
  file: 'dashboard/index.html',
  line: 0,
  summary: 'dashboard size exceeded baseline by 18%',
  citation: { mode: 'hash_only', hash: 'sha256:bbbb2222' },
};

const FINDING_MED_DATA = {
  type: 3, severity: 'MED', confidence: 'MED',
  subtype: 'data-integrity-row-count-drift',
  file: 'data/applications.md',
  line: 0,
  summary: 'applications.md row count dropped 47 → 32',
  citation: { mode: 'hash_only', hash: 'sha256:cccc3333' },
};

const FINDING_LOW_CODE = {
  type: 1, severity: 'LOW', confidence: 'LOW',
  subtype: 'outer-template-unescape-loose',
  file: 'scripts/build-dashboard.mjs',
  line: 99,
  summary: 'broad heuristic match — likely false positive',
  citation: { mode: 'hash_only', hash: 'sha256:dddd4444' },
};

const FINDING_HIGH_CLOSURE = {
  type: 6, severity: 'HIGH', confidence: 'HIGH',
  subtype: 'closure-invariant-violation',
  file: 'AGENTS.md',
  line: 200,
  summary: 'closure invariant from catalog Pattern X violated',
  citation: { mode: 'hash_only', hash: 'sha256:eeee5555' },
};

// ─── Test bodies ───────────────────────────────────────────────────────────
async function main() {
  const snap = snapshot();
  console.log(`[regression-bug-queue tests] snapshotted ${QUEUE_PATH} ` +
              `(${snap === null ? 'absent' : snap.length + ' bytes'}); ` +
              `running 11 test groups...\n`);
  try {
    // ─── Test 1: append eligibility filter ─────────────────────────────────
    // v2 2026-05-25 update: LOW is now eligible (interview Q11). Type filter
    // unchanged — closures/memory/perf still rejected.
    console.log('Test 1: appendRegressionFinding eligibility');
    clearQueue();

    const r1 = appendRegressionFinding(FINDING_CRIT_CODE);
    assert(r1.wrote === true && r1.id.startsWith('rg-'),
      '1a: CRIT type-1 finding writes successfully + id has rg- prefix');

    const r2 = appendRegressionFinding(FINDING_LOW_CODE);
    assert(r2.wrote === true && r2.id.startsWith('rg-'),
      '1b: LOW severity finding now ACCEPTED (Q11 expanded scope, was previously rejected)');

    const r3 = appendRegressionFinding(FINDING_HIGH_CLOSURE);
    assert(r3.wrote === false && r3.reason === 'not-eligible',
      '1c: type-6 closure finding still correctly rejected (type filter unchanged: types 1-4 only)');

    // ─── Test 2: dedup ─────────────────────────────────────────────────────
    console.log('\nTest 2: dedup on regression_citation_hash');
    clearQueue();
    appendRegressionFinding(FINDING_CRIT_CODE);
    const r4 = appendRegressionFinding(FINDING_CRIT_CODE);
    assert(r4.wrote === false && r4.reason === 'duplicate-active',
      '2a: re-writing same finding is rejected as duplicate-active');
    const after = loadRegressionQueue();
    assert(after.length === 1,
      '2b: queue contains exactly one entry after two writes of same finding');

    // ─── Test 3: bulk append ───────────────────────────────────────────────
    // v2 2026-05-25 update: LOW is now eligible. Closure (type 6) still not.
    console.log('\nTest 3: appendRegressionFindings (bulk)');
    clearQueue();
    const counts = appendRegressionFindings([
      FINDING_CRIT_CODE,
      FINDING_HIGH_UI,
      FINDING_MED_DATA,
      FINDING_LOW_CODE,           // now eligible (Q11)
      FINDING_HIGH_CLOSURE,       // still not-eligible (type 6)
      FINDING_CRIT_CODE,          // duplicate of first
    ]);
    assert(counts.written === 4,
      `3a: 4 eligible findings written including LOW (got ${counts.written})`);
    assert(counts.skipped_not_eligible === 1,
      `3b: 1 ineligible finding skipped (closure, got ${counts.skipped_not_eligible})`);
    assert(counts.skipped_duplicate === 1,
      `3c: 1 duplicate finding skipped (got ${counts.skipped_duplicate})`);

    // ─── Test 4: hash stability ────────────────────────────────────────────
    console.log('\nTest 4: regressionFindingHash stability');
    const h1 = regressionFindingHash(FINDING_CRIT_CODE);
    const h2 = regressionFindingHash({
      ...FINDING_CRIT_CODE,
      summary: 'totally different summary text',
      confidence: 'LOW',
      citation: { mode: 'hash_only', hash: 'sha256:DIFFERENT' },
    });
    assert(h1 === h2,
      `4a: hash ignores summary/confidence/citation (h1=${h1}, h2=${h2})`);

    const h3 = regressionFindingHash({ ...FINDING_CRIT_CODE, line: 99999 });
    assert(h1 !== h3,
      '4b: hash changes when line changes');

    const h4 = regressionFindingHash({ ...FINDING_CRIT_CODE, severity: 'HIGH' });
    assert(h1 !== h4,
      '4c: hash changes when severity changes');

    // ─── Test 5: ledger-shape mapping ──────────────────────────────────────
    console.log('\nTest 5: mapFindingToLedgerShape produces bug-ledger-compatible shape');
    const shape = mapFindingToLedgerShape(
      FINDING_CRIT_CODE, 'rg-2026-05-25-001',
      '2026-05-25T01:00:00-07:00', '2026-05-25T01:00:00-07:00'
    );
    assert(shape.id === 'rg-2026-05-25-001',
      '5a: shape.id matches passed id');
    assert(shape.source_surface === 'scripts/build-dashboard.mjs',
      '5b: shape.source_surface === finding.file');
    assert(shape.status === 'OPEN',
      '5c: shape.status defaults to OPEN');
    assert(shape.severity === 'CRIT',
      '5d: shape.severity propagated from finding');
    assert(shape.title.includes('outer-template-unescape-suspect'),
      '5e: shape.title includes finding.subtype');
    assert(shape.title.includes('scripts/build-dashboard.mjs:12345'),
      '5f: shape.title includes file:line');
    assert(shape.intake_metadata.is_sensitive_source === false,
      '5g: shape.intake_metadata.is_sensitive_source = false (regression-guard sources never sensitive)');
    assert(typeof shape.source_hash === 'string' && shape.source_hash.startsWith('sha256:'),
      '5h: shape.source_hash computed for real on-disk file');
    assert(Array.isArray(shape.vendor_log) && shape.vendor_log.length === 0,
      '5i: shape.vendor_log starts empty');

    // ─── Test 6: cross-fork-leak guard ─────────────────────────────────────
    console.log('\nTest 6: assertNoSensitiveInlineContent fires on bad inputs');
    let threw = false;
    try {
      assertNoSensitiveInlineContent({
        id: 'rg-test-bad-1',
        ledger_shape: {
          title: 'something quoted from .claude/projects/foo/bar.md',
          intake_metadata: { summary: 'innocuous summary' },
        },
      });
    } catch { threw = true; }
    assert(threw,
      '6a: guard fires on .claude/projects/ marker in title');

    threw = false;
    try {
      assertNoSensitiveInlineContent({
        id: 'rg-test-bad-2',
        ledger_shape: {
          title: 'innocuous title',
          intake_metadata: {
            summary: 'contains content from second-brain-extracted/personal.md',
          },
        },
      });
    } catch { threw = true; }
    assert(threw,
      '6b: guard fires on second-brain-extracted/ marker in summary');

    threw = false;
    try {
      assertNoSensitiveInlineContent({
        id: 'rg-test-good',
        ledger_shape: {
          title: 'normal title about scripts/build-dashboard.mjs',
          intake_metadata: { summary: 'normal summary, no sensitive paths' },
        },
      });
    } catch { threw = true; }
    assert(!threw,
      '6c: guard does NOT fire on innocuous content');

    // ─── Test 7: state filtering ───────────────────────────────────────────
    console.log('\nTest 7: loadPendingRegressionEntries filters by state');
    clearQueue();
    appendRegressionFinding(FINDING_CRIT_CODE);
    const all1 = loadRegressionQueue();
    const pending1 = loadPendingRegressionEntries();
    assert(all1.length === 1 && pending1.length === 1,
      '7a: fresh write produces 1 in both all and pending');

    updateRegressionEntry(all1[0].id, { v2_pipeline_state: 'DRAFT_PR' });
    const pending2 = loadPendingRegressionEntries();
    assert(pending2.length === 0,
      '7b: after DRAFT_PR state, pending count drops to 0');
    const all2 = loadRegressionQueue();
    assert(all2.length === 1 && all2[0].v2_pipeline_state === 'DRAFT_PR',
      '7c: all-load still returns it, with new state');

    // ─── Test 8: updateRegressionEntry validation ──────────────────────────
    console.log('\nTest 8: updateRegressionEntry validates state');
    threw = false;
    try {
      updateRegressionEntry(all1[0].id, { v2_pipeline_state: 'BOGUS_STATE' });
    } catch { threw = true; }
    assert(threw,
      '8a: invalid v2_pipeline_state is rejected');

    threw = false;
    try {
      updateRegressionEntry('rg-does-not-exist', { v2_pipeline_state: 'MERGED' });
    } catch { threw = true; }
    assert(threw,
      '8b: unknown id is rejected');

    // ─── Test 9: unified-queue loading ─────────────────────────────────────
    console.log('\nTest 9: loadUnifiedQueue merges + unwraps');
    clearQueue();
    appendRegressionFinding(FINDING_CRIT_CODE);
    appendRegressionFinding(FINDING_HIGH_UI);

    const unified = loadUnifiedQueue();
    // unified will include real bug-ledger entries too; we just check that
    // our two regression entries appear as LedgerEntry-shaped objects.
    const rgInUnified = unified.filter(e => isRegressionQueueId(e.id));
    assert(rgInUnified.length === 2,
      `9a: unified queue includes 2 regression entries (got ${rgInUnified.length})`);

    const rgCritEntry = rgInUnified.find(e => e.severity === 'CRIT');
    assert(rgCritEntry && rgCritEntry.source_surface === 'scripts/build-dashboard.mjs',
      '9b: regression entry unwrapped to ledger_shape — accessible like a normal LedgerEntry');
    assert(rgCritEntry && rgCritEntry.status === 'OPEN' &&
           Array.isArray(rgCritEntry.vendor_log),
      '9c: unwrapped entry has all expected LedgerEntry fields');

    // ─── Test 10: updateUnifiedEntry routing ───────────────────────────────
    console.log('\nTest 10: updateUnifiedEntry routes by id prefix');
    const rgId = rgCritEntry.id;
    assert(entrySource(rgId) === 'regression-queue',
      '10a: entrySource correctly identifies rg- prefix');
    assert(entrySource('bug-2026-05-23-001') === 'bug-ledger',
      '10b: entrySource correctly identifies bug- prefix');

    // Update via unified router — should set both wrapper state + ledger_shape.status
    updateUnifiedEntry(rgId, {
      status: 'DRAFT_PR',
      vendor_log: [{ phase: 'audit', vendor: 'gemini', costUsd: 0.05, ok: true }],
      total_cost_usd: 0.05,
    });
    const updated = loadRegressionQueue().find(e => e.id === rgId);
    assert(updated.v2_pipeline_state === 'DRAFT_PR',
      '10c: ledger.status=DRAFT_PR auto-advances wrapper.v2_pipeline_state to DRAFT_PR');
    assert(updated.ledger_shape.status === 'DRAFT_PR',
      '10d: ledger_shape.status updated via shape_patch');
    assert(updated.ledger_shape.total_cost_usd === 0.05,
      '10e: ledger_shape.total_cost_usd updated via shape_patch');
    assert(updated.ledger_shape.vendor_log.length === 1 &&
           updated.ledger_shape.vendor_log[0].vendor === 'gemini',
      '10f: ledger_shape.vendor_log updated via shape_patch');

    // Explicit v2_pipeline_state override
    updateUnifiedEntry(rgId, { v2_pipeline_state: 'MERGED' });
    const merged = loadRegressionQueue().find(e => e.id === rgId);
    assert(merged.v2_pipeline_state === 'MERGED',
      '10g: explicit v2_pipeline_state override takes effect');

    // ─── Test 11: immediate-invocation predicate (v2 2026-05-25 Q10) ───────
    console.log('\nTest 11: isImmediateInvocationFinding by severity');
    assert(isImmediateInvocationFinding(FINDING_CRIT_CODE) === true,
      '11a: CRIT triggers immediate invocation');
    assert(isImmediateInvocationFinding(FINDING_HIGH_UI) === true,
      '11b: HIGH triggers immediate invocation');
    assert(isImmediateInvocationFinding(FINDING_MED_DATA) === true,
      '11c: MED triggers immediate invocation');
    assert(isImmediateInvocationFinding(FINDING_LOW_CODE) === false,
      '11d: LOW does NOT trigger immediate invocation (Q10 — queued for scheduled)');
    assert(isImmediateInvocationFinding(FINDING_HIGH_CLOSURE) === false,
      '11e: type-6 closure NEVER immediate (not bridge-eligible even at HIGH)');
    assert(isImmediateInvocationFinding(null) === false,
      '11f: null finding handled safely (returns false)');
    assert(isImmediateInvocationFinding(undefined) === false,
      '11g: undefined finding handled safely (returns false)');
  } finally {
    restore(snap);
    console.log(`\n[regression-bug-queue tests] restored ${QUEUE_PATH}`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n[regression-bug-queue tests] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
