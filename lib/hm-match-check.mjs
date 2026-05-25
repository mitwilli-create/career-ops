// HM-match sub-check for the pre-apply-check orchestrator.
//
// Loads hiring-manager intel from data/hm-intel/<slug>.json, builds a cached
// persona+rubric prefix (Anthropic ephemeral cache — 90% discount on hot
// calls), then asks the configured model (default Sonnet 4.6) to score the
// applicant's artifacts against the HM persona signals.
//
// Per dealbreaker-final-pre-apply-2026-05-24.md:
//   - Sonnet 4.6 NOT Haiku — Mitchell empirically rejected Haiku as
//     polish-loop adjudicator; persona-conditioned multi-criteria evaluation
//     is the regime Haiku struggles with.
//   - Cached persona+rubric prefix — Anthropic 90% discount on hot cache hits
//     keeps per-call cost at $0.003-0.006 (verified pricing per the dealbreaker
//     web-grounding).
//   - HM-match is REQUIRED for orchestrator's 'ready' status. Returning
//     'unavailable' or 'error' caps overall_status at 'incomplete', per the
//     orchestrator's hard rule (GPT-5's load-bearing critique).
//
// Cost-relief escape hatch: PRE_APPLY_HM_MODEL env var routes to a different
// vendor without a code change. Locked decision Q2 (Mitchell 2026-05-24).
//   default: anthropic:claude-sonnet-4-6
//   also supported: google:gemini-3.1-pro-preview, openai:gpt-5
//   unknown values fall back to the default + console.warn.
//
// Return shape (matches orchestrator's _settledToCheck contract):
//   { status: 'pass' | 'caveats' | 'fail' | 'unavailable' | 'error',
//     score: number (0.0-1.0),
//     signals: string[],     // HM signals matched by the artifacts
//     gaps: string[],        // HM signals NOT matched — orchestrator surfaces in suggestions[]
//     ...optional: model_used, persona_signals_count, rationale, error }

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { callCouncil as _callCouncil } from './council.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));

const DEFAULT_MODEL = 'anthropic:claude-sonnet-4-6';
const SUPPORTED_MODELS = Object.freeze([
  'anthropic:claude-sonnet-4-6',
  'google:gemini-3.1-pro-preview',
  'openai:gpt-5',
]);

const PASS_THRESHOLD = 0.80;
const CAVEATS_THRESHOLD = 0.50;
const TIMEOUT_MS = 180_000;
const MAX_JD_EXCERPT_CHARS = 6000;
const MAX_ARTIFACT_CHARS = 18_000; // ~combined cv + cover_letter envelope

/**
 * Resolve the model to dispatch from PRE_APPLY_HM_MODEL env var with
 * fallback-to-default behavior on unknown values.
 *
 * @returns {string} model identifier from SUPPORTED_MODELS
 */
export function resolveModel() {
  const raw = process.env.PRE_APPLY_HM_MODEL;
  if (!raw) return DEFAULT_MODEL;
  const trimmed = String(raw).trim();
  if (SUPPORTED_MODELS.includes(trimmed)) return trimmed;
  // Unknown value — warn but don't throw. The orchestrator must never
  // hard-fail because someone set the env var to a typo.
  try {
    console.warn(
      `[hm-match-check] PRE_APPLY_HM_MODEL=${JSON.stringify(trimmed)} is not in the supported set ` +
      `(${SUPPORTED_MODELS.join(', ')}). Falling back to ${DEFAULT_MODEL}.`,
    );
  } catch (_) { /* never block on stderr */ }
  return DEFAULT_MODEL;
}

/**
 * Stable scoring rubric — kept inside the cached prefix block so it
 * benefits from the 90% cache discount on hot calls. Pure string constant;
 * changing this invalidates the cache (acceptable since it's load-bearing).
 *
 * The persona signals are drawn from the hm-intel file's content
 * (role_summary, alignment_with_goals, fit_evidence, outreach_strategy,
 * and the new signals[] field after migration). The model is asked to
 * score artifact alignment to those signals.
 */
