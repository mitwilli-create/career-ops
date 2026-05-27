/**
 * lib/intel-refresh-state.mjs — Disk-deriving status reader for intel-refresh slots.
 *
 * PR-E Phase 2 (2026-05-27). Phase 1 (PR #295, commit 18a4a95) shipped the
 * bug-fix to scripts/agents/intel-refresh.mjs so state.json HONESTLY tracks
 * slots_done + slots_failed. Phase 2 closes the parallel-write surface ENTIRELY
 * by making state.json a CACHE that's derived from disk on every read.
 *
 * After Phase 2: deleting state.json would NOT lose information — getRefreshStatus
 * re-derives slot completeness from disk artifacts every call. state.json's
 * only remaining role is the informational `last_refresh` ISO timestamp.
 *
 * Canonical incident (2026-05-26 row 2387 example-co): state.json claimed all
 * 10 slots done, but data/hm-intel/example-co-senior-forward-deployed-engineer.json
 * was missing on disk. Dashboard chip showed "fresh" while user clicked → got
 * stale/missing data.
 *
 * Source-of-truth contract (the WHOLE point of Phase 2):
 *   - Disk artifacts are source of truth for what's actually been computed.
 *   - state.json is informational only (last_refresh ISO + cached prior verdicts).
 *   - Every read re-derives slot completeness from disk.
 *
 * Slot path conventions are LOCKED to scripts/agents/intel-refresh.mjs §
 * refreshXxx functions. When that script's path conventions change, this
 * file's SLOT_DESCRIPTORS table MUST be updated in lockstep.
 *
 * Status semantics:
 *   - never-refreshed: zero slots done AND zero slots failed AND no state entry
 *   - partial:        0 < slots_done.length < expected_slot_count
 *   - complete:       all expected slots done AND last_refresh < STALE_TTL_DAYS
 *   - stale:          all expected slots done AND last_refresh >= STALE_TTL_DAYS
 *
 * Pure helpers exported for testability:
 *   - getRefreshStatus(rowId, opts?)  — main entry point
 *   - computeSlotFiles(row, opts?)    — pure: row → { slot → {path,size,mtime}|null }
 *   - deriveStatus(slots_done, slots_failed, last_refresh, expectedSlotCount, now)
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STALE_TTL_DAYS = 7;

// The 10 canonical slots intel-refresh.mjs fills. Each entry describes:
//   - name: slot key (matches state.json::rows[N].slots_done entries)
//   - kind: 'single' (one file path) | 'glob' (slug-suffixed file in dir) | 'dir' (apply-pack directory) | 'multi' (multiple paths, all required)
//   - resolve: function(row, opts) → string|string[] (absolute path or list)
//
// SLOT PATH CONVENTIONS (from scripts/agents/intel-refresh.mjs — keep in lockstep):
//   1. hm-intel:             data/hm-intel/<companySlug>-<roleSlug>.json
//   2. toxicity:             data/company-toxicity-cache/<companySlug>.json
//   3. strategy-ceiling:     data/strategy-ceiling/<padded>-<metric>.json (3 metrics: alignment / interview-likelihood / hm-noticing)
//   4. positioning:          data/positioning-cache/<padded>.json
//   5. liveness:             data/liveness-cache.json (URL-keyed shared file; existence + URL-key match)
//   6. ats-detection:        apply-pack/<padded>-<companySlug>-<roleSlug>/*.ai-detection.json (skip OK if pack dir missing)
//   7. role-enrichment:      data/role-enrichment/bf<num>-<slug>.json OR <rankPad>-<slug>.json (glob suffix match)
//   8. hm-chance:            data/hm-chance/<padded>-<slug>.json
//   9. interview-likelihood: data/interview-likelihood/<padded>-<slug>.json
//  10. team-health:          data/team-health/<companySlug>.json
//
// "legitimately skipped" cases (returns sentinel null but counts as done in
// status semantics): liveness with no canonical_url, ats-detection with no
// apply-pack on disk.

const SLOT_DESCRIPTORS = [
  {
    name: 'hm-intel',
    kind: 'single',
    resolve: (row) => join(ROOT, 'data', 'hm-intel', `${slugify(row.company)}-${slugify(row.role)}.json`),
  },
  {
    name: 'toxicity',
    kind: 'single',
    resolve: (row) => join(ROOT, 'data', 'company-toxicity-cache', `${slugify(row.company)}.json`),
  },
  {
    name: 'strategy-ceiling',
    kind: 'multi',
    resolve: (row) => {
      const padded = String(row.num).padStart(3, '0');
      return [
        join(ROOT, 'data', 'strategy-ceiling', `${padded}-alignment.json`),
        join(ROOT, 'data', 'strategy-ceiling', `${padded}-interview-likelihood.json`),
        join(ROOT, 'data', 'strategy-ceiling', `${padded}-hm-noticing.json`),
      ];
    },
  },
  {
    name: 'positioning',
    kind: 'single',
    resolve: (row) => join(ROOT, 'data', 'positioning-cache', `${String(row.num).padStart(3, '0')}.json`),
  },
  {
    name: 'liveness',
    kind: 'liveness',
    resolve: (row) => ({
      file: join(ROOT, 'data', 'liveness-cache.json'),
      url: row.canonical_url || row.url || null,
    }),
  },
  {
    name: 'ats-detection',
    kind: 'pack-dir',
    resolve: (row) => {
      const padded = String(row.num).padStart(3, '0');
      const packDir = join(ROOT, 'apply-pack', `${padded}-${slugify(row.company)}-${slugify(row.role)}`);
      return {
        packDir,
        sidecars: ['cv-tailored.md.ai-detection.json', 'cover-letter.md.ai-detection.json'],
      };
    },
  },
  {
    name: 'role-enrichment',
    kind: 'glob',
    resolve: (row) => {
      const slug = `${slugify(row.company)}-${slugify(row.role)}`;
      return {
        bf: join(ROOT, 'data', 'role-enrichment', `bf${row.num}-${slug}.json`),
        dir: join(ROOT, 'data', 'role-enrichment'),
        suffix: `-${slug}.json`,
      };
    },
  },
  {
    name: 'hm-chance',
    kind: 'single',
    resolve: (row) => {
      const slug = `${String(row.num).padStart(3, '0')}-${slugify(row.company)}-${slugify(row.role)}`;
      return join(ROOT, 'data', 'hm-chance', `${slug}.json`);
    },
  },
  {
    name: 'interview-likelihood',
    kind: 'single',
    resolve: (row) => {
      const slug = `${String(row.num).padStart(3, '0')}-${slugify(row.company)}-${slugify(row.role)}`;
      return join(ROOT, 'data', 'interview-likelihood', `${slug}.json`);
    },
  },
  {
    name: 'team-health',
    kind: 'single',
    resolve: (row) => join(ROOT, 'data', 'team-health', `${slugify(row.company)}.json`),
  },
];

const ALL_SLOT_NAMES = SLOT_DESCRIPTORS.map(d => d.name);

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function fileStat(path) {
  try {
    if (!existsSync(path)) return null;
    const s = statSync(path);
    if (!s.isFile()) return null;
    return { path, size: s.size, mtime: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Pure: compute per-slot disk-artifact descriptors for a single row.
 *
 * Returns Record<slot, { path, size, mtime } | null>. null means slot's
 * primary disk artifact is missing or zero-bytes. Legitimately-skipped slots
 * (liveness with no canonical_url, ats-detection with no apply-pack on disk)
 * return a sentinel { skipped: true, reason: '...' } so callers can distinguish
 * "never ran" from "ran and decided skip".
 *
 * @param {Object} row    — apply-now row { num, company, role, canonical_url?, url? }
 * @param {Object} [opts] — optional { rootOverride? } for testing
 */
