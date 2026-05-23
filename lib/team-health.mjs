/**
 * lib/team-health.mjs — Team-health intel per company (Phase 5.1, 2026-05-22)
 *
 * Purpose: power the drawer's "Team Health" pop-out widget (8.53.08 ask).
 * Reads + writes data/team-health/<company-slug>.json with a canonical
 * schema; renderers in scripts/build-dashboard.mjs consume the load API to
 * surface scores + narrative + anecdotes per company.
 *
 * THIS COMMIT ships the schema + load/save + cache-TTL plumbing + a stub
 * synthesizer. The full synthesize implementation (Chrome MCP scrape of
 * Glassdoor / Indeed / Blind / levels.fyi + Sonnet narrative agent) is its
 * own work-package (Phase 5.1 council research), best done after Phase 1.5
 * lands so we know which companies to prioritize.
 *
 * Why ship the stub now: lets Phase 4 drawer work (Polish Materials button,
 * Pre-Apply Check, Deep Refresh) be written against a stable contract
 * without waiting for the heavy synthesizer. Tests are runnable today.
 *
 * Exports:
 *   loadTeamHealth(companySlug)            → cached intel or null
 *   saveTeamHealth(companySlug, data)      → writes + validates schema
 *   isFresh(record, maxAgeMs?)             → true if within TTL (3d default)
 *   companySlugFromName(name)              → slugifier matching the gate
 *   synthesizeTeamHealth(name, opts)       → STUB; returns NOT_IMPLEMENTED
 *   TEAM_HEALTH_SCHEMA                     → JSON-schema-like type guide
 *   TEAM_HEALTH_DIR                        → absolute path constant
 *
 * Schema (`data/team-health/<company-slug>.json`):
 *   {
 *     company:           string,
 *     company_slug:      string,
 *     synthesized_at:    ISO-8601 string,
 *     providers_called:  string[],      // sources scraped this run
 *     providers_succeeded: string[],    // subset that returned data
 *     sources: {
 *       glassdoor?:  { url, last_reviewed_at, sample_count, overall_score, leadership_score, comp_score, growth_score, balance_score },
 *       indeed?:     { url, last_reviewed_at, sample_count, overall_score },
 *       blind?:      { url, last_reviewed_at, sample_count, sentiment_score, churn_mentions },
 *       levels_fyi?: { url, comp_p50, comp_p90, last_compensation_data_at }
 *     },
 *     scores: {
 *       overall:    0-5,
 *       leadership: 0-5,
 *       comp:       0-5,
 *       growth:     0-5,
 *       balance:    0-5
 *     },
 *     narrative:   string,              // 2-4 paragraph Sonnet-rewritten summary
 *     anecdotes: [
 *       { source: 'glassdoor' | 'indeed' | 'blind' | 'levels.fyi',
 *         quote: string,
 *         date:  ISO date,
 *         role_context?: string,
 *         sentiment: 'positive' | 'mixed' | 'negative' }
 *     ],
 *     toxicity_flags: string[],         // null-or-empty when clean
 *     _meta: {
 *       owner: 'team-health-lib',
 *       schema_version: '1.0.0',
 *       generated_by: 'synthesizeTeamHealth' | 'manual' | <agent-name>,
 *       row_nums: string[]              // apply-now-queue rows this serves
 *     }
 *   }
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const TEAM_HEALTH_DIR = join(REPO_ROOT, 'data/team-health');

export const TEAM_HEALTH_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 3 days
export const SCHEMA_VERSION = '1.0.0';

export const TEAM_HEALTH_SCHEMA = {
  required: ['company', 'company_slug', 'synthesized_at', 'scores', '_meta'],
  scoreKeys: ['overall', 'leadership', 'comp', 'growth', 'balance'],
  scoreRange: [0, 5],
  knownProviders: ['glassdoor', 'indeed', 'blind', 'levels.fyi'],
  anecdoteSentiments: ['positive', 'mixed', 'negative'],
};

/** Canonical slugifier (matches lib/apply-now-queue-gate.mjs companySlug). */
export function companySlugFromName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pathFor(companySlug) {
  return join(TEAM_HEALTH_DIR, `${companySlug}.json`);
}

/**
 * @param {string} companySlug
 * @returns {object|null}  Parsed record, or null if missing/unreadable.
 */
export function loadTeamHealth(companySlug) {
  const p = pathFor(companySlug);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} record   Loaded team-health record (or null).
 * @param {number} [maxAgeMs=TEAM_HEALTH_TTL_MS]
 * @returns {boolean}       True if record exists and is within TTL.
 */
export function isFresh(record, maxAgeMs = TEAM_HEALTH_TTL_MS) {
  if (!record || !record.synthesized_at) return false;
  const t = Date.parse(record.synthesized_at);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) < maxAgeMs;
}

