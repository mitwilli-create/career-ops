/**
 * lib/tto-estimator.mjs — Time-to-Offer estimator per company/role.
 *
 * Value-neutral velocity estimator. Given a company name (plus optional
 * funding-stage hint), returns an expected apply→offer cycle in weeks
 * along with a coarse velocity tier. Useful as a "this company moves
 * fast" insight when comparing roles, without imposing any external
 * scoring boost or penalty on the result.
 *
 * This module exports `estimateTTO(company, opts)` which returns:
 *   {
 *     weeks_estimate: number,       // expected total cycle (apply → offer)
 *     velocity_tier: 'fast'|'med'|'slow'|'glacial',
 *     basis: 'override'|'company_specific'|'stage_default'|'unknown',
 *     confidence: 'high'|'med'|'low',
 *     source: string,
 *   }
 *
 * Resolution order:
 *   1. data/tto-overrides.json (user-curated per-company intel — wins)
 *   2. Company-specific table below (known patterns from public reviews)
 *   3. Stage default lookup (funding stage → typical cycle)
 *   4. Fallback (unknown → conservative 10 weeks)
 *
 * Used by:
 *   - apply-now-queue surfacing ("fast-moving" / "glacial" hints)
 *   - council brief prompt (asks council to surface TTO signals to update overrides)
 *
 * The previous `scoreTTOBonus` helper was retired 2026-05-25 alongside the
 * runway-scarcity scoring model; only the value-neutral estimate remains.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERRIDES_PATH = join(ROOT, 'data/tto-overrides.json');

// ── Stage defaults (weeks) ──────────────────────────────────────────────
// Based on aggregate Glassdoor + HN + recruiter Twitter signal as of 2026-05.
const STAGE_DEFAULTS = {
  'pre-seed':       { weeks: 3,  tier: 'fast',    confidence: 'low'  },
  'seed':           { weeks: 4,  tier: 'fast',    confidence: 'med'  },
  'series-a':       { weeks: 5,  tier: 'fast',    confidence: 'med'  },
  'series-b':       { weeks: 7,  tier: 'med',     confidence: 'med'  },
  'series-c':       { weeks: 9,  tier: 'med',     confidence: 'med'  },
  'series-d-plus':  { weeks: 11, tier: 'slow',    confidence: 'med'  },
  'late-private':   { weeks: 12, tier: 'slow',    confidence: 'med'  },
  'public':         { weeks: 14, tier: 'glacial', confidence: 'high' },
  'unknown':        { weeks: 10, tier: 'med',     confidence: 'low'  },
};

// ── Company-specific overrides (known patterns) ─────────────────────────
// Keys are lowercased + slug-friendly (a-z 0-9 hyphens). Update via
// data/tto-overrides.json — this table is for the most-canonical cases.
const COMPANY_SPECIFIC = {
  'anthropic':       { weeks: 6,  tier: 'fast',  confidence: 'high', note: '5-stage panel, typically 4-8 weeks per recent Glassdoor + recruiter signal' },
  'openai':          { weeks: 7,  tier: 'med',   confidence: 'high', note: '6-stage panel, 5-10 weeks; some teams faster' },
  'xai':             { weeks: 4,  tier: 'fast',  confidence: 'med',  note: 'Lean process, founder-involved, 2-6 weeks' },
  'google':          { weeks: 12, tier: 'slow',  confidence: 'high', note: 'Multi-round + committee review, 10-16 weeks typical' },
  'google-deepmind': { weeks: 12, tier: 'slow',  confidence: 'high', note: 'Same Google process + research-team review' },
  'meta':            { weeks: 10, tier: 'slow',  confidence: 'high', note: 'On-site loop + team match, 8-14 weeks' },
  'microsoft':       { weeks: 11, tier: 'slow',  confidence: 'med',  note: '8-14 weeks, role-dependent' },
  'apple':           { weeks: 13, tier: 'glacial', confidence: 'high', note: 'Secretive + multi-stage, 10-18 weeks' },
  'amazon':          { weeks: 8,  tier: 'med',   confidence: 'med',  note: 'Bar-raiser loop, 6-12 weeks' },
  'mistral':         { weeks: 5,  tier: 'fast',  confidence: 'med',  note: 'European process, lean, 4-8 weeks' },
  'cohere':          { weeks: 6,  tier: 'fast',  confidence: 'med',  note: '5-stage, 4-8 weeks' },
  'perplexity':      { weeks: 5,  tier: 'fast',  confidence: 'med',  note: 'Fast-moving, 3-7 weeks' },
  'palantir':        { weeks: 9,  tier: 'med',   confidence: 'high', note: 'EXCLUDED per calibration brief — defense' },
  'anduril':         { weeks: 7,  tier: 'med',   confidence: 'high', note: 'EXCLUDED per calibration brief — defense' },
  'shield-ai':       { weeks: 7,  tier: 'med',   confidence: 'med',  note: 'EXCLUDED per calibration brief — defense' },
};

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'));
    // Schema: { "company-slug": { weeks, tier, confidence, source, expires_at? } }
    return parsed.companies || {};
  } catch (e) {
    console.warn(`[tto-estimator] Failed to parse ${OVERRIDES_PATH}: ${e.message}`);
    return {};
  }
}

/**
 * estimateTTO(company, opts?) → { weeks_estimate, velocity_tier, basis, confidence, source }
 *
 * @param {string} company - company name (will be slugified for lookup)
 * @param {object} opts
 * @param {string} opts.stage - funding stage if known (overrides company lookup miss)
 * @param {boolean} opts.skipOverrides - bypass data/tto-overrides.json (testing)
 */
