// lib/bug-resolver/regression-queue.mjs
//
// v2 (2026-05-25) — bridge between regression-guard findings and bug-resolver.
// Append-only JSONL at data/regression-bug-queue.jsonl. Each entry wraps ONE
// regression-guard finding into a bug-ledger-compatible LedgerEntry shape so
// the bug-resolver pipeline can process it identically to a hand-filed bug.
//
// Spec: data/decisions-pending-regression-auto-action-2026-05-25.md (gitignored)
// Change #1 of 10 in the v2 autonomous-remediation pipeline.
//
// Schema (one JSON per line):
//   {
//     id: "rg-YYYY-MM-DD-NNN",
//     source: "regression-guard",
//     first_seen: "...iso...",
//     last_updated: "...iso...",
//     regression_citation_hash: "<sha256-12char>",     // dedup key
//     v2_pipeline_state: "PENDING" | "IN_PROGRESS" | "DRAFT_PR" |
//                        "MERGED" | "VERIFIED" | "REVERTED",
//     ledger_shape: { ...bug-ledger-compatible LedgerEntry... },
//   }
//
// Routing contract:
//   - id prefix "rg-"   → this file
//   - id prefix "bug-"  → data/bug-ledger.jsonl (existing)
//   - lib/bug-resolver/unified-queue.mjs is the single entry point both
//     regression-guard and bug-resolver call.

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, renameSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const QUEUE_PATH = join(REPO_ROOT, 'data/regression-bug-queue.jsonl');

// Only these (type, severity) tuples are bridged to bug-resolver.
// Q3 of the v2 design: code + UI + data + pipeline only (4 of 8 types).
// Q2 of the v2 design: CRIT + HIGH + MED only (skip LOW + below).
const ELIGIBLE_TYPES = new Set([1, 2, 3, 4]);
const ELIGIBLE_SEVERITIES = new Set(['CRIT', 'HIGH', 'MED']);

const VALID_STATES = new Set([
  'PENDING', 'IN_PROGRESS', 'DRAFT_PR',
  'MERGED', 'VERIFIED', 'REVERTED',
]);

// PT-stamped ISO. Mirrors bug-resolver.mjs's helpers — we don't import them
// because that would create a circular import (bug-resolver imports us).
function ptIsoNow() {
  return new Date(Date.now() - 7 * 3600 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, '-07:00');
}
function ptDateStamp() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function queuePath() {
  return QUEUE_PATH;
}

// Load every entry currently in the queue (regardless of state).
export function loadRegressionQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  const raw = readFileSync(QUEUE_PATH, 'utf-8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  return entries;
}

// Return only entries the bug-resolver should pick up — PENDING state.
// IN_PROGRESS is excluded so a crash mid-pipeline doesn't double-process.
export function loadPendingRegressionEntries() {
  return loadRegressionQueue().filter(e => e.v2_pipeline_state === 'PENDING');
}

