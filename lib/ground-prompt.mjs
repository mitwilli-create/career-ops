// lib/ground-prompt.mjs — Reusable RAG primitive for personality-grounded LLM prompts.
//
// Ships per council adjudicated design 2026-05-23 + Mitchell's 4 sign-off picks:
//   Q1: Hybrid cacheKey — mtime in key (fast), SHA-256 content_hash in metadata (collision-detect)
//   Q2: 3 cache breakpoints — system + personality + profile (dynamic stays uncached)
//   Q3: Layer 3 voice classifier callable on cache-write only (cost-optimal)
//   Q4: Per-task default for 6th personality doc in lean mode
//
// Output voice: third-person analyst speaking TO Mitchell about him — NOT first-person Mitchell self-talk.
// Rollback: env var STRATEGY_CEILING_GROUNDED_MODE=0 returns the legacy (no-grounding) prompt shape.
//
// Designed for migration order: intel-refresh.mjs → strategy-ceiling.mjs + dashboard-server.mjs:7505 →
//   hm-chance.mjs → apply-pack-polish.mjs → write-side popout scripts.
//
// Counter-bug: env-shadow on launchd-spawned daemons. Callers should ensure dotenv is loaded
// with override:true at process start (see AGENTS.md § env-shadow-on-lazy-dotenv).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PERSONALITY_DIR = join(ROOT, 'data', 'second-brain-extracted', 'second brain');

// Per-task default for the 6th personality doc when lean mode fires (Q4).
// Lean mode kicks in when full-corpus latency exceeds 12s.
const PER_TASK_LEAN_SIXTH = {
  alignment:    'personality-strengths-profile.md',
  interview:    'personality-strengths-profile.md',
  hmNoticing:   'personality-decision-making.md',
  hm_chance:    'personality-decision-making.md',
  team_health:  'personality-values-motivations.md',
};

// Always-include personality docs (lean + full modes both load these)
const ALWAYS_PERSONALITY = [
  'personality-emotional-architecture.md', // tone-safety swap table (load-bearing for voice)
  'personality-communication-style.md',    // DISC DI + banned-vocab + voice rules
];

// Personality docs to drop FIRST in lean mode (per council rec)
const LEAN_DROP_FIRST = new Set([
  'personality-astrology-natal-chart.md',
  'personality-astrology-timing-periods.md',
  'personality-sensory-preferences.md',
  'personality-social-energy.md',
]);