export function estimateTTO(company, opts = {}) {
  const slug = slugify(company);

  // 1. User-curated overrides win
  if (!opts.skipOverrides) {
    const overrides = loadOverrides();
    const o = overrides[slug];
    if (o && o.weeks) {
      // Honor expiry if set
      if (!o.expires_at || Date.now() < Date.parse(o.expires_at)) {
        return {
          weeks_estimate: o.weeks,
          velocity_tier:  o.tier || tierFromWeeks(o.weeks),
          basis:          'override',
          confidence:     o.confidence || 'high',
          source:         o.source || `data/tto-overrides.json @ ${slug}`,
          note:           o.note,
        };
      }
    }
  }

  // 2. Company-specific known patterns
  if (COMPANY_SPECIFIC[slug]) {
    const c = COMPANY_SPECIFIC[slug];
    return {
      weeks_estimate: c.weeks,
      velocity_tier:  c.tier,
      basis:          'company_specific',
      confidence:     c.confidence,
      source:         `lib/tto-estimator.mjs COMPANY_SPECIFIC[${slug}]`,
      note:           c.note,
    };
  }

  // 3. Stage default
  if (opts.stage) {
    const stageKey = String(opts.stage).toLowerCase().replace(/_/g, '-');
    if (STAGE_DEFAULTS[stageKey]) {
      const s = STAGE_DEFAULTS[stageKey];
      return {
        weeks_estimate: s.weeks,
        velocity_tier:  s.tier,
        basis:          'stage_default',
        confidence:     s.confidence,
        source:         `lib/tto-estimator.mjs STAGE_DEFAULTS[${stageKey}]`,
      };
    }
  }

  // 4. Unknown fallback
  const u = STAGE_DEFAULTS['unknown'];
  return {
    weeks_estimate: u.weeks,
    velocity_tier:  u.tier,
    basis:          'unknown',
    confidence:     'low',
    source:         'fallback default — no signal',
  };
}

function tierFromWeeks(w) {
  if (w <= 5) return 'fast';
  if (w <= 9) return 'med';
  if (w <= 13) return 'slow';
  return 'glacial';
}

// `scoreTTOBonus(weeks, runwayWeeks)` was retired 2026-05-25 — the
// runway-scarcity scoring it implemented was removed when the runway-
// critical model was retired system-wide. The value-neutral
// `estimateTTO` above is the remaining surface. No external callers
// referenced `scoreTTOBonus` at retirement time.

// CLI: node lib/tto-estimator.mjs <company> [--stage=series-b]
if (import.meta.url === `file://${process.argv[1]}`) {
  const company = process.argv[2];
  const stageArg = process.argv.find(a => a.startsWith('--stage='));
  const stage = stageArg ? stageArg.split('=')[1] : undefined;
  if (!company) {
    console.error('Usage: node lib/tto-estimator.mjs <company> [--stage=series-b]');
    process.exit(1);
  }
  const est = estimateTTO(company, { stage });
  console.log(JSON.stringify(est, null, 2));
}
