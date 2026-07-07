// tests/process-all-state-null-distinguishability.test.mjs
//
// data-truth-audit invariant: a NOT-YET-COMPUTED process-all count metric and a
// GENUINE ZERO must be distinguishable end to end — from the state writer, through
// the SSE consumer's gating predicate, to the rendered cell.
//
// Why (Qodo PR #385 finding 2 → this migration, 2026-07-06):
//   writeProcessState() used to 0-fill missing count metrics. A dashboard reading
//   `processed: 0` could not tell "batch ran, processed nothing" from "batch never
//   ran". That is the sentinel-treated-as-truthy bug class (numeric analogue): the
//   sidebar rendered "0 / 0" for a just-queued run that had computed nothing yet.
//
// The contract this test pins:
//   1. writeProcessState with count metrics OMITTED  → field === null (not 0).
//   2. writeProcessState with an explicit 0          → field === 0 (genuine zero).
//   3. isMetricComputed()/formatProcessMetric() map the two states differently.
//   4. The SSE gating predicate (pending_before == null → not_computed) + the
//      client cell decision render a null metric as a non-numeric "not run" and
//      a genuine 0 as a distinct string ("pending" / a real count) — never the
//      same string. This is the end-to-end distinguishability assertion.
//
// Exits non-zero (node:test default) if any assertion fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeProcessState,
  isMetricComputed,
  formatProcessMetric,
  COUNT_METRIC_FIELDS,
} from '../lib/process-all-state.mjs';

const TMP = join(tmpdir(), 'process-all-null-distinguish-' + Date.now());
mkdirSync(TMP, { recursive: true });
const STATE = join(TMP, 'pipeline-process-state.json');

function readJob(jobId) {
  const s = JSON.parse(readFileSync(STATE, 'utf-8'));
  return s.jobs[jobId];
}

// ── 1. Writer: omitted count metrics default to null, NOT 0 ─────────────────
test('D1 — omitted count metrics write as null (not-yet-computed), never 0', () => {
  if (existsSync(STATE)) unlinkSync(STATE);
  // A freshly-queued job: only presence-required fields, no counts computed yet.
  writeProcessState({
    statePath: STATE,
    jobId: 'notrun-001',
    type: 'process-all',
    status: 'queued',
    phase: 'triage',
    startedAt: '2026-07-06T01:00:00.000Z',
    startedAtMs: Date.parse('2026-07-06T01:00:00.000Z'),
    // metrics deliberately omitted
    maxRounds: 30,
  });
  const j = readJob('notrun-001');
  for (const f of COUNT_METRIC_FIELDS) {
    assert.strictEqual(j[f], null, `${f} must be null (not-yet-computed), got ${JSON.stringify(j[f])}`);
    assert.notStrictEqual(j[f], 0, `${f} must NOT 0-fill when not computed`);
  }
});

// ── 2. Writer: an explicit 0 is preserved as a genuine zero ─────────────────
test('D2 — explicit 0 count metrics write as genuine 0 (distinct from null)', () => {
  writeProcessState({
    statePath: STATE,
    jobId: 'genuine-zero-001',
    type: 'process-all',
    status: 'completed',
    phase: 'done',
    startedAt: '2026-07-06T01:00:00.000Z',
    startedAtMs: Date.parse('2026-07-06T01:00:00.000Z'),
    metrics: { triage_advanced: 0, processed: 0, pending_before: 0, rounds_completed: 0, pending_after: 0 },
    maxRounds: 30,
  });
  const j = readJob('genuine-zero-001');
  for (const f of COUNT_METRIC_FIELDS) {
    assert.strictEqual(j[f], 0, `${f} must preserve a genuine 0`);
  }
});

// ── 3. The two states are byte-distinct on disk ─────────────────────────────
test('D3 — not-computed (null) and genuine-0 are distinguishable in the state file', () => {
  const notRun = readJob('notrun-001');
  const zero = readJob('genuine-zero-001');
  for (const f of COUNT_METRIC_FIELDS) {
    assert.notStrictEqual(
      notRun[f], zero[f],
      `${f}: not-computed (${JSON.stringify(notRun[f])}) must differ from genuine-0 (${JSON.stringify(zero[f])})`,
    );
  }
});

// ── 4. Helpers map the two states to different displays ─────────────────────
test('D4 — isMetricComputed()/formatProcessMetric() distinguish null from 0', () => {
  assert.equal(isMetricComputed(null), false, 'null → not computed');
  assert.equal(isMetricComputed(undefined), false, 'undefined → not computed');
  assert.equal(isMetricComputed(0), true, '0 → computed (genuine zero)');
  assert.equal(isMetricComputed(5), true, 'positive → computed');

  // Malformed values are NOT computed — a finite number is required, so a stray
  // NaN / Infinity / string never leaks "NaN"/text into the UI as a real count.
  assert.equal(isMetricComputed(NaN), false, 'NaN → not a computed count');
  assert.equal(isMetricComputed(Infinity), false, 'Infinity → not a computed count');
  assert.equal(isMetricComputed('5'), false, 'string → not a computed count');

  assert.equal(formatProcessMetric(null), '—', 'null renders as the not-run sentinel');
  assert.equal(formatProcessMetric(undefined), '—', 'undefined renders as the not-run sentinel');
  assert.equal(formatProcessMetric(0), '0', 'genuine 0 renders as "0"');
  assert.equal(formatProcessMetric(5), '5', 'positive renders as its number');
  assert.equal(formatProcessMetric(NaN), '—', 'NaN renders as not-run, never "NaN"');
  assert.equal(formatProcessMetric('foo'), '—', 'malformed string renders as not-run, never leaked text');
  // Distinguishability is the whole point: the two must not collide.
  assert.notEqual(formatProcessMetric(null), formatProcessMetric(0));
});

// ── 5. End-to-end: writer → SSE gating predicate → client cell string ───────
// Pure re-implementations of the exact predicates the live code uses, so the
// data→display contract is asserted without importing the 30k-line dashboard.

// Mirror: dashboard-server.mjs::batchLive pipelineStages triageNotComputed.
function sseNotComputed(job) {
  return job.pending_before == null && job.triage_advanced == null;
}

// Mirror: scripts/build-dashboard.mjs stage renderer `cnt` decision for a
// not-active, not-done triage stage.
function clientTriageCell(job) {
  const notComputed = sseNotComputed(job);
  const ttl = typeof job.pending_before === 'number' ? job.pending_before : 0;
  const done = typeof job.triage_advanced === 'number' ? job.triage_advanced : 0;
  if (notComputed) return 'not run';
  if (ttl === 0 && done === 0) return 'pending';
  return done + ' / ' + ttl;
}

test('D5 — end-to-end: not-computed job renders "not run", genuine-0 does not', () => {
  const notRun = readJob('notrun-001');
  const zero = readJob('genuine-zero-001');

  assert.equal(sseNotComputed(notRun), true, 'not-computed job flagged not_computed by SSE predicate');
  assert.equal(sseNotComputed(zero), false, 'genuine-0 job NOT flagged not_computed');

  assert.equal(clientTriageCell(notRun), 'not run', 'not-computed → honest "not run" (never a fake count)');
  assert.notEqual(clientTriageCell(zero), 'not run', 'genuine-0 must NOT read "not run"');
  assert.equal(clientTriageCell(zero), 'pending', 'genuine empty queue reads "pending" (0/0), distinct string');

  // The core anti-lie invariant: the two renders are never the same string.
  assert.notEqual(clientTriageCell(notRun), clientTriageCell(zero));
});

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true });
});