const SCORING_RUBRIC = `
# HM-match scoring rubric

You are evaluating whether an applicant's CV + cover letter would resonate
with the hiring manager (HM) for a specific role, given a structured
persona profile.

## Scoring axis (0.0–1.0)

For each HM persona signal, decide: does the applicant's artifacts EXPLICITLY
demonstrate this signal (matched), or is the signal absent / weak / under-
weighted (gap)?

- **score >= 0.80** — Strong alignment. >= 80% of persona signals matched by
  explicit evidence in artifacts. No critical signal absent. Status: pass.
- **score 0.50–0.79** — Mixed alignment. 50–79% signals matched. Some
  significant signals absent or buried. Status: caveats.
- **score < 0.50** — Weak alignment. < 50% signals matched. Major persona
  signals absent. Status: fail.

## Output format — STRICT JSON

Return ONLY a JSON object matching this exact shape (no markdown, no
prose, no preamble — JSON only):

{
  "score": <number 0.0–1.0>,
  "signals": ["<signal text 1>", "<signal text 2>", ...],
  "gaps": ["<missing signal 1>", "<missing signal 2>", ...],
  "rationale": "<one paragraph, <= 240 chars, why this score>"
}

## Constraints

- "signals" lists the persona signals demonstrated by the artifacts.
  Use the EXACT signal text from the persona profile (don't paraphrase).
- "gaps" lists the persona signals NOT demonstrated. Same exact-text rule.
- Together signals.length + gaps.length must equal the number of persona
  signals in the persona profile. No skipping.
- "rationale" is one paragraph (<= 240 chars), capability-focused — never
  identifies the HM by name even if their name is in the persona profile.
- "score" is a decimal between 0.0 and 1.0 inclusive.
- DO NOT include personal identifying information about the HM or applicant
  in the rationale. Focus on capabilities, evidence patterns, gaps.

## Persona profile (cached prefix)

(persona payload follows below; the dynamic per-call section is appended
after the cache block)
`.trim();

/**
 * Build the stable persona-block payload from hm-intel content.
 * This is the ONE long block sent through cacheStableContent — it goes
 * through Anthropic's cache_control: ephemeral mechanism on the
 * anthropic:* adapter, and is prepended for other providers.
 *
 * @param {object} hmIntel — parsed hm-intel JSON
 * @param {string} slug
 * @returns {string} persona block (stable across calls for the same slug)
 */
export function buildPersonaBlock(hmIntel, slug) {
  if (!hmIntel || typeof hmIntel !== 'object') {
    throw new Error('buildPersonaBlock: hmIntel object required');
  }

  const signals = Array.isArray(hmIntel.signals) ? hmIntel.signals : null;
  const signalsBlock = signals && signals.length
    ? signals.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    : '(no migrated signals[] field — derive signals from role_summary + alignment_with_goals + fit_evidence)';

  const lines = [
    SCORING_RUBRIC,
    '',
    '---',
    `# Persona profile — ${hmIntel.company || '(unknown company)'} / ${hmIntel.role || '(unknown role)'}`,
    `slug: ${slug}`,
    '',
    '## HM persona signals (load-bearing — score against these)',
    signalsBlock,
    '',
    '## Role context',
    String(hmIntel.role_summary || '(no role_summary)'),
    '',
    '## Alignment narrative',
    String(hmIntel.alignment_with_goals || '(no alignment_with_goals)'),
    '',
    '## Fit evidence (what HM looks for)',
    _formatFitEvidence(hmIntel.fit_evidence),
    '',
    '## Outreach strategy hints',
    _formatOutreach(hmIntel.outreach_strategy),
  ];
  return lines.join('\n');
}

function _formatFitEvidence(fit) {
  if (!fit || typeof fit !== 'object') return '(no fit_evidence)';
  const out = [];
  for (const [k, v] of Object.entries(fit)) {
    if (typeof v === 'string' && v.trim()) {
      out.push(`- **${k}**: ${v}`);
    }
  }
  return out.length ? out.join('\n') : '(empty fit_evidence)';
}