export function computeSlotFiles(row, opts = {}) {
  const overrideRoot = opts.rootOverride;
  const slotFiles = {};
  for (const desc of SLOT_DESCRIPTORS) {
    if (desc.kind === 'single') {
      const path = desc.resolve(row);
      const resolvedPath = overrideRoot ? path.replace(ROOT, overrideRoot) : path;
      slotFiles[desc.name] = fileStat(resolvedPath);
    } else if (desc.kind === 'multi') {
      const paths = desc.resolve(row).map(p => overrideRoot ? p.replace(ROOT, overrideRoot) : p);
      const stats = paths.map(fileStat);
      // multi: all-required → array of valid descriptors OR null if any missing
      slotFiles[desc.name] = stats.every(s => s !== null) ? stats : null;
    } else if (desc.kind === 'liveness') {
      const { file, url } = desc.resolve(row);
      const resolvedFile = overrideRoot ? file.replace(ROOT, overrideRoot) : file;
      if (!url) {
        slotFiles[desc.name] = { skipped: true, reason: 'no-canonical-url' };
      } else {
        const fStat = fileStat(resolvedFile);
        if (!fStat) {
          slotFiles[desc.name] = null;
        } else {
          // Verify the URL key exists in the cache JSON
          try {
            const cache = JSON.parse(readFileSync(resolvedFile, 'utf-8'));
            slotFiles[desc.name] = cache && typeof cache === 'object' && cache[url]
              ? fStat
              : null;
          } catch {
            slotFiles[desc.name] = null;
          }
        }
      }
    } else if (desc.kind === 'pack-dir') {
      const { packDir, sidecars } = desc.resolve(row);
      const resolvedPackDir = overrideRoot ? packDir.replace(ROOT, overrideRoot) : packDir;
      if (!existsSync(resolvedPackDir)) {
        // legitimately skipped — no apply-pack on disk
        slotFiles[desc.name] = { skipped: true, reason: 'no-apply-pack' };
      } else {
        const sidecarPaths = sidecars.map(s => join(resolvedPackDir, s));
        const stats = sidecarPaths.map(fileStat).filter(Boolean);
        slotFiles[desc.name] = stats.length > 0 ? stats : null;
      }
    } else if (desc.kind === 'glob') {
      const { bf, dir, suffix } = desc.resolve(row);
      const resolvedBf = overrideRoot ? bf.replace(ROOT, overrideRoot) : bf;
      const resolvedDir = overrideRoot ? dir.replace(ROOT, overrideRoot) : dir;
      // Prefer bf prefix; fall back to any file matching slug suffix
      let stat = fileStat(resolvedBf);
      if (!stat && existsSync(resolvedDir)) {
        try {
          const matches = readdirSync(resolvedDir).filter(f => f.endsWith(suffix));
          for (const f of matches) {
            stat = fileStat(join(resolvedDir, f));
            if (stat) break;
          }
        } catch { /* fall through */ }
      }
      slotFiles[desc.name] = stat;
    }
  }
  return slotFiles;
}

