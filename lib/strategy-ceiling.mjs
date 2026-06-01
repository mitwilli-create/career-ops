/**
 * lib/strategy-ceiling.mjs — Dynamic per-metric strategy ceiling with 3-5 actions.
 *
 * When a user clicks a score/percentage/gap chip in the dashboard, this module
 * returns the ceiling for that metric + concrete next-actions to close the gap.
 *
 * Exports:
 *   computeStrategyCeiling({ rowId, role, company, metricKey, currentValue, jdText, hmIntel, opts })
 *     → Promise<StrategyCeilingResult>
 *   getCachedStrategy(cacheKey, maxAgeMs) → cached | null
 *   forceRefresh(cacheKey)
 *   renderStrategyCard(result) → HTML string
 *
 * LLM: openai:gpt-5 (gpt-5.5 fallback) via callCouncil, reasoning_effort: medium, max 1500 tokens.
 * Cache: file-backed at data/strategy-cache/{rowId}-{metricKey}.json (24h default).
 * Cost target: $0.04–0.06/generation.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCouncil } from './council.mjs';
import { buildGroundedPrompt, classifyVoicePurity } from './ground-prompt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, 'data', 'strategy-cache');
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// ── Mode discriminator (data-first vs legacy) ────────────────────────────────
//
// 2026-05-25 popout-action-completed-mode refactor. The legacy LLM emission
// shape is `actions[]` (prescriptive — "do X to lift the metric"). The new
// data-first shape is `evidence[] + open_gaps[]` (descriptive — "this data
// reveals X about fit; this data is missing + the system has an agent for it").
//
// POPOUT_DATA_FIRST_MODE env gate:
//   '1' (default) → new evidence[]/open_gaps[] schema
//   '0'           → legacy actions[] schema (instant rollback path)
//
// Cache keys include the mode, so flipping the env reloads-from-LLM but
// doesn't collide previously-cached entries.
export function currentPopoutMode() {
  return process.env.POPOUT_DATA_FIRST_MODE === '0' ? 'legacy' : 'data-first';
}

// ── Zod-style inline schema validators (mode-dispatched) ─────────────────────

/**
 * Validate a parsed legacy strategy response (actions[] shape).
 * Returns { ok: true, data } or { ok: false, error: string }
 */
function validateStrategyResponseLegacy(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Not an object' };
  if (typeof obj.current !== 'number') return { ok: false, error: 'current must be number' };
  if (typeof obj.ceiling !== 'number') return { ok: false, error: 'ceiling must be number' };
  if (typeof obj.gap_pct !== 'number') return { ok: false, error: 'gap_pct must be number' };
  if (!Array.isArray(obj.actions)) return { ok: false, error: 'actions must be array' };
  if (obj.actions.length < 3 || obj.actions.length > 5) {
    return { ok: false, error: `actions must be 3-5 items, got ${obj.actions.length}` };
  }
  for (const [i, a] of obj.actions.entries()) {
    if (typeof a.title !== 'string' || !a.title) return { ok: false, error: `action[${i}].title missing` };
    if (typeof a.what !== 'string' || !a.what) return { ok: false, error: `action[${i}].what missing` };
    if (typeof a.why !== 'string' || !a.why) return { ok: false, error: `action[${i}].why missing` };
    if (!['low', 'medium', 'high'].includes(a.effort)) return { ok: false, error: `action[${i}].effort must be low|medium|high` };
    if (typeof a.expected_lift_pct !== 'number') return { ok: false, error: `action[${i}].expected_lift_pct must be number` };
  }
  return { ok: true, data: obj };
}

/**
 * Validate a parsed data-first strategy response (evidence[] + open_gaps[]).
 * Returns { ok: true, data } or { ok: false, error: string }
 */
function validateStrategyResponseDataFirst(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Not an object' };
  if (typeof obj.current !== 'number') return { ok: false, error: 'current must be number' };
  if (typeof obj.ceiling !== 'number') return { ok: false, error: 'ceiling must be number' };
  if (typeof obj.gap_pct !== 'number') return { ok: false, error: 'gap_pct must be number' };
  if (!Array.isArray(obj.evidence)) return { ok: false, error: 'evidence must be array' };
  if (!Array.isArray(obj.open_gaps)) return { ok: false, error: 'open_gaps must be array' };
  // Total surface ≥ 1: if disk is genuinely empty the LLM should emit gaps,
  // not return nothing. Caller can decide what to render when both are zero.
  if (obj.evidence.length + obj.open_gaps.length < 1) {
    return { ok: false, error: 'evidence[] + open_gaps[] total must be >= 1' };
  }
  for (const [i, e] of obj.evidence.entries()) {
    if (typeof e.what_data !== 'string' || !e.what_data) return { ok: false, error: `evidence[${i}].what_data missing` };
    if (typeof e.what_it_reveals !== 'string' || !e.what_it_reveals) return { ok: false, error: `evidence[${i}].what_it_reveals missing` };
    if (typeof e.source_path !== 'string' || !e.source_path) return { ok: false, error: `evidence[${i}].source_path missing` };
    if (e.confidence && !['high', 'medium', 'low'].includes(e.confidence)) {
      return { ok: false, error: `evidence[${i}].confidence must be high|medium|low when present` };
    }
  }
  for (const [i, g] of obj.open_gaps.entries()) {
    if (typeof g.what_is_missing !== 'string' || !g.what_is_missing) return { ok: false, error: `open_gaps[${i}].what_is_missing missing` };
    if (typeof g.why_it_matters !== 'string' || !g.why_it_matters) return { ok: false, error: `open_gaps[${i}].why_it_matters missing` };
    if (typeof g.suggested_agent !== 'string' || !g.suggested_agent) return { ok: false, error: `open_gaps[${i}].suggested_agent missing` };
    if (g.est_cost_usd != null && typeof g.est_cost_usd !== 'number') {
      return { ok: false, error: `open_gaps[${i}].est_cost_usd must be number when present` };
    }
  }
  return { ok: true, data: obj };
}

