#!/usr/bin/env node
// scripts/repair-pipeline-process-state.mjs
//
// One-time deterministic backfill. Reads batches-api-state.json + pipeline.md
// + applications.md to reconstruct what the last Process All run accomplished,
// then writes a synthetic job record into pipeline-process-state.json so the
// dashboard SSE has SOMETHING to surface immediately after deploy — before
// the next live Process All run.
//
// No LLM calls. No network. Pure file inspection + heuristic reconstruction.
//
// Usage:
//   node scripts/repair-pipeline-process-state.mjs           # write
//   node scripts/repair-pipeline-process-state.mjs --dry-run # report only
//
// Spec: data/spec-process-all-drain-and-visibility-2026-05-29.md § 6

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ARGS = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => a.includes('=') ? a.slice(2).split('=') : [a.slice(2), true]));
const DRY_RUN = !!ARGS['dry-run'];

const STATE_FILE      = join(ROOT, 'data/pipeline-process-state.json');
const BATCHES_API     = join(ROOT, 'batch/batches-api-state.json');
const BATCH_STATE_TSV = join(ROOT, 'batch/batch-state.tsv');
const PIPELINE_MD     = join(ROOT, 'data/pipeline.md');

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return fallback; }
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  try { writeFileSync(tmp, content); renameSync(tmp, path); }
  catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
}

function countPendingPipeline() {
  if (!existsSync(PIPELINE_MD)) return 0;
  // Match the orchestrator's countPendingPipeline contract — pipeline lines
  // start with `- [ ] ` but the URL can appear anywhere in the line (after a
  // company name + prose summary). Don't anchor on `https?://` immediately.
  return readFileSync(PIPELINE_MD, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

function reconstructLastRun() {
  const batches = readJson(BATCHES_API, { batches: [] });
  const list = Array.isArray(batches.batches) ? batches.batches
              : (batches.batches && typeof batches.batches === 'object') ? Object.values(batches.batches)
              : Array.isArray(batches) ? batches : [];

  // Find the most-recent batch by created_at
  const sorted = list
    .filter(b => b && typeof b === 'object')
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const lastBatch = sorted[sorted.length - 1] || null;

  // Estimate totals across recent batches (last 7 days from this batch's
  // ended_at; if no date, fall back to last 5 batches)
  const recent = sorted.slice(-5);
  let succeeded = 0, errored = 0, expired = 0;
  for (const b of recent) {
    const c = b.request_counts || {};
    succeeded += Number(c.succeeded) || 0;
    errored   += Number(c.errored)   || 0;
    expired   += Number(c.expired)   || 0;
  }

  const lastBatchId = lastBatch ? (lastBatch.id || lastBatch.batch_id) : null;
  const lastBatchStartedAt = lastBatch ? (lastBatch.created_at || null) : null;
  const lastBatchEndedAt = lastBatch ? (lastBatch.ended_at || lastBatch.created_at || null) : null;

  return {
    lastBatchId,
    lastBatchStartedAt,
    lastBatchEndedAt,
    succeeded,
    errored,
    expired,
    batchesScanned: recent.length,
  };
}

function main() {
  console.log('[repair-pipeline-process-state] starting');
  if (DRY_RUN) console.log('  --dry-run: will report only, no writes');

  const pendingNow = countPendingPipeline();
  const reconstructed = reconstructLastRun();
  console.log(`  pipeline pending now: ${pendingNow}`);
  console.log(`  most-recent batch: ${reconstructed.lastBatchId || '(none)'}`);
  if (reconstructed.lastBatchStartedAt) {
    console.log(`    started_at: ${reconstructed.lastBatchStartedAt}`);
    console.log(`    ended_at:   ${reconstructed.lastBatchEndedAt}`);
  }
  console.log(`  recent batches (${reconstructed.batchesScanned}): succeeded=${reconstructed.succeeded} errored=${reconstructed.errored} expired=${reconstructed.expired}`);

  // Synthesize a job record describing what we can reconstruct.
  const synthId = `proc-repair-${Date.now().toString(36)}`;
  const startedAt = reconstructed.lastBatchStartedAt || new Date().toISOString();
  const finishedAt = reconstructed.lastBatchEndedAt || new Date().toISOString();
  const processed = reconstructed.succeeded;
  const errored = reconstructed.errored;
  const totalUrls = reconstructed.succeeded + reconstructed.errored + reconstructed.expired;

  const synthRecord = {
    job_id: synthId,
    jobId: synthId,
    type: 'process-all',
    status: 'completed',
    phase: 'done',
    started_at: startedAt,
    finished_at: finishedAt,
    triage_advanced: totalUrls,
    processed,
    pending_before: pendingNow + processed,  // best-effort reconstruction
    pending_after: pendingNow,
    rounds_completed: reconstructed.batchesScanned,
    rounds_max: 30,
    wallclock_elapsed_ms: 0,  // unknown for reconstructed run
    last_event_at: finishedAt,
    updated_at: new Date().toISOString(),
    last_batch_id: reconstructed.lastBatchId,
    last_batch_result: {
      succeeded: reconstructed.succeeded,
      errored: reconstructed.errored,
      expired: reconstructed.expired,
    },
    repair_synthetic: true,
    repair_note: 'Reconstructed by repair-pipeline-process-state.mjs from batches-api-state.json + pipeline.md',
  };

  const state = readJson(STATE_FILE, { jobs: {} });
  state.jobs[synthId] = synthRecord;

  if (DRY_RUN) {
    console.log('');
    console.log('[dry-run] would write the following job record:');
    console.log(JSON.stringify(synthRecord, null, 2));
    return 0;
  }

  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('');
  console.log(`✓ wrote synthetic job ${synthId} to ${STATE_FILE}`);
  console.log(`  type=process-all status=completed phase=done`);
  console.log(`  triage_advanced=${totalUrls} processed=${processed} pending_before=${synthRecord.pending_before} pending_after=${pendingNow}`);
  return 0;
}

process.exit(main());
