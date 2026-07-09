#!/usr/bin/env node

/**
 * scripts/jd-keyword-score.mjs — JD-keyword overlap scorer (audit Item E,
 * 2026-05-18). Deterministic, no LLM spend. Runs as a post-build / pre-flight
 * gate to flag tailored apply-pack artifacts that miss the JD's load-bearing
 * terms.
 *
 * Per-pack workflow:
 *   1. Read JD body. PRIMARY source: apply-pack/<slug>/jd-verbatim.md (the
 *      verbatim posting; legacy name jd.md also honored), used ALONE when
 *      present. SECONDARY (no verbatim file): the eval report's JD-BEARING
 *      SECTIONS ONLY — Role Summary + the CV Match table's JD-requirement
 *      column (see extractJdBearingText). The report is passed explicitly via
 *      --report, or resolved by ROLE SLUG (never by bare numeric prefix:
 *      report numbers and tracker row numbers are independent num spaces —
 *      see resolveEvalReport). LAST RESORT: grok-intel.md + README.md +
 *      one-pager.md + the full report (intel-concat).
 *   2. Tokenize, lowercase, drop stopwords + numeric/date tokens, count.
 *      Non-verbatim sources additionally drop REPORT_META_STOPWORDS
 *      (evaluator scaffolding like `block` / `recruiter` / `report`).
 *      Sort by raw frequency; cap at top-20 (configurable).
 *   3. For each artifact (cv / cover-letter / form-fields / one-pager),
 *      compute the overlap with the JD top-20 — count matches, list misses.
 *   4. Write a markdown report to apply-pack/<slug>/keyword-alignment.md
 *      with the scoreboard + recommended additions.
 *
 * CLI:
 *   node scripts/jd-keyword-score.mjs --slug 048-anthropic-engineering-editorial-lead
 *   node scripts/jd-keyword-score.mjs --all                  # every apply-pack dir
 *   node scripts/jd-keyword-score.mjs --slug <slug> --top 30 # custom keyword cap
 *   node scripts/jd-keyword-score.mjs --slug <slug> --dry-run # print to stdout
 *   node scripts/jd-keyword-score.mjs --slug <slug> --report reports/2730-….md  # explicit JD report
 *
 * Exit code: 0 if every artifact hits the alignment floor (default ≥50%),
 *            1 if any pack falls below.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// English stopword set — small, hand-curated for resume/JD parsing.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
  'we', 'our', 'us', 'they', 'them', 'their', 'be', 'been', 'being', 'do', 'does', 'did', 'doing',
  'can', 'could', 'should', 'would', 'may', 'might', 'must', 'shall', 'so', 'if', 'then', 'than',
  'but', 'not', 'no', 'nor', 'because', 'about', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'under', 'over', 'again', 'further', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'one', 'two', 'three', 'i',
  'me', 'my', 'who', 'whom', 'which', 'what', 'these', 'those', 'am', 'doesn', 'don', 'didn',
  'haven', 'isn', 'wasn', 'weren', 'won', 'wouldn', 'couldn', 'shouldn', 'aren', 'shan',
  'she', 'his', 'her', 'him', 'hers', 'himself', 'herself', 'across',
  'also', 'well', 'within', 'including', 'every', 'rather', 'know', 'looking',
  'extremely', 'single', 'time', 'working',
  'role', 'work', 'team', 'company', 'job', 'position', 'opportunity', 'candidate', 'experience',
]);

// Report/intel meta-vocabulary — evaluator scaffolding, tracker fields, pack
// artifact names, and job-board plumbing that leaks into the term
// distribution whenever the JD source is an eval report or the intel-concat
// corpus rather than the verbatim posting. Dropped from JD-TERM RANKING for
// non-verbatim sources only — a real JD's own words are never filtered.
// Canonical incident (2026-07-08, packs 2507/2757/2758): hand-authored eval
// reports produced "JD top terms" like `block` / `recruiter` / `comp` /
// `apply` / `report` / `formatting-guide` / `2026-07-08` / `his`, driving
// false below-threshold scores and garbage "recommended additions".
export const REPORT_META_STOPWORDS = new Set([
  // report structure + evaluator vocabulary
  'block', 'blocks', 'report', 'reports', 'eval', 'evaluation', 'evaluated',
  'score', 'scored', 'scoring', 'status', 'note', 'notes', 'legitimacy',
  'archetype', 'verification', 'confirmed', 'inferred', 'bullet', 'bullets',
  'row', 'rows', 'tracker', 'annotation',
  // pack artifact names + apply plumbing
  'formatting-guide', 'formatting', 'checklist', 'one-pager', 'apply',
  'applied', 'applying', 'application', 'applications', 'apply-pack',
  'recruiter', 'recruiters', 'comp', 'pdf', 'readme',
  // job-board + link plumbing
  'linkedin', 'greenhouse', 'ashby', 'lever', 'url', 'urls', 'https', 'http', 'www',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/^[-/]+|[-/]+$/g, ''))
    .filter(t => t.length >= 3)
    // digits/date-shaped tokens ("2026", "2026-07-08", "07/08") are never JD
    // keywords — report headers made dates rank as top terms pre-2026-07-08.
    .filter(t => !/^[\d/-]+$/.test(t))
    .filter(t => !STOPWORDS.has(t));
}

function frequency(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function topN(counts, n) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function parseArgs(argv) {
  const a = { slug: null, all: false, top: 20, dryRun: false, threshold: 0.5, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug' && argv[i + 1]) { a.slug = argv[++i]; continue; }
    if (argv[i] === '--all') { a.all = true; continue; }
    if (argv[i] === '--top' && argv[i + 1]) { a.top = Number(argv[++i]); continue; }
    if (argv[i] === '--dry-run') { a.dryRun = true; continue; }
    if (argv[i] === '--threshold' && argv[i + 1]) { a.threshold = Number(argv[++i]); continue; }
    if (argv[i] === '--report' && argv[i + 1]) { a.report = argv[++i]; continue; }
  }
  return a;
}

/**
 * Resolve a pack slug to its eval report — NEVER by bare numeric prefix.
 *
 * Report numbers and tracker row numbers are INDEPENDENT num spaces (see
 * AGENTS.md § "Two num spaces"). The old fallback matched reports/ by the
 * pack's leading number, so pack 2729-lovable-* read report #2729 (Perplexity)
 * instead of the Lovable row's actual report #2730 — keyword-alignment.md then
 * scored artifacts against the WRONG JD (canonical incident 2026-06-10).
 *
 * Resolution order:
 *   1. Exact role-slug match against reports/<num>-<roleSlug>-<date>.md
 *      (both names derive from canonical buildSlug, so equality is exact;
 *      newest date wins when the same role was re-evaluated).
 *   2. Unique prefix match (slug-truncation tolerance, either direction) —
 *      only when every candidate agrees on a single role slug.
 *   3. The applications.md row's report-link column, accepted only when the
 *      linked filename shares the pack's company token (defends against the
 *      queue-num vs applications-num collision).
 *
 * Returns { path: 'reports/<file>.md', via } or null. Exported for tests.
 */
