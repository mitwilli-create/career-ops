#!/usr/bin/env node
/**
 * scripts/process-all-pipeline.mjs — one-shot pipeline orchestrator.
 *
 * Chains the full intake-to-dashboard flow so the user can click ONE button
 * on the dashboard ("Process All Pipeline Items") and have everything land:
 *
 *   1. triage   → reads data/pipeline.md, scores via Haiku, advances to batch
 *   2. batch    → submits advanced items to Anthropic batch API, polls, reconciles
 *   3. rebuild  → regenerates dashboard/index.html
 *   4. email    → (optional) sends a heartbeat email summarizing what landed
 *
 * Writes state to data/pipeline-process-state.json so the dashboard can
 * poll /api/pipeline/process/status and show a progress bar.
 *
 * Usage:
 *   node scripts/process-all-pipeline.mjs                 # no email
 *   node scripts/process-all-pipeline.mjs --send-email    # email on completion
 *   node scripts/process-all-pipeline.mjs --dry-run       # report what would run, no API calls
 *   node scripts/process-all-pipeline.mjs --job-id=xxx    # use specific job ID (server pre-allocates)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
// 2026-05-29 — Spec data/spec-process-all-drain-and-visibility-2026-05-29.md.
// Atomic state-write + resume-state + batch-state-repair-sweep. Closes 6+
// session recurring ask about Process All not draining the queue.
import { writeProcessState, writeResumeState, shouldResume, clearResumeState } from '../lib/process-all-state.mjs';
import { runBatchStateRepairSweep } from '../lib/batch-state-repair-sweep.mjs';
// 2026-06-02 — bounded drain controller: chain triage→batch cycles until the
// pipeline drains to 0 or a governor trips. Pure + unit-tested.
import { runDrainLoop } from '../lib/process-all-drain-controller.mjs';

try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'data/pipeline-process-state.json');
// 2026-05-29 — resume-state path. Written on SIGTERM/SIGINT/crash; read on
// next invocation to skip already-completed phases. Cleared on success.
const RESUME_PATH = join(ROOT, 'data/process-all-resume-state.json');
const BATCHES_API_STATE = join(ROOT, 'batch/batches-api-state.json');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
// Captured at module-init so all phases share the same start-time anchor.
const STARTED_AT = new Date().toISOString();
const STARTED_AT_MS = Date.now();

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const idx = a.indexOf('=');
    return idx >= 0 ? [a.slice(2, idx), a.slice(idx + 1)] : [a.slice(2), true];
  })
);
const SEND_EMAIL = !!ARGS['send-email'];
const DRY_RUN = !!ARGS['dry-run'];
// 2026-05-26 — propagate cap-override into batch-runner-batches.mjs (per
// batch round). Before this fix, dashboard-server.mjs passed --cap-override
// here but phaseBatch dropped it when building batchArgs, so the deepest
// MONTHLY_BUDGET_USD guard ignored the dashboard's force-override checkbox.
// See AGENTS.md bug-class: force-override-not-propagated-to-internal-guard.
const CAP_OVERRIDE = !!ARGS['cap-override'];
// 2026-05-29 — Resume control. --restart forces fresh triage even if a
// resume-state file exists < 24h. --resume is informational (default behavior
// is to resume when state exists + fresh).
const RESTART_FLAG = !!ARGS['restart'];
const JOB_ID = ARGS['job-id'] || ('proc-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'));
const LOG_PATH = `/tmp/process-all-${JOB_ID}.log`;

// 2026-05-20 — Tier system overhaul. Three tiers selectable in the Process
// All cost modal; defaults to 1 (Standard). See lib/process-all-tiers.mjs
// for the canonical definitions + cost estimates.
//
//   1 Standard         Haiku triage + Sonnet eval
//   2 Premium Triage   Sonnet triage + Sonnet eval (matches legacy '5')
//   3 Premium Eval     Sonnet triage + Opus eval
//
// Independent of tier: post-eval auto-escalation. Every row scoring ≥4.0
// gets apply-pack pregen + polish — the system invests more in proven
// winners regardless of which tier the user picked.
const { resolveTier, PREGEN_FLOOR, POLISH_FLOOR } = await import('../lib/process-all-tiers.mjs');
const TIER_OBJ = resolveTier(ARGS.tier);
const TIER = String(TIER_OBJ.id);
const IS_TIER5 = TIER_OBJ.id >= 2;  // legacy alias — anything 2+ used to be "Tier-5"
// 2026-05-27 — Polish + pregen REMOVED from Process All orchestrator (Mitchell's
// directive: "polish should not be a part of the process all or run batch functions").
// Separation of concerns — Process All handles pipeline drainage (triage → batch →
// merge → rebuild → email); per-pack refinement (apply-pack pregen + polish) is
// manual-trigger only via /api/polish + /api/build-pack-stage + the row-drawer
// Polish/Build-Pack buttons. The functions phasePolish + phasePregen are deleted
// from main(); apply-pack-polish.mjs + scripts/build-apply-packs.mjs stay reachable
// as standalone scripts. See AGENTS.md bug-class: polish-no-timeout-causes-process-all-stall.
// PREGEN_FLOOR / POLISH_FLOOR imports remain only for backward-compat with any
// downstream consumer that imports this module's constants.
const HIGH_CONFIDENCE_PREGEN_FLOOR = parseFloat(process.env.HIGH_CONFIDENCE_PREGEN_FLOOR || String(PREGEN_FLOOR));
const POLISH_FLOOR_SCORE = parseFloat(process.env.POLISH_FLOOR_SCORE || String(POLISH_FLOOR));

// Optional company scope from the Process All Phase A modal. When present,
// passed through to triage.mjs and batch-runner-batches.mjs so both filter
// at their respective layers (forward funnel — both must respect the scope
// or work leaks through one side). Merge + rebuild operate on global output
// artifacts and are intentionally NOT scoped.
const COMPANIES_ARG = typeof ARGS.companies === 'string' && ARGS.companies.trim() ? ARGS.companies.trim() : '';
const SCOPED_ARGS = COMPANIES_ARG ? [`--companies=${COMPANIES_ARG}`] : [];

// ── State helpers ─────────────────────────────────────────────────────────
// 2026-05-29 — saveState is now atomic (tmp + rename) per state-write-without-
// disk-write bug class. Half-written JSON used to break SSE consumer + leave
// dashboard rendering undefined chips.
function loadState() {
  if (!existsSync(STATE_FILE)) return { jobs: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { jobs: {} }; }
}
function saveState(s) {
  if (!existsSync(dirname(STATE_FILE))) mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmpPath = `${STATE_FILE}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(s, null, 2));
    renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
// updateJob is the per-phase partial-patch helper. Each call atomically
// merges the patch onto the existing job record + preserves the type tag
// so SSE filters (which require type === 'process-all') always pass.
function updateJob(patch) {
  const s = loadState();
  const prior = s.jobs[JOB_ID] || {};
  s.jobs[JOB_ID] = {
    ...prior,
    jobId: JOB_ID,
    job_id: JOB_ID,
    type: prior.type || 'process-all',
    ...patch,
    updated_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    wallclock_elapsed_ms: Math.max(0, Date.now() - STARTED_AT_MS),
  };
  saveState(s);
}

// ε 2026-05-19 — Orphan state cleanup on startup. Previously
// pipeline-process-state.json grew unbounded (every job, every run, forever)
// AND any 'running' job from a crashed prior pipeline kept that job marked
// running indefinitely — confusing batchLive()'s "active job" detection.
// Strategy:
//   - Mark jobs status='running' or 'queued' with updated_at >2h ago as 'crashed'
//     so the next dashboard rebuild and batchLive() don't treat them as active.
//   - Prune any job (any status) with updated_at >7d ago. Audit trail lives in
//     /tmp/process-all-*.log (each job has its own log).
// Bounded by ORPHAN_AGE_HOURS + STATE_TTL_DAYS env vars for ops tuning.
const ORPHAN_AGE_HOURS = parseFloat(process.env.PIPELINE_STATE_ORPHAN_AGE_HOURS || '2');
const STATE_TTL_DAYS   = parseFloat(process.env.PIPELINE_STATE_TTL_DAYS         || '7');
function cleanupOrphanState() {
  const s = loadState();
  if (!s.jobs || typeof s.jobs !== 'object') return;
  const now = Date.now();
  let markedCrashed = 0;
  let pruned = 0;
  for (const [jid, j] of Object.entries(s.jobs)) {
    if (!j || typeof j !== 'object') { delete s.jobs[jid]; pruned++; continue; }
    const tsStr = j.updated_at || j.started_at;
    if (!tsStr) continue;
    const ts = Date.parse(tsStr);
    if (!Number.isFinite(ts)) continue;
    const ageHours = (now - ts) / (1000 * 60 * 60);
    // Mark stale running/queued as crashed
    if ((j.status === 'running' || j.status === 'queued') && ageHours > ORPHAN_AGE_HOURS) {
      s.jobs[jid] = { ...j, status: 'crashed', crashed_at: new Date().toISOString(), updated_at: new Date().toISOString(), crash_reason: `no update for ${ageHours.toFixed(1)}h (orphan-cleanup at ${new Date().toISOString()})` };
      markedCrashed++;
    }
    // Prune anything older than TTL
    if (ageHours > STATE_TTL_DAYS * 24) {
      delete s.jobs[jid];
      pruned++;
    }
  }
  if (markedCrashed || pruned) {
    saveState(s);
    log(`[cleanup] orphan-state pass: ${markedCrashed} marked crashed, ${pruned} pruned (TTL ${STATE_TTL_DAYS}d, orphan-age ${ORPHAN_AGE_HOURS}h)`);
  }
}

// Closure H (2026-05-22): NDJSON heartbeat. Fires every 30s during long
// operations so the hang-watchdog (scripts/agents/hang-watchdog.mjs) and
// the dashboard's stall-detection (Closure D) can see the orchestrator
// is alive even when a phase is mid-stream and not writing to LOG_PATH.
// Heartbeat lines go to stderr (separate channel from spawned child output)
// and are picked up by the launchd plist's StandardError redirect.
let _heartbeatTimer = null;
let _heartbeatCurrentPhase = 'init';
function _emitHeartbeat() {
  try {
    const beat = {
      t: new Date().toISOString(),
      jobId: typeof JOB_ID !== 'undefined' ? JOB_ID : null,
      phase: _heartbeatCurrentPhase,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      mem_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    process.stderr.write('[heartbeat] ' + JSON.stringify(beat) + '\n');
  } catch (_) { /* never break orchestrator on heartbeat error */ }
}
function _startHeartbeat() {
  if (_heartbeatTimer) return;
  _emitHeartbeat();
  _heartbeatTimer = setInterval(_emitHeartbeat, 30000);
  _heartbeatTimer.unref();
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}
function _setHeartbeatPhase(p) { _heartbeatCurrentPhase = String(p || 'unknown'); }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

