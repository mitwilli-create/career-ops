#!/usr/bin/env node
/**
 * scripts/rebuild-apply-now-queue.mjs — keep apply-now-queue.json in sync
 * with applications.md without overwriting Mitchell's curated factor data.
 *
 * Why: data/apply-now-queue.json is the input to refresh-master's tier
 * classifier (lib/refresh-priority.mjs::classifyAllRows). New rows that
 * land in applications.md and pass the apply-now filter (score ≥4.0 AND
 * status in Evaluated|Responded) need to enter the queue so refresh-master
 * actually enriches them. Without this, the Health column will drift back
 * to "—" the next time Mitchell adds a 4+ row that isn't in the curated
 * queue.
 *
 * What it preserves:
 *   - All existing ranked[] entries (composite, factors, equity_stage,
 *     tactical_lead, notes_summary). Mitchell-curated wisdom, never
 *     overwritten.
 *   - All metadata fields (methodology, delta_from_prior_run, etc.).
 *
 * What it updates:
 *   - status field on rows whose status changed in applications.md
 *     (e.g. Evaluated → Discarded). Adds a `_dropped: true` marker if
 *     the row is no longer in the apply-now filter, so the classifier
 *     can demote it to Tier D without breaking ranks for other rows.
 *   - generated_at + reference_date.
 *
 * What it adds:
 *   - One new ranked[] entry per applications.md apply-now row not in
 *     the queue. New entries get rank=N+1..N+M appended (no resort of
 *     existing rows), default factors{tier:'C'}, and tactical_lead/
 *     notes_summary derived from applications.md.
 *
 * Usage:
 *   node scripts/rebuild-apply-now-queue.mjs               # write + log diff
 *   node scripts/rebuild-apply-now-queue.mjs --dry-run     # log only, no write
 *
 * Exit codes:
 *   0 — success (writes or dry-runs cleanly)
 *   2 — runtime error
 *
 * Designed to be invoked by refresh-master.mjs BEFORE classifyAllRows()
 * runs, OR on a daily launchd schedule paired with the dashboard build.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateRow } from '../lib/apply-now-queue-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUEUE_PATH = join(ROOT, 'data', 'apply-now-queue.json');
const APPS_PATH = join(ROOT, 'data', 'applications.md');
const LIVENESS_PATH = join(ROOT, 'data', 'liveness-state.json');

const DRY_RUN = process.argv.includes('--dry-run');

function loadLivenessState() {
  try { return JSON.parse(readFileSync(LIVENESS_PATH, 'utf-8')); }
  catch { return { rows: {} }; }
}

function annotateGate(row, ctx) {
  const verdict = gateRow(row, ctx);
  row._gate_bucket = verdict.bucket;
  row._gate_pass = verdict.pass;
  row._gate_reasons = verdict.reasons;
  row._gate_missing_repositories = verdict.missing_repositories;
  row._gate_checked_at = new Date().toISOString();
  return verdict;
}

async function main() {
  if (!existsSync(QUEUE_PATH)) {
    console.error(`ERROR: ${QUEUE_PATH} not found`);
    process.exit(2);
  }
  if (!existsSync(APPS_PATH)) {
    console.error(`ERROR: ${APPS_PATH} not found`);
    process.exit(2);
  }

  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
  const ranked = Array.isArray(queue.ranked) ? queue.ranked : [];
  const { parseApplicationsFile } = await import('../lib/parse-applications.mjs');
  const apps = parseApplicationsFile(APPS_PATH);
  const applyNow = apps.filter(r => r.score >= 4.0 && /^(evaluated|responded)$/i.test(r.status));

  // Index existing queue rows by num (string)
  const queueByNum = new Map(ranked.map(r => [String(r.num), r]));
  const appsByNum = new Map(apps.map(a => [String(a.num), a]));

  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    queueRowsBefore: ranked.length,
    addedFromApps: 0,
    statusUpdates: 0,
    droppedFromApplyNow: 0,
    inSyncRows: 0,
    gate_pass: 0,
    gate_auto_enrich: 0,
    gate_remove: 0,
  };
  const log = [];
  const gateCtx = { livenessState: loadLivenessState() };

  // Pass 1: update status on existing queue rows from applications.md
  for (const qrow of ranked) {
    const app = appsByNum.get(String(qrow.num));
    if (!app) {
      // Row exists in queue but not in applications.md — leave alone, but flag.
      log.push(`  ⚠ queue rank ${qrow.rank} (#${qrow.num} ${qrow.company} — ${qrow.role.slice(0, 40)}) not found in applications.md`);
      continue;
    }
    const prevStatus = qrow.status;
    if (prevStatus !== app.status) {
      qrow.status = app.status;
      stats.statusUpdates++;
      log.push(`  ↻ rank ${qrow.rank} (#${qrow.num} ${qrow.company}): ${prevStatus} → ${app.status}`);
    }
    // Mark as dropped if no longer in apply-now filter
    const stillEligible = app.score >= 4.0 && /^(evaluated|responded)$/i.test(app.status);
    if (!stillEligible && !qrow._dropped) {
      qrow._dropped = true;
      qrow._dropped_at = today;
      qrow._dropped_reason = `status=${app.status}, score=${app.score}`;
      stats.droppedFromApplyNow++;
      log.push(`  ↓ rank ${qrow.rank} (#${qrow.num} ${qrow.company}): dropped from apply-now filter (${qrow._dropped_reason})`);
    }
    if (stillEligible && qrow._dropped) {
      // Row recovered (e.g. status flipped back from Discarded to Evaluated)
      delete qrow._dropped;
      delete qrow._dropped_at;
      delete qrow._dropped_reason;
      log.push(`  ↑ rank ${qrow.rank} (#${qrow.num} ${qrow.company}): recovered into apply-now filter`);
    }
    if (prevStatus === app.status && stillEligible) stats.inSyncRows++;

    // Strict gate annotation (does not drop the row — informational + actionable downstream)
    if (!qrow._dropped) {
      const enriched = { ...qrow, url: qrow.url || app.url || '', canonical_url: qrow.canonical_url || app.canonical_url || '' };
      const verdict = annotateGate(qrow, gateCtx);
      // Mirror enriched URL fields back to qrow for downstream consumers without overwriting curated data
      if (!qrow.url && app.url) qrow.url = app.url;
      if (verdict.bucket === 'PASS') stats.gate_pass++;
      else if (verdict.bucket === 'AUTO_ENRICH') stats.gate_auto_enrich++;
      else if (verdict.bucket === 'REMOVE') stats.gate_remove++;
    }
  }

  // Pass 2: add applications.md apply-now rows not in queue
  const maxExistingRank = ranked.reduce((m, r) => Math.max(m, Number(r.rank) || 0), 0);
  let nextRank = maxExistingRank + 1;
  for (const arow of applyNow) {
    if (queueByNum.has(String(arow.num))) continue;
    const synthComposite = Math.round(arow.score * 17); // 4.0 → 68, 4.7 → 80
    const tierBucket = arow.score >= 4.5 ? 'A2' : arow.score >= 4.2 ? 'B' : 'C';
    const newRow = {
      rank: nextRank++,
      composite: synthComposite,
      num: String(arow.num),
      company: arow.company,
      role: arow.role,
      eval_score: arow.score,
      eval_date: arow.date,
      status: arow.status,
      report: arow.reportPath ? `[${String(arow.num)}](${arow.reportPath})` : '',
      factors: {
        base_fit: 15,
        equity_upside: 0,
        equity_stage: 'unknown — set after manual review',
        freshness: 20,
        eval_age_days: Math.max(0, Math.round((Date.now() - Date.parse(arow.date)) / 86400000)),
        tier_match: 10,
        tier: tierBucket,
      },
      too_late_flag: false,
      tactical_lead: 'AUTO-ADDED by rebuild-apply-now-queue.mjs — manual curation pending (factors{} are defaults).',
      notes_summary: (arow.notes || '').slice(0, 280),
      _auto_added: true,
      _auto_added_at: today,
    };
    // Run strict gate on the new candidate (annotation only — still added to queue
    // so refresh-master + auto-enrich workflow can act on AUTO_ENRICH rows)
    newRow.url = arow.url || '';
    const verdict = annotateGate(newRow, gateCtx);
    if (verdict.bucket === 'PASS') stats.gate_pass++;
    else if (verdict.bucket === 'AUTO_ENRICH') stats.gate_auto_enrich++;
    else if (verdict.bucket === 'REMOVE') stats.gate_remove++;

    ranked.push(newRow);
    stats.addedFromApps++;
    log.push(`  + rank ${newRow.rank} (#${arow.num} ${arow.company} — ${arow.role.slice(0, 40)}): score=${arow.score} status=${arow.status} gate=${verdict.bucket}`);
  }

  // Pass 3 — pre-flight collision gate (L3 of 2026-05-27 dedupe-defense PR).
  // Detect (normalized-company × variant-safe role × LIVE-status) collisions
  // in the final ranked[] BEFORE writing the queue. The queue is the public
  // surface — dupes here mean the dashboard apply-now widget shows the same
  // role 2+ times. WARN by default; ABORT (exit 3) if QUEUE_DEDUPE_STRICT=true.
  // Variant-safe roleEqual is inlined here to keep the queue rebuild a
  // single-file script with zero new module imports — the comma-qualifier
  // guard logic is identical to merge-tracker.mjs::roleFuzzyMatch fast-path
  // and dedup-tracker.mjs::roleMatch (all three agree on what's a dupe).
  const QUEUE_DEDUPE_STRICT = process.env.QUEUE_DEDUPE_STRICT === 'true';
  const QUEUE_LIVE_RE = /^(evaluated|responded|applied|interview|offer)$/i;
  const normCompany = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const variantSafeRoleEqual = (a, b) => {
    const normA = String(a || '').trim().toLowerCase();
    const normB = String(b || '').trim().toLowerCase();
    if (normA === normB) return true;
    const hasCommaA = normA.includes(',');
    const hasCommaB = normB.includes(',');
    if (hasCommaA || hasCommaB) {
      if (hasCommaA !== hasCommaB) return false;
      const qualA = normA.split(',').slice(1).join(',').trim();
      const qualB = normB.split(',').slice(1).join(',').trim();
      if (qualA !== qualB) return false;
      const baseA = normA.split(',')[0].trim();
      const baseB = normB.split(',')[0].trim();
      return baseA === baseB;
    }
    return false;
  };

  const liveRows = ranked.filter(r => !r._dropped && QUEUE_LIVE_RE.test((r.status || '').trim()));
  const companyBuckets = new Map();
  for (const r of liveRows) {
    const key = normCompany(r.company);
    if (!companyBuckets.has(key)) companyBuckets.set(key, []);
    companyBuckets.get(key).push(r);
  }
  const queueCollisions = [];
  for (const [, group] of companyBuckets) {
    if (group.length < 2) continue;
    const seenNums = new Set();
    for (let i = 0; i < group.length; i++) {
      if (seenNums.has(String(group[i].num))) continue;
      const cluster = [group[i]];
      seenNums.add(String(group[i].num));
      for (let j = i + 1; j < group.length; j++) {
        if (seenNums.has(String(group[j].num))) continue;
        if (variantSafeRoleEqual(group[i].role, group[j].role)) {
          cluster.push(group[j]);
          seenNums.add(String(group[j].num));
        }
      }
      if (cluster.length >= 2) queueCollisions.push(cluster);
    }
  }

  if (queueCollisions.length > 0) {
    const totalDupeRows = queueCollisions.reduce((n, c) => n + c.length, 0);
    console.warn(`\n⚠️  PRE-FLIGHT COLLISION GATE: ${queueCollisions.length} bucket(s) with ${totalDupeRows} duplicate live row(s):`);
    for (const c of queueCollisions) {
      console.warn(`    ${c[0].company} / ${c[0].role}`);
      for (const r of c) console.warn(`      #${r.num} (score ${r.eval_score ?? '?'}, ${r.status}, rank ${r.rank})`);
    }
    console.warn(`\n    Resolve: node dedup-tracker.mjs --mark   (then re-run this rebuild)`);
    stats.queue_collisions = queueCollisions.length;
    stats.queue_collision_rows = totalDupeRows;
    if (QUEUE_DEDUPE_STRICT) {
      console.error('\nFATAL: QUEUE_DEDUPE_STRICT=true and collisions detected — refusing to write queue.');
      process.exit(3);
    }
  } else {
    stats.queue_collisions = 0;
    stats.queue_collision_rows = 0;
  }

  // Update queue metadata
  queue.ranked = ranked;
  queue.total_rows = ranked.length;
  queue.generated_at = new Date().toISOString();
  queue.reference_date = today;
  queue.last_rebuilt_by = 'scripts/rebuild-apply-now-queue.mjs';
  queue.last_rebuilt_stats = stats;

  console.log(`[rebuild-apply-now-queue] ${DRY_RUN ? 'DRY-RUN — no write' : 'writing ' + QUEUE_PATH}`);
  console.log(`  apply-now-queue.json: ${stats.queueRowsBefore} → ${ranked.length} rows`);
  console.log(`  added from apps:      ${stats.addedFromApps}`);
  console.log(`  status updates:       ${stats.statusUpdates}`);
  console.log(`  dropped from filter:  ${stats.droppedFromApplyNow}`);
  console.log(`  in-sync rows:         ${stats.inSyncRows}`);
  console.log(`  gate verdict:         PASS=${stats.gate_pass} AUTO_ENRICH=${stats.gate_auto_enrich} REMOVE=${stats.gate_remove}`);
  if (log.length) {
    console.log('\nChanges:');
    for (const l of log) console.log(l);
  }

  if (!DRY_RUN) {
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
    console.log(`\n✓ wrote ${QUEUE_PATH}`);
  } else {
    console.log('\n(dry-run — no file written)');
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});
