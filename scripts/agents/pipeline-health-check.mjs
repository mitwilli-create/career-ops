#!/usr/bin/env node
/**
 * scripts/agents/pipeline-health-check.mjs
 *
 * Periodically asserts that:
 *   1. Sidebar badge numbers MATCH the underlying files (pipeline.md +
 *      triage-advance.tsv). Drift = bug.
 *   2. batch-state.tsv has no rows with status='in-progress' AND
 *      started_at > STUCK_THRESHOLD_HOURS old. Those are real batch-worker
 *      hangs that need investigation.
 *   3. triage-advance.tsv queue is informational ONLY. Rows sitting in the
 *      queue are waiting for the next scheduled batch fire (08:05 PT and
 *      12:00 PT) — NOT stuck. We only flag the queue as STALE if the file
 *      mtime is older than QUEUE_STALE_HOURS, indicating the batch may
 *      have stopped firing entirely.
 *   4. The dashboard-server is reachable (200 on /api/stats).
 *   5. No more than one Process All / Run Batch orchestrator is alive at once.
 *
 * Outputs data/pipeline-health.json (machine-readable) — read by the
 * dashboard's "System healthy" chip + the /api/pipeline/health-status endpoint.
 *
 * Exit 0 if healthy. Exit 1 if drift detected (launchd doesn't care; the JSON
 * IS the signal). The script never raises an alarm itself — it just records
 * truth. The dashboard surfaces what it finds.
 *
 * Designed to run every 5 min via launchd
 * (com.mitchell.career-ops.pipeline-health.plist).
 *
 * 2026-05-20: Refactored to distinguish "queue waiting" (normal) from
 * "worker stuck" (alarm). The original mtime-only check was flagging the
 * daily-batch waiting queue as stuck — a false positive that drowned the
 * real worker-hang signal.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRunRecord } from '../../lib/job-runs-ledger.mjs';

const __jobRun = installRunRecord('pipeline-health');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const HEALTH_FILE = join(ROOT, 'data', 'pipeline-health.json');

const STUCK_THRESHOLD_HOURS = parseFloat(process.env.PIPELINE_HEALTH_STUCK_THRESHOLD_HOURS || '2');
const QUEUE_STALE_THRESHOLD_HOURS = parseFloat(process.env.PIPELINE_HEALTH_QUEUE_STALE_HOURS || '20');
const DASHBOARD_URL = process.env.DASHBOARD_HEALTH_URL || 'http://localhost:3097';
// Max concurrent orchestrators considered healthy. Default 1; raise via
// PIPELINE_HEALTH_MAX_ORCHESTRATORS=2 (or higher) when sibling Claude Code
// sessions routinely overlap. Pre-2026-05-29 the threshold was hardcoded to 1
// which surfaced as a flapping plist whenever 2 sessions ran in parallel.
const MAX_ORCHESTRATORS = Math.max(1, parseInt(process.env.PIPELINE_HEALTH_MAX_ORCHESTRATORS || '1', 10));

function countPipelinePending() {
  const fp = join(ROOT, 'data/pipeline.md');
  if (!existsSync(fp)) return 0;
  return readFileSync(fp, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

function countTriageAdvanceRows() {
  const fp = join(ROOT, 'batch/triage-advance.tsv');
  if (!existsSync(fp)) return 0;
  return readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('url\t')).length;
}

function getTriageAdvanceMtime() {
  const fp = join(ROOT, 'batch/triage-advance.tsv');
  if (!existsSync(fp)) return null;
  try { return statSync(fp).mtime.toISOString(); } catch { return null; }
}

function readBatchState() {
  const fp = join(ROOT, 'batch/batch-state.tsv');
  if (!existsSync(fp)) return [];
  const text = readFileSync(fp, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('id\t'));
  return lines.map(l => {
    const cols = l.split('\t');
    return {
      id: cols[0],
      url: cols[1],
      status: cols[2],
      started_at: cols[3],
      completed_at: cols[4],
      report_num: cols[5],
      score: cols[6],
      error: cols[7],
      retries: cols[8],
    };
  });
}

function findStuckInProgress(thresholdHours) {
  const now = Date.now();
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  return readBatchState().filter(row => {
    if (row.status !== 'in-progress') return false;
    if (!row.started_at) return false;
    const startedMs = Date.parse(row.started_at);
    if (!Number.isFinite(startedMs)) return false;
    return (now - startedMs) > thresholdMs;
  });
}

async function checkApiBadge() {
  // Use Node's native fetch (v18+); fall back to undefined if HTTP fails.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${DASHBOARD_URL}/api/pipeline/preview`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return {
      ok: true,
      pending_pipeline: data.pending_pipeline,
      queued_for_batch: data.queued_for_batch,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function findOrchestratorPids() {
  try {
    const out = execSync('ps -ef | grep -E "process-all-pipeline|batch-runner-batches" | grep -v grep', {
      encoding: 'utf-8',
    });
    const pids = out.trim().split('\n').filter(Boolean).map(l => parseInt(l.split(/\s+/)[1], 10)).filter(Number.isFinite);
    return pids;
  } catch { return []; }
}

async function main() {
  const checks = {};

  // 1. File-level counts
  const filePending = countPipelinePending();
  const fileQueued = countTriageAdvanceRows();
  checks.file_counts = {
    pending_pipeline: filePending,
    queued_for_batch: fileQueued,
    total: filePending + fileQueued,
  };

  // 2. API-level counts
  const api = await checkApiBadge();
  checks.api = api;
  if (api.ok) {
    const driftPending = api.pending_pipeline !== filePending;
    const driftQueued  = api.queued_for_batch !== fileQueued;
    checks.drift = {
      pending_pipeline: driftPending ? { file: filePending, api: api.pending_pipeline } : null,
      queued_for_batch: driftQueued  ? { file: fileQueued,  api: api.queued_for_batch  } : null,
      drift_detected: driftPending || driftQueued,
    };
  } else {
    checks.drift = { drift_detected: null, api_unreachable: true };
  }

  // 3. REAL stuck detection — batch-state.tsv has rows with status='in-progress'
  //    AND started_at > STUCK_THRESHOLD_HOURS ago. These are worker hangs that
  //    need investigation; either a process crashed without writing 'completed'
  //    or 'failed', or the batch worker is genuinely hung mid-eval.
  const stuckInFlight = findStuckInProgress(STUCK_THRESHOLD_HOURS);
  checks.in_flight = {
    stuck_count: stuckInFlight.length,
    stuck_rows: stuckInFlight.map(r => ({
      id: r.id,
      url: r.url,
      started_at: r.started_at,
      age_hours: ((Date.now() - new Date(r.started_at).getTime()) / (1000 * 60 * 60)).toFixed(2),
    })),
    threshold_hours: STUCK_THRESHOLD_HOURS,
  };

  // 4. triage-advance queue depth — INFORMATIONAL only. Rows wait for the next
  //    scheduled batch fire (08:05 PT + 12:00 PT). Only flag as STALE if the
  //    file's mtime is older than QUEUE_STALE_THRESHOLD_HOURS, indicating the
  //    batch has stopped firing entirely (e.g., launchd job unloaded).
  const queueMtime = getTriageAdvanceMtime();
  let queueAgeHours = null;
  if (queueMtime) {
    queueAgeHours = (Date.now() - new Date(queueMtime).getTime()) / (1000 * 60 * 60);
  }
  checks.triage_queue = {
    mtime: queueMtime,
    age_hours: queueAgeHours,
    rows_queued: fileQueued,
    stale: (fileQueued > 0 && queueAgeHours != null && queueAgeHours > QUEUE_STALE_THRESHOLD_HOURS),
    stale_threshold_hours: QUEUE_STALE_THRESHOLD_HOURS,
  };

  // 5. Orchestrator process check — flag if more than 1 alive (race condition)
  const pids = findOrchestratorPids();
  checks.orchestrator_pids = pids;
  checks.orchestrator_warning = pids.length > MAX_ORCHESTRATORS
    ? `${pids.length} orchestrator processes alive (expected 0..${MAX_ORCHESTRATORS})`
    : null;

  // 6. Roll up to a single "healthy" flag
  const healthy =
    !checks.drift?.drift_detected &&
    checks.in_flight.stuck_count === 0 &&
    !checks.triage_queue.stale &&
    !checks.orchestrator_warning &&
    api.ok;

  const result = {
    checked_at: new Date().toISOString(),
    healthy,
    checks,
    summary: healthy
      ? 'all checks pass'
      : [
          checks.drift?.drift_detected ? 'badge↔file drift' : null,
          checks.in_flight.stuck_count > 0 ? `${checks.in_flight.stuck_count} batch worker(s) stuck > ${STUCK_THRESHOLD_HOURS}h` : null,
          checks.triage_queue.stale ? `triage queue stale > ${QUEUE_STALE_THRESHOLD_HOURS}h (${fileQueued} rows waiting on batch)` : null,
          checks.orchestrator_warning,
          !api.ok ? 'dashboard-server unreachable' : null,
        ].filter(Boolean).join(' · '),
  };

  writeFileSync(HEALTH_FILE, JSON.stringify(result, null, 2));
  // Compact stderr log so launchd's StandardOutPath stays small
  console.error(`[pipeline-health] ${result.healthy ? '✓' : '✗'} ${result.summary}`);

  // Always exit 0 — the JSON file is the signal (see top-of-file comment).
  // Pre-2026-05-29 this exited 1 on !healthy, which launchd misclassified as
  // a runtime crash, surfacing the plist as flapping for normal data-signal
  // states. The dashboard reads pipeline-health.json directly; launchd
  // success/failure is irrelevant to the health-detection contract.
  process.exit(0);
}

main().catch(err => {
  console.error('[pipeline-health] FATAL:', err);
  process.exit(2);
});
