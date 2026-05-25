/**
 * lib/ledger-enforcer.mjs
 *
 * Step 6 of the pre-apply-check deepening project — the anti-regression
 * infrastructure that closes the "closure-prompt-abandonment pattern"
 * documented in `.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md`.
 *
 * Reads `data/persistent-task-ledger.md`, extracts YAML-fenced metadata
 * blocks per LEDGER entry, and answers three questions:
 *
 *   1. Which open NEEDS_CLOSURE entries cite a `closure_artifacts` path
 *      that does not exist on disk? (The LEDGER-022/023/030 fabrication
 *      pattern — closure docs referenced but never written.)
 *
 *   2. Which entries cite a `code_paths` file that has been renamed or
 *      deleted out from under them? (The drift pattern — code moves;
 *      ledger does not.)
 *
 *   3. Of the paths modified in a commit / PR, which intersect a
 *      NEEDS_CLOSURE entry's `code_paths` without a matching ledger
 *      status update? (The active-commit-without-closure pattern —
 *      the actual regression-detector.)
 *
 * Per dealbreaker-final § "Anti-regression (Option C anti-fatigue design)":
 *
 *   - First version is CONSERVATIVE — exact path match only.
 *   - No glob inference. No prefix matching. Catch clear violations only.
 *   - Local pre-commit hook is WARN-mode (no bypass reflex possible).
 *   - GHA CI runs the same library in BLOCK mode (hard backstop).
 *
 * YAML metadata block format (embedded in the LEDGER markdown):
 *
 *   <!-- ledger-meta
 *   status: NEEDS_CLOSURE
 *   feature_tag: pre-apply-check-deepen
 *   code_paths:
 *     - lib/pre-apply-orchestrator.mjs
 *     - lib/ats-check.mjs
 *   closure_artifacts:
 *     - .claude/audit/pre-apply-deepen-2026-05-25/smoke-test.md
 *   -->
 *
 * Entries WITHOUT a metadata block are returned with `metadata_present: false`
 * — tolerant by design so the existing 31+ LEDGER entries don't all break the
 * world the moment this lands.
 *
 * Zero runtime dependencies — uses native fs + minimal hand-rolled YAML
 * parser scoped to the subset of YAML we actually use (scalars + arrays of
 * scalars).
 */