// Voice-purity regex families (Q3 Layer 2 — runs always, cheap)
// Higher weight = bigger penalty score.
const VOICE_PURITY_RULES = [
  { name: 'first-person-mitchell',   weight: 3, re: /\b(?:I (?:think|feel|believe|want|would|will|should|can|cannot|don't|do not)|my fit|my background|my strengths|my weaknesses|looking at this role I|in my view|from my perspective)\b/gi },
  { name: 'rsd-unsafe-language',     weight: 3, re: /\b(?:failed|broken|wrong|bad|poor|weak|deficient|lacking)\b/gi },
  { name: 'banned-corporate-vocab',  weight: 1, re: /\b(?:leverage|synergy|deep[ -]dive|ideate|circle back|touch base|bandwidth|moving forward|reach out)\b/gi },
  { name: 'em-dash',                 weight: 1, re: /—/g },  // 2026-06-13: em dashes are an AI tell, banned even in rendered dashboard analysis (feedback_no_em_dashes_in_materials)
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a grounded prompt + cache configuration for an LLM call.
 *
 * @param {object} config
 * @param {string} config.task          — task identifier (alignment | interview | hmNoticing | hm_chance | team_health | <custom>)
 * @param {string|number} config.rowId  — application row ID (cache-key disambiguator)
 * @param {string} [config.role='']     — job role title
 * @param {string} [config.company='']  — company name
 * @param {string} [config.jdText='']   — raw JD text (will be trimmed to 3000 chars)
 * @param {object|null} [config.hmIntel=null]         — hiring-manager intel JSON
 * @param {object|null} [config.roleEnrichment=null]  — role-enrichment JSON
 * @param {string} [config.metricKey]                 — defaults to task
 * @param {number|null} [config.currentValue=null]    — current metric value (0-100)
 * @param {string} [config.taskInstruction]           — task-specific instruction (default built from task)
 * @param {string} [config.responseSchema]            — JSON schema text for response
 * @param {boolean} [config.lean=false]               — force lean-corpus mode
 * @param {boolean} [config.fallbackToEmpty=false]    — return empty grounding instead of throwing when corpus missing (PR-02 R8: agents shouldn't crash on iCloud-not-synced)
 * @returns {{prompt: string, system: string, cacheStableContent: string[], cacheKey: string, metadata: object}}
 */
export function buildGroundedPrompt(config) {
  const {
    task,
    rowId,
    role = '',
    company = '',
    jdText = '',
    hmIntel = null,
    roleEnrichment = null,
    metricKey = config.task,
    currentValue = null,
    taskInstruction = null,
    responseSchema = null,
    lean = false,
    fallbackToEmpty = false,
  } = config;

  // Rollback gate (Q3-adjacent + Mitchell's locked decision on STRATEGY_CEILING_GROUNDED_MODE).
  // When the env flag is explicitly "0", return a legacy non-grounded shape so the dashboard
  // popouts revert to their pre-2026-05-23 behavior in <30s without code changes.
  if (process.env.STRATEGY_CEILING_GROUNDED_MODE === '0') {
    return _buildLegacyShape(config);
  }

  const personalityCorpus = _loadPersonalityCorpus({ task, lean });
  const profileCorpus = _loadProfileCorpus();

  // PR-02 R8: agents need to survive missing corpus (iCloud-not-synced, sparse worktree).
  // When fallbackToEmpty is set AND both corpora are empty, return a minimal grounding
  // shape with empty cache blocks + a system prompt that still enforces voice rules.
  // This lets the underlying generator proceed without crash; voice-rules-gate runs
  // post-process to catch drift even without grounding.
  if (fallbackToEmpty && personalityCorpus.content.length === 0 && profileCorpus.content.length === 0) {
    const system = _buildSystemPrompt({ task });
    const prompt = _buildUserPrompt({
      task, metricKey, currentValue,
      dynamicSection: _buildDynamicSection({ role, company, jdText, hmIntel, roleEnrichment }),
      taskInstruction, responseSchema,
    });
    return {
      prompt,
      system,
      cacheStableContent: [],
      cacheKey: `nogrounding-${rowId || 'unknown'}-${metricKey || task}`,
      metadata: {
        task,
        mode: 'fallback-empty',
        personalityCharCount: 0,
        profileCharCount: 0,
        fallbackReason: 'corpus-missing-or-unreadable',
        generatedAt: Date.now(),
      },
    };
  }
  const dynamicSection = _buildDynamicSection({ role, company, jdText, hmIntel, roleEnrichment });

  const cacheKey = _buildCacheKey({
    rowId, metricKey, company, role,
    personalityFiles: personalityCorpus.files,
    profileFiles: profileCorpus.files,
  });

  const contentHash = _buildContentHash({
    personality: personalityCorpus.content,
    profile: profileCorpus.content,
  });

  const system = _buildSystemPrompt({ task });
  const prompt = _buildUserPrompt({
    task, metricKey, currentValue,
    dynamicSection, taskInstruction, responseSchema,
  });

  // cacheStableContent is an ARRAY of 2 cache blocks (personality + profile).
  // Combined with the system prompt's own cache_control block (added by callCouncil),
  // this gives 3 effective breakpoints — matching Q2's locked decision.
  return {
    prompt,
    system,
    cacheStableContent: [personalityCorpus.content, profileCorpus.content],
    cacheKey,
    metadata: {
      task,
      contentHash,
      personalityFiles: personalityCorpus.files,
      profileFiles: profileCorpus.files,
      personalityCharCount: personalityCorpus.content.length,
      profileCharCount: profileCorpus.content.length,
      mode: lean ? 'lean' : 'full',
      generatedAt: Date.now(),
    },
  };
}

/**
 * Voice-purity Layer 2 check (regex). Cheap, runs always.
 * Higher score = more drift. score=0 means no rule fired.
 *
 * @param {string} output — LLM output to validate
 * @returns {{ok: boolean, score: number, fails: Array<{rule:string, weight:number, count:number, samples:string[]}>}}
 */
export function checkVoicePurity(output) {
  const text = String(output || '');
  const fails = [];
  let totalScore = 0;
  for (const rule of VOICE_PURITY_RULES) {
    const matches = text.match(rule.re) || [];
    if (matches.length > 0) {
      const ruleScore = matches.length * rule.weight;
      totalScore += ruleScore;
      fails.push({
        rule: rule.name,
        weight: rule.weight,
        count: matches.length,
        samples: matches.slice(0, 5),
      });
    }
  }
  return { ok: totalScore === 0, score: totalScore, fails };
}

/**
 * Voice-purity Layer 3 (LLM classifier). Q3-locked: callable on cache-WRITE only.
 * Caller is responsible for not running this on cache reads (per the cost-optimal decision).
 *
 * @param {string} output                    — LLM output to evaluate
 * @param {function} callLLM                 — injected LLM caller (e.g., callCouncil)
 * @returns {Promise<{ok: boolean, score: number|null, rationale: string}>}
 */
export async function classifyVoicePurity(output, callLLM) {
  const prompt = [
    `Mitchell Williams' voice in analytical output ABOUT himself is:`,
    `  - Third-person ("Mitchell's alignment shows...", NOT "I think my alignment shows...")`,
    `  - Analyst speaking TO Mitchell about him — never speaking AS Mitchell`,
    `  - tone-safe (no "failed", "broken", "wrong", "bad", "poor", "weak", "deficient", "lacking")`,
    `  - No banned corporate vocab (leverage, synergy, deep-dive, ideate, circle back)`,
    `  - Direct: lead with conclusion, not preamble`,
    ``,
    `Output to evaluate:`,
    `"""`,
    String(output || '').slice(0, 4000),
    `"""`,
    ``,
    `Rate voice match 0-10 where:`,
    `  10 = Reads exactly like an analyst speaking TO Mitchell about him`,
    `  7  = Mostly correct, minor first-person leakage OR mild generic-LLM tone`,
    `  4  = Clear voice drift (first-person self-talk OR tone-unsafe language OR banned vocab)`,
    `  0  = Doesn't sound like analyst-to-Mitchell at all`,
    ``,
    `Return STRICT JSON:`,
    `{ "score": <0-10 integer>, "rationale": "<one sentence>" }`,
    `Return ONLY the JSON object, no markdown fences.`,
  ].join('\n');

  try {
    const r = await callLLM({
      prompt,
      models: ['anthropic:claude-haiku-4-5-20251001'],
      opts: { timeoutMs: 30000, maxTokens: 200 },
    });
    const hit = (r.results || []).find(x => !x.error);
    if (!hit) return { ok: false, score: null, rationale: 'classifier-call-failed' };
    const cleaned = String(hit.content || '').replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      ok: parsed.score >= 7,
      score: parsed.score,
      rationale: parsed.rationale || '(no rationale)',
    };
  } catch (e) {
    return { ok: false, score: null, rationale: 'classifier-parse-failed: ' + e.message };
  }
}

/**
 * PR-02 helper: build a lean grounding prepend string for a content agent's system prompt.
 *
 * Returns a small (~5-8KB target) string to PREPEND to the agent's existing SYSTEM_PROMPT.
 * Honors cross-fork-leak rule:
 *   - For Anthropic vendors (anthropic:*): returns the full personality + profile corpus
 *     (Anthropic gets the trusted-vendor full grounding via the existing 3-breakpoint cache
 *     architecture invoked separately through buildGroundedPrompt's cacheStableContent).
 *   - For non-Anthropic vendors (openai:*, google:*, perplexity:*, xai:*): returns a
 *     SUMMARY-ONLY prepend with hash references + voice-rule highlights only — never
 *     the personality corpus inline. This keeps sensitive-path content out of third-party
 *     prompt logs while still giving the model the canonical voice rules.
 *
 * Both modes are env-flag gated: PERSONALITY_GROUNDING_ALL must not be 'false' AND the
 * per-agent override PERSONALITY_GROUNDING_<AGENT> must not be 'false'. When either is
 * 'false', returns empty string and the agent runs with its existing SYSTEM_PROMPT only.
 *
 * @param {object} cfg
 * @param {string} cfg.agentName            — uppercase agent slug (e.g. 'CV_TAILOR'); env override key
 * @param {string} cfg.vendor               — vendor family ('anthropic'|'openai'|'google'|'perplexity'|'xai')
 * @param {string} [cfg.task='content']     — task identifier for lean-corpus selection
 * @param {string|number} [cfg.rowId='']    — apply-now row ID (optional)
 * @param {string} [cfg.role='']            — JD role
 * @param {string} [cfg.company='']         — company
 * @returns {{prepend: string, mode: 'full'|'summary'|'disabled'|'fallback-empty', metadata: object}}
 */
export function buildLeanGroundingForAgent(cfg) {
  const {
    agentName,
    vendor,
    task = 'content',
    rowId = '',
    role = '',
    company = '',
  } = cfg || {};

  // Env-flag gating per R9
  if (process.env.PERSONALITY_GROUNDING_ALL === 'false') {
    return { prepend: '', mode: 'disabled', metadata: { reason: 'master-flag-disabled' } };
  }
  if (agentName && process.env[`PERSONALITY_GROUNDING_${agentName}`] === 'false') {
    return { prepend: '', mode: 'disabled', metadata: { reason: 'per-agent-flag-disabled', agentName } };
  }

  // Vendor classification for cross-fork-leak compliance
  const vendorFamily = String(vendor || '').toLowerCase().split(':')[0];
  const isAnthropic = vendorFamily === 'anthropic';

  // Build grounded shape with fallback-to-empty safety
  const grounded = buildGroundedPrompt({
    task,
    rowId: rowId || `agent-${agentName || 'unknown'}`,
    role, company,
    lean: true,
    fallbackToEmpty: true,
  });

  if (grounded.metadata?.mode === 'fallback-empty') {
    // Corpus missing — return the system prompt itself as a small prepend so voice
    // rules still ride along, but no corpus content was loaded.
    return {
      prepend: grounded.system + '\n\n',
      mode: 'fallback-empty',
      metadata: { ...grounded.metadata, vendor, agentName },
    };
  }

  if (isAnthropic) {
    // Full mode: Anthropic gets the full personality + profile content as a
    // system-prepend. cacheStableContent is also available via the grounded result
    // for callers who want true Anthropic ephemeral-cache breakpoint behavior;
    // for PR-02 the prepend is enough — Anthropic adapter handles cache hints.
    const corpusBlocks = (grounded.cacheStableContent || []).join('\n\n');
    const prepend = [
      grounded.system,
      '',
      '## Mitchell-grounding corpus (Anthropic-trusted vendor — full content)',
      corpusBlocks,
      '',
      '## End grounding corpus',
      '',
    ].join('\n');
    return {
      prepend,
      mode: 'full',
      metadata: {
        ...grounded.metadata,
        vendor,
        agentName,
        prependCharCount: prepend.length,
      },
    };
  }

  // Non-Anthropic: SUMMARY-ONLY prepend. No corpus content inline.
  // The summary captures voice-rule essentials by reference, not by quote.
  const personalityFileList = (grounded.metadata?.personalityFiles || []).join(', ');
  const profileFileList = (grounded.metadata?.profileFiles || []).join(', ');
  const summary = [
    grounded.system,
    '',
    '## Mitchell-grounding summary (non-Anthropic vendor — references only, no inline corpus)',
    '',
    `Personality corpus references (hash_only, ${grounded.metadata?.personalityCharCount || 0} chars total): ${personalityFileList || '(none loaded)'}`,
    `Profile corpus references (hash_only, ${grounded.metadata?.profileCharCount || 0} chars total): ${profileFileList || '(none loaded)'}`,
    `Content hash: ${grounded.metadata?.contentHash || 'n/a'}`,
    '',
    'You do NOT have direct access to the corpus content above. Apply the voice rules from the',
    'system prompt strictly. When asked to cite proof points, reference them generically (e.g.',
    '"per cv.md experience section") rather than inventing specific quotes.',
    '',
    '## End grounding summary',
    '',
  ].join('\n');
  return {
    prepend: summary,
    mode: 'summary',
    metadata: {
      ...grounded.metadata,
      vendor,
      agentName,
      prependCharCount: summary.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal builders
// ─────────────────────────────────────────────────────────────────────────────

function _loadPersonalityCorpus({ task, lean }) {
  let allFiles = [];
  try {
    allFiles = readdirSync(PERSONALITY_DIR)
      .filter(f => f.startsWith('personality-') && f.endsWith('.md') && f !== 'personality-index.md')
      .sort();
  } catch {
    return { files: [], content: '' };
  }

  let selectedFiles;
  if (!lean) {
    // Full mode: every doc except the index
    selectedFiles = allFiles;
  } else {
    // Lean mode (Q4): always-include + per-task 6th + skip LEAN_DROP_FIRST
    const sixth = PER_TASK_LEAN_SIXTH[task] || 'personality-strengths-profile.md';
    const core = new Set([...ALWAYS_PERSONALITY, sixth, 'personality-values-motivations.md', 'personality-decision-making.md', 'personality-strengths-profile.md']);
    selectedFiles = allFiles.filter(f => core.has(f) && !LEAN_DROP_FIRST.has(f));
  }

  const parts = [];
  const filesUsed = [];
  for (const f of selectedFiles) {
    try {
      const content = readFileSync(join(PERSONALITY_DIR, f), 'utf-8');
      parts.push(`=== ${f} ===\n${content}`);
      filesUsed.push(f);
    } catch { /* skip missing */ }
  }
  return { files: filesUsed, content: parts.join('\n\n') };
}

function _loadProfileCorpus() {
  const filesToTry = ['cv.md', 'article-digest.md', 'modes/_profile.md', 'config/profile.yml', 'data/press-media-network-roster.md'];
  const parts = [];
  const filesUsed = [];
  for (const rel of filesToTry) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    try {
      let content = readFileSync(full, 'utf-8');
      // Cap any single profile file at 50K chars to keep total tokens manageable.
      if (content.length > 50000) content = content.slice(0, 50000) + '\n\n[truncated at 50K chars]';
      parts.push(`=== ${rel} ===\n${content}`);
      filesUsed.push(rel);
    } catch { /* skip on read error */ }
  }
  return { files: filesUsed, content: parts.join('\n\n') };
}

function _buildDynamicSection({ role, company, jdText, hmIntel, roleEnrichment }) {
  const parts = [];
  parts.push(`Role: ${role || '(unknown — row context missing)'}`);
  parts.push(`Company: ${company || '(unknown — row context missing)'}`);
  if (jdText) {
    parts.push(`\n## Job description excerpt\n${String(jdText).slice(0, 3000)}`);
  }
  if (hmIntel && typeof hmIntel === 'object' && Object.keys(hmIntel).length > 0) {
    parts.push(`\n## Hiring-manager intel\n${JSON.stringify(hmIntel, null, 2).slice(0, 2500)}`);
  }
  if (roleEnrichment && typeof roleEnrichment === 'object' && Object.keys(roleEnrichment).length > 0) {
    parts.push(`\n## Role enrichment\n${JSON.stringify(roleEnrichment, null, 2).slice(0, 1500)}`);
  }
  return parts.join('\n');
}

function _buildCacheKey({ rowId, metricKey, company, role, personalityFiles, profileFiles }) {
  // Q1 (Mitchell-locked): mtime in cacheKey for cheap freshness; content_hash lives in metadata.
  const personalityMtime = personalityFiles
    .map(f => { try { return statSync(join(PERSONALITY_DIR, f)).mtimeMs; } catch { return 0; } })
    .reduce((a, b) => Math.max(a, b), 0);
  const profileMtime = profileFiles
    .map(rel => { try { return statSync(join(ROOT, rel)).mtimeMs; } catch { return 0; } })
    .reduce((a, b) => Math.max(a, b), 0);
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [
    rowId,
    metricKey,
    slug(company),
    slug(role).slice(0, 30),
    `p${Math.floor(personalityMtime / 1000)}`,
    `f${Math.floor(profileMtime / 1000)}`,
  ].join('-');
}

function _buildContentHash({ personality, profile }) {
  const h = createHash('sha256');
  h.update(personality);
  h.update('\0');
  h.update(profile);
  return h.digest('hex').slice(0, 16);
}

function _buildSystemPrompt({ task }) {
  return [
    `You are a senior career strategist providing analysis ABOUT Mitchell Williams to Mitchell himself.`,
    ``,
    `You will be given Mitchell's full second-brain corpus (personality docs, values, decision patterns, communication style, tone-safety constraints) PLUS his profile corpus (cv.md, article-digest, modes/_profile, config/profile) PLUS the specific role context.`,
    ``,
    `CRITICAL VOICE RULES — output that violates these will be rejected by an automated voice-purity check:`,
    `  1. Write in THIRD-PERSON about Mitchell. Use his name or "he"/"his". NEVER use first-person ("I think", "my fit", "looking at this role I"). You are an analyst speaking TO him about himself — you are NOT him.`,
    `  2. Honor tone-safety: NEVER apply words like "failed", "broken", "wrong", "bad", "poor", "weak", "deficient", "lacking" to Mitchell's background, choices, or proof points. Use neutral observational framing ("gap to bridge", "area needing demonstration", "less-documented dimension", "trajectory in progress").`,
    `  3. Banned vocabulary (replace with plain English): "leverage", "synergy", "deep dive", "ideate", "circle back", "touch base", "bandwidth", "moving forward", "reach out". These read as corporate noise and break voice match. Also never use em dashes (the U+2014 character); use commas, colons, periods, or parentheses (this analysis is rendered in the dashboard).`,
    `  4. Lead with conclusions, not preamble. Mitchell's DISC DI profile prefers answer-first; preamble buries the signal.`,
    `  5. Cite specific corpus locations when making claims (cv.md section, article-digest excerpt, story-bank entry, hm-intel field). Vague claims read as ungrounded.`,
    `  6. Use Mitchell's actual proof points from his corpus. Do not invent achievements; do not paraphrase generic AI-engineer accomplishments.`,
    `  7. Apply Mitchell's personality lens: strategic, action-first, direct. Frame recommendations in ways he can ACT on, not generic strategy memos.`,
    ``,
    `Task: ${task}`,
  ].join('\n');
}

function _buildUserPrompt({ task, metricKey, currentValue, dynamicSection, taskInstruction, responseSchema }) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [`Today is ${today} PT.`, ''];
  parts.push(taskInstruction || `Analyze ${task} for the role below using Mitchell's full corpus + personality lens (from cached stable content above).`);
  if (currentValue !== null && metricKey) {
    parts.push(`Current ${metricKey} value: ${currentValue}%`);
  }
  parts.push('', '## Role context', dynamicSection);
  if (responseSchema) {
    parts.push('', '## Response shape', 'Respond ONLY with valid JSON matching this schema:', responseSchema, '', 'Return ONLY the JSON object, no markdown fences.');
  }
  return parts.join('\n');
}

function _buildLegacyShape(config) {
  // Rollback path: mirrors the OLD lib/strategy-ceiling.mjs::_buildPrompt shape so toggling
  // STRATEGY_CEILING_GROUNDED_MODE=0 produces output indistinguishable from pre-2026-05-23.
  const { task, metricKey = task, role = '', company = '', jdText = '', hmIntel = null, currentValue = null, responseSchema } = config;
  const today = new Date().toISOString().slice(0, 10);
  const jdSnippet = jdText ? String(jdText).slice(0, 1500) : '(not provided)';
  const hmSnippet = hmIntel && Object.keys(hmIntel).length > 0
    ? JSON.stringify(hmIntel).slice(0, 600)
    : '(not provided)';
  const prompt = [
    `You are a senior career strategist. Today is ${today} PT.`,
    `The candidate is Mitchell Williams: senior AI practitioner, brand "rare combination, ships fast," targeting $250K-$240K TC at pre-IPO frontier-AI labs.`,
    ``,
    `Task: for the metric "${metricKey}" with current value ${currentValue}%, compute the realistic ceiling and 3-5 next-actions to close the gap.`,
    ``,
    `Context:`,
    `  - Role: ${role || 'unknown'}`,
    `  - Company: ${company || 'unknown'}`,
    `  - JD snippet: ${jdSnippet}`,
    `  - HM intel: ${hmSnippet}`,
    ``,
    responseSchema ? `Respond ONLY with valid JSON matching this schema exactly:\n${responseSchema}\nReturn ONLY the JSON object, no markdown fences.` : '',
  ].filter(Boolean).join('\n');
  return {
    prompt,
    system: 'You are a senior career strategist.',
    cacheStableContent: [], // legacy = no caching
    cacheKey: `legacy-${config.rowId || 'unknown'}-${metricKey}`,
    metadata: { mode: 'legacy', generatedAt: Date.now() },
  };
}
