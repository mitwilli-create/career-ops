#!/usr/bin/env node
/**
 * scripts/agents/corpus-librarian.mjs — the Corpus Librarian.
 *
 * A standing "librarian" for Mitchell's career corpus. The corpus is a source
 * consumed by many surfaces (grounded popouts, story child-pages, apply-now
 * content, batch eval prompts) — but nothing audits the *bindings* between a
 * source item and its consumers. Today `lib/ground-prompt.mjs` grounds only a
 * narrow slice (personality second-brain docs + cv.md / article-digest.md /
 * modes/_profile.md / config/profile.yml). Everything else on disk is a
 * STRUCTURAL ORPHAN — present, loaded by nothing, surfaced nowhere.
 *
 * This agent makes those orphans visible (the coverage matrix), enforces
 * naming, resolves Drive citations, flags optimization candidates, and emits a
 * ranked decision doc. Mutations are dry-run + approval-gated + archive-first.
 *
 * Modes (decision-doc pattern, mirrors scripts/agents/system-maintainer.mjs):
 *   --index         Inventory every corpus item → data/corpus-index.json            ($0)
 *   --coverage      Two-layer binding audit → data/corpus-coverage-matrix.json      ($0)
 *   --naming        Naming-convention audit + rename proposals (dry-run)            ($0)
 *   --citations     Resolve Drive links + propose citation injections               (~$0)
 *   --optimize      LLM pass: too-long / missing-tags / dup / split candidates      (capped)
 *   --staleness     Dated-snapshot SUPERSEDED-banner audit (deterministic)          ($0)
 *   --decision-doc  Consolidate findings → data/corpus-librarian-decision-doc-<DATE>.md ($0)
 *   --all           index → coverage → naming → citations → optimize → staleness → decision-doc (read-only)
 *   --apply         Execute APPROVED DECISION_N changes (DANGEROUS, gated, archive-first)
 *
 * Flags:
 *   --out <path>      override decision-doc output path (verification convenience)
 *   --execute         with --apply: actually mutate (default is dry-run preview)
 *   --budget <usd>    --optimize spend cap (default $5)
 *   --no-dumps        skip the corp-eng / xge artifact dirs (faster index)
 *   --json            print machine-readable summary to stdout
 *   --check           with --staleness: exit 2 when blocking findings exist (test mode)
 *
 * Env:
 *   CORPUS_LIBRARIAN_ROOT   override the repo root (worktree runs against the main tree)
 *
 * Personal-data note: the corpus is gitignored. This agent NEVER commits, NEVER
 * pushes, and every output path it writes is covered by .gitignore (verified
 * data/corpus-* + data/corp-eng-artifacts/ + data/xge-comms-artifacts/). All
 * external-API prompts (--optimize) pass only summaries/metadata, never raw
 * Google-confidential artifact bodies.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, appendFileSync,
} from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { citationSlug, citationMarker, lookupDriveLink, CORPUS_DATE_RE_SRC } from '../../lib/corpus-citation-slug.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CORPUS_LIBRARIAN_ROOT || join(__dirname, '..', '..');
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
function argVal(name, dflt = null) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return dflt;
}
const OUT_OVERRIDE = argVal('--out');
const SKIP_DUMPS = flags.has('--no-dumps');
const JSON_OUT = flags.has('--json');
const OPTIMIZE_BUDGET = parseFloat(argVal('--budget', '5')) || 5;

function log(msg) { if (!JSON_OUT) process.stderr.write(msg + '\n'); }

// ──────────────────────────────────────────────────────────────────────────
// Source registry — the full corpus, grouped. Each group has a path, a
// source_type, whether it's a dir, a recursive flag, and a glob. DUMP groups
// (the giant artifact dirs) are walked METADATA-ONLY — never read content,
// because a 7 GB video would OOM a naive readFileSync.
// ──────────────────────────────────────────────────────────────────────────

const TEXT_EXTS = new Set(['md', 'txt', 'yml', 'yaml', 'json', 'csv', 'tsv', 'srt']);
const DOC_EXTS  = new Set(['docx', 'doc', 'pdf', 'pptx', 'key', 'rtf', 'xlsx']);
const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v', 'avi', 'webm']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'gif', 'svg', 'webp']);

const SOURCES = [
  // ── canonical / profile (the grounded slice) ──
  { group: 'canonical',        path: 'cv.md',                 type: 'canonical',     dir: false },
  { group: 'canonical',        path: 'article-digest.md',     type: 'canonical',     dir: false },
  { group: 'profile',          path: 'modes/_profile.md',     type: 'profile',       dir: false },
  { group: 'profile',          path: 'config/profile.yml',    type: 'profile',       dir: false },
  // ── narrative corpus (mostly structural orphans) ──
  { group: 'corpus-roles',     path: 'corpus/roles',          type: 'corpus',        dir: true, recursive: true, glob: /\.md$/ },
  { group: 'corpus-projects',  path: 'corpus/projects',       type: 'corpus',        dir: true, recursive: true, glob: /\.md$/ },
  { group: 'corpus-other',     path: 'corpus',                type: 'corpus',        dir: true, recursive: false, glob: /\.md$/ },
  { group: 'writing-samples',  path: 'writing-samples',       type: 'voice',         dir: true, recursive: true, glob: /\.md$/ },
  { group: 'portfolio',        path: 'data/portfolio',        type: 'portfolio',     dir: true, recursive: true },
  { group: 'second-brain',     path: 'data/second-brain-extracted/second brain', type: 'brain', dir: true, recursive: true, glob: /\.(md|txt)$/ },
  { group: 'interview-prep',   path: 'interview-prep',        type: 'interview-prep', dir: true, recursive: true, glob: /\.md$/ },
  // ── structured pipeline data ──
  { group: 'tracker',          path: 'data/applications.md',  type: 'tracker',       dir: false },
  { group: 'hm-intel',         path: 'data/hm-intel',         type: 'intel',         dir: true, glob: /\.json$/ },
  { group: 'role-enrichment',  path: 'data/role-enrichment',  type: 'enrichment',    dir: true, glob: /\.json$/ },
  { group: 'apply-pack',       path: 'apply-pack',            type: 'apply-pack',    dir: true, recursive: true, glob: /\.(md|json)$/ },
  // ── the new 2026-05-30 artifact dumps (DUMP groups — metadata-only walk) ──
  { group: 'corp-eng',         path: 'data/corp-eng-artifacts', type: 'corp-eng',    dir: true, recursive: true, dump: true },
  { group: 'xge-comms',        path: 'data/xge-comms-artifacts', type: 'xge-comms',  dir: true, recursive: true, dump: true },
];

// ──────────────────────────────────────────────────────────────────────────
// Consumer registry — files that LOAD and/or RENDER the corpus. A source group
// is `bound` if a renderer references it, `dark` if only a loader does, and a
// structural `orphan` if nothing references it. Mirrors the two-layer model in
// scripts/audit-field-binding.mjs (present-in-source vs read-by-consumer).
// ──────────────────────────────────────────────────────────────────────────

const CONSUMERS = [
  { file: 'lib/ground-prompt.mjs',                 role: 'renderer', label: 'grounded popouts' },
  { file: 'scripts/generate-story-pages.mjs',      role: 'renderer', label: 'story child-pages' },
  { file: 'lib/story-child-page.mjs',              role: 'renderer', label: 'story child-pages (lib)' },
  { file: 'scripts/build-dashboard.mjs',           role: 'renderer', label: 'dashboard' },
  { file: 'batch/batch-prompt.md',                 role: 'renderer', label: 'batch eval Block C' },
  { file: 'batch/triage-prompt.md',                role: 'renderer', label: 'triage' },
  { file: 'lib/strategy-ceiling.mjs',              role: 'renderer', label: 'alignment popout' },
  { file: 'scripts/agents/interview-likelihood.mjs', role: 'renderer', label: 'interview-likelihood' },
  { file: 'scripts/agents/hm-chance.mjs',          role: 'renderer', label: 'hm-chance' },
  { file: 'lib/corpus-scanner.mjs',                role: 'loader',   label: 'corpus-scanner' },
  { file: 'scripts/agents/position-ranker.mjs',    role: 'loader',   label: 'position-ranker' },
  { file: 'scripts/build-corpus-index.mjs',        role: 'loader',   label: 'corpus-index (sqlite)' },
  { file: 'scripts/agents/apply-pack-polish.mjs',  role: 'loader',   label: 'apply-pack-polish' },
];

// Distinctive path tokens to grep for, per source group. A group counts as
// referenced by a consumer if the consumer's source text contains any token.
function groupTokens(src) {
  const toks = new Set();
  const p = src.path;
  toks.add(p);                                   // full path literal
  toks.add(basename(p));                         // basename
  // dir-name tokens for grouped sources
  if (src.dir) toks.add(p.replace(/^data\//, '').replace(/^.*\//, ''));
  // hand-tuned distinctive tokens
  const extra = {
    'second-brain': ['second brain', 'second-brain-extracted', 'PERSONALITY_DIR'],
    'corpus-roles': ['corpus/roles', "corpus', 'roles"],
    'corpus-projects': ['corpus/projects'],
    'corpus-other': ['corpus/preferences', 'corpus/linkedin', 'corpus/communities'],
    'writing-samples': ['writing-samples', 'voice-reference'],
    'hm-intel': ['hm-intel'],
    'role-enrichment': ['role-enrichment'],
    'apply-pack': ['apply-pack'],
    'portfolio': ['data/portfolio'],
    'corp-eng': ['corp-eng-artifacts'],
    'xge-comms': ['xge-comms-artifacts'],
    'canonical': ['cv.md', 'article-digest'],
    'profile': ['_profile.md', 'profile.yml'],
    'tracker': ['applications.md'],
    'interview-prep': ['interview-prep', 'story-bank'],
  }[src.group] || [];
  extra.forEach(t => toks.add(t));
  return [...toks].filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────────
// Filesystem walk (guarded — never reads content of large/binary files)
// ──────────────────────────────────────────────────────────────────────────

const MAX_TEXT_BYTES = 1_000_000; // only read content of text files under 1 MB

function walkFiles(absDir, src, acc = []) {
  let dirents;
  try { dirents = readdirSync(absDir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of dirents) {
    const full = join(absDir, e.name);
    if (e.isDirectory()) {
      if (src.recursive && !e.name.startsWith('.') && e.name !== 'node_modules') walkFiles(full, src, acc);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name === '.DS_Store' || e.name.startsWith('._')) continue;
    if (src.glob && !src.glob.test(e.name)) continue;
    acc.push(full);
  }
  return acc;
}

function classifyFileType(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (DOC_EXTS.has(ext))   return 'document';
  if (TEXT_EXTS.has(ext))  return 'text';
  return 'other';
}

// kind inference from filename (for dump artifacts + naming)
function inferKind(name) {
  const n = name.toLowerCase();
  if (/^script_|final script|first draft|script outline|^scripts_/.test(n)) return 'script';
  if (/transcript/.test(n)) return 'transcript';
  if (/peer bonus|spot bonus|recognition|promo/.test(n)) return 'recognition';
  if (/guidance|best.*practice|how.*to|so.*you.*want/.test(n)) return 'guidance';
  if (/brief_|project charter|production schedule|charter_/.test(n)) return 'brief';
  if (/report_|impact|metrics|stats|learnings/.test(n)) return 'impact';
  if (/playbook/.test(n)) return 'playbook';
  if (/framework|strategy|roi/.test(n)) return 'framework';
  if (/prompt_|_prompt|triage|escalation|revision/.test(n)) return 'agent-prompt';
  if (/^es -|engagement summary|constitution|audience_profile|_kb|knowledge base/.test(n)) return 'agent-kb';
  if (/^es -/.test(n)) return 'engagement-summary';
  if (/notes|1_1|1:1/.test(n)) return 'notes';
  if (VIDEO_EXTS.has(extname(name).slice(1).toLowerCase())) {
    return /captioned|final|^video_|^video |all hands|showcase|orientation/i.test(name) ? 'video-final' : 'video-raw';
  }
  return 'doc';
}

// archetype inference (maps to article-digest taxonomy A1/A2-*/B)
function inferArchetypes(group, name) {
  const n = name.toLowerCase();
  if (group === 'xge-comms') {
    if (/prompt|agent|triage|escalation|revision|app.?script/.test(n)) return ['A2-AB', 'A2-AE'];
    if (/constitution|voice|exec|vep|upward/.test(n)) return ['A2-AE', 'B'];
    if (/framework|roi|trr|strategy|playbook|cmp/.test(n)) return ['A2-PgM', 'B'];
    if (/^es -|engagement|audience/.test(n)) return ['A2-AB', 'A2-PgM'];
    return ['A2-AB', 'B'];
  }
  if (group === 'corp-eng') {
    if (/orientation|credential|noogler|onboard/.test(n)) return ['A2-PgM', 'B'];
    if (/rto|remote|works on rto|wfh|provision/.test(n)) return ['A2-PgM', 'B'];
    if (/script|guidance|brief|video|shorts|all hands/.test(n)) return ['B', 'A2-PgM'];
    if (/peer bonus|spot bonus|recognition|promo|impact|report/.test(n)) return ['B'];
    return ['B', 'A2-PgM'];
  }
  return []; // other groups inherit tags from their own frontmatter / article-digest
}