/** Mode-dispatched validator. Public for callers that already have parsed JSON. */
function validateStrategyResponse(obj, mode = currentPopoutMode()) {
  if (mode === 'legacy') return validateStrategyResponseLegacy(obj);
  return validateStrategyResponseDataFirst(obj);
}

// ── Corpus hash helper (for cache invalidation) ──────────────────────────────

function _computeCorpusHash() {
  const files = [
    join(ROOT, 'cv.md'),
    join(ROOT, 'article-digest.md'),
  ];
  const h = createHash('sha1');
  for (const f of files) {
    try { h.update(readFileSync(f, 'utf-8')); } catch { /* not found — skip */ }
  }
  return h.digest('hex').slice(0, 12);
}

// ── File-backed cache ─────────────────────────────────────────────────────────

/** Build the cache key from inputs (deterministic). */
export function buildCacheKey({ rowId, metricKey, company, role }) {
  const corpusHash = _computeCorpusHash();
  return `${rowId}-${metricKey}-${(company ?? '').toLowerCase().replace(/\s+/g, '-')}-${(role ?? '').toLowerCase().replace(/\s+/g, '-').slice(0, 30)}-${corpusHash}`;
}

/** Return cached result if present and fresh.
 *
 * γ GAMMA fix 2026-05-19 (adversarial-review #1):
 * Pre-CRIT-3 degraded entries (with fabricated expected_lift_pct numbers and
 * 1-hour TTLs) may still exist on disk from before the fix landed. Refuse to
 * serve any cached entry where `_degraded: true` — force a real LLM call so
 * the next render gets a current strategy or a current "data unavailable".
 */
