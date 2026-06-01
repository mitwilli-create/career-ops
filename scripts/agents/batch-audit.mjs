#!/usr/bin/env node
/**
 * scripts/agents/batch-audit.mjs — diagnostic audit of Run Batch + Process All.
 *
 * Theme 3 PR 2 of 2 (2026-05-29) — F124 successor skill.
 * Audits batch + Process All health: success rate, cost drift, queue drain,
 * audit-log entries.
 *
 * Modes:
 *   --dry-run        Inventory only, no synthesis. $0.
 *   (default)        Inventory + Sonnet 4.6 synthesis. ~$0.05-0.15.
 *   --council        + 7-model adjudication. ~$20-40.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);
const AUDIT_DIR = join(ROOT, '.claude', 'audit', TODAY);
const SYNTHESIS_MODEL = process.env.BATCH_AUDIT_MODEL || 'anthropic:claude-sonnet-4-6';

function parseArgs(argv) {
  const out = { dryRun: false, council: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--council') out.council = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`batch-audit — Run Batch + Process All diagnostic.

Usage:
  node scripts/agents/batch-audit.mjs [--dry-run | --council]

Output: .claude/audit/${TODAY}/batch-audit-${TODAY}.md`);
}

function dim1BatchSuccessRate() {
  const path = join(ROOT, 'batch', 'batches-api-state.json');
  if (!existsSync(path)) {
    return { dimension: 'batch-success-rate', skipped: true, reason: 'batch/batches-api-state.json missing' };
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    const batches = Array.isArray(j.batches) ? j.batches : Array.isArray(j) ? j : Object.values(j);
    const recent = batches.slice(-10);
    let totalReq = 0, totalSucc = 0, totalErr = 0;
    for (const b of recent) {
      const counts = b?.request_counts || b?.counts || {};
      totalReq += Number(counts.processing || 0) + Number(counts.succeeded || 0) + Number(counts.errored || 0) + Number(counts.expired || 0);
      totalSucc += Number(counts.succeeded || 0);
      totalErr += Number(counts.errored || 0) + Number(counts.expired || 0);
    }
    const succPct = totalReq ? Math.round((totalSucc / totalReq) * 100) : 0;
    return {
      dimension: 'batch-success-rate',
      recent_batch_count: recent.length,
      total_requests: totalReq,
      succeeded: totalSucc,
      errored_or_expired: totalErr,
      success_pct: succPct,
      verdict: succPct >= 90 ? 'PASS' : succPct >= 70 ? 'CAVEATS' : 'FAIL',
      note: 'PASS if last-10 batches show ≥90% per-request success rate.',
    };
  } catch (err) {
    return { dimension: 'batch-success-rate', skipped: true, reason: `parse error: ${err.message}` };
  }
}

function dim2ProcessAllRuns() {
  const path = join(ROOT, 'data', 'pipeline-process-state.json');
  if (!existsSync(path)) {
    return { dimension: 'process-all-runs', skipped: true, reason: 'data/pipeline-process-state.json missing' };
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    const jobs = Array.isArray(j.jobs) ? j.jobs : Object.values(j.jobs || {});
    const recent = jobs.slice(-5);
    const completed = recent.filter(x => x.status === 'completed').length;
    const cancelled = recent.filter(x => x.status === 'cancelled').length;
    const failed = recent.filter(x => x.status === 'failed' || x.status === 'error').length;
    return {
      dimension: 'process-all-runs',
      recent_count: recent.length,
      completed, cancelled, failed,
      completion_pct: recent.length ? Math.round((completed / recent.length) * 100) : 0,
      verdict: !recent.length ? 'SKIPPED' : completed === recent.length ? 'PASS' : completed >= recent.length * 0.7 ? 'CAVEATS' : 'FAIL',
      note: 'PASS if all last-5 Process All runs completed (no cancel / no fail).',
    };
  } catch (err) {
    return { dimension: 'process-all-runs', skipped: true, reason: `parse error: ${err.message}` };
  }
}

function dim3ProcessAllAuditLog() {
  const path = join(ROOT, 'data', 'process-all-audit.jsonl');
  if (!existsSync(path)) {
    return { dimension: 'process-all-audit-log', present: false, verdict: 'INFO', note: 'No high-spend audit entries yet — audit fires above $250.' };
  }
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  let totalSpend = 0;
  const tierTallies = {};
  for (const l of lines.slice(-20)) {
    try {
      const j = JSON.parse(l);
      const cost = Number(j.cost_estimate_usd || j.cost_usd || 0);
      totalSpend += cost;
      const tier = j.tier_name || j.tier_id || 'unknown';
      tierTallies[tier] = (tierTallies[tier] || 0) + 1;
    } catch { /* skip */ }
  }
  return {
    dimension: 'process-all-audit-log',
    recent_entry_count: Math.min(lines.length, 20),
    total_estimated_spend_usd: Number(totalSpend.toFixed(2)),
    tier_tallies: tierTallies,
    verdict: 'INFO',
    note: 'Informational. Audit fires for any Process All run estimated >$250.',
  };
}