/**
 * Pure: derive top-level status from per-slot disk presence + state-file metadata.
 *
 * @param {string[]} slots_done    — slot names with valid disk artifact OR legitimate skip
 * @param {string[]} slots_failed  — slot names known to have failed
 * @param {string|null} last_refresh — ISO timestamp from state.json (informational)
 * @param {number} expectedSlotCount — usually 10 (ALL_SLOT_NAMES.length)
 * @param {number} [nowMs]         — for testability
 */
export function deriveStatus(slots_done, slots_failed, last_refresh, expectedSlotCount, nowMs = Date.now()) {
  const done = (slots_done || []).length;
  const failed = (slots_failed || []).length;
  if (done === 0 && failed === 0 && !last_refresh) return 'never-refreshed';
  if (done < expectedSlotCount) return 'partial';
  // done === expectedSlotCount → check staleness via last_refresh
  if (last_refresh) {
    const ageMs = nowMs - Date.parse(last_refresh);
    if (Number.isFinite(ageMs) && ageMs >= STALE_TTL_DAYS * 86400000) return 'stale';
  }
  return 'complete';
}

/**
 * Look up a row by rowId from data/apply-now-queue.json.
 *
 * @param {string|number} rowId
 * @param {Object} [opts] — { queuePath? } override for testing
 * @returns {Object|null} row or null
 */
