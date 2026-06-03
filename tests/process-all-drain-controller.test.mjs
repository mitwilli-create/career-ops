#!/usr/bin/env node
/**
 * tests/process-all-drain-controller.test.mjs
 *
 * Exhaustive termination-branch coverage for the bounded Process All drain
 * controller (lib/process-all-drain-controller.mjs). Pure + mocked — no triage,
 * no batch, no network, $0. Proves the loop ALWAYS terminates and picks the
 * correct stop reason, which is the safety property that prevents the
 * convergence-impossible-runaway-without-cap bug class.
 */
import assert from 'node:assert';
import { runDrainLoop, CLEAN_REASONS } from '../lib/process-all-drain-controller.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

// A stateful fake queue: runCycle drains `drainPerCycle` items (clamped at 0).
function fakeQueue(initial, drainPerCycle, { aborted = null, ok = true } = {}) {
  let pending = initial;
  const calls = { runCycle: 0 };
  return {
    countPending: () => pending,
    calls,
    runCycle: async () => {
      calls.runCycle++;
      pending = Math.max(0, pending - drainPerCycle);
      return { ok, aborted };
    },
  };
}
const BIG = 90 * 60 * 1000;

console.log('process-all-drain-controller — termination branches');

await test('already-empty: queue 0 at start → 0 cycles run', async () => {
  const q = fakeQueue(0, 10);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'already-empty');
  assert.strictEqual(r.cyclesRun, 0);
  assert.strictEqual(q.calls.runCycle, 0, 'runCycle must NOT be called on an empty queue');
  assert.strictEqual(r.clean, true);
});

await test('drained-to-zero in one cycle', async () => {
  const q = fakeQueue(10, 10);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'drained-to-zero');
  assert.strictEqual(r.cyclesRun, 1);
  assert.strictEqual(r.clean, true);
});

await test('drained-to-zero across multiple cycles (100, drain 40 → 3 cycles)', async () => {
  const q = fakeQueue(100, 40);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'drained-to-zero');
  assert.strictEqual(r.cyclesRun, 3); // 100→60→20→0
  assert.deepStrictEqual(r.cycleLog.map(c => c.after), [60, 20, 0]);
});

await test('no-progress: a full cycle drains 0 → stop after 1 cycle', async () => {
  const q = fakeQueue(50, 0);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'no-progress');
  assert.strictEqual(r.cyclesRun, 1);
  assert.strictEqual(r.clean, false, 'no-progress is NOT a clean stop');
});

await test('max-cycles: always makes progress but never reaches 0', async () => {
  const q = fakeQueue(1000, 1); // drains 1/cycle, would need 1000 cycles
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 3, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'max-cycles');
  assert.strictEqual(r.cyclesRun, 3, 'must stop exactly at the cycle ceiling');
  assert.strictEqual(q.calls.runCycle, 3);
});

await test('wallclock-cap: time budget trips between cycles', async () => {
  const q = fakeQueue(100, 10);
  // now() returns 0 on the first pre-cycle check, then jumps past the cap.
  let n = 0; const clock = [0, 5000]; const now = () => clock[Math.min(n++, clock.length - 1)];
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: 1000, startedAtMs: 0, now });
  assert.strictEqual(r.reason, 'wallclock-cap');
  assert.strictEqual(r.cyclesRun, 1, 'one cycle runs, then the wall-clock guard trips');
});

await test('batch-abort: phaseBatch self-abort stops the loop (no retry)', async () => {
  const q = fakeQueue(100, 10, { aborted: 'error-rate-degraded' });
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'batch-error-rate-degraded');
  assert.strictEqual(r.cyclesRun, 1);
  assert.strictEqual(r.clean, false);
});

await test('batch-abort wallclock variant surfaces the reason verbatim', async () => {
  const q = fakeQueue(100, 10, { aborted: 'wallclock-cap' });
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'batch-wallclock-cap');
});

await test('cycle-failed: runCycle returns ok:false → cycle-failed', async () => {
  const q = fakeQueue(100, 10, { ok: false });
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'cycle-failed');
  assert.strictEqual(r.cyclesRun, 1);
  assert.strictEqual(r.cycleLog[0].failed, true);
});

await test('cycleLog records before/after/delta per cycle', async () => {
  const q = fakeQueue(30, 10);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.deepStrictEqual(r.cycleLog, [
    { cycle: 1, before: 30, after: 20, delta: 10, batch_aborted: null },
    { cycle: 2, before: 20, after: 10, delta: 10, batch_aborted: null },
    { cycle: 3, before: 10, after: 0,  delta: 10, batch_aborted: null },
  ]);
});

await test('drained-to-zero takes priority over a same-cycle batch-abort', async () => {
  // If a cycle both reaches 0 AND reports aborted, reaching 0 wins (work is done).
  const q = fakeQueue(10, 10, { aborted: 'wallclock-cap' });
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 12, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.reason, 'drained-to-zero');
});

await test('CLEAN_REASONS = exactly {already-empty, drained-to-zero}', () => {
  assert.deepStrictEqual([...CLEAN_REASONS].sort(), ['already-empty', 'drained-to-zero']);
});

await test('type guard: non-function countPending throws', async () => {
  await assert.rejects(() => runDrainLoop({ countPending: null, runCycle: async () => ({ ok: true }), maxCycles: 1, wallclockCapMs: BIG, startedAtMs: 0 }), /countPending must be a function/);
});

await test('type guard: non-function runCycle throws', async () => {
  await assert.rejects(() => runDrainLoop({ countPending: () => 1, runCycle: null, maxCycles: 1, wallclockCapMs: BIG, startedAtMs: 0 }), /runCycle must be a function/);
});

await test('maxCycles=1 with a draining queue still terminates (no off-by-one spin)', async () => {
  const q = fakeQueue(100, 10);
  const r = await runDrainLoop({ countPending: q.countPending, runCycle: q.runCycle, maxCycles: 1, wallclockCapMs: BIG, startedAtMs: 0, now: () => 0 });
  assert.strictEqual(r.cyclesRun, 1);
  assert.strictEqual(r.reason, 'max-cycles');
});

console.log(`\nprocess-all-drain-controller: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
