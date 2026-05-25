#!/usr/bin/env node
/**
 * scripts/scan-stale-polish-summaries.mjs — Layer 3 of bug-2026-05-25-022 closure
 *
 * Purpose: find apply-pack polish summaries left behind by the pre-744258c
 * cost-warn-force-abandon bug. The fix shipped in commit 744258c at
 * 2026-05-25 01:41:48 PDT, but any summary file WRITTEN BEFORE that fix
 * with abandon_reason: 'cost-warn-threshold' is a persistent on-disk
 * symptom that outlives the code fix — the dashboard's row drawer reads
 * those summaries and shows "Rejected · $X spent" indefinitely.
 *
 * THIS SCANNER:
 *   - Default (--dry-run, no flag needed): report stale summaries, do nothing
 *   - --apply: move each stale summary to data/apply-packs/.stale-bug-2026-05-25-022/<slug>-polish-orchestrator-summary.json
 *   - Idempotent: re-running --apply when nothing is stale is a no-op
 *   - --cutoff-sha <sha> override for testing (default: 744258c)
 *
 * Pattern documented in AGENTS.md § "Bug class: stale-on-disk-state-from-fixed-bug".
 *
 * Usage:
 *   node scripts/scan-stale-polish-summaries.mjs                 # dry-run, report
 *   node scripts/scan-stale-polish-summaries.mjs --apply         # archive stale summaries
 *   node scripts/scan-stale-polish-summaries.mjs --apply --quiet # apply without per-file log
 *
 * Exit codes:
 *   0 = clean (0 stale, or all stale archived successfully)
 *   1 = scan completed, found stale summaries (dry-run reports them; --apply archives them)
 *   2 = error
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const APPLY_PACKS_DIR = join(REPO_ROOT, 'data', 'apply-packs');
const STALE_ARCHIVE_DIR = join(APPLY_PACKS_DIR, '.stale-bug-2026-05-25-022');
const DEFAULT_CUTOFF_SHA = '744258c';

function parseArgs(argv) {
  const out = { apply: false, dryRun: true, quiet: false, cutoffSha: DEFAULT_CUTOFF_SHA };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; out.dryRun = false; }
    else if (a === '--dry-run') { out.dryRun = true; out.apply = false; }
    else if (a === '--quiet') { out.quiet = true; }
    else if (a === '--cutoff-sha') { out.cutoffSha = argv[++i]; }
    else if (a.startsWith('--cutoff-sha=')) { out.cutoffSha = a.slice('--cutoff-sha='.length); }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/scan-stale-polish-summaries.mjs [--apply] [--quiet] [--cutoff-sha <sha>]`);
      process.exit(0);
    }
  }
  return out;
}

function log(msg, opts) { if (!opts.quiet) console.log(msg); }

function getCutoffEpochMs(sha) {
  try {
    const ts = execSync(`git -C "${REPO_ROOT}" log -1 --format=%ct ${sha}`, { encoding: 'utf-8' }).trim();
    const epoch = Number(ts);
    if (!Number.isFinite(epoch) || epoch <= 0) {
      throw new Error(`git returned non-numeric timestamp: ${ts}`);
    }
    return epoch * 1000;
  } catch (err) {
    throw new Error(`failed to resolve cutoff sha ${sha}: ${err.message}`);
  }
}

function isStaleSummary(summaryPath, cutoffMs) {
  let stat;
  try { stat = statSync(summaryPath); } catch { return null; }
  if (stat.mtimeMs > cutoffMs) {
    return { stale: false, reason: `mtime ${new Date(stat.mtimeMs).toISOString()} > cutoff ${new Date(cutoffMs).toISOString()}` };
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(summaryPath, 'utf-8')); }
  catch { return { stale: false, reason: 'unparseable JSON' }; }

  const artifacts = parsed?.artifacts || parsed?.artifact_results || {};
  const flagged = [];
  for (const [slug, art] of Object.entries(artifacts)) {
    if (art && art.abandon_reason === 'cost-warn-threshold') flagged.push(slug);
  }
  if (flagged.length === 0) return { stale: false, reason: 'no cost-warn-threshold abandon_reasons' };
  return {
    stale: true,
    flagged_artifacts: flagged,
    mtime_iso: new Date(stat.mtimeMs).toISOString(),
    size_bytes: stat.size,
  };
}

function findSummaries() {
  if (!existsSync(APPLY_PACKS_DIR)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(APPLY_PACKS_DIR, { withFileTypes: true }); }
  catch { return []; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue; // skip .stale-bug-* already-archived dir
    const summaryPath = join(APPLY_PACKS_DIR, ent.name, 'polish-orchestrator-summary.json');
    if (existsSync(summaryPath)) out.push({ slug: ent.name, path: summaryPath });
  }
  return out;
}

function archiveStaleSummary(slug, path, opts) {
  if (!existsSync(STALE_ARCHIVE_DIR)) mkdirSync(STALE_ARCHIVE_DIR, { recursive: true });
  const target = join(STALE_ARCHIVE_DIR, `${slug}-polish-orchestrator-summary.json`);
  if (existsSync(target)) {
    log(`  ! archive target already exists, skipping: ${target}`, opts);
    return { ok: false, reason: 'target-exists', target };
  }
  try {
    renameSync(path, target);
    return { ok: true, target };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cutoffMs;
  try { cutoffMs = getCutoffEpochMs(opts.cutoffSha); }
  catch (err) { console.error(`error: ${err.message}`); process.exit(2); }

  log(`[scan-stale-polish-summaries] cutoff sha=${opts.cutoffSha} ts=${new Date(cutoffMs).toISOString()}`, opts);
  log(`[scan-stale-polish-summaries] apply-packs dir: ${APPLY_PACKS_DIR}`, opts);
  log(`[scan-stale-polish-summaries] mode: ${opts.dryRun ? 'DRY-RUN' : 'APPLY'}`, opts);

  const summaries = findSummaries();
  log(`[scan-stale-polish-summaries] found ${summaries.length} polish-orchestrator-summary.json file(s)`, opts);

  const stale = [];
  for (const { slug, path } of summaries) {
    const result = isStaleSummary(path, cutoffMs);
    if (result?.stale) {
      stale.push({ slug, path, ...result });
      log(`  STALE  ${slug}  (artifacts flagged: ${result.flagged_artifacts.join(', ')}; mtime ${result.mtime_iso}; ${result.size_bytes}B)`, opts);
    } else {
      log(`  fresh  ${slug}  (${result?.reason || 'no result'})`, opts);
    }
  }

  if (stale.length === 0) {
    log(`[scan-stale-polish-summaries] CLEAN: 0 stale summaries`, opts);
    process.exit(0);
  }

  if (opts.dryRun) {
    log(`[scan-stale-polish-summaries] would archive ${stale.length} stale summaries to ${STALE_ARCHIVE_DIR}`, opts);
    log(`[scan-stale-polish-summaries] re-run with --apply to archive`, opts);
    process.exit(1);
  }

  let archived = 0;
  let failed = 0;
  for (const item of stale) {
    const r = archiveStaleSummary(item.slug, item.path, opts);
    if (r.ok) { archived++; log(`  archived  ${item.slug} → ${r.target}`, opts); }
    else { failed++; log(`  FAILED    ${item.slug}: ${r.reason}`, opts); }
  }

  log(`[scan-stale-polish-summaries] archived ${archived}/${stale.length}, failed ${failed}`, opts);
  process.exit(failed > 0 ? 1 : 0);
}

main();
