// In-flight Anthropic batch detector.
//
// Reads batch/batches-api-state.json + returns a normalised snapshot of the
// most-recent in-flight batch (or null when nothing is in flight). Wired
// into dashboard-server.mjs::batchLive so the sidebar can render an amber
// "⏳ in-flight" chip even when no orchestrator job is currently in the
// batch phase (e.g., between rounds, or when a batch is left in flight
// after the orchestrator's phase advanced).
//
// Why this exists (Spec 5a, 2026-05-29): Anthropic's batch API uses a 60s
// poll cadence and atomic progress updates (processing:N→0, succeeded:0→N
// in a single observation). Without a visible "in-flight + elapsed + next
// poll in Ns" chip, the user perceives "stuck progress" because the count
// doesn't tick. Companion to the funnel-visibility renderer change.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Matches batch-runner-batches.mjs poll cadence; if that file changes, this
// should follow. Hardcoded rather than imported to keep the lib zero-dep.
const POLL_INTERVAL_MS = 60_000;

/**
 * Detect the most-recent in-flight batch from a parsed batches-api-state
 * structure. Pure function — pass parsed state + a timestamp.
 *
 * Accepts both array-of-batches and object-keyed-by-id shapes since
 * batch-runner-batches.mjs has shifted between them historically.
 *
 * @param {Object|Array|null} batchesState
 * @param {number} nowMs
 * @returns {Object|null}
 */
export function detectInFlightBatch(batchesState, nowMs) {
  if (!batchesState) return null;
  const batches = Array.isArray(batchesState)
    ? batchesState
    : Array.isArray(batchesState.batches)
      ? batchesState.batches
      : Object.values(batchesState.batches || {});
  if (!batches.length) return null;

  const inFlight = batches
    .filter((b) => {
      if (!b) return false;
      const counts = b.request_counts || {};
      const processing = counts.processing || 0;
      if (processing <= 0) return false;
      const status = String(b.processing_status || b.status || '').toLowerCase();
      // Terminal states should never have processing > 0, but defend against
      // corrupt records that claim both.
      return status !== 'ended' && status !== 'expired' && status !== 'canceled';
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  if (!inFlight.length) return null;
  const b = inFlight[0];
  const counts = b.request_counts || {};
  const processing = counts.processing || 0;
  const succeeded = counts.succeeded || 0;
  const errored = counts.errored || 0;
  const canceled = counts.canceled || 0;
  const expired = counts.expired || 0;
  const total = processing + succeeded + errored + canceled + expired;
  const completed = succeeded + errored + canceled + expired;
  const errorRate = completed > 0 ? errored / completed : 0;

  const submittedTs = Date.parse(b.created_at || '') || 0;
  const elapsedMs = submittedTs > 0 && nowMs > submittedTs ? nowMs - submittedTs : 0;
  // Best-effort next-poll estimate: orchestrator polls every POLL_INTERVAL_MS,
  // so the next poll lands at elapsed mod interval. When elapsed is 0 (missing
  // timestamp), default to a full interval.
  const nextPollInMs =
    elapsedMs > 0 ? POLL_INTERVAL_MS - (elapsedMs % POLL_INTERVAL_MS) : POLL_INTERVAL_MS;

  return {
    batchId: b.id || null,
    processing,
    succeeded,
    errored,
    canceled,
    expired,
    total,
    submitted_at: b.created_at || null,
    elapsed_ms: elapsedMs,
    next_poll_in_ms: nextPollInMs,
    error_rate: errorRate,
  };
}

/**
 * Convenience wrapper that reads + parses batches-api-state.json from disk.
 * Returns null on missing file or parse error so callers don't need
 * try/catch wrappers.
 */
export function detectInFlightBatchFromDisk(repoRoot, nowMs = Date.now()) {
  try {
    const fp = join(repoRoot, 'batch/batches-api-state.json');
    if (!existsSync(fp)) return null;
    const state = JSON.parse(readFileSync(fp, 'utf-8'));
    return detectInFlightBatch(state, nowMs);
  } catch (_) {
    return null;
  }
}