// Next sequential id for today (mirrors ledger.mjs::nextId).
export function nextRegressionId(dateStamp = ptDateStamp()) {
  const entries = loadRegressionQueue();
  const prefix = `rg-${dateStamp}-`;
  let max = 0;
  for (const e of entries) {
    if (typeof e.id === 'string' && e.id.startsWith(prefix)) {
      const n = parseInt(e.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

// Stable hash for a regression-guard finding. Used as dedup key so that a
// finding which keeps surfacing across daily regression-guard runs only
// generates ONE bug-resolver pipeline cycle.
//
// The hash includes (type, subtype, file, line, severity). Summary text is
// EXCLUDED because the same underlying issue may be summarized differently
// across runs (depending on detector state) — we want the same hash regardless.
export function regressionFindingHash(finding) {
  const sig = [
    finding.type,
    finding.subtype || '',
    finding.file || '',
    finding.line || 0,
    finding.severity || '',
  ].join('|');
  return createHash('sha256').update(sig).digest('hex').slice(0, 12);
}

// Compute the sha256 of a real file's current contents. Skipped for
// pseudo-paths the pipeline doesn't read (github://, transcript:, memory:).
function sha256File(absPath) {
  try {
    const buf = readFileSync(absPath);
    return 'sha256:' + createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { return null; }
}

// Decide whether a finding is eligible for bridging into bug-resolver.
export function isEligibleFinding(finding) {
  if (!finding) return false;
  if (!ELIGIBLE_TYPES.has(finding.type)) return false;
  if (!ELIGIBLE_SEVERITIES.has(finding.severity)) return false;
  // type 0 (canary failures) is intentionally NOT eligible — those go
  // through regression-guard's own decision-doc, not bug-resolver.
  return true;
}

// Convert a regression-guard finding into a bug-ledger-compatible LedgerEntry.
// The pipeline.mjs::readSource(source_surface, source_hash) call will then
// re-read the file fresh + detect drift, which is the existing contract.
export function mapFindingToLedgerShape(finding, id, firstSeen, lastUpdated) {
  const sourceSurface = String(finding.file || '');
  // For real on-disk files inside the repo, compute source_hash so the
  // pipeline can detect drift between intake and audit phases.
  let sourceHash = null;
  if (sourceSurface && !sourceSurface.startsWith('github://') &&
      !sourceSurface.startsWith('transcript:') &&
      !sourceSurface.startsWith('memory:')) {
    const abs = sourceSurface.startsWith('/')
      ? sourceSurface
      : join(REPO_ROOT, sourceSurface);
    if (existsSync(abs)) sourceHash = sha256File(abs);
  }

  const title =
    `[regression-guard type ${finding.type} ${finding.severity}] ` +
    `${finding.subtype || 'unknown-subtype'} ` +
    `at ${sourceSurface}${finding.line ? ':' + finding.line : ''}`;

  // intake_metadata.summary is the human-readable description bug-resolver
  // surfaces in its audit prompt. Cross-fork-leak compliant — no inline
  // quotes from sensitive paths (regression-guard already gates this; we
  // double-check below via assertNoSensitiveInlineContent).
  const summary =
    `regression-guard finding · type ${finding.type} · ` +
    `severity ${finding.severity} · subtype ${finding.subtype || 'unknown'} · ` +
    `confidence ${finding.confidence || 'MEDIUM'} · ` +
    `file ${sourceSurface}${finding.line ? ':' + finding.line : ''} · ` +
    `citation ${finding.citation?.mode || 'none'} ${finding.citation?.hash || ''}`.trim();

  return {
    id,
    first_seen: firstSeen,
    last_updated: lastUpdated,
    source_surface: sourceSurface,
    source_hash: sourceHash,
    title,
    severity: finding.severity,
    status: 'OPEN',
    bug_class: null,            // audit phase classifies
    owner: 'bug-resolver',
    blast_radius: 'low',
    linked_to: null,
    draft_pr_url: null,
    resolution_commit: null,
    hardening_doc: null,
    vendor_log: [],
    total_cost_usd: 0,
    needs_human_reasons: [],
    verification_runs: [],
    intake_metadata: {
      is_sensitive_source: false,
      summary,
    },
  };
}

// Defense-in-depth: refuse to write any entry whose ledger_shape.title or
// intake_metadata.summary contains substrings that look like inline content
// from sensitive paths. regression-guard's own citation-policy.mjs is the
// primary gate; this is the second layer of belt-and-suspenders.
const SENSITIVE_MARKERS = [
  // Path tells: anything that mentions a sensitive directory in a way that
  // would have to be inline content (these strings shouldn't appear in titles
  // or summaries — only in source_surface, which we don't scan here).
  '.claude/projects/',
  'second-brain-extracted/',
  'data/hm-intel/',
  'apply-pack/',
  'apply-packs/',
];

export function assertNoSensitiveInlineContent(entry) {
  const scan = [
    entry?.ledger_shape?.title || '',
    entry?.ledger_shape?.intake_metadata?.summary || '',
  ];
  for (const text of scan) {
    for (const marker of SENSITIVE_MARKERS) {
      if (text.includes(marker)) {
        // Allowed only when it's the file path itself (e.g. source_surface).
        // Title/summary should NEVER contain these markers.
        throw new Error(
          `regression-queue: entry "${entry?.id}" appears to contain inline ` +
          `content from a sensitive path (marker: "${marker}"). ` +
          `Cross-fork-leak guard refused write.`
        );
      }
    }
  }
}

// Append a single regression-guard finding as a new queue entry.
// Dedup: skip if an entry with the same regression_citation_hash already
// exists in a non-terminal state (PENDING or IN_PROGRESS). If the prior entry
// is in a terminal state (MERGED/VERIFIED/REVERTED) and the finding has
// resurfaced, we DO write a fresh entry — that's a re-regression and
// deserves a fresh fix cycle.
//
// Returns { wrote: boolean, id: string|null, reason?: string }.
export function appendRegressionFinding(finding, { dateStamp = ptDateStamp() } = {}) {
  if (!isEligibleFinding(finding)) {
    return { wrote: false, id: null, reason: 'not-eligible' };
  }

  const hash = regressionFindingHash(finding);
  const existing = loadRegressionQueue();

  // Dedup against active entries
  const active = existing.find(e =>
    e.regression_citation_hash === hash &&
    (e.v2_pipeline_state === 'PENDING' ||
     e.v2_pipeline_state === 'IN_PROGRESS' ||
     e.v2_pipeline_state === 'DRAFT_PR')
  );
  if (active) {
    return { wrote: false, id: active.id, reason: 'duplicate-active' };
  }

  const now = ptIsoNow();
  const id = nextRegressionId(dateStamp);

  const entry = {
    id,
    source: 'regression-guard',
    first_seen: now,
    last_updated: now,
    regression_citation_hash: hash,
    v2_pipeline_state: 'PENDING',
    ledger_shape: mapFindingToLedgerShape(finding, id, now, now),
  };

  assertNoSensitiveInlineContent(entry);

  appendFileSync(QUEUE_PATH, JSON.stringify(entry) + '\n');
  return { wrote: true, id, reason: 'appended' };
}

// Bulk-append a findings array (called by regression-guard after detection).
// Returns counts: { written, skipped_not_eligible, skipped_duplicate }.
export function appendRegressionFindings(findings) {
  let written = 0;
  let skipped_not_eligible = 0;
  let skipped_duplicate = 0;
  for (const f of findings || []) {
    const r = appendRegressionFinding(f);
    if (r.wrote) written++;
    else if (r.reason === 'not-eligible') skipped_not_eligible++;
    else if (r.reason === 'duplicate-active') skipped_duplicate++;
  }
  return { written, skipped_not_eligible, skipped_duplicate };
}

// Atomic update of a single queue entry by id.
// Throws if id not found OR if v2_pipeline_state moves to a state not in
// VALID_STATES (prevents typos like "MEERGED" silently breaking the FSM).
export function updateRegressionEntry(id, updates) {
  const entries = loadRegressionQueue();
  let updated = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === id) {
      const merged = {
        ...entries[i],
        ...updates,
        last_updated: ptIsoNow(),
      };
      // Allow ledger_shape patches via a sentinel key
      if (updates.ledger_shape_patch) {
        merged.ledger_shape = {
          ...(entries[i].ledger_shape || {}),
          ...updates.ledger_shape_patch,
        };
        delete merged.ledger_shape_patch;
      }
      if (merged.v2_pipeline_state &&
          !VALID_STATES.has(merged.v2_pipeline_state)) {
        throw new Error(
          `updateRegressionEntry: invalid v2_pipeline_state ` +
          `"${merged.v2_pipeline_state}" for ${id}`
        );
      }
      entries[i] = merged;
      updated = true;
      break;
    }
  }
  if (!updated) {
    throw new Error(`updateRegressionEntry: id "${id}" not found in queue`);
  }
  // Atomic write
  const tmpPath = QUEUE_PATH + '.tmp';
  const body = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(tmpPath, body);
  renameSync(tmpPath, QUEUE_PATH);
}

// Sentinel for callers who need to know "is this id ours?" without parsing.
export function isRegressionQueueId(id) {
  return typeof id === 'string' && id.startsWith('rg-');
}
