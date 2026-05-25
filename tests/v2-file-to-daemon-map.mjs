#!/usr/bin/env node
// tests/v2-file-to-daemon-map.mjs
//
// Smoke tests for scripts/lib/file-to-daemon-map.mjs (PR #3 of 10 in v2).
// Pure-logic tests only — does NOT invoke launchctl. The retryKickstart +
// restartDaemons paths are exercised by PR #4's verification subset runner
// against real daemons.
//
// Run: node tests/v2-file-to-daemon-map.mjs
// Exit: 0 = all pass, 1 = at least one fail

import {
  mapFilesToDaemons,
  isLongRunningDaemon,
  daemonServiceName,
  retryKickstart,
  restartDaemons,
  LONG_RUNNING_DAEMONS,
} from '../scripts/lib/file-to-daemon-map.mjs';

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

function setEquals(s, arr) {
  if (s.size !== arr.length) return false;
  for (const x of arr) if (!s.has(x)) return false;
  return true;
}

console.log('[v2-file-to-daemon-map] running 9 test groups...\n');

// ─── Test 1: dashboard surface ─────────────────────────────────────────────
console.log('Test 1: dashboard surface → dashboard-server');
{
  const d1 = mapFilesToDaemons(['scripts/build-dashboard.mjs']);
  assert(setEquals(d1, ['dashboard-server']),
    '1a: scripts/build-dashboard.mjs → {dashboard-server}');

  const d2 = mapFilesToDaemons(['dashboard-server.mjs']);
  assert(setEquals(d2, ['dashboard-server']),
    '1b: dashboard-server.mjs (root) → {dashboard-server}');

  const d3 = mapFilesToDaemons(['dashboard/index.html', 'dashboard/styles.css']);
  assert(setEquals(d3, ['dashboard-server']),
    '1c: dashboard/* (multiple files) → {dashboard-server}');
}

// ─── Test 2: telegram bot ──────────────────────────────────────────────────
console.log('\nTest 2: telegram bot → telegram-bot');
{
  const d1 = mapFilesToDaemons(['scripts/agents/telegram-bot.mjs']);
  assert(setEquals(d1, ['telegram-bot']),
    '2a: scripts/agents/telegram-bot.mjs → {telegram-bot}');

  const d2 = mapFilesToDaemons(['lib/telegram-formatter.mjs']);
  assert(setEquals(d2, ['telegram-bot']),
    '2b: lib/telegram-* → {telegram-bot}');
}

// ─── Test 3: signal monitor ────────────────────────────────────────────────
console.log('\nTest 3: signal monitor → signal-monitor');
{
  const d1 = mapFilesToDaemons(['scripts/signal-monitor.mjs']);
  assert(setEquals(d1, ['signal-monitor']),
    '3a: scripts/signal-monitor.mjs → {signal-monitor}');

  const d2 = mapFilesToDaemons(['lib/signal-utils.mjs']);
  assert(setEquals(d2, ['signal-monitor']),
    '3b: lib/signal-* → {signal-monitor}');
}

// ─── Test 4: heartbeat (no restart) ────────────────────────────────────────
console.log('\nTest 4: heartbeat scripts → no restart');
{
  const d1 = mapFilesToDaemons(['scripts/heartbeat.mjs']);
  assert(d1.size === 0,
    '4a: scripts/heartbeat.mjs → {} (scheduled-only, next launchd cycle picks up)');

  const d2 = mapFilesToDaemons(['scripts/heartbeat-evening.mjs']);
  assert(d2.size === 0,
    '4b: scripts/heartbeat-evening.mjs → {}');

  const d3 = mapFilesToDaemons(['lib/heartbeat-template.mjs']);
  assert(d3.size === 0,
    '4c: lib/heartbeat-* → {} (matches before lib/* conservative fallback)');
}

// ─── Test 5: lib/* conservative fallback ───────────────────────────────────
console.log('\nTest 5: unmatched lib/* → all long-running daemons');
{
  const d1 = mapFilesToDaemons(['lib/council.mjs']);
  assert(setEquals(d1, LONG_RUNNING_DAEMONS),
    '5a: lib/council.mjs (unmatched) → all 3 long-running daemons');

  const d2 = mapFilesToDaemons(['lib/leak-guard.mjs']);
  assert(setEquals(d2, LONG_RUNNING_DAEMONS),
    '5b: lib/leak-guard.mjs (unmatched) → all 3 long-running daemons');

  const d3 = mapFilesToDaemons(['lib/bug-resolver/pipeline.mjs']);
  assert(setEquals(d3, LONG_RUNNING_DAEMONS),
    '5c: lib/bug-resolver/pipeline.mjs (unmatched) → all 3 long-running daemons');
}

