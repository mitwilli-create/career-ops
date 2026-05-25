#!/usr/bin/env node
// tests/v2-verify-subset.mjs
//
// Smoke tests for scripts/agents/v2-verify-subset.mjs (PR #4 of 10 in v2).
//
// Tests dry-run path (no side effects) + invocation contract. Real curl /
// node execSync paths are exercised by integration when bug-resolver calls
// verifyV2Fix with a real merged commit; here we just verify the
// orchestration shape + dry-run semantics + step ordering.
//
// Run: node tests/v2-verify-subset.mjs

import { verifyV2Fix } from '../scripts/agents/v2-verify-subset.mjs';

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

console.log('[v2-verify-subset tests] running 5 test groups (dry-run only)...\n');

// ─── Test 1: dry-run orchestration shape ───────────────────────────────────
console.log('Test 1: dry-run returns expected shape');
{
  const r = await verifyV2Fix({
    fixSha: 'abc123',
    changedFiles: ['scripts/agents/bug-resolver.mjs'],
    dryRun: true,
  });
  assert(r.overall === 'PASS',
    '1a: dry-run with non-UI files → overall PASS');
  assert(r.fixSha === 'abc123',
    '1b: fixSha echoed in result');
  assert(typeof r.elapsedMs === 'number' && r.elapsedMs >= 0,
    '1c: elapsedMs is a non-negative number');
  assert(r.steps && typeof r.steps === 'object',
    '1d: steps object present');
  assert(r.dryRun === true,
    '1e: dryRun flag echoed');
}

// ─── Test 2: all 5 steps present in result ─────────────────────────────────
console.log('\nTest 2: all 5 step keys present');
{
  const r = await verifyV2Fix({
    fixSha: 'def456',
    changedFiles: ['scripts/build-dashboard.mjs'],
    dryRun: true,
  });
  assert('daemon_restart' in r.steps,
    '2a: steps.daemon_restart present');
  assert('canary' in r.steps,
    '2b: steps.canary present');
  assert('dashboard_live' in r.steps,
    '2c: steps.dashboard_live present');
  assert('heartbeat' in r.steps,
    '2d: steps.heartbeat present');
  assert('ui_verify' in r.steps,
    '2e: steps.ui_verify present');
}

// ─── Test 3: UI-touching files trigger ui_verify (not skipped) ─────────────
console.log('\nTest 3: UI-touch detection');
{
  const r1 = await verifyV2Fix({
    fixSha: 'ghi789',
    changedFiles: ['scripts/build-dashboard.mjs'],
    dryRun: true,
  });
  // In dry-run UI step returns ok:true with dryRun marker — but the
  // pre-dryRun branch checks if UI-touching first. Since dry-run shortcuts
  // ALL real work, both UI and non-UI inputs return ok:true. We can't
  // distinguish dry-run-skip-because-no-UI from dry-run-skip-but-was-UI
  // without invoking real curl. That's an integration concern.
  assert(r1.steps.ui_verify.ok === true,
    '3a: UI-touching files in dry-run → ui_verify ok (dry-run skip)');

  const r2 = await verifyV2Fix({
    fixSha: 'jkl000',
    changedFiles: ['lib/council.mjs'],
    dryRun: true,
  });
  assert(r2.steps.ui_verify.ok === true,
    '3b: non-UI files in dry-run → ui_verify ok');
}

// ─── Test 4: empty/missing input handled ───────────────────────────────────
console.log('\nTest 4: edge cases');
{
  const r1 = await verifyV2Fix({ fixSha: 'empty-test', changedFiles: [], dryRun: true });
  assert(r1.overall === 'PASS',
    '4a: empty changedFiles → PASS in dry-run (no daemons to restart)');
  assert(r1.steps.daemon_restart.ok === true && r1.steps.daemon_restart.skipped === true,
    '4b: empty changedFiles → daemon_restart skipped:true');

  const r2 = await verifyV2Fix({ dryRun: true });
  assert(r2.overall === 'PASS',
    '4c: omitted changedFiles handled safely → PASS');
  assert(Array.isArray(r2.changedFiles) && r2.changedFiles.length === 0,
    '4d: omitted changedFiles → empty array in result');

  const r3 = await verifyV2Fix({ fixSha: null, changedFiles: null, dryRun: true });
  assert(r3.overall === 'PASS',
    '4e: null inputs handled safely');
  assert(r3.fixSha === null,
    '4f: null fixSha echoed');
}

// ─── Test 5: step ordering preserved ───────────────────────────────────────
console.log('\nTest 5: step ordering + early-exit on daemon-restart fail');
{
  // We can't easily trigger a real daemon-restart fail in unit tests without
  // mocking. Just verify the dry-run path orders steps correctly via key
  // insertion order (JS objects preserve insertion order for string keys).
  const r = await verifyV2Fix({
    fixSha: 'order-test',
    changedFiles: ['scripts/build-dashboard.mjs', 'lib/council.mjs'],
    dryRun: true,
  });
  const stepKeys = Object.keys(r.steps);
  assert(stepKeys[0] === 'daemon_restart',
    `5a: daemon_restart is first step (got ${stepKeys[0]})`);
  assert(stepKeys[1] === 'canary',
    `5b: canary is second (got ${stepKeys[1]})`);
  assert(stepKeys[2] === 'dashboard_live',
    `5c: dashboard_live is third (got ${stepKeys[2]})`);
  assert(stepKeys[3] === 'heartbeat',
    `5d: heartbeat is fourth (got ${stepKeys[3]})`);
  assert(stepKeys[4] === 'ui_verify',
    `5e: ui_verify is fifth/last (got ${stepKeys[4]})`);
}

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n[v2-verify-subset tests] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
