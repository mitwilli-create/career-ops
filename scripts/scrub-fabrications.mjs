#!/usr/bin/env node
/**
 * scrub-fabrications.mjs — REUSABLE deterministic retired-metric scrubber for the
 * 2026-05-31 backlog apply-ready generation batch.
 *
 * WHY: LLM regeneration (interview-likelihood.mjs / hm-chance.mjs / build-apply-packs.mjs)
 * re-introduces HARDENED-CV-SPEC-2026-05-30-retired metrics (canonical: the council
 * writes "three production LLM agents" back into competitive_edge). Per memory
 * feedback_polish_does_not_strip_fabrications, removing a retired metric is a
 * DETERMINISTIC find-replace, never an LLM pass.
 *
 * Each mapping rewrites a forbidden phrase to its approved, grammar-safe, honest form
 * (mirrors cv.md hardened framing: two deployed xGE agents + forked career-ops pipeline;
 * scope = 1,000+ L8+ Senior Technical ICs; triage ~60% auto-handled).
 *
 * SAFETY: after scrubbing, re-greps each file with the EXACT verify-dashboard-real PAT
 * (+ EXCL). If any leak SURVIVES (a novel phrase no mapping covers), exits 1 and prints
 * it — so it gets hand-fixed, never silently mangled. Backs up each touched file first.
 *
 * Usage:
 *   node scripts/scrub-fabrications.mjs <file> [<file> ...]        (apply + verify)
 *   node scripts/scrub-fabrications.mjs --dry-run <file> ...       (report only)
 *   node scripts/scrub-fabrications.mjs --slug <slug>             (scrub the 6 popout/pack files for a slug)
 *   exit 0 = all clean post-scrub · exit 1 = a leak survived (hand-fix) · exit 2 = bad args
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const BACKUP = join(ROOT, 'data', 'scrub-backups-2026-05-31');

// ── grammar-safe regex replacements (ordered). Each maps a retired metric to an
//    approved honest form. Keep CONSERVATIVE — fail-loud handles anything novel. ──
const RULES = [
  // canonical recurring leak: council rewrites "three production LLM agents"
  // (also digit form "3 production…" + infixes "shipped/deployed/distinct")
  [/\b(?:three|3) (shipped |deployed |distinct |production-grade )?production (AI|LLM) (agents|systems|builds|artifacts|deployments|surfaces)\b/gi, 'two $1production $2 $3'],
  // broadened backstop (2026-05-31 PASS2): "3 production agents" with NO AI/LLM token, or
  // an inaccurate "AI voice"/"voice" descriptor, is the SAME overstated-count fabrication.
  // The prior rule already converted the AI/LLM-token forms, so this only catches the leftovers.
  // Honest fix: correct the count to two and drop the inaccurate voice descriptor.
  [/\b(?:three|3) production (?:AI voice |AI |LLM |voice )?agents\b/gi, 'two production agents'],
  [/\b99%\s+stylistic\s+fidelity\b/gi, 'high stylistic fidelity'],
  [/\b99%\s+fidelity\b/gi, 'high fidelity'],
  [/(?:>\s*|greater than\s+|over\s+)90%\s+classification(?:\s+accuracy)?/gi, 'reliable classification accuracy'],
  // retired triage-latency metric (seed: "DROP 90% latency"). Existing scrub-target script maps to "substantial".
  [/\b90%\s+reduction\s+in\s+(drafting\s+latency|latency|drafting)/gi, 'substantial reduction in $1'],
  [/\b90%\s+(drafting[- ]latency|latency|drafting)\s+reduction/gi, 'substantial $1 reduction'],
  [/\b300%\+?\s+(active capacity|active|capacity|scaling|deployment)\b/gi, 'substantial $1'],
  [/\b348\s+(attendees|senior eng\w*|senior tech\w*|of them)\b/gi, 'hundreds of $1'],
  [/\b93%\s+CSAT\b/gi, 'high CSAT'],
  [/\btop\s+0\.5%\b/gi, 'most senior engineering tier'],
  [/\b9,000\s+machines?\s+and\s+9,500\s+\w+/gi, 'company-wide devices and hotspots'],
  // "1,000 senior" WITHOUT the +/L8+ qualifier is the retired over-count form
  [/\b1,000\s+senior\b/gi, '1,000+ L8+ Senior Technical IC'],
  // STALE-but-conservative scope: cv.md:21 canonical = "1000+ L8+". "600+ L8+" was the
  // interim recalled value (v5.1 claimed it swept to 0, but 1,791 files still carry it).
  [/\b600\+\s*L8\+/gi, '1,000+ L8+'],
  // ── 180K headcount claim (HARDENED-CV-SPEC retired "180K-person"; added 2026-05-31).
  //    Drop the retired headcount, keep the org/Google framing. NEVER matches "$180" comp
  //    figures — every form requires person/employee/eng-org/Google/workforce after 180K|180,000. ──
  [/\b180(?:,?000|K)[ -]person([ -])/gi, 'large$1'],         // 180K-person / 180,000-person qualifier → large …
  [/\b180K[ -](eng|engineering)([ -]org)/gi, 'large $1$2'],  // 180K eng org (no "person") → large eng org
  [/\b180K[ -]employee\b/gi, 'large-enterprise'],            // 180K-employee (compound adj) → large-enterprise IT support
  [/\b180K[ -]employees\b/gi, 'many employees'],             // 180K employees (plural noun) → many employees
  [/\b180K (Google )?workforce\b/gi, '$1workforce'],         // (full) 180K Google workforce → (full) Google workforce
];

// ── EXACT verify-dashboard-real-2026-05-31 PAT + EXCL (source of truth for "forbidden") ──
const PAT = '99% stylistic fidelity|99% fidelity|>90% classification|greater than 90% classification|over 90% classification|300%\\+ (active|capacity|scaling|deployment)|348 (attendees|senior eng|senior tech|of them)|93% CSAT|9,000 machines and 9,500|top 0\\.5%|(three|3) (shipped |deployed |distinct |production-grade )?production (AI|LLM) (agents|systems|builds|artifacts|deployments|surfaces)|(three|3) production (AI voice |AI |LLM |voice )?agents|1,000 senior|180(,?000|K)[ -]?(person|people|employee|eng|engineering|Google|workforce)';
const EXCL = 'quarantine|zzz-polish|unsupported|dropped|Metric-hardened|corrected or dropped|No retired metrics';

function resolveSlugFiles(slug) {
  return [
    `data/interview-likelihood/${slug}.json`,
    `data/hm-chance/${slug}.json`,
    `apply-pack/${slug}/cover-letter.md`,
    `apply-pack/${slug}/cv-tailored.md`,
    `apply-pack/${slug}/full-story.md`,
    `apply-pack/${slug}/form-fields.md`,
  ].map(r => join(ROOT, r)).filter(existsSync);
}

let files = [];
if (argv.includes('--slug')) {
  const slug = argv[argv.indexOf('--slug') + 1];
  if (!slug) { console.error('--slug requires a value'); process.exit(2); }
  files = resolveSlugFiles(slug);
} else {
  files = argv.filter(a => !a.startsWith('--')).map(a => (a.startsWith('/') ? a : join(ROOT, a)));
}
if (files.length === 0) { console.error('no files to scrub'); process.exit(2); }

if (!DRY && !existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });

let totalRepl = 0, filesChanged = 0;
for (const p of files) {
  if (!existsSync(p)) { console.log(`SKIP (absent): ${p.replace(ROOT + '/', '')}`); continue; }
  let body = readFileSync(p, 'utf8');
  const orig = body;
  let hits = 0;
  for (const [re, to] of RULES) {
    body = body.replace(re, (m, ...g) => { hits++; return to.replace(/\$(\d)/g, (_, d) => g[d - 1] ?? ''); });
  }
  if (body !== orig) {
    // path-flattened backup name so shared basenames (cover-letter.md across packs) don't collide
    if (!DRY) { copyFileSync(p, join(BACKUP, p.replace(ROOT + '/', '').replace(/[\/ ]/g, '__') + '.bak')); writeFileSync(p, body); }
    totalRepl += hits; filesChanged++;
    console.log(`  ${DRY ? 'would scrub' : 'scrubbed'} ${hits}× : ${p.replace(ROOT + '/', '')}`);
  }
}

// ── fail-loud re-grep with the EXACT verifier pattern ──
let survived = 0;
for (const p of files) {
  if (!existsSync(p)) continue;
  try {
    const out = execSync(`grep -nE "${PAT}" "${p}" 2>/dev/null | grep -vE "${EXCL}" || true`, { encoding: 'utf8' }).trim();
    if (out) { survived++; console.log(`  🔴 SURVIVING LEAK in ${p.replace(ROOT + '/', '')}:\n${out.split('\n').map(l => '     ' + l.slice(0, 160)).join('\n')}`); }
  } catch {}
}

console.log(`\n${DRY ? 'DRY-RUN' : 'APPLIED'}: ${totalRepl} replacement(s) across ${filesChanged} file(s). ${survived === 0 ? '✅ verifier-clean' : `🔴 ${survived} file(s) still leaking — HAND-FIX`}`);
process.exit(survived === 0 ? 0 : 1);