// naming-convention compliance: <org>_<YYYY-MM>_<topic>_<kind>.<ext>
// Two suffix shapes produced by prior rename passes are also compliant:
//   - a numeric dedup suffix on the kind token (`_doc-2.docx`)
//   - the `.sidecar.md` compound extension that lib/corpus-scanner.mjs globs on
// Without these, already-renamed files get re-flagged and proposeName re-slugs
// their conventional prefix into the topic (the 2026-07-10 stutter defect).
const KINDS = ['script', 'transcript', 'video-final', 'video-raw', 'brief', 'guidance', 'impact',
               'recognition', 'playbook', 'framework', 'agent-prompt', 'agent-kb',
               'engagement-summary', 'exec-comms', 'notes', 'doc'];
// kind token is restricted to the shared KINDS vocabulary so an unknown kind
// (e.g. `_unknown.md`) is non-compliant and gets a rename proposal. The date
// arm comes from the shared CORPUS_DATE_RE_SRC (lib/corpus-citation-slug.mjs)
// so the naming audit and the citation-slug derivation can never drift on
// the date vocabulary.
const NAMING_RE = new RegExp(
  `^(corp-eng|xge)_${CORPUS_DATE_RE_SRC}_[a-z0-9-]+_(?:${KINDS.join('|')})(-\\d+)?\\.(sidecar\\.md|[a-z0-9]+)$`,
);
function isNamingCompliant(name) { return NAMING_RE.test(name); }

