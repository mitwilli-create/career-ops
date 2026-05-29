// Unit tests for lib/in-flight-batch-detector.mjs (Spec 5a server-side).
//
// Pure function tests — no network, no disk, no Date.now() leakage.
// Every test passes a fixed nowMs so the next-poll arithmetic is exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInFlightBatch } from '../lib/in-flight-batch-detector.mjs';

test('returns null on null/undefined/empty inputs', () => {
  assert.equal(detectInFlightBatch(null, 0), null);
  assert.equal(detectInFlightBatch(undefined, 0), null);
  assert.equal(detectInFlightBatch({}, 0), null);
  assert.equal(detectInFlightBatch({ batches: [] }, 0), null);
  assert.equal(detectInFlightBatch({ batches: {} }, 0), null);
});

test('returns null when no batch has processing > 0', () => {
  const state = {
    batches: [
      { id: 'b1', request_counts: { processing: 0, succeeded: 76, errored: 0 } },
      { id: 'b2', request_counts: { processing: 0, succeeded: 5, errored: 5 } },
    ],
  };
  assert.equal(detectInFlightBatch(state, Date.now()), null);
});

test('surfaces in-flight batch with all counts + elapsed + next-poll', () => {
  const state = {
    batches: [
      {
        id: 'msgbatch_abc123',
        created_at: '2026-05-29T22:00:00.000Z',
        processing_status: 'in_progress',
        request_counts: { processing: 50, succeeded: 26, errored: 0, canceled: 0, expired: 0 },
      },
    ],
  };
  const nowMs = Date.parse('2026-05-29T22:02:30.000Z'); // 150,000 ms after
  const r = detectInFlightBatch(state, nowMs);
  assert.equal(r.batchId, 'msgbatch_abc123');
  assert.equal(r.processing, 50);
  assert.equal(r.succeeded, 26);
  assert.equal(r.errored, 0);
  assert.equal(r.total, 76);
  assert.equal(r.submitted_at, '2026-05-29T22:00:00.000Z');
  assert.equal(r.elapsed_ms, 150_000);
  // 60000 - (150000 % 60000) = 60000 - 30000 = 30000
  assert.equal(r.next_poll_in_ms, 30_000);
  assert.equal(r.error_rate, 0);
});

test('picks most-recent (by created_at) when multiple batches are in flight', () => {
  const state = {
    batches: [
      {
        id: 'old',
        created_at: '2026-05-29T20:00:00.000Z',
        request_counts: { processing: 5, succeeded: 0, errored: 0 },
      },
      {
        id: 'new',
        created_at: '2026-05-29T21:00:00.000Z',
        request_counts: { processing: 10, succeeded: 0, errored: 0 },
      },
    ],
  };
  const r = detectInFlightBatch(state, Date.parse('2026-05-29T21:30:00.000Z'));
  assert.equal(r.batchId, 'new');
  assert.equal(r.processing, 10);
});

test('ignores batches with terminal processing_status (ended/expired/canceled) even when processing>0', () => {
  const state = {
    batches: [
      {
        id: 'ended-but-claims-processing',
        created_at: '2026-05-29T20:00:00.000Z',
        processing_status: 'ended',
        request_counts: { processing: 5, succeeded: 0, errored: 0 },
      },
      {
        id: 'expired-with-counts',
        created_at: '2026-05-29T19:00:00.000Z',
        status: 'expired',
        request_counts: { processing: 3, succeeded: 0, errored: 0 },
      },
      {
        id: 'canceled-with-counts',
        created_at: '2026-05-29T18:00:00.000Z',
        processing_status: 'canceled',
        request_counts: { processing: 2, succeeded: 0, errored: 0 },
      },
    ],
  };
  assert.equal(detectInFlightBatch(state, Date.now()), null);
});

test('accepts object-keyed batches shape (legacy variant)', () => {
  const state = {
    batches: {
      msgbatch_xyz: {
        id: 'msgbatch_xyz',
        created_at: '2026-05-29T22:00:00.000Z',
        request_counts: { processing: 3, succeeded: 0 },
      },
    },
  };
  const r = detectInFlightBatch(state, Date.parse('2026-05-29T22:01:00.000Z'));
  assert.equal(r.batchId, 'msgbatch_xyz');
  assert.equal(r.processing, 3);
});

test('accepts bare array shape (no .batches wrapper)', () => {
  const state = [
    {
      id: 'bare',
      created_at: '2026-05-29T22:00:00.000Z',
      request_counts: { processing: 1, succeeded: 0 },
    },
  ];
  const r = detectInFlightBatch(state, Date.parse('2026-05-29T22:00:30.000Z'));
  assert.equal(r.batchId, 'bare');
});

test('computes error_rate from completed (succeeded+errored+canceled+expired) only', () => {
  const state = {
    batches: [
      {
        id: 'partial-errors',
        created_at: '2026-05-29T22:00:00.000Z',
        request_counts: { processing: 10, succeeded: 8, errored: 2, canceled: 0, expired: 0 },
      },
    ],
  };
  const r = detectInFlightBatch(state, Date.now());
  // 2 errored / (8 succeeded + 2 errored) = 0.2; processing not in denominator
  assert.equal(r.error_rate, 0.2);
});

test('handles missing created_at gracefully (elapsed_ms=0, next_poll_in_ms=full interval)', () => {
  const state = {
    batches: [
      {
        id: 'no-timestamp',
        request_counts: { processing: 5, succeeded: 0 },
      },
    ],
  };
  const r = detectInFlightBatch(state, Date.now());
  assert.equal(r.batchId, 'no-timestamp');
  assert.equal(r.elapsed_ms, 0);
  assert.equal(r.next_poll_in_ms, 60_000);
});

test('handles malformed batch records gracefully (no throw, returns null)', () => {
  const state = {
    batches: [
      null,
      { id: 'no-counts' },
      { id: 'bad-counts', request_counts: 'not-an-object' },
    ],
  };
  assert.equal(detectInFlightBatch(state, Date.now()), null);
});

test('elapsed_ms is 0 when nowMs is BEFORE submitted_at (clock-skew safety)', () => {
  const state = {
    batches: [
      {
        id: 'future-submitted',
        created_at: '2026-05-29T22:10:00.000Z',
        request_counts: { processing: 1, succeeded: 0 },
      },
    ],
  };
  const r = detectInFlightBatch(state, Date.parse('2026-05-29T22:05:00.000Z'));
  assert.equal(r.elapsed_ms, 0);
});
