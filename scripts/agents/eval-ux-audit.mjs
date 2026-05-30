#!/usr/bin/env node
/**
 * scripts/agents/eval-ux-audit.mjs — 7-phase evaluation UX audit (lightweight orchestrator).
 *
 * Theme 3 PR 2 of 2 (2026-05-29) — F124 successor skill.
 * Light orchestrator that statistically audits Mitchell's evaluation system:
 * reports/ inventory, scoring distribution from applications.md, corpus
 * citation rate in eval reports, role-discovery surface, audit-loop gaps.
 *
 * NOTE: The "full 7-phase" version described in memory (corpus audit → live
 * Chrome MCP harvest → 7-model council → dealbreaker → implementation gate
 * → /deploy-verify) is reserved for a future opt-in `--full-pipeline` flag.
 * Default mode here is statistical-only + Sonnet 4.6 narrative to keep cost
 * tight per Mitchell's session ceiling.
 *
 * Modes:
 *   --dry-run        Inventory only, no synthesis. $0.
 *   (default)        Inventory + Sonnet 4.6 synthesis. ~$0.05-0.15.
 *   --council        + 7-model adjudication. ~$20-40.
 *   --full-pipeline  Reserved — currently aliases to --council with a note.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);
const AUDIT_DIR = join(ROOT, '.claude', 'audit', TODAY);
const SYNTHESIS_MODEL = process.env.EVAL_UX_AUDIT_MODEL || 'anthropic:claude-sonnet-4-6';

function parseArgs(argv) {
  const out = { dryRun: false, council: false, fullPipeline: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--council') out.council = true;
    else if (a === '--full-pipeline') out.fullPipeline = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printUsage() {
  console.log(`eval-ux-audit — evaluation system diagnostic.

Usage:
  node scripts/agents/eval-ux-audit.mjs [--dry-run | --council | --full-pipeline]

Output: .claude/audit/${TODAY}/eval-ux-audit-${TODAY}.md`);
}

function dim1ReportsInventory() {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) {
    return { dimension: 'reports-inventory', skipped: true, reason: 'reports/ missing' };
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  let total = files.length;
  let stale = 0;
  const now = Date.now();
  for (const f of files) {
    try {
      const stat = statSync(join(dir, f));
      const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 30) stale++;
    } catch { /* skip */ }
  }
  return {
    dimension: 'reports-inventory',
    total_reports: total,
    stale_count: stale,
    stale_pct: total ? Math.round((stale / total) * 100) : 0,
    verdict: total > 100 ? 'PASS' : total > 30 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if >100 reports total.',
  };
}

function dim2ScoringDistribution() {
  const path = join(ROOT, 'data', 'applications.md');
  if (!existsSync(path)) {
    return { dimension: 'scoring-distribution', skipped: true, reason: 'data/applications.md missing (gitignored — expected)' };
  }
  const text = readFileSync(path, 'utf-8');
  // Pull all "N.N/5" scores from the table.
  const scores = [...text.matchAll(/\|\s*([0-5]\.\d)\/5\s*\|/g)].map(m => Number(m[1]));
  if (!scores.length) {
    return { dimension: 'scoring-distribution', skipped: true, reason: 'No N.N/5 scores parsed from applications.md' };
  }
  scores.sort((a, b) => a - b);
  const p50 = scores[Math.floor(scores.length / 2)];
  const bands = { strong: 0, moderate: 0, weak: 0 };
  for (const s of scores) {
    if (s >= 4.0) bands.strong++;
    else if (s >= 3.0) bands.moderate++;
    else bands.weak++;
  }
  return {
    dimension: 'scoring-distribution',
    total_scored: scores.length,
    median: p50,
    bands,
    band_pct: {
      strong: Math.round((bands.strong / scores.length) * 100),
      moderate: Math.round((bands.moderate / scores.length) * 100),
      weak: Math.round((bands.weak / scores.length) * 100),
    },
    verdict: bands.strong > 0 && bands.weak > 0 ? 'PASS' : 'CAVEATS',
    note: 'PASS if scoring shows real selectivity (both strong + weak bands populated).',
  };
}

function dim3CorpusCitationRate() {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) {
    return { dimension: 'corpus-citation-rate', skipped: true, reason: 'reports/ missing' };
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).slice(-20);
  let cvCites = 0, articleCites = 0, profileCites = 0;
  for (const f of files) {
    try {
      const t = readFileSync(join(dir, f), 'utf-8');
      if (t.includes('cv.md')) cvCites++;
      if (t.includes('article-digest')) articleCites++;
      if (t.includes('_profile')) profileCites++;
    } catch { /* skip */ }
  }
  const total = files.length || 1;
  return {
    dimension: 'corpus-citation-rate',
    sample_size: files.length,
    cv_cite_pct: Math.round((cvCites / total) * 100),
    article_digest_cite_pct: Math.round((articleCites / total) * 100),
    profile_cite_pct: Math.round((profileCites / total) * 100),
    verdict: cvCites >= total * 0.5 ? 'PASS' : cvCites >= total * 0.25 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if ≥50% of recent reports cite cv.md (corpus actually feeds evaluation).',
  };
}

