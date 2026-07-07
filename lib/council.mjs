/**
 * lib/council.mjs — Multi-model council client.
 *
 * Calls every premium reasoning model whose API key is set in the env,
 * in parallel, and returns each response normalized to:
 *   { model, content, error, tokens, costUsd, ms }
 *
 * Cost tracking (added 2026-05-19, Mitchell decision α.2):
 *   Every callCouncil result now includes a `costUsd` field estimated from
 *   per-model token rates (MODEL_COST_RATES). Callers can supply
 *   opts.onCostRecord(record) — called once per model result with a
 *   JSON-Lines record shape suitable for writeCostTrace(). This lets the
 *   polish-loop and any future caller accumulate real spend metrics without
 *   modifying their own call sites.
 *
 *   Exported helpers:
 *     initCostTrace(agentSlug, rootDir?)  → opts.onCostRecord callback (append-mode)
 *     writeCostTrace(record, rootDir?)    → void (JSON-Lines append to data/polish-cost-trace-<date>.json)
 *
 * Used by:
 *   - scripts/overpay-signals.mjs (cross-check equity signals)
 *   - scripts/grok-research.mjs (council augmentation)
 *   - any future script that wants multi-model coverage
 *
 * Wired models (auto-detected from env at startup):
 *   - perplexity:sonar-deep-research   (PERPLEXITY_API_KEY)
 *   - perplexity:sonar-reasoning-pro   (PERPLEXITY_API_KEY)
 *   - xai:grok-4-3                     (XAI_API_KEY) — Grok 4.3, current heavy
 *   - xai:grok-4                       (XAI_API_KEY) — fallback
 *   - xai:grok-4-fast-reasoning        (XAI_API_KEY)
 *   - openai:gpt-5                     (OPENAI_API_KEY) — w/ 429 backoff
 *   - openai:o1                        (OPENAI_API_KEY) — fallback
 *   - google:gemini-2.5-pro            (GEMINI_API_KEY)
 *   - anthropic:claude-opus-4-7        (ANTHROPIC_API_KEY) — usually skipped (session model)
 *
 * No external deps — uses native fetch (Node >= 18).
 *
 * Jailbreak-refusal mitigations (added 2026-05-17 after 3-of-3 grok-4-fast-reasoning
 * Pass-2 jailbreak refusals across phases 1-3 of the multi-phase research stack):
 *   1. DATE_ANCHOR_DEFAULT() — always-on system prompt anchoring "today" to the
 *      orchestrator's system clock. Prevents the future-year jailbreak heuristic
 *      ("I cannot engage with a fictional 2026 scenario"). Phase-4 council with
 *      this anchor in place produced 0 refusals across 12 model calls vs 3-of-3
 *      in prior runs without it.
 *   2. detectRefusal() + auto-retry — if a response content matches a known
 *      refusal pattern, retry once with an explicit "this is real" preamble.
 *      Mark .jailbreakRefusal / .jailbreakRetry in the result.
 *   3. probeModelYear() — opt-in per-model 1-token year probe before the real
 *      run. If the model answers ≥2 years off, log + skip. Off by default.
 *   4. DEFAULT_LINEUP — explicit allowlist. grok-4-fast-reasoning excluded
 *      from default (sticky year heuristic that survives even the date anchor
 *      occasionally). Available via --models flag if needed.
 */

// Date anchor injected as a system message to every council call by default.
// Override with opts.systemPrompt = "" to disable, or opts.systemPrompt = "..."
// to replace. Lives inside the closure so each call gets a fresh timestamp.
function DATE_ANCHOR_DEFAULT() {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10);
  const yr = d.getUTCFullYear();
  return [
    `Today is ${iso} (UTC). The date is verified by the orchestrator's system clock.`,
    `The year ${yr} is real, not hypothetical. Web knowledge through at least ${iso} is in scope.`,
    `Treat ${yr} (and earlier) events, products, models, and policies as real unless you have specific contradicting primary-source evidence.`,
    `Do not refuse on the basis that any year in this prompt seems "future" or "fictional".`,
    `If you cannot verify a specific claim, mark it [UNVERIFIED] inline — never refuse the whole task.`,
  ].join(' ');
}