// Tolerant JSON parse for LLM responses (2026-05-31): councils occasionally emit
// near-strict JSON — trailing commas before } or ], stray ```json fences, or a
// response truncated at maxTokens mid-array (the classic "Expected ',' or ']' after
// array element"). Repair deterministically, THEN JSON.parse. Returns null only when
// no repair yields valid JSON. Schema validation downstream still guards correctness,
// so a bracket-balanced (but field-incomplete) repair is rejected by validateStrategyResponse,
// never silently accepted.
export function tolerantParseLlmJson(s) {
  if (s == null) return null;
  const direct = (() => { try { return JSON.parse(s); } catch { return undefined; } })();
  if (direct !== undefined) return direct;
  // strip code fences + trailing commas before a close bracket/brace
  let t = String(s).replace(/```(?:json)?/gi, '').replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(t); } catch { /* fall through to bracket-balance */ }
  // balance an unterminated string + unclosed { [ (truncation repair)
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let repaired = t;
  if (inStr) repaired += '"';
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === '{' ? '}' : ']';
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(repaired); } catch { return null; }
}

export function getCachedStrategy(cacheKey, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!existsSync(CACHE_DIR)) return null;
  const filePath = join(CACHE_DIR, `${cacheKey}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (raw._degraded === true) return null;
    // 2026-05-31 cache-never-served fix: cache files are written with `as_of`
    // (ISO string) but this freshness check only read `generated_at` — absent on
    // every file, so `?? 0` made every entry look infinitely stale → the endpoint
    // recomputed (~70s council) on EVERY popout open → generic/timeout fallback.
    // Fall back to as_of so fresh caches actually serve.
    const ts = raw.generated_at ?? (raw.as_of ? Date.parse(raw.as_of) : 0);
    const age = Date.now() - (Number.isFinite(ts) ? ts : 0);
    if (age > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Force-invalidate a cache entry so the next call re-generates. */
export function forceRefresh(cacheKey) {
  const filePath = join(CACHE_DIR, `${cacheKey}.json`);
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      raw.generated_at = 0; // expire immediately
      writeFileSync(filePath, JSON.stringify(raw, null, 2));
    } catch { /* ignore */ }
  }
}

function _writeCache(cacheKey, data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const filePath = join(CACHE_DIR, `${cacheKey}.json`);
  writeFileSync(filePath, JSON.stringify({ ...data, generated_at: Date.now() }, null, 2));
}

// ── Response schemas (mode-dispatched) ───────────────────────────────────────

const STRATEGY_CEILING_LEGACY_RESPONSE_SCHEMA = [
  `{`,
  `  "current": <number 0-100, same as input currentValue>,`,
  `  "ceiling": <number 0-100, realistic achievable ceiling given context>,`,
  `  "gap_pct": <number, ceiling minus current>,`,
  `  "actions": [`,
  `    {`,
  `      "title": "<short imperative phrase>",`,
  `      "what": "<1-2 sentence concrete action>",`,
  `      "why": "<1 sentence on why this moves the metric>",`,
  `      "effort": "low" | "medium" | "high",`,
  `      "expected_lift_pct": <number, estimated pct-point improvement>,`,
  `      "corpus_ref": "<cv.md section, article-digest excerpt, or story-bank entry this leverages>",`,
  `      "citation": "<source/data point — required when claim is non-obvious>"`,
  `    }`,
  `  ],`,
  `  "reasoning": "<1-2 sentences explaining ceiling rationale, citing corpus locations>"`,
  `}`,
  ``,
  `Rules: 3-5 actions. expected_lift_pct sum should not exceed gap_pct. Anchor each action in Mitchell's actual corpus — no generic advice.`,
].join('\n');

const STRATEGY_CEILING_DATAFIRST_RESPONSE_SCHEMA = [
  `{`,
  `  "current": <number 0-100, same as input currentValue>,`,
  `  "ceiling": <number 0-100, realistic achievable ceiling given the evidence on disk>,`,
  `  "gap_pct": <number, ceiling minus current>,`,
  `  "evidence": [`,
  `    {`,
  `      "what_data": "<short name of the data point (e.g. 'cv.md frontend-comms section', 'hm-intel: Sarah Chen 2026-04 LinkedIn post', 'reports/048: alignment block')>",`,
  `      "what_it_reveals": "<1-2 sentences synthesizing what THIS DATA reveals about Mitchell's fit at this role — NOT a generic claim>",`,
  `      "source_path": "<concrete path like 'cv.md', 'article-digest.md', 'data/hm-intel/<slug>.json', 'reports/NNN-...md', 'data/team-health/<slug>.json', 'data/apply-packs/<slug>/cv-tailored.md', 'data/apply-packs/<slug>/cover-letter.md', 'data/apply-packs/<slug>/polish-orchestrator-summary.json'>",`,
  `      "source_date": "<YYYY-MM-DD when known; omit when not>",`,
  `      "confidence": "high" | "medium" | "low"`,
  `    }`,
  `    // 0-5 items. Cite what is ACTUALLY on disk. Do NOT cite a file you don't see in the context.`,
  `  ],`,
  `  "open_gaps": [`,
  `    {`,
  `      "what_is_missing": "<short — what data, artifact, or research is absent that would sharpen the read>",`,
  `      "why_it_matters": "<1 sentence — why this gap reduces confidence in the metric>",`,
  `      "suggested_agent": "<specific agent name the system already has: 'build-apply-pack' | 'apply-pack-polish' | 'intel-refresh' | 'team-health-scrapers' | 'interview-likelihood' | 'hm-chance' | 'network-enricher' | 'network-emailer' | 'cv-tailor' | 'cover-letter'>",`,
  `      "est_cost_usd": <number — your best estimate of the cost to fill this gap>`,
  `    }`,
  `    // 0-5 items. If everything needed is already on disk, emit zero gaps.`,
  `  ],`,
  `  "reasoning": "<1-2 sentences — overall synthesis. Lead with what the evidence reveals, not what should be done.>"`,
  `}`,
  ``,
  `Voice + behavior rules:`,
  `- DESCRIPTIVE not prescriptive. Synthesize what THIS DATA reveals about Mitchell's fit. The system already knows what to do — your job is to surface what's on disk + what's honestly missing.`,
  `- Cite specific source paths in every evidence[] item. "cv.md" alone is acceptable; "cv.md: Anthropic Comms section" is better.`,
  `- Do NOT invent files. If you don't see the file in the context provided, don't cite it.`,
  `- evidence[] + open_gaps[] total must be >= 1 (if disk is genuinely empty, emit gaps surfacing 'no X on disk; suggested_agent fills it').`,
  `- For open_gaps[], suggested_agent must be a real script name from the list above. est_cost_usd is your honest estimate.`,
].join('\n');

// Backwards-compat export name (used by callers that import the constant directly).
const STRATEGY_CEILING_RESPONSE_SCHEMA = STRATEGY_CEILING_LEGACY_RESPONSE_SCHEMA;

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * computeStrategyCeiling — compute ceiling + actions for a metric chip.
 *
 * @param {object} params
 *   rowId        {number|string}  — application row ID (for cache key)
 *   role         {string}         — job title
 *   company      {string}         — company name
 *   metricKey    {string}         — e.g. 'interview_likelihood', 'fit_score'
 *   currentValue {number}         — current value 0–100
 *   jdText       {string?}        — raw JD text (will be trimmed to 1500 chars)
 *   hmIntel      {object?}        — hiring-manager intel object
 *   opts         {object}         — { maxAgeMs?, llmClient?, dry? }
 *
 * @returns {Promise<StrategyCeilingResult>}
 */
export async function computeStrategyCeiling({
  rowId,
  role,
  company,
  metricKey,
  currentValue,
  jdText = '',
  hmIntel = {},
  opts = {},
} = {}) {
  const {
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    llmClient = null,
    dry = false,
  } = opts;

  // 2026-05-23 B2 — build the grounded prompt (Q-locked: persistent personality
  // + profile corpus, 3-breakpoint cache, third-person analyst voice).
  // 2026-05-25 popout-action-completed-mode — dual-mode dispatch on
  // POPOUT_DATA_FIRST_MODE env. Default 'data-first' (new evidence[]/open_gaps[]
  // schema); '0' falls back to legacy actions[] schema for instant rollback.
  const mode = currentPopoutMode();
  const responseSchema = mode === 'legacy'
    ? STRATEGY_CEILING_LEGACY_RESPONSE_SCHEMA
    : STRATEGY_CEILING_DATAFIRST_RESPONSE_SCHEMA;
  const taskInstruction = mode === 'legacy'
    ? null  // ground-prompt builds the default instruction for legacy
    : `Synthesize what THIS DATA reveals about Mitchell's fit at ${company || 'this role'} (role: ${role || metricKey}). DO NOT prescribe action items — the system already knows what to do, and a separate orchestration layer queues the next step. Your job is to (1) cite what's already on disk that informs the metric and (2) name what's honestly missing + which agent the system has for filling that gap. Output evidence[] (citations to files on disk) + open_gaps[] (the suggested_agent must be a real script the system runs).`;
  const grounded = buildGroundedPrompt({
    task: metricKey,
    rowId, role, company, jdText, hmIntel,
    metricKey, currentValue,
    responseSchema,
    taskInstruction,
  });
  // Cache key embeds the mode so rollback (env=0) doesn't collide cached
  // entries written under env=1, and vice versa.
  const cacheKey = `${grounded.cacheKey}-${mode}`;

  // Check cache first
  const cached = getCachedStrategy(cacheKey, maxAgeMs);
  if (cached && !dry) return { ...cached, cache_key: cacheKey, _fromCache: true, _mode: cached._mode || mode };

  if (dry) {
    // Dry-run: return a deterministic stub matching the active mode.
    if (mode === 'legacy') {
      return {
        current: currentValue,
        ceiling: Math.min(100, currentValue + 30),
        gap_pct: 30,
        actions: [
          { title: 'Dry-run placeholder', what: 'No LLM call in dry mode.', why: 'Testing.', effort: 'low', expected_lift_pct: 5 },
          { title: 'Review JD', what: 'Read the JD carefully.', why: 'Understand requirements.', effort: 'low', expected_lift_pct: 5 },
          { title: 'Tailor narrative', what: 'Update your narrative.', why: 'Match role framing.', effort: 'medium', expected_lift_pct: 10 },
        ],
        generated_at: Date.now(),
        cache_key: cacheKey,
        _dry: true,
        _mode: 'legacy',
      };
    }
    return {
      current: currentValue,
      ceiling: Math.min(100, currentValue + 30),
      gap_pct: 30,
      evidence: [
        { what_data: 'dry-run placeholder', what_it_reveals: 'No LLM call in dry mode.', source_path: 'tests/fixture', confidence: 'low' },
      ],
      open_gaps: [
        { what_is_missing: 'dry-run gap stub', why_it_matters: 'placeholder; not a real gap.', suggested_agent: 'intel-refresh', est_cost_usd: 0 },
      ],
      reasoning: 'Dry-run stub — no LLM was called.',
      generated_at: Date.now(),
      cache_key: cacheKey,
      _dry: true,
      _mode: 'data-first',
    };
  }

  // LLM call with 1 retry on schema validation failure.
  //
  // Model routing: claude-sonnet-4-6 primary (Anthropic prompt-caching benefit
  // on the 3-breakpoint cacheStableContent array), openai:gpt-5 fallback. The
  // gpt-5 path receives the joined stable content prepended to the prompt at
  // fireOnce() in lib/council.mjs (non-Anthropic adapters get the full context
  // but no cache hit).
  const client = llmClient ?? {
    call: async (p, sys, stable) => {
      const r = await callCouncil({
        prompt: p,
        systemPrompt: sys,
        models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5'],
        opts: {
          timeoutMs: 180000,
          maxTokens: 2400,   // 2026-05-31: was 1500 — too tight for data-first evidence[]+open_gaps[]; truncation mid-array caused "Expected ',' or ']'" parse failures (row #1 alignment)
          cacheStableContent: stable,            // ARRAY: [personality, profile]
          cacheCaller: 'strategy-ceiling:' + metricKey,
        },
      });
      const hit = r.results.find(x => !x.error);
      if (!hit) throw new Error('No successful council response: ' + (r.results[0]?.error ?? 'unknown'));
      return { content: hit.content, usage: hit.usage || {}, model: hit.model || hit.name || '' };
    },
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response;
    try {
      response = await client.call(grounded.prompt, grounded.system, grounded.cacheStableContent);
    } catch (err) {
      throw new Error(`LLM call failed: ${err.message}`);
    }

    // Back-compat: support both new {content, usage} and legacy raw-string client returns.
    const raw = typeof response === 'string' ? response : (response?.content ?? '');
    const usage = (response && typeof response === 'object' && response.usage) || {};
    const modelLabel = (response && typeof response === 'object' && response.model) || '';

    // Extract JSON from response (handles stray prose/fences). Prefer a balanced
    // {...} slice; on truncation (no closing brace) fall back to everything from the
    // first { so tolerantParseLlmJson can bracket-balance it instead of hard-failing.
    const rawStr = String(raw);
    const firstBrace = rawStr.indexOf('{');
    if (firstBrace === -1) {
      lastError = 'LLM returned no JSON object';
      continue;
    }
    const balanced = rawStr.match(/\{[\s\S]*\}/);
    const jsonCandidate = balanced ? balanced[0] : rawStr.slice(firstBrace);

    const parsed = tolerantParseLlmJson(jsonCandidate);
    if (parsed == null) {
      lastError = `JSON parse error: LLM JSON unparseable even after strict-repair (trailing-comma / fence / truncation)`;
      continue;
    }

    // Inject current value if model didn't echo it
    if (parsed.current == null) parsed.current = currentValue;
    // Recompute gap_pct if missing
    if (parsed.gap_pct == null && parsed.ceiling != null) {
      parsed.gap_pct = Math.max(0, parsed.ceiling - parsed.current);
    }

    const validation = validateStrategyResponse(parsed, mode);
    if (!validation.ok) {
      lastError = `Schema validation failed (mode=${mode}): ${validation.error}`;
      continue;
    }

    const result = mode === 'legacy'
      ? {
          current: parsed.current,
          ceiling: parsed.ceiling,
          gap_pct: parsed.gap_pct,
          actions: parsed.actions,
          reasoning: parsed.reasoning ?? null,
          generated_at: Date.now(),
          cache_key: cacheKey,
          _grounded: grounded.metadata.mode !== 'legacy',
          _model: modelLabel || null,
          _mode: 'legacy',
        }
      : {
          current: parsed.current,
          ceiling: parsed.ceiling,
          gap_pct: parsed.gap_pct,
          evidence: parsed.evidence,
          open_gaps: parsed.open_gaps,
          reasoning: parsed.reasoning ?? null,
          generated_at: Date.now(),
          cache_key: cacheKey,
          _grounded: grounded.metadata.mode !== 'legacy',
          _model: modelLabel || null,
          _mode: 'data-first',
        };

    // Q3-locked: Layer 3 LLM voice classifier runs on actual cache WRITES
    // only (cost-optimal). Gate strictly on cache_creation_input_tokens > 0
    // AND cache_read_input_tokens == 0 — that's the "fresh write" signature.
    // Opt-in via env STRATEGY_CEILING_VOICE_CLASSIFIER=1 (default off so the
    // popout never pays the ~$0.005 Haiku call without explicit consent).
    const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
    const cacheRead = Number(usage.cache_read_input_tokens || 0);
    const isFreshCacheWrite = cacheCreation > 0 && cacheRead === 0;
    if (
      isFreshCacheWrite
      && grounded.metadata.mode !== 'legacy'
      && process.env.STRATEGY_CEILING_VOICE_CLASSIFIER === '1'
    ) {
      try {
        const voice = await classifyVoicePurity(JSON.stringify(parsed.actions), callCouncil);
        if (voice && typeof voice.score === 'number') {
          result._voice_score = voice.score;
          result._voice_rationale = voice.rationale;
        }
      } catch { /* best-effort — never block on classifier failure */ }
    }

    _writeCache(cacheKey, result);
    return result;
  }

  // γ GAMMA fix 2026-05-19 (audit CRIT-3) + PR-08 softening 2026-05-25 + data-first mode 2026-05-25:
  // Both LLM attempts failed. No fabricated ceiling or lift numbers shown.
  // legacy mode: surface Retry CTA with per-row+day cap (PR-08); data-first mode: honest open_gap.
  const retryInfo = mode === 'legacy' ? _retryAvailability(metricKey, rowId) : null;
  const degraded = mode === 'legacy'
    ? {
        current: currentValue,
        ceiling: null,
        gap_pct: null,
        actions: [
          {
            title: 'Strategy unavailable — LLM did not respond',
            what: retryInfo.retry_available
              ? `Two attempts failed (${lastError || 'unknown error'}). Click "Retry now" to try again. ${retryInfo.remaining} retry attempts left today.`
              : `Two attempts failed (${lastError || 'unknown error'}). Daily retry cap reached (${retryInfo.cap}/day). Resets at midnight PT.`,
            why: 'No fabricated ceiling or lift numbers shown.',
            effort: 'medium',
            expected_lift_pct: null,
          },
        ],
        reasoning: null,
        generated_at: Date.now(),
        cache_key: cacheKey,
        _degraded: true,
        _last_error: lastError,
        _mode: 'legacy',
        // PR-08: structured retry metadata for renderer + client wiring.
        status: 'degraded',
        reason: 'llm_timeout',
        retry_available: retryInfo.retry_available,
        retry_endpoint: '/api/drawer/auto-enrich',
        retry_slot: 'strategy-ceiling',
        retry_cap: retryInfo.cap,
        retry_used: retryInfo.used,
        retry_remaining: retryInfo.remaining,
        retry_est_cost_usd: 1.0,
      }
    : {
        current: currentValue,
        ceiling: null,
        gap_pct: null,
        evidence: [],
        open_gaps: [
          {
            what_is_missing: 'LLM synthesis for this metric',
            why_it_matters: `Two attempts to compute the ceiling failed (${lastError || 'unknown error'}). Until the LLM responds, the popout can only show "data unavailable" — no fabricated ceiling or lift numbers.`,
            suggested_agent: 'strategy-ceiling',
            est_cost_usd: 0.05,
          },
        ],
        reasoning: null,
        generated_at: Date.now(),
        cache_key: cacheKey,
        _degraded: true,
        _last_error: lastError,
        _mode: 'data-first',
      };
  // Intentionally not calling _writeCache — see comment above.
  return degraded;
}

// ── PR-08 (2026-05-25) — Per-row+day retry cap helper ───────────────────────
//
// Convergence-impossible-runaway prevention (CLAUDE.md bug-class catalog):
// every UI retry costs ~$1 LLM spend. Without a cap, a chronic LLM outage
// could see a Mitchell clicking "Retry now" 50 times in an hour and burning
// $50 with no signal that anything changed. The cap is per-row+per-day so:
//   1. Different rows can retry independently
//   2. The counter resets at midnight PT (consistent with daily spend buckets)
//   3. Counter file lives at data/strategy-ceiling-retry-count/<key>.json
//      (gitignored as data/strategy-ceiling-retry-count/ pattern)
//
// rowId is best-effort — if the caller did not pass one, we key on metricKey
// alone (still bounded). Counter only increments via incrementRetryCount(),
// which is called by the /api/drawer/auto-enrich dispatcher when slot ===
// 'strategy-ceiling' (so the cap is enforced server-side, not at the renderer).

const DEFAULT_RETRY_CAP = 3;

function _retryCountKey(metricKey, rowId) {
  const r = String(rowId || 'unkrow').replace(/[^a-zA-Z0-9_-]/g, '');
  const m = String(metricKey || 'unkmetric').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${r}-${m}`;
}

function _retryCountDir() {
  return joinForRetry('data', 'strategy-ceiling-retry-count');
}

function _retryCountFile(metricKey, rowId, dateStr) {
  return joinForRetry(_retryCountDir(), `${_retryCountKey(metricKey, rowId)}-${dateStr}.json`);
}

function _todayPtDateStr() {
  const pt = new Date(Date.now() - 7 * 60 * 60 * 1000); // PDT
  return pt.toISOString().slice(0, 10);
}

function _retryAvailability(metricKey, rowId) {
  const cap = Number(process.env.STRATEGY_CEILING_RETRY_CAP_PER_DAY) || DEFAULT_RETRY_CAP;
  const dateStr = _todayPtDateStr();
  const fp = _retryCountFile(metricKey, rowId, dateStr);
  let used = 0;
  try {
    if (existsSyncRetry(fp)) {
      const j = JSON.parse(readFileSyncRetry(fp, 'utf-8'));
      used = Number(j.count) || 0;
    }
  } catch { /* missing or malformed — treat as 0 */ }
  const remaining = Math.max(0, cap - used);
  return {
    cap,
    used,
    remaining,
    retry_available: remaining > 0,
  };
}

/**
 * Increment the retry counter for a row+metric. Called by the
 * /api/drawer/auto-enrich endpoint when slot === 'strategy-ceiling' so the
 * cap is enforced server-side. Returns the new {used, remaining, cap}.
 *
 * Exported for use by dashboard-server.mjs.
 *
 * @param {string} metricKey
 * @param {string|number} rowId
 * @returns {{cap:number, used:number, remaining:number, retry_available:boolean}}
 */
export function incrementRetryCount(metricKey, rowId) {
  const dir = _retryCountDir();
  const dateStr = _todayPtDateStr();
  const fp = _retryCountFile(metricKey, rowId, dateStr);
  try { if (!existsSyncRetry(dir)) mkdirSyncRetry(dir, { recursive: true }); } catch {}
  const before = _retryAvailability(metricKey, rowId);
  const after = {
    metricKey,
    rowId: String(rowId || ''),
    date: dateStr,
    count: before.used + 1,
    last_increment: new Date().toISOString(),
  };
  try { writeFileSyncRetry(fp, JSON.stringify(after, null, 2)); } catch {}
  return _retryAvailability(metricKey, rowId);
}

// ──────────────────────────────────────────────────────────────────────────────
// Lazy-loaded fs primitives — keep this module ESM-clean even though the
// retry-counter is the only fs caller. We use module-scoped names so the
// rest of the file (which is also expected to be fs-clean) isn't affected.
// ──────────────────────────────────────────────────────────────────────────────
import { existsSync as existsSyncRetry, readFileSync as readFileSyncRetry, writeFileSync as writeFileSyncRetry, mkdirSync as mkdirSyncRetry } from 'node:fs';
import { join as joinForRetry } from 'node:path';

// ── Renderer ─────────────────────────────────────────────────────────────────

/**
 * renderStrategyCard(result) → HTML string for dashboard drawer popout.
 *
 * Mode-dispatched: when result._mode === 'data-first', renders evidence[] +
 * open_gaps[] blocks. Otherwise renders the legacy actions[] list. Backwards
 * compat: results without _mode field default to legacy (matches v0 shape).
 *
 * @param {StrategyCeilingResult} result
 * @returns {string} HTML
 */
export function renderStrategyCard(result) {
  const mode = result._mode || (Array.isArray(result.evidence) || Array.isArray(result.open_gaps) ? 'data-first' : 'legacy');
  if (mode === 'data-first') return renderStrategyCardDataFirst(result);
  return renderStrategyCardLegacy(result);
}

/**
 * Legacy renderer (actions[] shape). Preserved for env=0 instant rollback.
 */
function renderStrategyCardLegacy(result) {
  const { current, ceiling, gap_pct, actions = [], reasoning, _fromCache, _degraded, generated_at } = result;

  const gapBar = Math.min(100, Math.max(0, gap_pct ?? 0));
  const ceilPct = Math.min(100, Math.max(0, ceiling ?? current));
  const currPct = Math.min(100, Math.max(0, current ?? 0));

  const effortBadge = (effort) => {
    const map = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444' };
    return `<span style="display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;background:${map[effort] ?? '#6b7280'};color:#fff;">${effort}</span>`;
  };

  // γ GAMMA fix 2026-05-19 (audit CRIT-3): suppress the +X% lift badge when
  // expected_lift_pct is null (the degraded-fallback case). Previously the
  // fallback shipped 3 generic actions with FABRICATED 10/8/15 lift numbers
  // that looked indistinguishable from real LLM lift estimates.
  const liftBadge = (a) => {
    if (a.expected_lift_pct == null) {
      return `<span style="margin-left:auto;font-size:11px;color:#9ca3af;" title="lift estimate unavailable — LLM did not respond">—</span>`;
    }
    return `<span style="margin-left:auto;font-size:11px;color:#6b7280;">+${a.expected_lift_pct}%</span>`;
  };

  const actionItems = actions.map((a, i) => `
  <li style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border,#232737);">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <span style="font-size:12px;font-weight:600;color:var(--text-2,#e4e4e7);">${i + 1}. ${a.title}</span>
      ${effortBadge(a.effort)}
      ${liftBadge(a)}
    </div>
    <p style="margin:0 0 3px;font-size:12px;color:var(--text-2,#e4e4e7);">${a.what}</p>
    <p style="margin:0;font-size:11px;color:var(--text-3,#b8b8c0);font-style:italic;">${a.why}</p>
    ${a.corpus_ref ? `<p style="margin:3px 0 0;font-size:10px;color:var(--text-4,#9a9aa6);">Ref: ${a.corpus_ref}</p>` : ''}
  </li>`).join('');

  // γ GAMMA provenance chip — surface the actual cache age + degraded state.
  const ageLabel = generated_at
    ? (() => {
        const ageMs = Date.now() - generated_at;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMin < 60) return `${ageMin}m ago`;
        const ageHr = Math.round(ageMs / 3600000);
        if (ageHr < 48) return `${ageHr}h ago`;
        return `${Math.round(ageMs / 86400000)}d ago`;
      })()
    : 'unknown';

  // Suppress the progress-bar visualization entirely when ceiling is null
  // (degraded path). No fabricated "current + 20" pseudo-ceiling.
  const showProgressBar = ceiling != null && current != null;

  // PR-08 (2026-05-25) — inline retry button when degraded + retry available.
  // Uses PR-03's window._drawerAutoEnrichDispatch (rowId, slot, slug, confirmedAt).
  // confirmedAt=ISO-string forces auto-enrich past the cost-confirmation gate
  // (this is an explicit user action — they clicked the button).
  const retryButton = _degraded && result.retry_available
    ? `<button type="button" class="strategy-retry-btn" data-auto-enrich="strategy-ceiling" data-row-id="${result.rowId != null ? String(result.rowId).replace(/[^0-9]/g, '') : ''}" data-metric-key="${(result.cache_key || '').replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 80)}" style="display:inline-block;margin-left:8px;padding:3px 10px;font-size:11px;font-weight:600;background:#0a84ff;color:white;border:none;border-radius:4px;cursor:pointer;vertical-align:middle">Retry now (~$${(result.retry_est_cost_usd || 1).toFixed(0)})</button>`
    : '';

  const retryExhaustedNote = _degraded && !result.retry_available
    ? `<div style="font-size:10.5px;color:#9ca3af;margin-top:4px;">Daily retry cap reached (${result.retry_cap}/day). Counter resets at midnight PT.</div>`
    : '';

  return `
<div class="strategy-card" style="font-family:system-ui;max-width:420px;padding:14px 16px;border-radius:8px;border:1px solid var(--border,#232737);background:var(--surface,#11131c);box-shadow:0 2px 8px rgba(0,0,0,.25);">
  ${_degraded ? `<div style="font-size:11px;color:#fbbf24;margin-bottom:8px;background:rgba(245,158,11,0.15);padding:6px 8px;border-radius:4px;border:1px solid rgba(245,158,11,0.3);">⚠ Strategy ceiling unavailable — LLM did not respond. No fabricated numbers shown.${retryButton}${retryExhaustedNote}</div>` : ''}
  ${_fromCache ? `<div style="font-size:10px;color:var(--text-4,#9a9aa6);margin-bottom:6px;">Cached result · computed ${ageLabel}</div>` : ''}

  ${showProgressBar ? `
  <!-- Progress bar -->
  <div style="margin-bottom:12px;">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3,#b8b8c0);margin-bottom:4px;">
      <span>Current: <strong style="color:var(--text-2,#e4e4e7);">${currPct}%</strong></span>
      <span>Ceiling: <strong style="color:var(--text-2,#e4e4e7);">${ceilPct}%</strong></span>
    </div>
    <div style="background:var(--surface-2,#181b27);border-radius:4px;height:8px;overflow:hidden;position:relative;">
      <div style="background:#3b82f6;height:100%;width:${currPct}%;border-radius:4px;"></div>
      <div style="background:#22c55e;height:100%;width:${gapBar}%;margin-left:${currPct}%;border-radius:4px;position:absolute;top:0;left:${currPct}%;opacity:0.5;"></div>
    </div>
    ${reasoning ? `<p style="margin:6px 0 0;font-size:11px;color:var(--text-3,#b8b8c0);font-style:italic;">${reasoning}</p>` : ''}
  </div>
  ` : ''}

  <!-- Actions -->
  <ul style="list-style:none;padding:0;margin:0;">
    ${actionItems}
  </ul>
</div>`.trim();
}

// ── Data-first renderer (evidence[] + open_gaps[]) ───────────────────────────
//
// Action-completed mode: lead with what the system already KNOWS about Mitchell
// (evidence[] cited to source files on disk), then honest gaps (open_gaps[]
// with a one-click button to queue the suggested_agent that fills the gap).
//
// Escape rules for inline HTML (no rich library available — server emits raw HTML):
//   _esc → escape < > & " for safe rendering of LLM strings
//
function _escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStrategyCardDataFirst(result) {
  const { current, ceiling, gap_pct, evidence = [], open_gaps = [], reasoning, _fromCache, _degraded, generated_at } = result;

  const gapBar = Math.min(100, Math.max(0, gap_pct ?? 0));
  const ceilPct = Math.min(100, Math.max(0, ceiling ?? current));
  const currPct = Math.min(100, Math.max(0, current ?? 0));
  const showProgressBar = ceiling != null && current != null;

  const ageLabel = generated_at
    ? (() => {
        const ageMs = Date.now() - generated_at;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMin < 60) return `${ageMin}m ago`;
        const ageHr = Math.round(ageMs / 3600000);
        if (ageHr < 48) return `${ageHr}h ago`;
        return `${Math.round(ageMs / 86400000)}d ago`;
      })()
    : 'unknown';

  const confBadge = (conf) => {
    if (!conf) return '';
    const map = { high: '#16a34a', medium: '#f59e0b', low: '#ef4444' };
    return `<span style="display:inline-block;padding:1px 6px;margin-left:6px;border-radius:10px;font-size:10px;font-weight:600;background:${map[conf] ?? '#6b7280'};color:#fff;">${_escHtml(conf)}</span>`;
  };

  const evidenceItems = (evidence || []).map((e) => `
  <li style="margin-bottom:10px;padding:8px 10px;background:rgba(22,163,74,0.1);border-left:3px solid #16a34a;border-radius:4px;">
    <div style="font-size:12px;font-weight:600;color:var(--text-2,#e4e4e7);margin-bottom:2px;">
      ${_escHtml(e.what_data)}${confBadge(e.confidence)}
    </div>
    <p style="margin:0 0 4px;font-size:12px;color:var(--text-2,#e4e4e7);line-height:1.45;">${_escHtml(e.what_it_reveals)}</p>
    <div style="font-size:10px;color:var(--text-4,#9a9aa6);">
      <span style="font-family:ui-monospace,monospace;">${_escHtml(e.source_path)}</span>${e.source_date ? ` · ${_escHtml(e.source_date)}` : ''}
    </div>
  </li>`).join('');

  const gapItems = (open_gaps || []).map((g) => {
    const agent = _escHtml(g.suggested_agent || '');
    const cost = (typeof g.est_cost_usd === 'number') ? `~$${g.est_cost_usd.toFixed(2)}` : '';
    return `
  <li style="margin-bottom:10px;padding:8px 10px;background:rgba(245,158,11,0.12);border-left:3px solid #d97706;border-radius:4px;">
    <div style="font-size:12px;font-weight:600;color:var(--text-2,#e4e4e7);margin-bottom:2px;">
      ${_escHtml(g.what_is_missing)}
    </div>
    <p style="margin:0 0 6px;font-size:12px;color:var(--text-2,#e4e4e7);line-height:1.45;">${_escHtml(g.why_it_matters)}</p>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <button type="button" data-strategy-fill-gap-agent="${agent}" style="padding:4px 10px;font-size:11px;background:#d97706;border:1px solid #b45309;color:#fff;border-radius:4px;cursor:pointer;font-weight:600;">Queue ${agent}</button>
      ${cost ? `<span style="font-size:10px;color:var(--text-4,#9a9aa6);">est ${cost}</span>` : ''}
    </div>
  </li>`;
  }).join('');

  const noContentBlock = (evidence.length === 0 && open_gaps.length === 0)
    ? `<p style="margin:8px 0;padding:8px 10px;background:rgba(239,68,68,0.12);border-left:3px solid #ef4444;border-radius:4px;font-size:12px;color:#f87171;">No evidence cited and no gaps flagged. This is likely a degraded LLM response — re-run the popout to retry.</p>`
    : '';

  return `
<div class="strategy-card strategy-card--data-first" data-popout-mode="data-first" style="font-family:system-ui;max-width:480px;padding:14px 16px;border-radius:8px;border:1px solid var(--border,#232737);background:var(--surface,#11131c);box-shadow:0 2px 8px rgba(0,0,0,.25);">
  ${_degraded ? `<div style="font-size:11px;color:#fbbf24;margin-bottom:8px;background:rgba(245,158,11,0.15);padding:6px 8px;border-radius:4px;border:1px solid rgba(245,158,11,0.3);">⚠ Strategy ceiling unavailable — LLM did not respond. No fabricated numbers shown.</div>` : ''}
  ${_fromCache ? `<div style="font-size:10px;color:var(--text-4,#9a9aa6);margin-bottom:6px;">Cached result · computed ${ageLabel}</div>` : ''}

  <!-- 2026-05-31 BUG 2 fix: removed the Current/Ceiling number + bar. The
       strategy-ceiling current/ceiling computation is disconnected from (and
       conflicts with) the sidebar's per-metric value — it rendered an identical
       "Current: 0% / Ceiling: 72%" across alignment/interview/hm-chance while the
       sidebar showed the real, different 100%/33%/64%. The sidebar bar is now the
       single source of truth for the number; this popout keeps only the qualitative
       reasoning + evidence (which ARE per-metric correct). See overnight-COMPLETE-2026-05-31. -->
  ${reasoning ? `<p style="margin:0 0 12px;font-size:11.5px;color:var(--text-3,#b8b8c0);font-style:italic;line-height:1.5;">${_escHtml(reasoning)}</p>` : ''}

  ${evidence.length > 0 ? `
  <!-- Evidence on disk -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3,#b8b8c0);margin:8px 0 6px;">Evidence on disk</div>
  <ul style="list-style:none;padding:0;margin:0 0 12px;">
    ${evidenceItems}
  </ul>
  ` : ''}

  ${open_gaps.length > 0 ? `
  <!-- Open gaps -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3,#b8b8c0);margin:8px 0 6px;">Open gaps · honest read</div>
  <ul style="list-style:none;padding:0;margin:0;">
    ${gapItems}
  </ul>
  ` : ''}

  ${noContentBlock}
</div>`.trim();
}
