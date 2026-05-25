/**
 * lib/drawer-auto-enrich.mjs — Drawer auto-enrich dispatcher + job tracking
 *
 * PR-03 of the apply-now UX overhaul (2026-05-25). Spec:
 *   .claude/audit/apply-now-ux-audit-2026-05-25/strategy.md §4 (R13-R20)
 *   .claude/audit/apply-now-ux-audit-2026-05-25/strategy-adjudicated.md
 *
 * Replaces the legacy "run script X" CLI-hint strings in the drawer with a
 * single generic auto-spawn dispatch primitive. Per the adjudicated strategy
 * (Tradeoff 1 BROKEN — HOLD), a generic endpoint is preferred over per-slot
 * endpoints to bound endpoint sprawl + concentrate budget gating + per-row+slot
 * lock management in one place.
 *
 * Design (Mitchell-locked):
 *   - Per-row+slot lock at data/drawer-jobs/locks/<rowId>-<slot>.lock (5-min TTL)
 *   - Job state at data/drawer-jobs/<job_id>.json (24h TTL)
 *   - Per-call estimate > $1 requires `confirmed_at` (cost-confirmation contract)
 *   - Daily cap: $50 across all dispatch (counts against V2_BUDGET_USD)
 *   - Slot dispatch table — adding a slot is one line; removing is `delete table.<slot>`
 *
 * Slot → generator dispatch:
 *   hm-intel             → scripts/agents/intel-refresh.mjs --slots hm-intel --rows <N>
 *   interview-likelihood → scripts/agents/interview-likelihood.mjs --row <N>
 *   hm-chance            → scripts/agents/hm-chance.mjs --row <N>
 *   team-health          → scripts/agents/intel-refresh.mjs --slots team-health --rows <N>
 *                          (PR-04, 2026-05-25: routed to corpus-grounded synth)
 *   context-note         → degraded-useful path (cv.md + article-digest stub)
 *
 * Cross-fork-leak safety: this module does NOT inline-quote any sensitive paths.
 * Lock files are gitignored (data/drawer-jobs/ is added to .gitignore by PR-03).
 *
 * Hang prevention: spawn uses detached + unref + AbortSignal pattern. The
 * EventSource endpoint in dashboard-server.mjs has its own keepalive heartbeat
 * + auto-close on cache-write or 5min timeout per CLAUDE.md hang-prevention.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const JOBS_DIR = join(DATA_DIR, 'drawer-jobs');
const LOCKS_DIR = join(JOBS_DIR, 'locks');

// ─────────────────────────────────────────────────────────────────────────────
// Constants — env-overridable
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 5 * 60 * 1000;          // 5 minutes
const JOB_TTL_MS = 24 * 60 * 60 * 1000;     // 24 hours
const DAILY_CAP_USD = Math.min(
  500,
  Math.max(1, Number(process.env.DRAWER_AUTO_ENRICH_DAILY_USD) || 50),
);
const COST_CONFIRMATION_THRESHOLD_USD = 1.0;
const PER_CALL_HARD_CAP_USD = 5.0;

// Per-slot cost estimates (in USD). Used both for surfacing in CTAs +
// for the cost-confirmation gate.
// PR-08 (2026-05-25) — added 'strategy-ceiling' slot to back the inline
// "Retry now (~$1)" button on the degraded strategy popout.
export const SLOT_COST_ESTIMATES = Object.freeze({
  'hm-intel': 0.50,
  'interview-likelihood': 1.20,
  'hm-chance': 0.80,
  'team-health': 0.30,
  'context-note': 0.05,
  'strategy-ceiling': 1.00,
});

// Per-slot ETA (in seconds). Surfaced in the skeleton-state UI as "Agent
// working — refresh in ~N min".
export const SLOT_ETA_SECONDS = Object.freeze({
  'hm-intel': 300,                 // ~5 min (intel-refresh single-slot)
  'interview-likelihood': 120,     // ~2 min (council research)
  'hm-chance': 90,                 // ~1.5 min (council research)
  'team-health': 60,               // ~1 min (corpus synthesis, PR-04)
  'context-note': 10,              // ~10 sec (degraded fallback path)
  'strategy-ceiling': 90,          // ~1.5 min (Sonnet 4.6 grounded synthesis)
});

// Per-slot cache file location. EventSource endpoint polls this path for
// the "cache_written" event.
export function slotCachePath(rowId, slot, slug) {
  // Caches are slug-keyed, not row-id-keyed. Caller must resolve slug.
  if (slot === 'context-note') return join(DATA_DIR, 'context-notes', `${rowId}.json`);
  if (slot === 'strategy-ceiling') {
    // strategy-ceiling cache is keyed by cache-key (metric+rowId), not by
    // slug. Each retry attempt regenerates a fresh entry — the SSE just
    // signals 'completed' from the job-state file. Return null so the SSE
    // doesn't try to mtime-watch a non-existent path.
    return null;
  }
  if (!slug) return null;
  if (slot === 'hm-intel') return join(DATA_DIR, 'hm-intel', `${slug}.json`);
  if (slot === 'interview-likelihood') return join(DATA_DIR, 'interview-likelihood', `${slug}.json`);
  if (slot === 'hm-chance') return join(DATA_DIR, 'hm-chance', `${slug}.json`);
  if (slot === 'team-health') return join(DATA_DIR, 'team-health', `${slug}.json`);
  return null;
}

// Slot → generator command. Returns null if the slot is deferred (e.g.
// team-health pending PR-04).
function slotDispatchCommand(rowId, slot) {
  if (slot === 'hm-intel') {
    return {
      cmd: 'node',
      args: [join(REPO_ROOT, 'scripts/agents/intel-refresh.mjs'), '--slots', 'hm-intel', '--row', String(rowId)],
    };
  }
  if (slot === 'interview-likelihood') {
    return {
      cmd: 'node',
      args: [join(REPO_ROOT, 'scripts/agents/interview-likelihood.mjs'), '--row', String(rowId)],
    };
  }
  if (slot === 'hm-chance') {
    return {
      cmd: 'node',
      args: [join(REPO_ROOT, 'scripts/agents/hm-chance.mjs'), '--row', String(rowId)],
    };
  }
  if (slot === 'team-health') {
    // PR-04 (2026-05-25): route through intel-refresh.mjs which now wires
    // team-health to lib/team-health-synthesis.mjs (corpus-grounded). The
    // intel-refresh entry point also handles slug resolution from the
    // apply-now-queue.json by row number.
    return {
      cmd: 'node',
      args: [join(REPO_ROOT, 'scripts/agents/intel-refresh.mjs'), '--slots', 'team-health', '--row', String(rowId)],
    };
  }
  if (slot === 'context-note') {
    // PR-08 (2026-05-25): context-note degraded-useful path now ships in
    // lib/context-note-fallback.mjs (read by the /api/context-note endpoint
    // directly). This dispatcher path is unused on the typical flow — the
    // endpoint serves fallback content synchronously. Retained for any
    // future surface that needs cache pre-warming.
    return {
      cmd: 'node',
      args: ['-e', 'process.exit(0);'],
      synthetic: true,
    };
  }
  if (slot === 'strategy-ceiling') {
    // PR-08 (2026-05-25): "Retry now" button on the degraded strategy popout.
    // The actual strategy-ceiling regenerate is triggered by the drawer's
    // next refetch (cache wasn't written on the degraded path). For the
    // retry-counter side-effect we use a synthetic no-op dispatch — the
    // increment happens in the endpoint, not in the spawned subprocess.
    // Real regeneration is just the next /api/drill/percentage call.
    return {
      cmd: 'node',
      args: ['-e', 'process.exit(0);'],
      synthetic: true,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File-system helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [DATA_DIR, JOBS_DIR, LOCKS_DIR]) {
    if (!existsSync(d)) {
      try { mkdirSync(d, { recursive: true }); } catch {}
    }
  }
}

function lockPath(rowId, slot) {
  return join(LOCKS_DIR, `${rowId}-${slot}.lock`);
}

function jobPath(jobId) {
  return join(JOBS_DIR, `${jobId}.json`);
}

// Returns { exists, expired, job_id } for an existing lock file.
function readLock(rowId, slot) {
  const p = lockPath(rowId, slot);
  if (!existsSync(p)) return { exists: false, expired: false, job_id: null };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const ageMs = Date.now() - Date.parse(raw.created_at || 0);
    const expired = ageMs > LOCK_TTL_MS;
    return { exists: true, expired, job_id: raw.job_id || null, raw };
  } catch {
    // Malformed lock — treat as expired.
    return { exists: true, expired: true, job_id: null };
  }
}

function writeLock(rowId, slot, jobId) {
  const p = lockPath(rowId, slot);
  const payload = {
    rowId,
    slot,
    job_id: jobId,
    created_at: new Date().toISOString(),
  };
  try { writeFileSync(p, JSON.stringify(payload, null, 2)); } catch {}
}

function releaseLock(rowId, slot) {
  const p = lockPath(rowId, slot);
  try { if (existsSync(p)) unlinkSync(p); } catch {}
}

// Returns the daily spend total for drawer-auto-enrich dispatches. Read
// from data/drawer-auto-enrich-spend-<YYYY-MM-DD>.json.
function todayPtDate() {
  const pt = new Date(Date.now() - 7 * 60 * 60 * 1000); // PDT
  return pt.toISOString().slice(0, 10);
}

function spendFilePath(dateStr) {
  return join(DATA_DIR, `drawer-auto-enrich-spend-${dateStr}.json`);
}

function readTodaySpend() {
  const p = spendFilePath(todayPtDate());
  if (!existsSync(p)) return 0;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return Number(j.total_usd) || 0;
  } catch { return 0; }
}

function recordSpend(usd) {
  ensureDirs();
  const today = todayPtDate();
  const p = spendFilePath(today);
  const current = readTodaySpend();
  const next = { date: today, total_usd: current + Number(usd || 0), last_updated: new Date().toISOString() };
  try { writeFileSync(p, JSON.stringify(next, null, 2)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate input parameters. Returns { ok, error } shape.
 */