/** Lightweight schema check — returns array of issue strings; empty = valid. */
export function validateRecord(record) {
  const issues = [];
  if (!record || typeof record !== 'object') {
    issues.push('record is not an object');
    return issues;
  }
  for (const k of TEAM_HEALTH_SCHEMA.required) {
    if (!(k in record)) issues.push(`missing required field: ${k}`);
  }
  if (record.scores) {
    for (const k of TEAM_HEALTH_SCHEMA.scoreKeys) {
      const v = record.scores[k];
      if (v == null) continue;  // optional per-key
      if (typeof v !== 'number') { issues.push(`scores.${k} is not a number`); continue; }
      const [lo, hi] = TEAM_HEALTH_SCHEMA.scoreRange;
      if (v < lo || v > hi) issues.push(`scores.${k} (${v}) outside [${lo}, ${hi}]`);
    }
  }
  if (record.providers_called && !Array.isArray(record.providers_called)) {
    issues.push('providers_called is not an array');
  }
  if (record.anecdotes && !Array.isArray(record.anecdotes)) {
    issues.push('anecdotes is not an array');
  }
  return issues;
}

/**
 * @param {string} companySlug
 * @param {object} data    Either a partial record (will be merged with
 *                         _meta + synthesized_at defaults) or a full record.
 * @returns {{ ok: boolean, path: string, issues?: string[] }}
 */
export function saveTeamHealth(companySlug, data) {
  if (!companySlug) return { ok: false, path: '', issues: ['empty companySlug'] };
  const record = {
    synthesized_at: new Date().toISOString(),
    company_slug: companySlug,
    ...data,
    _meta: {
      owner: 'team-health-lib',
      schema_version: SCHEMA_VERSION,
      ...(data && data._meta),
    },
  };
  const issues = validateRecord(record);
  if (issues.length > 0) return { ok: false, path: pathFor(companySlug), issues };
  if (!existsSync(TEAM_HEALTH_DIR)) mkdirSync(TEAM_HEALTH_DIR, { recursive: true });
  const p = pathFor(companySlug);
  writeFileSync(p, JSON.stringify(record, null, 2));
  return { ok: true, path: p };
}

/**
 * STUB synthesizer — the heavy Chrome MCP scrape + Sonnet narrative agent
 * lives in a follow-up Phase 5.1 PR. Returns a structured NOT_IMPLEMENTED
 * payload so callers can degrade gracefully (e.g., dashboard pop-out shows
 * "team health pending; click to queue for next refresh").
 *
 * @param {string} companyName
 * @param {object} [opts]   { force?, rowNums?, budgetUsd?, providers? }
 * @returns {Promise<{ status: 'NOT_IMPLEMENTED' | 'CACHED' | 'SYNTHESIZED',
 *                    record: object|null,
 *                    cost_usd_estimate: number,
 *                    next_action: string }>}
 */
export async function synthesizeTeamHealth(companyName, opts = {}) {
  const slug = companySlugFromName(companyName);
  if (!slug) {
    return {
      status: 'NOT_IMPLEMENTED',
      record: null,
      cost_usd_estimate: 0,
      next_action: 'invalid company name — slug is empty',
    };
  }
  const existing = loadTeamHealth(slug);
  if (existing && isFresh(existing) && !opts.force) {
    return {
      status: 'CACHED',
      record: existing,
      cost_usd_estimate: 0,
      next_action: 'returning cached record (< 3 days old)',
    };
  }
  // Full synthesizer not implemented yet — return structured stub so
  // callers can degrade. Phase 5.1 follow-up replaces this body with the
  // real Chrome MCP scrape + Sonnet narrative agent.
  return {
    status: 'NOT_IMPLEMENTED',
    record: null,
    cost_usd_estimate: 0,
    next_action: 'Phase 5.1 follow-up: implement Chrome MCP scrape of Glassdoor / Indeed / Blind / levels.fyi for ' + companyName + ', then Sonnet-narrative agent.',
  };
}

/**
 * Convenience used by the dashboard build at render time. Returns a slim
 * object the chip/pop-out templates consume directly.
 *
 * @param {string} companyName
 * @returns {{ available: boolean, fresh: boolean, scores: object|null,
 *             narrative: string|null, sources: object|null,
 *             synthesized_at: string|null }}
 */
export function snapshotForRender(companyName) {
  const slug = companySlugFromName(companyName);
  const record = slug ? loadTeamHealth(slug) : null;
  if (!record) {
    return {
      available: false,
      fresh: false,
      scores: null,
      narrative: null,
      sources: null,
      synthesized_at: null,
    };
  }
  return {
    available: true,
    fresh: isFresh(record),
    scores: record.scores || null,
    narrative: record.narrative || null,
    sources: record.sources || null,
    synthesized_at: record.synthesized_at || null,
  };
}
