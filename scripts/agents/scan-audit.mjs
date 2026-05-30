#!/usr/bin/env node
/**
 * scripts/agents/scan-audit.mjs — diagnostic audit of the scanner pipeline.
 *
 * Theme 3 PR 2 of 2 (2026-05-29) — F124 successor skill.
 * Audits portal scanner health: which scanners loaded, last fire, exit codes,
 * triage advance rate, portals.yml coverage, scan-history dedup rate.
 *
 * Modes:
 *   --dry-run        Inventory only, no synthesis. $0.
 *   (default)        Inventory + Sonnet 4.6 synthesis. ~$0.05-0.15.
 *   --council        + 7-model adjudication. ~$20-40.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);
const AUDIT_DIR = join(ROOT, '.claude', 'audit', TODAY);
const SYNTHESIS_MODEL = process.env.SCAN_AUDIT_MODEL || 'anthropic:claude-sonnet-4-6';

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
  console.log(`scan-audit — scanner pipeline diagnostic.

Usage:
  node scripts/agents/scan-audit.mjs [--dry-run | --council]

Output: .claude/audit/${TODAY}/scan-audit-${TODAY}.md`);
}

function dim1ScannerPlists() {
  const dir = join(ROOT, 'scripts', 'launchd');
  if (!existsSync(dir)) return { dimension: 'scanner-plists', skipped: true, reason: 'scripts/launchd/ missing' };
  const plists = readdirSync(dir).filter(f => /^com\.mitchell\.career-ops\.scan/.test(f));
  return {
    dimension: 'scanner-plists',
    plist_count: plists.length,
    plists,
    verdict: plists.length >= 6 ? 'PASS' : plists.length >= 3 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if ≥6 scanner plists installed.',
  };
}

function dim2PipelineIngressState() {
  const path = join(ROOT, 'data', 'pipeline-ingress-state.json');
  if (!existsSync(path)) {
    return { dimension: 'pipeline-ingress', skipped: true, reason: 'data/pipeline-ingress-state.json missing' };
  }
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    const scanners = j.scanners || j.sources || j.sources_status || {};
    const entries = Object.entries(scanners);
    const now = Date.now();
    const stale = entries.filter(([k, v]) => {
      const last = v?.last_run_at || v?.last_scanned_at || v?.last_fire;
      if (!last) return true;
      const ageHours = (now - new Date(last).getTime()) / (1000 * 60 * 60);
      return ageHours > 48;
    }).length;
    const total = entries.length;
    return {
      dimension: 'pipeline-ingress',
      scanner_count: total,
      stale_count: stale,
      stale_pct: total ? Math.round((stale / total) * 100) : 0,
      verdict: total === 0 ? 'INFRA-MISSING' : (stale / total) <= 0.25 ? 'PASS' : (stale / total) <= 0.5 ? 'CAVEATS' : 'FAIL',
      note: 'PASS if ≤25% of scanners are stale (>48h since last fire).',
    };
  } catch (err) {
    return { dimension: 'pipeline-ingress', skipped: true, reason: `parse error: ${err.message}` };
  }
}

function dim3PortalsCoverage() {
  const path = join(ROOT, 'portals.yml');
  if (!existsSync(path)) {
    return { dimension: 'portals-coverage', skipped: true, reason: 'portals.yml missing' };
  }
  const text = readFileSync(path, 'utf-8');
  const companyLines = (text.match(/^\s+- (?:slug|name):/gm) || []).length;
  const positiveFilters = (text.match(/^\s+(?:positive|title_filter):/gm) || []).length;
  return {
    dimension: 'portals-coverage',
    company_entries: companyLines,
    filter_count: positiveFilters,
    verdict: companyLines >= 20 ? 'PASS' : companyLines >= 10 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if ≥20 company entries in portals.yml.',
  };
}

function dim4ScanHistory() {
  const path = join(ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(path)) {
    return { dimension: 'scan-history', skipped: true, reason: 'data/scan-history.tsv missing' };
  }
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  return {
    dimension: 'scan-history',
    total_entries: lines.length,
    verdict: lines.length >= 100 ? 'PASS' : lines.length >= 10 ? 'CAVEATS' : 'FAIL',
  };
}

function dim5TriageAdvance() {
  const path = join(ROOT, 'batch', 'triage-advance.tsv');
  if (!existsSync(path)) {
    return { dimension: 'triage-advance', skipped: true, reason: 'batch/triage-advance.tsv missing' };
  }
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  return {
    dimension: 'triage-advance',
    pending_advance_count: lines.length,
    verdict: lines.length < 500 ? 'PASS' : lines.length < 2000 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if pending queue <500 (healthy throughput). FAIL >2000 (drain stalled).',
  };
}

function assertNoLeak(body) {
  const triggers = [
    /^# Curriculum Vitae/i, /^# Mitchell Williams$/m, /^\s*hiring_managers:/m,
  ];
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
  const prompt = `Audit Mitchell's career-ops scanner pipeline. 5 dimensions below. Synthesize a tight (250-400 word) narrative: scanner health, ingress posture, portal coverage, throughput, single highest-leverage fix.

Rules: confidence label per claim; bottom-line first; one recommendation; no personal data quoted.

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

# Scan audit — ${TODAY}

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

  console.error(`[scan-audit] mode=${opts.dryRun ? 'dry-run' : opts.council ? 'council' : 'standard'}`);

  const dim1 = dim1ScannerPlists();
  console.error(`[D1] scanner plists: ${dim1.verdict || 'SKIPPED'} (count=${dim1.plist_count ?? 0})`);
  const dim2 = dim2PipelineIngressState();
  console.error(`[D2] pipeline ingress: ${dim2.verdict || 'SKIPPED'} (stale_pct=${dim2.stale_pct ?? 'n/a'})`);
  const dim3 = dim3PortalsCoverage();
  console.error(`[D3] portals coverage: ${dim3.verdict || 'SKIPPED'} (companies=${dim3.company_entries ?? 0})`);
  const dim4 = dim4ScanHistory();
  console.error(`[D4] scan history: ${dim4.verdict || 'SKIPPED'} (entries=${dim4.total_entries ?? 0})`);
  const dim5 = dim5TriageAdvance();
  console.error(`[D5] triage advance: ${dim5.verdict || 'SKIPPED'} (pending=${dim5.pending_advance_count ?? 0})`);

  const dims = [dim1, dim2, dim3, dim4, dim5];
  const synthesis = await synthesize(dims, opts);
  console.error(`[synthesis] ${synthesis.ok ? 'ok' : synthesis.skipped ? 'skipped' : 'error'}`);

  const finishedAt = new Date().toISOString();
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const outPath = join(AUDIT_DIR, `scan-audit-${TODAY}.md`);
  writeFileSync(outPath, renderReport({ dims, synthesis, opts, startedAt, finishedAt }), 'utf-8');
  console.error(`[done] wrote ${outPath.replace(ROOT + '/', '')}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message || err}`);
  process.exit(1);
});