export function validateDispatchInput({ rowId, slot, confirmed_at }) {
  if (!rowId || !/^[0-9]+$/.test(String(rowId))) {
    return { ok: false, error: 'rowId required (positive integer)' };
  }
  if (!slot || !SLOT_COST_ESTIMATES.hasOwnProperty(slot)) {
    return { ok: false, error: `slot required (one of: ${Object.keys(SLOT_COST_ESTIMATES).join(', ')})` };
  }
  const estCost = SLOT_COST_ESTIMATES[slot];
  if (estCost > COST_CONFIRMATION_THRESHOLD_USD && !confirmed_at) {
    return {
      ok: false,
      error: `estimated $${estCost.toFixed(2)} exceeds cost-confirmation threshold $${COST_CONFIRMATION_THRESHOLD_USD.toFixed(2)} — confirmed_at required`,
      requires_confirmation: true,
      est_cost_usd: estCost,
    };
  }
  if (estCost > PER_CALL_HARD_CAP_USD) {
    return {
      ok: false,
      error: `estimated $${estCost.toFixed(2)} exceeds per-call hard cap $${PER_CALL_HARD_CAP_USD.toFixed(2)}`,
      est_cost_usd: estCost,
    };
  }
  return { ok: true, est_cost_usd: estCost };
}