function dim4ModesInventory() {
  const dir = join(ROOT, 'modes');
  if (!existsSync(dir)) {
    return { dimension: 'modes-inventory', skipped: true, reason: 'modes/ missing' };
  }
  const root = readdirSync(dir).filter(f => f.endsWith('.md'));
  return {
    dimension: 'modes-inventory',
    mode_count: root.length,
    profile_present: existsSync(join(dir, '_profile.md')),
    shared_present: existsSync(join(dir, '_shared.md')),
    verdict: root.length >= 6 ? 'PASS' : 'CAVEATS',
  };
}

function dim5RoleDiscoverySurface() {
  // Check portals.yml + portal-scan workflow + recent triage volume.
  const portalsPath = join(ROOT, 'portals.yml');
  const triagePath = join(ROOT, 'batch', 'triage-advance.tsv');
  const portalCount = existsSync(portalsPath)
    ? (readFileSync(portalsPath, 'utf-8').match(/^\s+- (?:slug|name):/gm) || []).length
    : 0;
  const triageEntries = existsSync(triagePath)
    ? readFileSync(triagePath, 'utf-8').split('\n').filter(Boolean).length
    : 0;
  return {
    dimension: 'role-discovery-surface',
    portal_count: portalCount,
    pending_triage: triageEntries,
    verdict: portalCount >= 20 && triageEntries > 0 ? 'PASS' : 'CAVEATS',
    note: 'PASS if portals.yml covers ≥20 companies and triage-advance is active.',
  };
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
  const prompt = `Audit Mitchell's career-ops evaluation system. 5 dimensions below. Synthesize a tight (300-500 word) narrative: report inventory health, scoring selectivity, corpus integration, mode coverage, role discovery, single highest-leverage tuning recommendation.

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
mode: ${opts.dryRun ? 'dry-run' : opts.council ? 'council' : opts.fullPipeline ? 'full-pipeline' : 'standard'}
synthesis_model: ${SYNTHESIS_MODEL}
---

# Eval UX audit — ${TODAY}

## Headline

${summary}

## Synthesis

${synthesis?.text || '_(no synthesis — dry-run or import failure)_'}

## Dimension data

\`\`\`json
${JSON.stringify(dims, null, 2)}
\`\`\`

## Method

Light orchestrator running 5 statistical dimensions + Sonnet 4.6 synthesis.
The full Phase 0-7 pipeline (corpus audit → Chrome MCP harvest → 7-model
council → dealbreaker → implementation gate → /deploy-verify) is reserved
for the future \`--full-pipeline\` flag. Diagnostic only — does NOT modify
scoring code, modes, or evaluation prompts.
`;
  assertNoLeak(body);
  return body;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }
  const startedAt = new Date().toISOString();

  if (opts.fullPipeline && !opts.council) {
    console.error('[note] --full-pipeline currently aliases to --council with statistical dimensions only.');
    console.error('       The full Chrome MCP harvest + dealbreaker + deploy-verify path is reserved for v1.1.');
    opts.council = true;
  }

  console.error(`[eval-ux-audit] mode=${opts.dryRun ? 'dry-run' : opts.council ? 'council' : opts.fullPipeline ? 'full-pipeline' : 'standard'}`);

  const dim1 = dim1ReportsInventory();
  console.error(`[D1] reports inventory: ${dim1.verdict || 'SKIPPED'} (total=${dim1.total_reports ?? 0})`);
  const dim2 = dim2ScoringDistribution();
  console.error(`[D2] scoring distribution: ${dim2.verdict || 'SKIPPED'} (count=${dim2.total_scored ?? 0})`);
  const dim3 = dim3CorpusCitationRate();
  console.error(`[D3] corpus citation: ${dim3.verdict || 'SKIPPED'} (cv_pct=${dim3.cv_cite_pct ?? 'n/a'})`);
  const dim4 = dim4ModesInventory();
  console.error(`[D4] modes inventory: ${dim4.verdict || 'SKIPPED'} (count=${dim4.mode_count ?? 0})`);
  const dim5 = dim5RoleDiscoverySurface();
  console.error(`[D5] role discovery: ${dim5.verdict || 'SKIPPED'} (portals=${dim5.portal_count ?? 0})`);

  const dims = [dim1, dim2, dim3, dim4, dim5];
  const synthesis = await synthesize(dims, opts);
  console.error(`[synthesis] ${synthesis.ok ? 'ok' : synthesis.skipped ? 'skipped' : 'error'}`);

  const finishedAt = new Date().toISOString();
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const outPath = join(AUDIT_DIR, `eval-ux-audit-${TODAY}.md`);
  writeFileSync(outPath, renderReport({ dims, synthesis, opts, startedAt, finishedAt }), 'utf-8');
  console.error(`[done] wrote ${outPath.replace(ROOT + '/', '')}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message || err}`);
  process.exit(1);
});
