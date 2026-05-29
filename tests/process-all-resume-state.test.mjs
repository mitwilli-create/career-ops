// tests/process-all-resume-state.test.mjs
//
// Tests for resume-state in lib/process-all-state.mjs.
// Resume contract:
//   - On SIGTERM/SIGINT/crash, orchestrator writes data/process-all-resume-state.json
//   - On next invocation, orchestrator reads it if < RESUME_TTL_MS (24h) AND
//     no --restart flag → skip phases already completed.
//
// Spec: data/spec-process-all-drain-and-visibility-2026-05-29.md § 3 + § 9

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeResumeState,
  readResumeState,
  clearResumeState,
  shouldResume,
  RESUME_TTL_MS,
} from '../lib/process-all-state.mjs';

function setupFixture() {
  const TMP = join(tmpdir(), 'process-all-resume-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(TMP, { recursive: true });
  return { TMP, resumePath: join(TMP, 'process-all-resume-state.json') };
}

test('T1 — writeResumeState then readResumeState round-trips', () => {
  const { TMP, resumePath } = setupFixture();
  writeResumeState({
    resumePath,
    jobId: 'proc-test-001',
    startedAt: '2026-05-29T01:00:00.000Z',
    phase: 'batch',
    roundsCompleted: 3,
    remainingUrlCount: 175,
    reason: 'sigterm',
  });
  const r = readResumeState({ resumePath });
  assert.equal(r.job_id, 'proc-test-001');
  assert.equal(r.resume_from.phase, 'batch');
  assert.equal(r.resume_from.next_round, 4, 'next_round = rounds_completed + 1');
  assert.equal(r.resume_from.remaining_url_count, 175);
  assert.equal(r.reason, 'sigterm');
  assert.ok(r.abandoned_at, 'abandoned_at populated');
  rmSync(TMP, { recursive: true, force: true });
});

test('T2 — readResumeState returns null when file missing', () => {
  const { TMP, resumePath } = setupFixture();
  const r = readResumeState({ resumePath });
  assert.equal(r, null);
  rmSync(TMP, { recursive: true, force: true });
});

test('T3 — readResumeState returns null on malformed JSON (no throw)', () => {
  const { TMP, resumePath } = setupFixture();
  writeFileSync(resumePath, 'not-json');
  let threw = false;
  let r;
  try { r = readResumeState({ resumePath }); } catch { threw = true; }
  assert.ok(!threw, 'must not throw');
  assert.equal(r, null);
  rmSync(TMP, { recursive: true, force: true });
});

test('T4 — shouldResume: fresh state (< 24h) and no --restart → true', () => {
  const { TMP, resumePath } = setupFixture();
  writeResumeState({
    resumePath,
    jobId: 'proc-fresh',
    startedAt: new Date().toISOString(),
    phase: 'batch',
    roundsCompleted: 1,
    remainingUrlCount: 50,
    reason: 'sigterm',
  });
  const decision = shouldResume({ resumePath, restartFlag: false });
  assert.ok(decision.resume, 'fresh state should resume');
  assert.ok(decision.state, 'state attached');
  assert.equal(decision.reason, 'fresh-state');
  rmSync(TMP, { recursive: true, force: true });
});

test('T5 — shouldResume: stale state (> 24h) → false', () => {
  const { TMP, resumePath } = setupFixture();
  const oldDate = new Date(Date.now() - (RESUME_TTL_MS + 60_000)).toISOString();
  writeFileSync(resumePath, JSON.stringify({
    job_id: 'proc-stale',
    started_at: oldDate,
    abandoned_at: oldDate,
    resume_from: { phase: 'batch', next_round: 2, remaining_url_count: 50 },
    reason: 'sigterm',
  }, null, 2));
  const decision = shouldResume({ resumePath, restartFlag: false });
  assert.ok(!decision.resume, 'stale state should NOT resume');
  assert.equal(decision.reason, 'state-too-old');
  rmSync(TMP, { recursive: true, force: true });
});

test('T6 — shouldResume: --restart flag forces fresh run', () => {
  const { TMP, resumePath } = setupFixture();
  writeResumeState({
    resumePath,
    jobId: 'proc-with-restart',
    startedAt: new Date().toISOString(),
    phase: 'batch',
    roundsCompleted: 1,
    remainingUrlCount: 50,
    reason: 'sigterm',
  });
  const decision = shouldResume({ resumePath, restartFlag: true });
  assert.ok(!decision.resume, '--restart wins over fresh state');
  assert.equal(decision.reason, 'restart-flag');
  rmSync(TMP, { recursive: true, force: true });
});

test('T7 — shouldResume: missing file → false (no resume needed)', () => {
  const { TMP, resumePath } = setupFixture();
  const decision = shouldResume({ resumePath, restartFlag: false });
  assert.ok(!decision.resume);
  assert.equal(decision.reason, 'no-state');
  rmSync(TMP, { recursive: true, force: true });
});

test('T8 — clearResumeState removes file (success-path cleanup)', () => {
  const { TMP, resumePath } = setupFixture();
  writeResumeState({
    resumePath,
    jobId: 'proc-cleanup',
    startedAt: new Date().toISOString(),
    phase: 'batch',
    roundsCompleted: 1,
    remainingUrlCount: 0,
    reason: 'sigterm',
  });
  assert.ok(existsSync(resumePath));
  clearResumeState({ resumePath });
  assert.ok(!existsSync(resumePath), 'file gone after clearResumeState');
  // Calling on already-missing file does not throw
  assert.doesNotThrow(() => clearResumeState({ resumePath }));
  rmSync(TMP, { recursive: true, force: true });
});

test('T9 — RESUME_TTL_MS is 24h', () => {
  assert.equal(RESUME_TTL_MS, 24 * 60 * 60 * 1000);
});
