/**
 * lib/build-pack-stage-input.mjs — Resolve rowId → SubAgentInput for /api/build-pack-stage.
 *
 * Bug context (2026-05-25, Worker C of pre-apply-followup sprint):
 *   /api/build-pack-stage previously passed `{ pack: { rowId, num: rowId } }`
 *   into runCvTailor / runCoverLetter / etc. Those agents read company + role
 *   from `input?.pack?.jd?.company` / `input?.pack?.meta?.company` and fall
 *   back to the literal string 'Unknown' when both are missing. The result:
 *   cv-tailor wrote its bullet ledger to
 *   `data/apply-packs/000-unknown-unknown/cv-tailored.md` instead of the
 *   canonical `<padded-rowid>-<company-slug>-<role-slug>/` directory.
 *
 *   This helper resolves rowId to the row record in apply-now-queue.json
 *   first, then falls back to applications.md. When a row IS found, it
 *   builds the full SubAgentInput shape (matching scripts/cv-tailor-batch.mjs
 *   line 220 `buildSubAgentInput()`). When NOT found, it returns null so the
 *   server can surface an actionable 404.
 *
 * Why server-side, not agent-side: cv-tailor is correct to default — its
 * own batch wrapper provides the full input. The /api/build-pack-stage
 * caller (the dashboard) is the one that has the rowId-only contract and
 * must hydrate it. Fixing it once here covers every stage agent.
 *
 * Public API (one function + one internal helper):
 *   resolveRowToPackInput(rowId, opts?) → { ok, packInput?, row?, error? }
 *   _readQueueAndApplications(opts)     → { queue, applications }  (internal)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApplicationsFile } from './parse-applications.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

/**
 * Slugify a string for the apply-pack directory name. Matches the
 * convention used by scripts/agents/cv-tailor.mjs:156 and
 * lib/apply-now-queue-gate.mjs:79.
 *
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Find a row matching `rowId` in the apply-now-queue ranked array.
 * `rowId` may be number-typed or string-typed. Returns null when not found.
 *
 * @param {Array<object>} ranked
 * @param {number|string} rowId
 * @returns {object|null}
 */
export function findRowInQueue(ranked, rowId) {
  if (!Array.isArray(ranked) || rowId == null || rowId === '') return null;
  const rowIdStr = String(rowId).replace(/^0+/, ''); // strip leading zeros
  const rowIdNum = Number(rowIdStr);
  for (const r of ranked) {
    if (!r) continue;
    // r.num is stored as string in apply-now-queue.json; coerce both sides
    const rNumStr = String(r.num ?? '').replace(/^0+/, '');
    if (rNumStr === rowIdStr) return r;
    if (Number.isFinite(rowIdNum) && Number(r.num) === rowIdNum) return r;
  }
  return null;
}

/**
 * Find a row in applications.md by num.
 *
 * @param {Array<object>} apps
 * @param {number|string} rowId
 * @returns {object|null}
 */
export function findRowInApplications(apps, rowId) {
  if (!Array.isArray(apps) || rowId == null || rowId === '') return null;
  const rowIdStr = String(rowId).replace(/^0+/, '');
  const rowIdNum = Number(rowIdStr);
  for (const r of apps) {
    if (!r) continue;
    if (Number(r.num) === rowIdNum) return r;
  }
  return null;
}

/**
 * Resolve rowId → { ok, packInput, row, error }. `packInput` is the
 * SubAgentInput shape consumed by runCvTailor / runCoverLetter / etc.
 *
 * @param {number|string} rowId
 * @param {object} [opts]
 * @param {string} [opts.root]               Override repo root (test injection).
 * @param {Array<object>} [opts.rankedOverride]   Inject ranked array (test).
 * @param {Array<object>} [opts.appsOverride]     Inject applications array (test).
 * @param {object} [opts.config]             Extra config passed through to agent.
 * @returns {{ ok: boolean, packInput?: object, row?: object, slug?: string, error?: string, source?: string }}
 */
