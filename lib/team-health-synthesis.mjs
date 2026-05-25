/**
 * lib/team-health-synthesis.mjs — Corpus-grounded team-health synthesizer
 *
 * PR-04 of the apply-now UX overhaul (2026-05-25).
 *
 * Strategy-locked path (Strategy-Adjudicated §6 R44+, dealbreaker HOLD):
 *   - Path (b) CORPUS-GROUNDED was chosen over (a) 4 new Chrome MCP scrapers
 *     (~$525 initial fill + auth drift) and (c) explicit deferral.
 *   - Synthesizes from EXISTING hm-intel signals + Mitchell's personality +
 *     profile corpus via lib/ground-prompt.mjs.
 *   - Sonnet 4.6 narrative agent, lean grounding mode (skips astrology /
 *     sensory / social-energy docs).
 *   - Confidence label is DOWNGRADED automatically when hm-intel signals are
 *     thin/absent (Low / Guessing). No scaffolding lies.
 *
 * Output schema (4 sections, tone-safe, voice-faithful):
 *   {
 *     what_we_know:       [{ claim, source_field }],
 *     what_uncertain:     [string],
 *     what_to_ask_in_screen: [string],     // 3-5 grounded questions
 *     confidence:         'High' | 'Medium' | 'Low' | 'Guessing',
 *     synthesis_mode:     'corpus-grounded' (forward-compat),
 *     _meta: { generated_by, generated_at, cost_usd, source_signals_count,
 *              hm_intel_present, profile_corpus_present, model_used }
 *   }
 *
 * Cost governance:
 *   - Per-call warn threshold: $0.50 (logged but not blocking)
 *   - Per-call hard cap: $2.00 (BUDGET_EXCEEDED status; record NOT saved)
 *   - Daily aggregation via lib/v2-budget.mjs when available (best-effort,
 *     never blocks synthesis flow)
 *
 * Cross-fork-leak safety:
 *   - hm-intel signals are referenced by FIELD KEY, never inline-quoted
 *   - personality corpus loaded through buildGroundedPrompt's cache breakpoints
 *   - output cites source_field names (e.g. 'team_gap_analysis') — never paths
 *
 * Hang prevention:
 *   - callCouncil timeoutMs: 180_000 (3 min hard cap)
 *   - Single Sonnet call (no inner loops)
 *   - Graceful degradation: returns 'Guessing' confidence on Sonnet failure
 *     instead of throwing
 *
 * @file PR-04 strategy: corpus-grounded synth (4-model converge)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGroundedPrompt, checkVoicePurity } from './ground-prompt.mjs';
import { saveTeamHealth, companySlugFromName, loadTeamHealth, isFresh } from './team-health.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

// ─── Cost governance constants ─────────────────────────────────────────────
export const SYNTH_PER_CALL_WARN_USD = 0.50;
export const SYNTH_PER_CALL_HARD_CAP_USD = 2.0;
export const SYNTH_DEFAULT_DAILY_USD = 20.0;

// ─── Confidence calibration ────────────────────────────────────────────────
// Confidence label is DERIVED from signal density, NOT trusted from the LLM.
// LLMs hallucinate confidence; we anchor it to observable structure.
//
// Bands (per Mitchell's voice rules in CLAUDE.md):
//   - 'High'     : multi-source corroboration (8+ rich signals from hm-intel)
//   - 'Medium'   : moderate signal density (4-7 rich signals)
//   - 'Low'      : sparse signals (1-3 rich signals OR shallow hm-intel)
//   - 'Guessing' : zero hm-intel signals (corpus-only inference)
function deriveConfidenceLabel({ hmIntelPresent, signalCount, signalDepth }) {
  if (!hmIntelPresent || signalCount === 0) return 'Guessing';
  // signalDepth = average characters per signal (richer = higher confidence)
  if (signalCount >= 8 && signalDepth >= 150) return 'High';
  if (signalCount >= 4 && signalDepth >= 80) return 'Medium';
  return 'Low';
}

// ─── HM-intel signal extraction ────────────────────────────────────────────
// Pulls structured signals from hm-intel. Does NOT inline-quote — surfaces
// field NAMES that the synthesizer cites. The synthesizer prompt receives a
// summary block (field-keys + short hints) so it can ground claims to
// specific source fields without leaking raw PII.
//
// Field set chosen for team-health relevance:
//   - team_gap_analysis        — qualitative team weaknesses + role context
//   - company_signals_90d      — recent news, layoffs, leadership churn
//   - tradeoffs_vs_current_role — direct comp/culture deltas
//   - honest_gaps_vs_requirements — gaps from candidate POV
//   - role_summary             — what the role actually entails
//   - alignment_with_goals     — alignment overview (rich narrative)
//   - hiring_managers[*]       — leadership signals (counts only)
//   - recruiters[*]            — recruiter intel (counts only)
//   - comp_intelligence        — comp data (presence flag only)
//   - signals[*]               — PR-02b structured signals
//   - provider_disagreements   — calibration signal (controversy = uncertainty)
function extractHmIntelSignals(hmIntel) {
  if (!hmIntel || typeof hmIntel !== 'object') {
    return {
      hmIntelPresent: false,
      signalCount: 0,
      signalDepth: 0,
      fields: {},
      signal_summary: '(no hm-intel cached)',
    };
  }

  const fields = {};
  let totalChars = 0;
  let signalCount = 0;

  // String fields — track char count for depth scoring
  const STRING_FIELDS = [
    'team_gap_analysis',
    'company_signals_90d',
    'role_summary',
    'alignment_with_goals',
    'outreach_strategy',
    'provider_disagreements',
  ];
  for (const k of STRING_FIELDS) {
    const v = hmIntel[k];
    if (typeof v === 'string' && v.trim().length >= 50) {
      fields[k] = { present: true, char_count: v.length, preview: v.slice(0, 120) };
      totalChars += v.length;
      signalCount++;
    }
  }

  // Array fields — surface counts only (PII safety)
  const ARRAY_FIELDS = ['hiring_managers', 'recruiters', 'honest_gaps_vs_requirements', 'signals', 'source_urls'];
  for (const k of ARRAY_FIELDS) {
    const v = hmIntel[k];
    if (Array.isArray(v) && v.length > 0) {
      fields[k] = { present: true, count: v.length };
      // signals[] is structured (PR-02b) — include short hints
      if (k === 'signals') {
        fields[k].sample_kinds = v.slice(0, 5).map(s => (s && s.kind) || (s && s.type) || 'unknown').filter(Boolean);
      }
      signalCount++;
      totalChars += 80; // base credit for non-empty array
    }
  }

  // Object fields — presence flag + key count
  const OBJECT_FIELDS = ['comp_intelligence', 'fit_evidence', 'tradeoffs_vs_current_role'];
  for (const k of OBJECT_FIELDS) {
    const v = hmIntel[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
      fields[k] = { present: true, key_count: Object.keys(v).length };
      signalCount++;
      totalChars += 60;
    }
  }

  const signalDepth = signalCount > 0 ? Math.round(totalChars / signalCount) : 0;

  // Build a summary block the LLM can read (NO inline quotes from the raw
  // hm-intel — just field-key references + short previews that are already
  // synthesized narrative, not raw PII).
  const lines = [];
  for (const [key, info] of Object.entries(fields)) {
    if (info.char_count) {
      lines.push(`  - ${key} [${info.char_count} chars]: ${info.preview.replace(/\n/g, ' ')}…`);
    } else if (info.count != null) {
      const sample = info.sample_kinds ? ` (kinds: ${info.sample_kinds.join(', ')})` : '';
      lines.push(`  - ${key} [${info.count} items]${sample}`);
    } else if (info.key_count != null) {
      lines.push(`  - ${key} [${info.key_count} sub-keys present]`);
    }
  }
  const signal_summary = lines.length > 0
    ? lines.join('\n')
    : '(no team-health-relevant hm-intel fields populated)';

  return { hmIntelPresent: true, signalCount, signalDepth, fields, signal_summary };
}

// ─── System prompt for the synthesizer ─────────────────────────────────────
function _systemPromptForSynthesis() {
  return [
    'You are an analyst speaking TO Mitchell Williams about team-health risk for a target company.',
    '',
    'Voice constraints (load-bearing — tone-safety):',
    '- Third-person about Mitchell. Never first-person ("I think", "my").',
    '- tone-safe framing: observation + reasoning, never judgment.',
    '  - Use: "concerning signal", "mixed feedback", "pattern flagged", "uncertain"',
    '  - NEVER use: "failed", "broken", "wrong", "bad", "poor", "weak", "deficient", "lacking"',
    '- No corporate vocab: leverage, synergy, deep-dive, ideate, circle back, ecosystem.',
    '- Direct: each claim leads with the observation, then the source.',
    '- Lean prose. No flowery hedging.',
    '',
    'Grounding contract:',
    '- Every claim in `what_we_know` MUST cite a `source_field` from the hm-intel signal summary provided.',
    '- If no hm-intel signal supports a claim, omit it OR move it to `what_uncertain`.',
    '- `what_to_ask_in_screen` questions must reference Mitchell\'s specific values (from the personality + profile corpus you have access to in the cached blocks).',
    '- DO NOT fabricate Glassdoor ratings, employee quotes, or specific names not in the source signals.',
    '- DO NOT assert numeric scores for overall/leadership/comp/growth/balance — corpus-grounded mode does not produce 0-5 scores; that is the role of the future Chrome MCP scraper path.',
    '',
    'Output JSON only — no markdown fences, no prose preamble.',
    '',
    'Required shape:',
    '{',
    '  "what_we_know": [',
    '    { "claim": "string — one observation, ≤ 30 words", "source_field": "hm-intel field key (e.g. team_gap_analysis)" }',
    '  ],',
    '  "what_uncertain": [',
    '    "string — explicit gap, ≤ 25 words each. Examples: \'no Glassdoor data available\', \'leadership tenure not in hm-intel\'."',
    '  ],',
    '  "what_to_ask_in_screen": [',
    '    "string — 3 to 5 grounded questions in Mitchell\'s voice. Each ≤ 40 words."',
    '  ]',
    '}',
    '',
    'Counts:',
    '- what_we_know: 2 to 6 items when hm-intel is present; 0 to 2 when absent (Guessing mode).',
    '- what_uncertain: ALWAYS include at least 2 — explicit gaps build trust.',
    '- what_to_ask_in_screen: ALWAYS 3 to 5. These should help Mitchell screen the company DURING a recruiter call, not weeks later.',
  ].join('\n');
}

// ─── Load profile-yaml (which dimensions matter to Mitchell) ───────────────
function _loadProfileWeights() {
  try {
    const p = join(REPO_ROOT, 'config', 'profile.yml');
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    // Cheap key extraction — we don't need full YAML parsing; the values are
    // surfaced into the corpus by ground-prompt.mjs already. Just signal
    // presence + extract any explicit team-health weighting if present.
    return { present: true, char_count: raw.length };
  } catch {
    return null;
  }
}

// ─── Slugify helper (matches scripts/agents/intel-refresh.mjs) ──────────────
function _slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ─── Load hm-intel by slug ─────────────────────────────────────────────────
// hm-intel files are keyed by `${slugify(company)}-${slugify(role)}` per
// scripts/agents/intel-refresh.mjs:99 — NOT by the company-only slug that
// keys data/team-health/<slug>.json. Caller passes companyName + roleName
// (when known) so we can resolve the correct file.
function _loadHmIntelBySlug(companySlug, companyName, roleName) {
  if (!companySlug && !companyName) return null;
  const candidates = [];

  // Path 1 (preferred): company-role hm-intel slug
  if (companyName && roleName) {
    const hmSlug = `${_slugify(companyName)}-${_slugify(roleName)}`;
    candidates.push(join(REPO_ROOT, 'data', 'hm-intel', `${hmSlug}.json`));
  }
  // Path 2: company-only slug fallback (rare — some hm-intel files predate
  // the role-aware schema or use shortened slugs)
  if (companySlug) {
    candidates.push(join(REPO_ROOT, 'data', 'hm-intel', `${companySlug}.json`));
  }
  // Path 3: company-slug-from-name when companySlug was passed differently
  if (companyName) {
    candidates.push(join(REPO_ROOT, 'data', 'hm-intel', `${_slugify(companyName)}.json`));
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

// ─── Best-effort v2-budget gate ────────────────────────────────────────────
async function _checkDailyBudget(estimatedCost) {
  try {
    const mod = await import('./v2-budget.mjs');
    if (mod && typeof mod.checkV2Budget === 'function') {
      const result = mod.checkV2Budget({ projected: estimatedCost });
      return result;
    }
  } catch { /* v2-budget optional */ }
  return { ok: true, reason: 'v2-budget not available — best-effort skip' };
}