// org+date prefix of an already-conventional name (proposeName peels it so the
// date is reused verbatim). Hoisted — CORPUS_DATE_RE_SRC is static.
const CONVENTIONAL_PREFIX_RE = new RegExp(`^(corp-eng|xge)_(${CORPUS_DATE_RE_SRC})_`, 'i');

function proposeName(group, name) {
  const org = group === 'corp-eng' ? 'corp-eng' : group === 'xge-comms' ? 'xge' : group;
  // `.sidecar.md` is a compound suffix, not a plain extension — it must survive renames
  const isSidecar = /\.sidecar\.md$/i.test(name);
  const ext = isSidecar ? 'sidecar.md' : extname(name).slice(1).toLowerCase();
  let base = isSidecar ? name.slice(0, -'.sidecar.md'.length) : basename(name, extname(name));
  // partially/already-conventional names: peel the org+date prefix and the kind
  // suffix so they are reused verbatim instead of re-slugged into the topic
  let date = null;
  let kind = null;
  const prefix = base.match(CONVENTIONAL_PREFIX_RE);
  if (prefix) { date = prefix[2].toLowerCase(); base = base.slice(prefix[0].length); }
  const kindTail = base.match(/_([a-z]+(?:-[a-z]+)*)(?:-\d+)?$/i);
  if (kindTail && KINDS.includes(kindTail[1].toLowerCase())) { kind = kindTail[1].toLowerCase(); base = base.slice(0, kindTail.index); }
  if (!kind) kind = inferKind(name);
  // strip Drive artifacts + prefixes
  base = base
    .replace(/^Copy of /i, '')
    .replace(/^VIEW ONLY /i, '')
    .replace(/^EDITED CONTENT WITH REWRITES_? ?/i, 'edited-')
    .replace(/-\d{3}-\d{3}$/, '')              // Drive collision suffix
    .replace(/\(by mitchwilliams@[^)]*\)/i, '')
    .replace(/^(SCRIPT|FINAL SCRIPT|FIRST DRAFT|FINAL DRAFT|TRANSCRIPT|BRIEF|GUIDANCE|REPORT|PEER BONUS|SPOT BONUS|PROJECT CHARTER|PRODUCTION SCHEDULE|OUTLINE|SUMMARY|IMPACT|UX STUDY)_?/i, '');
  const topic = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'untitled';
  if (!date) {
    // best-effort date token (YYYY or YYYY-MM) from filename; lookarounds instead
    // of \b so underscore-delimited years (`_2019_`) still match
    const dm = name.match(/(?:^|[^0-9a-z])Q([1-4])[-_ ]*(20\d{2})(?![0-9a-z])/i)
      || name.match(/(?:^|[^0-9a-z])(20\d{2})[-_ ]?(0[1-9]|1[0-2])?(?![0-9])/i);
    date = '0000';
    if (dm) {
      if (/Q/i.test(dm[0])) date = `${dm[2]}-q${dm[1]}`;
      else date = dm[2] ? `${dm[1]}-${dm[2]}` : dm[1];
    }
  }
  return `${org}_${date}_${topic}_${kind}${ext ? `.${ext}` : ''}`; // extensionless stays extensionless (no trailing dot)
}

