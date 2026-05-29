// lib/process-all-state.mjs
//
// Reliable state-write + resume-state helpers for the Process All orchestrator.
//
// Why this exists (2026-05-29 deploy):
//   - The orchestrator's prior saveState() wrote pipeline-process-state.json
//     directly via writeFileSync, with no tmp+rename. A crash mid-write left
//     half-written JSON; the SSE consumer threw and silently downgraded.
//   - There was no SIGTERM/SIGINT-driven resume-state file. If Process All
//     was killed mid-batch, the next invocation re-triaged the whole queue
//     from scratch — work lost, dollars burnt.
//   - The required-field set the SSE consumer expects was implicit
//     (scattered across updateJob() patches). When a phase forgot to update
//     a field, the SSE silently rendered "0/0 pending" or undefined chips.
//
// Contract (preserved + hardened, NOT broken):
//   - Schema is { jobs: { [jobId]: { ...fields } } } — same as before. The
//     SSE consumer at dashboard-server.mjs::batchLive (line ~2625) reads
//     `ps.jobs[jobId].field`; do NOT flatten to top-level fields or that
//     downstream breaks.
//   - Writes are atomic: write to tmp.<pid>.<rand>, then rename. On macOS
//     APFS the rename is atomic per dirent — a concurrent reader sees either
//     the old file or the new file, never a half-written one.
//   - Required fields (REQUIRED_FIELDS export) — every state write must
//     populate ALL of them. Missing fields default to typed sentinels so
//     the SSE never sees undefined.
//
// Cross-references:
//   - AGENTS.md bug-class: state-write-without-disk-write (2026-05-27)
//   - AGENTS.md bug-class: process-orchestrator-without-resumable-state (new)
//   - AGENTS.md bug-class: state-file-without-schema-enforcement (new)
//   - dashboard-server.mjs::batchLive — the SSE consumer of this schema

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// The 11 fields the SSE consumer expects on every job record. If a phase
// forgets to provide one, writeProcessState() inserts a typed sentinel.
export const REQUIRED_FIELDS = [
  'job_id',
  'type',                // 'process-all' | 'batch-only' — filter key for SSE
  'status',              // 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  'phase',               // 'triage' | 'batch' | 'polish' | 'merge' | 'rebuild' | 'email' | 'done' | 'cancelled'
  'started_at',
  'finished_at',         // null while running; ISO on terminal
  'triage_advanced',
  'processed',
  'pending_before',
  'pending_after',
  'rounds_completed',
];

// Resume-state TTL: state files older than this are ignored. 24h matches
// the spec — beyond that, the queue may have meaningfully shifted (Mitchell
// added rows, sibling worker discarded rows), so a fresh triage is safer
// than blindly resuming.
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

// ── Pipeline state (the canonical {jobs: {jobId: {...}}} schema) ────────────

function loadStateRaw(statePath) {
  if (!existsSync(statePath)) return { jobs: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { jobs: {} };
    if (!parsed.jobs || typeof parsed.jobs !== 'object') parsed.jobs = {};
    return parsed;
  } catch {
    return { jobs: {} };
  }
}

function atomicWriteJson(targetPath, payload) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of orphan tmp; never throw cleanup errors over the
    // real write error.
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Write a single job's record to pipeline-process-state.json.
 * Preserves all OTHER jobs in the jobs map.
 *
 * @param {object} opts
 * @param {string} opts.statePath — absolute path to pipeline-process-state.json
 * @param {string} opts.jobId
 * @param {string} opts.type — 'process-all' | 'batch-only'
 * @param {string} opts.status — 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
 * @param {string} opts.phase — 'triage' | 'batch' | 'polish' | 'merge' | 'rebuild' | 'email' | 'done' | 'cancelled'
 * @param {string} opts.startedAt — ISO timestamp
 * @param {number} opts.startedAtMs — Date.now()-style milliseconds for elapsed calc
 * @param {object} opts.metrics — { triage_advanced?, processed?, pending_before?, pending_after?, rounds_completed?, last_batch_id?, last_batch_result? }
 * @param {number} opts.maxRounds — rounds_max for the run
 * @param {object} [opts.extraFields] — any additional fields to merge into the job record
 */
