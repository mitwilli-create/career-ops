#!/usr/bin/env node
/**
 * tests/polish-sigterm-e2e.test.mjs
 *
 * End-to-end SIGTERM test for the 2026-05-24 summary-on-abandon fix.
 *
 * Verifies that:
 *   T1. Spawning apply-pack-polish via the runPolishPack export installs
 *       SIGTERM/SIGINT handlers (when installSignalHandlers !== false).
 *   T2. Sending SIGTERM to the running orchestrator triggers the handler
 *       BEFORE the process exits.
 *   T3. The handler writes polish-orchestrator-summary.json with:
 *         abort_reason: 'SIGTERM'
 *         partial: true
 *         ok: false
 *         coherence stub valid for polish-status-loader
 *   T4. The process exits with code 143 (128 + 15 SIGTERM).
 *
 * Mechanism:
 *   Parent spawns tests/_polish-sigterm-runner.mjs as a child process.
 *   The runner emits PHASE2_READY:<summaryPath> on stdout once it's in
 *   Phase 2 with a slow polishArtifact mock. Parent waits for the
 *   POLISH_STARTED line, then sends SIGTERM, then reads the summary file.
 *
 * No live API calls — runner uses DI'd harvestPolishSignals + polishArtifact
 * + checkPackCoherence.
 *
 * Usage:
 *   node tests/polish-sigterm-e2e.test.mjs
 *
 * Exits 0 on pass; 1 on any failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNNER = join(__dirname, '_polish-sigterm-runner.mjs');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail !== undefined) console.error('  detail:', detail);
    fail++;
    failures.push({ name, detail });
  }
}

const testSlug = `zzz-polish-sigterm-test-${Date.now()}`;
const applyPackDir = join(REPO_ROOT, 'apply-pack', testSlug);
const dataPackDir = join(REPO_ROOT, 'data', 'apply-packs', testSlug);
const summaryPath = join(dataPackDir, 'polish-orchestrator-summary.json');

function cleanup() {
  try { rmSync(applyPackDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(dataPackDir, { recursive: true, force: true }); } catch { /* */ }
}

// Spawn the runner
const child = spawn(process.execPath, [RUNNER, '--slug', testSlug], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test' },
});

let stdoutBuf = '';
let stderrBuf = '';
let polishStartedSeen = false;
let phase2ReadySeen = false;
let exitCode = null;
let exitSignal = null;

child.stdout.setEncoding('utf-8');
child.stderr.setEncoding('utf-8');

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  for (const line of chunk.split('\n').filter(Boolean)) {
    if (line.startsWith('PHASE2_READY:')) phase2ReadySeen = true;
    if (line.startsWith('POLISH_STARTED:')) {
      polishStartedSeen = true;
      // Now safe to SIGTERM — we know the orchestrator is past Phase 1
      // and the polishArtifact mock is blocking inside Phase 2.
      // Send SIGTERM after a short grace period.
      setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* */ }
      }, 200);
    }
  }
});
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk;
});

const exitPromise = new Promise((resolve) => {
  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    resolve();
  });
});

// Failsafe — if the test doesn't progress, kill after 15s with SIGKILL
const failsafe = setTimeout(() => {
  try { child.kill('SIGKILL'); } catch { /* */ }
}, 15_000);

await exitPromise;
clearTimeout(failsafe);

try {
  // ────────────── Assertions ──────────────────────────────────────────
  check('T1 child emitted PHASE2_READY before exit', phase2ReadySeen, { stdout: stdoutBuf.slice(0, 480), stderr: stderrBuf.slice(0, 240) });
  check('T2 child emitted POLISH_STARTED before SIGTERM', polishStartedSeen, { stdout: stdoutBuf.slice(0, 480) });

  // exit code 143 on SIGTERM (128 + 15); some Node versions report null code + signal:'SIGTERM' instead
  const sigtermExit = exitCode === 143 || exitSignal === 'SIGTERM';
  check('T4 process exited with SIGTERM signal (code 143 or signal SIGTERM)', sigtermExit, { exitCode, exitSignal });

  check('T3.a summary file exists on disk after SIGTERM', existsSync(summaryPath), { summaryPath });
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    check('T3.b summary.abort_reason === "SIGTERM"', summary.abort_reason === 'SIGTERM', { abort_reason: summary.abort_reason });
    check('T3.c summary.partial === true', summary.partial === true, { partial: summary.partial });
    check('T3.d summary.ok === false', summary.ok === false, { ok: summary.ok });
    check('T3.e coherence stub has final_recommendation', summary.coherence && typeof summary.coherence.final_recommendation === 'string', { coherence: summary.coherence });
    check('T3.f coherence.meta.partial === true', summary.coherence?.meta?.partial === true, { meta: summary.coherence?.meta });
    check('T3.g coherence.meta.abort_reason === "SIGTERM"', summary.coherence?.meta?.abort_reason === 'SIGTERM', { abort_reason: summary.coherence?.meta?.abort_reason });
  }

  // Summary
  console.log('');
  console.log(`Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('');
    console.error('Failures:');
    for (const f of failures) {
      let d = f.detail;
      try { d = JSON.stringify(d); } catch { /* */ }
      console.error(`  - ${f.name} → ${String(d).slice(0, 480)}`);
    }
    process.exit(1);
  }
  process.exit(0);
} finally {
  cleanup();
}