function _formatOutreach(o) {
  if (!o || typeof o !== 'object') return '(no outreach_strategy)';
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v.trim()) {
      out.push(`- **${k}**: ${v}`);
    }
  }
  return out.length ? out.join('\n') : '(empty outreach_strategy)';
}

/**
 * Build the dynamic per-call section. NOT cached — varies per applicant + JD.
 *
 * @param {object} input
 * @param {string} input.jdText
 * @param {object} input.artifacts — {cv?, cover_letter?, ...}
 * @returns {string}
 */
function _buildDynamicSection({ jdText, artifacts }) {
  const cv = String(artifacts?.cv || '').trim();
  const cover = String(artifacts?.cover_letter || '').trim();
  const jd = String(jdText || '').trim().slice(0, MAX_JD_EXCERPT_CHARS);

  // Combined artifact envelope, truncated to MAX_ARTIFACT_CHARS to keep
  // the call within budget (cv is usually 5-10K, cover 1-3K).
  let combined = '';
  if (cover) combined += `### COVER LETTER\n\n${cover}\n\n`;
  if (cv) combined += `### CV / RESUME\n\n${cv}\n\n`;
  if (combined.length > MAX_ARTIFACT_CHARS) {
    combined = combined.slice(0, MAX_ARTIFACT_CHARS) + '\n\n[...artifact truncated to fit envelope...]';
  }

  return [
    '# Dynamic per-call section',
    '',
    '## Job description excerpt',
    jd || '(no JD text provided)',
    '',
    '## Applicant artifacts',
    combined || '(no artifacts provided)',
    '',
    '---',
    'Now score the artifacts against the HM persona signals. Return ONLY the JSON object specified in the rubric.',
  ].join('\n');
}

/**
 * Default hm-intel loader. Reads data/hm-intel/<slug>.json. Returns null
 * when the file is missing (the caller maps null → status:'unavailable').
 *
 * @param {string} slug
 * @returns {object | null}
 */
export function loadHmIntel(slug) {
  if (!slug || typeof slug !== 'string') return null;
  // Strip any leading numeric prefix some apply-pack slugs carry
  // (e.g. "048-anthropic-aaa-industries"); hm-intel files are named
  // by company-role only.
  const candidates = [slug, slug.replace(/^\d+[-_]/, '')];
  for (const candidate of candidates) {
    const p = join(ROOT, 'data', 'hm-intel', `${candidate}.json`);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch (err) {
        throw new Error(`hm-intel JSON parse failed for ${candidate}: ${err.message}`);
      }
    }
  }
  return null;
}

/**
 * Parse model output → typed result. Tolerates ``` fences. On any parse
 * failure throws a tagged error the caller maps to status:'error'.
 *
 * @param {string} raw
 * @returns {{score:number, signals:string[], gaps:string[], rationale?:string}}
 */
export function parseHmMatchResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('empty response from model');
  }
  // Tolerate ```json ... ``` fences and stray prose around the JSON object.
  let cleaned = raw.trim();
  // Strip code fences first
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find the JSON object — first '{' through matching '}'.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('no JSON object found in response');
  }
  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parsed response is not an object');
  }
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`invalid score (must be 0.0–1.0): ${JSON.stringify(parsed.score)}`);
  }
  const signals = Array.isArray(parsed.signals)
    ? parsed.signals.map(s => String(s)).filter(Boolean)
    : [];
  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.map(s => String(s)).filter(Boolean)
    : [];
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 480) : undefined;
  return { score, signals, gaps, rationale };
}

function _statusFromScore(score) {
  if (score >= PASS_THRESHOLD) return 'pass';
  if (score >= CAVEATS_THRESHOLD) return 'caveats';
  return 'fail';
}

/**
 * Main entry — HM-match sub-check.
 *
 * @param {object} input
 * @param {string} input.slug
 * @param {string} [input.jdText]
 * @param {object} [input.artifacts] — {cv, cover_letter, ...}
 * @param {object} [input.opts]
 * @param {object} [input.opts.hmIntel] — pre-loaded intel (skips disk read)
 * @param {string} [input.opts.modelOverride] — bypasses env var for tests
 * @param {function} [input.opts.callCouncil] — inject for tests
 * @param {function} [input.opts.loadHmIntel] — inject for tests
 * @returns {Promise<{status,score,signals,gaps,model_used?,error?,rationale?,persona_signals_count?}>}
 */
