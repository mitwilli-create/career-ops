// tests/icloud-safe-fs.test.mjs
//
// Tests for lib/icloud-safe-fs.mjs — bounded EDEADLK retry wrappers for hot
// state-file writes under iCloud Drive (fileproviderd mid-sync lock race).
//
// Canonical incident 2026-07-02: triage.mjs died with "Unknown system error
// -11" opening batch/daily-quota.json mid Process All run.
// See docs/BUG-CLASSES.md § icloud-fileprovider-edeadlk-on-hot-state-file.
//
// All retry-path tests inject sleepFn so the suite runs in milliseconds
// (no real 250ms/1s/3s waits).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isEdeadlkError,
  retrySyncOnEdeadlk,
  safeWriteFileSync,
  safeAppendFileSync,
  safeReadFileSync,
  DEFAULT_BACKOFF_MS,
} from '../lib/icloud-safe-fs.mjs';

function edeadlk(msg = 'EDEADLK: resource deadlock avoided, open \'/x/daily-quota.json\'') {
  const e = new Error(msg);
  e.code = 'EDEADLK';
  e.errno = -11;
  return e;
}

// ── isEdeadlkError matcher ──────────────────────────────────────

test('T1 — isEdeadlkError matches all three observed shapes', () => {
  assert.equal(isEdeadlkError(edeadlk()), true, 'code EDEADLK');
  const errnoOnly = new Error('some wrapper message');
  errnoOnly.errno = -11;
  assert.equal(isEdeadlkError(errnoOnly), true, 'errno -11');
  // The exact shape Node surfaced in the 2026-07-02 incident — no code, raw message
  assert.equal(
    isEdeadlkError(new Error("Unknown system error -11: Unknown system error -11, open 'batch/daily-quota.json'")),
    true,
    'raw "Unknown system error -11" message',
  );
});

test('T2 — isEdeadlkError rejects non-EDEADLK errors', () => {
  const enoent = new Error("ENOENT: no such file or directory, open '/nope'");
  enoent.code = 'ENOENT';
  enoent.errno = -2;
  assert.equal(isEdeadlkError(enoent), false);
  assert.equal(isEdeadlkError(null), false);
  assert.equal(isEdeadlkError(undefined), false);
  assert.equal(isEdeadlkError(new Error('EACCES: permission denied')), false);
});

// ── retrySyncOnEdeadlk core loop ────────────────────────────────

test('T3 — success on first attempt: no sleep, value returned', () => {
  const sleeps = [];
  const result = retrySyncOnEdeadlk(() => 42, { sleepFn: (ms) => sleeps.push(ms) });
  assert.equal(result, 42);
  assert.deepEqual(sleeps, []);
});

test('T4 — recovers after 2 EDEADLK failures; backoff schedule honored', () => {
  const sleeps = [];
  let calls = 0;
  const result = retrySyncOnEdeadlk(() => {
    calls++;
    if (calls <= 2) throw edeadlk();
    return 'recovered';
  }, { sleepFn: (ms) => sleeps.push(ms) });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 1000], 'slept 250ms then 1s before the successful third attempt');
});

test('T5 — exhausts schedule (4 attempts total) and rethrows the last EDEADLK', () => {
  const sleeps = [];
  let calls = 0;
  assert.throws(
    () => retrySyncOnEdeadlk(() => { calls++; throw edeadlk(`attempt ${calls}`); }, { sleepFn: (ms) => sleeps.push(ms) }),
    (err) => err.message.includes('attempt 4'),
  );
  assert.equal(calls, 1 + DEFAULT_BACKOFF_MS.length, '1 initial + 3 retries');
  assert.deepEqual(sleeps, [250, 1000, 3000]);
});

test('T6 — non-retryable error is rethrown immediately with zero sleeps', () => {
  const sleeps = [];
  let calls = 0;
  const enoent = new Error('ENOENT: no such file');
  enoent.code = 'ENOENT';
  assert.throws(
    () => retrySyncOnEdeadlk(() => { calls++; throw enoent; }, { sleepFn: (ms) => sleeps.push(ms) }),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('T7 — custom backoffMs overrides the default schedule', () => {
  const sleeps = [];
  let calls = 0;
  assert.throws(() => retrySyncOnEdeadlk(
    () => { calls++; throw edeadlk(); },
    { backoffMs: [10, 20], sleepFn: (ms) => sleeps.push(ms) },
  ));
  assert.equal(calls, 3, '1 initial + 2 retries for a 2-entry schedule');
  assert.deepEqual(sleeps, [10, 20]);
});

// ── fs wrappers ─────────────────────────────────────────────────

function setupFixture() {
  const TMP = join(tmpdir(), 'icloud-safe-fs-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(TMP, { recursive: true });
  return TMP;
}

test('T8 — safeWriteFileSync / safeAppendFileSync / safeReadFileSync happy-path round-trip', () => {
  const TMP = setupFixture();
  try {
    const f = join(TMP, 'daily-quota.json');
    safeWriteFileSync(f, JSON.stringify({ date: '2026-07-02', triaged: 5 }));
    safeAppendFileSync(f, '\n');
    const back = safeReadFileSync(f, 'utf8');
    assert.equal(JSON.parse(back).triaged, 5);
    assert.equal(readFileSync(f, 'utf8'), back, 'wrapper read matches raw read');
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});

test('T9 — wrappers do NOT retry real non-EDEADLK fs errors (ENOENT dir)', () => {
  const TMP = setupFixture();
  try {
    const missing = join(TMP, 'no-such-dir', 'quota.json');
    const sleeps = [];
    assert.throws(
      () => safeWriteFileSync(missing, '{}', undefined, { sleepFn: (ms) => sleeps.push(ms) }),
      (err) => err.code === 'ENOENT',
    );
    assert.deepEqual(sleeps, [], 'ENOENT must not consume the backoff schedule');
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});

test('T10 — wrapper retryOpts thread through (injected matcher + sleep prove wiring)', () => {
  const TMP = setupFixture();
  try {
    const missing = join(TMP, 'no-such-dir', 'quota.json');
    const sleeps = [];
    // Force the wrapper to treat ENOENT as retryable — proves retryOpts reach
    // the core loop. It must exhaust the injected 2-entry schedule.
    let threw = false;
    try {
      safeWriteFileSync(missing, '{}', undefined, {
        backoffMs: [5, 5],
        sleepFn: (ms) => sleeps.push(ms),
        isRetryable: () => true,
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'ENOENT');
    }
    assert.equal(threw, true);
    assert.deepEqual(sleeps, [5, 5]);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});