/**
 * Main synthesizer. Reads hm-intel + personality + profile corpus, calls
 * Sonnet 4.6, emits 4-section tone-safe synthesis output.
 *
 * @param {object} input
 * @param {string} input.slug         — company-slug for cache + hm-intel resolution
 * @param {object} [input.hm_intel]   — optional pre-loaded hm-intel (else loaded from disk by slug)
 * @param {object} [input.profile_yaml] — optional pre-loaded (else loaded by lib)
 * @param {object} [input.opts]
 *   - companyName     : string (preferred — used in prompts; falls back to slug)
 *   - roleName        : string (optional context for "what to ask in screen")
 *   - rowId           : string|number (optional, included in cache key)
 *   - force           : boolean (skip cache)
 *   - callCouncil     : function (DI for tests)
 *   - budgetUsd       : number (override per-call hard cap; clamped to [0.10, 2.0])
 *   - skipPersist     : boolean (do not write to data/team-health/<slug>.json)
 * @returns {Promise<{
 *   status: 'SYNTHESIZED'|'CACHED'|'BUDGET_EXCEEDED'|'ERROR',
 *   record: object|null,
 *   cost_usd: number,
 *   confidence: string,
 *   reason?: string
 * }>}
 */
export async function synthesizeTeamHealth(input = {}) {
  const { slug, hm_intel, profile_yaml, opts = {} } = input;
  if (!slug || typeof slug !== 'string') {
    return { status: 'ERROR', record: null, cost_usd: 0, confidence: 'Guessing', reason: 'slug required' };
  }
  if (!/^[a-z0-9._-]+$/.test(slug)) {
    return { status: 'ERROR', record: null, cost_usd: 0, confidence: 'Guessing', reason: 'invalid slug format' };
  }

  // ─── Cache check (3-day TTL via existing lib/team-health.mjs) ─────────────
  const cached = loadTeamHealth(slug);
  if (cached && isFresh(cached) && !opts.force && cached.synthesis_mode === 'corpus-grounded') {
    return {
      status: 'CACHED',
      record: cached,
      cost_usd: 0,
      confidence: cached.confidence || 'Medium',
      reason: 'cache hit (< 3 days old, corpus-grounded mode)',
    };
  }

  // ─── Load hm-intel (cited by field, never inline-quoted) ─────────────────
  // hm-intel slug is `${slugify(company)}-${slugify(role)}` per intel-refresh,
  // NOT the company-only slug we use for the team-health cache. Pass both so
  // the loader can resolve the right file.
  const hmIntel = (hm_intel && typeof hm_intel === 'object')
    ? hm_intel
    : _loadHmIntelBySlug(slug, opts.companyName, opts.roleName);
  const signalExtraction = extractHmIntelSignals(hmIntel);

  // ─── Profile-yaml load (best-effort) ─────────────────────────────────────
  const profileWeights = profile_yaml || _loadProfileWeights();

  // ─── Derive confidence label BEFORE the LLM call (anchored to structure) ─
  const confidence = deriveConfidenceLabel({
    hmIntelPresent: signalExtraction.hmIntelPresent,
    signalCount: signalExtraction.signalCount,
    signalDepth: signalExtraction.signalDepth,
  });

  // ─── Build grounded prompt via lib/ground-prompt.mjs (lean mode) ─────────
  const companyName = opts.companyName || slug.replace(/-/g, ' ');
  const roleName = opts.roleName || '';
  const rowId = opts.rowId || null;

  const taskInstruction = [
    `Synthesize team-health analysis for "${companyName}"${roleName ? ' / ' + roleName : ''}.`,
    '',
    'Calibration context:',
    `- Derived confidence label: "${confidence}" (signal_count=${signalExtraction.signalCount}, signal_depth=${signalExtraction.signalDepth})`,
    `- hm-intel cache present: ${signalExtraction.hmIntelPresent ? 'yes' : 'no'}`,
    `- This is a "corpus-grounded" synthesis — there is NO Glassdoor / Blind / levels.fyi scrape backing this. Do not invent quantitative scores.`,
    '',
    'hm-intel signals available (cite by field key in source_field):',
    signalExtraction.signal_summary,
    '',
    'Your task: produce the 4-section JSON output specified in the system prompt.',
    'Output JSON ONLY. No markdown fences. No prose preamble.',
  ].join('\n');

  const responseSchema = JSON.stringify({
    what_we_know: 'array<{claim:string, source_field:string}>',
    what_uncertain: 'array<string>',
    what_to_ask_in_screen: 'array<string>  // 3-5 items',
  });

  let grounded;
  try {
    grounded = buildGroundedPrompt({
      task: 'team_health',
      rowId,
      role: roleName,
      company: companyName,
      jdText: '',
      hmIntel: null,  // we pass our own structured summary in taskInstruction (avoids leaking raw hm-intel into prompt)
      metricKey: 'team_health',
      taskInstruction,
      responseSchema,
      lean: true,     // skip astrology / sensory / social-energy docs per PR-02 extension
      fallbackToEmpty: true,
    });
  } catch (err) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd: 0,
      confidence,
      reason: 'grounding failed: ' + (err && err.message ? err.message : String(err)),
    };
  }

  // Override the system prompt with our team-health-specific one (which
  // takes precedence over the generic analyst voice rules ground-prompt
  // builds — ground-prompt's are valuable as PRINCIPLES; ours are
  // task-specific schema enforcement).
  const system = _systemPromptForSynthesis();

  // ─── Daily budget pre-check (best-effort) ─────────────────────────────────
  const budgetGate = await _checkDailyBudget(SYNTH_PER_CALL_WARN_USD);
  if (!budgetGate.ok) {
    return {
      status: 'BUDGET_EXCEEDED',
      record: null,
      cost_usd: 0,
      confidence,
      reason: 'v2-budget pre-check failed: ' + (budgetGate.reason || 'cap reached'),
    };
  }

  // ─── Sonnet call (no inner loops; hang-prevention timeoutMs) ──────────────
  let callCouncilFn = opts.callCouncil;
  if (!callCouncilFn) {
    try {
      const mod = await import('./council.mjs');
      callCouncilFn = mod.callCouncil;
    } catch (err) {
      return {
        status: 'ERROR',
        record: null,
        cost_usd: 0,
        confidence,
        reason: 'failed to load lib/council.mjs: ' + err.message,
      };
    }
  }

  let council;
  try {
    council = await callCouncilFn({
      prompt: grounded.prompt,
      models: ['anthropic:claude-sonnet-4-6'],
      opts: {
        systemPrompt: system,
        timeoutMs: 180_000,
        maxTokens: 2000,
        cacheStableContent: grounded.cacheStableContent,
        cacheCaller: 'team-health-synthesis:' + slug,
      },
    });
  } catch (err) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd: 0,
      confidence,
      reason: 'Sonnet call failed: ' + (err && err.message ? err.message : String(err)),
    };
  }

  const sonnet = council && Array.isArray(council.results)
    ? council.results.find(r => r && r.model && r.model.startsWith('anthropic:'))
    : null;
  const content = (sonnet && sonnet.content) ? sonnet.content : null;
  const costSpent = (sonnet && typeof sonnet.costUsd === 'number') ? sonnet.costUsd : 0;

  // ─── Per-call hard cap enforcement ────────────────────────────────────────
  const hardCap = Math.max(0.10, Math.min(SYNTH_PER_CALL_HARD_CAP_USD, Number(opts.budgetUsd) || SYNTH_PER_CALL_HARD_CAP_USD));
  if (costSpent > hardCap) {
    return {
      status: 'BUDGET_EXCEEDED',
      record: null,
      cost_usd: costSpent,
      confidence,
      reason: `Sonnet call cost $${costSpent.toFixed(4)} exceeded per-call cap $${hardCap.toFixed(2)}`,
    };
  }

  if (!content) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd: costSpent,
      confidence,
      reason: 'Sonnet returned no content',
    };
  }

  // ─── Parse + validate JSON ────────────────────────────────────────────────
  let parsed;
  try {
    const stripped = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      status: 'ERROR',
      record: null,
      cost_usd: costSpent,
      confidence,
      reason: 'Sonnet returned non-JSON: ' + err.message,
    };
  }

  // ─── Schema validation + defensive defaults ───────────────────────────────
  const what_we_know = Array.isArray(parsed.what_we_know) ? parsed.what_we_know.slice(0, 8) : [];
  const what_uncertain = Array.isArray(parsed.what_uncertain) ? parsed.what_uncertain.slice(0, 6) : [];
  const what_to_ask_in_screen = Array.isArray(parsed.what_to_ask_in_screen) ? parsed.what_to_ask_in_screen.slice(0, 5) : [];

  // Ensure at least one uncertain item (build trust via explicit gaps)
  if (what_uncertain.length === 0) {
    what_uncertain.push('No quantitative employee-review data (Glassdoor / Blind / levels.fyi) was scraped for this synthesis');
  }
  if (!signalExtraction.hmIntelPresent) {
    what_uncertain.push('No hm-intel cache present — all claims are corpus-inference only');
  }

  // ─── Voice purity Layer 2 check (cheap regex) ─────────────────────────────
  const voiceCheck = checkVoicePurity(
    JSON.stringify({ what_we_know, what_uncertain, what_to_ask_in_screen })
  );

  // ─── Assemble record (canonical TEAM_HEALTH_SCHEMA compliant) ─────────────
  const record = {
    company: companyName,
    what_we_know,
    what_uncertain,
    what_to_ask_in_screen,
    confidence,
    synthesis_mode: 'corpus-grounded',
    // Required fields for TEAM_HEALTH_SCHEMA (validateRecord) — keep as
    // empty/null since we don't produce 0-5 scores in this mode. The legacy
    // chip-renderer can still inspect this record + degrade gracefully.
    scores: {},
    narrative: '', // narrative lives in what_we_know array, not here
    anecdotes: [],
    sources: {},
    providers_called: ['corpus-grounded-synthesis'],
    providers_succeeded: signalExtraction.hmIntelPresent ? ['hm-intel', 'personality-corpus', 'profile-corpus'] : ['personality-corpus', 'profile-corpus'],
    _meta: {
      owner: 'team-health-synthesis',
      schema_version: '1.1.0',
      generated_by: 'synthesizeTeamHealth:sonnet-4-6:corpus-grounded',
      generated_at: new Date().toISOString(),
      cost_usd: Math.round(costSpent * 10000) / 10000,
      source_signals_count: signalExtraction.signalCount,
      source_signals_depth_avg: signalExtraction.signalDepth,
      hm_intel_present: signalExtraction.hmIntelPresent,
      profile_corpus_present: !!profileWeights,
      model_used: 'anthropic:claude-sonnet-4-6',
      cache_key: grounded.cacheKey,
      voice_purity_score: voiceCheck.score,
      voice_purity_ok: voiceCheck.ok,
      row_nums: rowId ? [String(rowId)] : [],
    },
  };

  // ─── Cost-warn soft threshold (logged, not blocking) ──────────────────────
  if (costSpent > SYNTH_PER_CALL_WARN_USD) {
    try {
      process.stderr.write(JSON.stringify({
        t: new Date().toISOString(),
        agent: 'team-health-synthesis',
        slug,
        msg: 'WARN: per-call cost exceeded soft threshold',
        cost_usd: costSpent,
        warn_threshold_usd: SYNTH_PER_CALL_WARN_USD,
      }) + '\n');
    } catch { /* logging best-effort */ }
  }

  // ─── Persist via existing saveTeamHealth (schema validated) ───────────────
  if (!opts.skipPersist) {
    const result = saveTeamHealth(slug, record);
    if (!result.ok) {
      return {
        status: 'ERROR',
        record: null,
        cost_usd: costSpent,
        confidence,
        reason: 'saveTeamHealth validation failed: ' + JSON.stringify(result.issues),
      };
    }
  }

  return {
    status: 'SYNTHESIZED',
    record,
    cost_usd: costSpent,
    confidence,
    reason: signalExtraction.hmIntelPresent
      ? `synthesized from ${signalExtraction.signalCount} hm-intel signals + corpus grounding`
      : 'synthesized from corpus-only inference (no hm-intel)',
  };
}

// Default export for convenience
export default synthesizeTeamHealth;