/**
 * Check daily cap. Returns { ok, spent, remaining }.
 */
export function checkDailyCap({ estimatedNextCall = 0 } = {}) {
  const spent = readTodaySpend();
  const remaining = DAILY_CAP_USD - spent;
  const ok = remaining >= estimatedNextCall;
  return { ok, spent, remaining, cap: DAILY_CAP_USD };
}

/**
 * Dispatch an auto-enrich job. Returns:
 *   { ok, job_id, eta_seconds, est_cost_usd, state, cache_path?, ... }
 *
 * State values:
 *   'queued'      — job spawned, work begins
 *   'in_flight'   — existing lock found, returns existing job_id
 *   'deferred'    — slot not yet implemented (e.g. team-health)
 *   'complete'    — cache file already exists + is fresh (no dispatch needed)
 *   'error'       — validation, cap, or spawn failure
 */
export async function dispatchAutoEnrich({ rowId, slot, confirmed_at, slug = null, force = false } = {}) {
  ensureDirs();

  // 1) Validate
  const v = validateDispatchInput({ rowId, slot, confirmed_at });
  if (!v.ok) {
    return {
      ok: false,
      state: 'error',
      error: v.error,
      requires_confirmation: !!v.requires_confirmation,
      est_cost_usd: v.est_cost_usd || SLOT_COST_ESTIMATES[slot] || 0,
    };
  }

  // 2) Daily cap check
  const cap = checkDailyCap({ estimatedNextCall: v.est_cost_usd });
  if (!cap.ok) {
    return {
      ok: false,
      state: 'error',
      error: `daily auto-enrich cap reached ($${cap.spent.toFixed(2)} / $${cap.cap.toFixed(2)})`,
      est_cost_usd: v.est_cost_usd,
      daily_cap_reached: true,
    };
  }

  // 3) Per-row+slot lock — second concurrent dispatch returns existing job
  const lock = readLock(rowId, slot);
  if (lock.exists && !lock.expired && lock.job_id && !force) {
    return {
      ok: true,
      state: 'in_flight',
      job_id: lock.job_id,
      eta_seconds: SLOT_ETA_SECONDS[slot],
      est_cost_usd: v.est_cost_usd,
      cache_path: slotCachePath(rowId, slot, slug),
      message: 'job already in flight (lock held)',
    };
  }

  // 4) Slot dispatch
  const dispatchCmd = slotDispatchCommand(rowId, slot);
  if (!dispatchCmd) {
    // Currently only team-health falls through (PR-04 deferred)
    return {
      ok: true,
      state: 'deferred',
      slot,
      rowId,
      reason: slot === 'team-health'
        ? 'Team-health synthesis queued behind PR-04 ship'
        : `slot "${slot}" not yet implemented`,
      est_cost_usd: v.est_cost_usd,
    };
  }

  // 5) Generate job_id, write lock + job state
  const jobId = `enrich-${slot}-r${rowId}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const cachePath = slotCachePath(rowId, slot, slug);
  const logPath = `/tmp/drawer-auto-enrich-${jobId}.log`;

  const jobState = {
    job_id: jobId,
    rowId,
    slot,
    slug,
    state: 'queued',
    cache_path: cachePath,
    log_path: logPath,
    est_cost_usd: v.est_cost_usd,
    eta_seconds: SLOT_ETA_SECONDS[slot],
    created_at: new Date().toISOString(),
    cache_existed_at_start: cachePath ? existsSync(cachePath) : false,
    cache_mtime_at_start: (cachePath && existsSync(cachePath))
      ? statSync(cachePath).mtimeMs
      : null,
  };
  try { writeFileSync(jobPath(jobId), JSON.stringify(jobState, null, 2)); } catch {}
  writeLock(rowId, slot, jobId);

  // 6) Spawn detached subprocess (synthetic dispatch is no-op + immediate cleanup)
  if (dispatchCmd.synthetic) {
    // For context-note degraded path until PR-08 ships the real agent
    setImmediate(() => {
      try {
        const stub = {
          source: 'degraded-fallback',
          reason: 'context-note agent not yet built (PR-08); using corpus-stub',
          generated_at: new Date().toISOString(),
        };
        const cp = slotCachePath(rowId, slot, slug);
        if (cp) {
          try { mkdirSync(dirname(cp), { recursive: true }); } catch {}
          writeFileSync(cp, JSON.stringify(stub, null, 2));
        }
      } catch {}
      releaseLock(rowId, slot);
      // Update job state
      try {
        const cur = JSON.parse(readFileSync(jobPath(jobId), 'utf-8'));
        cur.state = 'complete';
        cur.completed_at = new Date().toISOString();
        writeFileSync(jobPath(jobId), JSON.stringify(cur, null, 2));
      } catch {}
    });
    return {
      ok: true,
      state: 'queued',
      job_id: jobId,
      slot,
      rowId,
      eta_seconds: SLOT_ETA_SECONDS[slot],
      est_cost_usd: v.est_cost_usd,
      cache_path: cachePath,
    };
  }

  // Real subprocess
  try {
    const proc = spawn(dispatchCmd.cmd, dispatchCmd.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Best-effort: capture stdout/stderr to log file
    proc.stdout?.on('data', c => {
      try {
        const { appendFileSync } = require('node:fs');
        appendFileSync(logPath, c);
      } catch {}
    });
    proc.stderr?.on('data', c => {
      try {
        const { appendFileSync } = require('node:fs');
        appendFileSync(logPath, '[stderr] ' + c);
      } catch {}
    });

    proc.on('exit', (code) => {
      // Update job state + release lock
      try {
        const cur = JSON.parse(readFileSync(jobPath(jobId), 'utf-8'));
        cur.state = code === 0 ? 'complete' : 'error';
        cur.exit_code = code;
        cur.completed_at = new Date().toISOString();
        if (code !== 0) cur.error = `process exited ${code}`;
        writeFileSync(jobPath(jobId), JSON.stringify(cur, null, 2));
      } catch {}
      // Record spend (best-effort)
      if (code === 0) recordSpend(v.est_cost_usd);
      releaseLock(rowId, slot);
    });

    proc.on('error', (err) => {
      try {
        const cur = JSON.parse(readFileSync(jobPath(jobId), 'utf-8'));
        cur.state = 'error';
        cur.error = err.message || String(err);
        cur.completed_at = new Date().toISOString();
        writeFileSync(jobPath(jobId), JSON.stringify(cur, null, 2));
      } catch {}
      releaseLock(rowId, slot);
    });

    proc.unref();
  } catch (err) {
    releaseLock(rowId, slot);
    return {
      ok: false,
      state: 'error',
      error: 'spawn failed: ' + (err.message || String(err)),
      est_cost_usd: v.est_cost_usd,
    };
  }

  return {
    ok: true,
    state: 'queued',
    job_id: jobId,
    slot,
    rowId,
    eta_seconds: SLOT_ETA_SECONDS[slot],
    est_cost_usd: v.est_cost_usd,
    cache_path: cachePath,
  };
}

/**
 * Read job state by job_id. Returns null if not found or expired.
 */
export function readJobState(jobId) {
  if (!jobId || !/^[A-Za-z0-9._-]+$/.test(jobId)) return null;
  const p = jobPath(jobId);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    const ageMs = Date.now() - Date.parse(j.created_at || 0);
    if (ageMs > JOB_TTL_MS) return null;
    return j;
  } catch { return null; }
}

/**
 * Clear expired locks + jobs. Called opportunistically from dispatcher
 * or via periodic sweep.
 */
export function sweepExpired() {
  ensureDirs();
  let cleared = 0;
  // Locks
  try {
    for (const f of readdirSync(LOCKS_DIR)) {
      const p = join(LOCKS_DIR, f);
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        const ageMs = Date.now() - Date.parse(raw.created_at || 0);
        if (ageMs > LOCK_TTL_MS) {
          unlinkSync(p);
          cleared++;
        }
      } catch { /* malformed — leave */ }
    }
  } catch {}
  // Jobs
  try {
    for (const f of readdirSync(JOBS_DIR)) {
      if (f === 'locks') continue;
      const p = join(JOBS_DIR, f);
      try {
        const stat = statSync(p);
        if (!stat.isFile()) continue;
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        const ageMs = Date.now() - Date.parse(raw.created_at || 0);
        if (ageMs > JOB_TTL_MS) {
          unlinkSync(p);
          cleared++;
        }
      } catch { /* malformed — leave */ }
    }
  } catch {}
  return { cleared };
}