export function lookupRow(rowId, opts = {}) {
  const queuePath = opts.queuePath || join(ROOT, 'data', 'apply-now-queue.json');
  if (!existsSync(queuePath)) return null;
  try {
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    const ranked = Array.isArray(queue?.ranked) ? queue.ranked : [];
    const id = Number(rowId);
    return ranked.find(r => r && Number(r.num) === id) || null;
  } catch {
    return null;
  }
}

/**
 * MAIN ENTRY POINT — disk-derived refresh status for one row.
 *
 * Reads state.json ONLY for the informational last_refresh timestamp.
 * Computes slots_done + slots_failed from disk every call. If state.json is
 * absent or stale relative to disk, disk wins.
 *
 * @param {string|number} rowId
 * @param {Object} [opts] — { rootOverride?, queuePath?, statePath? } for testing
 * @returns {{
 *   slots_done:    string[],
 *   slots_failed:  string[],
 *   slots_missing: string[],
 *   last_refresh:  string|null,
 *   status:        'never-refreshed' | 'partial' | 'complete' | 'stale',
 *   slot_files:    Record<string, { path, size, mtime } | { skipped, reason } | null>
 * }}
 */
export function getRefreshStatus(rowId, opts = {}) {
  const row = lookupRow(rowId, opts);
  if (!row) {
    return {
      slots_done: [],
      slots_failed: [],
      slots_missing: [...ALL_SLOT_NAMES],
      last_refresh: null,
      status: 'never-refreshed',
      slot_files: Object.fromEntries(ALL_SLOT_NAMES.map(s => [s, null])),
      error: `row ${rowId} not in apply-now-queue`,
    };
  }

  const slot_files = computeSlotFiles(row, opts);

  // Read state.json — last_refresh ONLY. Disk-derive everything else.
  const overrideRoot = opts.rootOverride;
  const statePath = opts.statePath
    || (overrideRoot
      ? join(overrideRoot, 'data', 'intel-refresh-state.json')
      : join(ROOT, 'data', 'intel-refresh-state.json'));

  let stateRow = null;
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      stateRow = state?.rows?.[String(rowId)] || state?.rows?.[Number(rowId)] || null;
    } catch { /* corrupt state → treat as missing */ }
  }

  // Classify each slot from disk
  const slots_done = [];
  const slots_failed = [];
  const slots_missing = [];
  for (const slot of ALL_SLOT_NAMES) {
    const v = slot_files[slot];
    if (v === null) {
      // Disk says missing. Was it claimed in state.slots_failed? → 'failed' (known failure)
      // Was it claimed in state.slots_done? → state lied; still 'missing' (disk wins)
      // Otherwise → never-attempted 'missing'
      const failedEntry = Array.isArray(stateRow?.slots_failed)
        ? stateRow.slots_failed.find(f => f?.slot === slot)
        : null;
      if (failedEntry) {
        slots_failed.push(slot);
      } else {
        slots_missing.push(slot);
      }
    } else if (v && typeof v === 'object' && v.skipped) {
      // Legitimately skipped → counts as done
      slots_done.push(slot);
    } else {
      // Valid disk artifact (or array thereof) → done
      slots_done.push(slot);
    }
  }

  const last_refresh = stateRow?.last_refresh || null;
  const status = deriveStatus(slots_done, slots_failed, last_refresh, ALL_SLOT_NAMES.length);

  return {
    slots_done: slots_done.sort(),
    slots_failed: slots_failed.sort(),
    slots_missing: slots_missing.sort(),
    last_refresh,
    status,
    slot_files,
  };
}

/**
 * Convenience: ALL_SLOT_NAMES for callers that want the canonical slot list.
 */
export function getSlotNames() {
  return [...ALL_SLOT_NAMES];
}

export const _internals = { SLOT_DESCRIPTORS, ALL_SLOT_NAMES, STALE_TTL_DAYS, slugify };
