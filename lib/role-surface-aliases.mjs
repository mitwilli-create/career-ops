/**
 * lib/role-surface-aliases.mjs — registry I/O for L5 surface-alias data.
 *
 * Records the "this URL is a different surface of canonical applications.md
 * row #N" mapping, so the triage→eval pipeline can skip eval $ on URLs that
 * point at roles already evaluated on another surface (LinkedIn ↔ Greenhouse
 * ↔ Ashby ↔ company-site).
 *
 * The registry lives at data/role-surface-aliases.json (gitignored). Append-
 * only; dedup-safe at write time (skips entries where (canonical_num, alias_url)
 * already exists).
 *
 * Registry shape:
 *   {
 *     schema_version: 1,
 *     last_updated: ISO,
 *     entries: [
 *       {
 *         canonical_num: '2594',
 *         alias_url: 'https://linkedin.com/jobs/view/...',
 *         surface: 'linkedin'|'greenhouse'|'ashby'|'lever'|'amazon'|'workday'|'company-site'|'other',
 *         method: 'exact-equal'|'sonnet-confirmed-fuzzy',
 *         confidence: 1.0,
 *         detected_at: ISO,
 *         triage_score: 4.3,                 // score from triage at detection time
 *         triage_archetype: 'A2'             // archetype from triage
 *       },
 *       ...
 *     ]
 *   }
 *
 * L5 of the 2026-05-27 dedupe-defense PR sequence (#308 → #310 stacked-on-main).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REGISTRY_PATH = join(ROOT, 'data', 'role-surface-aliases.json');

const SCHEMA_VERSION = 1;

const SURFACE_BY_HOST = [
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)greenhouse\.io$|job-boards\.greenhouse\.io$/, 'greenhouse'],
  [/(^|\.)ashbyhq\.com$|jobs\.ashbyhq\.com$/, 'ashby'],
  [/(^|\.)lever\.co$|jobs\.lever\.co$/, 'lever'],
  [/(^|\.)amazon\.jobs$/, 'amazon'],
  [/myworkdayjobs\.com$/, 'workday'],
  [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
  [/(^|\.)icims\.com$/, 'icims'],
];

/** Infer surface from URL host. Returns 'company-site' as fallback. */
export function inferSurface(url) {
  if (!url) return 'other';
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const [re, surface] of SURFACE_BY_HOST) {
      if (re.test(host)) return surface;
    }
    return 'company-site';
  } catch {
    return 'other';
  }
}

/** Load the registry. Returns the empty-shape if file is absent. */
export function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { schema_version: SCHEMA_VERSION, last_updated: null, entries: [] };
  }
  try {
    const obj = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    if (!obj || typeof obj !== 'object') {
      return { schema_version: SCHEMA_VERSION, last_updated: null, entries: [] };
    }
    obj.entries = Array.isArray(obj.entries) ? obj.entries : [];
    return obj;
  } catch (err) {
    // Corrupted file — preserve as .corrupt + start fresh.
    try {
      renameSync(REGISTRY_PATH, REGISTRY_PATH + '.corrupt.' + Date.now());
    } catch { /* best effort */ }
    return { schema_version: SCHEMA_VERSION, last_updated: null, entries: [] };
  }
}

/** Append a new alias entry. Dedup-safe (skips if (canonical_num, alias_url) already exists). */
export function recordSurfaceAlias({
  canonical_num,
  alias_url,
  method,
  confidence,
  triage_score = null,
  triage_archetype = null,
  detected_at = new Date().toISOString(),
}) {
  if (!canonical_num || !alias_url) {
    return { added: false, reason: 'missing required field (canonical_num | alias_url)' };
  }
  const registry = loadRegistry();
  const numStr = String(canonical_num);
  const dupe = registry.entries.find(
    (e) => String(e.canonical_num) === numStr && e.alias_url === alias_url,
  );
  if (dupe) return { added: false, reason: 'duplicate', existing: dupe };

  const surface = inferSurface(alias_url);
  const entry = {
    canonical_num: numStr,
    alias_url,
    surface,
    method,
    confidence,
    detected_at,
    triage_score,
    triage_archetype,
  };
  registry.entries.push(entry);
  registry.last_updated = detected_at;
  registry.schema_version = SCHEMA_VERSION;

  // Atomic write: tmp + rename
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  const tmp = REGISTRY_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, REGISTRY_PATH);
  return { added: true, entry };
}

/** Read aliases for a given canonical row (for dashboard "N other surfaces" badge). */
export function aliasesFor(canonical_num) {
  const registry = loadRegistry();
  const numStr = String(canonical_num);
  return registry.entries.filter((e) => String(e.canonical_num) === numStr);
}

/** True if this URL is already recorded as an alias of any canonical row. */
export function isKnownAliasUrl(url) {
  if (!url) return false;
  const registry = loadRegistry();
  return registry.entries.some((e) => e.alias_url === url);
}

export const REGISTRY_PATH_FOR_TESTS = REGISTRY_PATH;
