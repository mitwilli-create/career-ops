#!/usr/bin/env node
/**
 * scripts/audit-queue-gate.mjs — Phase 1.4 backfill audit (2026-05-22)
 *
 * Runs lib/apply-now-queue-gate.mjs against every actionable row sourced from:
 *   1. data/apply-now-queue.json   (curated ranked array, excluding _dropped)
 *   2. data/applications.md        (every Evaluated|Responded row with score ≥ 4.0
 *                                   not already in apply-now-queue.json)
 *
 * Enriches each row by loading its **URL:** header from the corresponding
 * report file in reports/, so the gate's url check has real data to evaluate.
 *
 * Emits data/queue-gate-audit-2026-05-22.json with three buckets:
 *   - pass         → can stay in apply-now (or be re-promoted)
 *   - auto_enrich  → reachable by populating missing repositories + URL canon
 *   - remove       → demote to All Evaluations
 *
 * Usage:
 *   node scripts/audit-queue-gate.mjs                   # writes audit + summary
 *   node scripts/audit-queue-gate.mjs --dry-run         # summary only
 *   node scripts/audit-queue-gate.mjs --out=path.json   # custom audit path
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateBatch } from '../lib/apply-now-queue-gate.mjs';
import { parseApplicationsFile } from '../lib/parse-applications.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Allow override so the audit can run from a git worktree against the main
// repo's personal-data files (which aren't synced into worktrees). Matches
// the same env var the gate library reads.
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

const QUEUE_PATH = join(ROOT, 'data', 'apply-now-queue.json');
const APPS_PATH = join(ROOT, 'data', 'applications.md');
const LIVENESS_PATH = join(ROOT, 'data', 'liveness-state.json');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const OUT_FLAG = ARGS.find(a => a.startsWith('--out='));
const today = new Date().toISOString().slice(0, 10);
const OUT_PATH = OUT_FLAG
  ? join(ROOT, OUT_FLAG.replace('--out=', ''))
  : join(ROOT, `data/queue-gate-audit-${today}.json`);

function loadJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return fallback; }
}

const URL_HEADER_RE = /^\*\*URL:\*\*\s*(\S+)/m;

function urlFromReport(reportPath) {
  if (!reportPath) return '';
  const abs = join(ROOT, reportPath);
  if (!existsSync(abs)) return '';
  try {
    // Only the first ~2KB is needed; URL is in the header block
    const content = readFileSync(abs, 'utf-8').slice(0, 2000);
    const m = content.match(URL_HEADER_RE);
    return (m && m[1] && m[1] !== '—' && m[1] !== 'TBD') ? m[1] : '';
  } catch {
    return '';
  }
}

function projectQueueRow(row) {
  const reportPathMatch = String(row.report || '').match(/\((reports\/[^\)]+)\)/);
  const reportPath = reportPathMatch ? reportPathMatch[1] : '';
  return {
    num: String(row.num),
    company: row.company,
    role: row.role,
    eval_score: row.eval_score,
    status: row.status,
    url: row.url || urlFromReport(reportPath),
    canonical_url: row.canonical_url || null,
    reportPath,
    _source: 'apply-now-queue.json',
    _rank: row.rank,
  };
}

function projectAppRow(app) {
  return {
    num: String(app.num),
    company: app.company,
    role: app.role,
    eval_score: app.score,
    status: app.status,
    url: app.url || urlFromReport(app.reportPath),
    canonical_url: app.canonical_url || null,
    reportPath: app.reportPath,
    _source: 'applications.md',
  };
}

async function main() {
  const livenessState = loadJson(LIVENESS_PATH, { rows: {} });
  const queue = loadJson(QUEUE_PATH, { ranked: [] });
  const queueRanked = (queue.ranked || []).filter(r => !r._dropped);
  const queueNums = new Set(queueRanked.map(r => String(r.num)));

  const apps = parseApplicationsFile(APPS_PATH);
  const eligible = apps.filter(a =>
    a.score >= 4.0 &&
    /^(Evaluated|Responded|Interview|Applied|Offer)$/i.test(a.status) &&
    !queueNums.has(String(a.num))
  );

  console.log(`[audit] queue rows (not _dropped): ${queueRanked.length}`);
  console.log(`[audit] applications.md eligible (not in queue): ${eligible.length}`);

  const rows = [
    ...queueRanked.map(projectQueueRow),
    ...eligible.map(projectAppRow),
  ];

  const ctx = { livenessState };
  const result = gateBatch(rows, ctx);

  const audit = {
    generated_at: new Date().toISOString(),
    reference_date: today,
    sources: {
      apply_now_queue: queueRanked.length,
      applications_md_eligible: eligible.length,
      total_audited: rows.length,
    },
    summary: result.summary,
    pass: result.pass.map(r => ({
      num: r.num, company: r.company, role: r.role,
      score: r.eval_score, source: r._source, rank: r._rank,
      url: r.url,
      _gate: r._gate,
    })),
    auto_enrich: result.auto_enrich.map(r => ({
      num: r.num, company: r.company, role: r.role,
      score: r.eval_score, source: r._source, rank: r._rank,
      url: r.url,
      reportPath: r.reportPath,
      _gate: r._gate,
    })),
    remove: result.remove.map(r => ({
      num: r.num, company: r.company, role: r.role,
      score: r.eval_score, status: r.status, source: r._source, rank: r._rank,
      _gate: r._gate,
    })),
  };

  console.log('\n=== Audit summary ===');
  console.log(`PASS:        ${result.summary.pass}`);
  console.log(`AUTO_ENRICH: ${result.summary.auto_enrich}`);
  console.log(`REMOVE:      ${result.summary.remove}`);
  console.log(`Repo populated rate:`, result.summary.repository_populated_rate);
  console.log('\nTop AUTO_ENRICH reasons (sample 5):');
  for (const r of result.auto_enrich.slice(0, 5)) {
    console.log(`  #${r.num} ${r.company} — ${r.role}`);
    console.log(`    reasons: ${r._gate.reasons.slice(0, 3).join('; ')}`);
    console.log(`    missing repos: ${r._gate.missing_repositories.join(', ') || '(none)'}`);
  }
  if (result.remove.length > 0) {
    console.log('\nREMOVE bucket (sample 5):');
    for (const r of result.remove.slice(0, 5)) {
      console.log(`  #${r.num} ${r.company} (${r.status}, score=${r.eval_score}) — ${r._gate.reasons.slice(0, 2).join('; ')}`);
    }
  }

  if (!DRY_RUN) {
    writeFileSync(OUT_PATH, JSON.stringify(audit, null, 2));
    console.log(`\n✓ wrote ${OUT_PATH}`);
  } else {
    console.log('\n(dry-run — no file written)');
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});