// ── Run a child script, stream stdout into our log + state ────────────────
function runScript(name, args = [], env = {}) {
  return new Promise((resolve) => {
    log(`▶ ${name} ${args.join(' ')}`);
    const proc = spawn('node', [name, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outBytes = 0;
    proc.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      try { appendFileSync(LOG_PATH, chunk); } catch {}
    });
    proc.stderr.on('data', (chunk) => {
      try { appendFileSync(LOG_PATH, '[stderr] ' + chunk); } catch {}
    });
    proc.on('close', (code) => {
      log(`◀ ${name} exited ${code} (${outBytes} bytes stdout)`);
      resolve(code);
    });
  });
}


// ── Phase wrappers ────────────────────────────────────────────────────────
async function phaseTriage() {
  updateJob({ phase: 'triage', phase_started_at: new Date().toISOString(), tier: TIER });
  log(`━━━ Phase 1/4: TRIAGE ${IS_TIER5 ? '(TIER-5: Sonnet JD)' : '(Haiku)'} ━━━`);
  if (DRY_RUN) { log('(dry-run) skipping triage'); return { ok: true, advanced: 0 }; }
  // 2026-05-20 — Process All is gated by an explicit cost-confirmation
  // modal (Run Batch $25 / Process All $250 / Monthly $500). That user
  // consent IS the throughput governor; hidden caps below it break the
  // contract — the cost preview promises "drain the pipeline" but the
  // caps silently truncate.
  //
  // triage.mjs has TWO caps:
  //   --limit=N         per-session (default 50, the binding constraint)
  //   --daily-limit=N   cumulative daily (default 200)
  //
  // The original bug only overrode --daily-limit=300, leaving --limit at
  // its 50 default → each Process All run processed at most 50 URLs
  // regardless of confirmed cost. Now we override BOTH to effectively-
  // unlimited values (high enough to drain any realistic queue), letting
  // the modal's confirmed spend be the only governor.
  //
  // Mitchell can re-impose caps via:
  //   - PROCESS_ALL_TRIAGE_LIMIT env var (sets both --limit and
  //     --daily-limit to the same value), OR
  //   - triage_daily_limit in data/dashboard-settings.json (only used
  //     by the scheduled-launchd path, not Process All).
  //
  // Standalone `node triage.mjs --limit=N --daily-limit=M` still works
  // for ad-hoc capped runs outside Process All.
  const triageArgs = [...SCOPED_ARGS];
  const envCap = process.env.PROCESS_ALL_TRIAGE_LIMIT;
  const cap = envCap && /^\d+$/.test(envCap) ? parseInt(envCap, 10) : 100000;
  triageArgs.push(`--limit=${cap}`);
  triageArgs.push(`--daily-limit=${cap}`);
  log(envCap
    ? `  cap: --limit=${cap} --daily-limit=${cap} (from PROCESS_ALL_TRIAGE_LIMIT env)`
    : `  cap: --limit=${cap} --daily-limit=${cap} (effectively unlimited — per cost-confirmation contract)`);
  if (TIER_OBJ.triage_use_sonnet_jd) triageArgs.push('--use-sonnet-jd');

  // 2026-05-20 — Per-run telemetry. Capture pipeline size BEFORE triage so we
  // can detect cap-hits in post (if processed < pipeline_size_before AND cap
  // < pipeline_size_before, the cap bound the throughput). Surfaced via
  // pipeline-process-state.json + the dashboard Batch Status modal.
  let pipelineBefore = 0;
  try {
    const pipeText = readFileSync(join(ROOT, 'data/pipeline.md'), 'utf-8');
    pipelineBefore = pipeText.split('\n').filter(l => l.startsWith('- [ ]')).length;
  } catch {}
  updateJob({ triage_pipeline_before: pipelineBefore, triage_cap: cap });

  const code = await runScript('triage.mjs', triageArgs);
  // Parse triage's output for advanced + skipped + dead counts.
  let advanced = 0, skipped = 0, dead = 0;
  try {
    const logText = readFileSync(LOG_PATH, 'utf-8');
    const mA = logText.match(/Advanced:\s+(\d+)/);     if (mA) advanced = parseInt(mA[1], 10);
    const mS = logText.match(/Skipped:\s+(\d+)/);      if (mS) skipped  = parseInt(mS[1], 10);
    const mD = logText.match(/Dead:\s+(\d+)/);         if (mD) dead     = parseInt(mD[1], 10);
  } catch {}
  if (code !== 0) {
    log(`✗ triage failed (exit ${code})`);
    return { ok: false, advanced };
  }
  // Cap-hit detection: triage processed (advanced + skipped + dead) URLs;
  // if that equals the cap AND pipeline still has un-touched rows, the cap
  // was the binding constraint.
  const processed = advanced + skipped + dead;
  let pipelineAfter = 0;
  try {
    const pipeText = readFileSync(join(ROOT, 'data/pipeline.md'), 'utf-8');
    pipelineAfter = pipeText.split('\n').filter(l => l.startsWith('- [ ]')).length;
  } catch {}
  const capHit = processed >= cap && pipelineAfter > 0;
  const missed = capHit ? pipelineAfter : 0;
  log(`✓ triage complete — pipeline ${pipelineBefore} → ${pipelineAfter} · processed ${processed} (advanced=${advanced} skipped=${skipped} dead=${dead}) · cap=${cap}${capHit ? ` · ⚠ CAP HIT — ${missed} URL(s) missed this run` : ''}`);
  updateJob({
    triage_advanced: advanced,
    triage_skipped:  skipped,
    triage_dead:     dead,
    triage_processed: processed,
    triage_pipeline_after: pipelineAfter,
    triage_cap_hit:  capHit,
    triage_missed_this_run: missed,
  });
  return { ok: true, advanced, skipped, dead, processed, cap_hit: capHit, missed };
}

