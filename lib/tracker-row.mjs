#!/usr/bin/env node
/**
 * lib/tracker-row.mjs — single source of truth for applications.md row
 * escaping + structural validation.
 *
 * Closes two leak classes (pipeline-ingest-format-drift, 2026-07-06 pipeline
 * reboot — see docs/BUG-CLASSES.md § pipeline-ingest-format-drift):
 *
 *   1. Unescaped `|` in a company/role string shifts EVERY downstream column
 *      (the score lands in the status cell, table parsing corrupts). Canonical
 *      incident: row #2535 "AI Operations Specialist | Agentic Workflows".
 *      Writers must run company/role through escapeTableCell() before composing
 *      a markdown row.
 *
 *   2. A structural check that is NOTE-AWARE. Pipes in the TRAILING notes
 *      column (col 9+) are legitimate — batch-runner-batches.mjs emits
 *      `field | field | field` notes by design — and must NOT trip the
 *      invariant. Only the fixed FRONT columns (num / date / score / status)
 *      are type-checked, so a leaked triage-skip shape (row #2756 celonis)
 *      whose columns are shifted still fails, while ~114 legit pipe-in-notes
 *      rows pass.
 *
 * Escaping convention matches dedup-tracker.mjs:315 — backslash-escape the pipe
 * (`\|`), which GitHub/GFM + the dashboard renderer display as a literal pipe
 * inside one cell. splitTableRow() therefore splits on UNESCAPED pipes only, so
 * an escaped pipe in company/role keeps the columns aligned; the invariant
 * stays green after the writer fix.
 */

// Canonical states (templates/states.yml) + deprecated SKIP alias for
// historical rows written before the 2026-05-26 SKIP→Discarded migration.
export const CANONICAL_STATUS_RE = /^(Evaluated|Applied|Responded|Interview|Offer|Rejected|Discarded|SKIP)$/i;
export const NUM_RE = /^\d+$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Score cell: "X.X/5", "N/A", or "DUP" (merge-tracker heuristic token).
export const SCORE_RE = /^(\d+(?:\.\d+)?\/5|N\/A|DUP)$/i;

/**
 * Escape a value for safe insertion into ONE markdown-table cell.
 * Strips line-breakers/tabs (which would corrupt the row or upstream TSV) and
 * backslash-escapes UNESCAPED pipes (idempotent — will not double-escape `\|`).
 */
export function escapeTableCell(v) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')       // no line breaks inside a cell/row
    .replace(/\t/g, ' ')            // tabs would corrupt the upstream TSV too
    .replace(/(?<!\\)\|/g, '\\|')   // escape UNESCAPED pipes only (idempotent)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip only line-breakers (keep pipes) — for TSV fields whose delimiter is
 * TAB. Notes deliberately carry `field | field` separators; keep them.
 */
export function tsvSafeCell(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Split a markdown table row on UNESCAPED pipes (so `\|` stays inside its cell). */
export function splitTableRow(line) {
  return String(line).split(/(?<!\\)\|/);
}

/**
 * True if this line is an applications.md DATA row (not header/separator/prose).
 * A data row starts with `|` and its first cell is the integer id — which alone
 * excludes the header (`| # | Date | …`) and the `|---|---|` separator (first
 * cell `---`). We deliberately do NOT reject on a substring `---` match: a
 * legitimate notes cell can contain `---` (e.g. a date range or an em-dash-free
 * separator), and skipping such a row would let a real corruption hide from the
 * invariant (false negative).
 */
export function isTrackerDataRow(line) {
  if (typeof line !== 'string' || !line.startsWith('|')) return false;
  const first = (splitTableRow(line)[1] || '').trim();
  return NUM_RE.test(first);   // integer first cell ⇒ data row (never a header/separator)
}

/**
 * Validate ONE applications.md data row. Note-aware: only the fixed front
 * columns are type-checked; pipes in notes (col 9+) are allowed.
 *
 * Columns after an UNESCAPED split:
 *   [ '', num, date, company, role, score, status, pdf, report, ...notes ]
 *
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
export function validateTrackerRow(line) {
  const p = splitTableRow(line);
  if (p.length < 10) {
    return { ok: false, reason: `too few columns (${p.length} < 10) — a pipe likely broke a structural cell` };
  }
  const num = (p[1] || '').trim();
  const date = (p[2] || '').trim();
  const score = (p[5] || '').trim();
  const status = (p[6] || '').trim();
  if (!NUM_RE.test(num)) return { ok: false, reason: `col1 num not integer: "${num}"` };
  if (!DATE_RE.test(date)) return { ok: false, reason: `col2 date not YYYY-MM-DD: "${date}"` };
  if (!SCORE_RE.test(score)) return { ok: false, reason: `col5 score malformed: "${score}" (unescaped '|' in company/role shifts this cell)` };
  if (!CANONICAL_STATUS_RE.test(status)) return { ok: false, reason: `col6 status non-canonical: "${status}"` };
  return { ok: true };
}