export function writeProcessState({
  statePath,
  jobId,
  type,
  status,
  phase,
  startedAt,
  startedAtMs,
  metrics = {},
  maxRounds,
  extraFields = {},
}) {
  if (!statePath) throw new Error('writeProcessState: statePath required');
  if (!jobId) throw new Error('writeProcessState: jobId required');
  if (!type) throw new Error('writeProcessState: type required');
  if (!status) throw new Error('writeProcessState: status required');
  if (!phase) throw new Error('writeProcessState: phase required');

  const isTerminal = status === 'completed' || status === 'cancelled' || status === 'failed';
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const state = loadStateRaw(statePath);
  const prior = state.jobs[jobId] || {};

  // Build the record. Required fields ALWAYS present with typed sentinels
  // (never undefined). Extra fields layer on top.
  const record = {
    ...prior,
    job_id: jobId,
    jobId,                  // legacy alias preserved (SSE consumer reads both shapes)
    type,
    status,
    phase,
    started_at: prior.started_at || startedAt || nowIso,
    finished_at: isTerminal ? (prior.finished_at || nowIso) : null,
    triage_advanced: metrics.triage_advanced != null ? metrics.triage_advanced : (prior.triage_advanced != null ? prior.triage_advanced : 0),
    processed: metrics.processed != null ? metrics.processed : (prior.processed != null ? prior.processed : 0),
    pending_before: metrics.pending_before != null ? metrics.pending_before : (prior.pending_before != null ? prior.pending_before : 0),
    pending_after: metrics.pending_after !== undefined ? metrics.pending_after : (prior.pending_after !== undefined ? prior.pending_after : null),
    rounds_completed: metrics.rounds_completed != null ? metrics.rounds_completed : (prior.rounds_completed != null ? prior.rounds_completed : 0),
    rounds_max: maxRounds != null ? maxRounds : (prior.rounds_max != null ? prior.rounds_max : null),
    wallclock_elapsed_ms: startedAtMs != null ? Math.max(0, nowMs - startedAtMs) : (prior.wallclock_elapsed_ms != null ? prior.wallclock_elapsed_ms : 0),
    last_event_at: nowIso,
    updated_at: nowIso,
    last_batch_id: metrics.last_batch_id != null ? metrics.last_batch_id : (prior.last_batch_id || null),
    last_batch_result: metrics.last_batch_result != null ? metrics.last_batch_result : (prior.last_batch_result || null),
    ...extraFields,
  };

  state.jobs[jobId] = record;
  atomicWriteJson(statePath, state);
  return record;
}

// ── Resume state (lib/process-all-resume-state.json) ────────────────────────

/**
 * Write the resume-state file on signal exit / crash. Atomic.
 *
 * @param {object} opts
 * @param {string} opts.resumePath
 * @param {string} opts.jobId
 * @param {string} opts.startedAt — original run's start ISO
 * @param {string} opts.phase — last completed phase (e.g. 'batch')
 * @param {number} opts.roundsCompleted — last fully-completed batch round
 * @param {number} opts.remainingUrlCount — pipeline.md [ ] count at abandonment
 * @param {string} opts.reason — 'sigterm' | 'sigint' | 'crash' | 'weekly-limit' | 'cancelled' | 'wallclock-cap' | 'error-rate-degraded'
 */
export function writeResumeState({
  resumePath,
  jobId,
  startedAt,
  phase,
  roundsCompleted,
  remainingUrlCount,
  reason,
}) {
  if (!resumePath) throw new Error('writeResumeState: resumePath required');
  const payload = {
    job_id: jobId,
    started_at: startedAt,
    abandoned_at: new Date().toISOString(),
    resume_from: {
      phase: phase || 'unknown',
      next_round: (roundsCompleted || 0) + 1,
      remaining_url_count: remainingUrlCount != null ? remainingUrlCount : null,
    },
    reason: reason || 'unknown',
  };
  atomicWriteJson(resumePath, payload);
  return payload;
}

/**
 * Read the resume-state file. Returns null if missing or malformed.
 */
export function readResumeState({ resumePath }) {
  if (!resumePath || !existsSync(resumePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(resumePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide whether the orchestrator should resume from prior state.
 *
 * Returns { resume: boolean, state: object|null, reason: string }
 *   - reason ∈ {'no-state', 'state-too-old', 'restart-flag', 'fresh-state'}
 */
export function shouldResume({ resumePath, restartFlag }) {
  if (restartFlag) {
    // Even if state exists, --restart wins. But we still report whether state
    // existed so the orchestrator can log "ignored prior resume-state."
    const state = readResumeState({ resumePath });
    return { resume: false, state, reason: 'restart-flag' };
  }
  const state = readResumeState({ resumePath });
  if (!state) return { resume: false, state: null, reason: 'no-state' };
  const abandonedTs = Date.parse(state.abandoned_at || '');
  if (!Number.isFinite(abandonedTs)) {
    return { resume: false, state, reason: 'state-malformed' };
  }
  const ageMs = Date.now() - abandonedTs;
  if (ageMs > RESUME_TTL_MS) {
    return { resume: false, state, reason: 'state-too-old' };
  }
  return { resume: true, state, reason: 'fresh-state' };
}

/**
 * Remove the resume-state file. Idempotent.
 */
export function clearResumeState({ resumePath }) {
  if (!resumePath) return;
  try { if (existsSync(resumePath)) unlinkSync(resumePath); }
  catch { /* idempotent — never throw */ }
}
