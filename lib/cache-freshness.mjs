/**
 * lib/cache-freshness.mjs — Shared cache-freshness threshold registry.
 *
 * Single source of truth for every cache surface's TTL. Used by:
 *   - scripts/build-dashboard.mjs  (drawer staleness badges — D2)
 *   - scripts/agents/system-maintainer.mjs (90d archive sweep — D4)
 *   - lib/team-health.mjs (already has its own isFresh; cross-reference only)
 *   - Any new consumer that needs to check cache age
 *
 * PR-09 (apply-now UX overhaul, 2026-05-25).
 *
 * Design rules:
 *   - apply-pack surfaces are Infinity (never stale — human-curated)
 *   - network-database mirrors the refresh-cache-registry.mjs Layer-1 cadence
 *   - hm-intel, interview-likelihood, hm-chance, strategy-ceiling: 14d per
 *     refresh-cache-registry.mjs:hardMaxTtlDays
 *   - context-notes: 24h (generated on-demand, cheap to regenerate)
 *   - role-enrichment: 30d (per comp-researcher.mjs + refresh-cache-registry)
 *   - team-health: 7d (3d TTL for internal isFresh; 7d here is "drawer badge"
 *     threshold — softer, shows "updated N days ago" but still actionable)
 *
 * tone-safe note: callers should NOT use the word "stale" in user-facing copy.
 * Use "Updated N days ago — refresh?" or "Data is N days old — refresh?" instead.
 */

import { statSync } from 'node:fs';

// ── Registry ──────────────────────────────────────────────────────────────────

export const CACHE_FRESHNESS_THRESHOLDS_MS = {
  'hm-intel':             14 * 24 * 60 * 60 * 1000,   // 14 days
  'team-health':           7 * 24 * 60 * 60 * 1000,   //  7 days
  'context-notes':             24 * 60 * 60 * 1000,   // 24 hours
  'role-enrichment':      30 * 24 * 60 * 60 * 1000,   // 30 days
  'strategy-ceiling':     14 * 24 * 60 * 60 * 1000,   // 14 days
  'interview-likelihood': 14 * 24 * 60 * 60 * 1000,   // 14 days
  'hm-chance':            14 * 24 * 60 * 60 * 1000,   // 14 days
  'apply-pack':                         Infinity,       // never stale (human-curated)
  'network-database':      7 * 24 * 60 * 60 * 1000,   //  7 days
};

/**
 * Returns true when the file at `cacheFile` is within the freshness window
 * for `cacheDir` (one of the keys in CACHE_FRESHNESS_THRESHOLDS_MS).
 *
 * @param {string} cacheDir   - one of the registry keys above
 * @param {string} cacheFile  - absolute path to the cache file
 * @returns {boolean}
 */
export function isCacheFresh(cacheDir, cacheFile) {
  const threshold = CACHE_FRESHNESS_THRESHOLDS_MS[cacheDir];
  if (threshold === Infinity) return true;
  if (threshold == null) return true; // unknown dir → don't flag as stale
  try {
    const mtimeMs = statSync(cacheFile).mtimeMs;
    return (Date.now() - mtimeMs) < threshold;
  } catch {
    return false; // file missing → not fresh
  }
}

/**
 * Returns an age bucket for `cacheFile` relative to `cacheDir`'s threshold.
 *
 * @param {string} cacheDir   - one of the registry keys above
 * @param {string} cacheFile  - absolute path to the cache file
 * @returns {{
 *   ageMs: number,
 *   ageDays: number,
 *   threshold: number,
 *   isFresh: boolean,
 *   ageDaysDisplay: string   - e.g. "2 days" or "23 hours"
 * }}
 */
export function cacheAgeBucket(cacheDir, cacheFile) {
  const threshold = CACHE_FRESHNESS_THRESHOLDS_MS[cacheDir] ?? Infinity;
  let mtimeMs;
  try {
    mtimeMs = statSync(cacheFile).mtimeMs;
  } catch {
    return {
      ageMs: Infinity, ageDays: Infinity, threshold,
      isFresh: false, ageDaysDisplay: '?',
      missing: true,
    };
  }
  const ageMs   = Date.now() - mtimeMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // Display: use hours when < 2 days, days otherwise
  const ageDaysDisplay = ageMs < 48 * 60 * 60 * 1000
    ? `${Math.round(ageMs / (60 * 60 * 1000))} hours`
    : `${Math.floor(ageDays)} days`;

  return {
    ageMs,
    ageDays,
    threshold,
    isFresh: threshold === Infinity ? true : ageMs < threshold,
    ageDaysDisplay,
    missing: false,
  };
}

/**
 * Build an tone-safe staleness badge HTML string (or '' when fresh/not applicable).
 *
 * "Updated N days ago — refresh?" with a link to the auto-enrich endpoint.
 * Never uses "stale", "broken", or "missing" in user-facing copy.
 *
 * @param {{
 *   cacheDir: string,           - registry key
 *   cacheFile: string,          - absolute path
 *   slot: string,               - auto-enrich slot name (e.g., 'hm-intel')
 *   slug: string,               - row slug for the auto-enrich endpoint
 *   alwaysShow?: boolean,       - if true show even when fresh (for debugging)
 * }} opts
 * @returns {string}  HTML fragment or ''
 */
export function renderCacheStalenessInline({ cacheDir, cacheFile, slot, slug, alwaysShow = false }) {
  if (CACHE_FRESHNESS_THRESHOLDS_MS[cacheDir] === Infinity) return ''; // apply-pack
  const bucket = cacheAgeBucket(cacheDir, cacheFile);
  if (bucket.isFresh && !alwaysShow) return '';
  const ageStr = bucket.missing ? 'No data yet' : `Updated ${bucket.ageDaysDisplay} ago`;
  const _esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const href = `/api/drawer/auto-enrich?slot=${encodeURIComponent(slot)}&slug=${encodeURIComponent(slug)}`;
  return `<span class="cache-freshness-badge" style="display:inline-block;font-size:11px;color:var(--text-3,#8a8b96);margin-left:6px;white-space:nowrap">${_esc(ageStr)} — <a href="${_esc(href)}" rel="noopener" onclick="event.stopPropagation()" style="color:var(--blue-fg,#0a84ff);text-decoration:underline dotted;font-size:11px" title="Refresh ${_esc(slot)} cache for this row">refresh? →</a></span>`;
}