// 2026-05-19 cohesion fix (Mitchell postmortem) — count rows in the
// triage-advance queue so phaseBatch can loop until drained. Skips the
// header row. Returns 0 if the file doesn't exist.
function countTriageAdvanceRows() {
  const fp = join(ROOT, 'batch/triage-advance.tsv');
  if (!existsSync(fp)) return 0;
  const lines = readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('url\t'));
  return lines.length;
}

// 2026-05-29 — Inspect the most recent batch's error rate from
// batches-api-state.json. Returns a number in [0, 1] or null when the file
// is unreadable or contains no batches. Used by the 2-consecutive-100%-error
// early-abort guard in phaseBatch.
function _readMostRecentBatchErrorRate() {
  try {
    if (!existsSync(BATCHES_API_STATE)) return null;
    const s = JSON.parse(readFileSync(BATCHES_API_STATE, 'utf-8'));
    const field = s && s.batches != null ? s.batches : s;
    const list = Array.isArray(field) ? field : Object.values(field || {});
    if (list.length === 0) return null;
    const sorted = list
      .filter(b => b && typeof b === 'object')
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const last = sorted[sorted.length - 1];
    if (!last) return null;
    const c = last.request_counts || {};
    const total = (Number(c.succeeded) || 0) + (Number(c.errored) || 0) + (Number(c.expired) || 0);
    if (total === 0) return null;
    return ((Number(c.errored) || 0) + (Number(c.expired) || 0)) / total;
  } catch {
    return null;
  }
}

