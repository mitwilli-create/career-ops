#!/usr/bin/env node
/**
 * scripts/agents/corpus-audit.mjs — phase 0-2 corpus-gap diagnostic.
 *
 * Theme 3 PR 2 of 2 (2026-05-29) — F124 successor skill.
 * Walks Mitchell's career-corpus surfaces (cv.md / article-digest.md /
 * modes/_profile.md / config/profile.yml / data/career-archive/ /
 * apply-pack/ / writing-samples/) and inventories what's missing,
 * stale, or under-leveraged by the scoring system.
 *
 * NO implementation phase. NO Chrome MCP harvest (deferred — needs
 * /eval-ux-audit for the live web pull). Diagnostic only.
 *
 * Modes:
 *   --dry-run        Inventory only, no synthesis. $0.
 *   (default)        Inventory + Sonnet 4.6 synthesis. ~$0.05-0.15.
 *   --council        Add 7-model adjudication. ~$20-40.
 *   --help           Print usage.
 *
 * Output: .claude/audit/<DATE>/corpus-audit-<DATE>.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);
const AUDIT_DIR = join(ROOT, '.claude', 'audit', TODAY);

const SPEND_CAP_USD = Number(process.env.CORPUS_AUDIT_DAILY_USD || 50);
const SYNTHESIS_MODEL = process.env.CORPUS_AUDIT_MODEL || 'anthropic:claude-sonnet-4-6';

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
  console.log(`corpus-audit — phase 0-2 corpus-gap diagnostic.

Usage:
  node scripts/agents/corpus-audit.mjs [--dry-run | --council]

Output: .claude/audit/${TODAY}/corpus-audit-${TODAY}.md`);
}

function fileMeta(absPath) {
  if (!existsSync(absPath)) return { path: absPath.replace(ROOT + '/', ''), present: false };
  const stat = statSync(absPath);
  const sizeBytes = stat.size;
  const ageDays = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
  return {
    path: absPath.replace(ROOT + '/', ''),
    present: true,
    size_bytes: sizeBytes,
    age_days: ageDays,
    stale: ageDays > 30,
  };
}

function wordCount(absPath) {
  if (!existsSync(absPath)) return 0;
  try {
    return readFileSync(absPath, 'utf-8').split(/\s+/).filter(Boolean).length;
  } catch { return 0; }
}

function dim1CoreCorpus() {
  const files = [
    'cv.md', 'article-digest.md', 'modes/_profile.md',
    'config/profile.yml', 'config/profile.example.yml',
    'portals.yml', 'AGENTS.md', 'CLAUDE.md',
  ];
  const results = files.map(f => {
    const meta = fileMeta(join(ROOT, f));
    if (meta.present) meta.word_count = wordCount(join(ROOT, f));
    return meta;
  });
  const missing = results.filter(r => !r.present);
  const stale = results.filter(r => r.present && r.stale);
  return {
    dimension: 'core-corpus',
    files: results,
    missing_count: missing.length,
    stale_count: stale.length,
    verdict: missing.length === 0 ? (stale.length <= 2 ? 'PASS' : 'CAVEATS') : 'FAIL',
  };
}

function dim2ApplyPackInventory() {
  const dir = join(ROOT, 'apply-pack');
  if (!existsSync(dir)) {
    return { dimension: 'apply-pack-inventory', skipped: true, reason: 'apply-pack/ missing' };
  }
  const packs = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  const ARTIFACTS = ['cv-tailored.md', 'cover-letter.md', 'form-fields.md', 'impact-doc.md', 'references.md', 'referrals.md'];
  const coverage = packs.map(slug => {
    const present = ARTIFACTS.filter(a => existsSync(join(dir, slug, a)));
    return { slug, present_count: present.length, total: ARTIFACTS.length, complete: present.length === ARTIFACTS.length };
  });
  const complete = coverage.filter(c => c.complete).length;
  const completePct = packs.length ? Math.round((complete / packs.length) * 100) : 0;
  return {
    dimension: 'apply-pack-inventory',
    total_packs: packs.length,
    complete_packs: complete,
    complete_pct: completePct,
    incomplete: coverage.filter(c => !c.complete).map(c => ({ slug: c.slug, present_count: c.present_count })),
    verdict: completePct >= 75 ? 'PASS' : completePct >= 50 ? 'CAVEATS' : 'FAIL',
  };
}

function dim3WritingSamples() {
  const dir = join(ROOT, 'writing-samples');
  if (!existsSync(dir)) {
    return { dimension: 'writing-samples', present: false, verdict: 'FAIL', note: 'writing-samples/ missing' };
  }
  const files = readdirSync(dir).filter(f => !f.startsWith('.') && !f.startsWith('README'));
  return {
    dimension: 'writing-samples',
    present: true,
    sample_count: files.length,
    verdict: files.length >= 3 ? 'PASS' : files.length >= 1 ? 'CAVEATS' : 'FAIL',
    note: 'PASS if ≥3 samples for voice calibration.',
  };
}

function dim4CareerArchive() {
  const dir = join(ROOT, 'data', 'career-archive');
  if (!existsSync(dir)) {
    return { dimension: 'career-archive', present: false, verdict: 'CAVEATS', note: 'data/career-archive/ missing — optional but recommended' };
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
  return {
    dimension: 'career-archive',
    present: true,
    file_count: files.length,
    verdict: files.length >= 5 ? 'PASS' : 'CAVEATS',
  };
}

function dim5HmIntelCoverage() {
  const dir = join(ROOT, 'data', 'hm-intel');
  if (!existsSync(dir)) {
    return { dimension: 'hm-intel-corpus', skipped: true, reason: 'data/hm-intel/ missing' };
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  return {
    dimension: 'hm-intel-corpus',
    file_count: files.length,
    verdict: files.length >= 20 ? 'PASS' : files.length >= 10 ? 'CAVEATS' : 'FAIL',
  };
}

function assertNoLeak(body) {
  const triggers = [
    /^# Curriculum Vitae/i,
    /^# Mitchell Williams$/m,
    /^\s*hiring_managers:/m,
  ];
  for (const re of triggers) {
    if (re.test(body)) {
      throw new Error(`Cross-fork-leak guard fired: ${re}`);
    }
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
  const prompt = `Audit Mitchell's career corpus. Below are 5 dimensions of corpus health. Synthesize a tight (250-400 word) narrative: what's strong, what's missing, single highest-leverage gap to fill first.

Rules:
- No filler. Confidence label per claim.
- Lead with bottom line.
- One concrete recommendation at end.
- DO NOT quote personal content.

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

# Corpus audit — ${TODAY}

## Headline

${summary}

## Synthesis

${synthesis?.text || '_(no synthesis — dry-run or import failure)_'}

## Dimension data

\`\`\`json
${JSON.stringify(dims, null, 2)}
\`\`\`

## Method

Phase 0-2 only: inventory corpus surfaces + identify gaps. No Chrome MCP harvest (deferred to /eval-ux-audit). No code mutation. No personal data inlined.
`;
  assertNoLeak(body);
  return body;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }
  const startedAt = new Date().toISOString();

  console.error(`[corpus-audit] mode=${opts.dryRun ? 'dry-run' : opts.council ? 'council' : 'standard'}`);

  const dim1 = dim1CoreCorpus();
  console.error(`[D1] core corpus: ${dim1.verdict} (missing=${dim1.missing_count} stale=${dim1.stale_count})`);
  const dim2 = dim2ApplyPackInventory();
  console.error(`[D2] apply-pack: ${dim2.verdict || 'SKIPPED'} (${dim2.complete_pct ?? 0}% complete)`);
  const dim3 = dim3WritingSamples();
  console.error(`[D3] writing samples: ${dim3.verdict} (count=${dim3.sample_count ?? 0})`);
  const dim4 = dim4CareerArchive();
  console.error(`[D4] career archive: ${dim4.verdict}`);
  const dim5 = dim5HmIntelCoverage();
  console.error(`[D5] hm-intel corpus: ${dim5.verdict || 'SKIPPED'}`);

  const dims = [dim1, dim2, dim3, dim4, dim5];
  const synthesis = await synthesize(dims, opts);
  console.error(`[synthesis] ${synthesis.ok ? 'ok' : synthesis.skipped ? 'skipped' : 'error'}`);

  const finishedAt = new Date().toISOString();
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const outPath = join(AUDIT_DIR, `corpus-audit-${TODAY}.md`);
  writeFileSync(outPath, renderReport({ dims, synthesis, opts, startedAt, finishedAt }), 'utf-8');
  console.error(`[done] wrote ${outPath.replace(ROOT + '/', '')}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.stack || err.message || err}`);
  process.exit(1);
});