import { readFileSync, existsSync, statSync as nodeFsStatSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/**
 * Statuses that count as "still open" — the enforcer fires only on these.
 * CLOSED / DONE / SUPERSEDED / COMPLETED entries are intentionally skipped:
 * once an entry is closed, modifying its old code_paths is normal repo
 * maintenance, not a closure regression.
 */
export const OPEN_STATUSES = new Set([
  'NEEDS_CLOSURE',
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'PERMANENT-OPEN',
]);

/**
 * Statuses that count as "closed" — the enforcer skips these.
 */
export const CLOSED_STATUSES = new Set([
  'DONE',
  'CLOSED',
  'COMPLETED',
  'SUPERSEDED',
]);

const LEDGER_META_OPEN = '<!-- ledger-meta';
const LEDGER_META_CLOSE = '-->';

// Match LEDGER-NNN or LEDGER-NNN-DONE etc., anchored at start of line in any
// reasonable header form (## heading, table-cell, or | LEDGER-NNN | row).
const ENTRY_ID_PATTERN = /\bLEDGER-\d+(?:-[A-Z]+)?\b/g;

// ──────────────────────────────────────────────────────────────────────────
// Minimal YAML parser
// ──────────────────────────────────────────────────────────────────────────
// We deliberately do NOT shell out to a YAML library — the metadata format
// is fixed and small (key: value scalars + lists of scalars). Hand-rolling
// keeps deps at zero and the parser auditable in ~40 lines.

/**
 * Parse a small subset of YAML — enough for our metadata blocks.
 * Supports:
 *   key: scalar           → string
 *   key: [a, b]           → array (flow style, NOT used in our format but tolerated)
 *   key:                  → array (when followed by - items)
 *     - item1
 *     - item2
 *
 * Returns a plain object. Unknown shapes are dropped silently — the
 * enforcer treats missing fields as "not present" rather than throwing,
 * so a typo in one entry doesn't poison the whole audit.
 *
 * @param {string} text
 * @returns {Record<string, string | string[]>}
 */
export function parseMiniYaml(text) {
  const obj = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.replace(/\s+$/, '');
    if (!trimmed || /^\s*#/.test(trimmed)) {
      i++;
      continue;
    }
    // top-level key: ...
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === '') {
      // Multi-line list block — collect following "- item" lines (any indent > 0).
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next.trim()) {
          j++;
          continue;
        }
        const listMatch = next.match(/^\s+-\s+(.*)$/);
        if (!listMatch) break;
        items.push(stripQuotes(listMatch[1].trim()));
        j++;
      }
      obj[key] = items;
      i = j;
      continue;
    }
    // Flow-style list: key: [a, b, c]
    const flow = rest.match(/^\[(.*)\]$/);
    if (flow) {
      obj[key] = flow[1]
        .split(',')
        .map(s => stripQuotes(s.trim()))
        .filter(Boolean);
      i++;
      continue;
    }
    // Scalar
    obj[key] = stripQuotes(rest);
    i++;
  }
  return obj;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// Core: parseLedger
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the ledger text into structured entries.
 *
 * Strategy:
 *   - Walk the document linearly.
 *   - Every LEDGER-NNN identifier we see opens (or reopens) a logical entry
 *     context. We track the "current entry id" as the most recently seen.
 *   - Every <!-- ledger-meta ... --> block we encounter is attributed to
 *     the closest preceding entry id. If no entry id has appeared yet,
 *     the block is dropped (with a debug note).
 *   - An entry can also be discovered from a metadata block whose body
 *     contains `id: LEDGER-XYZ` — the block's own `id` field wins over
 *     positional attribution.
 *
 * Returns an array of normalized entry records. Every record has the
 * same shape:
 *
 *   {
 *     id: 'LEDGER-026',
 *     status: 'NEEDS_CLOSURE' | 'OPEN' | 'DONE' | ... | null,
 *     feature_tag: string | null,
 *     code_paths: string[],         // always an array; empty if absent
 *     closure_artifacts: string[],  // always an array; empty if absent
 *     metadata_present: boolean,    // false → entry seen but no YAML block
 *     raw_meta: Record<string, ...>  // the raw parsed YAML for debugging
 *   }
 *
 * Tolerant of:
 *   - Entries without metadata blocks (returns metadata_present: false)
 *   - Multiple appearances of the same id (last metadata block wins; first
 *     positional appearance sets the id)
 *   - Comments inside metadata blocks
 *   - Trailing whitespace / blank lines
 *
 * @param {string} text - raw ledger markdown
 * @returns {Array<Object>}
 */
