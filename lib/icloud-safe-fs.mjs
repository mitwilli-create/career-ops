// lib/icloud-safe-fs.mjs — EDEADLK-tolerant sync fs wrappers for hot state files
//
// Why this exists: ~/Documents is synced by iCloud Drive (Desktop & Documents
// in iCloud). fileproviderd holds transient locks on files it is mid-sync on.
// A process that rewrites a small state file at high frequency (e.g.
// triage.mjs → batch/daily-quota.json after every URL) can race the sync
// daemon: the next open() lands while fileproviderd holds the file and fails
// with EDEADLK, surfaced by Node as "Unknown system error -11". Uncaught,
// that kills the whole run (canonical incident 2026-07-02 — Process All died
// at the triage phase).
//
// This module wraps the sync fs calls used on hot state paths in a bounded
// retry: 3 retries with 250ms / 1s / 3s backoff (4 total attempts). The
// backoff window comfortably outlasts a fileproviderd sync pass on a <10KB
// JSON file. Non-EDEADLK errors are rethrown immediately — this is NOT a
// generic error-swallower.
//
// See docs/BUG-CLASSES.md § icloud-fileprovider-edeadlk-on-hot-state-file
// for the incident, the structural fix evaluation (STATE_DIR vs symlinks),
// and detection commands.

import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';

export const DEFAULT_BACKOFF_MS = [250, 1000, 3000];

/**
 * True when err is the iCloud fileproviderd deadlock class:
 * EDEADLK code, errno -11, or the raw "Unknown system error -11" message
 * Node emits when libuv has no name for the errno on this platform.
 */
export function isEdeadlkError(err) {
  if (!err) return false;
  if (err.code === 'EDEADLK') return true;
  if (err.errno === -11) return true;
  const msg = String(err.message || '');
  return msg.includes('Unknown system error -11') || msg.includes('EDEADLK');
}

// Sync sleep without spinning the CPU. Atomics.wait is permitted on the
// Node.js main thread (unlike browsers) and blocks for exactly `ms`.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a synchronous fs operation, retrying on EDEADLK-class errors with
 * bounded backoff. Rethrows immediately on any other error; rethrows the
 * last EDEADLK error once the backoff schedule is exhausted.
 *
 * @param {Function} fn        the sync operation; its return value is returned
 * @param {object}   [opts]
 * @param {number[]} [opts.backoffMs]   delays between attempts (default 250/1000/3000)
 * @param {string}   [opts.label]       identifier for the NDJSON retry log line
 * @param {Function} [opts.sleepFn]     injectable sleep (unit tests)
 * @param {Function} [opts.isRetryable] injectable matcher (unit tests)
 */
export function retrySyncOnEdeadlk(fn, opts = {}) {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const label = opts.label ?? 'fs-op';
  const sleep = opts.sleepFn ?? sleepSync;
  const retryable = opts.isRetryable ?? isEdeadlkError;
  let lastErr;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!retryable(err)) throw err;
      lastErr = err;
      if (attempt === backoff.length) break; // schedule exhausted
      const delayMs = backoff[attempt];
      // NDJSON heartbeat so retries are visible in launchd/orchestrator logs
      try {
        process.stderr.write(JSON.stringify({
          t: new Date().toISOString(),
          event: 'edeadlk-retry',
          label,
          attempt: attempt + 1,
          delay_ms: delayMs,
          error: String(err.message || err).slice(0, 120),
        }) + '\n');
      } catch { /* logging must never break the retry */ }
      sleep(delayMs);
    }
  }
  throw lastErr;
}

/** writeFileSync with EDEADLK retry. */
export function safeWriteFileSync(path, data, options, retryOpts) {
  return retrySyncOnEdeadlk(() => writeFileSync(path, data, options), {
    label: `write:${path}`,
    ...retryOpts,
  });
}

/** appendFileSync with EDEADLK retry. */
export function safeAppendFileSync(path, data, options, retryOpts) {
  return retrySyncOnEdeadlk(() => appendFileSync(path, data, options), {
    label: `append:${path}`,
    ...retryOpts,
  });
}

/** readFileSync with EDEADLK retry. */
export function safeReadFileSync(path, options, retryOpts) {
  return retrySyncOnEdeadlk(() => readFileSync(path, options), {
    label: `read:${path}`,
    ...retryOpts,
  });
}
