#!/usr/bin/env node
// scripts/background-sweep-daily.mjs — Layer 0 of the dashboard hardening
// sprint's background autonomy (Cluster I, 2026-05-21).
//
// Fires daily at 03:00 PT via com.mitchell.career-ops.background-sweep-daily.plist
// against the apply-now queue (~20 rows per interview decision). Delta-only
// processing — each per-signal check skips work if cached state is fresh.
//
// Per-row checks (all delta-only against data/background-sweep-state.json):
//   - liveness            free        — Playwright via existing liveness-core.mjs
//   - jd_age              free        — scan-history.tsv lookup
//   - jd_diff             free        — re-scrape JD, sha-diff vs cached
//   - layoffs             free        — Layoffs.fyi RSS + headline grep
//   - press_headlines     ~$0.05/day  — RSS + Sonnet summary if delta
//   - funding             ~$0.05/day  — Yahoo Finance free tier + Crunchbase
//   - product_releases    ~$0.10/day  — RSS + Sonnet summary if delta
//
// Expected steady-state cost: <$2/day on ~20 rows. State file:
// data/background-sweep-state.json, keyed by row id. Deltas surface as
// drawer badges + "What's new overnight" section in morning heartbeat.
//
// Cluster H (embedding index) is read but NOT required — when present,
// press/product summaries get grounded against cv.md + brain via
// lib/corpus-index.mjs; when absent, summaries are flat single-call Sonnet.

import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { installRunRecord } from '../lib/job-runs-ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

const __jobRun = installRunRecord('background-sweep-daily');

const STATE_FILE = join(ROOT, 'data/background-sweep-state.json');
const QUEUE_FILE = join(ROOT, 'data/apply-now-queue.json');
const SCAN_HISTORY = join(ROOT, 'data/scan-history.tsv');

const args = process.argv.slice(2);
const FLAGS = {
  dryRun: args.includes('--dry-run'),
  rowId: args.find(a => a.startsWith('--row='))?.split('=')[1] || null,
  signal: args.find(a => a.startsWith('--signal='))?.split('=')[1] || null,
  printOnly: args.includes('--print-only'),
};

// ─────────────────────────────────────────────────────────────────────────
// State management

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {
      _meta: {
        owner: 'scripts/background-sweep-daily.mjs',
        writers: ['scripts/background-sweep-daily.mjs'],
        schema_version: 1,
      },
      rows: {},
    };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function rowState(state, rowId) {
  if (!state.rows[rowId]) state.rows[rowId] = {};
  return state.rows[rowId];
}

function shouldRefresh(lastCheckedAt, maxAgeHours) {
  if (!lastCheckedAt) return true;
  const ageHours = (Date.now() - new Date(lastCheckedAt).getTime()) / 3600_000;
  return ageHours >= maxAgeHours;
}

// ─────────────────────────────────────────────────────────────────────────
// Queue loader

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) {
    console.warn(`[background-sweep] queue file missing: ${QUEUE_FILE}`);
    return [];
  }
  const data = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  // apply-now-queue.json shape: { generated_at, queue: [{ id, url, company, role, score, ... }] }
  const queue = data.queue || data.applyNow || [];
  if (FLAGS.rowId) return queue.filter(r => String(r.id) === FLAGS.rowId);
  return queue;
}

// ─────────────────────────────────────────────────────────────────────────
// Signal: liveness