async function phaseBatch() {
  updateJob({ phase: 'batch', phase_started_at: new Date().toISOString() });
  log('━━━ Phase 2/4: BATCH EVAL ━━━');
  if (DRY_RUN) { log('(dry-run) skipping batch'); return { ok: true }; }

  // 2026-05-29 — MAX_ROUNDS ceiling raised 10 → 30 default, clamp [1, 100].
  // Realized per-batch sizes cluster at 73-179 (per CLAUDE.md Session Notes
  // 2026-05-27 audit), so 10 rounds capped throughput at 730-1790 URLs even
  // when all rounds succeeded. With error-rate spikes the effective drain
  // was much lower. 30 default lets a 3000-URL queue drain in one run.
  const MAX_ROUNDS = Math.max(1, Math.min(100, parseInt(process.env.PROCESS_ALL_MAX_BATCH_ROUNDS || '30', 10)));
  const PER_ROUND_LIMIT = Math.max(1, parseInt(process.env.PROCESS_ALL_BATCH_LIMIT || '1000', 10));
  // 2026-05-29 — wall-clock cap. Default 90 min, clamp [10 min, 6 hours].
  // Secondary to PER_RUN_CAP_PROCESS_ALL_USD ($1000) — wall-clock is a hung-
  // process safeguard, not a budget cap.
  const WALLCLOCK_CAP_MS = Math.max(10 * 60 * 1000, Math.min(6 * 60 * 60 * 1000,
    parseInt(process.env.PROCESS_ALL_MAX_WALLCLOCK_MS || String(90 * 60 * 1000), 10)));
  // 2026-05-29 — 2-consecutive-100%-error early abort. If two rounds in a
  // row produce error_rate >= 80%, abort with `aborted-batch-degraded` so
  // the SSE toast can surface "every batch is erroring — likely a vendor
  // deprecation; investigate."
  const ERROR_RATE_ABORT_THRESHOLD = 0.80;
  let consecutiveHighErrorRounds = 0;
  let round = 1;
  let totalDrained = 0;
  while (round <= MAX_ROUNDS) {
    // 2026-05-29 — wall-clock check at the top of every round so a hung
    // batch-runner can be bounded.
    const elapsedMs = Date.now() - STARTED_AT_MS;
    if (elapsedMs > WALLCLOCK_CAP_MS) {
      log(`  ⏰ wall-clock cap reached (${Math.round(elapsedMs/60000)}m > ${Math.round(WALLCLOCK_CAP_MS/60000)}m) — aborting`);
      updateJob({ batch_aborted_reason: 'wallclock-cap', batch_rounds_used: round - 1 });
      return { ok: true, aborted: 'wallclock-cap', rounds_used: round - 1, total_drained: totalDrained };
    }
    const beforeCount = countTriageAdvanceRows();
    if (beforeCount === 0) {
      log(`  batch queue empty (round ${round}) — drain complete`);
      break;
    }
    log(`━━━ Batch round ${round}/${MAX_ROUNDS} — ${beforeCount} items in queue · eval=${TIER_OBJ.eval_model} ━━━`);
    // 2026-05-20 — pass tier's eval model to batch-runner-batches.mjs
    // (which already accepts --model). Tier 1+2 use Sonnet (default);
    // Tier 3 uses Opus for the A-G report writing.
    // 2026-05-26 — forward --cap-override so batch-runner's internal
    // MONTHLY_BUDGET_USD guard respects the dashboard force-override checkbox.
    const batchArgs = ['run', `--limit=${PER_ROUND_LIMIT}`, `--model=${TIER_OBJ.eval_model}`, ...SCOPED_ARGS];
    if (CAP_OVERRIDE) batchArgs.push('--cap-override');
    const code = await runScript('batch-runner-batches.mjs', batchArgs);
    if (code !== 0) {
      log(`✗ batch round ${round} failed (exit ${code})`);
      return { ok: false };
    }
    const afterCount = countTriageAdvanceRows();
    const drainedThisRound = beforeCount - afterCount;
    totalDrained += drainedThisRound;
    log(`  round ${round}: ${beforeCount} → ${afterCount} (drained ${drainedThisRound})`);
    // 2026-05-29 — Persist rounds_completed on every round so the SSE shows
    // real-time progress. Also tracks the resume-from-round counter.
    updateJob({ rounds_completed: round, batch_items_drained_so_far: totalDrained });
    // 2026-05-29 — Error-rate early abort. Inspect the just-submitted batch's
    // request_counts in batches-api-state.json. If two consecutive rounds
    // both show >= 80% errors, abort — likely a vendor deprecation or
    // upstream auth issue, not a transient blip.
    const errorRateThisRound = _readMostRecentBatchErrorRate();
    if (errorRateThisRound != null && errorRateThisRound >= ERROR_RATE_ABORT_THRESHOLD) {
      consecutiveHighErrorRounds++;
      log(`  round ${round}: error-rate ${Math.round(errorRateThisRound * 100)}% (consecutive high-error rounds: ${consecutiveHighErrorRounds})`);
      if (consecutiveHighErrorRounds >= 2) {
        log(`  ⚠ 2 consecutive rounds with error-rate ≥ ${Math.round(ERROR_RATE_ABORT_THRESHOLD * 100)}% — aborting (likely vendor deprecation or auth issue; investigate batches-api-state.json)`);
        updateJob({ batch_aborted_reason: 'error-rate-degraded', batch_rounds_used: round });
        return { ok: true, aborted: 'error-rate-degraded', rounds_used: round, total_drained: totalDrained };
      }
    } else if (errorRateThisRound != null) {
      consecutiveHighErrorRounds = 0;
    }
    if (drainedThisRound <= 0) {
      log(`  round ${round}: no drain detected — breaking (queue may be stuck behind expired postings or company-scope filter)`);
      break;
    }
    round++;
  }
  log(`✓ batch eval complete — ${totalDrained} item(s) drained across ${round - 1} round(s)`);
  updateJob({ batch_rounds_used: round - 1, batch_items_drained: totalDrained });
  // β Run-Batch eval 2026-05-19: persist published_count so the sidebar's
  // 5-stage Publish bar can render a real ratio (was hard-coded 0/0 because
  // dashboard-server.mjs:batchLive() reads activeJob.published_count and no
  // upstream phase ever set it). "Published" = items that finished with a
  // score ≥ THRESHOLD_FOR_PUBLISH (4.0 — matches buildPipelinePreview).
  // Soft-fail on parse error: we'd rather log 0 than crash the whole orchestrator.
  try {
    const PUBLISH_THRESHOLD = parseFloat(process.env.THRESHOLD_FOR_PUBLISH || '4.0');
    const statePath = join(ROOT, 'batch/batch-state.tsv');
    let publishedCount = 0;
    if (existsSync(statePath)) {
      const lines = readFileSync(statePath, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('id'));
      for (const l of lines) {
        const cols = l.split('\t');
        const status = cols[2];
        const score = parseFloat(cols[6] || '0');
        if (status === 'completed' && !Number.isNaN(score) && score >= PUBLISH_THRESHOLD) {
          publishedCount++;
        }
      }
    }
    updateJob({ published_count: publishedCount });
    log(`  published_count: ${publishedCount} (score ≥ ${PUBLISH_THRESHOLD})`);
  } catch (err) {
    log(`  ⚠ could not compute published_count: ${err.message} — defaulting to 0`);
    updateJob({ published_count: 0 });
  }
  return { ok: true };
}