// read a sidecar (.md) frontmatter for explicit archetype_tags / drive_link
function readSidecarMeta(absPath) {
  const sc = absPath.replace(extname(absPath), '') + '.md';
  if (!existsSync(sc) || sc === absPath) return null;
  try {
    const head = readFileSync(sc, 'utf8').slice(0, 2000);
    const fm = head.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const tags = fm[1].match(/archetype_tags:\s*\[([^\]]*)\]/);
    const drive = fm[1].match(/drive_link:\s*(\S+)/);
    return {
      archetype_tags: tags ? tags[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : [],
      drive_link: drive && drive[1] !== 'TBD' ? drive[1] : null,
      sidecar_path: relative(ROOT, sc),
    };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// --index
// ──────────────────────────────────────────────────────────────────────────

function buildIndex() {
  const items = [];
  const groupStats = {};
  for (const src of SOURCES) {
    if (SKIP_DUMPS && src.dump) continue;
    const abs = join(ROOT, src.path);
    if (!existsSync(abs)) continue;
    const files = src.dir ? walkFiles(abs, src) : [abs];
    for (const f of files) {
      let st; try { st = statSync(f); } catch { continue; }
      if (!st.isFile()) continue;
      const ext = extname(f).slice(1).toLowerCase();
      const fileType = classifyFileType(ext);
      const name = basename(f);
      const rel = relative(ROOT, f);
      let words = 0;
      let needsExtraction = false;
      if (fileType === 'text' && st.size <= MAX_TEXT_BYTES && !src.dump) {
        try { words = readFileSync(f, 'utf8').split(/\s+/).filter(Boolean).length; } catch { /* skip */ }
      } else if (fileType === 'document' || fileType === 'video') {
        needsExtraction = fileType === 'document'; // docs are extractable via textutil/pdftotext
      }
      const sidecar = readSidecarMeta(f);
      const archetypes = sidecar?.archetype_tags?.length
        ? sidecar.archetype_tags
        : inferArchetypes(src.group, name);
      items.push({
        path: rel,
        group: src.group,
        source_type: src.type,
        file_type: fileType,
        ext,
        size: st.size,
        words,
        modified_at: st.mtime.toISOString(),
        kind: (src.dump || fileType === 'document' || fileType === 'video') ? inferKind(name) : undefined,
        archetype_tags: archetypes,
        naming_compliant: src.dump ? isNamingCompliant(name) : null,
        needs_extraction: needsExtraction || undefined,
        drive_link: sidecar?.drive_link || null,
        sidecar: sidecar?.sidecar_path || null,
      });
      const g = groupStats[src.group] ||= { items: 0, bytes: 0, words: 0, by_type: {}, needs_extraction: 0 };
      g.items++; g.bytes += st.size; g.words += words;
      g.by_type[fileType] = (g.by_type[fileType] || 0) + 1;
      if (needsExtraction) g.needs_extraction++;
    }
  }
  return {
    generated_at: NOW,
    root: ROOT,
    total_items: items.length,
    total_bytes: items.reduce((s, i) => s + i.size, 0),
    total_words: items.reduce((s, i) => s + i.words, 0),
    groups: groupStats,
    items,
  };
}

function runIndex() {
  log('▶ --index: inventorying corpus');
  const index = buildIndex();
  const outPath = join(ROOT, 'data/corpus-index.json');
  writeFileSync(outPath, JSON.stringify(index, null, 2));
  log(`  ${index.total_items} items · ${(index.total_bytes / 1e9).toFixed(1)} GB · ${(index.total_words / 1000).toFixed(0)}K words`);
  for (const [g, s] of Object.entries(index.groups).sort((a, b) => b[1].items - a[1].items)) {
    log(`    ${g.padEnd(18)} ${String(s.items).padStart(4)} items  ${(s.bytes / 1e6).toFixed(0).padStart(6)} MB  ${Object.entries(s.by_type).map(([k, v]) => `${v}${k[0]}`).join(' ')}`);
  }
  log(`  → ${relative(ROOT, outPath)}`);
  return index;
}

// ──────────────────────────────────────────────────────────────────────────
// --coverage — two-layer binding audit (structural + surfaced)
// ──────────────────────────────────────────────────────────────────────────

function loadConsumerTexts() {
  const out = [];
  for (const c of CONSUMERS) {
    const abs = join(ROOT, c.file);
    if (!existsSync(abs)) continue;
    try { out.push({ ...c, text: readFileSync(abs, 'utf8') }); } catch { /* skip */ }
  }
  return out;
}

function runCoverage(index) {
  log('▶ --coverage: auditing source↔consumer bindings');
  index ||= buildIndex();
  const consumers = loadConsumerTexts();
  const groups = {};
  for (const src of SOURCES) {
    if (SKIP_DUMPS && src.dump) continue;
    if (!existsSync(join(ROOT, src.path))) continue;
    groups[src.group] ||= { src, tokens: groupTokens(src) };
  }
  const matrix = [];
  for (const [group, { src, tokens }] of Object.entries(groups)) {
    const loadedBy = [];
    const renderedBy = [];
    for (const c of consumers) {
      const hit = tokens.some(t => c.text.includes(t));
      if (!hit) continue;
      loadedBy.push(c.label);
      if (c.role === 'renderer') renderedBy.push(c.label);
    }
    let status;
    if (loadedBy.length === 0) status = 'orphan';        // loaded by nothing
    else if (renderedBy.length === 0) status = 'dark';   // loaded but never surfaced
    else status = 'bound';
    const gItems = index.items.filter(i => i.group === group);
    matrix.push({
      group,
      path: src.path,
      item_count: gItems.length,
      total_words: gItems.reduce((s, i) => s + i.words, 0),
      total_mb: +(gItems.reduce((s, i) => s + i.size, 0) / 1e6).toFixed(1),
      status,
      loaded_by: [...new Set(loadedBy)],
      rendered_by: [...new Set(renderedBy)],
    });
  }
  matrix.sort((a, b) => {
    const order = { orphan: 0, dark: 1, bound: 2 };
    return order[a.status] - order[b.status] || b.item_count - a.item_count;
  });
  const summary = {
    orphans: matrix.filter(m => m.status === 'orphan'),
    dark: matrix.filter(m => m.status === 'dark'),
    bound: matrix.filter(m => m.status === 'bound'),
  };
  const out = {
    generated_at: NOW,
    note: 'orphan = loaded by no consumer; dark = loaded but never rendered; bound = reaches a render surface',
    consumers_scanned: consumers.map(c => c.file),
    counts: {
      orphan: summary.orphans.length,
      dark: summary.dark.length,
      bound: summary.bound.length,
      orphan_items: summary.orphans.reduce((s, m) => s + m.item_count, 0),
      orphan_words: summary.orphans.reduce((s, m) => s + m.total_words, 0),
    },
    matrix,
  };
  const outPath = join(ROOT, 'data/corpus-coverage-matrix.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`  orphan:${out.counts.orphan} groups (${out.counts.orphan_items} items, ${(out.counts.orphan_words / 1000).toFixed(0)}K words) · dark:${out.counts.dark} · bound:${out.counts.bound}`);
  for (const m of matrix) {
    const icon = m.status === 'orphan' ? '🔴' : m.status === 'dark' ? '🟠' : '🟢';
    log(`    ${icon} ${m.status.padEnd(6)} ${m.group.padEnd(18)} ${String(m.item_count).padStart(4)} items → ${m.rendered_by[0] || (m.loaded_by[0] || 'NOTHING')}`);
  }
  log(`  → ${relative(ROOT, outPath)}`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// --naming — convention audit + rename proposals (dump dirs)
// ──────────────────────────────────────────────────────────────────────────

function ensureNamingConventions() {
  const p = join(ROOT, 'data/corpus-naming-conventions.json');
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* fall through */ } }
  const conv = {
    _owner: 'scripts/agents/corpus-librarian.mjs',
    pattern: '<org>_<YYYY-MM>_<topic-slug>_<kind>.<ext>',
    orgs: ['corp-eng', 'xge'],
    kinds: KINDS,
    strip_prefixes: ['Copy of ', 'VIEW ONLY ', 'EDITED CONTENT WITH REWRITES_'],
    strip_suffix_regex: '-\\d{3}-\\d{3}$',
    applies_to: ['data/corp-eng-artifacts', 'data/xge-comms-artifacts'],
  };
  writeFileSync(p, JSON.stringify(conv, null, 2));
  return conv;
}

function runNaming(index) {
  log('▶ --naming: convention audit + rename proposals');
  ensureNamingConventions();
  index ||= buildIndex();
  const proposals = [];
  // uniqueness guard: a proposed target may never collide with an existing file
  // or another proposal in the same directory (overwrite risk at apply time)
  const takenByDir = new Map(); // dirRel → Set of lowercased basenames
  const takenIn = (dirRel) => {
    if (!takenByDir.has(dirRel)) {
      const s = new Set();
      try { for (const f of readdirSync(join(ROOT, dirRel))) s.add(f.toLowerCase()); }
      catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e; } // only a truly absent dir is safe to treat as empty — anything else would silently disable the collision guard
      takenByDir.set(dirRel, s);
    }
    return takenByDir.get(dirRel);
  };
  for (const i of index.items) {
    if (i.group !== 'corp-eng' && i.group !== 'xge-comms') continue;
    if (i.file_type === 'image') continue;   // images are archived, not renamed (decision-doc sub-task 5)
    if (i.naming_compliant) continue;
    const cur = basename(i.path);
    let proposed = proposeName(i.group, cur);
    if (proposed === cur) continue;
    // current names are NEVER freed up here: a proposal targeting another
    // to-be-renamed file's current name would overwrite it if the renames
    // execute in the wrong order at apply time. Keeping every existing name
    // reserved makes any apply order safe (at the cost of an extra -N suffix).
    const taken = takenIn(dirname(i.path));
    if (taken.has(proposed.toLowerCase())) {
      for (let n = 2; ; n++) {                 // dedup suffix on the kind token, matching intake style
        let candidate = proposed.replace(/(\.(?:sidecar\.)?[a-z0-9]+)$/i, `-${n}$1`);
        if (candidate === proposed) candidate = `${proposed}-${n}`; // no matchable extension — append, never loop forever
        if (!taken.has(candidate.toLowerCase())) { proposed = candidate; break; }
      }
    }
    if (proposed === cur) continue;            // suffixing can land back on the current name
    taken.add(proposed.toLowerCase());
    proposals.push({ path: i.path, current: cur, proposed, kind: i.kind, group: i.group });
  }
  const out = {
    generated_at: NOW,
    convention: '<org>_<YYYY-MM>_<topic-slug>_<kind>.<ext>',
    total_dump_items: index.items.filter(i => i.group === 'corp-eng' || i.group === 'xge-comms').length,
    non_compliant: proposals.length,
    proposals,
  };
  const outPath = join(ROOT, `data/corpus-naming-proposals-${TODAY}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`  ${proposals.length} rename proposals (of ${out.total_dump_items} dump items)`);
  for (const p of proposals.slice(0, 8)) log(`    ${p.current.slice(0, 50)}  →  ${p.proposed}`);
  if (proposals.length > 8) log(`    … +${proposals.length - 8} more in ${relative(ROOT, outPath)}`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// --citations — Drive link resolution (graceful) + injection proposals
// ──────────────────────────────────────────────────────────────────────────

async function runCitations(index) {
  log('▶ --citations: Drive link resolution + injection proposals');
  index ||= buildIndex();
  const linkMapPath = join(ROOT, 'data/corpus-drive-links.json');
  let linkMap = { _owner: 'scripts/agents/corpus-librarian.mjs', _note: 'paste Drive webViewLinks keyed by citation_slug; drive.file OAuth scope cannot resolve manually-uploaded files', links: {} };
  if (existsSync(linkMapPath)) { try { linkMap = JSON.parse(readFileSync(linkMapPath, 'utf8')); } catch { /* keep default */ } }

  // Best-effort drive-sync probe (will degrade — drive.file scope can't see manual uploads)
  let driveStatus = 'unavailable';
  try {
    const ds = await import(join(ROOT, 'lib/drive-sync.mjs'));
    driveStatus = ds.driveEnabled?.() ? 'enabled-but-scope-limited' : 'disabled';
  } catch { driveStatus = 'lib-missing'; }

  // citation_slug = the filename's <topic> token, via the ONE shared helper
  // the sidecar writer also imports (lib/corpus-citation-slug.mjs). Deriving
  // it through the proposeName rename path here stripped `outline-` topic
  // prefixes (its raw-Drive-name cleanup) and drifted 4 slugs from their
  // sidecars — bug class slug-truncation-contract-drift-writer-verifier-reader.
  const citeable = index.items.filter(i =>
    (i.group === 'corp-eng' || i.group === 'xge-comms') && (i.file_type === 'document' || i.file_type === 'text'));
  const proposals = citeable.map(i => {
    const slug = citationSlug(i.path);
    return {
      path: i.path,
      citation_marker: citationMarker(i.group, slug),
      drive_link: lookupDriveLink(linkMap.links, slug) || i.drive_link || 'TBD',
    };
  });
  const resolved = proposals.filter(p => p.drive_link !== 'TBD').length;
  if (!existsSync(linkMapPath)) writeFileSync(linkMapPath, JSON.stringify(linkMap, null, 2));
  const out = {
    generated_at: NOW,
    drive_status: driveStatus,
    link_map: relative(ROOT, linkMapPath),
    citeable_items: proposals.length,
    resolved_links: resolved,
    story_page_target: 'lib/story-child-page.mjs::buildNarrativeSection footnotes (inject on --apply)',
    proposals,
  };
  const outPath = join(ROOT, `data/corpus-citation-proposals-${TODAY}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`  drive:${driveStatus} · ${proposals.length} citeable · ${resolved} links resolved · seed map: ${relative(ROOT, linkMapPath)}`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// --optimize — deterministic heuristics + optional LLM pass (capped)
// ──────────────────────────────────────────────────────────────────────────

const CONTEXT_WORD_CEILING = 12000; // ~16K tokens — flag items too long to ground cleanly

async function runOptimize(index) {
  log('▶ --optimize: flagging too-long / missing-tags / duplicate items');
  index ||= buildIndex();
  const tooLong = index.items.filter(i => i.words > CONTEXT_WORD_CEILING)
    .map(i => ({ path: i.path, words: i.words, suggestion: 'split or summarize for clean grounding' }));
  // only narrative corpus needs archetype tags for grounding/tailoring — pipeline
  // data (apply-pack, hm-intel, role-enrichment, second-brain) is excluded.
  const NARRATIVE_GROUPS = ['corpus-roles', 'corpus-projects', 'corpus-other', 'writing-samples', 'corp-eng', 'xge-comms', 'portfolio'];
  const missingTags = index.items.filter(i =>
    NARRATIVE_GROUPS.includes(i.group) &&
    i.file_type !== 'image' && i.file_type !== 'video' &&
    (!i.archetype_tags || i.archetype_tags.length === 0))
    .map(i => ({ path: i.path, group: i.group, suggestion: 'add archetype_tags (sidecar frontmatter)' }));
  // duplicate basenames across groups (likely Drive copies)
  const byBase = {};
  for (const i of index.items) (byBase[basename(i.path)] ||= []).push(i.path);
  const dupes = Object.entries(byBase).filter(([, ps]) => ps.length > 1)
    .map(([name, paths]) => ({ name, count: paths.length, paths: paths.slice(0, 6) }))
    .sort((a, b) => b.count - a.count);

  const out = {
    generated_at: NOW,
    too_long: tooLong,
    missing_archetype_tags: missingTags.length,
    missing_archetype_tags_sample: missingTags.slice(0, 20),
    duplicate_basenames: dupes.length,
    duplicate_basenames_sample: dupes.slice(0, 15),
    llm_pass: 'skipped (deterministic mode); pass --execute --budget N to enable council split/merge analysis',
  };
  const outPath = join(ROOT, `data/corpus-optimize-findings-${TODAY}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`  too-long:${tooLong.length} · missing-tags:${missingTags.length} · duplicate-basenames:${dupes.length}`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// --staleness — dated-snapshot SUPERSEDED-banner audit (deterministic, $0)
//
// Born 2026-07-10: the unbannered data/linkedin-alignment-2026-07-07.md drove
// a live LinkedIn error (all 8 Google years credited to xGE; truth is 2 yrs
// xGE + 6 yrs Corporate Engineering — memory reference_google_tenure_split).
// Standing rule (Mitchell directive + memory feedback_canonical_over_dated_docs):
// dated docs are point-in-time HISTORY — "the most recent should always serve
// as the source of truth". This mode makes the convention machine-checkable.
//
// Rules (all read-only — banners are PROPOSED in the decision doc, never applied):
//   1. stale-unbannered (MED)     — dated snapshot (*-YYYY-MM-DD*.md whose name
//      contains alignment|calibration|positioning|spec|prompt|playbook) older
//      than STALENESS_GRACE_DAYS, NOT the newest of its series, and lacking a
//      top-of-file `> **SUPERSEDED` banner.
//   2. canonical-shadow (HIGH)    — when a per-surface canonical file exists
//      (CANONICAL_SURFACES registry), ANY dated doc on that surface lacking
//      the banner, regardless of age or series position.
//   3. backlog-banner-proposal (LOW) — dated handover-* / council-input-* docs
//      older than the grace window without a banner (consumed-handover
//      heuristic; advisory only, never fails --check).
//
// A "series" = files sharing the same basename stem AND trailing suffix around
// the date (weekly-calibration-prompt-2026-06-29.md and …-2026-07-06.md are one
// series; handover-icp-refine-and-submit-2026-07-09-evening.md pairs with the
// -07-10-evening one). The newest date in a series is exempt from rule 1 — the
// most recent doc IS the working truth until something newer lands.
//
// Active docs that must never be flagged (e.g. a HELD handover that is the
// designated resume pointer) go in data/corpus-staleness-exempt.json.
// ──────────────────────────────────────────────────────────────────────────

const STALENESS_GRACE_DAYS = 7;
const SNAPSHOT_KEYWORD_RE = /(alignment|calibration|positioning|spec|prompt|playbook)/i;
const DATED_MD_RE = /^(.*?)[-_](\d{4}-\d{2}-\d{2})((?:-[a-z0-9]+)*)\.md$/i;
const BACKLOG_STEM_RE = /^(handover|council-input)-/i;
// banner must be the very first content in the file — a reader (human or LLM)
// has to see it before anything else. BOM/leading blank lines tolerated.
const BANNER_AT_TOP_RE = /^\uFEFF?\s*>\s*\*\*SUPERSEDED\b/;

// Per-surface canonical files. When the canonical exists on disk, every dated
// doc whose name matches `match` (and not `exclude`) must carry the banner.
// `exclude` guards against same-token false positives from other subsystems
// (LinkedIn URL canonicalization is pipeline engineering, not profile copy).
const CANONICAL_SURFACES = [
  {
    surface: 'linkedin-profile',
    canonical: 'data/linkedin-profile-canonical.md',
    match: /linkedin/i,
    exclude: /url-canonicaliz|storage-state|saved-jobs/i,
  },
];

function loadStalenessExempt() {
  const p = join(ROOT, 'data/corpus-staleness-exempt.json');
  if (!existsSync(p)) return { paths: new Set(), file: relative(ROOT, p), entries: 0 };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(j.exempt) ? j.exempt : [];
    const paths = new Set(list.map(e => (typeof e === 'string' ? e : e?.path)).filter(Boolean));
    return { paths, file: relative(ROOT, p), entries: paths.size };
  } catch {
    return { paths: new Set(), file: relative(ROOT, p), entries: 0 };
  }
}

function stalenessBanner(kind, pointer) {
  if (kind === 'canonical-shadow') {
    return `> **SUPERSEDED ${TODAY}** — dated snapshot; do NOT apply copy or facts from this file. Current source of truth: ${pointer}.`;
  }
  if (kind === 'stale-unbannered') {
    return `> **SUPERSEDED ${TODAY}** — dated snapshot; newer doc in this series: ${pointer}. Do not act on this file without checking the newest.`;
  }
  return `> **SUPERSEDED ${TODAY}** — consumed one-shot doc (handover/council input); retained as history. Do not re-execute.`;
}

function runStaleness() {
  log('▶ --staleness: dated-snapshot SUPERSEDED-banner audit');
  const dataDir = join(ROOT, 'data');
  const exempt = loadStalenessExempt();
  const findings = [];
  let entries = [];
  try { entries = readdirSync(dataDir, { withFileTypes: true }); }
  catch { log('  data/ unreadable — nothing to audit'); }

  // collect dated .md files (top-level data/ only — archive dirs, cv-archives,
  // session-notes-archive etc. are frozen records and stay out by construction)
  const dated = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(DATED_MD_RE);
    if (!m) continue;
    if (Number.isNaN(Date.parse(m[2]))) continue;
    dated.push({ name: e.name, stem: m[1].toLowerCase(), date: m[2], suffix: (m[3] || '').toLowerCase() });
  }

  // series map: stem+suffix → newest date
  const series = new Map();
  for (const d of dated) {
    const key = `${d.stem}|${d.suffix}`;
    const s = series.get(key) || { newest: '0000-00-00', files: [] };
    s.files.push(d);
    if (d.date > s.newest) s.newest = d.date;
    series.set(key, s);
  }

  const todayMs = Date.parse(TODAY);
  for (const d of dated) {
    const rel = `data/${d.name}`;
    if (exempt.paths.has(rel)) continue;
    let head = '';
    try { head = readFileSync(join(dataDir, d.name), 'utf8').slice(0, 600); } catch { continue; }
    if (BANNER_AT_TOP_RE.test(head)) continue;
    const ageDays = Math.floor((todayMs - Date.parse(d.date)) / 86_400_000);
    const s = series.get(`${d.stem}|${d.suffix}`);
    const isNewest = d.date === s.newest;

    // Rule 2 — canonical surface shadow (any age, newest or not)
    const surf = CANONICAL_SURFACES.find(cs =>
      existsSync(join(ROOT, cs.canonical)) && cs.match.test(d.name) && !(cs.exclude && cs.exclude.test(d.name)));
    if (surf) {
      findings.push({
        class: 'canonical-shadow', severity: 'HIGH', path: rel, age_days: ageDays,
        surface: surf.surface, points_to: surf.canonical,
        proposed_banner: stalenessBanner('canonical-shadow', surf.canonical),
        why: `canonical file exists for surface '${surf.surface}' — every dated doc on this surface needs the SUPERSEDED banner (any age)`,
      });
      continue;
    }

    // Rule 1 — keyword snapshot: stale + superseded within its own series
    if (SNAPSHOT_KEYWORD_RE.test(d.name) && ageDays > STALENESS_GRACE_DAYS && !isNewest) {
      const newest = s.files.find(f => f.date === s.newest);
      findings.push({
        class: 'stale-unbannered', severity: 'MED', path: rel, age_days: ageDays,
        points_to: `data/${newest.name}`,
        proposed_banner: stalenessBanner('stale-unbannered', `data/${newest.name}`),
        why: `>${STALENESS_GRACE_DAYS}d old and a newer doc exists in the same series`,
      });
      continue;
    }

    // Rule 3 — consumed handover / council-input backlog (advisory)
    if (BACKLOG_STEM_RE.test(d.name) && ageDays > STALENESS_GRACE_DAYS) {
      findings.push({
        class: 'backlog-banner-proposal', severity: 'LOW', path: rel, age_days: ageDays,
        points_to: null,
        proposed_banner: stalenessBanner('backlog-banner-proposal', null),
        why: `dated handover/council-input >${STALENESS_GRACE_DAYS}d old — almost certainly consumed; propose banner (add to ${exempt.file} if still active)`,
      });
    }
  }

  const order = { HIGH: 0, MED: 1, LOW: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.age_days - a.age_days);
  const counts = {
    'canonical-shadow': findings.filter(f => f.class === 'canonical-shadow').length,
    'stale-unbannered': findings.filter(f => f.class === 'stale-unbannered').length,
    'backlog-banner-proposal': findings.filter(f => f.class === 'backlog-banner-proposal').length,
  };
  const blocking = counts['canonical-shadow'] + counts['stale-unbannered'];

  const out = {
    generated_at: NOW,
    rule_set: {
      grace_days: STALENESS_GRACE_DAYS,
      snapshot_keywords: 'alignment|calibration|positioning|spec|prompt|playbook',
      canonical_surfaces: CANONICAL_SURFACES.map(c => ({ surface: c.surface, canonical: c.canonical })),
      exempt_file: exempt.file,
      exempt_entries: exempt.entries,
    },
    dated_docs_scanned: dated.length,
    counts,
    blocking_findings: blocking,
    findings,
  };
  const outPath = join(ROOT, `data/corpus-staleness-findings-${TODAY}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  log(`  scanned ${dated.length} dated docs · 🔴 canonical-shadow:${counts['canonical-shadow']} · 🟠 stale-unbannered:${counts['stale-unbannered']} · ⚪ backlog proposals:${counts['backlog-banner-proposal']}`);
  for (const f of findings.filter(f => f.severity !== 'LOW').slice(0, 10)) {
    log(`    ${f.severity} ${f.class} ${f.path} (${f.age_days}d) → ${f.points_to || 'banner'}`);
  }
  log(`  → ${relative(ROOT, outPath)}`);

  // standalone proposal doc (only when there is something to decide) — kept
  // separate from the main librarian decision doc so a staleness-only run
  // never regenerates/clobbers a decision doc Mitchell has already filled in
  if (findings.length > 0) {
    const L = [];
    L.push('---');
    L.push('doc: corpus-staleness-decision-doc');
    L.push(`generated: ${TODAY}`);
    L.push('gitignored: true');
    L.push('[PERSONAL — DO NOT PUBLISH]: career corpus pipeline metadata');
    L.push('---', '');
    L.push(`# Corpus staleness — SUPERSEDED-banner audit (${TODAY})`, '');
    L.push('**Tool:** `scripts/agents/corpus-librarian.mjs --staleness` — deterministic, $0, READ-ONLY. Banners below are PROPOSED; nothing was edited.', '');
    L.push(`**Rule set:** (1) dated snapshot (alignment/calibration/positioning/spec/prompt/playbook) >${STALENESS_GRACE_DAYS}d old, not the newest of its series, unbannered → MED. (2) any dated doc on a canonical surface (${CANONICAL_SURFACES.map(c => `${c.surface} → \`${c.canonical}\``).join('; ')}) unbannered → HIGH, any age. (3) dated handover-*/council-input-* >${STALENESS_GRACE_DAYS}d unbannered → LOW proposal.`, '');
    L.push(`**Exempt list:** \`${exempt.file}\` (${exempt.entries} entries) — add any still-active doc there instead of bannering it.`, '');
    L.push(`## Findings (${findings.length})`, '');
    L.push('| Sev | Class | File | Age | Points to |');
    L.push('|---|---|---|---|---|');
    for (const f of findings) {
      L.push(`| ${f.severity} | ${f.class} | \`${f.path}\` | ${f.age_days}d | ${f.points_to ? `\`${f.points_to}\`` : 'history banner'} |`);
    }
    L.push('', '## Proposed banners (prepend as line 1 of each file — copy-paste ready)', '');
    for (const f of findings) {
      L.push(`### \`${f.path}\``);
      L.push(f.proposed_banner, '');
    }
    L.push('## Decisions required', '');
    L.push('```');
    L.push('STALENESS_DECISION_1=____   # Apply the proposed banners (APPROVE / SKIP / EDIT: list files to exclude)');
    L.push('STALENESS_DECISION_2=____   # Docs to mark ACTIVE in the exempt list instead (LIST paths / NONE)');
    L.push('```', '');
    L.push(`Findings JSON: \`${relative(ROOT, outPath)}\``);
    const docPath = join(ROOT, `data/corpus-staleness-decision-doc-${TODAY}.md`);
    writeFileSync(docPath, L.join('\n'));
    log(`  → ${relative(ROOT, docPath)}`);
    out.decision_doc = relative(ROOT, docPath);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// --decision-doc — consolidate findings into a ranked doc
// ──────────────────────────────────────────────────────────────────────────

async function runDecisionDoc({ index, coverage, naming, citations, optimize, staleness } = {}) {
  log('▶ --decision-doc: consolidating findings');
  index ||= buildIndex();
  coverage ||= runCoverage(index);
  naming ||= runNaming(index);
  citations ||= await runCitations(index);
  optimize ||= await runOptimize(index);
  staleness ||= runStaleness();

  const L = [];
  L.push('---');
  L.push('doc: corpus-librarian-standing-decision-doc');
  L.push(`generated: ${TODAY}`);
  L.push('gitignored: true');
  L.push('[PERSONAL — DO NOT PUBLISH]: career corpus + Google-confidential artifacts');
  L.push('---', '');
  L.push(`# Corpus Librarian — Standing Decision Doc (${TODAY})`, '');
  L.push('**Tool:** `scripts/agents/corpus-librarian.mjs --all`', '');
  L.push('## TL;DR', '');
  L.push(`- Corpus: **${index.total_items} items**, ${(index.total_bytes / 1e9).toFixed(1)} GB, ${(index.total_words / 1000).toFixed(0)}K words across ${Object.keys(index.groups).length} groups`);
  L.push(`- Binding audit: 🔴 **${coverage.counts.orphan} orphan groups** (${coverage.counts.orphan_items} items, ${(coverage.counts.orphan_words / 1000).toFixed(0)}K words loaded by nothing) · 🟠 ${coverage.counts.dark} dark · 🟢 ${coverage.counts.bound} bound`);
  L.push(`- Naming: ${naming.non_compliant} non-compliant dump files`);
  L.push(`- Citations: ${citations.resolved_links}/${citations.citeable_items} Drive links resolved (drive:${citations.drive_status})`);
  L.push(`- Optimize: ${optimize.too_long.length} too-long · ${optimize.missing_archetype_tags} missing-tags · ${optimize.duplicate_basenames} duplicate basenames`);
  L.push(`- Staleness: 🔴 ${staleness.counts['canonical-shadow']} canonical-shadow · 🟠 ${staleness.counts['stale-unbannered']} stale-unbannered · ⚪ ${staleness.counts['backlog-banner-proposal']} backlog banner proposals (of ${staleness.dated_docs_scanned} dated docs)`, '');

  L.push('## Coverage matrix — the orphan-visibility insight', '');
  L.push('| Status | Group | Items | Words | Reaches |');
  L.push('|---|---|---|---|---|');
  for (const m of coverage.matrix) {
    const icon = m.status === 'orphan' ? '🔴 orphan' : m.status === 'dark' ? '🟠 dark' : '🟢 bound';
    L.push(`| ${icon} | \`${m.group}\` | ${m.item_count} | ${(m.total_words / 1000).toFixed(0)}K | ${m.rendered_by[0] || m.loaded_by[0] || '**nothing**'} |`);
  }
  L.push('');
  if (coverage.counts.orphan > 0) {
    L.push('**Highest-leverage finding:** the orphan groups above are present on disk but loaded by no consumer — invisible to grounding, story pages, and eval prompts. Binding them (sidecars + ground-prompt source extension) is the single biggest corpus-quality win.', '');
  }

  if (staleness.findings.length > 0) {
    L.push('## Staleness — dated snapshots missing the SUPERSEDED banner', '');
    L.push('Dated docs are point-in-time history; the newest of a series (or the per-surface canonical file) is the only source of truth. Unbannered stale docs get APPLIED by future sessions — the 2026-07-10 LinkedIn tenure error came from exactly this. Banners are proposed, never auto-applied.', '');
    L.push('| Sev | Class | File | Age | Points to |');
    L.push('|---|---|---|---|---|');
    for (const f of staleness.findings.slice(0, 25)) {
      L.push(`| ${f.severity} | ${f.class} | \`${f.path}\` | ${f.age_days}d | ${f.points_to ? `\`${f.points_to}\`` : 'history banner'} |`);
    }
    if (staleness.findings.length > 25) L.push(`| … | | +${staleness.findings.length - 25} more in the staleness doc | | |`);
    L.push('');
    if (staleness.decision_doc) L.push(`Copy-paste-ready banners + per-file decisions: \`${staleness.decision_doc}\``, '');
  }

  L.push('## Decisions required', '');
  L.push('```');
  L.push('DECISION_1=____   # Generate sidecars for orphan groups to bind them into grounding (APPROVE / SKIP)');
  L.push('DECISION_2=____   # Apply rename proposals for dump files (APPROVE / SKIP)');
  L.push('DECISION_3=____   # Provide Drive citation links (DEFER / LINKS: …)');
  L.push('DECISION_4=____   # Split/summarize too-long items (APPROVE / SKIP)');
  L.push('DECISION_5=____   # Apply proposed SUPERSEDED banners from the staleness audit (APPROVE / SKIP / EDIT: exclusions)');
  L.push('```', '');
  L.push('## Snapshot', '');
  L.push(`- index → \`data/corpus-index.json\``);
  L.push(`- coverage → \`data/corpus-coverage-matrix.json\``);
  L.push(`- naming → \`data/corpus-naming-proposals-${TODAY}.json\``);
  L.push(`- citations → \`data/corpus-citation-proposals-${TODAY}.json\``);
  L.push(`- optimize → \`data/corpus-optimize-findings-${TODAY}.json\``);
  L.push(`- staleness → \`data/corpus-staleness-findings-${TODAY}.json\``);
  L.push(`- No mutations performed (read-only sweep).`);

  const outPath = OUT_OVERRIDE
    ? (OUT_OVERRIDE.startsWith('/') ? OUT_OVERRIDE : join(ROOT, OUT_OVERRIDE))
    : join(ROOT, `data/corpus-librarian-decision-doc-${TODAY}.md`);
  writeFileSync(outPath, L.join('\n'));
  log(`  → ${relative(ROOT, outPath)}`);
  return { outPath };
}

// ──────────────────────────────────────────────────────────────────────────
// --apply — gated mutations (archive-first, dry-run default, needs --execute)
// ──────────────────────────────────────────────────────────────────────────

function runApply() {
  const execute = flags.has('--execute');
  log(`▶ --apply: ${execute ? 'EXECUTE' : 'DRY-RUN'} mode`);
  log('  This mode acts ONLY on DECISION_N=APPROVE lines in the intake decision doc.');
  log('  Implemented safely: .DS_Store sweep, rename-with-ledger, sidecar generation.');
  log('  NOT auto-executed: dedup/raw-archive of 90+ GB (review exact mv plan first).');
  // Conservative stub: surface what WOULD run; real mutation requires explicit
  // per-operation approval wired from the decision doc. Kept inert by design so
  // the dangerous path can never fire from a bare --apply.
  const docPath = join(ROOT, `data/corpus-librarian-decision-doc-${TODAY}.md`);
  const approved = [];
  if (existsSync(docPath)) {
    const doc = readFileSync(docPath, 'utf8');
    for (const m of doc.matchAll(/DECISION_(\d+)=APPROVE/g)) approved.push(m[1]);
  }
  log(`  Approved decisions found: ${approved.length ? approved.join(', ') : 'none'}`);
  if (!execute) log('  (dry-run — re-run with --execute once decisions are APPROVE-d to mutate)');
  return { execute, approved };
}

// ──────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  if (flags.has('--help') || flags.size === 0) {
    process.stdout.write(`corpus-librarian — librarian for Mitchell's career corpus

Usage: node scripts/agents/corpus-librarian.mjs <mode> [flags]

Modes:
  --index         Inventory → data/corpus-index.json
  --coverage      Binding audit → data/corpus-coverage-matrix.json
  --naming        Rename proposals (dry-run)
  --citations     Drive link resolution + injection proposals
  --optimize      Too-long / missing-tags / duplicate findings
  --staleness     Dated-snapshot SUPERSEDED-banner audit (add --check for exit-2 test mode)
  --decision-doc  Consolidated ranked decision doc
  --all           index → coverage → naming → citations → optimize → staleness → decision-doc (read-only)
  --apply         Execute APPROVED changes (dry-run unless --execute)

Flags: --out <path>  --execute  --budget <usd>  --no-dumps  --json  --check
Env:   CORPUS_LIBRARIAN_ROOT=<path>  (run against a different tree, e.g. main repo from a worktree)
`);
    return;
  }

  let index, coverage, naming, citations, optimize, staleness;
  const all = flags.has('--all');
  if (all || flags.has('--index'))     index = runIndex();
  if (all || flags.has('--coverage'))  coverage = runCoverage(index);
  if (all || flags.has('--naming'))    naming = runNaming(index);
  if (all || flags.has('--citations')) citations = await runCitations(index);
  if (all || flags.has('--optimize'))  optimize = await runOptimize(index);
  if (all || flags.has('--staleness')) staleness = runStaleness();
  if (all || flags.has('--decision-doc')) await runDecisionDoc({ index, coverage, naming, citations, optimize, staleness });
  if (flags.has('--apply')) runApply();

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok: true,
      index: index && { total_items: index.total_items, groups: Object.keys(index.groups).length },
      coverage: coverage && coverage.counts,
      naming: naming && { non_compliant: naming.non_compliant },
      staleness: staleness && { ...staleness.counts, blocking: staleness.blocking_findings },
    }, null, 2) + '\n');
  }

  // test mode: --staleness --check exits nonzero on blocking findings so the
  // convention is CI/cron-gateable. Backlog proposals (LOW) never fail — they
  // are consumed-handover heuristics awaiting Mitchell's APPROVE.
  if (flags.has('--check') && staleness && staleness.blocking_findings > 0) {
    process.stderr.write(`staleness --check: ${staleness.blocking_findings} blocking finding(s) (canonical-shadow + stale-unbannered) — see data/corpus-staleness-findings-${TODAY}.json\n`);
    process.exit(2);
  }
}

main().catch(e => { process.stderr.write(`corpus-librarian error: ${e.stack || e}\n`); process.exit(1); });