export function resolveRowToPackInput(rowId, opts = {}) {
  if (rowId == null || rowId === '') {
    return { ok: false, error: 'rowId is required' };
  }
  // Numeric validation — string with non-digit chars is invalid
  const rowIdStr = String(rowId).trim();
  if (!/^\d+$/.test(rowIdStr)) {
    return { ok: false, error: `rowId must be numeric (got: ${rowIdStr})` };
  }

  const root = opts.root || DEFAULT_ROOT;

  // 1. Look up in apply-now-queue.json (preferred — has all the live signals)
  let row = null;
  let source = null;
  if (Array.isArray(opts.rankedOverride)) {
    row = findRowInQueue(opts.rankedOverride, rowId);
    if (row) source = 'apply-now-queue';
  } else {
    const ranked = _loadRanked(root);
    row = findRowInQueue(ranked, rowId);
    if (row) source = 'apply-now-queue';
  }

  // 2. Fall back to applications.md (covers rows not in the apply-now-queue —
  //    Discarded rows, rows below the 4.0 score gate, historical rows, etc.)
  if (!row) {
    if (Array.isArray(opts.appsOverride)) {
      row = findRowInApplications(opts.appsOverride, rowId);
      if (row) source = 'applications.md';
    } else {
      const apps = _loadApplications(root);
      row = findRowInApplications(apps, rowId);
      if (row) source = 'applications.md';
    }
  }

  if (!row) {
    return {
      ok: false,
      error:
        `rowId=${rowIdStr} not found in apply-now-queue.json or applications.md. ` +
        `Re-run merge-tracker.mjs or rebuild-apply-now-queue.mjs if the row is new.`,
    };
  }

  const company = row.company || row.Company || '';
  const role = row.role || row.Role || row.roleTitle || '';
  const url = row.url || row.URL || row.canonical_url || '';

  if (!company || !role) {
    return {
      ok: false,
      error:
        `rowId=${rowIdStr} resolved (source=${source}) but missing ` +
        `company=${JSON.stringify(company)} or role=${JSON.stringify(role)}. ` +
        `Check the source row before retrying.`,
    };
  }

  // Build slug for the apply-pack directory the agent will write to.
  const padded = String(rowIdStr).padStart(3, '0');
  const slug = `${padded}-${slugify(company)}-${slugify(role)}`;

  // Build the full SubAgentInput shape. Matches scripts/cv-tailor-batch.mjs
  // line 220 `buildSubAgentInput()` for fidelity with the batch path.
  const packInput = {
    pack: {
      rowId: Number(rowIdStr),
      num: Number(rowIdStr),
      jd: {
        jd_text: '', // /api/build-pack-stage doesn't fetch JD; cv-tailor reads from cv.md only
        company,
        role,
        url,
      },
      corpus: {
        cv_path: 'cv.md',
        article_digest_path: 'article-digest.md',
        voice_reference_path: 'writing-samples/voice-reference.md',
      },
      meta: { row_id: Number(rowIdStr), company, role },
    },
  };

  return { ok: true, packInput, row, slug, source };
}

/**
 * Internal — load apply-now-queue.json ranked array.
 * Returns [] on any read/parse failure (resolver falls back to applications.md).
 *
 * @param {string} root
 * @returns {Array<object>}
 */
function _loadRanked(root) {
  try {
    const fp = join(root, 'data/apply-now-queue.json');
    if (!existsSync(fp)) return [];
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(data?.ranked) ? data.ranked : [];
  } catch {
    return [];
  }
}

/**
 * Internal — load applications.md as parsed rows.
 * Returns [] on any read/parse failure.
 *
 * @param {string} root
 * @returns {Array<object>}
 */
function _loadApplications(root) {
  try {
    const fp = join(root, 'data/applications.md');
    if (!existsSync(fp)) return [];
    return parseApplicationsFile(fp) || [];
  } catch {
    return [];
  }
}

// Test-only export for the internal loaders (allows tests to verify the
// fallback chain without filesystem injection)
export const _internal = { _loadRanked, _loadApplications };