// 2026-05-27 — phasePolish REMOVED from Process All orchestrator (Mitchell's
// directive). Polish remains reachable as a manual surface via:
//   - POST /api/polish (dashboard-server.mjs)
//   - scripts/agents/apply-pack-polish.mjs (CLI standalone)
//   - Row drawer "Polish" button (per-pack on-demand)
// Architecture rationale: pack refinement (polish) and pipeline drainage
// (Process All) change for different reasons; coupling them caused stalls.
// See AGENTS.md bug-class: polish-no-timeout-causes-process-all-stall.

async function phaseMergeTracker() {
  updateJob({ phase: 'merge', phase_started_at: new Date().toISOString() });
  log('━━━ Phase 2.5/4: MERGE TRACKER ━━━');
  if (DRY_RUN) { log('(dry-run) skipping merge-tracker'); return { ok: true }; }
  const code = await runScript('merge-tracker.mjs');
  if (code !== 0) {
    log(`✗ merge-tracker failed (exit ${code})`);
    return { ok: false };
  }
  log('✓ tracker merged');
  return { ok: true };
}

// 2026-05-27 — phasePregen REMOVED from Process All orchestrator (Mitchell's
// directive). Apply-pack pregen remains reachable as a manual surface via:
//   - POST /api/build-pack-stage (dashboard-server.mjs)
//   - scripts/build-apply-packs.mjs (CLI standalone)
//   - Row drawer "Build Pack" button (per-pack on-demand)
// Pregen also stops being the auto-trigger for Council/Researcher/Dealbreaker
// agents — those now only fire when invoked from a user-initiated pack build.