export function parseLedger(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseLedger: text must be a string');
  }

  const byId = new Map();       // id → entry record
  const entryOrder = [];        // insertion order for return stability

  function ensureEntry(id) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        status: null,
        feature_tag: null,
        code_paths: [],
        closure_artifacts: [],
        metadata_present: false,
        raw_meta: null,
      });
      entryOrder.push(id);
    }
    return byId.get(id);
  }

  // First pass — find every LEDGER-NNN identifier and ensure an entry exists.
  // Walks line-by-line; first appearance per line is recorded.
  let currentEntryId = null;
  const lines = text.split(/\r?\n/);

  // We need positional tracking: as we walk, currentEntryId is whichever
  // entry was last seen so we can attribute YAML blocks correctly.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect LEDGER-NNN identifier appearance(s) on this line.
    // We use matchAll so multiple ids on one line all register, but
    // currentEntryId is set to the LAST one (assumption: rare; in tables
    // a row has one id).
    let match;
    let lastIdOnLine = null;
    const localPattern = new RegExp(ENTRY_ID_PATTERN.source, 'g');
    while ((match = localPattern.exec(line)) !== null) {
      lastIdOnLine = normalizeEntryId(match[0]);
      ensureEntry(lastIdOnLine);
    }
    if (lastIdOnLine) {
      currentEntryId = lastIdOnLine;
    }

    // Detect the start of a metadata block.
    if (line.trim().startsWith(LEDGER_META_OPEN)) {
      // Collect lines until the closing -->
      const bodyLines = [];
      // The opening line MAY have content after `<!-- ledger-meta`, e.g.
      // `<!-- ledger-meta` (no content) → body starts next line.
      // We tolerate both forms.
      const openerRest = line.replace(/^.*<!-- ledger-meta\s*/, '');
      if (openerRest && !openerRest.startsWith('-->')) {
        bodyLines.push(openerRest);
      }
      let j = i + 1;
      let foundClose = false;
      while (j < lines.length) {
        const candidate = lines[j];
        if (candidate.includes(LEDGER_META_CLOSE)) {
          // Strip the closer + anything before it on that line into the body.
          const beforeClose = candidate.split(LEDGER_META_CLOSE)[0];
          if (beforeClose) bodyLines.push(beforeClose);
          foundClose = true;
          j++;
          break;
        }
        bodyLines.push(candidate);
        j++;
      }
      if (foundClose) {
        const yamlBody = bodyLines.join('\n');
        const parsed = parseMiniYaml(yamlBody);
        // Determine which entry this metadata block belongs to.
        // Block's own `id` field wins; otherwise positional currentEntryId.
        let targetId = parsed.id ? normalizeEntryId(String(parsed.id)) : currentEntryId;
        if (!targetId) {
          // Floating metadata block with no entry context — skip.
          i = j;
          continue;
        }
        const entry = ensureEntry(targetId);
        entry.metadata_present = true;
        entry.raw_meta = parsed;
        if (typeof parsed.status === 'string') {
          entry.status = parsed.status.trim();
        }
        if (typeof parsed.feature_tag === 'string') {
          entry.feature_tag = parsed.feature_tag.trim();
        }
        if (Array.isArray(parsed.code_paths)) {
          entry.code_paths = parsed.code_paths.filter(Boolean);
        }
        if (Array.isArray(parsed.closure_artifacts)) {
          entry.closure_artifacts = parsed.closure_artifacts.filter(Boolean);
        }
        i = j;
        continue;
      }
      // Unclosed block — give up parsing this block; treat as text.
    }

    i++;
  }

  // Return entries in insertion order, preserving stability.
  return entryOrder.map(id => byId.get(id));
}

/**
 * Normalize an entry id. Strips trailing -DONE/-CLOSED suffixes so the
 * supersedes pattern (LEDGER-022 → LEDGER-022-DONE) is unified under the
 * base id — but only for matching purposes elsewhere. We KEEP the suffix
 * as-is in entry ids to preserve the audit trail; the caller can decide
 * whether to collapse.
 *
 * For now: no normalization — return as-is.
 *
 * @param {string} id
 * @returns {string}
 */
function normalizeEntryId(id) {
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// Audit functions
// ──────────────────────────────────────────────────────────────────────────

/**
 * For each entry with cited closure_artifacts, verify each cited file
 * exists on disk at `<repoRoot>/<path>`. Catches the LEDGER-022/023/030
 * fabrication pattern: closure prompt cites `data/closure-prompt-XX-...`
 * but the file was never written.
 *
 * Returns an array of strings shaped `<entry_id>::<missing_path>`. This is
 * a flat list so the CLI can grep / count easily. The full structured
 * version (with entry status etc.) is available via auditAllStaleArtifacts.
 *
 * @param {Array<Object>} entries - output of parseLedger
 * @param {string} repoRoot - absolute path to repo root
 * @returns {string[]}
 */
export function findStaleArtifacts(entries, repoRoot) {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`findStaleArtifacts: repoRoot must be absolute, got: ${repoRoot}`);
  }
  const out = [];
  for (const entry of entries) {
    // Closed entries are skipped — their closure_artifacts may have been
    // moved/archived/deleted as part of normal repo maintenance.
    if (entry.status && CLOSED_STATUSES.has(entry.status.toUpperCase())) continue;
    for (const artifactPath of entry.closure_artifacts) {
      const abs = isAbsolute(artifactPath)
        ? artifactPath
        : resolve(repoRoot, artifactPath);
      if (!existsSync(abs)) {
        out.push(`${entry.id}::${artifactPath}`);
      }
    }
  }
  return out;
}

