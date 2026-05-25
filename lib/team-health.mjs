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

// GAP-RES-13 (2026-05-24) — Team-health synthesizer hard cap. The closure plan
// budgeted ~$15-20/row for the Deep Refresh sweep; we set the per-row cap at
// $15 for safety (any single Sonnet narrative pass should land well below
// $0.30, so $15 is generous headroom + protection against a future scraper
// loop running unbounded). Surface caller via opts.budgetUsd for tighter caps.
export const TEAM_HEALTH_PER_ROW_USD_CAP = 15.0;

/**
 * Default no-op scrapers. The full Chrome MCP scrapers for each source live
 * in scripts/agents/team-health-scrapers/<source>.mjs (Phase 5.2 follow-up).
 * For v1 the synthesizer accepts an optional `opts.rawSignals` parameter so a
 * future scraper module can inject structured data without changing the
 * synthesizer contract. When rawSignals is absent, the synthesizer falls
 * back to a NEEDS_SCRAPERS status that callers can degrade against.
 *
 * Each provider key, when present in rawSignals, must conform to the schema
 * fragment documented in the file header (e.g., glassdoor: {url, overall_score, ...}).
 */
const SUPPORTED_PROVIDERS = ['glassdoor', 'indeed', 'blind', 'levels.fyi'];

function _stringifySignalsForPrompt(rawSignals) {
  if (!rawSignals || typeof rawSignals !== 'object') return '(no scraped signals provided)';
  const parts = [];
  for (const k of SUPPORTED_PROVIDERS) {
    if (!rawSignals[k]) continue;
    parts.push(`### ${k}\n` + JSON.stringify(rawSignals[k], null, 2));
  }
  return parts.length ? parts.join('\n\n') : '(no recognized provider keys in rawSignals)';
}

function _systemPromptForNarrative() {
  return [
    'You are a careful researcher synthesizing team-health intel from public review-site signals.',
    'Output JSON only — no markdown fences, no prose preamble.',
    '',
    'Voice constraints (load-bearing):',
    '- tone-safe framing: observation + reasoning, never judgment. No "failed", "broken", "bad culture" — use "concerning signal", "mixed feedback", "pattern flagged".',
    '- No corporate vocab: leverage, synergy, deep-dive, ideate, circle-back, ecosystem (banned).',
    '- Cite specific evidence where present. When a score is computed from limited data, label it "limited-sample" in toxicity_flags.',
    '- If signals are absent for a provider, omit that provider from sources; do NOT fabricate.',
    '',
    'Return shape (top-level keys required: scores, narrative, anecdotes, toxicity_flags, sources):',
    '{',
    '  "scores": { "overall": 0-5, "leadership": 0-5, "comp": 0-5, "growth": 0-5, "balance": 0-5 },',
    '  "narrative": "2-4 paragraph plain prose. No lists. Each paragraph names a specific signal source.",',
    '  "anecdotes": [{ "source": "glassdoor|indeed|blind|levels.fyi", "quote": "...", "date": "YYYY-MM-DD", "sentiment": "positive|mixed|negative" }],',
    '  "toxicity_flags": [ "string flags such as: high-attrition, layoffs-recent, pip-mentions, leadership-churn, pay-disparity, return-to-office-friction, limited-sample" ],',
    '  "sources": { "glassdoor": {...}, "indeed": {...}, "blind": {...}, "levels.fyi": {...} }',
    '}',
    '',
    'Set any score to null when zero signals support that dimension (e.g., scores.leadership: null if no leadership-specific quotes were scraped).',
  ].join('\n');
}

/**
 * Real synthesizer — GAP-RES-13 (2026-05-24). Replaces the prior NOT_IMPLEMENTED
 * stub. v1 architecture:
 *
 *   1. Check cache (loadTeamHealth + isFresh) — return CACHED if hit.
 *   2. Accept rawSignals from caller (Phase 5.2 will plug in Chrome MCP scrapers
 *      that produce this object). If rawSignals is absent, return NEEDS_SCRAPERS.
 *   3. Sonnet narrative agent reads rawSignals + emits canonical TeamHealth record.
 *   4. Save via saveTeamHealth (which validates schema).
 *   5. Return SYNTHESIZED with cost estimate.
 *
 * Spend cap: TEAM_HEALTH_PER_ROW_USD_CAP ($15/row). opts.budgetUsd can tighten.
 *
 * @param {string} companyName
 * @param {object} [opts]
 *   - force            : boolean (skip cache)
 *   - rowNums          : string[] (apply-now rows this serves; written to _meta)
 *   - budgetUsd        : number  (override default cap)
 *   - providers        : string[] (subset of SUPPORTED_PROVIDERS to attempt; v2)
 *   - rawSignals       : object  (pre-scraped data; see schema in file header)
 *   - mock             : object  (test-only — return this record verbatim)
 *   - callCouncil      : function (dependency-injection for tests)
 * @returns {Promise<{ status: 'NEEDS_SCRAPERS' | 'CACHED' | 'SYNTHESIZED' | 'ERROR' | 'BUDGET_EXCEEDED',
 *                    record: object|null,
 *                    cost_usd_estimate: number,
 *                    next_action: string }>}
 */