export function resolveEvalReport(packSlug, { root = ROOT } = {}) {
  const m = String(packSlug || '').match(/^(\d+)-(.+)$/);
  if (!m) return null;
  const [, rowNum, roleSlug] = m;
  const reportsDir = join(root, 'reports');
  let files = [];
  try { files = readdirSync(reportsDir).filter(f => f.endsWith('.md')); } catch { /* no reports dir */ }
  const slugOf = f => f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').replace(/\.md$/, '');

  let candidates = files.filter(f => slugOf(f) === roleSlug);
  if (candidates.length === 0) {
    candidates = files.filter(f => {
      const s = slugOf(f);
      return s.length >= 12 && roleSlug.length >= 12 && (s.startsWith(roleSlug) || roleSlug.startsWith(s));
    });
    // Prefix tolerance must be unambiguous: every candidate must be the SAME
    // role slug (e.g. a truncated pack slug must not span "…-industries" AND
    // "…-commercial" reports).
    if (new Set(candidates.map(slugOf)).size > 1) candidates = [];
  }
  if (candidates.length > 0) {
    candidates.sort(); // same slug → ISO date suffix sorts oldest→newest
    return { path: join('reports', candidates[candidates.length - 1]), via: 'slug-match' };
  }

  // applications.md report-link column, with company-token sanity check.
  try {
    const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf-8');
    const row = tracker.match(new RegExp(`^\\| *${rowNum} *\\|.*$`, 'm'))?.[0];
    const link = row && row.match(/\((reports\/[^)]+\.md)\)/)?.[1];
    if (link) {
      const companyToken = roleSlug.split('-')[0];
      if (companyToken && basename(link).toLowerCase().includes(companyToken.toLowerCase())) {
        return { path: link, via: 'applications-md-report-link' };
      }
    }
  } catch { /* tracker unavailable — fall through to null */ }
  return null;
}

