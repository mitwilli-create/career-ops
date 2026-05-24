// lib/bug-resolver/ledger.mjs
//
// Bug-ledger I/O. JSONL append-only with atomic rewrite for updates.
// Schema: data/bug-resolver-plan.md § 1.2.
//
// Each ledger entry represents one tracked bug. The ledger is the authoritative
// state object the bug-resolver orchestrator walks (Mon/Thu 02:00 PT in Phase 2).
// The intake mapper (Phase 1) is the only writer that APPENDS new entries;
// the resolver UPDATES existing entries' status/vendor_log/etc as it processes them.

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const LEDGER_PATH = join(REPO_ROOT, 'data/bug-ledger.jsonl');

export function ledgerPath() {
  return LEDGER_PATH;
}

// Returns Array<LedgerEntry>. Empty array if file missing.
// Malformed lines are skipped silently (defensive — never throw on corrupt entries).
export function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = readFileSync(LEDGER_PATH, 'utf-8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  return entries;
}

// Append-only write. Caller is responsible for ensuring the entry doesn't
// already exist (use entryByHash for dedup).
export function appendEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(LEDGER_PATH, line);
}

// Atomic update via tmp + rename. Throws if id not found.
export function updateEntry(id, updates) {
  const entries = loadLedger();
  let updated = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === id) {
      entries[i] = {
        ...entries[i],
        ...updates,
        last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      updated = true;
      break;
    }
  }
  if (!updated) throw new Error(`updateEntry: id "${id}" not found in ledger`);
  const tmpPath = LEDGER_PATH + '.tmp';
  const body = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(tmpPath, body);
  renameSync(tmpPath, LEDGER_PATH);
}

// Find existing entry by source_hash. Used by intake mapper for dedup.
// Returns the full entry, or null if none.
export function entryByHash(hash) {
  return loadLedger().find(e => e.source_hash === hash) || null;
}

// Generate next sequential ID for a given date stamp ("YYYY-MM-DD").
// Format: bug-YYYY-MM-DD-NNN (3-digit zero-padded).
export function nextId(dateStamp) {
  const entries = loadLedger();
  const prefix = `bug-${dateStamp}-`;
  let max = 0;
  for (const e of entries) {
    if (typeof e.id === 'string' && e.id.startsWith(prefix)) {
      const n = parseInt(e.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `bug-${dateStamp}-${String(max + 1).padStart(3, '0')}`;
}

// Convert a RawBugEntry from a surface reader into a full LedgerEntry.
export function makeNewEntry({ raw, id, ptNow }) {
  return {
    id,
    first_seen: raw.first_seen_iso,
    last_updated: ptNow,
    source_surface: raw.source_surface,
    source_hash: raw.source_hash,
    title: raw.title,
    severity: raw.severity,
    status: 'OPEN',
    bug_class: raw.bug_class,
    owner: 'bug-resolver',
    blast_radius: 'low', // default; resolver can reassess in Phase 2
    linked_to: null, // set by linkEntries() during Phase 2 semantic dedup
    draft_pr_url: null,
    resolution_commit: null,
    hardening_doc: null,
    vendor_log: [],
    total_cost_usd: 0,
    needs_human_reasons: [],
    verification_runs: [],
    intake_metadata: {
      is_sensitive_source: raw.is_sensitive_source,
      summary: raw.summary,
    },
  };
}

// Mark a bug as a semantic duplicate of another. Sets status='WONT_FIX' on
// the duplicate + linked_to pointer to the canonical entry. Used by Phase 2's
// audit phase after the LLM determines two bugs are the same underlying issue.
export function linkEntries(dupeId, canonicalId, reason = 'semantic-duplicate') {
  updateEntry(dupeId, {
    status: 'WONT_FIX',
    linked_to: canonicalId,
    needs_human_reasons: [`Linked to ${canonicalId}: ${reason}`],
  });
}

// Heuristic candidate-dup finder. Returns up to maxN OPEN entries that share
// bug_class, source-surface dir prefix, or significant title-token overlap
// with the input entry. NOT a semantic check — just a cheap filter so the LLM
// audit phase has 1-5 candidates to compare instead of every OPEN entry.
export function findCandidateDupes(entry, maxN = 5) {
  const all = loadLedger();
  const open = all.filter(e =>
    e.status === 'OPEN' &&
    e.id !== entry.id &&
    !e.linked_to
  );
  if (open.length === 0) return [];

  const entryTokens = tokenize(entry.title);
  const entrySurfacePrefix = surfaceDir(entry.source_surface);

  const scored = open.map(e => {
    let score = 0;
    if (e.bug_class && e.bug_class === entry.bug_class) score += 3;
    if (surfaceDir(e.source_surface) === entrySurfacePrefix) score += 1;
    const overlap = jaccardOverlap(entryTokens, tokenize(e.title));
    score += overlap * 2;
    return { entry: e, score };
  });

  return scored
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxN)
    .map(s => s.entry);
}

function tokenize(s) {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function jaccardOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function surfaceDir(surface) {
  const s = String(surface || '');
  if (s.startsWith('transcript:') || s.startsWith('memory:') || s.startsWith('github://')) {
    return s.split(/[:/]/, 2)[0];
  }
  const lastSlash = s.lastIndexOf('/');
  return lastSlash > 0 ? s.slice(0, lastSlash) : s;
}