export async function synthesizeTeamHealth(companyName, opts = {}) {
  const slug = companySlugFromName(companyName);
  if (!slug) {
    return {
      status: 'ERROR',
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

  // Test escape hatch: caller can inject a fully-baked record (used in smoke tests).
  if (opts.mock && typeof opts.mock === 'object') {
    const result = saveTeamHealth(slug, {
      company: companyName,
      ...opts.mock,
      _meta: {
        owner: 'team-health-lib',
        schema_version: SCHEMA_VERSION,
        generated_by: 'synthesizeTeamHealth:mock',
        row_nums: opts.rowNums || [],
      },
    });
    return {
      status: result.ok ? 'SYNTHESIZED' : 'ERROR',
      record: result.ok ? loadTeamHealth(slug) : null,
      cost_usd_estimate: 0,
      next_action: result.ok ? 'mock record saved' : ('save failed: ' + JSON.stringify(result.issues)),
    };
  }

  // No rawSignals — without scrapers we can't synthesize. Return structured stub.
  if (!opts.rawSignals || typeof opts.rawSignals !== 'object') {
    return {
      status: 'NEEDS_SCRAPERS',
      record: null,
      cost_usd_estimate: 0,
      next_action: [
        'No rawSignals provided + no Chrome MCP scrapers wired in v1.',
        'To synthesize: pass opts.rawSignals = { glassdoor: {...}, indeed: {...}, blind: {...}, "levels.fyi": {...} } per the schema in lib/team-health.mjs header.',
        'Phase 5.2 follow-up: scripts/agents/team-health-scrapers/<source>.mjs modules will produce this object.',
      ].join(' '),
    };
  }

  const budgetUsd = typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0
    ? Math.min(opts.budgetUsd, TEAM_HEALTH_PER_ROW_USD_CAP)
    : TEAM_HEALTH_PER_ROW_USD_CAP;

  // Dependency-inject callCouncil for tests; production loads lib/council.mjs.
  let callCouncilFn = opts.callCouncil;
  if (!callCouncilFn) {
    try {
      const mod = await import('./council.mjs');
      callCouncilFn = mod.callCouncil;
    } catch (err) {
      return {
        status: 'ERROR',
        record: null,
        cost_usd_estimate: 0,
        next_action: 'failed to load lib/council.mjs: ' + err.message,
      };
    }
  }

  const prompt = [
    'Synthesize a team-health record for: ' + companyName,
    '',
    'Scraped public signals (only what successful scrapers returned; absent providers omitted):',
    _stringifySignalsForPrompt(opts.rawSignals),
    '',
    'Return JSON only matching the schema in the system message. No markdown fences.',
  ].join('\n');

  let council;
  try {
    council = await callCouncilFn({
      prompt,
      models: ['anthropic:claude-sonnet-4-6'],
      opts: {
        systemPrompt: _systemPromptForNarrative(),
        timeoutMs: 120_000,
        maxTokens: 4096,
      },
    });
  } catch (err) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd_estimate: 0,
      next_action: 'Sonnet narrative call failed: ' + err.message,
    };
  }

  // Find sonnet's response in the council result.
  const sonnet = council && council.results && council.results.find
    ? council.results.find(r => r.model && r.model.startsWith('anthropic:'))
    : null;
  const content = sonnet && sonnet.content ? sonnet.content : null;
  const costSpent = (sonnet && typeof sonnet.costUsd === 'number') ? sonnet.costUsd : 0;

  if (!content) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd_estimate: costSpent,
      next_action: 'Sonnet returned no content; council results: ' + JSON.stringify(council && council.results ? council.results.map(r => ({ model: r.model, status: r.status })) : null),
    };
  }

  if (costSpent > budgetUsd) {
    return {
      status: 'BUDGET_EXCEEDED',
      record: null,
      cost_usd_estimate: costSpent,
      next_action: `Sonnet call cost $${costSpent.toFixed(4)} exceeded budget cap $${budgetUsd.toFixed(2)} — record NOT saved`,
    };
  }

  // Parse Sonnet JSON. Be defensive: strip code fences if model included them.
  let parsed;
  try {
    const stripped = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd_estimate: costSpent,
      next_action: 'Sonnet returned non-JSON: ' + err.message + ' — first 240 chars: ' + String(content).slice(0, 240),
    };
  }

  const recordIn = {
    company: companyName,
    providers_called: Object.keys(opts.rawSignals),
    providers_succeeded: parsed.sources ? Object.keys(parsed.sources) : [],
    sources: parsed.sources || {},
    scores: parsed.scores || {},
    narrative: parsed.narrative || '',
    anecdotes: parsed.anecdotes || [],
    toxicity_flags: parsed.toxicity_flags || [],
    _meta: {
      owner: 'team-health-lib',
      schema_version: SCHEMA_VERSION,
      generated_by: 'synthesizeTeamHealth:sonnet-4-6',
      row_nums: opts.rowNums || [],
    },
  };

  const result = saveTeamHealth(slug, recordIn);
  if (!result.ok) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd_estimate: costSpent,
      next_action: 'saveTeamHealth validation failed: ' + JSON.stringify(result.issues),
    };
  }
  return {
    status: 'SYNTHESIZED',
    record: loadTeamHealth(slug),
    cost_usd_estimate: costSpent,
    next_action: `record saved to ${result.path}; under budget cap ($${costSpent.toFixed(4)} < $${budgetUsd.toFixed(2)})`,
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