// The JD source (verbatim file, report extract, or fallback corpus) must
// clear this floor before term extraction runs — a stub shouldn't starve the
// keyword gate.
const MIN_JD_CHARS = 200;

// Sources whose text IS the posting — their words are never meta-filtered.
export const VERBATIM_JD_SOURCES = new Set(['jd-verbatim.md', 'jd.md']);

/**
 * Extract the JD-BEARING text from an eval report: the Role Summary section
 * (whose Function/Seniority cells restate the posting) + the FIRST column of
 * the CV Match table (the "JD requirement" cells). Everything else in a
 * report is analysis ABOUT the candidate — Block C prose, legitimacy checks,
 * header fields, rejection-gate annotations — and tokenizing it manufactures
 * fake "JD keywords" (`block`, `recruiter`, `comp`, dates, pronouns).
 * Returns '' when neither section is found. Exported for tests.
 */
export function extractJdBearingText(reportText) {
  const text = String(reportText || '');
  // Body of the first heading matching `re`, up to the next ## heading.
  const section = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/^##\s/m);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const parts = [];
  const roleSummary = section(/^##\s*(?:[A-Z]\)\s*)?Role Summary\b.*$/im);
  if (roleSummary) parts.push(roleSummary);
  const cvMatch = section(/^##\s*(?:[A-Z]\)\s*)?CV Match\b.*$/im);
  if (cvMatch) {
    for (const line of cvMatch.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      const first = t.replace(/^\|/, '').split('|')[0].trim();
      if (!first) continue;
      if (/^:?-+:?$/.test(first)) continue;                 // separator row
      if (/^jd requirement/i.test(first)) continue;         // header row
      parts.push(first);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Load JD-source text for a pack. Returns { text, source } where source is
 * 'jd-verbatim.md' | 'jd.md' | 'report-jd-sections' | 'intel-concat'.
 * Exported for tests.
 *
 * PRIMARY — apply-pack/<slug>/jd-verbatim.md (canonical name, 2026-07-08) or
 * legacy jd.md: the verbatim posting, used ALONE. Mixing in the intel files
 * dilutes the term distribution with meta-vocabulary (`inferred`, `https`,
 * `www`, `recruiter`, `bullet`…) until the "JD top terms" stop describing
 * the job and the ≥50% gate scores artifacts against noise (canonical
 * incident: pack 049-perplexity-*, 2026-06-10 — tailored-cv.md scored 30%
 * against terms like `linkedin`/`comp`/`https` while the real JD sat unused
 * in jd.md). The verbatim file also wins over --report: the eval report is
 * an ANALYSIS of the JD, not the JD.
 *
 * SECONDARY (no verbatim file) — the eval report's JD-bearing sections ONLY
 * (Role Summary + CV Match JD-requirement cells, see extractJdBearingText),
 * used ALONE. Report resolution: explicit --report override first, slug-based
 * resolution otherwise (see resolveEvalReport). Canonical incident
 * (2026-07-08, packs 2507/2757/2758): whole-report tokenization of
 * hand-authored evals ranked report meta-vocabulary as "JD top terms".
 *
 * LAST RESORT (no verbatim file, no extractable report sections) —
 * concatenate grok-intel.md, README.md, one-pager.md, plus the full report
 * when one resolved.
 */
export function loadJdText(packDir, slug, reportOverride = null, { root = ROOT } = {}) {
  for (const name of ['jd-verbatim.md', 'jd.md']) {
    const p = join(packDir, name);
    if (existsSync(p) && statSync(p).isFile()) {
      const jd = readFileSync(p, 'utf-8');
      if (jd.trim().length >= MIN_JD_CHARS) return { text: jd, source: name };
    }
  }

  let reportText = null;
  if (reportOverride) {
    const p = isAbsolute(reportOverride) ? reportOverride : join(root, reportOverride);
    if (existsSync(p) && statSync(p).isFile()) {
      reportText = readFileSync(p, 'utf-8');
    } else {
      console.error(`WARN: --report ${reportOverride} not found — falling back to slug resolution`);
    }
  }
  if (reportText == null) {
    const resolved = resolveEvalReport(slug, { root });
    if (resolved) {
      // The applications.md report-link column can go stale (row edited,
      // report renamed/archived) — a missing file must degrade to the
      // intel-concat fallback, never throw ENOENT and kill the pack run.
      const p = join(root, resolved.path);
      if (existsSync(p) && statSync(p).isFile()) {
        reportText = readFileSync(p, 'utf-8');
      } else {
        console.error(`WARN: resolved report ${resolved.path} (via ${resolved.via}) missing on disk — falling back to intel-concat`);
      }
    }
  }
  if (reportText != null) {
    const extracted = extractJdBearingText(reportText);
    if (extracted.length >= MIN_JD_CHARS) return { text: extracted, source: 'report-jd-sections' };
  }

  const parts = [];
  for (const name of ['grok-intel.md', 'README.md', 'one-pager.md']) {
    const p = join(packDir, name);
    if (existsSync(p)) parts.push(readFileSync(p, 'utf-8'));
  }
  if (reportText != null) parts.push(reportText);
  return { text: parts.join('\n\n'), source: 'intel-concat' };
}

function loadArtifact(packDir, filename) {
  const p = join(packDir, filename);
  if (!existsSync(p)) return null;
  return { path: filename, text: readFileSync(p, 'utf-8') };
}

function scoreOverlap(jdTopTerms, artifactText) {
  const artifactTokens = new Set(tokenize(artifactText));
  const hits = [];
  const misses = [];
  for (const { term } of jdTopTerms) {
    if (artifactTokens.has(term)) hits.push(term);
    else misses.push(term);
  }
  return {
    hits,
    misses,
    score: jdTopTerms.length > 0 ? hits.length / jdTopTerms.length : 0,
  };
}

function buildReport(slug, jdTopTerms, artifactScores, threshold, jdSource) {
  const lines = [];
  lines.push(`# Keyword alignment — ${slug}`);
  lines.push('');
  lines.push(`Generated by \`scripts/jd-keyword-score.mjs\` on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push(`Threshold: ${Math.round(threshold * 100)}%. Below threshold = ATS-filter risk.`);
  const sourceNotes = {
    'jd-verbatim.md': ' (verbatim posting)',
    'jd.md': ' (verbatim posting)',
    'report-jd-sections': ' (eval report: Role Summary + CV Match JD-requirement cells only — add jd-verbatim.md to the pack for the full posting)',
    'intel-concat': ' (grok-intel + README + one-pager + eval report — add jd-verbatim.md to the pack for clean JD terms)',
  };
  lines.push(`JD source: \`${jdSource}\`${sourceNotes[jdSource] || ''}`);
  lines.push('');
  lines.push('## JD top terms');
  lines.push('');
  lines.push('| Rank | Term | Frequency |');
  lines.push('|---:|---|---:|');
  jdTopTerms.forEach((t, i) => {
    lines.push(`| ${i + 1} | \`${t.term}\` | ${t.count} |`);
  });
  lines.push('');
  lines.push('## Per-artifact overlap');
  lines.push('');
  lines.push('| Artifact | Hits | Score | Status |');
  lines.push('|---|---:|---:|---|');
  for (const a of artifactScores) {
    const pct = Math.round(a.score * 100);
    const status = a.score >= threshold ? '✅ OK' : '🟠 BELOW THRESHOLD';
    lines.push(`| \`${a.path}\` | ${a.hits.length} / ${jdTopTerms.length} | ${pct}% | ${status} |`);
  }
  lines.push('');
  lines.push('## Misses per artifact');
  lines.push('');
  for (const a of artifactScores) {
    lines.push(`### \`${a.path}\` (${a.misses.length} misses)`);
    if (a.misses.length === 0) {
      lines.push('All top JD terms present.');
    } else {
      lines.push('Recommended additions: ' + a.misses.map(t => `\`${t}\``).join(', '));
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export function processPack(packSlug, opts, { root = ROOT } = {}) {
  const packDir = join(root, 'apply-pack', packSlug);
  if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
    return { slug: packSlug, ok: false, error: 'pack_dir_not_found' };
  }

  const { text: jdText, source: jdSource } = loadJdText(packDir, packSlug, opts.report, { root });
  if (!jdText || jdText.trim().length < MIN_JD_CHARS) {
    return { slug: packSlug, ok: false, error: 'jd_text_too_short' };
  }
  let jdTokens = tokenize(jdText);
  // Non-verbatim sources carry evaluator/report meta-vocabulary — drop it
  // before ranking so the top-N describes the job, not the report.
  if (!VERBATIM_JD_SOURCES.has(jdSource)) {
    jdTokens = jdTokens.filter(t => !REPORT_META_STOPWORDS.has(t));
  }
  const jdCounts = frequency(jdTokens);
  const jdTopTerms = topN(jdCounts, opts.top);

  // CV slot: cv-tailored.md is the L6 schema-typed artifact that renders to
  // the shipped PDF — score it FIRST so the gate callers' find() lands on it;
  // legacy tailored-cv.md is also scored when present (the two render
  // surfaces can drift independently). Master cv.md is the fallback only
  // when NEITHER pack-local CV exists.
  const artifactNames = ['cv-tailored.md', 'tailored-cv.md', 'cover-letter.md', 'form-fields.md', 'one-pager.md'];
  const artifactScores = [];
  let cvCovered = false;
  for (const name of artifactNames) {
    const a = loadArtifact(packDir, name);
    if (!a) continue;
    if (name === 'cv-tailored.md' || name === 'tailored-cv.md') cvCovered = true;
    artifactScores.push({ path: a.path, ...scoreOverlap(jdTopTerms, a.text) });
  }
  if (!cvCovered) {
    try {
      const cvMdFallback = readFileSync(join(root, 'cv.md'), 'utf-8');
      artifactScores.unshift({ path: 'cv.md (fallback)', ...scoreOverlap(jdTopTerms, cvMdFallback) });
    } catch { /* no master cv.md (CI / fixture root) — score what exists */ }
  }

  const report = buildReport(packSlug, jdTopTerms, artifactScores, opts.threshold, jdSource);
  const allOk = artifactScores.every(a => a.score >= opts.threshold);

  if (opts.dryRun) {
    process.stdout.write(report);
  } else {
    const outPath = join(packDir, 'keyword-alignment.md');
    writeFileSync(outPath, report);
  }

  return {
    slug: packSlug,
    ok: allOk,
    jd_source: jdSource,
    jd_terms: jdTopTerms.map(t => t.term),
    jdTopTerms: jdTopTerms.length,
    artifacts: artifactScores.map(a => ({ path: a.path, score: Math.round(a.score * 100), misses: a.misses.length })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slugs = [];
  if (args.all) {
    const applyPackDir = join(ROOT, 'apply-pack');
    if (!existsSync(applyPackDir)) {
      console.error(`apply-pack/ directory not found at ${applyPackDir}`);
      process.exit(1);
    }
    for (const d of readdirSync(applyPackDir)) {
      if (statSync(join(applyPackDir, d)).isDirectory()) slugs.push(d);
    }
  } else if (args.slug) {
    slugs.push(args.slug);
  } else {
    console.error('Usage: node scripts/jd-keyword-score.mjs --slug <pack-slug> [--top 20] [--threshold 0.5] [--dry-run]');
    console.error('       node scripts/jd-keyword-score.mjs --all');
    process.exit(1);
  }

  const results = [];
  for (const slug of slugs) {
    results.push(processPack(slug, args));
  }

  const summary = {
    timestamp: new Date().toISOString(),
    threshold: args.threshold,
    top_n: args.top,
    packs_attempted: results.length,
    packs_ok: results.filter(r => r.ok).length,
    packs_failed: results.filter(r => !r.ok).length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.packs_failed > 0 ? 1 : 0);
}

// Import-guard: only run the CLI when executed directly (tests import
// resolveEvalReport without triggering main()).
const _isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isCli) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(2);
  });
}