export async function hmMatchCheck({ slug, jdText = '', artifacts = {}, opts = {} } = {}) {
  if (!slug || typeof slug !== 'string') {
    return { status: 'error', error: 'slug (string) is required', score: 0, signals: [], gaps: [] };
  }

  // 1. Load HM intel — either from opts (test/cache path) or disk.
  let hmIntel;
  try {
    if (opts.hmIntel && typeof opts.hmIntel === 'object') {
      hmIntel = opts.hmIntel;
    } else {
      const loader = opts.loadHmIntel || loadHmIntel;
      hmIntel = loader(slug);
    }
  } catch (err) {
    return {
      status: 'error',
      error: `hm-intel load failed: ${err.message}`,
      score: 0,
      signals: [],
      gaps: [],
    };
  }
  if (!hmIntel) {
    return {
      status: 'unavailable',
      error: `no hm-intel for ${slug} — run hiring-manager-research first`,
      score: 0,
      signals: [],
      gaps: [],
    };
  }

  // 2. Build the cached persona block + dynamic section.
  let personaBlock;
  try {
    personaBlock = buildPersonaBlock(hmIntel, slug);
  } catch (err) {
    return {
      status: 'error',
      error: `persona block build failed: ${err.message}`,
      score: 0,
      signals: [],
      gaps: [],
    };
  }
  const dynamicSection = _buildDynamicSection({ jdText, artifacts });

  // 3. Resolve model + dispatch.
  const model = opts.modelOverride || resolveModel();
  const callFn = opts.callCouncil || _callCouncil;

  let response;
  try {
    response = await callFn({
      prompt: dynamicSection,
      models: [model],
      opts: {
        timeoutMs: TIMEOUT_MS,
        cacheStableContent: [personaBlock],
        cacheCaller: 'hm-match',
        // Surface system context separately so adapters that support a
        // distinct system field (Anthropic, OpenAI) use it; Gemini will
        // see the persona block prepended.
        systemPrompt: 'You are an expert hiring-manager-persona evaluator. Output STRICT JSON matching the rubric exactly. Never narrate; never apologize; never refuse.',
      },
    });
  } catch (err) {
    return {
      status: 'error',
      error: `model call threw: ${err.message || String(err)}`,
      score: 0,
      signals: [],
      gaps: [],
      model_used: model,
    };
  }

  if (!response || !Array.isArray(response.results) || response.results.length === 0) {
    return {
      status: 'error',
      error: 'model call returned no results',
      score: 0,
      signals: [],
      gaps: [],
      model_used: model,
    };
  }
  const result = response.results[0];
  if (result.error || !result.content) {
    return {
      status: 'error',
      error: `model error: ${result.error || 'empty content'}`,
      score: 0,
      signals: [],
      gaps: [],
      model_used: model,
    };
  }

  // 4. Parse the JSON output.
  let parsed;
  try {
    parsed = parseHmMatchResponse(result.content);
  } catch (err) {
    return {
      status: 'error',
      error: `parse error: ${err.message}`,
      score: 0,
      signals: [],
      gaps: [],
      model_used: model,
    };
  }

  // 5. Map score → status.
  const status = _statusFromScore(parsed.score);
  const personaSignalsCount = Array.isArray(hmIntel.signals) ? hmIntel.signals.length : null;

  return {
    status,
    score: Math.round(parsed.score * 100) / 100,
    signals: parsed.signals,
    gaps: parsed.gaps,
    rationale: parsed.rationale,
    model_used: model,
    persona_signals_count: personaSignalsCount,
  };
}

// Exposed for tests + the migration script.
export const _internal = {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  PASS_THRESHOLD,
  CAVEATS_THRESHOLD,
  TIMEOUT_MS,
  SCORING_RUBRIC,
  _statusFromScore,
  _buildDynamicSection,
};
