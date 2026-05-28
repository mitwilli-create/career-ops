// lib/persona-learning-loop.mjs
//
// Wave 2 task 10 of 14. The learning loop closes the catalog-aware-persona
// system. Three responsibilities:
//
//   1. readCatalogBugClasses()  — parse the bug-class names from AGENTS.md
//      (in-repo) + ~/.claude/knowledge/brain/bug-class-catalog.md (if present;
//      outside-repo personal knowledge). Used by persona prompts as the
//      authoritative vocabulary.
//
//   2. analyzeFindingsForNewBugClasses(opts) — read the rolling findings
//      ledger and surface bug_class names returned by personas that are
//      NOT in the catalog. ≥3 occurrences within window = candidate for a
//      new catalog entry.
//
//   3. proposeNewBugClassOmega(candidates) — write a NEEDS-APPROVAL omega
//      proposal so Mitchell can review + decide whether to add the new
//      bug-class entry to AGENTS.md.
//
// Counter-bug: regression-guard-cross-fork-leak — the catalog readers
// return BUG-CLASS NAMES only (public taxonomy strings), NEVER finding
// content or sensitive-path quotes.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');
const BRAIN_CATALOG = join(homedir(), '.claude', 'knowledge', 'brain', 'bug-class-catalog.md');
const FINDINGS_LEDGER = join(REPO_ROOT, 'data', 'persona-findings.jsonl');
const PROPOSALS_DIR = join(REPO_ROOT, 'data');

/**
 * Parse bug-class names from AGENTS.md + brain catalog (if present).
 *
 * Bug classes in AGENTS.md are introduced via `### Bug class: <name>` or
 * `## Bug class: <name>` headings.
 *
 * @returns {{ names: Set<string>, sources: string[] }}
 */
export function readCatalogBugClasses() {
  const names = new Set();
  const sources = [];

  // AGENTS.md (in-repo)
  if (existsSync(AGENTS_MD)) {
    try {
      const md = readFileSync(AGENTS_MD, 'utf-8');
      const re = /^#{2,4}\s+Bug class:\s+([a-z0-9][a-z0-9-]*[a-z0-9])/gim;
      let m;
      while ((m = re.exec(md))) {
        names.add(m[1].toLowerCase());
      }
      sources.push('AGENTS.md');
    } catch { /* read failure — skip */ }
  }

  // Brain catalog (outside-repo; optional)
  if (existsSync(BRAIN_CATALOG)) {
    try {
      const md = readFileSync(BRAIN_CATALOG, 'utf-8');
      // Brain catalog uses "Pattern X — <name>" headings + bug-class catalog patterns
      const reHeading = /^#{2,4}\s+Bug class:\s+([a-z0-9][a-z0-9-]*[a-z0-9])/gim;
      let m;
      while ((m = reHeading.exec(md))) {
        names.add(m[1].toLowerCase());
      }
      const rePattern = /^#{2,4}\s+Pattern\s+[A-Z0-9]+\s+[—-]\s+([a-z0-9][a-z0-9-]*[a-z0-9])/gim;
      while ((m = rePattern.exec(md))) {
        names.add(m[1].toLowerCase());
      }
      sources.push('~/.claude/knowledge/brain/bug-class-catalog.md');
    } catch { /* read failure — skip */ }
  }

  return { names, sources };
}

/**
 * Read findings ledger for the trailing `windowDays` days, group by
 * bug_class, return classes with ≥minOccurrences that are NOT in the
 * catalog.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays=30]      — trailing window
 * @param {number} [opts.minOccurrences=3]   — min finding count to surface
 * @param {string} [opts.ledgerPath]         — override findings path
 * @returns {object[]} candidates — sorted by occurrence count desc
 */
