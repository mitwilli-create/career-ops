/**
 * scripts/lib/row-resolver.mjs — resolve any row by num/slug
 *
 * Shared utility for chip-popout agents (hm-chance, interview-likelihood,
 * future ones) that originally hardcoded a 4-row PASS_ROWS allowlist.
 * Deep-refresh button promises "populate all chips for any row in the
 * pipeline"; this resolver closes the gap by walking three sources in
 * priority order:
 *
 *   1. data/apply-now-queue.json (ranked[] — highest-priority pipeline rows)
 *   2. data/applications.md      (full evaluation tracker)
 *   3. (legacy PASS_ROWS lookup is the caller's responsibility)
 *
 * Returns { num, company, role, slug } or null.
 *
 * Slug convention follows apply-pack/<NNN>-<company-slug>-<role-slug>/ —
 * 3-digit zero-pad for rows < 1000, no pad above. See AGENTS.md § TSV Format.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function padNum(n) {
  const s = String(n);
  return s.length < 3 ? s.padStart(3, '0') : s;
}

export function buildSlug(num, company, role) {
  return `${padNum(num)}-${slugify(company)}-${slugify(role)}`;
}

/**
 * Resolve a row by num or slug. Returns { num, company, role, slug } or null.
 * Walks apply-now-queue.json first (cheapest), then applications.md.
 */
export function resolveRow(rowIdOrSlug) {
  if (rowIdOrSlug == null || rowIdOrSlug === '') return null;
  const key = String(rowIdOrSlug);

  // Source 1: apply-now-queue.json
  try {
    const apqPath = join(ROOT, 'data', 'apply-now-queue.json');
    if (existsSync(apqPath)) {
      const apq = JSON.parse(readFileSync(apqPath, 'utf-8'));
      const ranked = apq.ranked || [];
      const match = ranked.find(r => {
        if (!r) return false;
        if (String(r.num) === key) return true;
        if (r.slug && r.slug === key) return true;
        return false;
      });
      if (match && match.company && match.role) {
        const slug = match.slug || buildSlug(match.num, match.company, match.role);
        return { num: match.num, company: match.company, role: match.role, slug };
      }
    }
  } catch { /* fall through */ }

  // Source 2: applications.md
  try {
    const appsPath = join(ROOT, 'data', 'applications.md');
    if (existsSync(appsPath)) {
      const lines = readFileSync(appsPath, 'utf-8').split('\n');
      for (const ln of lines) {
        // Match: | NNN | YYYY-MM-DD | Company | Role | X.X/5 | Status | ...
        const m = ln.match(/^\|\s*(\d+)\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
        if (!m) continue;
        const [, num, company, role] = m;
        const slug = buildSlug(num, company, role);
        if (String(num) === key || slug === key) {
          return { num: Number(num), company: company.trim(), role: role.trim(), slug };
        }
      }
    }
  } catch { /* fall through */ }

  return null;
}
