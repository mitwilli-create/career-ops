#!/usr/bin/env node
/**
 * scripts/deep-refresh-sweep.mjs
 *
 * Closure 16 of Part 4 (dashboard hardening sprint 2026-05-21).
 *
 * Runs deep-refresh sequentially over the top-N apply-now-queue rows:
 *   1. Liveness check via lib/http-liveness.mjs
 *   2. intel-refresh.mjs --slots toxicity,positioning --force (cheaper than
 *      full deep-council-7; hm-intel slot skipped when its researcher script
 *      is missing — surfaces 'kept_due_to_missing_script' rather than silent
 *      failure)
 *   3. Dashboard rebuild after all rows processed
 *
 * Logs per-role results to data/deep-refresh-results-<YYYY-MM-DD>.json so
 * Mitchell can audit what was refreshed without re-reading every log file.
 *
 * Usage:
 *   node scripts/deep-refresh-sweep.mjs --top=3
 *   node scripts/deep-refresh-sweep.mjs --top=5 --slots=toxicity
 *
 * Cost: ~$5-9 per role at default slots (toxicity + positioning). $0 for
 * liveness. Default cap = 3 roles to stay under the Part 4 $15-20 budget.
 *
 * Hang prevention:
 *   - spawnSync with timeout: 1_500_000 (25 min ceiling per role)
 *   - Sequential, no parallel fan-out (avoids API rate limits)
 *   - Best-effort writes; failures logged but never abort the sweep
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import { checkUrl } from '../lib/http-liveness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

const today = new Date().toISOString().slice(0, 10);
const RESULTS_PATH = join(ROOT, 'data', `deep-refresh-results-${today}.json`);

const args = process.argv.slice(2);
function arg(name, fallback) {
  const m = args.find(a => a.startsWith('--' + name + '='));
  if (m) return m.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}
const topN = parseInt(arg('top', '3'), 10);
const slots = arg('slots', 'toxicity,positioning');

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}

function findSlugForRow(num) {
  const padded = String(num).padStart(3, '0') + '-';
  for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
    if (!existsSync(base)) continue;
    try {
      const hit = readdirSync(base).find(n => n.startsWith(padded));
      if (hit) return hit;
    } catch {}
  }
  return null;
}

function readJdUrlFromHmIntel(row) {
  // hm-intel JSON has the URL at the top level. Slug is company-role with
  // numeric prefix stripped, so try the obvious key.
  try {
    const slugified = `${slugifyForFile(row.company)}-${slugifyForFile(row.role)}`;
    const path = join(ROOT, 'data', 'hm-intel', `${slugified}.json`);
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf-8'));
      if (j.url) return j.url;
    }
  } catch {}
  return null;
}

function slugifyForFile(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

const qPath = join(ROOT, 'data', 'apply-now-queue.json');
if (!existsSync(qPath)) {
  console.error('apply-now-queue.json missing');
  process.exit(1);
}
const queue = JSON.parse(readFileSync(qPath, 'utf-8'));
const ranked = Array.isArray(queue.ranked) ? queue.ranked.slice(0, topN) : [];

emit({ phase: 'sweep-start', target_count: ranked.length, slots, today });

const results = {
  generated_at: new Date().toISOString(),
  slots_run: slots.split(','),
  rows: [],
};

for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  const slug = findSlugForRow(r.num);
  const row_result = {
    num: r.num,
    company: r.company,
    role: r.role,
    slug,
    started_at: new Date().toISOString(),
    liveness: null,
    intel_refresh: null,
    errors: [],
  };
  emit({ phase: 'row-start', i: i + 1, of: ranked.length, num: r.num, slug });

  // Step 1: Liveness check
  const jdUrl = readJdUrlFromHmIntel(r);
  if (jdUrl) {
    try {
      const lv = await checkUrl(jdUrl, { timeoutMs: 15_000 });
      row_result.liveness = { url: jdUrl, status: lv.status || lv.code || 'unknown', http: lv.http || null };
      emit({ phase: 'liveness-done', num: r.num, status: row_result.liveness.status });
    } catch (e) {
      row_result.liveness = { url: jdUrl, status: 'error', error: String(e.message || e) };
      row_result.errors.push('liveness: ' + e.message);
    }
  } else {
    row_result.liveness = { status: 'skipped', reason: 'no JD URL in hm-intel' };
  }

  // Step 2: intel-refresh.mjs (toxicity + positioning, NOT hm-intel — its
  // researcher script is missing and the slot now skips gracefully).
  try {
    const t0 = Date.now();
    const proc = spawnSync('node', [
      join(ROOT, 'scripts/agents/intel-refresh.mjs'),
      '--row', String(r.num),
      '--slots', slots,
      '--force',
    ], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf-8',
      timeout: 1_500_000,  // 25-min per-row ceiling
      maxBuffer: 4 * 1024 * 1024,
    });
    row_result.intel_refresh = {
      exit_code: proc.status,
      elapsed_ms: Date.now() - t0,
      stderr_tail: (proc.stderr || '').split('\n').filter(Boolean).slice(-10).join('\n'),
      stdout_tail: (proc.stdout || '').split('\n').filter(Boolean).slice(-3).join('\n'),
    };
    emit({ phase: 'intel-refresh-done', num: r.num, exit: proc.status, elapsed_ms: row_result.intel_refresh.elapsed_ms });
  } catch (e) {
    row_result.intel_refresh = { error: String(e.message || e) };
    row_result.errors.push('intel-refresh: ' + e.message);
  }

  row_result.finished_at = new Date().toISOString();
  results.rows.push(row_result);

  // Save after each row so partial results survive interruption.
  try {
    mkdirSync(dirname(RESULTS_PATH), { recursive: true });
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  } catch (e) {
    emit({ phase: 'results-write-failed', error: e.message });
  }
}

// Step 3: rebuild dashboard
emit({ phase: 'rebuild-start' });
try {
  const t0 = Date.now();
  const proc = spawnSync('node', [join(ROOT, 'scripts/build-dashboard.mjs')], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf-8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  results.rebuild = { exit_code: proc.status, elapsed_ms: Date.now() - t0 };
  emit({ phase: 'rebuild-done', exit: proc.status, elapsed_ms: results.rebuild.elapsed_ms });
} catch (e) {
  results.rebuild = { error: String(e.message || e) };
}

writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
emit({ phase: 'sweep-done', results_path: RESULTS_PATH });
console.log(JSON.stringify({ ok: true, results_path: RESULTS_PATH, summary: { rows: results.rows.length, rebuild: results.rebuild?.exit_code } }, null, 2));