async function phaseRebuild() {
  updateJob({ phase: 'rebuild', phase_started_at: new Date().toISOString() });
  log('━━━ Phase 3/4: DASHBOARD REBUILD ━━━');
  if (DRY_RUN) { log('(dry-run) skipping rebuild'); return { ok: true }; }
  const code = await runScript('scripts/build-dashboard.mjs');
  if (code !== 0) {
    log(`✗ rebuild failed (exit ${code})`);
    return { ok: false };
  }
  log('✓ dashboard rebuilt');
  return { ok: true };
}

async function phaseEmail() {
  if (!SEND_EMAIL) {
    log('━━━ Phase 4/4: EMAIL ━━━ (skipped — no --send-email flag)');
    return { ok: true, skipped: true };
  }
  updateJob({ phase: 'email', phase_started_at: new Date().toISOString() });
  log('━━━ Phase 4/4: HEARTBEAT EMAIL ━━━');
  if (DRY_RUN) { log('(dry-run) skipping email'); return { ok: true }; }
  const code = await runScript('scripts/heartbeat.mjs', ['--send']);
  if (code !== 0) {
    log(`✗ heartbeat email failed (exit ${code})`);
    return { ok: false };
  }
  log('✓ heartbeat email sent');
  return { ok: true };
}

// ── Main orchestration ────────────────────────────────────────────────────
function countPendingPipeline() {
  const fp = join(ROOT, 'data/pipeline.md');
  if (!existsSync(fp)) return 0;
  return readFileSync(fp, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

async function main() {
  // ε 2026-05-19 — run orphan-state cleanup BEFORE registering ourselves so
  // we don't accidentally mark our own brand-new row as crashed.
  try { cleanupOrphanState(); } catch (err) { log(`[cleanup] error (non-fatal): ${err.message}`); }

  // 2026-05-29 — Resume-state detection. If a fresh (< 24h) resume-state
  // file exists AND --restart was not passed, log the resume state.
  // Kill switch: PROCESS_ALL_DISABLE_RESUME=true forces fresh runs.
  const _disableResume = String(process.env.PROCESS_ALL_DISABLE_RESUME || '').toLowerCase() === 'true';
  let resumeDecision = null;
  if (!DRY_RUN && !_disableResume) {
    try {
      resumeDecision = shouldResume({ resumePath: RESUME_PATH, restartFlag: RESTART_FLAG });
      if (resumeDecision.resume) {
        const rf = resumeDecision.state.resume_from || {};
        log(`▶ RESUMING from prior abandoned run ${resumeDecision.state.job_id} — ${rf.phase}, next_round=${rf.next_round}, remaining=${rf.remaining_url_count}`);
        log(`  abandoned_at: ${resumeDecision.state.abandoned_at} · reason: ${resumeDecision.state.reason}`);
      } else if (resumeDecision.state) {
        log(`(resume-state present but skipping: ${resumeDecision.reason})`);
      }
    } catch (err) {
      log(`[resume] error (non-fatal): ${err.message}`);
    }
  }

  // 2026-05-29 — Batch-state-repair-sweep. Re-marks pipeline.md URLs as [x]
  // when their batch is in terminal-error or terminal-expired state. Closes
  // the loop from PR #308 (markPipelineUrl-on-terminal-error) for batches
  // that predate the fix. Idempotent; safe to run on every Process All start.
  // Kill switch: PROCESS_ALL_DISABLE_REPAIR_SWEEP=true skips.
  const _disableSweep = String(process.env.PROCESS_ALL_DISABLE_REPAIR_SWEEP || '').toLowerCase() === 'true';
  if (!DRY_RUN && !_disableSweep) {
    try {
      const sweep = runBatchStateRepairSweep({
        pipelinePath: PIPELINE_PATH,
        statePath: BATCHES_API_STATE,
      });
      if (sweep.ok) {
        log(`✓ batch-state-repair-sweep: marked ${sweep.marked} URLs from ${sweep.batchesScanned} batches scanned`);
      } else {
        log(`⚠ batch-state-repair-sweep: ${sweep.error} (non-fatal — continuing)`);
      }
    } catch (err) {
      log(`[sweep] error (non-fatal): ${err.message}`);
    }
  }

  const pendingBefore = countPendingPipeline();
  // 2026-05-29 — Tag type='process-all' explicitly so SSE filters surface
  // this run even when invoked directly from CLI / launchd (server-spawn
  // pre-writes this; CLI invocation didn't until now).
  updateJob({
    type:            'process-all',
    status:          'running',
    started_at:      STARTED_AT,
    pending_before:  pendingBefore,
    triage_advanced: 0,
    processed:       0,
    pending_after:   null,
    rounds_completed: 0,
    send_email:      SEND_EMAIL,
    dry_run:         DRY_RUN,
    log_path:        LOG_PATH,
  });

  // 2026-05-29 — Signal handlers. Write resume-state on SIGTERM/SIGINT so a
  // killed run is resumable.
  const _onSignalAbandon = (signalName) => {
    try {
      const remaining = countPendingPipeline();
      writeResumeState({
        resumePath: RESUME_PATH,
        jobId: JOB_ID,
        startedAt: STARTED_AT,
        phase: _heartbeatCurrentPhase,
        roundsCompleted: 0,
        remainingUrlCount: remaining,
        reason: signalName === 'SIGINT' ? 'sigint' : 'sigterm',
      });
      updateJob({ status: 'cancelled', cancelled_at: new Date().toISOString(), phase: 'cancelled', cancel_reason: signalName });
      log(`  signal ${signalName} — wrote resume-state at ${RESUME_PATH}; pipeline.md has ${remaining} remaining URLs`);
    } catch (err) {
      log(`[signal] error writing resume-state: ${err.message}`);
    }
    process.exitCode = 130;
  };
  process.on('SIGTERM', () => _onSignalAbandon('SIGTERM'));
  process.on('SIGINT',  () => _onSignalAbandon('SIGINT'));
  log(`Process-all-pipeline job ${JOB_ID} starting`);
  log(`  pending items before: ${pendingBefore}`);
  log(`  send_email: ${SEND_EMAIL}`);
  log(`  dry_run: ${DRY_RUN}`);
  log(`  company scope: ${COMPANIES_ARG || '(none — full drain)'}`);

  // Closure H (2026-05-22): NDJSON heartbeat for stall detection.
  _setHeartbeatPhase('triage');
  _startHeartbeat();
  process.on('exit', _stopHeartbeat);

  const phases = {};
  // ── Bounded drain controller (2026-06-02) ───────────────────────────────
  // Chain triage→batch cycles, re-verifying pipeline depth after EACH cycle,
  // until the queue drains to 0 (drained-to-zero) OR a full cycle makes no
  // progress (no-progress: residual is undrainable — dead postings, hard-
  // disqualified, or a triage skip-without-mark gap) OR a governor trips
  // (max-cycles / wall-clock / a phaseBatch self-abort). Makes "Process All
  // chains batches until the queue reaches 0" an explicit, auto-verified
  // contract instead of a single triage→batch pass.
  //
  // NOT an uncapped loop-until-exactly-0: "exactly 0" is the GOAL, reached
  // when reachable. The queue routinely contains URLs that can never drain
  // (dead postings, terminal-errored/expired batches) plus continuous scanner
  // ingress, so the no-progress + cycle + wall-clock guards prevent the
  // infinite re-batch loop the 179-stuck-URL incident produced (CLAUDE.md
  // Session Notes 2026-05-27/29). Safe because batch-runner-batches.mjs polls
  // each batch to terminal state, marks pipeline.md, and dequeues triage-
  // advance.tsv BEFORE returning — so a later cycle never re-submits an
  // in-flight URL.
  const MAX_DRAIN_CYCLES = Math.max(1, Math.min(50,
    parseInt(process.env.PROCESS_ALL_MAX_DRAIN_CYCLES || '12', 10)));
  // Shared 90-min wall-clock anchor with phaseBatch (both off STARTED_AT_MS),
  // so the whole run — every cycle combined — is wall-clock-bounded.
  const DRAIN_WALLCLOCK_CAP_MS = Math.max(10 * 60 * 1000, Math.min(6 * 60 * 60 * 1000,
    parseInt(process.env.PROCESS_ALL_MAX_WALLCLOCK_MS || String(90 * 60 * 1000), 10)));
  // Loop logic + every termination branch live in (unit-tested)
  // lib/process-all-drain-controller.mjs. main() supplies the side-effectful
  // wiring: phaseTriage + phaseBatch per cycle, with the hard-failure exits.
  const _drain = await runDrainLoop({
    countPending: countPendingPipeline,
    maxCycles: MAX_DRAIN_CYCLES,
    wallclockCapMs: DRAIN_WALLCLOCK_CAP_MS,
    startedAtMs: STARTED_AT_MS,
    log,
    runCycle: async (cycle) => {
      _setHeartbeatPhase('triage');
      phases.triage = await phaseTriage();
      if (!phases.triage.ok) {
        updateJob({ status: 'failed', failed_at: new Date().toISOString(), failure_phase: 'triage', drain_cycles_completed: cycle });
        process.exit(2);
      }
      _setHeartbeatPhase('batch');
      phases.batch = await phaseBatch();
      if (!phases.batch.ok) {
        updateJob({ status: 'failed', failed_at: new Date().toISOString(), failure_phase: 'batch', drain_cycles_completed: cycle });
        process.exit(2);
      }
      // Real-time SSE progress (full cycle_log is returned + persisted once below).
      updateJob({ drain_cycles_completed: cycle, pending_current: countPendingPipeline() });
      return { ok: true, aborted: phases.batch.aborted || null };
    },
  });
  const drainReason = _drain.reason;
  const drainCycle = _drain.cyclesRun;
  const drainCycleLog = _drain.cycleLog;
  const _pendingAtDrainEnd = countPendingPipeline();
  updateJob({ drain_reason: drainReason, drain_cycles_used: drainCycle, drain_cycle_log: drainCycleLog, pending_after_drain: _pendingAtDrainEnd });
  log(`✓ drain controller halted: ${drainReason} — ${drainCycle} cycle(s) run, ${_pendingAtDrainEnd} pending remaining`);
  // 2026-05-27 — phasePolish + phasePregen removed from Process All orchestrator
  // per Mitchell's directive (separation of concerns: pipeline drainage vs
  // pack refinement). Polish stays reachable via /api/polish + row-drawer
  // Polish button; pregen via /api/build-pack-stage + Build Pack button.
  // See AGENTS.md bug-class: polish-no-timeout-causes-process-all-stall.
  _setHeartbeatPhase('merge');
  phases.merge   = await phaseMergeTracker();
  if (!phases.merge.ok) {
    // Non-fatal — tracker merge failure shouldn't block rebuild
    log('⚠️  merge-tracker failed but continuing to rebuild');
  }
  _setHeartbeatPhase('rebuild');
  phases.rebuild = await phaseRebuild();
  if (!phases.rebuild.ok) {
    updateJob({ status: 'failed', failed_at: new Date().toISOString(), failure_phase: 'rebuild' });
    process.exit(2);
  }
  _setHeartbeatPhase('email');
  phases.email   = await phaseEmail();
  // email failure is non-fatal — the work IS done; only the notification didn't go out

  const pendingAfter = countPendingPipeline();
  const processed = Math.max(0, pendingBefore - pendingAfter);

  // γ GAMMA 2026-05-19 truth-audit: persist published_count so the SSE
  // batchLive stream renders the publish stage correctly. Before this fix the
  // publish stage always showed `0/0` even when items were promoted. Derive
  // from apply-now-queue.json (post-rebuild) by counting `Evaluated` entries
  // with score ≥ THRESHOLD_FOR_PUBLISH (4.0).
  let publishedCount = null;
  try {
    const apqPath = join(ROOT, 'data/apply-now-queue.json');
    if (existsSync(apqPath)) {
      const apq = JSON.parse(readFileSync(apqPath, 'utf-8'));
      publishedCount = (apq.ranked || []).filter(r =>
        r && (r.score >= 4.0 || parseFloat(r.score) >= 4.0)
      ).length;
    }
  } catch (_) { /* leave null — renderer falls back to ✓ */ }

  // ── Guard 2 (2026-06-01): no-op detection ──────────────────────────────────
  // A run that found pending items but processed/drained NONE did no work despite
  // a non-empty queue (parser-format drift, gate misconfig, or all candidates
  // already triaged). Mark it `completed_no_op` so the dashboard renders an amber
  // warning instead of a green ✓ that lies. Closes the "completed · drained 0"
  // silent-failure class (303 HN-format items, 2026-06-01).
  const _triageProcessed = (phases.triage && phases.triage.processed) || 0;
  const _didNoWork = pendingBefore > 0 && processed === 0 && _triageProcessed === 0;
  const _warnings = [];
  if (_didNoWork) {
    _warnings.push(
      `No-op: ${pendingBefore} item(s) were pending but 0 were processed and 0 drained. ` +
      `Likely un-parseable lines in data/pipeline.md (run: node scripts/backfill-hn-pipeline-format.mjs --apply) ` +
      `or all remaining items were already triaged.`
    );
    log(`⚠ NO-OP DETECTED — ${_warnings[0]}`);
  }
  // ── Drain-residual surfacing (2026-06-02) ──────────────────────────────────
  // The bounded drain controller halts at 0 (clean) OR on a residual it could
  // not drain. Surface a non-clean stop as a warning so the run reads as
  // "drained N, M remain (reason)" instead of a green ✓ that hides the residual.
  // 'drained-to-zero' / 'already-empty' are the only clean stops.
  const _drainClean = (drainReason === 'drained-to-zero' || drainReason === 'already-empty');
  if (!_drainClean && pendingAfter > 0 && !_didNoWork) {
    const reasonHelp = {
      'no-progress':   'a full triage+batch cycle drained 0 — the residual is undrainable this run (dead postings, hard-disqualified roles, terminal-errored/expired batches, or a triage skip-without-mark gap).',
      'max-cycles':    'hit PROCESS_ALL_MAX_DRAIN_CYCLES — raise it (or re-run) to keep draining a very large queue.',
      'wallclock-cap': 'hit the wall-clock cap — re-run (Process All resumes) to continue draining.',
    }[drainReason] || (drainReason.startsWith('batch-')
      ? `phaseBatch self-aborted (${drainReason.slice(6)}) — investigate batch/batches-api-state.json.`
      : drainReason);
    _warnings.push(
      `Partial drain: ${processed} item(s) drained across ${drainCycle} cycle(s); ${pendingAfter} still pending (stop reason: ${drainReason}). ${reasonHelp}`
    );
    log(`⚠ PARTIAL DRAIN — ${_warnings[_warnings.length - 1]}`);
  }
  updateJob({
    status:           _didNoWork ? 'completed_no_op' : 'completed',
    no_op:            _didNoWork,
    warnings:         _warnings,
    finished_at:      new Date().toISOString(),
    pending_after:    pendingAfter,
    processed,
    published_count:  publishedCount,
    drain_reason:     drainReason,
    drain_cycles_used: drainCycle,
    drain_cycle_log:  drainCycleLog,
    partial_drain:    !_drainClean && pendingAfter > 0,
    phases,
    phase:            'done',
  });
  // 2026-05-29 — On successful completion, clear any prior resume-state so
  // the next invocation starts fresh.
  try { clearResumeState({ resumePath: RESUME_PATH }); } catch {}
  log(`${_didNoWork ? '⚠ Done (NO-OP)' : '✓ Done'}. Processed ${processed} items (${pendingBefore} → ${pendingAfter}). Published: ${publishedCount == null ? 'unknown' : publishedCount}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  updateJob({ status: 'failed', failed_at: new Date().toISOString(), error: err.message });
  process.exit(2);
});
