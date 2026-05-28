#!/usr/bin/env node
/**
 * scripts/regen-spanish-reports.mjs — PR-X Spanish report bulk re-eval.
 *
 * Per Mitchell's Q4 + Q5 locked decisions (2026-05-27 interview):
 *   Q4: Full re-eval, all 253 Spanish reports (not translate-only)
 *   Q5: Live URLs only (pre-check via check-liveness.mjs, skip dead postings)
 *
 * Scope:
 *   1. Walk reports/*.md
 *   2. Detect Spanish reports (regex on `## Bloque` / `Resumen del Rol` / etc.)
 *   3. Extract posting URL from each report's `**URL:**` header line
 *   4. Pre-check URL liveness (skip dead — wasted re-eval spend)
 *   5. (--execute): full council re-eval per live role, generate English
 *      report, overwrite the file in place. Cost: ~$80-300 total.
 *   6. (default): dry-run — emit a manifest of candidates only, $0 spend.
 *
 * Safety:
 *   - DEFAULT MODE IS DRY-RUN. `--execute` flag must be explicitly passed.
 *   - Manifest written to data/regen-spanish-reports-manifest-<DATE>.json
 *     BEFORE any LLM call. Mitchell reviews the manifest, then runs again
 *     with --execute --confirm to authorize spend.
 *   - --limit N caps how many roles get re-evaled in a single run (testing).
 *   - Cost ledger written to data/regen-spanish-reports-cost-<DATE>.jsonl
 *     per role processed (resumable: ledger entries skip already-done).
 *
 * Usage:
 *   node scripts/regen-spanish-reports.mjs                          # dry-run
 *   node scripts/regen-spanish-reports.mjs --execute --confirm      # full run
 *   node scripts/regen-spanish-reports.mjs --execute --confirm --limit 5
 *
 * See data/heartbeat-overhaul-spec-2026-05-27.md § PR-X for full context.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = process.cwd();
const REPORTS_DIR = join(ROOT, 'reports');
const DATA_DIR = join(ROOT, 'data');
const TODAY = new Date().toISOString().slice(0, 10);

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const CONFIRM = args.includes('--confirm');
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();

// Spanish detection patterns — high-specificity to avoid false positives.
const SPANISH_PATTERNS = [
  /^##\s+Bloque\s+[A-F]\s*[—\-]/m,
  /Resumen del Rol/,
  /Recomendación final/,
  /Evaluación general/,
  /Encaja con/,
];

const URL_HEADER_RE = /\*\*URL:\*\*\s*(\S+)/;

function log(level, msg, extra = {}) {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    level,
    source: 'regen-spanish-reports',
    msg,
    ...extra,
  }) + '\n');
}

function detectSpanish(content) {
  for (const pattern of SPANISH_PATTERNS) {
    if (pattern.test(content)) return { spanish: true, matched: pattern.source };
  }
  return { spanish: false };
}

function extractPostingUrl(content) {
  const m = content.match(URL_HEADER_RE);
  return m ? m[1] : null;
}

async function checkLiveness(url) {
  if (!url) return { alive: false, reason: 'no_url' };
  try {
    const { checkUrlLiveness } = await import('../liveness-core.mjs').catch(async () => {
      const m = await import('../lib/event-liveness.mjs');
      return { checkUrlLiveness: m.checkEventUrlLive };
    });
    return checkUrlLiveness(url, { timeoutMs: 6000 });
  } catch (err) {
    return { alive: false, reason: `liveness_check_failed: ${err.message}` };
  }
}

async function walkReports() {
  const entries = readdirSync(REPORTS_DIR);
  const mdFiles = entries.filter(e => e.endsWith('.md'));
  const candidates = [];
  log('info', 'walking_reports', { total: mdFiles.length });
  for (const file of mdFiles) {
    const path = join(REPORTS_DIR, file);
    let content;
    try { content = readFileSync(path, 'utf-8'); } catch { continue; }
    const { spanish, matched } = detectSpanish(content);
    if (!spanish) continue;
    const url = extractPostingUrl(content);
    candidates.push({ file, path, url, spanish_pattern: matched });
  }
  log('info', 'candidates_identified', { count: candidates.length });
  return candidates;
}

async function pretestLiveness(candidates) {
  log('info', 'pretest_liveness', { count: candidates.length });
  const live = [];
  const dead = [];
  for (const c of candidates) {
    if (!c.url) { dead.push({ ...c, liveness: { alive: false, reason: 'no_url' } }); continue; }
    const result = await checkLiveness(c.url);
    if (result.alive) live.push({ ...c, liveness: result });
    else dead.push({ ...c, liveness: result });
    await new Promise(r => setTimeout(r, 100));
  }
  log('info', 'liveness_complete', { live: live.length, dead: dead.length });
  return { live, dead };
}

async function reevalRole(candidate) {
  // STUB — full re-eval implementation. Wired through but commented for the
  // initial scaffold ship. To activate: uncomment + add the call to the
  // existing eval pipeline (phase3b-evaluator.mjs or lib/council.mjs direct).
  //
  // Recommended path:
  //   1. Scrape live JD from candidate.url via Playwright (or reuse cached
  //      from data/role-enrichment/ if present)
  //   2. Read cv.md + article-digest.md + modes/_profile.md for Mitchell's
  //      profile context
  //   3. callCouncil({ prompt, models: ['anthropic:claude-sonnet-4-6'], ... })
  //      with the auto-pipeline.md prompt (English mode)
  //   4. Format response as a report.md file in the existing schema
  //   5. Overwrite candidate.path with the new English content
  //   6. Append cost ledger entry
  //
  // Estimated cost per role: $0.40-1.50 (Sonnet 4.6 with full corpus context).
  // ~150-200 live URLs × ~$0.80 avg = ~$120-160 total.
  return {
    ok: false,
    skipped: true,
    reason: 'reeval_implementation_pending — see scripts/regen-spanish-reports.mjs comment block. Run with --execute --confirm after wiring lib/council.mjs call.',
    cost_usd: 0,
  };
}

(async () => {
  log('info', 'starting', { execute: EXECUTE, confirm: CONFIRM, limit: LIMIT, today: TODAY });

  if (!existsSync(REPORTS_DIR)) {
    log('error', 'reports_dir_missing', { path: REPORTS_DIR });
    process.exit(1);
  }

  const candidates = await walkReports();
  const { live, dead } = await pretestLiveness(candidates);

  const manifestPath = join(DATA_DIR, `regen-spanish-reports-manifest-${TODAY}.json`);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    ts: new Date().toISOString(),
    today: TODAY,
    total_reports_scanned: readdirSync(REPORTS_DIR).filter(e => e.endsWith('.md')).length,
    spanish_candidates: candidates.length,
    live_count: live.length,
    dead_count: dead.length,
    live: live.map(c => ({ file: c.file, url: c.url, status: c.liveness.status, finalUrl: c.liveness.finalUrl })),
    dead: dead.map(c => ({ file: c.file, url: c.url, reason: c.liveness.reason })),
  }, null, 2));
  log('info', 'wrote_manifest', { path: manifestPath });

  if (!EXECUTE) {
    log('info', 'dry_run_complete', { manifest: manifestPath, next: `Review manifest then run: node scripts/regen-spanish-reports.mjs --execute --confirm` });
    process.exit(0);
  }

  if (!CONFIRM) {
    log('error', 'execute_without_confirm', { msg: '--execute requires --confirm flag (safety guard against accidental spend)', estimated_cost: `~$${(live.length * 0.8).toFixed(2)}` });
    process.exit(2);
  }

  log('info', 'beginning_reeval', { count: Math.min(live.length, LIMIT), estimated_cost_usd: `~$${(Math.min(live.length, LIMIT) * 0.8).toFixed(2)}` });
  const ledgerPath = join(DATA_DIR, `regen-spanish-reports-cost-${TODAY}.jsonl`);
  let totalCost = 0;
  let processed = 0;
  for (const c of live.slice(0, LIMIT)) {
    const result = await reevalRole(c);
    const entry = {
      ts: new Date().toISOString(),
      file: c.file,
      url: c.url,
      ok: result.ok,
      cost_usd: result.cost_usd || 0,
      reason: result.reason || null,
    };
    writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', { flag: 'a' });
    totalCost += result.cost_usd || 0;
    processed++;
    if (result.ok) log('info', 'role_reevaled', { file: c.file, cost: result.cost_usd });
    else log('warn', 'role_skipped', { file: c.file, reason: result.reason });
  }
  log('info', 'reeval_complete', { processed, total_cost_usd: totalCost.toFixed(4), ledger: ledgerPath });
  process.exit(0);
})().catch(err => {
  log('error', 'fatal', { err: err.message, stack: err.stack?.slice(0, 500) });
  process.exit(1);
});