function dim4ApplyNowQueueState() {
  const path = join(ROOT, 'data', 'apply-now-queue.json');
  if (!existsSync(path)) {
    return { dimension: 'apply-now-state', skipped: true, reason: 'apply-now-queue.json missing' };
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    const ranked = Array.isArray(j.ranked) ? j.ranked.length : 0;
    const pending = Number(j.pending_count || j.pending || 0);
    return {
      dimension: 'apply-now-state',
      ranked_rows: ranked,
      pending_in_pipeline: pending,
      verdict: ranked > 0 && pending < 1000 ? 'PASS' : ranked === 0 ? 'FAIL' : 'CAVEATS',
      note: 'PASS if ranked>0 and pending<1000.',
    };
  } catch (err) {
    return { dimension: 'apply-now-state', skipped: true, reason: `parse error: ${err.message}` };
  }
}

function dim5DailyQuota() {
  const path = join(ROOT, 'batch', 'daily-quota.json');
  if (!existsSync(path)) {
    return { dimension: 'daily-quota', skipped: true, reason: 'batch/daily-quota.json missing' };
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    const today = j[TODAY] || j.today || {};
    const spent = Number(today.spent_usd || today.spend || 0);
    const cap = Number(today.cap_usd || j.daily_cap_usd || 50);
    return {
      dimension: 'daily-quota',
      today_spent_usd: spent,
      cap_usd: cap,
      remaining_usd: Number((cap - spent).toFixed(2)),
      pct_used: cap ? Math.round((spent / cap) * 100) : 0,
      verdict: spent < cap * 0.75 ? 'PASS' : spent < cap ? 'CAVEATS' : 'FAIL',
    };
  } catch (err) {
    return { dimension: 'daily-quota', skipped: true, reason: `parse error: ${err.message}` };
  }
}

function assertNoLeak(body) {
  const triggers = [/^# Curriculum Vitae/i, /^# Mitchell Williams$/m, /^\s*hiring_managers:/m];
  for (const re of triggers) {
    if (re.test(body)) throw new Error(`Cross-fork-leak guard fired: ${re}`);
  }
}

async function synthesize(dims, opts) {
  if (opts.dryRun) return { skipped: true };
  let callCouncil = null;
  try {
    const mod = await import(join(ROOT, 'lib', 'council.mjs'));
    callCouncil = mod.callCouncil;
  } catch (err) {
    return { skipped: true, reason: err.message };
  }
  const prompt = `Audit Mitchell's Run Batch + Process All pipelines. 5 dimensions below. Synthesize a tight (250-400 word) narrative: batch reliability, cost posture, Process All completion rate, queue health, single highest-leverage fix.

Rules: confidence label; bottom-line first; one recommendation; no personal data.

Dimensions:
${JSON.stringify(dims, null, 2)}`;
  try {
    const r = await callCouncil({ prompt, models: [SYNTHESIS_MODEL], opts: { timeoutMs: 120000 } });
    const text = Array.isArray(r?.results) && r.results.length
      ? r.results.map(x => x.content || x.text || '').filter(Boolean).join('\n\n---\n\n')
      : (typeof r === 'string' ? r : JSON.stringify(r));
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function renderReport({ dims, synthesis, opts, startedAt, finishedAt }) {
  const summary = dims.map((d, i) => `- **D${i + 1} ${d.dimension}** — ${d.verdict || (d.skipped ? 'SKIPPED' : 'INFO')}`).join('\n');
  const body = `---
classification: "[PERSONAL — DO NOT PUBLISH]"
generated_at: ${startedAt}
finished_at: ${finishedAt}
mode: ${opts.dryRun ? 'dry-run' : opts.council ? 'council' : 'standard'}
synthesis_model: ${SYNTHESIS_MODEL}
---

# Batch audit — ${TODAY}

## Headline

${summary}

## Synthesis

${synthesis?.text || '_(no synthesis — dry-run or import failure)_'}

## Dimension data

\`\`\`json
${JSON.stringify(dims, null, 2)}
\`\`\`
`;
  assertNoLeak(body);
  return body;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }
  const startedAt = new Date().toISOString();

  console.error(`[batch-audit] mode=${opts.dryRun ? 'dry-run' : opts.council ? 'council' : 'standard'}`);

  const dim1 = dim1BatchSuccessRate();
  console.error(`[D1] batch success: ${dim1.verdict || 'SKIPPED'} (${dim1.success_pct ?? 'n/a'}%)`);
  const dim2 = dim2ProcessAllRuns();
  console.error(`[D2] process-all runs: ${dim2.verdict || 'SKIPPED'} (${dim2.completion_pct ?? 'n/a'}%)`);
  const dim3 = dim3ProcessAllAuditLog();
  console.error(`[D3] audit log: ${dim3.verdict}`);
  const dim4 = dim4ApplyNowQueueState();
  console.error(`[D4] apply-now state: ${dim4.verdict || 'SKIPPED'}`);
  const dim5 = dim5DailyQuota();
  console.error(`[D5] daily quota: ${dim5.verdict || 'SKIPPED'} (${dim5.pct_used ?? 'n/a'}%)`);

  const dims = [dim1, dim2, dim3, dim4, dim5];
  const synthesis = await synthesize(dims, opts);
  console.error(`[synthesis] ${synthesis.ok ? 'ok' : synthesis.skipped ? 'skipped' : 'error'}`);

  const finishedAt = new Date().toISOString();
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const outPath = join(AUDIT_DIR, `batch-audit-${TODAY}.md`);
  writeFileSync(outPath, renderReport({ dims, synthesis, opts, startedAt, finishedAt }), 'utf-8');
  console.error(`[done] wrote ${outPath.replace(ROOT + '/', '')}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message || err}`);
  process.exit(1);
});