export function analyzeFindingsForNewBugClasses(opts = {}) {
  const windowDays = opts.windowDays || 30;
  const minOccurrences = opts.minOccurrences || 3;
  const ledgerPath = opts.ledgerPath || FINDINGS_LEDGER;

  if (!existsSync(ledgerPath)) {
    return { candidates: [], totalFindings: 0, catalogSize: 0, windowDays, minOccurrences };
  }

  const { names: catalogNames } = readCatalogBugClasses();

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const groupedByClass = new Map();
  let totalFindings = 0;

  const raw = readFileSync(ledgerPath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !rec.bug_class) continue;
    const ts = Date.parse(rec.first_seen || rec.last_updated || rec.date || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const bc = String(rec.bug_class).toLowerCase().trim();
    if (!bc || bc === 'unspecified') continue;
    totalFindings++;
    if (!groupedByClass.has(bc)) groupedByClass.set(bc, []);
    groupedByClass.get(bc).push({
      persona: rec.persona,
      severity: rec.severity,
      date: rec.date,
      // hash_only — NEVER inline finding content per cross-fork-leak guard
      finding_hash: hashShort(rec.finding || ''),
    });
  }

  const candidates = [];
  for (const [bc, occurrences] of groupedByClass.entries()) {
    if (catalogNames.has(bc)) continue; // already in catalog; not a candidate
    if (occurrences.length < minOccurrences) continue;
    candidates.push({
      bug_class: bc,
      occurrence_count: occurrences.length,
      personas: Array.from(new Set(occurrences.map(o => o.persona).filter(Boolean))),
      severity_distribution: tally(occurrences.map(o => o.severity)),
      first_seen_date: occurrences.map(o => o.date).sort()[0],
      occurrences_hashed: occurrences.slice(0, 10),
    });
  }
  candidates.sort((a, b) => b.occurrence_count - a.occurrence_count);

  return {
    candidates,
    totalFindings,
    catalogSize: catalogNames.size,
    windowDays,
    minOccurrences,
  };
}

function tally(arr) {
  const m = {};
  for (const x of arr) {
    const k = String(x || 'UNKNOWN').toUpperCase();
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function hashShort(s) {
  // Simple non-crypto hash for stability + privacy. NEVER include source content.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * Write a NEEDS-APPROVAL omega proposal for each candidate bug-class.
 * Returns the proposal file path (one file per call; date-stamped).
 *
 * Always prefixes with [PERSONAL — DO NOT PUBLISH] frontmatter per the
 * cross-fork-leak policy.
 *
 * @param {object[]} candidates — output of analyzeFindingsForNewBugClasses().candidates
 * @returns {string|null} path written, or null if no candidates
 */
export function proposeNewBugClassOmega(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (!existsSync(PROPOSALS_DIR)) mkdirSync(PROPOSALS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const path = join(PROPOSALS_DIR, `persona-new-bugclass-candidates-${date}.md`);

  const lines = [
    '---',
    'title: Persona-Surfaced New Bug-Class Candidates',
    `date: ${date}`,
    'status: NEEDS-APPROVAL',
    'classification: "[PERSONAL — DO NOT PUBLISH]"',
    'source: lib/persona-learning-loop.mjs',
    `candidate_count: ${candidates.length}`,
    '---',
    '',
    '# Persona-Surfaced New Bug-Class Candidates',
    '',
    'Personas observed these `bug_class` strings in their findings, but they are',
    'NOT in the current AGENTS.md / brain-catalog vocabulary. Each is a candidate',
    'for a new catalog entry.',
    '',
    'Append your approval (or rejection) to `data/omega-approvals.md` referencing',
    'the candidate name. Approved candidates should be added to AGENTS.md under',
    'a new "Bug class: <name>" heading with the standard structure (bug pattern,',
    'safe pattern, canonical incident).',
    '',
    '## Candidates',
    '',
    '| # | bug_class | count | personas | severity dist | first seen |',
    '|---|---|---|---|---|---|',
    ...candidates.map((c, i) => [
      i + 1,
      c.bug_class,
      c.occurrence_count,
      c.personas.join('+') || '(none)',
      Object.entries(c.severity_distribution).map(([k, v]) => `${k}:${v}`).join(', '),
      c.first_seen_date || '(unknown)',
    ].join(' | ')),
    '',
    '## Details (hash_only — finding content withheld per cross-fork-leak guard)',
    '',
    ...candidates.flatMap(c => [
      `### ${c.bug_class} (${c.occurrence_count} occurrences)`,
      `- Personas: ${c.personas.join(', ') || '(unspecified)'}`,
      `- First seen: ${c.first_seen_date || '(unknown)'}`,
      `- Severity distribution: ${JSON.stringify(c.severity_distribution)}`,
      `- Finding hashes: ${c.occurrences_hashed.map(o => o.finding_hash).slice(0, 5).join(', ')}${c.occurrences_hashed.length > 5 ? ' (+more)' : ''}`,
      '',
    ]),
  ];

  try {
    appendFileSync(path, lines.join('\n'));
    return path;
  } catch (e) {
    // Never crash on file write — return null to signal failure
    return null;
  }
}