// ─── Test 6: non-daemon agents (no restart) ────────────────────────────────
console.log('\nTest 6: non-daemon scripts → no restart');
{
  const d1 = mapFilesToDaemons(['scripts/agents/bug-resolver.mjs']);
  assert(d1.size === 0,
    '6a: scripts/agents/bug-resolver.mjs (not a daemon) → {}');

  const d2 = mapFilesToDaemons(['scripts/agents/regression-guard.mjs']);
  assert(d2.size === 0,
    '6b: scripts/agents/regression-guard.mjs (not a daemon) → {}');

  const d3 = mapFilesToDaemons(['scripts/scan.mjs', 'scripts/check-liveness.mjs']);
  assert(d3.size === 0,
    '6c: other scheduled scripts → {}');
}

// ─── Test 7: combined / multi-file inputs ──────────────────────────────────
console.log('\nTest 7: combined changesets');
{
  const d1 = mapFilesToDaemons([
    'scripts/build-dashboard.mjs',
    'lib/telegram-formatter.mjs',
    'scripts/agents/bug-resolver.mjs',  // no restart
  ]);
  assert(setEquals(d1, ['dashboard-server', 'telegram-bot']),
    '7a: dashboard + telegram changes → both daemons; non-daemon ignored');

  const d2 = mapFilesToDaemons([
    'scripts/agents/regression-guard.mjs',
    'tests/regression-bug-queue.mjs',
    'AGENTS.md',
  ]);
  assert(d2.size === 0,
    '7b: only non-daemon/test/doc changes → {} (no restart)');

  const d3 = mapFilesToDaemons([
    'lib/council.mjs',
    'dashboard-server.mjs',
  ]);
  // lib/council matches conservative fallback (all daemons); + dashboard
  // direct match is a SUBSET — Set dedup gives all 3 daemons total.
  assert(setEquals(d3, LONG_RUNNING_DAEMONS),
    '7c: lib/* fallback + explicit dashboard → still all 3 (set dedup)');
}

// ─── Test 8: edge cases ────────────────────────────────────────────────────
console.log('\nTest 8: edge cases');
{
  const d1 = mapFilesToDaemons([]);
  assert(d1.size === 0,
    '8a: empty changeset → {}');

  const d2 = mapFilesToDaemons(null);
  assert(d2.size === 0,
    '8b: null changeset handled safely → {}');

  const d3 = mapFilesToDaemons(undefined);
  assert(d3.size === 0,
    '8c: undefined changeset handled safely → {}');

  const d4 = mapFilesToDaemons(['./scripts/build-dashboard.mjs']);
  assert(setEquals(d4, ['dashboard-server']),
    '8d: leading "./" stripped before matching');

  const d5 = mapFilesToDaemons(['/scripts/build-dashboard.mjs']);
  assert(setEquals(d5, ['dashboard-server']),
    '8e: leading "/" stripped before matching');
}

// ─── Test 9: helper exports ────────────────────────────────────────────────
console.log('\nTest 9: helper exports');
{
  assert(isLongRunningDaemon('dashboard-server') === true,
    '9a: isLongRunningDaemon recognizes dashboard-server');
  assert(isLongRunningDaemon('telegram-bot') === true,
    '9b: isLongRunningDaemon recognizes telegram-bot');
  assert(isLongRunningDaemon('signal-monitor') === true,
    '9c: isLongRunningDaemon recognizes signal-monitor');
  assert(isLongRunningDaemon('bug-resolver') === false,
    '9d: isLongRunningDaemon rejects non-daemons');

  const svc = daemonServiceName('dashboard-server');
  assert(svc === 'com.mitchell.career-ops.dashboard-server',
    '9e: daemonServiceName returns full launchd label');
  assert(daemonServiceName('unknown') === null,
    '9f: daemonServiceName returns null for unknown daemons');

  assert(typeof retryKickstart === 'function',
    '9g: retryKickstart is exported as a function');
  assert(typeof restartDaemons === 'function',
    '9h: restartDaemons is exported as a function');
}

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n[v2-file-to-daemon-map] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
