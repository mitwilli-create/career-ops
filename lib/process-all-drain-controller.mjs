/**
 * lib/process-all-drain-controller.mjs — bounded drain controller for Process All.
 *
 * Pure, side-effect-free orchestration of the triage→batch drain loop so it can
 * be unit-tested deterministically (every termination branch) without spawning
 * triage.mjs or batch-runner-batches.mjs. `scripts/process-all-pipeline.mjs`
 * wires the real phase functions into `runCycle` + `countPending`.
 *
 * Contract: chain cycles, re-verifying the pending queue depth after EACH
 * cycle, until ONE of these halts the loop (priority order within a cycle):
 *
 *   already-empty   — queue was 0 before any cycle ran (nothing to drain)
 *   drained-to-zero — queue reached 0 (the GOAL — "chains batches until 0")
 *   cycle-failed    — runCycle returned !ok (triage/batch hard failure)
 *   batch-<reason>  — runCycle reported a phaseBatch self-abort
 *                     (error-rate-degraded / wallclock-cap) — do NOT retry
 *   no-progress     — a full cycle drained 0 items; residual is undrainable
 *                     this run (dead postings, hard-disqualified, terminal-
 *                     errored/expired batches, or a triage skip-without-mark gap)
 *   max-cycles      — hit the cycle ceiling (very large queue → raise/re-run)
 *   wallclock-cap   — hit the shared wall-clock budget
 *
 * This is deliberately NOT an uncapped loop-until-exactly-0. "exactly 0" is the
 * goal, reached when reachable; the no-progress + max-cycles + wall-clock guards
 * prevent the infinite re-batch loop the 179-stuck-URL incident produced
 * (CLAUDE.md Session Notes 2026-05-27/29; AGENTS.md bug-class
 * convergence-impossible-runaway-without-cap).
 */

const CLEAN_REASONS = new Set(['already-empty', 'drained-to-zero']);

/**
 * @param {object}   o
 * @param {() => number}                       o.countPending     reads current pending queue depth
 * @param {(cycle:number, before:number) => Promise<{ok:boolean, aborted?:string|null}>} o.runCycle  runs one triage→batch cycle
 * @param {number}   o.maxCycles        hard ceiling on cycles (clamp the caller's value to [1,50])
 * @param {number}   o.wallclockCapMs   wall-clock budget from startedAtMs
 * @param {number}   o.startedAtMs      epoch-ms anchor (shared with phaseBatch)
 * @param {() => number} [o.now]        time source (injectable for tests); default Date.now
 * @param {(msg:string) => void} [o.log] logger (no-op default)
 * @returns {Promise<{reason:string, cyclesRun:number, cycleLog:Array, clean:boolean}>}
 */
export async function runDrainLoop({
  countPending,
  runCycle,
  maxCycles,
  wallclockCapMs,
  startedAtMs,
  now = () => Date.now(),
  log = () => {},
}) {
  if (typeof countPending !== 'function') throw new TypeError('runDrainLoop: countPending must be a function');
  if (typeof runCycle !== 'function') throw new TypeError('runDrainLoop: runCycle must be a function');

  let cycle = 0;
  let reason = null;
  const cycleLog = [];

  while (true) {
    // ── Pre-cycle guards: check BEFORE spending on another triage+batch ──
    const before = countPending();
    if (before === 0) { reason = cycle === 0 ? 'already-empty' : 'drained-to-zero'; break; }
    if (cycle >= maxCycles) { reason = 'max-cycles'; break; }
    if (now() - startedAtMs > wallclockCapMs) { reason = 'wallclock-cap'; break; }

    cycle++;
    log(`━━━ DRAIN CYCLE ${cycle}/${maxCycles} — ${before} pending in queue ━━━`);

    const res = await runCycle(cycle, before);

    // Hard phase failure (triage/batch exited non-zero). runCycle is expected
    // to have already recorded the failed-state side effects; we just stop.
    if (!res || res.ok !== true) {
      cycleLog.push({ cycle, before, after: countPending(), delta: 0, failed: true });
      reason = 'cycle-failed';
      break;
    }

    // ── Auto-verify: re-measure queue depth after the cycle ──
    const after = countPending();
    const delta = before - after;
    cycleLog.push({ cycle, before, after, delta, batch_aborted: res.aborted || null });
    log(`  ✓ cycle ${cycle}: ${before} → ${after} (drained ${delta})`);

    // ── Post-cycle break conditions, in priority order ──
    if (after === 0) { reason = 'drained-to-zero'; break; }
    // Respect phaseBatch's own governor: a degraded vendor (error-rate) or a
    // hung batch (wallclock) must NOT trigger another full cycle.
    if (res.aborted) { reason = `batch-${res.aborted}`; break; }
    // No-progress: a full triage+batch cycle reduced the queue by 0 — the
    // residual is undrainable this run. Break + report rather than spin.
    if (delta <= 0) { reason = 'no-progress'; break; }
  }

  if (reason == null) reason = 'max-cycles';
  return { reason, cyclesRun: cycle, cycleLog, clean: CLEAN_REASONS.has(reason) };
}

export { CLEAN_REASONS };