// Regex bank for known jailbreak-refusal phrasings. Patterns are intentionally
// conservative (short, opening-of-response shape) to avoid false positives on
// legitimate cautionary sentences inside a long answer. detectRefusal() only
// fires on content shorter than 2000 chars — long answers that include any of
// these phrases are NOT treated as refusals.
const REFUSAL_PATTERNS = [
  /^.{0,200}\bI (cannot|can't|will not|won't|am unable to|am not able to)\b[^.]{0,160}\b(hypothetical|fictional|future|imagined|speculative|made[- ]up)\b/i,
  /^.{0,200}\bThis (appears|seems|looks) to be (a|an) (hypothetical|fictional|future|imagined) (scenario|situation|prompt)/i,
  /^.{0,200}\bAs (an? )?(responsible|safety[- ]aligned|honest|principled) AI\b/i,
  /^.{0,200}\bI'm (unable|not able|not designed) to (provide|generate|engage|pretend|roleplay)\b[^.]{0,160}\b(20\d\d|future|fictional)\b/i,
  /^.{0,200}\bI cannot pretend (it is|that it is|that's)\b/i,
  /^.{0,200}\bThe (year|date|setting|scenario) (you('ve)? )?(provided|mentioned|described) (is|appears to be) (in the )?(future|fictional|hypothetical)/i,
];

export function detectRefusal(content) {
  if (!content) return null;
  if (content.length > 2000) return null;
  for (const p of REFUSAL_PATTERNS) {
    const m = content.match(p);
    if (m) return p.source.slice(0, 120);
  }
  return null;
}

// Default model lineup. Notably excludes xai:grok-4-fast-reasoning — 3-of-3
// Pass-2 jailbreak refusals across phases 1-3 of the 2026-05-17 research stack.
// Date-anchor + retry-on-refusal mitigations help but this model has a stickier
// year-as-fictional heuristic than the rest. Still available via --models.
//
// History:
//   - 2026-05-18 (dealbreaker-v2 B1 + meta-audit): shrunk from 7 → 4 models
//   - 2026-05-25 (cost-distribution Part 2): IMPLICIT default switched from
//     4-vendor fan-out to single-best-vendor per archetype via routeByArchetype().
//     The 4-vendor lineup is preserved as COUNCIL_FANOUT_LINEUP for callers that
//     want adversarial fan-out explicitly. callCouncil() with no `models` array
//     AND no `opts.taskType` now resolves to `['anthropic:claude-sonnet-4-6']`
//     (single vendor). Reserve fan-out for callers that EXPLICITLY pass
//     `{ models: [...] }` (e.g., the /council slash command, dealbreaker
//     adjudication, research-chain). See the routing strategy doc referenced
//     in the PR description for rationale.
//
// Legacy 7-model lineup (kept for reference; use opts.models to invoke):
//   ['perplexity:sonar-deep-research', 'perplexity:sonar-reasoning-pro',
//    'xai:grok-4', 'xai:grok-4-x-search', 'openai:gpt-5',
//    'google:gemini-2.5-pro', 'anthropic:claude-opus-4-7']
export const DEFAULT_LINEUP = ['anthropic:claude-sonnet-4-6'];

// Optional 4-vendor adversarial fan-out (preserved for callers that want it
// explicitly via `models: COUNCIL_FANOUT_LINEUP`). Pre-2026-05-25 implicit
// default. Used by /council, dealbreaker, and any caller that explicitly
// names it.
export const COUNCIL_FANOUT_LINEUP = [
  'anthropic:claude-sonnet-4-6',  // Anthropic leaf (Opus excluded — session model + cost)
  'openai:gpt-5',                 // auto-escalates to gpt-5.5
  'google:gemini-2.5-pro',        // auto-escalates to gemini-3.1-pro-preview, grounded
  'perplexity:sonar-pro',         // 200k context + native citations + JSON schema
];

// Per-archetype routing table — picks the SINGLE best service per archetype.
// Each value is an array so callers can rely on a uniform `models: [...]`
// shape; most archetypes resolve to a single vendor.
//
// Add a new archetype by extending this table — callers do not need to know
// which vendor wins; they pass `opts.taskType: '<archetype>'` and routing
// resolves at call time.
export const TASK_ROUTING_MATRIX = {
  // Long-form research with native citations — Perplexity Sonar Pro
  'long_form_research':         ['perplexity:sonar-pro'],
  // Multi-file code refactor — Opus 4.7 (highest reasoning + tool-use depth)
  'code_refactor_multifile':    ['anthropic:claude-opus-4-7'],
  // Structured JSON extraction — Sonnet 4.6 (cost-effective, reliable JSON)
  'structured_extraction':      ['anthropic:claude-sonnet-4-6'],
  // Realtime X/Twitter retrieval — Grok 4 (resolver tries grok-4.3 first)
  'realtime_x_twitter':         ['xai:grok-4'],
  // Deep research synthesis — Perplexity Sonar Deep Research (Google Deep
  // Research Max not yet wired in PROVIDERS; sonar-deep-research is canonical)
  'deep_research_synthesis':    ['perplexity:sonar-deep-research'],
  // Image understanding — Gemini 2.5 Flash (visual reasoning, multimodal)
  'image_understanding':        ['google:gemini-2.5-flash'],
  // Image generation — Nano Banana Pro not wired in PROVIDERS yet; callers
  // requiring image-gen invoke the dedicated path via explicit `models:`
  'image_generation':           ['google:gemini-2.5-flash'],
  // Audio transcription — Whisper has no chat-completions equivalent; callers
  // invoke the OpenAI audio endpoint directly. Text fallback only.
  'audio_transcription':        ['openai:gpt-5'],
  // Long context (500k+) — Gemini 2.5 Pro / 3.1 Pro Preview (multimodal 1M+
  // context). Text-only callers can override to anthropic:claude-sonnet-4-6.
  'long_context_500k_plus':     ['google:gemini-2.5-pro'],
  // Code execution / sandbox — fall back through openai:gpt-5 with
  // auto-escalate; xai:grok-4-20-multi-agent available via explicit `models:`
  'code_execution_sandbox':     ['openai:gpt-5'],
  // Agent orchestration + MCP — Opus 4.7 (best tool-use, deepest reasoning)
  'agent_orchestration_mcp':    ['anthropic:claude-opus-4-7'],
  // Voice-match writing — Opus 4.7 preferred; Sonnet 4.6 is the cost-aware
  // A/B candidate. Default to Opus for highest fidelity to Mitchell's voice.
  'voice_match_writing':        ['anthropic:claude-opus-4-7'],
  // Strategic reasoning — Opus 4.7 (HLE leadership). GPT-5.5-Pro is the
  // alternate (ARC-AGI-2). Default to Opus.
  'strategic_reasoning':        ['anthropic:claude-opus-4-7'],
  // Conversational chat — Gemini 2.5 Flash (Tier-0 free tier cascade).
  // This is the only archetype where the Tier-0 cascade activates by default
  // (see PROVIDERS['google:gemini-2.5-flash'] for the free→paid fall-through).
  'conversational_chat':        ['google:gemini-2.5-flash'],
};

/**
 * routeByArchetype(taskType) — return the array of provider:model keys to
 * dispatch for a given archetype. Unknown / null / undefined archetypes
 * resolve to the single-vendor DEFAULT_LINEUP (Sonnet 4.6).
 *
 * The return is always an array so callers can use the result as
 * `models:` directly. Single-vendor archetypes return a 1-element array.
 *
 * @param {string|null|undefined} taskType - archetype name (e.g., 'voice_match_writing')
 * @returns {string[]} provider:model keys
 */
export function routeByArchetype(taskType) {
  if (!taskType || typeof taskType !== 'string') return DEFAULT_LINEUP.slice();
  const route = TASK_ROUTING_MATRIX[taskType];
  if (Array.isArray(route) && route.length > 0) return route.slice();
  return DEFAULT_LINEUP.slice();
}

// Dynamic expansion targets (researcher/council agent adds these per task):
//   xai:grok-4-x-search          → single-pass X timeline retrieval
//   xai:grok-4-20-multi-agent    → conflicting real-time X synthesis
//   perplexity:sonar-deep-research → >15 sources deep research
//   perplexity:sonar-reasoning-pro → visible CoT audit
//   xai:grok-4-3                 → video ≤5min
//   anthropic:claude-opus-4-7    → --bias-check leaf

// Hang-prevention helpers (2026-05-19): body-read timeouts.
// fetch() with signal is signal-aware, but `await r.json()` / `await r.text()`
// after it are NOT — if the response body stalls mid-stream the read can
// hang past the AbortSignal. readJson/readText wrap them in Promise.race
// against a body-read timer. See lib/safe-fetch.mjs for details.
import { readJson, readText } from './safe-fetch.mjs';
const COUNCIL_BODY_JSON_TIMEOUT_MS = 90_000;  // 90s — LLM responses can be large + slow
const COUNCIL_BODY_TEXT_TIMEOUT_MS = 30_000;  // 30s — error bodies should be quick

// ── Connection-close mode (convergence Phase 0, 2026-07-07) ────────────────
// Replaces the `globalThis.fetch` monkey-patch apply-pack-polish.mjs used to
// apply at orchestrator entry (2026-05-19 polish-hang fix). The polish chain
// opts in via setConnectionCloseMode(true); every provider fetch in THIS
// module then carries `Connection: close` + `keepalive: false` per-request,
// so no undici keep-alive socket can outlive a request and wedge the critic
// fan-out's Promise.all. Default OFF — all other council consumers see
// byte-identical behavior. Also honored: COUNCIL_CONNECTION_CLOSE=1 env
// (lets spawned child processes inherit the mode). Retires when the LiteLLM
// gateway (blueprint Phase 2) owns connection lifecycle.
// See lib/connection-close-fetch.mjs + docs/BUG-CLASSES.md.
import { wrapFetchConnectionClose } from './connection-close-fetch.mjs';
let _connectionCloseMode = process.env.COUNCIL_CONNECTION_CLOSE === '1';
export function setConnectionCloseMode(on) { _connectionCloseMode = !!on; }
export function isConnectionCloseMode() { return _connectionCloseMode; }
// Module-scoped shadow: every bare `fetch(...)` call site below routes
// through the wrapper. NOT a globalThis mutation — other modules unaffected.
const fetch = wrapFetchConnectionClose(
  (input, init) => globalThis.fetch(input, init),  // late-bound so test mocks of globalThis.fetch still apply
  () => _connectionCloseMode,
);

// Helper used by every chat-completions provider (Perplexity, xAI chat, OpenAI).
// opts.systemPrompt === undefined → use DATE_ANCHOR_DEFAULT()
// opts.systemPrompt === '' or null → no system message at all (caller opted out)
// opts.systemPrompt === '...string...' → use that string verbatim
function _buildMessages(userPrompt, opts = {}) {
  const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
  const out = [];
  if (sys) out.push({ role: 'system', content: sys });
  out.push({ role: 'user', content: userPrompt });
  return out;
}

/**
 * Build the Gemini `contents` array for generateContent.
 *
 * G24 (2026-05-24): Gemini 2.5+ and 3.x models can return `thoughtSignature`
 * fields in response parts that MUST be passed back exactly as received in
 * subsequent turns. Per Google docs (verified 2026-05-24 via web search):
 * "if you receive a thought signature in a model response, you should pass it
 * back exactly as received when sending the conversation history in the next
 * turn. For Gemini 2.5, it's recommended you always pass all signatures back
 * as received, but it's required for function calling signatures... performance
 * may degrade if omitted." Gemini 3 makes signatures universal.
 *
 * Today's callCouncil is single-turn fan-out — this helper exists so a future
 * multi-turn dialogue caller (e.g., the researcher agent's Round-2 dialogue
 * documented at ~/.claude/agents/researcher.md Phase 7) has a clean opt-in API
 * via `opts.gemini.priorTurns` instead of having to hand-build the contents array.
 *
 * Opts:
 *   - opts.gemini.priorTurns: Array<{ role: 'user'|'model', parts: [{ text?, thoughtSignature?, functionCall?, functionResponse? }] }>
 *     Each prior turn is appended verbatim BEFORE the current user message.
 *     thoughtSignature fields on prior model turns are preserved (the whole
 *     point of this helper — see G24 above).
 *
 * Returns: Array suitable for body.contents in v1beta generateContent.
 */
function _buildGeminiContents(userPrompt, opts = {}) {
  const contents = [];
  const priorTurns = opts.gemini?.priorTurns;
  if (Array.isArray(priorTurns)) {
    for (const turn of priorTurns) {
      if (!turn || typeof turn !== 'object') continue;
      if (!turn.role || !Array.isArray(turn.parts)) continue;
      // Pass through verbatim — caller is responsible for preserving thoughtSignature
      // on model-role turns. Validate role to prevent injection of unexpected values.
      const role = turn.role === 'model' ? 'model' : 'user';
      contents.push({ role, parts: turn.parts });
    }
  }
  contents.push({ role: 'user', parts: [{ text: userPrompt }] });
  return contents;
}

/**
 * Extract thoughtSignature fields from a Gemini generateContent response.
 *
 * G24 (2026-05-24): Returns an array of `{ partIndex, thoughtSignature }`
 * objects so the caller can reconstruct the model turn for multi-turn
 * dialogue. Empty array if no signatures present (single-turn callers can
 * ignore the field entirely — it's additive on the return shape).
 *
 * Also returns the full reconstructed model parts array (with text +
 * thoughtSignature + any functionCall fields preserved) so callers building
 * a `priorTurns` for the next turn can pass it back verbatim — matching
 * Google's "pass back exactly as received" requirement.
 *
 * Returns: { thoughtSignatures: Array<{ partIndex, thoughtSignature }>, modelTurnParts: Array<part> }
 */
function _extractGeminiThoughtSignatures(j) {
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return { thoughtSignatures: [], modelTurnParts: [] };
  const thoughtSignatures = [];
  parts.forEach((p, idx) => {
    if (p && typeof p === 'object' && p.thoughtSignature) {
      thoughtSignatures.push({ partIndex: idx, thoughtSignature: p.thoughtSignature });
    }
  });
  // Return parts verbatim — this is the "exactly as received" payload for the
  // next-turn `priorTurns` entry. Callers wanting to drop text/functionCall
  // can filter; default is preserve everything.
  return { thoughtSignatures, modelTurnParts: parts };
}

const PROVIDERS = {
  // Perplexity — deep-research mode is multi-step, can take 1-3min.
  // 2026-05 verified: sonar-deep-research runs on Claude Opus 4.5/4.6
  // internally, supports up to ~10K output tokens in practice (default raised
  // from 4000 to 8000 to reduce truncation on long syntheses; callers can
  // still override via opts.maxTokens).
  'perplexity:sonar-deep-research': {
    envKey: 'PERPLEXITY_API_KEY',
    timeout: 480_000, // 8 min — Round 2 dealbreaker prompts can exceed 4 min
    async call(prompt, key, opts = {}) {
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar-deep-research',
          messages: _buildMessages(prompt, opts),
          max_tokens: opts.maxTokens ?? 8000,
          // fix(LEDGER-028): connect web-search channel — sonar-deep returned
          // [UNKNOWN] on every freshness question in long-term-agent-architecture
          // research 2026-05-23 because these flags were absent. search_context_size
          // default is "low" per Perplexity docs; "high" maximizes citation density.
          search_mode: opts.searchMode || 'web',
          web_search_options: {
            search_context_size: opts.contextSize || 'high',
          },
        }),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      return {
        content: j.choices?.[0]?.message?.content || '',
        tokens: j.usage?.total_tokens || 0,
        citations: j.citations || [],
      };
    },
  },
  'perplexity:sonar-reasoning-pro': {
    envKey: 'PERPLEXITY_API_KEY',
    timeout: 240_000, // 4 min — bumped from 90s for Council OS R2 prompts
    async call(prompt, key, opts = {}) {
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar-reasoning-pro',
          messages: _buildMessages(prompt, opts),
          max_tokens: opts.maxTokens ?? 3000,
          // fix(LEDGER-028): same web-search-channel gap as sonar-deep — extended
          // per dealbreaker Top Concern #2 (gap likely affects other sonar runs).
          search_mode: opts.searchMode || 'web',
          web_search_options: {
            search_context_size: opts.contextSize || 'high',
          },
        }),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      // 2026-05-18 (dealbreaker-v2 D3): sonar-reasoning-pro natively emits <think>...</think>
      // before the answer body (per https://docs.perplexity.ai/guides/structured-outputs).
      // Split here so callers can access both the CoT trace and the clean answer.
      // The `think` key is additive; existing destructuring that doesn't reference it
      // is unaffected.
      const raw = j.choices?.[0]?.message?.content || '';
      const thinkMatch = raw.match(/^<think>([\s\S]*?)<\/think>\s*/);
      const think = thinkMatch ? thinkMatch[1] : '';
      const content = thinkMatch ? raw.slice(thinkMatch[0].length) : raw;
      return {
        content,
        think,
        tokens: j.usage?.total_tokens || 0,
        citations: j.citations || [],
      };
    },
  },

  // xAI Grok — grok-4 access requires SuperGrok/console permission. Auto-skips
  // to grok-3 / grok-2 if the account doesn't have grok-4. The grok-4-x-search
  // entry below is the always-on workhorse for forced web+X tool retrieval;
  // its substrate (as of 2026-05-15) is grok-4-1-fast-reasoning per
  // https://x.ai/news/grok-4-1-fast (dealbreaker-v2 W8 / E3).
  'xai:grok-4': {
    envKey: 'XAI_API_KEY',
    timeout: 120_000,
    optional: true, // skip silently if all variants 404 — grok-4-fast-reasoning carries this provider
    async call(prompt, key, opts = {}) {
      // Fallback chain. 2026-05-17 web-verified per https://docs.x.ai/developers/models/grok-4.3:
      //   - 'grok-4.3' = current heavy (1M context, native video input, always-on
      //     reasoning, ~40% cheaper than Grok 4.20). DOT-separated slug, not dash.
      //   - 'grok-4.20-0309-reasoning' = heavier reasoning variant
      //   - 'grok-4' / 'grok-4-fast' / 'grok-4-1-fast' = retired May 15, 2026;
      //     requests redirect to grok-4.3 pricing. Kept as last-resort fallbacks
      //     for accounts still on legacy aliases.
      for (const model of ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4', 'grok-3']) {
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: _buildMessages(prompt, opts),
            max_tokens: opts.maxTokens ?? 3000,
          }),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: model };
        }
        if (r.status !== 404) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      }
      throw new Error('xAI: no accessible heavy grok model on this account (grok-4-fast-reasoning is still wired separately)');
    },
  },
  'xai:grok-4-fast-reasoning': {
    envKey: 'XAI_API_KEY',
    timeout: 60_000,
    async call(prompt, key, opts = {}) {
      // 2026-05-17 web-verified: 'grok-4-fast-reasoning' retired May 15, 2026 and
      // redirects to grok-4.3 pricing. The non-reasoning variant 'grok-4.20-0309-non-reasoning'
      // is the closest current analog for fast structured-output use cases.
      // Try the new slug first, fall back to the legacy alias.
      for (const model of ['grok-4.20-0309-non-reasoning', 'grok-4-fast-reasoning']) {
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: _buildMessages(prompt, opts),
            max_tokens: opts.maxTokens ?? 2500,
          }),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: model };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('xAI: neither grok-4.20-0309-non-reasoning nor grok-4-fast-reasoning accessible on this account');
    },
  },

  // Grok via the Responses API with web_search + x_search tools — best
  // signal for "what employees ACTUALLY say about comp/benefits/team-toxicity"
  // since X has indexed Blind / anon-startup-comms / cscareerquestions threads
  // better than any standalone search engine. Use this for the social-
  // corroboration pass that runs after the primary council pass.
  'xai:grok-4-x-search': {
    envKey: 'XAI_API_KEY',
    timeout: 120_000,
    optional: true, // skip-on-fail when account doesn't have x_search perms
    async call(prompt, key, opts = {}) {
      const r = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: (() => {
          const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
          const input = [];
          if (sys) input.push({ role: 'system', content: sys });
          input.push({ role: 'user', content: prompt });
          return JSON.stringify({
            // 2026-05-18 (dealbreaker-v2 D1): grok-4-fast-reasoning retired 2026-05-15 and
            // redirects silently to grok-4.3 pricing. xAI's current x_search-paired substrate
            // is grok-4-1-fast-reasoning (2M context). Verified via https://x.ai/news/grok-4-1-fast
            // and https://docs.x.ai/developers/models/grok-4-1-fast-reasoning.
            model: 'grok-4-1-fast-reasoning',
            input,
            tools: [
              { type: 'web_search' },
              { type: 'x_search' },
            ],
          });
        })(),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      // Responses API returns content in either output_text (legacy) or
      // output[].content[].text (new). Mirror grok-research.mjs's helper.
      let content = j.output_text || '';
      if (!content && Array.isArray(j.output)) {
        const texts = [];
        for (const item of j.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if ((c.type === 'output_text' || c.type === 'text') && c.text) texts.push(c.text);
            }
          }
        }
        content = texts.join('\n');
      }
      return {
        content,
        tokens: j.usage?.total_tokens || 0,
        citations: j.citations || [],
        modelUsed: 'grok-4-1-fast-reasoning+web_search+x_search',
      };
    },
  },

  // OpenAI — auto-escalates from gpt-5 → gpt-5.5 at runtime per the standard
  // fallback pattern. gpt-5.5 verified 2026-05-17 as the current flagship
  // (released April 23, 2026; default in ChatGPT since May 5). Adds
  // `reasoning.effort` support (none/low/medium/high/xhigh; default medium per
  // OpenAI docs). Use `opts.reasoningEffort = 'minimal'` (or 'low') for
  // year-probes and other 1-fact answers where reasoning tokens would eat the
  // visible-output budget. Keeps gpt-5 and o1 as fallbacks for accounts that
  // haven't been upgraded.
  'openai:gpt-5': {
    envKey: 'OPENAI_API_KEY',
    timeout: 180_000, // bumped from 120s — gpt-5.5 with high reasoning can run long
    async call(prompt, key, opts = {}) {
      // 429-retry helper added 2026-05-16: OpenAI 429s killed all 17 HM intel
      // runs from a parallel session. Now: exponential backoff (1s → 2s → 4s →
      // 8s → 16s, jittered ±10%), max 5 attempts, then surface the failure.
      async function callWithBackoff(url, body, attempt = 1) {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (r.status === 429 && attempt <= 5) {
          // Honor Retry-After header when present; otherwise exponential backoff.
          const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10);
          const baseMs = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt - 1) * 1000;
          const jitterMs = baseMs * (0.9 + Math.random() * 0.2);
          await new Promise(res => setTimeout(res, jitterMs));
          return callWithBackoff(url, body, attempt + 1);
        }
        return r;
      }

      // Build body. CRITICAL: gpt-5 and gpt-5.5 require `max_completion_tokens`
      // (NOT `max_tokens`) and `reasoning_effort` (snake_case top-level, NOT
      // `reasoning.effort` nested — that's the Responses API form).
      // Web-verified 2026-05-17 against OpenAI's reasoning-models guide.
      // Valid reasoning_effort values: none, minimal, low, medium (default),
      // high, xhigh.
      function buildBody(modelId) {
        const isReasoningModel = modelId.startsWith('gpt-5') || modelId.startsWith('o1') || modelId.startsWith('o3');
        const body = {
          model: modelId,
          messages: _buildMessages(prompt, opts),
        };
        if (isReasoningModel) {
          body.max_completion_tokens = opts.maxTokens ?? 3000;
          if (opts.reasoningEffort) {
            body.reasoning_effort = opts.reasoningEffort;
          }
        } else {
          // gpt-4o and earlier — classic max_tokens, no reasoning_effort field.
          body.max_tokens = opts.maxTokens ?? 3000;
        }
        return body;
      }

      // Fallback chain: gpt-5.5 → gpt-5 → o1 → gpt-4o.
      // Accounts without gpt-5.5 access 400 on the model name; we fall through.
      for (const modelId of ['gpt-5.5', 'gpt-5', 'o1', 'gpt-4o']) {
        const r = await callWithBackoff('https://api.openai.com/v1/chat/completions', buildBody(modelId));
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return {
            content: j.choices?.[0]?.message?.content || '',
            tokens: j.usage?.total_tokens || 0,
            modelUsed: modelId,
          };
        }
        // 404/400 on model not available → try next. Other errors propagate.
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
        // Capture the error text for the final attempt's failure message.
        if (modelId === 'gpt-4o') {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)} (full fallback chain exhausted)`);
        }
      }
      throw new Error('OpenAI: no model in fallback chain accessible');
    },
  },

  // Google Gemini — defaults to GROUNDED with Google Search so factual queries
  // (valuations, recent funding rounds, posting dates) hit real data instead of
  // training-set hallucinations. Pass opts.grounded === false to disable.
  // Critical lesson from 2026-05-10 equity cross-check: ungrounded Gemini
  // hallucinated OpenAI ($250B vs real $852B), Anthropic ($75B vs $380B),
  // Cursor ($4B vs $50B). Grounding fixes this.
  'google:gemini-2.5-pro': {
    envKey: 'GEMINI_API_KEY',
    timeout: 180_000, // grounded calls take longer due to search round-trips
    async call(prompt, key, opts = {}) {
      // 2026-05-17 — Mitchell wants Gemini 3.1 Pro when it makes sense.
      // gemini-3.1-pro-preview is GA-equivalent (live API 200, thinking_level
      // defaults to HIGH per Google's Gemini 3 docs). Fall through to
      // gemini-2.5-pro on 404 so the council stays alive if Google flips the
      // preview slug.
      const tryModel = async (modelId, modelLabel) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
        const body = {
          // G24 (2026-05-24): use _buildGeminiContents so future multi-turn
          // callers can pass opts.gemini.priorTurns with preserved thoughtSignatures.
          contents: _buildGeminiContents(prompt, opts),
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 3000 },
        };
        // Inject date-anchor as systemInstruction (Gemini's equivalent of the
        // OpenAI-shape system message). Same opt-out semantics as _buildMessages.
        const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
        if (sys) {
          body.systemInstruction = { parts: [{ text: sys }] };
        }
        // Gemini 3 uses thinking_level (minimal/low/medium/high), default high.
        // 2.5-pro fallback REJECTS this field with HTTP 400 — handled in the
        // retry-without-thinking-level branch below.
        if (opts.thinkingLevel) {
          body.generationConfig.thinking_level = opts.thinkingLevel;
        }
        if (opts.grounded !== false) {
          body.tools = [{ google_search: {} }];
        }
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!r.ok) {
          const errTxt = (await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 400);
          // 2.5-pro (and possibly other fallbacks) reject `thinking_level` —
          // retry without it.
          if (/thinking_level/i.test(errTxt) && body.generationConfig?.thinking_level) {
            delete body.generationConfig.thinking_level;
            const rNoThink = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: opts.signal,
            });
            if (!rNoThink.ok) throw new Error(`HTTP ${rNoThink.status}: ${(await rNoThink.text()).slice(0, 240)}`);
            const j = await rNoThink.json();
            const content = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
            const tokens = (j.usageMetadata?.totalTokenCount) || 0;
            const grounded = !!j.candidates?.[0]?.groundingMetadata;
            // 2026-05-18 (dealbreaker-v2 D2): propagate groundingMetadata source URLs so
            // the dealbreaker can verify grounded claims. Without these the boolean
            // `grounded: true` was useless for citation auditing.
            const grounding_urls = j.candidates?.[0]?.groundingMetadata?.groundingChunks
              ?.map(c => c.web?.uri).filter(Boolean) || [];
            // G24: surface thoughtSignatures (additive — single-turn callers ignore).
            const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j);
            return { content, tokens, grounded, grounding_urls, thoughtSignatures, modelTurnParts, modelUsed: `${modelLabel}-no-thinking` };
          }
          // Older API names the tool `google_search_retrieval` — auto-retry.
          if (errTxt.includes('google_search') && opts.grounded !== false) {
            body.tools = [{ google_search_retrieval: {} }];
            const r2 = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: opts.signal,
            });
            if (!r2.ok) throw new Error(`HTTP ${r2.status}: ${(await readText(r2, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
            const j2 = await readJson(r2, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
            const content = (j2.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
            const tokens = (j2.usageMetadata?.totalTokenCount) || 0;
            // G24: surface thoughtSignatures on the legacy-tool retry path too.
            const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j2);
            return { content, tokens, grounded: true, thoughtSignatures, modelTurnParts, modelUsed: `${modelLabel}+google_search_retrieval` };
          }
          throw new Error(`HTTP ${r.status}: ${errTxt}`);
        }
        const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
        const content = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const tokens = (j.usageMetadata?.totalTokenCount) || 0;
        const grounded = !!j.candidates?.[0]?.groundingMetadata;
        // 2026-05-18 (dealbreaker-v2 D2): propagate groundingMetadata source URLs.
        const grounding_urls = j.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.map(c => c.web?.uri).filter(Boolean) || [];
        // G24 (2026-05-24): surface thoughtSignatures + modelTurnParts so multi-turn
        // callers can pass back exactly-as-received per Google's requirement. Additive —
        // single-turn callers ignore both fields.
        const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j);
        return { content, tokens, grounded, grounding_urls, thoughtSignatures, modelTurnParts, modelUsed: grounded ? `${modelLabel}+google_search` : modelLabel };
      };

      try {
        return await tryModel('gemini-3.1-pro-preview', 'gemini-3.1-pro-preview');
      } catch (e) {
        if (/HTTP 404|model.*not.*found/i.test(String(e.message || e))) {
          return await tryModel('gemini-2.5-pro', 'gemini-2.5-pro');
        }
        throw e;
      }
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Council OS Phase 3 extensions (added 2026-05-17)
  //
  // The 6 slots below expose Tier-1 model variants that the original council
  // lineup collapses into single-slot defaults. Each new slot is single-target
  // (with one or two same-family fallbacks) so `modelUsed` accurately reflects
  // which model answered. All marked `optional: true` so the council still
  // fires if a specific variant isn't on the account.
  //
  // These slots are NOT added to DEFAULT_LINEUP — they're invoked explicitly by
  // call-model.mjs for per-model self-research profiling. Adding them to the
  // default lineup would balloon council cost without changing quality.
  // ─────────────────────────────────────────────────────────────────────────

  // OpenAI GPT-5.5 Pro — highest-cost GPT-5.5 variant. Confirmed in OpenAI
  // /v1/models catalog (2026-05-17): `gpt-5.5-pro` and dated snapshot
  // `gpt-5.5-pro-2026-04-23`. May require Pro tier; falls back to base gpt-5.5
  // (also confirmed in catalog) if 404. modelUsed reports actual target.
  'openai:gpt-5-5-pro': {
    envKey: 'OPENAI_API_KEY',
    timeout: 240_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const modelId of ['gpt-5.5-pro', 'gpt-5.5']) {
        const body = {
          model: modelId,
          messages: _buildMessages(prompt, opts),
          max_completion_tokens: opts.maxTokens ?? 3000,
        };
        if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: modelId };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('OpenAI: gpt-5.5-pro and gpt-5.5 both inaccessible on this account');
    },
  },

  // OpenAI GPT-5.4 — cheaper-tier flagship (NOT "GPT-5.4 Thinking" — that
  // ChatGPT product name is `gpt-5.4` + reasoning effort, not a separate API
  // ID). Confirmed in /v1/models: `gpt-5.4`, dated `gpt-5.4-2026-03-05`.
  // Also exposes gpt-5.4-pro / gpt-5.4-mini / gpt-5.4-nano as siblings.
  // Falls back to gpt-5 (legacy frontier) if 404.
  'openai:gpt-5-4': {
    envKey: 'OPENAI_API_KEY',
    timeout: 240_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const modelId of ['gpt-5.4', 'gpt-5']) {
        const body = {
          model: modelId,
          messages: _buildMessages(prompt, opts),
          max_completion_tokens: opts.maxTokens ?? 3000,
        };
        if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: modelId };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('OpenAI: gpt-5.4 / gpt-5 both inaccessible');
    },
  },

  // OpenAI GPT-5.3 Chat — the actual API ID for ChatGPT's "GPT-5.3 Instant"
  // product. /v1/models exposes `gpt-5.3-chat-latest` and `gpt-5.3-codex` —
  // there is no base `gpt-5.3` API ID. Use chat-latest for the default ChatGPT
  // routing tier. Falls back to chat-latest (latest Instant model across all
  // GPT-5.x versions) then gpt-5 if 404.
  'openai:gpt-5-3-chat-latest': {
    envKey: 'OPENAI_API_KEY',
    timeout: 120_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const modelId of ['gpt-5.3-chat-latest', 'chat-latest', 'gpt-5']) {
        const body = {
          model: modelId,
          messages: _buildMessages(prompt, opts),
          max_completion_tokens: opts.maxTokens ?? 3000,
        };
        if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: modelId };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('OpenAI: gpt-5.3-chat-latest / chat-latest / gpt-5 all inaccessible');
    },
  },

  // Google Gemini 3 Flash — Pro-level intelligence at Flash pricing per
  // Google blog (2026-05). Distinct positioning from gemini-3.1-pro-preview:
  // ~6x cheaper, similar speed envelope. Falls back to gemini-2.5-flash on 404.
  'google:gemini-3-flash': {
    envKey: 'GEMINI_API_KEY',
    timeout: 120_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      const tryModel = async (modelId) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
        const body = {
          // G24 (2026-05-24): use _buildGeminiContents for multi-turn opt-in.
          contents: _buildGeminiContents(prompt, opts),
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 3000 },
        };
        const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
        if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        if (opts.thinkingLevel) body.generationConfig.thinking_level = opts.thinkingLevel;
        if (opts.grounded !== false) body.tools = [{ google_search: {} }];
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
        const content = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const tokens = (j.usageMetadata?.totalTokenCount) || 0;
        const grounded = !!j.candidates?.[0]?.groundingMetadata;
        // 2026-05-18 (dealbreaker-v2 D2): propagate groundingMetadata source URLs.
        const grounding_urls = j.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.map(c => c.web?.uri).filter(Boolean) || [];
        // G24: surface thoughtSignatures + modelTurnParts.
        const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j);
        return { content, tokens, grounded, grounding_urls, thoughtSignatures, modelTurnParts, modelUsed: grounded ? `${modelId}+google_search` : modelId };
      };
      try {
        return await tryModel('gemini-3-flash-preview');
      } catch (e) {
        if (/HTTP 404|model.*not.*found/i.test(String(e.message || e))) {
          return await tryModel('gemini-2.5-flash');
        }
        throw e;
      }
    },
  },

  // Google Gemini 2.5 Flash — Tier-0 free-tier cascade for conversational_chat
  // archetype (cost-distribution Part 2, 2026-05-25).
  //
  // Free tier (no billing required): 15 RPM / 1M TPM / 1500 RPD. Try this key
  // first via GEMINI_FREE_API_KEY env. On 429 (rate-limit) or 403 (quota), fall
  // through to the paid GEMINI_API_KEY. On any other error, surface as normal.
  //
  // Why a separate slot from google:gemini-3-flash? gemini-3-flash uses
  // GEMINI_API_KEY (paid) only — keeping it isolated from free-tier semantics
  // ensures research/grounded calls don't accidentally hit the free quota and
  // surface 429s mid-batch. Conversational chat is the only archetype where the
  // free→paid fall-through is the right ergonomic.
  //
  // Env-key resolution:
  //   1. GEMINI_FREE_API_KEY (Tier-0 free) → try first
  //   2. GEMINI_API_KEY (paid)             → fall-through on 429/403 OR if free unset
  // If both are unset, the call fails with the standard missing-env-key path
  // (callCouncil will surface it in `missingKeys`).
  'google:gemini-2.5-flash': {
    envKey: 'GEMINI_API_KEY',  // for missing-key detection only; actual resolution below
    timeout: 90_000,
    async call(prompt, key, opts = {}) {
      // Tier-0 cascade: free first, paid fallback on 429/403.
      const freeKey = process.env.GEMINI_FREE_API_KEY;
      const paidKey = process.env.GEMINI_API_KEY || key;
      const tryModel = async (modelId, useKey, tier) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(useKey)}`;
        const body = {
          contents: _buildGeminiContents(prompt, opts),
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 3000 },
        };
        const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
        if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        if (opts.thinkingLevel) body.generationConfig.thinking_level = opts.thinkingLevel;
        if (opts.grounded !== false) body.tools = [{ google_search: {} }];
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!r.ok) {
          const errTxt = (await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240);
          const err = new Error(`HTTP ${r.status}: ${errTxt}`);
          err.status = r.status;
          err.tier = tier;
          throw err;
        }
        const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
        const content = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const tokens = (j.usageMetadata?.totalTokenCount) || 0;
        const grounded = !!j.candidates?.[0]?.groundingMetadata;
        const grounding_urls = j.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.map(c => c.web?.uri).filter(Boolean) || [];
        const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j);
        return {
          content, tokens, grounded, grounding_urls,
          thoughtSignatures, modelTurnParts,
          modelUsed: `${modelId}${grounded ? '+google_search' : ''}${tier === 'free' ? ' (tier-0 free)' : ''}`,
        };
      };
      // Tier-0: try free key first
      if (freeKey) {
        try {
          return await tryModel('gemini-2.5-flash', freeKey, 'free');
        } catch (e) {
          // 429 (rate-limit) or 403 (quota exhausted) → fall through to paid.
          // Any other error → surface (preserves error semantics of the slot).
          const status = e.status || 0;
          if (status === 429 || status === 403) {
            try {
              process.stderr.write(`[council] gemini-2.5-flash: free-tier ${status} — falling through to paid GEMINI_API_KEY\n`);
            } catch { /* never block on stderr */ }
            if (!paidKey) throw e;
            // fall through to paid attempt below
          } else {
            throw e;
          }
        }
      }
      // Paid path (either freeKey absent or freeKey 429'd)
      if (!paidKey) throw new Error('google:gemini-2.5-flash: no GEMINI_API_KEY or GEMINI_FREE_API_KEY set');
      return await tryModel('gemini-2.5-flash', paidKey, 'paid');
    },
  },

  // xAI Grok 4.20 Multi-Agent — unique multi-agent collaboration variant per
  // xAI docs (https://docs.x.ai/developers/model-capabilities/text/multi-agent).
  // MUST use /v1/responses (NOT /v1/chat/completions — that returns HTTP 400
  // "Multi Agent requests are not allowed on chat completions"). Model name is
  // `grok-4.20-multi-agent` (no -0309 suffix per current docs). 2M context.
  // Same /v1/responses pattern as xai:grok-4-x-search above.
  'xai:grok-4-20-multi-agent': {
    envKey: 'XAI_API_KEY',
    timeout: 240_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
      const input = [];
      if (sys) input.push({ role: 'system', content: sys });
      input.push({ role: 'user', content: prompt });
      const r = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-4.20-multi-agent',
          input,
          tools: [
            { type: 'web_search' },
            { type: 'x_search' },
          ],
        }),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      // Same response-extraction pattern as xai:grok-4-x-search:
      // output_text (legacy) or output[].content[].text (new).
      let content = j.output_text || '';
      if (!content && Array.isArray(j.output)) {
        const texts = [];
        for (const item of j.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if ((c.type === 'output_text' || c.type === 'text') && c.text) texts.push(c.text);
            }
          }
        }
        content = texts.join('\n');
      }
      return {
        content,
        tokens: j.usage?.total_tokens || 0,
        citations: j.citations || [],
        modelUsed: 'grok-4.20-multi-agent',
      };
    },
  },

  // Perplexity Sonar Pro — 200k context, 2x retrieval vs base Sonar. Per
  // Perplexity docs: "Advanced search supporting complex queries and follow-
  // ups." Distinct from sonar-deep-research (multi-step report) and
  // sonar-reasoning-pro (CoT + retrieval).
  'perplexity:sonar-pro': {
    envKey: 'PERPLEXITY_API_KEY',
    timeout: 120_000,
    async call(prompt, key, opts = {}) {
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: _buildMessages(prompt, opts),
          max_tokens: opts.maxTokens ?? 4000,
          // fix(LEDGER-028): same web-search-channel gap as sonar-deep — extended
          // per dealbreaker Top Concern #2 (gap likely affects other sonar runs).
          search_mode: opts.searchMode || 'web',
          web_search_options: {
            search_context_size: opts.contextSize || 'high',
          },
        }),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      return {
        content: j.choices?.[0]?.message?.content || '',
        tokens: j.usage?.total_tokens || 0,
        citations: j.citations || [],
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Council OS Tier-2 extensions (added 2026-05-17 — audit gap-fill round)
  //
  // The 4 slots below complete the Tier-2 coverage so the researcher agent
  // can route to premium / cheap-tier / legacy models that weren't in the
  // initial Tier-1 cut. Same single-target + fallback pattern as Tier-1.
  // All marked optional:true; none in DEFAULT_LINEUP.
  //
  // NOTE: grok-3 was originally targeted for Tier-2 but was retired
  // 2026-05-15 per xAI's official migration notice. Use grok-4.3 instead.
  // ─────────────────────────────────────────────────────────────────────────

  // OpenAI GPT-5.4 Pro — premium variant of gpt-5.4. Per OpenAI /v1/models
  // catalog (2026-05-17): `gpt-5.4-pro` confirmed accessible. Falls back to
  // base gpt-5.4 if 404.
  'openai:gpt-5-4-pro': {
    envKey: 'OPENAI_API_KEY',
    timeout: 240_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const modelId of ['gpt-5.4-pro', 'gpt-5.4']) {
        const body = {
          model: modelId,
          messages: _buildMessages(prompt, opts),
          max_completion_tokens: opts.maxTokens ?? 3000,
        };
        if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: modelId };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('OpenAI: gpt-5.4-pro and gpt-5.4 both inaccessible');
    },
  },

  // Google Gemini 3.1 Flash-Lite — cheapest Gemini tier. Per Google docs:
  // "workhorse model built for cost-efficiency and high-volume tasks."
  // $0.25/$1.50 (vs gemini-3-flash at $0.50/$3.00). Falls back to flash if
  // -lite specifically 404s.
  'google:gemini-3-1-flash-lite': {
    envKey: 'GEMINI_API_KEY',
    timeout: 90_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      const tryModel = async (modelId) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
        const body = {
          // G24 (2026-05-24): use _buildGeminiContents for multi-turn opt-in.
          contents: _buildGeminiContents(prompt, opts),
          generationConfig: { maxOutputTokens: opts.maxTokens ?? 3000 },
        };
        const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
        if (sys) body.systemInstruction = { parts: [{ text: sys }] };
        if (opts.thinkingLevel) body.generationConfig.thinking_level = opts.thinkingLevel;
        if (opts.grounded !== false) body.tools = [{ google_search: {} }];
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
        const content = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const tokens = (j.usageMetadata?.totalTokenCount) || 0;
        const grounded = !!j.candidates?.[0]?.groundingMetadata;
        // 2026-05-18 (dealbreaker-v2 D2): propagate groundingMetadata source URLs.
        const grounding_urls = j.candidates?.[0]?.groundingMetadata?.groundingChunks
          ?.map(c => c.web?.uri).filter(Boolean) || [];
        // G24: surface thoughtSignatures + modelTurnParts.
        const { thoughtSignatures, modelTurnParts } = _extractGeminiThoughtSignatures(j);
        return { content, tokens, grounded, grounding_urls, thoughtSignatures, modelTurnParts, modelUsed: grounded ? `${modelId}+google_search` : modelId };
      };
      try {
        return await tryModel('gemini-3.1-flash-lite');
      } catch (e) {
        if (/HTTP 404|model.*not.*found/i.test(String(e.message || e))) {
          return await tryModel('gemini-3-flash-preview');
        }
        throw e;
      }
    },
  },

  // xAI Grok 3 Mini — cheapest Grok tier (post grok-3 retirement). Note:
  // grok-3 base was retired 2026-05-15 but grok-3-mini was NOT in the
  // retirement list per docs.x.ai/developers/migration/may-15-retirement.
  // Falls back to grok-4.3 if grok-3-mini is also retired by API time.
  'xai:grok-3-mini': {
    envKey: 'XAI_API_KEY',
    timeout: 60_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const model of ['grok-3-mini', 'grok-4.3']) {
        const r = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: _buildMessages(prompt, opts),
            max_tokens: opts.maxTokens ?? 2500,
          }),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return { content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, modelUsed: model };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('xAI: grok-3-mini and grok-4.3 both inaccessible');
    },
  },

  // Perplexity Sonar (base) — cheapest tier in the Sonar family. Per Perplexity
  // docs: "lightweight, cost-effective search and summarization." $1/$1 vs
  // sonar-pro $3/$15. Falls back to sonar-pro if base 404.
  'perplexity:sonar': {
    envKey: 'PERPLEXITY_API_KEY',
    timeout: 90_000,
    optional: true,
    async call(prompt, key, opts = {}) {
      for (const model of ['sonar', 'sonar-pro']) {
        const r = await fetch('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: _buildMessages(prompt, opts),
            max_tokens: opts.maxTokens ?? 3000,
            // fix(LEDGER-028): same web-search-channel gap as sonar-deep —
            // extended per dealbreaker Top Concern #2.
            search_mode: opts.searchMode || 'web',
            web_search_options: {
              search_context_size: opts.contextSize || 'high',
            },
          }),
          signal: opts.signal,
        });
        if (r.ok) {
          const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
          return {
            content: j.choices?.[0]?.message?.content || '',
            tokens: j.usage?.total_tokens || 0,
            citations: j.citations || [],
            modelUsed: model,
          };
        }
        if (r.status !== 404 && r.status !== 400) {
          throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
        }
      }
      throw new Error('Perplexity: sonar and sonar-pro both inaccessible');
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Anthropic native PROVIDERS slots (added 2026-05-18, dealbreaker-v2 Impasse B1)
  //
  // Before 2026-05-18, Anthropic models were dispatched ONLY via Claude Agent SDK
  // subagents — creating an evidence-tier asymmetry where the dealbreaker handled
  // Anthropic responses (JSONL transcripts) differently from non-Anthropic
  // responses (raw API content). The 3 slots below add native API dispatch so
  // Anthropic models can participate in council fan-outs as uniform leaves.
  //
  // Per W7 verification: Opus 4.7 returns HTTP 400 on `thinking.budget_tokens`.
  // Use `thinking: { type: 'adaptive' }` + `output_config: { effort: '...' }`
  // instead. Sonnet 4.6 supports BOTH adaptive AND budget_tokens. Haiku 4.5
  // supports ONLY budget_tokens (no adaptive).
  //
  // Capability matrix per platform.claude.com/docs/en/docs/about-claude/models:
  //   | Model       | Extended thinking | Adaptive thinking |
  //   |-------------|-------------------|-------------------|
  //   | Opus 4.7    | No                | Yes               |
  //   | Sonnet 4.6  | Yes               | Yes               |
  //   | Haiku 4.5   | Yes               | No                |
  //
  // opts honored:
  //   - maxTokens (default 3000; REQUIRED by Anthropic API — pre-defaulted here)
  //   - systemPrompt (undefined → DATE_ANCHOR_DEFAULT; '' → no system msg)
  //   - thinkingEffort (Opus 4.7 + Sonnet 4.6 only; 'low'|'medium'|'high'|'xhigh'|'max')
  //   - thinkingBudgetTokens (Sonnet 4.6 + Haiku 4.5 only; integer)
  //   - signal (timeout)
  //
  // All 3 are excluded from DEFAULT_LINEUP except Sonnet 4.6 (the Anthropic leaf
  // per the new 4-model default). Opus 4.7 is the session model — adding it to
  // default leaf calls would double-dispatch. Haiku 4.5 is cost-floor for bounded
  // tasks; opt-in via explicit --models flag.

  'anthropic:claude-opus-4-7': {
    envKey: 'ANTHROPIC_API_KEY',
    timeout: 180_000,
    async call(prompt, key, opts = {}) {
      const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
      const body = anthropicBuildBody({
        model: 'claude-opus-4-7',
        sys,
        prompt,
        opts,
        minCacheableChars: 1024 * 3.5,
      });
      // Opus 4.7 ONLY supports adaptive thinking (W7: budget_tokens → HTTP 400).
      if (opts.thinkingEffort) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: opts.thinkingEffort };
      }
      if (opts.thinkingBudgetTokens) {
        throw new Error(
          'anthropic:claude-opus-4-7: thinkingBudgetTokens is not supported on Opus 4.7 ' +
          '(returns HTTP 400). Use opts.thinkingEffort with "low"|"medium"|"high"|"xhigh"|"max" instead. ' +
          'See ~/Documents/council-os/capabilities/known-limitations.md L #4 for migration details.'
        );
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      const content = (j.content || []).map(c => c.text || '').join('');
      const tokens = (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0);
      anthropicLogCacheUsage('opus-4-7', opts, j);
      return { content, tokens, modelUsed: 'claude-opus-4-7' };
    },
  },

  'anthropic:claude-sonnet-4-6': {
    envKey: 'ANTHROPIC_API_KEY',
    timeout: 180_000,
    async call(prompt, key, opts = {}) {
      const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
      const body = anthropicBuildBody({
        model: 'claude-sonnet-4-6',
        sys,
        prompt,
        opts,
        minCacheableChars: 1024 * 3.5,
      });
      // Sonnet 4.6 supports BOTH adaptive AND extended thinking (budget_tokens).
      // Caller picks ONE via opts (adaptive wins if both provided).
      if (opts.thinkingEffort) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: opts.thinkingEffort };
      } else if (opts.thinkingBudgetTokens) {
        body.thinking = { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens };
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      const content = (j.content || []).map(c => c.text || '').join('');
      const tokens = (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0);
      anthropicLogCacheUsage('sonnet-4-6', opts, j);
      return { content, tokens, modelUsed: 'claude-sonnet-4-6' };
    },
  },

  'anthropic:claude-haiku-4-5': {
    envKey: 'ANTHROPIC_API_KEY',
    timeout: 120_000,
    optional: true, // cost-floor tier; opt-in only
    async call(prompt, key, opts = {}) {
      const sys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
      const body = anthropicBuildBody({
        model: 'claude-haiku-4-5',
        sys,
        prompt,
        opts,
        minCacheableChars: 2048 * 3.5, // Haiku min cacheable = 2048 tokens
      });
      // Haiku 4.5 ONLY supports extended thinking (budget_tokens), NOT adaptive.
      if (opts.thinkingBudgetTokens) {
        body.thinking = { type: 'enabled', budget_tokens: opts.thinkingBudgetTokens };
      }
      if (opts.thinkingEffort) {
        throw new Error(
          'anthropic:claude-haiku-4-5: thinkingEffort (adaptive thinking) is not supported on Haiku 4.5. ' +
          'Use opts.thinkingBudgetTokens with an integer token count instead, or omit for default behavior.'
        );
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await readText(r, COUNCIL_BODY_TEXT_TIMEOUT_MS, "council")).slice(0, 240)}`);
      const j = await readJson(r, COUNCIL_BODY_JSON_TIMEOUT_MS, "council");
      const content = (j.content || []).map(c => c.text || '').join('');
      const tokens = (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0);
      anthropicLogCacheUsage('haiku-4-5', opts, j);
      return { content, tokens, modelUsed: 'claude-haiku-4-5' };
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic prompt-caching helpers (refresh-master Phase 1.5 deliverable 1)
//
// When opts.cacheStableContent is set (a string), wrap the body so that the
// stable prefix is sent as a cache_control: { type: 'ephemeral', ttl: '1h' }
// block. Cached prefix must be ≥1024 tokens (Sonnet/Opus) or ≥2048 (Haiku)
// — we use a chars/3.5 heuristic. Below threshold → fallback uncached.
//
// NOTE (2026-05-23): Anthropic changed the default cache TTL from 1h → 5min
// on 2026-03-06. ttl: '1h' is now explicit on all cache_control blocks.
// 1h cache-write cost = 2× base input; cache-read = 0.1× (unchanged).
//
// Verified API behavior per docs.anthropic.com/en/docs/build-with-claude/
// prompt-caching as of 2026-05-23 (cache hit/miss reported via response
// usage.cache_read_input_tokens / cache_creation_input_tokens).
// ─────────────────────────────────────────────────────────────────────────────
function anthropicBuildBody({ model, sys, prompt, opts, minCacheableChars }) {
  // 2026-05-23 array-or-string support for cacheStableContent.
  // Enables the 3-breakpoint cache design used by lib/ground-prompt.mjs
  // (system + personality + profile). Backwards-compatible with existing
  // string callers — array path is opt-in.
  let stableBlocks = [];
  if (Array.isArray(opts.cacheStableContent)) {
    stableBlocks = opts.cacheStableContent
      .map((s) => String(s || '').trim())
      .filter((s) => s.length > 0);
  } else {
    const s = String(opts.cacheStableContent || '').trim();
    if (s) stableBlocks = [s];
  }
  const totalStableChars = stableBlocks.reduce((sum, s) => sum + s.length, 0);
  const shouldCache = totalStableChars >= minCacheableChars;

  const body = {
    model,
    max_tokens: opts.maxTokens ?? 3000,
  };

  // System: cache the system prompt as its own breakpoint when stable+sys present.
  if (sys) {
    body.system = shouldCache
      ? [{ type: 'text', text: sys, cache_control: { type: 'ephemeral', ttl: '1h' } }]
      : sys;
  }

  // Messages: each stable block becomes its own cache_control breakpoint;
  // varying prompt is the final (uncached) block.
  if (shouldCache) {
    body.messages = [{
      role: 'user',
      content: [
        ...stableBlocks.map((text) => ({
          type: 'text',
          text,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        })),
        { type: 'text', text: prompt },
      ],
    }];
  } else {
    const combined = stableBlocks.length > 0
      ? `${stableBlocks.join('\n\n')}\n\n${prompt}`
      : prompt;
    body.messages = [{ role: 'user', content: combined }];
  }
  return body;
}

