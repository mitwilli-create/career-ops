// lib/triage-hard-disqualifier-filter.mjs
//
// Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 1
//
// Deterministic post-triage filter. Runs AFTER Haiku/Flash returns its score,
// BEFORE the URL is appended to triage-advance.tsv.
//
// Why it exists: triage prompt declares hard-SKIP rules (Python production
// engineering as primary screen, mandatory leetcode, former PM required,
// etc.) but Haiku-as-judge is generous and rarely fires them. The score
// distribution (zero values below 4.0 across 21 ranked rows on 2026-05-29)
// confirms soft enforcement. This filter applies the same rules as
// deterministic regex, overriding Haiku's verdict when a hard rule trips.
//
// AGENTS.md bug class: llm-judge-soft-enforcement-of-hard-rules.
//
// Kill switch: DISABLE_HARD_DISQUALIFIER_FILTER=true → returns ADVANCE
//              passthrough for every input, surfacing { disabled: true }.
// Override file: data/triage-overrides.json — entries with
//   { rowNum, gate: 'hard-disqualifier', status:'active' } bypass the filter
//   for that row only, surfacing { overridden: true }.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERRIDES_PATH = join(ROOT, 'data', 'triage-overrides.json');

// ─────────────────────────────────────────────────────────────────────────────
// Hard-disqualifier rules.
//
// Each rule: { name, pattern, archetype_exempt }.
// archetype_exempt: array of archetypes for which the rule does NOT fire.
//   (e.g., Python-prod-engineering is exempt for A2a — SA/FDE Technical —
//   because that archetype expects Python as a primary screen.)
//
// Patterns are regex tested against the full JD text. CASE-INSENSITIVE.
// Patterns are anchored on phrasing that signals MANDATORY / HARD requirement
// — not nice-to-have / preferred. False-positive risk is the primary tuning
// concern; the backfill audit + override mechanism are the safety nets.
// ─────────────────────────────────────────────────────────────────────────────

const HARD_DISQUALIFIERS = [
  {
    name: 'mandatory-leetcode-or-systems-design',
    pattern: /\b(leetcode|coding interview|systems design (interview|round)|technical (interview|screen).{0,40}coding|live coding)\b/i,
    archetype_exempt: [],
  },
  {
    name: 'mandatory-python-production-engineering',
    pattern: /(production (python|java|c\+\+) (engineer|develop|service|system)|deep (python|java|c\+\+) experience|(5|6|7|8|9|10)\+\s*years?\s*(of\s+)?(python|java|c\+\+))/i,
    archetype_exempt: ['A2a'],
  },
  {
    name: 'mandatory-former-pm-experience',
    pattern: /((5|6|7|8|9|10)\+\s*years?\s*(of\s+)?(product management|as a (product manager|pm))|former (product manager|pm)\s*(required|preferred|essential))/i,
    archetype_exempt: [],
  },
  {
    name: 'mandatory-former-em',
    pattern: /((5|6|7|8|9|10)\+\s*years?\s*(of\s+)?(engineering management|managing engineers)|former engineering manager required)/i,
    archetype_exempt: [],
  },
  {
    name: 'leadership-experience-required-heavy',
    pattern: /((10|12|15)\+\s*years?\s*(of\s+)?(leadership|management)|senior leadership track record)/i,
    archetype_exempt: [],
  },
  {
    name: 'pure-cloud-devops-mlops-primary',
    pattern: /\b(kubernetes admin|terraform expert|aws cloud architect|gcp infrastructure|mlops engineer)\b/i,
    archetype_exempt: [],
  },
];

// Exported for test/audit introspection
export const RULES = HARD_DISQUALIFIERS;

// ─────────────────────────────────────────────────────────────────────────────
// Overrides loader. Read on every call (cheap; <1KB file). Resilient to
// malformed JSON — log + treat as empty.
// ─────────────────────────────────────────────────────────────────────────────

function loadOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return [];
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'));
    const arr = Array.isArray(raw?.overrides) ? raw.overrides : [];
    return arr.filter(o => o && (o.status == null || o.status === 'active'));
  } catch (e) {
    console.error(`[triage-hard-disqualifier-filter] WARN: failed to parse overrides at ${OVERRIDES_PATH}: ${e.message}`);
    return [];
  }
}

function hasOverride({ rowNum, gate, overrides }) {
  if (rowNum == null) return false;
  return overrides.some(o => Number(o.rowNum) === Number(rowNum) && o.gate === gate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply hard-disqualifier rules to a JD.
 *
 * @param {object} input
 * @param {string|null} input.jdText  — full JD text (null/empty → ADVANCE).
 * @param {string} [input.archetype] — Haiku-detected archetype (A1/A2a/A2b/A2c/B/NO).
 *                                     Some rules exempt specific archetypes.
 * @param {number|string} [input.rowNum] — applications.md row number; if present
 *                                          AND an override exists for this row +
 *                                          gate='hard-disqualifier', the filter
 *                                          returns ADVANCE with overridden:true.
 * @returns {object} {
 *   decision: 'SKIP' | 'ADVANCE',
 *   violations: string[],
 *   disabled?: boolean,       // env kill switch was on
 *   overridden?: boolean,     // override list matched
 *   override_reason?: string, // free-form reason from overrides.json
 * }
 */
export function applyHardDisqualifiers({ jdText, archetype, rowNum } = {}) {
  // Env kill switch
  if (process.env.DISABLE_HARD_DISQUALIFIER_FILTER === 'true') {
    return { decision: 'ADVANCE', violations: [], disabled: true };
  }

  const overrides = loadOverrides();
  if (hasOverride({ rowNum, gate: 'hard-disqualifier', overrides })) {
    const matched = overrides.find(o => Number(o.rowNum) === Number(rowNum) && o.gate === 'hard-disqualifier');
    return {
      decision: 'ADVANCE',
      violations: [],
      overridden: true,
      override_reason: matched?.reason || '(no reason recorded)',
    };
  }

  const text = String(jdText || '');
  const violations = [];

  for (const rule of HARD_DISQUALIFIERS) {
    if (archetype && Array.isArray(rule.archetype_exempt) && rule.archetype_exempt.includes(archetype)) {
      continue;
    }
    if (rule.pattern.test(text)) {
      violations.push(rule.name);
    }
  }

  return {
    decision: violations.length > 0 ? 'SKIP' : 'ADVANCE',
    violations,
  };
}

/**
 * Human-readable reason string. Useful for triage-advance.tsv notes column +
 * scan-history.tsv reason field.
 */
export function formatViolationReason(result) {
  if (result?.disabled) return 'hard-disqualifier-filter disabled via env';
  if (result?.overridden) return `hard-disqualifier override (rowNum=${result?.rowNum ?? '?'}): ${result.override_reason || '(no reason)'}`;
  if (!result?.violations || result.violations.length === 0) return '';
  return 'hard-disqualifier: ' + result.violations.join(', ');
}