/**
 * For each entry with cited code_paths, verify each path exists on disk.
 * Catches the drift pattern: a code file gets renamed or deleted; the
 * ledger entry tracking it is now stale.
 *
 * Returns flat `<entry_id>::<missing_path>` strings, same shape as
 * findStaleArtifacts.
 *
 * @param {Array<Object>} entries
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function findStaleCodePaths(entries, repoRoot) {
  if (!isAbsolute(repoRoot)) {
    throw new Error(`findStaleCodePaths: repoRoot must be absolute, got: ${repoRoot}`);
  }
  const out = [];
  for (const entry of entries) {
    if (entry.status && CLOSED_STATUSES.has(entry.status.toUpperCase())) continue;
    for (const codePath of entry.code_paths) {
      const abs = isAbsolute(codePath) ? codePath : resolve(repoRoot, codePath);
      if (!existsSync(abs)) {
        out.push(`${entry.id}::${codePath}`);
      }
    }
  }
  return out;
}

/**
 * THE core enforcer predicate. Given a set of paths modified in a commit
 * or PR, find every NEEDS_CLOSURE-status entry whose code_paths contains
 * one of those modified paths EXACTLY.
 *
 * Conservative-by-design:
 *   - EXACT path match only. `lib/ats-check.mjs` modified does NOT trigger
 *     an entry that cites `lib/ats-check.test.mjs`, even though the prefix
 *     matches.
 *   - No glob expansion. An entry citing `lib/*.mjs` (which our format
 *     doesn't support anyway) would NOT match `lib/foo.mjs`.
 *   - No prefix or substring inference.
 *   - Only entries in OPEN_STATUSES (NEEDS_CLOSURE, OPEN, IN_PROGRESS,
 *     BLOCKED, PERMANENT-OPEN) trigger violations. Closed entries are
 *     skipped because their code_paths are no longer load-bearing.
 *
 * Per dealbreaker-final § "First version of enforcer must be conservative"
 * (gpt-5 distinctive) — anti-fatigue design directly supports Opus's
 * anti-fatigue framing.
 *
 * Returns an array of structured violation records:
 *   { entry_id, path, message }
 *
 * `message` is a human-readable one-liner ready to dump to stdout / hook
 * output / PR comment.
 *
 * @param {{ entries: Array<Object>, modifiedPaths: string[], repoRoot: string }} params
 * @returns {Array<{ entry_id: string, path: string, message: string }>}
 */
export function checkModifiedPaths({ entries, modifiedPaths, repoRoot }) {
  if (!Array.isArray(entries)) {
    throw new TypeError('checkModifiedPaths: entries must be an array');
  }
  if (!Array.isArray(modifiedPaths)) {
    throw new TypeError('checkModifiedPaths: modifiedPaths must be an array');
  }
  if (typeof repoRoot !== 'string') {
    throw new TypeError('checkModifiedPaths: repoRoot must be a string');
  }

  // Normalize modifiedPaths: strip leading ./ and any absolute prefixes
  // matching the repo root so we compare apples to apples.
  const normalizedModified = modifiedPaths
    .map(p => normalizeRelative(p, repoRoot))
    .filter(Boolean);

  const violations = [];
  for (const entry of entries) {
    const statusUpper = (entry.status || '').toUpperCase();
    if (!OPEN_STATUSES.has(statusUpper)) continue;
    // PERMANENT-OPEN entries (e.g., LEDGER-001 which tracks the ledger file
    // itself) by design never close — they exist to enforce a recurring
    // discipline, not to gate one-time closure. Modifying their tracked
    // code_paths is the SUCCESS condition of their existence, not a
    // closure-required event. They remain audited for stale closure_artifacts
    // via findStaleArtifacts/findStaleCodePaths.
    if (statusUpper === 'PERMANENT-OPEN') continue;
    if (!entry.code_paths || entry.code_paths.length === 0) continue;

    // Pre-normalize entry code_paths once per entry.
    const entryPathsNormalized = entry.code_paths
      .map(p => normalizeRelative(p, repoRoot))
      .filter(Boolean);

    for (const modPath of normalizedModified) {
      // EXACT string match only — no startsWith, no includes, no glob.
      if (entryPathsNormalized.includes(modPath)) {
        violations.push({
          entry_id: entry.id,
          path: modPath,
          message: `${entry.id} (${statusUpper || 'NO-STATUS'}) tracks "${modPath}" — update data/persistent-task-ledger.md or note why this commit doesn't require closure.`,
        });
      }
    }
  }
  return violations;
}

