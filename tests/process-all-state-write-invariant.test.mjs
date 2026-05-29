// tests/process-all-state-write-invariant.test.mjs
//
// Invariant: writeProcessState() in lib/process-all-state.mjs MUST write
// pipeline-process-state.json such that:
//   1. The file has a `jobs` map (backward-compat with existing SSE consumer
//      in dashboard-server.mjs::batchLive — line 2625-2627 reads ps.jobs[jobId])
//   2. Within jobs[jobId], all 11 required fields are present + valid:
//      job_id, status, phase, started_at, finished_at (null while running),
//      triage_advanced, processed, pending_before, pending_after,
//      rounds_completed, type
//   3. Writes are atomic — interrupting between open and rename leaves the
//      previous state intact (no half-written JSON).
//
// Spec: data/spec-process-all-drain-and-visibility-2026-05-29.md § 7

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeProcessState, REQUIRED_FIELDS } from '../lib/process-all-state.mjs';

const TMP = join(tmpdir(), 'process-all-state-test-' + Date.now());
mkdirSync(TMP, { recursive: true });
const STATE = join(TMP, 'pipeline-process-state.json');

test('T1 — required-fields contract', () => {
  // Documents what the 11 fields are. If REQUIRED_FIELDS drifts, this trips.
  const expected = [
    'job_id', 'type', 'status', 'phase', 'started_at', 'finished_at',
    'triage_advanced', 'processed', 'pending_before', 'pending_after',
    'rounds_completed',
  ];
  assert.deepEqual(REQUIRED_FIELDS.slice().sort(), expected.slice().sort());
});

test('T2 — empty file, fresh write populates all required fields under jobs[jobId]', () => {
  if (existsSync(STATE)) unlinkSync(STATE);
  writeProcessState({
    statePath: STATE,
    jobId: 'test-001',
    type: 'process-all',
    status: 'running',
    phase: 'triage',
    startedAt: '2026-05-29T01:00:00.000Z',
    startedAtMs: Date.parse('2026-05-29T01:00:00.000Z'),
    metrics: { triage_advanced: 0, processed: 0, pending_before: 303, pending_after: null, rounds_completed: 0 },
    maxRounds: 30,
  });
  const s = JSON.parse(readFileSync(STATE, 'utf-8'));
  assert.ok(s.jobs, 'top-level jobs map exists');
  const j = s.jobs['test-001'];
  assert.ok(j, 'job record exists');
  for (const k of REQUIRED_FIELDS) {
    assert.notStrictEqual(j[k], undefined, `field ${k} must be present (was undefined)`);
  }
  assert.equal(j.status, 'running');
  assert.equal(j.phase, 'triage');
  assert.equal(j.type, 'process-all');
  assert.equal(j.finished_at, null, 'finished_at null while running');
  assert.equal(j.pending_before, 303);
  assert.equal(j.rounds_completed, 0);
});

test('T3 — terminal write populates finished_at + wallclock_elapsed_ms', () => {
  writeProcessState({
    statePath: STATE,
    jobId: 'test-001',
    type: 'process-all',
    status: 'completed',
    phase: 'done',
    startedAt: '2026-05-29T01:00:00.000Z',
    startedAtMs: Date.parse('2026-05-29T01:00:00.000Z'),
    metrics: { triage_advanced: 50, processed: 48, pending_before: 303, pending_after: 255, rounds_completed: 5 },
    maxRounds: 30,
  });
  const s = JSON.parse(readFileSync(STATE, 'utf-8'));
  const j = s.jobs['test-001'];
  assert.equal(j.status, 'completed');
  assert.ok(j.finished_at, 'finished_at populated on terminal status');
  assert.ok(j.wallclock_elapsed_ms != null && j.wallclock_elapsed_ms >= 0, 'wallclock_elapsed_ms is a non-negative number');
  assert.equal(j.processed, 48);
});

test('T4 — writes are atomic (tmp + rename); no orphan tmp file after success', () => {
  const before = existsSync(STATE) ? statSync(STATE).mtimeMs : 0;
  writeProcessState({
    statePath: STATE,
    jobId: 'test-002',
    type: 'process-all',
    status: 'running',
    phase: 'batch',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    metrics: { triage_advanced: 25, processed: 0, pending_before: 100, pending_after: null, rounds_completed: 0 },
    maxRounds: 30,
  });
  const after = statSync(STATE).mtimeMs;
  assert.ok(after >= before, 'state file written');
  // Scan tmp dir for orphan tmp files — there should be no `*.tmp.*` siblings
  // of STATE after a successful write.
  const dir = TMP;
  const orphans = readdirSync(dir).filter(f => f.includes('.tmp.'));
  assert.deepEqual(orphans, [], 'no orphan tmp files left in state dir');
});

test('T5 — writes preserve other jobs in the jobs map', () => {
  // After two writes (test-001 + test-002), both must remain.
  const s = JSON.parse(readFileSync(STATE, 'utf-8'));
  assert.ok(s.jobs['test-001'], 'test-001 preserved');
  assert.ok(s.jobs['test-002'], 'test-002 preserved');
});

test('T6 — phase ∈ {triage, batch, polish, merge, rebuild, email, done, cancelled}', () => {
  const valid = ['triage', 'batch', 'polish', 'merge', 'rebuild', 'email', 'done', 'cancelled'];
  // Should not throw for any valid phase
  for (const p of valid) {
    assert.doesNotThrow(() => writeProcessState({
      statePath: STATE,
      jobId: 'test-003-' + p,
      type: 'process-all',
      status: 'running',
      phase: p,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      metrics: { triage_advanced: 0, processed: 0, pending_before: 0, pending_after: null, rounds_completed: 0 },
      maxRounds: 30,
    }));
  }
});

test('T7 — last_batch_result populated when present', () => {
  writeProcessState({
    statePath: STATE,
    jobId: 'test-004',
    type: 'process-all',
    status: 'running',
    phase: 'batch',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    metrics: {
      triage_advanced: 50,
      processed: 25,
      pending_before: 303,
      pending_after: 278,
      rounds_completed: 2,
      last_batch_id: 'msgbatch_test_abc',
      last_batch_result: { succeeded: 25, errored: 0, expired: 0 },
    },
    maxRounds: 30,
  });
  const s = JSON.parse(readFileSync(STATE, 'utf-8'));
  const j = s.jobs['test-004'];
  assert.equal(j.last_batch_id, 'msgbatch_test_abc');
  assert.deepEqual(j.last_batch_result, { succeeded: 25, errored: 0, expired: 0 });
});

// Cleanup at the end
test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true });
});