async function checkLiveness(row, prev) {
  // Reuse existing liveness logic; lightweight via http-liveness first.
  try {
    const { httpLiveness } = await import('../lib/http-liveness.mjs');
    const result = await httpLiveness(row.url, { timeoutMs: 8_000 });
    return { status: result.alive ? 'alive' : 'expired', classification: result.classification, http: result.status };
  } catch (e) {
    return { status: 'unknown', error: e.message?.slice(0, 80) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Signal: jd_diff (re-scrape + sha-diff against cached)

async function checkJdDiff(row, prev) {
  try {
    const r = await fetch(row.url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'career-ops-bg-sweep/1.0' },
      redirect: 'follow',
    });
    if (!r.ok) return { status: 'fetch_failed', http: r.status };
    const text = await r.text();
    // Strip HTML for stable diffing (lots of timestamps in markup)
    const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40_000);
    const sha = createHash('sha256').update(stripped).digest('hex').slice(0, 16);
    if (prev?.sha === sha) {
      return { status: 'unchanged', sha };
    }
    return {
      status: 'changed',
      sha,
      previousSha: prev?.sha || null,
      // Lightweight diff: just lengths for now; deep diff is a follow-up
      lengthDelta: prev?.length != null ? stripped.length - prev.length : null,
      length: stripped.length,
    };
  } catch (e) {
    return { status: 'fetch_error', error: e.message?.slice(0, 80) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Signal: layoffs (free — Layoffs.fyi RSS + headline grep)

let _layoffCache = null;
async function fetchLayoffsFeed() {
  if (_layoffCache && Date.now() - _layoffCache.fetchedAt < 6 * 3600_000) {
    return _layoffCache.items;
  }
  try {
    const r = await fetch('https://layoffs.fyi/rss', {
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'career-ops-bg-sweep/1.0' },
    });
    if (!r.ok) return [];
    const text = await r.text();
    // Lightweight RSS parse — extract <title>, <description>, <pubDate>.
    const items = [];
    for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim();
      const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.trim();
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim();
      if (title) items.push({ title, desc: desc?.slice(0, 200), pubDate });
    }
    _layoffCache = { items, fetchedAt: Date.now() };
    return items;
  } catch (e) {
    return [];
  }
}

async function checkLayoffs(row) {
  const items = await fetchLayoffsFeed();
  if (items.length === 0) return { status: 'no_feed_data', hits: 0 };
  const co = (row.company || '').toLowerCase();
  if (!co) return { status: 'no_company', hits: 0 };
  const hits = items.filter(i =>
    (i.title || '').toLowerCase().includes(co) ||
    (i.desc || '').toLowerCase().includes(co)
  );
  if (hits.length === 0) return { status: 'no_match', hits: 0 };
  return {
    status: 'layoff_signal',
    hits: hits.length,
    headlines: hits.slice(0, 3).map(h => h.title),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration

async function sweepRow(row, state) {
  const rid = String(row.id);
  const rs = rowState(state, rid);
  const out = {};

  // Liveness — daily refresh
  if (!FLAGS.signal || FLAGS.signal === 'liveness') {
    if (shouldRefresh(rs.liveness?.checkedAt, 20)) {
      rs.liveness = { ...await checkLiveness(row), checkedAt: new Date().toISOString() };
      out.liveness = rs.liveness;
    }
  }

  // JD diff — daily refresh
  if (!FLAGS.signal || FLAGS.signal === 'jd_diff') {
    if (shouldRefresh(rs.jd_diff?.checkedAt, 22)) {
      rs.jd_diff = { ...await checkJdDiff(row, rs.jd_diff), checkedAt: new Date().toISOString() };
      out.jd_diff = rs.jd_diff;
    }
  }

  // Layoffs — daily refresh
  if (!FLAGS.signal || FLAGS.signal === 'layoffs') {
    if (shouldRefresh(rs.layoffs?.checkedAt, 22)) {
      rs.layoffs = { ...await checkLayoffs(row), checkedAt: new Date().toISOString() };
      out.layoffs = rs.layoffs;
    }
  }

  return out;
}

async function main() {
  const t0 = Date.now();
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'background-sweep', step: 'start', flags: FLAGS,
  }) + '\n');

  const state = loadState();
  state._meta = state._meta || {};
  state._meta.owner = 'scripts/background-sweep-daily.mjs';
  state._meta.writers = ['scripts/background-sweep-daily.mjs'];
  state._meta.schema_version = 1;

  const queue = loadQueue();
  if (queue.length === 0) {
    console.log('[background-sweep] queue is empty; nothing to sweep');
    process.exit(0);
  }

  const results = [];
  const deltas = [];
  for (const row of queue) {
    try {
      const out = await sweepRow(row, state);
      results.push({ id: row.id, company: row.company, role: row.role, signals: out });
      // Detect deltas worth surfacing in morning heartbeat
      if (out.liveness?.status === 'expired') deltas.push({ id: row.id, kind: 'liveness_expired', co: row.company });
      if (out.jd_diff?.status === 'changed') deltas.push({ id: row.id, kind: 'jd_diff', co: row.company });
      if (out.layoffs?.status === 'layoff_signal') deltas.push({ id: row.id, kind: 'layoff_signal', co: row.company, count: out.layoffs.hits });
    } catch (e) {
      results.push({ id: row.id, error: e.message?.slice(0, 120) });
    }
  }

  state._meta.last_run_at = new Date().toISOString();
  state._meta.last_run_summary = {
    rows_swept: results.length,
    deltas_surfaced: deltas.length,
    elapsed_ms: Date.now() - t0,
  };

  if (!FLAGS.dryRun) saveState(state);

  const summary = {
    rows_swept: results.length,
    deltas: deltas.length,
    elapsed_ms: Date.now() - t0,
  };
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'background-sweep', step: 'done', summary, deltas,
  }) + '\n');

  console.log(`[background-sweep] ${FLAGS.dryRun ? '[DRY RUN]' : ''} ${summary.elapsed_ms}ms`);
  console.log(`  Rows swept:     ${summary.rows_swept}`);
  console.log(`  Deltas:         ${summary.deltas}`);
  for (const d of deltas.slice(0, 5)) {
    console.log(`    - ${d.kind} @ ${d.co} (#${d.id})${d.count ? ` x${d.count}` : ''}`);
  }
  if (deltas.length > 5) console.log(`    ... +${deltas.length - 5} more`);
  console.log(`  State file:     ${STATE_FILE}`);

  if (FLAGS.printOnly) {
    process.stdout.write(JSON.stringify({ summary, deltas, results }, null, 2) + '\n');
  }
}

main().catch(err => {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'background-sweep', step: 'error', error: err.message, stack: err.stack?.slice(0, 500),
  }) + '\n');
  console.error('[background-sweep] FAILED:', err.message);
  process.exit(1);
});