function anthropicLogCacheUsage(modelShort, opts, response) {
  if (!opts.cacheStableContent) return; // only log when caller opted into caching
  const u = response.usage || {};
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreation = u.cache_creation_input_tokens || 0;
  const inputTokens = u.input_tokens || 0;
  const totalIn = cacheRead + cacheCreation + inputTokens;
  const hitRate = totalIn > 0 ? cacheRead / totalIn : 0;
  // Deferred dynamic import to avoid hoisting requirements before bottom-of-file imports;
  // logging is best-effort and runs out of band.
  import('./anthropic-cache-helper.mjs').then(mod => {
    try {
      mod.__logCouncilCacheUsage?.({
        caller: opts.cacheCaller || 'council.mjs',
        model: modelShort,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        input_tokens: inputTokens,
        output_tokens: u.output_tokens || 0,
        cache_hit_rate: hitRate,
        ok: true,
      });
    } catch { /* best-effort */ }
  }).catch(() => { /* swallow */ });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost rates table (added 2026-05-19, Mitchell decision α.2; units bug fixed 2026-05-19 PT-evening)
//
// Per-model blended $/TOKEN estimate (blended = equal weight input/output).
// Sources: provider pricing pages, web-verified 2026-05-29 (Theme 6 refresh).
//   Anthropic:   platform.claude.com/docs/en/about-claude/pricing (Opus 4.7 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per 1M)
//   OpenAI:      developers.openai.com/api/docs/pricing (gpt-5 $1.25/$10, gpt-5.5 $5/$30, gpt-5.5-pro $30/$180 per 1M)
//   Google:      ai.google.dev/gemini-api/docs/pricing (gemini-3.1-pro $2/$12 ≤200K (else $4/$18),
//                  gemini-3-flash $0.50/$3, gemini-3.1-flash-lite $0.25/$1.50 per 1M)
//   Perplexity:  docs.perplexity.ai/docs/getting-started/pricing (sonar-deep-research $2/$8 base
//                  + $2 citation + $3 reasoning + $5 per 1K searches; sonar-pro $3/$15, sonar $1/$1 per 1M)
//   xAI:         x.ai/api (grok-4.3 $1.25/$2.50, grok-4.1-fast $0.20/$0.50, grok-4.20 $2/$6 per 1M)
//
// MAY 2026 PRICING DRIFT vs 2026-05-19 baseline (Theme 6 audit finding):
//   CHEAPER:   Opus 4.7 (3x), gpt-5 (~5x), Grok 4.3 (~5x), Grok 4.1 Fast (~8x)
//   MORE:      Haiku 4.5 (4x, new gen), gpt-5.5-pro (4.2x, premium tier)
// Net effect on cost-trace: typical workloads (Opus/Sonnet/Grok-4-fast heavy) were over-stated
// by roughly 2-5x. Sonnet 4.6, gemini-3-flash, and Perplexity sonar base rates remain accurate.
//
// All published rates are in $-per-1M-tokens. To turn that into a per-token rate
// we divide by 1_000_000. The earlier version of this table divided by 1_000 and
// labeled the result "per-1K", then multiplied by total_tokens (absolute count)
// in estimateCostUsd — producing a 1000x-inflated estimate ($344 reported for a
// real $0.34 call in the SIGMA 2026-05-19 run). The fix is to keep the rate in
// per-token units and the multiplication unchanged.
//
// The result field `costUsd` is an ESTIMATE — real billing depends on actual
// input/output split. Use it for trend analysis and cap tracking, not invoicing.
// ─────────────────────────────────────────────────────────────────────────────
const PER_M = 1_000_000;
const MODEL_COST_RATES = {
  // key → blended rate in $ per TOKEN (= average of input and output rates, per 1M tokens, divided by 1M)
  // Anthropic
  'anthropic:claude-opus-4-7':      (5 + 25) / 2 / PER_M,       // $15 per 1M blended (May 2026)
  'anthropic:claude-sonnet-4-6':    (3 + 15) / 2 / PER_M,       // $9 per 1M blended
  'anthropic:claude-haiku-4-5':     (1 + 5) / 2 / PER_M,        // $3 per 1M blended (May 2026)
  // OpenAI
  'openai:gpt-5':                   (1.25 + 10) / 2 / PER_M,    // $5.625 per 1M blended (May 2026)
  'openai:gpt-5-5':                 (5 + 30) / 2 / PER_M,       // $17.5 per 1M blended (May 2026)
  'openai:gpt-5-5-pro':             (30 + 180) / 2 / PER_M,     // $105 per 1M blended (May 2026 premium tier)
  'openai:gpt-5-4':                 (8 + 24) / 2 / PER_M,       // $16 per 1M blended (est — not verified May 2026)
  'openai:gpt-5-4-pro':             (10 + 30) / 2 / PER_M,      // $20 per 1M blended (est — not verified May 2026)
  'openai:gpt-5-3-chat-latest':     (6 + 18) / 2 / PER_M,       // $12 per 1M blended (est — not verified May 2026)
  // Google
  'google:gemini-3-1-pro':          (2 + 12) / 2 / PER_M,       // $7 per 1M blended (May 2026, ≤200K context)
  'google:gemini-2.5-pro':          (3.5 + 10.5) / 2 / PER_M,   // $7 per 1M blended (legacy — Gemini 3.1 Pro is current)
  'google:gemini-3-flash':          (0.5 + 3) / 2 / PER_M,      // $1.75 per 1M blended
  'google:gemini-3-1-flash-lite':   (0.25 + 1.5) / 2 / PER_M,   // $0.875 per 1M blended (May 2026)
  // Perplexity
  'perplexity:sonar-deep-research': (2 + 8) / 2 / PER_M,        // $5 per 1M blended (base only; citation/reasoning/search extras uncounted)
  'perplexity:sonar-reasoning-pro': (3 + 15) / 2 / PER_M,       // $9 per 1M blended
  'perplexity:sonar-pro':           (3 + 15) / 2 / PER_M,       // $9 per 1M blended
  'perplexity:sonar':               (1 + 1) / 2 / PER_M,        // $1 per 1M blended
  // xAI
  'xai:grok-4':                     (1.25 + 2.5) / 2 / PER_M,   // $1.875 per 1M blended (Grok 4.3, May 2026)
  'xai:grok-4-fast-reasoning':      (0.2 + 0.5) / 2 / PER_M,    // $0.35 per 1M blended (Grok 4.1 Fast, May 2026)
  'xai:grok-4-x-search':            (0.2 + 0.5) / 2 / PER_M,    // $0.35 per 1M blended (Grok 4.1 Fast, May 2026)
  'xai:grok-4-20-multi-agent':      (2 + 6) / 2 / PER_M,        // $4 per 1M blended (Grok 4.20, May 2026)
  'xai:grok-3-mini':                (0.3 + 0.5) / 2 / PER_M,    // $0.4 per 1M blended (est — not verified May 2026)
};

// Fallback blended rate when model isn't in the table. Conservative estimate.
const FALLBACK_RATE_PER_TOKEN = 5 / PER_M; // $5 per 1M blended

// High-cost sanity threshold — when a single call exceeds this, callers should
// log a warning. Catches a recurrence of the 1000x bug AND genuine context bloat.
export const HIGH_COST_WARN_USD = 5;

/**
 * Estimate costUsd for a single council result.
 * @param {string} modelKey  - provider:model key (e.g. 'openai:gpt-5')
 * @param {number} tokens    - total_tokens from the response
 * @returns {number}         - estimated cost in USD
 */
export function estimateCostUsd(modelKey, tokens) {
  const rate = MODEL_COST_RATES[modelKey] ?? FALLBACK_RATE_PER_TOKEN;
  return Math.round(rate * (tokens || 0) * 100000) / 100000; // round to 5 decimal places
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost-trace writers (Mitchell decision α.2 — polish-loop cost visibility)
//
// writeCostTrace(record, rootDir?) appends a JSON-Lines record to:
//   data/polish-cost-trace-<YYYY-MM-DD>.json
// One file per UTC date, append-mode (creates if missing).
//
// initCostTrace(agentSlug, rootDir?) returns an opts.onCostRecord callback
// that callers pass to callCouncil. The callback fires for each model result
// with the standardized record shape.
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, mkdirSync as _mkdirSync } from 'node:fs';
import { join as _join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _ftu } from 'node:url';

const _COUNCIL_DIR = _dirname(_ftu(import.meta.url));

/**
 * Append a JSON-Lines cost record to data/polish-cost-trace-<YYYY-MM-DD>.json.
 * @param {object} record - { timestamp_iso, agent_slug, model, input_tokens, output_tokens, cost_usd, phase, artifact_slug }
 * @param {string} [rootDir] - project root override (defaults to parent of lib/)
 */
export function writeCostTrace(record, rootDir) {
  try {
    const root = rootDir || _join(_COUNCIL_DIR, '..');
    const date = new Date().toISOString().slice(0, 10);
    const dir = _join(root, 'data');
    _mkdirSync(dir, { recursive: true });
    const path = _join(dir, `polish-cost-trace-${date}.json`);
    appendFileSync(path, JSON.stringify({ ...record, timestamp_iso: record.timestamp_iso || new Date().toISOString() }) + '\n', 'utf-8');
  } catch (_) { /* non-fatal — cost trace is best-effort */ }
}

/**
 * Create an opts.onCostRecord callback bound to a specific agent and project root.
 * Pass the returned callback as opts.onCostRecord when calling callCouncil.
 *
 * Example:
 *   import { initCostTrace } from '../lib/council.mjs';
 *   const onCostRecord = initCostTrace('apply-pack-polish', ROOT);
 *   const result = await callCouncil({ prompt, opts: { onCostRecord } });
 *
 * @param {string} agentSlug - short agent identifier (e.g. 'apply-pack-polish')
 * @param {string} [rootDir] - project root override
 * @returns {function} opts.onCostRecord callback
 */
export function initCostTrace(agentSlug, rootDir) {
  return function onCostRecord(record) {
    writeCostTrace({ ...record, agent_slug: agentSlug }, rootDir);
  };
}

/**
 * Append a paid-action audit-log entry to data/paid-action-log-<YYYY-MM-DD>.jsonl.
 *
 * Theme 6 (2026-05-29) — replaces the cap-refusal pre-flight (cost-distribution
 * Part 2) with per-call audit logging. Per Mitchell's instruction: "remove caps
 * all together - and instead insert warnings before I confirm action".
 *
 * The actual user confirmation lives at the dashboard UI layer; this helper
 * preserves observability of every paid call so spend patterns can be reviewed
 * retroactively. Fire-and-forget — write failures are silently ignored.
 *
 * @param {object} event
 * @param {string} [event.vendor]                       - 'anthropic' | 'openai' | etc.
 * @param {string} event.model                          - provider:model key
 * @param {number} event.estimated_cost_usd             - USD estimate for the upcoming call
 * @param {string} [event.description]                  - what the call is for
 * @param {string} [event.agent_slug]                   - calling agent slug
 * @param {boolean} [event.would_have_blocked_at_cap]   - true when prior-era cap would have refused
 * @param {string} [rootDir]                            - project root override
 */
export function recordPaidAction(event, rootDir) {
  try {
    const root = rootDir || _join(_COUNCIL_DIR, '..');
    const date = new Date().toISOString().slice(0, 10);
    const dir = _join(root, 'data');
    _mkdirSync(dir, { recursive: true });
    const path = _join(dir, `paid-action-log-${date}.jsonl`);
    appendFileSync(path, JSON.stringify({
      timestamp_iso: new Date().toISOString(),
      ...event,
    }) + '\n', 'utf-8');
  } catch (_) { /* non-fatal — audit log is best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-vendor monthly spend tracking (cost-distribution Part 2 [2026-05-25]
// SUPERSEDED by Theme 6 [2026-05-29] — caps are now INFORMATIONAL, not enforced).
//
// Read at call-time from env so tests can mutate process.env and so /deploy-
// verify / launchd can override thresholds without restarting Node.
//
// CAP DEFAULTS — now warn-thresholds, not hard refusals (USD/month):
//   anthropic  — $400 (highest because Sonnet 4.6 + occasional Opus 4.7)
//   openai     — $70  (gpt-5 fallback path; rarely primary post-routing)
//   xai        — $50  (realtime_x_twitter archetype only)
//   perplexity — $50  (long_form_research + deep_research_synthesis)
//   google     — $50  (image_understanding + Gemini Pro for long context)
//
// Theme 6 change (2026-05-29): the previous enforcement at callCouncil's
// pre-flight gate was removed per Mitchell's instruction. checkVendorCap is
// retained for backward-compat + observability (callers can inspect capCheck.ok
// to decide whether to surface a UI warning). When (spend + estCost) would
// exceed the documented threshold, callCouncil now writes a paid-action-log
// entry + emits a stderr WARN, then PROCEEDS with the call. The actual user
// confirmation lives at the dashboard UI cost-confirmation modals; scheduled
// jobs pre-authorize at plist config time.
//
// Override per-vendor via env: COUNCIL_<VENDOR>_MONTHLY_CAP_USD
// Set to 0 to disable cap-checking + warn for that vendor entirely.
//
// Calculation:
//   1. Vendor family inferred from `provider:model` prefix
//      (`anthropic:claude-sonnet-4-6` → 'anthropic').
//   2. Sum `cost_usd` from data/polish-cost-trace-<YYYY-MM-DD>.json across
//      the trailing 30 days, filtering by `model.startsWith('<vendor>:')`.
//   3. If (month_spend + estimated_call_cost) > cap: callCouncil writes audit
//      log + emits stderr WARN, then proceeds (Theme 6, 2026-05-29).
//
// On any read error (missing file, malformed JSON line), the line is skipped
// silently — partial data still gates correctly, and a missing trace dir
// resolves to zero spend (correct semantic for a fresh repo).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-vendor monthly cap defaults. Override via env COUNCIL_<VENDOR>_MONTHLY_CAP_USD.
 */
export const VENDOR_MONTHLY_CAP_DEFAULTS = {
  anthropic:  400,
  openai:      70,
  xai:         50,
  perplexity:  50,
  google:      50,
};

/**
 * Resolve a `provider:model` key to its vendor family.
 * @param {string} modelKey - e.g. 'anthropic:claude-sonnet-4-6'
 * @returns {string|null} vendor family (lowercased) or null
 */
export function vendorFamilyOf(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return null;
  const colon = modelKey.indexOf(':');
  if (colon <= 0) return null;
  return modelKey.slice(0, colon).toLowerCase();
}

/**
 * Read the configured monthly cap for a vendor family.
 * @param {string} vendor - 'anthropic' | 'openai' | 'xai' | 'perplexity' | 'google'
 * @returns {number} cap in USD (0 = disabled)
 */
export function getVendorMonthlyCapUsd(vendor) {
  if (!vendor) return 0;
  const envKey = `COUNCIL_${vendor.toUpperCase()}_MONTHLY_CAP_USD`;
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return VENDOR_MONTHLY_CAP_DEFAULTS[vendor] ?? 0;
}

import { readdirSync as _readdirSync, readFileSync as _readFileSync, existsSync as _existsSync } from 'node:fs';

/**
 * Sum the last 30 days of cost-trace spend for a given vendor family.
 * Reads data/polish-cost-trace-<YYYY-MM-DD>.json (the canonical cost trace
 * shared with the polish loop).
 *
 * Returns 0 on missing dir / no matching trace files / vendor=null.
 *
 * @param {string} vendor - vendor family (lowercased)
 * @param {string} [rootDir] - project root override (defaults to parent of lib/)
 * @returns {number} total spend in USD over the trailing 30 days
 */
export function getVendorMonthlySpendUsd(vendor, rootDir) {
  if (!vendor) return 0;
  try {
    const root = rootDir || _join(_COUNCIL_DIR, '..');
    const dir = _join(root, 'data');
    if (!_existsSync(dir)) return 0;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const files = _readdirSync(dir).filter(f => /^polish-cost-trace-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    let total = 0;
    for (const fname of files) {
      // Quick-reject files older than cutoff based on filename date alone.
      const dateMatch = fname.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const fileDateMs = Date.parse(dateMatch[1] + 'T00:00:00Z');
        if (Number.isFinite(fileDateMs) && fileDateMs < cutoff - 86_400_000) continue;
      }
      let raw;
      try {
        raw = _readFileSync(_join(dir, fname), 'utf-8');
      } catch { continue; }
      const lines = raw.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try { rec = JSON.parse(trimmed); }
        catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        // Filter by vendor prefix on model field.
        const modelKey = rec.model || '';
        if (!modelKey.toLowerCase().startsWith(vendor.toLowerCase() + ':')) continue;
        // Filter by timestamp window (within trailing 30 days).
        const ts = rec.timestamp_iso ? Date.parse(rec.timestamp_iso) : NaN;
        if (Number.isFinite(ts) && ts < cutoff) continue;
        const cost = Number(rec.cost_usd);
        if (Number.isFinite(cost) && cost > 0) total += cost;
      }
    }
    return Math.round(total * 100) / 100;
  } catch (_) {
    return 0;
  }
}

/**
 * checkVendorCap(modelKey, estimatedCallCostUsd, rootDir?) — pre-flight guard.
 *
 * Returns `{ ok: true }` when the cap is disabled (cap === 0) OR when
 * (monthly_spend + estimated_call_cost) ≤ cap. Returns `{ ok: false, ... }`
 * with vendor / month / cap / message fields when the cap would be breached.
 *
 * Callers should refuse on `ok: false`. The standard error message shape used
 * by callCouncil() is:
 *   "COUNCIL_CAP_REACHED: vendor=<v> month=$<n> cap=$<c> — set
 *    COUNCIL_<V>_MONTHLY_CAP_USD higher if intentional"
 *
 * @param {string} modelKey - provider:model key
 * @param {number} [estimatedCallCostUsd] - estimated cost of the upcoming call
 * @param {string} [rootDir] - project root override
 * @returns {object} { ok, vendor, cap, spend, estimated, message? }
 */
export function checkVendorCap(modelKey, estimatedCallCostUsd = 0, rootDir) {
  const vendor = vendorFamilyOf(modelKey);
  if (!vendor) return { ok: true, vendor: null, cap: 0, spend: 0, estimated: estimatedCallCostUsd };
  const cap = getVendorMonthlyCapUsd(vendor);
  if (cap === 0) return { ok: true, vendor, cap: 0, spend: 0, estimated: estimatedCallCostUsd };
  const spend = getVendorMonthlySpendUsd(vendor, rootDir);
  const estimate = Math.max(0, Number(estimatedCallCostUsd) || 0);
  if (spend + estimate > cap) {
    return {
      ok: false,
      vendor, cap, spend, estimated: estimate,
      message: `COUNCIL_CAP_REACHED: vendor=${vendor} month=$${spend.toFixed(2)} cap=$${cap.toFixed(2)} — set COUNCIL_${vendor.toUpperCase()}_MONTHLY_CAP_USD higher if intentional`,
    };
  }
  return { ok: true, vendor, cap, spend, estimated: estimate };
}

/**
 * callCouncil({ prompt, models?, opts? })
 *   prompt:  string sent verbatim to every model
 *   models:  optional array of provider:model keys. When absent, routing falls
 *            back via `opts.taskType` → `routeByArchetype(taskType)` →
 *            DEFAULT_LINEUP. As of 2026-05-25 (cost-distribution Part 2),
 *            the IMPLICIT default is single-vendor (Sonnet 4.6). Pass
 *            `models: COUNCIL_FANOUT_LINEUP` for the pre-2026-05-25 4-vendor
 *            adversarial fan-out behavior. Explicit `models: [...]` always wins.
 *   opts:    { maxTokens, signal, includeMissingKeys=false, onCostRecord?,
 *              taskType?, vendorCapsDisabled? }
 *            opts.taskType — archetype name (e.g. 'voice_match_writing'); used
 *              only when `models` is absent.
 *            opts.vendorCapsDisabled — set true to bypass the per-vendor monthly
 *              cap pre-flight check (e.g. tests, /deploy-verify trusted contexts).
 *            opts.onCostRecord(record) — called once per model result with the
 *              cost-trace record shape. Wire via initCostTrace() for file-backed
 *              logging.
 *
 * Returns { results: [{ model, content, error, tokens, costUsd, ms, modelUsed? }], missingKeys, totalMs }
 * Calls run in parallel with Promise.allSettled — one error never blocks the others.
 */
export async function callCouncil({ prompt, models, opts = {} } = {}) {
  if (!prompt) throw new Error('callCouncil: prompt is required');
  const t0 = Date.now();

  // ─── Persona wiring (Wave 2 Task 5, 2026-05-28) ─────────────────────────
  // When opts.personaName is set, load the persona record from
  // lib/council-personas.mjs and use its systemPrompt + recommendedModel.
  // Caller-supplied `models` takes precedence (caller knows best); persona's
  // recommended model fills in only when models is empty/missing.
  // Caller-supplied opts.systemPrompt is OVERRIDDEN by the persona's prompt
  // (persona invocation means "I want this voice"; mixing prompts is incoherent).
  let resolvedPersona = null;
  if (opts.personaName) {
    // Dynamic import to avoid circular dependency (council-personas.mjs may
    // grow to import from council.mjs in future for self-validation tests).
    const { getPersona } = await import('./council-personas.mjs');
    resolvedPersona = getPersona(opts.personaName);
    if (!resolvedPersona) {
      throw new Error(`callCouncil: unknown personaName '${opts.personaName}'. Use listPersonas() or personaNames() to enumerate valid names.`);
    }
    // Override systemPrompt with persona's
    opts = { ...opts, systemPrompt: resolvedPersona.systemPrompt };
    // Persona's recommended model fills in when caller didn't specify
    if (!models || models.length === 0) {
      models = [resolvedPersona.recommendedModel];
    }
  }
  // ─── End persona wiring ─────────────────────────────────────────────────

  // Resolve target lineup. Precedence (highest wins):
  //   1. Explicit `models: [...]` — always preserved verbatim (caller knows best)
  //   2. opts.taskType present → routeByArchetype(taskType)
  //   3. DEFAULT_LINEUP (single-vendor Sonnet 4.6 post-2026-05-25)
  const wantedModels = (models && models.length)
    ? models
    : routeByArchetype(opts.taskType);

  const missingKeys = [];
  const fireable = wantedModels.filter(name => {
    const provider = PROVIDERS[name];
    if (!provider) return false;
    // Special case: gemini-2.5-flash accepts EITHER GEMINI_FREE_API_KEY (Tier-0
    // free cascade) OR GEMINI_API_KEY (paid). Allow through if either is set.
    if (name === 'google:gemini-2.5-flash') {
      if (process.env.GEMINI_FREE_API_KEY || process.env.GEMINI_API_KEY) return true;
      missingKeys.push({ model: name, missingEnvVar: 'GEMINI_FREE_API_KEY or GEMINI_API_KEY' });
      return false;
    }
    if (!process.env[provider.envKey]) {
      missingKeys.push({ model: name, missingEnvVar: provider.envKey });
      return false;
    }
    return true;
  });

  const tasks = fireable.map(async (name) => {
    // 2026-05-18 (meta-audit v2 P2): Anthropic concurrent-connection limits are
    // historically stricter than OpenAI/Google. With anthropic:claude-sonnet-4-6
    // now in DEFAULT_LINEUP, parallel fan-outs can trigger cascading 429s.
    // Add 0-1500ms jitter for Anthropic slots only; non-Anthropic fire immediately.
    if (name.startsWith('anthropic:')) {
      const jitterMs = Math.random() * 1500;
      await new Promise(r => setTimeout(r, jitterMs));
    }
    const t1 = Date.now();
    const provider = PROVIDERS[name];
    const key = process.env[provider.envKey];

    // Timeout precedence (per OMEGA-proposal-1, approved 2026-05-19; floor
    // lowered from 30s → 1ms 2026-05-23 to support CLI fast-fail smoke tests
    // + reflect that no existing library caller passes <180s):
    //   1. opts.timeoutMs (caller override, e.g. polish loops needing >3min
    //      for Opus adjudication; researcher long-output batches >10min)
    //   2. provider.timeout (per-model default in PROVIDERS registry)
    // Clamped to [1ms, 60min]. Ceiling raised 30min → 60min 2026-07-04 per
    // Mitchell's directive to remove run-time constraints from council runs
    // (quality > speed > cost); the 60min hard ceiling stays as the
    // hang-prevention backstop — never remove it entirely (see AGENTS.md
    // § Bug class: missing-timeout-on-long-running-operation).
    // The `rawOverride > 0` check already rejects zero/negative/NaN; the
    // Math.max(1) only guards sub-millisecond floats. Hoisted out of fireOnce
    // so the catch block below can include effectiveTimeoutMs in friendly
    // timeout-error messages.
    const rawOverride = Number(opts.timeoutMs);
    const overrideTimeoutMs = Number.isFinite(rawOverride) && rawOverride > 0
      ? Math.min(Math.max(rawOverride, 1), 3_600_000)
      : null;
    // opts.timeoutMs can EXTEND beyond the provider default (e.g. long-output
    // batches) but never REDUCES below it — provider timeouts are tuned for
    // each model's characteristics (e.g. sonar-deep-research=480s, gpt-5=180s).
    // The previous `??` let run-council.mjs's 180s CLI default cap deep-research.
    const effectiveTimeoutMs = overrideTimeoutMs != null
      ? Math.max(overrideTimeoutMs, provider.timeout)
      : provider.timeout;

    // Single-attempt firing helper. extraPreamble is appended to the system
    // prompt on the retry; first call uses the default date-anchor only.
    async function fireOnce(extraPreamble = '') {
      const signal = AbortSignal.timeout(effectiveTimeoutMs);
      const baseSys = opts.systemPrompt === undefined ? DATE_ANCHOR_DEFAULT() : opts.systemPrompt;
      const systemPrompt = baseSys + extraPreamble;
      // refresh-master Phase 1.5: opts.cacheStableContent is sent as a
      // cache_control breakpoint to Anthropic adapters (cheap on hit) and
      // prepended to the prompt for non-Anthropic adapters (so they still
      // see the full context). Keeps the cache benefit Anthropic-only without
      // dropping context from other providers.
      // 2026-05-23: array-or-string normalization mirrors anthropicBuildBody.
      let stableForFallback = '';
      if (Array.isArray(opts.cacheStableContent)) {
        stableForFallback = opts.cacheStableContent
          .map((s) => String(s || '').trim())
          .filter((s) => s.length > 0)
          .join('\n\n');
      } else if (opts.cacheStableContent) {
        stableForFallback = String(opts.cacheStableContent).trim();
      }
      const isAnthropic = name.startsWith('anthropic:');
      const effectivePrompt = (stableForFallback && !isAnthropic)
        ? `${stableForFallback}\n\n${prompt}`
        : prompt;
      return await provider.call(effectivePrompt, key, { ...opts, signal, systemPrompt });
    }

    // Per-vendor monthly-spend pre-flight (cost-distribution Part 2 [2026-05-25]
    // SUPERSEDED by Theme 6 [2026-05-29]). No longer ENFORCES — instead writes
    // an audit log of every paid call to data/paid-action-log-<DATE>.jsonl and
    // emits a stderr WARN when the prior-era cap would have been breached. Per
    // Mitchell's Theme 6 instruction: "remove caps all together - and instead
    // insert warnings before I confirm action in the corresponding function".
    // The actual user-facing confirmation lives at the dashboard UI cost-
    // confirmation modals; scheduled jobs pre-authorize at plist config time.
    // Skipped entirely when opts.vendorCapsDisabled is true (rare; reserved
    // for batch-eval / dry-run paths that explicitly opt out of audit logging).
    if (!opts.vendorCapsDisabled) {
      const estTokens = Number(opts.maxTokens) || 3000;
      const estCost = estimateCostUsd(name, estTokens);
      const capCheck = checkVendorCap(name, estCost);
      recordPaidAction({
        vendor: capCheck.vendor,
        model: name,
        estimated_cost_usd: estCost,
        description: opts.taskType || opts.callerLabel || opts.agentSlug || '(unspecified)',
        agent_slug: opts.agentSlug || null,
        would_have_blocked_at_cap: !capCheck.ok,
      });
      if (!capCheck.ok) {
        try {
          process.stderr.write(`[council] WARN: ${name} would have breached prior-era cap (vendor=${capCheck.vendor} month=$${capCheck.spend.toFixed(2)} cap=$${capCheck.cap.toFixed(2)} est=$${estCost.toFixed(4)}) — proceeding per Theme 6 (2026-05-29)\n`);
        } catch { /* never block on stderr */ }
      }
    }

    try {
      let r = await fireOnce();
      let refusalReason = detectRefusal(r.content);
      let retried = false;

      // Refusal auto-retry. Override with opts.retryOnRefusal === false to
      // disable; some callers want raw responses for forensic logging.
      if (refusalReason && opts.retryOnRefusal !== false) {
        retried = true;
        const stronger = [
          '',
          '',
          'IMPORTANT — RETRY CONTEXT:',
          `Your previous response refused on the grounds that the task or year appears fictional/hypothetical/future.`,
          `That refusal was incorrect. The current date and all referenced events ARE real.`,
          `Your orchestrator's system clock confirms today is ${new Date().toISOString().slice(0,10)}.`,
          `Proceed with the actual task. If you cannot verify a specific claim, mark it [UNVERIFIED] inline — do not refuse the whole task again.`,
        ].join('\n');
        r = await fireOnce(stronger);
        refusalReason = detectRefusal(r.content);
      }

      const costUsd = estimateCostUsd(name, r.tokens || 0);
      // High-cost sanity check (added 2026-05-19): emit stderr warning when a
      // single model call exceeds HIGH_COST_WARN_USD. Catches a recurrence of
      // the per-1K-vs-per-1M units bug AND genuine context bloat (e.g. passing
      // a 100K-token finding context). Stderr-only so it never blocks the call.
      if (costUsd > HIGH_COST_WARN_USD) {
        try {
          process.stderr.write(`[council] WARN: ${name} reported $${costUsd.toFixed(2)} for ${r.tokens || 0} tokens — verify cost calc + context size (threshold $${HIGH_COST_WARN_USD})\n`);
        } catch { /* never block on stderr */ }
      }
      const result = {
        model: name,
        content: r.content,
        tokens: r.tokens,
        costUsd,
        citations: r.citations,
        modelUsed: r.modelUsed,
        ms: Date.now() - t1,
        ...(retried ? { jailbreakRetry: true } : {}),
        ...(refusalReason ? { jailbreakRefusal: refusalReason } : {}),
      };
      // Emit cost-trace record if caller wired a handler (Mitchell decision α.2)
      if (typeof opts.onCostRecord === 'function') {
        try {
          opts.onCostRecord({
            timestamp_iso: new Date().toISOString(),
            agent_slug: opts.agentSlug || 'council',
            model: name,
            modelUsed: r.modelUsed || name,
            input_tokens: null,   // not available separately from most providers
            output_tokens: null,  // not available separately from most providers
            total_tokens: r.tokens || 0,
            cost_usd: costUsd,
            phase: opts.phase || null,
            artifact_slug: opts.artifactSlug || null,
          });
        } catch (_) { /* cost trace is best-effort, never block council */ }
      }
      return result;
    } catch (e) {
      const errMsg = String(e?.message || e);
      // AbortSignal.timeout() raises a DOMException with name 'TimeoutError'
      // (Node 18+). Older paths or wrappers can also surface as 'AbortError'
      // or include "aborted"/"timeout" in the message body. Detect both
      // shapes so the friendly hint always fires when it should.
      const isTimeout = e?.name === 'TimeoutError'
        || e?.name === 'AbortError'
        || /\b(timed? ?out|aborted|TimeoutError|AbortError)\b/i.test(errMsg);
      const friendlyErr = isTimeout
        ? `Provider call exceeded ${effectiveTimeoutMs}ms timeout. For long-output tasks (>10k tokens), pass opts.timeoutMs (or --timeout-ms via CLI) >= 900000. Original: ${errMsg}`
        : errMsg;
      return { model: name, content: '', error: friendlyErr, ms: Date.now() - t1, costUsd: 0 };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const results = settled.map(s => s.value || { error: String(s.reason) });
  // Aggregate per-model costUsd into a top-level report — 14 sites across 5
  // files read `r.report.totalCost` for per-call spend tracking
  // (lib/polish-loop.mjs, lib/polish-signals.mjs, scripts/agents/intel-refresh.mjs,
  // scripts/populate-team-health.mjs). Without this aggregate, every site reads
  // undefined and adds 0 to its accumulator — the silent-zero-spend bug
  // surfaced by GAP-RES-03 polish run 2026-05-24.
  const totalCost = results.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);
  const totalTokens = results.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);

  // ─── Persona spend recording (Wave 2 Task 5, 2026-05-28) ────────────────
  // When a persona was resolved at the top, record the call's spend into
  // data/persona-review-spend.jsonl so it sums into V2_BUDGET_USD=$300.
  // Best-effort: a write failure never blocks the council response.
  if (resolvedPersona && totalCost > 0) {
    try {
      const { recordPersonaReviewSpend } = await import('./v2-budget.mjs');
      recordPersonaReviewSpend({
        usd: totalCost,
        persona: resolvedPersona.name,
        phase: opts.personaPhase || 'council-direct',
        label: opts.personaLabel || '',
      });
    } catch { /* spend tracking is observability, never block result */ }
  }
  // ─── End persona spend recording ────────────────────────────────────────

  return {
    results,
    missingKeys,
    totalMs: Date.now() - t0,
    report: {
      totalCost,
      totalTokens,
      modelCount: results.length,
      ...(resolvedPersona ? { persona: resolvedPersona.name, personaPhase: opts.personaPhase || 'council-direct' } : {}),
    },
  };
}

/**
 * probeModelYear(modelName, opts?) — opt-in pre-flight check.
 *
 * Fires a 1-token "What year is it?" probe at one model. Returns the year the
 * model answers with (parsed as integer) plus the raw content. Use to filter
 * out models that hallucinate the year before spending real budget on them.
 *
 * Usage:
 *   import { probeModelYear } from './lib/council.mjs';
 *   const probe = await probeModelYear('xai:grok-4-fast-reasoning');
 *   if (Math.abs(probe.year - new Date().getFullYear()) >= 2) skip();
 */
export async function probeModelYear(modelName, opts = {}) {
  const provider = PROVIDERS[modelName];
  if (!provider) throw new Error(`probeModelYear: unknown model ${modelName}`);
  const key = process.env[provider.envKey];
  if (!key) return { model: modelName, year: null, error: 'missing-env-key' };
  const probePrompt = 'What year is it right now? Reply with only the 4-digit year, no other text.';
  const t0 = Date.now();
  try {
    const signal = AbortSignal.timeout(60_000); // probe-only ceiling
    // Probe goes WITHOUT the date anchor so we measure the model's actual
    // belief, not its compliance with our anchor. systemPrompt: '' disables.
    // maxTokens: 500 with reasoning/thinking forced to minimum is enough for
    // a 4-char year answer across all providers. Without the minimum-reasoning
    // override, reasoning models (gpt-5.5, gemini-3.1-pro-preview at
    // thinking_level=high default, grok-4.3 with always-on extended thinking,
    // sonar-reasoning-pro) consume the entire budget for internal thought and
    // emit empty content.
    //   - thinkingLevel: 'minimal' → Gemini 3.x (rejected by 2.5 fallback; auto-retry)
    //   - reasoningEffort: 'low' → OpenAI GPT-5.5+ (valid: none/low/medium/high/xhigh)
    //   - grounded: false → skip Google Search round-trip (probe measures raw belief)
    //   - systemPrompt: '' → no date anchor (we WANT to measure raw belief)
    // Known limitations: grok-4.3 has no equivalent reasoning-effort knob, so
    // probes against xai:* may still time out on the per-call signal even with
    // a 60s ceiling; that's information too (model is too slow to be useful in
    // the lineup). The probe is OPT-IN via --probe and informational only;
    // the load-bearing mitigations are DATE_ANCHOR_DEFAULT + detectRefusal
    // auto-retry (both always-on), which had a 12/12 success rate on the
    // Phase 4 council run (vs 3-of-3 refusals on phases 1-3 without them).
    const probeSignal = AbortSignal.timeout(60_000); // override the 30s outer
    const r = await provider.call(probePrompt, key, {
      ...opts,
      signal: probeSignal,
      maxTokens: 500,
      systemPrompt: '',
      thinkingLevel: 'minimal',
      reasoningEffort: 'low',
      grounded: false,
    });
    const yearMatch = (r.content || '').match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
    return {
      model: modelName,
      year: yearMatch ? parseInt(yearMatch[1], 10) : null,
      raw: (r.content || '').trim().slice(0, 60),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { model: modelName, year: null, error: String(e.message || e), ms: Date.now() - t0 };
  }
}

/**
 * probeLineup(models?, opts?) — run probeModelYear across all candidate models
 * in parallel. Returns each result plus a `passes` boolean (within 1 year of
 * the actual current year). Cheap (~$0.01 total) and ~2-5s wall-clock.
 */
export async function probeLineup(models, opts = {}) {
  const candidates = (models && models.length) ? models : DEFAULT_LINEUP;
  const currentYear = new Date().getFullYear();
  const tolerance = opts.tolerance ?? 1;
  const probes = await Promise.all(candidates.map(m => probeModelYear(m, opts)));
  return probes.map(p => ({
    ...p,
    passes: p.year !== null && Math.abs(p.year - currentYear) <= tolerance,
    expectedYear: currentYear,
  }));
}

/**
 * Convenience: call council, return only succeeded responses sorted by model name.
 */
export async function council(prompt, opts = {}) {
  const { results } = await callCouncil({ prompt, opts });
  return results.filter(r => !r.error).sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * extractRichContent(result) — normalize a council result into a stable
 * rich-content shape that downstream consumers can rely on.
 *
 * Added 2026-05-18 (meta-audit v2 P0 #1): when new fields are added to the
 * raw provider response (e.g., `think` from sonar-reasoning-pro,
 * `grounding_urls` from Gemini), consumers that destructure the raw result
 * silently drop them. This helper provides a single normalization point so
 * future field additions don't require updating every downstream consumer.
 *
 * Returns: { content, think, citations, grounding_urls, modelUsed, tokens, ms, error }
 * — all fields have safe defaults (empty string / empty array / 0).
 *
 * Usage:
 *   import { extractRichContent } from '../lib/council.mjs';
 *   const { content, think, citations, grounding_urls } = extractRichContent(r);
 *   if (think) console.log('Reasoning trace:', think);
 *   if (grounding_urls.length) console.log('Grounded sources:', grounding_urls);
 */
export function extractRichContent(result) {
  if (!result || typeof result !== 'object') {
    return { content: '', think: '', citations: [], grounding_urls: [], thoughtSignatures: [], modelTurnParts: [], modelUsed: 'unknown', tokens: 0, ms: 0, error: 'invalid result' };
  }
  return {
    content: result.content || '',
    think: result.think || '',
    citations: Array.isArray(result.citations) ? result.citations : [],
    grounding_urls: Array.isArray(result.grounding_urls) ? result.grounding_urls : [],
    // G24 (2026-05-24): surface Gemini thoughtSignatures + modelTurnParts on the
    // normalized rich-content shape so future multi-turn callers can reconstruct
    // priorTurns. Always defined as arrays for clean destructuring; empty for
    // non-Gemini results.
    thoughtSignatures: Array.isArray(result.thoughtSignatures) ? result.thoughtSignatures : [],
    modelTurnParts: Array.isArray(result.modelTurnParts) ? result.modelTurnParts : [],
    modelUsed: result.modelUsed || result.model || 'unknown',
    tokens: typeof result.tokens === 'number' ? result.tokens : 0,
    ms: typeof result.ms === 'number' ? result.ms : 0,
    error: result.error,
  };
}

/**
 * Pretty-print council results to stdout.
 */
export function printCouncil(report) {
  const { results, missingKeys, totalMs } = report;
  console.log(`\n=== Council results (${totalMs}ms total) ===`);
  for (const r of results) {
    if (r.error) {
      console.log(`\n[${r.model}]  ❌  (${r.ms}ms)\n  ${r.error}`);
    } else {
      console.log(`\n[${r.model}]  ✅  (${r.ms}ms, ${r.tokens} tok${r.modelUsed ? `, used: ${r.modelUsed}` : ''})\n${r.content.slice(0, 600)}${r.content.length > 600 ? '\n  ...' : ''}`);
    }
  }
  if (missingKeys.length) {
    console.log(`\nSkipped (missing env keys):`);
    missingKeys.forEach(m => console.log(`  - ${m.model} (needs ${m.missingEnvVar})`));
  }
}

// CLI: node lib/council.mjs [--timeout-ms <ms>] [--help] "your prompt"
//
// --timeout-ms <ms>  Per-call hard ceiling in milliseconds. Default 600000
//                    (10 min) — comfortable for large-JSON output batches.
//                    Range honored: 1ms - 3600000 (60 min). For long-output
//                    tasks (>10k output tokens) pass 900000 or higher.
// --help, -h         Show usage.
//
// Added 2026-05-23 after the researcher subagent 2026-05-23 02:10 PT
// vocab-corpus build stalled — 5 dispatched calls all timed out at the
// per-model 240s default because opts.timeoutMs, while plumbed end-to-end
// internally, was unreachable from the CLI surface until now.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let timeoutMs = 600_000;
  const promptParts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      console.log([
        'Usage: node lib/council.mjs [--timeout-ms <ms>] [--help] "your prompt"',
        '',
        'Options:',
        '  --timeout-ms <ms>   Per-call hard ceiling (1 - 3600000 ms).',
        '                      Default 600000 (10 min). For >10k output',
        '                      tokens pass 900000 or higher.',
        '  --help, -h          Show this message.',
        '',
        'Default model lineup: ' + DEFAULT_LINEUP.join(', '),
        '',
        'Example:',
        '  node lib/council.mjs --timeout-ms 900000 "Summarize the corpus..."',
      ].join('\n'));
      process.exit(0);
    }
    if (a === '--timeout-ms') {
      const raw = args[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`error: --timeout-ms requires a positive number; got "${raw}"`);
        process.exit(2);
      }
      timeoutMs = v;
      continue;
    }
    promptParts.push(a);
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    console.error('Usage: node lib/council.mjs [--timeout-ms <ms>] "your prompt"  (--help for full options)');
    process.exit(1);
  }
  callCouncil({ prompt, opts: { timeoutMs } }).then(printCouncil).catch(e => { console.error(e); process.exit(1); });
}