/**
 * Strip a repo-root prefix + leading ./ from a path so comparisons are
 * canonical. Does NOT collapse `..` segments — those would suggest the
 * input is escaping the repo and should be left alone for the caller to
 * notice.
 *
 * @param {string} p
 * @param {string} repoRoot - absolute
 * @returns {string}
 */
function normalizeRelative(p, repoRoot) {
  if (!p) return '';
  let s = String(p).trim();
  if (!s) return '';
  // Strip leading ./ if any
  if (s.startsWith('./')) s = s.slice(2);
  // If absolute and inside repo root, strip the repo-root prefix
  if (isAbsolute(s) && isAbsolute(repoRoot) && s.startsWith(repoRoot + '/')) {
    s = s.slice(repoRoot.length + 1);
  }
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// High-level audit helper (--audit mode)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Run the full audit pass — stale artifacts, stale code_paths, plus
 * per-entry metadata-coverage stats.
 *
 * Returns:
 *   {
 *     entry_count, with_metadata, without_metadata,
 *     stale_artifacts: string[],
 *     stale_code_paths: string[],
 *     open_needs_closure: Array<Object>,
 *   }
 *
 * @param {{ entries: Array<Object>, repoRoot: string }} params
 */
export function auditLedger({ entries, repoRoot }) {
  const stale_artifacts = findStaleArtifacts(entries, repoRoot);
  const stale_code_paths = findStaleCodePaths(entries, repoRoot);

  const with_metadata = entries.filter(e => e.metadata_present).length;
  const without_metadata = entries.length - with_metadata;
  const open_needs_closure = entries.filter(e => {
    const s = (e.status || '').toUpperCase();
    return OPEN_STATUSES.has(s);
  });

  return {
    entry_count: entries.length,
    with_metadata,
    without_metadata,
    stale_artifacts,
    stale_code_paths,
    open_needs_closure,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// File-system helper
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convenience loader — read the ledger file from disk and parse.
 * Throws if the file doesn't exist.
 *
 * @param {string} ledgerPath - absolute path to ledger .md file
 * @returns {Array<Object>}
 */
export function loadLedgerFile(ledgerPath) {
  if (!isAbsolute(ledgerPath)) {
    throw new Error(`loadLedgerFile: ledgerPath must be absolute, got: ${ledgerPath}`);
  }
  if (!existsSync(ledgerPath)) {
    throw new Error(`loadLedgerFile: file does not exist: ${ledgerPath}`);
  }
  const text = readFileSync(ledgerPath, 'utf8');
  return parseLedger(text);
}

/**
 * Default ledger location relative to repo root.
 */
export const DEFAULT_LEDGER_PATH = 'data/persistent-task-ledger.md';

/**
 * Helper to compute the absolute path to the default ledger.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function defaultLedgerPath(repoRoot) {
  return join(repoRoot, DEFAULT_LEDGER_PATH);
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 5 — Hook-based injection summary (4-week trial)
// ──────────────────────────────────────────────────────────────────────────
// Built for the UserPromptSubmit hook at `.claude/hooks/ledger-summary-inject.mjs`.
// Per dealbreaker Phase 5 (`.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md`
// § "Hook-based ledger summary injection (4-week trial)"). The hook calls
// `getInjectionSummary()` on every UserPromptSubmit event and returns the
// result as a `<system-reminder>` via the `additionalContext` field.
//
// Quality bar:
//   - Read-only — never mutates the ledger
//   - Bounded output — 5-10 lines, capped at MAX_INJECTION_CHARS
//   - Tolerant — empty string on missing ledger / parse errors / oversized files
//   - Stable — deterministic ordering (by entry id) so the summary doesn't
//     shimmer between adjacent prompts

/**
 * Maximum size of the persistent-task-ledger.md file before the helper
 * refuses to parse it (returns the warning string). Catches accidental
 * runaway-growth that would block every UserPromptSubmit on parsing.
 * 10 MB = comfortably larger than any plausible legitimate ledger.
 */
export const MAX_LEDGER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Maximum total characters in the rendered summary text. Hooks should
 * keep their additionalContext small so they don't push real user
 * messages out of the visible context window. 2 KB is plenty for 5
 * entries at ~250 chars each.
 */
export const MAX_INJECTION_CHARS = 2048;

/**
 * Default max number of entries to include in the summary. Per the
 * Phase 5 spec — top-5 NEEDS_CLOSURE entries.
 */
export const DEFAULT_MAX_ENTRIES = 5;

/**
 * Build a short, human-readable summary of open ledger entries — formatted
 * for injection as `additionalContext` in a UserPromptSubmit hook payload.
 *
 * The output looks like:
 *
 *   Open ledger entries (3 NEEDS_CLOSURE):
 *   - LEDGER-022 · ledger-fabrication-sweep · data/closure-prompt-08-...
 *   - LEDGER-023 · ledger-fabrication-sweep · data/closure-prompt-09-...
 *   - LEDGER-030 · ledger-fabrication-sweep · (no code paths cited)
 *
 * Each entry line is: `LEDGER-NNN · {feature_tag|<no-feature-tag>} · {first 1-3 code_paths joined by '; '|<no-code-paths-cited>}`.
 *
 * Returns the empty string (NOT throws) when:
 *   - ledger file does not exist on disk
 *   - ledger has zero open entries matching the requested status
 *   - read or parse fails for any reason
 *
 * Returns a one-line warning string when:
 *   - ledger file exceeds MAX_LEDGER_BYTES (10 MB)
 *
 * @param {Object} [opts]
 * @param {string} [opts.status='NEEDS_CLOSURE'] - Status to filter on. May be:
 *   - 'NEEDS_CLOSURE' (default) — exact status match
 *   - any other OPEN_STATUSES member (OPEN / IN_PROGRESS / BLOCKED / PERMANENT-OPEN)
 *   - 'ALL_OPEN' — any OPEN_STATUSES member
 * @param {number} [opts.max_entries=5] - Cap on entries rendered. Clamped to [1, 50].
 * @param {string} [opts.ledgerPath] - Override the default ledger path. Useful for tests.
 *   When unset, resolves to `<cwd>/data/persistent-task-ledger.md`.
 * @returns {string}
 */
export function getInjectionSummary(opts = {}) {
  const status = String(opts.status || 'NEEDS_CLOSURE').trim();
  const requestedMax = Number.isFinite(opts.max_entries) ? opts.max_entries : DEFAULT_MAX_ENTRIES;
  const maxEntries = Math.max(1, Math.min(50, Math.floor(requestedMax)));
  const ledgerPath = opts.ledgerPath || join(process.cwd(), DEFAULT_LEDGER_PATH);

  // Step 1: existence check — return empty string when ledger is absent.
  // The hook should be silent (no system-reminder) when there's nothing
  // to show. This lets Mitchell run the hook in fresh clones / dev
  // checkouts without spam.
  let stats;
  try {
    if (!existsSync(ledgerPath)) return '';
    stats = nodeFsStatSync(ledgerPath);
  } catch {
    return '';
  }

  // Step 2: size guard. A ledger > 10 MB is almost certainly a runaway
  // append; refusing to parse keeps the hook fast + safe.
  if (stats && stats.size > MAX_LEDGER_BYTES) {
    return `[ledger-injection] persistent-task-ledger.md exceeds ${MAX_LEDGER_BYTES} bytes (${stats.size}) — skipping parse.`;
  }

  // Step 3: read + parse, tolerate every failure mode.
  let entries;
  try {
    const text = readFileSync(ledgerPath, 'utf8');
    entries = parseLedger(text);
  } catch {
    return '';
  }
  if (!Array.isArray(entries) || entries.length === 0) return '';

  // Step 4: filter by requested status.
  const filtered = filterEntriesForInjection(entries, status);
  if (filtered.length === 0) return '';

  // Step 5: stable sort by entry id so the summary doesn't shimmer.
  filtered.sort((a, b) => compareEntryIdsForSort(a.id, b.id));

  // Step 6: render. Keep total < MAX_INJECTION_CHARS.
  return renderInjectionSummary(filtered, status, maxEntries);
}


/**
 * Filter parsed entries down to those matching the requested status.
 * - 'NEEDS_CLOSURE' / any OPEN_STATUSES member → exact match (case-insensitive)
 * - 'ALL_OPEN' → any OPEN_STATUSES member
 * Excludes CLOSED_STATUSES always (defense in depth).
 *
 * @param {Array<Object>} entries
 * @param {string} status
 * @returns {Array<Object>}
 */
function filterEntriesForInjection(entries, status) {
  const wanted = status.toUpperCase();
  const wantAll = wanted === 'ALL_OPEN';
  return entries.filter(e => {
    const s = (e.status || '').toUpperCase();
    if (!s) return false;
    if (CLOSED_STATUSES.has(s)) return false;
    if (wantAll) return OPEN_STATUSES.has(s);
    return s === wanted;
  });
}

/**
 * Sort LEDGER-NNN ids numerically when both have an obvious numeric suffix;
 * fall back to lexicographic compare. Keeps LEDGER-022 above LEDGER-100
 * (numeric) and gracefully tolerates suffixes like LEDGER-022-DONE.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareEntryIdsForSort(a, b) {
  const numA = parseInt(String(a).replace(/^LEDGER-/, ''), 10);
  const numB = parseInt(String(b).replace(/^LEDGER-/, ''), 10);
  if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Render the filtered+sorted entries into the final summary text. Caps
 * total length at MAX_INJECTION_CHARS — overflow entries are dropped
 * with a closing "[+N more]" line.
 *
 * @param {Array<Object>} filtered
 * @param {string} status
 * @param {number} maxEntries
 * @returns {string}
 */
function renderInjectionSummary(filtered, status, maxEntries) {
  const slice = filtered.slice(0, maxEntries);
  const overflow = filtered.length - slice.length;

  const header = (() => {
    const label = status.toUpperCase() === 'ALL_OPEN' ? 'open' : `${status.toUpperCase()}`;
    return `Open ledger entries (${filtered.length} ${label}):`;
  })();

  const lines = [header];
  for (const e of slice) {
    lines.push(renderEntryLine(e));
  }
  if (overflow > 0) {
    lines.push(`- [+${overflow} more — see data/persistent-task-ledger.md]`);
  }

  // Char cap. If the rendered summary somehow blows past MAX_INJECTION_CHARS
  // (extremely unlikely with default 5 entries × 250-char lines), truncate
  // hard at the line boundary that fits.
  let out = lines.join('\n');
  if (out.length > MAX_INJECTION_CHARS) {
    // Walk lines back until we fit; always keep the header.
    const truncMarker = '\n- [truncated — output exceeded char cap]';
    const budget = MAX_INJECTION_CHARS - truncMarker.length;
    const acc = [header];
    let len = header.length;
    for (let i = 1; i < lines.length; i++) {
      const candidate = '\n' + lines[i];
      if (len + candidate.length > budget) break;
      acc.push(lines[i]);
      len += candidate.length;
    }
    out = acc.join('\n') + truncMarker;
  }
  return out;
}

/**
 * Render a single entry as a one-line bullet.
 *
 * Format: `- <id> · <feature_tag|<no-feature-tag>> · <first 1-3 code_paths joined by '; '>`
 *
 * @param {Object} entry
 * @returns {string}
 */
function renderEntryLine(entry) {
  const id = entry.id || 'LEDGER-???';
  const tag = entry.feature_tag && String(entry.feature_tag).trim()
    ? String(entry.feature_tag).trim()
    : '<no-feature-tag>';
  const paths = Array.isArray(entry.code_paths) && entry.code_paths.length > 0
    ? entry.code_paths.slice(0, 3).join('; ')
    : '<no-code-paths-cited>';
  return `- ${id} · ${tag} · ${paths}`;
}
