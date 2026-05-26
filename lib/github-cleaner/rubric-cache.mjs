/**
 * lib/github-cleaner/rubric-cache.mjs — Phase 2 of github-cleaner.
 *
 * Derives the hiring-lens rubric Mitchell's GitHub is audited against. Uses
 * PER-MODEL BRIEFS that leverage each LLM's unique grounding/tools/connectors,
 * across 15 verticals × 7 source platforms (defined in
 * config/github-cleaner-personas.yml), then adjudicates via the dealbreaker
 * agent with explicit corroboration-source mapping.
 *
 * Cached 30 days unless config/profile.yml, modes/_profile.md, cv.md, OR
 * config/github-cleaner-personas.yml change.
 *
 * Output: data/github-cleaner/rubric-cache.json (shape in design doc § Phase 2)
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 2.
 *
 * Status: SKELETON — function signatures locked, per-model brief composition
 * logic + dealbreaker delegation pending the full build pass.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const CACHE_PATH = join(ROOT, 'data', 'github-cleaner', 'rubric-cache.json');
const PERSONAS_PATH = join(ROOT, 'config', 'github-cleaner-personas.yml');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Phase 2';

/* ──────────────────────── Cache + sha helpers ──────────────────────── */

/**
 * Returns the cached rubric if fresh, else null. Invalidates on TTL or on
 * identity-sha change (target-roles, cv.md, or personas.yml edit).
 */
export function getCachedRubric({ identitySha, forceFresh = false } = {}) {
  if (forceFresh) return null;
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    const age = Date.now() - new Date(cache.as_of).getTime();
    if (age >= CACHE_TTL_MS) return null;
    if (identitySha && cache.identity_sha && cache.identity_sha !== identitySha) return null;
    return cache;
  } catch { return null; }
}

/**
 * Compute the sha of the relevant identity + targeting + personas sources.
 * Cache invalidates on change to any of: cv.md (identity), config/profile.yml
 * (target roles), modes/_profile.md (archetype/positioning), or
 * config/github-cleaner-personas.yml (vertical weights + source matrix).
 *
 * Legacy alias `computeProfileSha` is preserved for the orchestrator that
 * was wired before the rename.
 */
export function computeIdentitySha() {
  const parts = [];
  for (const rel of ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'config/github-cleaner-personas.yml']) {
    const p = join(ROOT, rel);
    if (existsSync(p)) parts.push(`# ${rel}\n${readFileSync(p, 'utf-8')}`);
  }
  return createHash('sha1').update(parts.join('\n--\n')).digest('hex');
}

// Legacy alias used by the orchestrator + tests written before the rename.
export const computeProfileSha = computeIdentitySha;

/* ──────────────────────── Personas loader ──────────────────────── */

/**
 * Load + parse config/github-cleaner-personas.yml. Cached in-process.
 *
 * @returns {{ verticals: object, source_platforms: object, model_brief_focus: object, dealbreaker_thresholds: object }}
 */
let _personasCache = null;
export function loadPersonas() {
  if (_personasCache) return _personasCache;
  if (!existsSync(PERSONAS_PATH)) {
    throw new Error(
      `Personas config missing at ${PERSONAS_PATH}. The cleaner needs the ` +
      `vertical weights + source matrix to compose per-model briefs. ` +
      `See ${DESIGN_DOC_REF}.`
    );
  }
  try {
    _personasCache = yaml.load(readFileSync(PERSONAS_PATH, 'utf-8'));
    return _personasCache;
  } catch (e) {
    throw new Error(`Failed to parse personas YAML: ${e.message}`);
  }
}

/**
 * Test hook: clear the personas cache (used in tests when reloading the YAML).
 */
export function _clearPersonasCache() { _personasCache = null; }

/* ──────────────────────── Brief composition ──────────────────────── */

/**
 * Compose ONE brief per council model, each tuned to that model's unique
 * grounding/tools per personas.model_brief_focus. Each brief includes:
 *   - The verticals it should prioritize (with weights from personas.verticals)
 *   - The source platforms it's load-bearing for + freshness windows
 *   - Output schema for findings[]
 *   - Anti-fabrication rule + date constraint
 *
 * Per Decision-Maximization Policy: full council, no subsets, unless
 * --council-subset is explicit at the orchestrator level.
 *
 * @param {{ focusRole?: string|null, includeModels?: string[]|null }} opts
 * @returns {Array<{ model: string, brief: string, primary_sources: string[], primary_verticals: string[], expected_output_schema: object }>}
 */
export function composePerModelBriefs(opts = {}) {
  const { focusRole = null, includeModels = null } = opts;
  const personas = loadPersonas();

  // Read Mitchell's corpus for context
  let cvContext = '';
  let profileContext = '';
  for (const [rel, key] of [['cv.md', 'cv'], ['config/profile.yml', 'profile'], ['modes/_profile.md', 'mode']]) {
    const p = join(ROOT, rel);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').slice(0, 3000);
        cvContext += `\n\n### ${rel}\n${content}`;
      } catch { /* skip */ }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  // Build weighted vertical summary for the brief
  const verticals = personas.verticals || {};
  const topVerticals = Object.entries(verticals)
    .sort(([, a], [, b]) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 8)
    .map(([k, v]) => `  - ${k} (weight ${v.weight}, demonstrated=${v.demonstrated}, aspirational=${v.aspirational}): ${v.sample_role_titles?.slice(0, 2).join(', ')}`);

  const sourcePlatforms = personas.source_platforms || {};
  const enabledSources = Object.entries(sourcePlatforms)
    .filter(([, v]) => v.enabled !== false)
    .map(([k, v]) => `  - ${k} (freshness window: ${v.freshness_window_days}d)`);

  // Base context block shared by all models
  const sharedContext = `
## Context: Mitchell Williams — Career Profile
Today is ${today}. The year ${year} is real and verified by the orchestrator's system clock.

Mitchell is a career-changer pivoting from senior television/media roles (Google, Al Jazeera, HuffPost Live, CCTV America) to AI-forward roles. He has built production AI agent systems (career-ops, storytellermitch.com, other side projects on GitHub at mitwilli-create). His GitHub profile at https://github.com/mitwilli-create is a PRIMARY signal for hiring managers in his target roles.

### Top verticals by weight (sorted by importance to Mitchell):
${topVerticals.join('\n')}

### Source platforms to canvas (freshness windows):
${enabledSources.join('\n')}

${focusRole ? `### Focus role for this run: ${focusRole}` : ''}

### Anti-fabrication rule (MANDATORY):
Quote real content from the platforms you canvas. Never invent URLs, posts, or statistics. If you cannot find evidence, say so explicitly with [NO EVIDENCE FOUND]. Never guess. Mark uncertain data [UNVERIFIED].

### Output schema (return THIS exact JSON shape — no preamble, no markdown fences):
\`\`\`
{
  "findings": [
    {
      "id": "unique string like f-{model}-{n}",
      "claim": "What hiring managers / recruiters expect to see on GitHub for these roles",
      "rationale": "Why this matters for Mitchell's target roles",
      "vertical": "which vertical this applies to",
      "weight": 0.0-1.0,
      "category": "must_have|nice_to_have|red_flag",
      "confidence_evidence": [
        { "platform": "x|reddit|linkedin|glassdoor|blind|indeed|company_spokespersons", "url": "actual URL", "excerpt": "verbatim quote ≤200 chars", "as_of": "YYYY-MM-DD", "verified": true }
      ]
    }
  ],
  "model": "your model identifier",
  "as_of": "${today}",
  "platforms_canvased": ["list of platforms you checked"],
  "freshness_note": "oldest source date used"
}
\`\`\`
`;

  // Per-model focus assignments from personas.yml
  const modelFocus = personas.model_brief_focus || {};
  const allModels = Object.keys(modelFocus);
  const modelsToUse = includeModels && includeModels.length > 0
    ? allModels.filter(m => includeModels.some(inc => m.includes(inc)))
    : allModels;

  const briefs = [];
  for (const modelKey of modelsToUse) {
    const focus = modelFocus[modelKey] || {};
    const primarySources = Array.isArray(focus.primary_sources)
      ? focus.primary_sources
      : (focus.primary_sources === 'synthesize' ? ['all_models_output'] : []);

    const isSynthesis = focus.role === 'synthesis_and_per_claim_confidence';

    let modelBrief;
    if (isSynthesis) {
      modelBrief = `${sharedContext}

## Your role: Synthesis + per-claim confidence assignment (Anthropic Opus)

You are the synthesis model. You will receive the raw findings from the 6 other council models (passed as additional context). Your job:
1. Identify universal signals (claimed by 3+ models) vs role-specific (1-2 models)
2. Flag contradictions between models (where 2+ models directly disagree)
3. Assign a preliminary confidence tier to each claim: VERIFIED (3+ models) | CORROBORATED (2 models/platforms) | UNIQUE-PLAUSIBLE (1 model with URL) | UNIQUE-UNSUPPORTED (1 model, no URL)
4. De-duplicate overlapping claims by merging them into a single canonical claim

Return the synthesized claims in the output schema above.

Focus on GitHub-specific signals: what recruiters + hiring managers at AI labs (Anthropic, OpenAI, Google DeepMind) and AI-forward companies look for on a GitHub profile when evaluating candidates for Mitchell's target roles.`;
    } else {
      const sourceList = primarySources.map(s => {
        const cfg = sourcePlatforms[s];
        return cfg ? `  - **${s}** (freshness: ${cfg.freshness_window_days}d): ${cfg.notes?.split('\n')[0] || ''}` : `  - ${s}`;
      }).join('\n');

      modelBrief = `${sharedContext}

## Your role: ${focus.notes || 'Hiring-signal research for Mitchell Williams'}

### Your primary source platforms for this query:
${sourceList || '  (canvas all enabled sources)'}

### Task:
Research what hiring managers and recruiters in AI-forward companies ACTUALLY look for on a candidate's GitHub profile when evaluating for Mitchell's target roles. Use your unique access to ${primarySources.join(', ')}.

Specifically find evidence about:
1. What GitHub signals (READMEs, projects, profile README, bio, pinned repos, activity graph) actually move the needle for candidates targeting AI PgM / Communications / Applied AI / Solutions Architecture roles
2. What red flags on GitHub cause fast-passes (stale repos, no READMEs, no description, personal data leaks, etc.)
3. What "great" looks like — specific GitHub profiles of people who recently got hired into these roles (if you can find public examples)
4. Keywords, topics, and signals that are currently trending in JDs vs GitHub profiles (the gap = the opportunity)

Today is ${today}. Limit findings to signals ≤${sourcePlatforms[primarySources[0]]?.freshness_window_days || 90} days old unless noted as historical context.

Return your findings in the JSON schema above.`;
    }

    const expectedOutputSchema = {
      findings: [],
      model: modelKey,
      as_of: today,
      platforms_canvased: primarySources,
      freshness_note: null,
    };

    briefs.push({
      model: modelKey,
      brief: modelBrief,
      primary_sources: primarySources,
      primary_verticals: Object.keys(verticals).filter(v => {
        if (focus.primary_verticals_filter === 'all') return true;
        const arr = Array.isArray(focus.primary_verticals_filter) ? focus.primary_verticals_filter : [];
        return arr.includes(v);
      }),
      expected_output_schema: expectedOutputSchema,
      is_synthesis: isSynthesis,
    });
  }

  return briefs;
}

/**
 * Legacy single-brief composer — deprecated; use composePerModelBriefs().
 */
export function composeResearchBrief({ targetRoles, focusRole = null } = {}) {
  // Delegate to the new per-model briefs and return the synthesis model's brief
  const briefs = composePerModelBriefs({ focusRole });
  const synthBrief = briefs.find(b => b.is_synthesis) || briefs[0];
  return synthBrief ? synthBrief.brief : '';
}

/* ──────────────────────── Pipeline + dealbreaker ──────────────────────── */

/**
 * Run the full Phase 2 pipeline:
 *   1. Compose per-model briefs from personas.yml
 *   2. Fan out to the council in parallel (via lib/council.mjs)
 *   3. Aggregate per-model responses into a candidate-claims pool
 *   4. Hand to the dealbreaker agent for tier classification
 *   5. Write the cache + the dealbreaker audit appendix
 */
export async function refreshRubric(opts = {}) {
  const { identitySha, councilSubset = null, preApplySlug = null, runId = null } = opts;

  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'start' }) + '\n');

  // Load callCouncil from lib/council.mjs
  let callCouncil;
  try {
    const councilModule = await import('../council.mjs');
    callCouncil = councilModule.callCouncil;
  } catch (e) {
    throw new Error(`rubric-cache: failed to import lib/council.mjs: ${e.message}`);
  }

  const personas = loadPersonas();

  // 1. Compose per-model briefs
  const briefs = composePerModelBriefs({ focusRole: preApplySlug, includeModels: councilSubset?.split(',') || null });
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'briefs_composed', count: briefs.length }) + '\n');

  // 2. Fan out to each model in parallel (one callCouncil per model with its specific brief)
  const modelResults = [];
  const fanOutPromises = briefs.map(async (b) => {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'model_start', model: b.model }) + '\n');
    try {
      const results = await callCouncil({
        prompt: b.brief,
        models: [b.model],
        opts: { timeoutMs: 600_000 },
      });
      const result = Array.isArray(results) ? results[0] : results;
      process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'model_done', model: b.model, ok: !result?.error }) + '\n');
      return { model: b.model, result, brief: b };
    } catch (e) {
      process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'model_error', model: b.model, error: String(e.message).slice(0, 200) }) + '\n');
      return { model: b.model, result: { error: e.message }, brief: b };
    }
  });

  const settled = await Promise.allSettled(fanOutPromises);
  const perModelResponses = {};
  let totalCostUsd = 0;

  for (const s of settled) {
    if (s.status === 'rejected') continue;
    const { model, result, brief } = s.value;
    const costUsd = result?.costUsd || 0;
    totalCostUsd += costUsd;
    perModelResponses[model] = {
      model,
      responded: !result?.error && !result?.skipped,
      raw_findings_count: 0,
      spend_usd: costUsd,
      groundings_used: brief.primary_sources,
      raw_content: result?.content || result?.text || null,
      error: result?.error || null,
      skipped: result?.skipped || false,
    };
  }

  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'fan_out_complete', models_responded: Object.values(perModelResponses).filter(r => r.responded).length }) + '\n');

  // 3. Parse raw responses into a claims pool
  const claimsPool = [];
  for (const [model, resp] of Object.entries(perModelResponses)) {
    if (!resp.responded || !resp.raw_content) continue;
    try {
      const clean = resp.raw_content.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
      const parsed = JSON.parse(clean);
      const findings = parsed.findings || [];
      resp.raw_findings_count = findings.length;
      for (const f of findings) {
        claimsPool.push({
          ...f,
          _source_model: model,
          _source_platforms: resp.groundings_used || [],
        });
      }
    } catch { /* model returned non-JSON — skip */ }
  }

  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'claims_aggregated', count: claimsPool.length }) + '\n');

  // 4. Adjudicate via local dealbreaker
  let runDir = null;
  if (runId) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    runDir = join(ROOT, 'data', 'github-cleaner', ts);
    try { mkdirSync(runDir, { recursive: true }); } catch { /* */ }
  }

  const adjudicated = await adjudicateViaDealbreaker(claimsPool, runDir);

  // 5. Build and write the rubric cache
  const rubric = {
    as_of: new Date().toISOString(),
    expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    identity_sha: identitySha || computeIdentitySha(),
    vertical_weights: Object.fromEntries(
      Object.entries(personas.verticals || {}).map(([k, v]) => [k, v.weight || 1.0])
    ),
    council_cost_usd: totalCostUsd,
    per_model_responses: perModelResponses,
    must_haves: adjudicated.must_haves,
    nice_to_haves: adjudicated.nice_to_haves,
    red_flags: adjudicated.red_flags,
    vertical_lenses: adjudicated.vertical_lenses,
    dealbreaker_audit_appendix: adjudicated.audit_path || null,
  };

  writeRubricCache(rubric);
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'rubric_refresh', step: 'cache_written', path: CACHE_PATH }) + '\n');

  return rubric;
}

/**
 * Local dealbreaker: applies confidence tier classification from personas.yml
 * thresholds to the aggregated claims pool. Writes the audit appendix.
 *
 * @param {Array<object>} claimsPool - raw findings from all models
 * @param {string|null} runDir - where to write the audit appendix
 * @returns {Promise<{ must_haves, nice_to_haves, red_flags, vertical_lenses, audit_path }>}
 */
export async function adjudicateViaDealbreaker(claimsPool, runDir) {
  const personas = loadPersonas();
  const thresholds = personas.dealbreaker_thresholds || {};

  const VERIFIED_MIN_MODELS = thresholds.verified?.min_models || 3;
  const VERIFIED_MIN_PLATFORMS = thresholds.verified?.min_source_platforms || 2;
  const CORROBORATED_MIN = thresholds.corroborated?.min_models_or_platforms || 2;

  const today = new Date();
  const defaultMaxAgeDays = thresholds.stale?.default_max_age_days || 90;

  // Group claims by semantic similarity (simple: group by claim hash of first 60 chars)
  const claimGroups = new Map();
  for (const claim of claimsPool) {
    const key = normalizeClaimKey(claim.claim || claim.id || '');
    if (!claimGroups.has(key)) {
      claimGroups.set(key, { claims: [], models: new Set(), platforms: new Set() });
    }
    const g = claimGroups.get(key);
    g.claims.push(claim);
    if (claim._source_model) g.models.add(claim._source_model);
    const evidencePlatforms = (claim.confidence_evidence || []).map(e => e.platform).filter(Boolean);
    for (const p of (claim._source_platforms || evidencePlatforms)) g.platforms.add(p);
  }

  const must_haves = [];
  const nice_to_haves = [];
  const red_flags = [];
  const rejected = [];

  let idCounter = 0;
  for (const [key, group] of claimGroups) {
    const { claims, models, platforms } = group;
    const representative = claims[0];
    const modelCount = models.size;
    const platformCount = platforms.size;

    // Check staleness
    const allEvidence = claims.flatMap(c => c.confidence_evidence || []);
    const hasRecentEvidence = allEvidence.length === 0 || allEvidence.some(e => {
      if (!e.as_of) return true;
      const ageDays = (today.getTime() - new Date(e.as_of).getTime()) / (24 * 60 * 60 * 1000);
      return ageDays <= defaultMaxAgeDays;
    });

    if (!hasRecentEvidence) {
      rejected.push({ claim: representative.claim, reason: 'STALE', models: [...models], platforms: [...platforms] });
      continue;
    }

    // Assign confidence tier
    let tier;
    if (modelCount >= VERIFIED_MIN_MODELS && platformCount >= VERIFIED_MIN_PLATFORMS) {
      tier = 'VERIFIED';
    } else if (modelCount >= CORROBORATED_MIN || platformCount >= CORROBORATED_MIN) {
      tier = 'CORROBORATED';
    } else if (modelCount >= 1 && allEvidence.some(e => e.url && e.verified !== false)) {
      tier = 'UNIQUE-PLAUSIBLE';
    } else {
      rejected.push({ claim: representative.claim, reason: 'UNIQUE-UNSUPPORTED', models: [...models], platforms: [...platforms] });
      continue;
    }

    const weight = representative.weight || (tier === 'VERIFIED' ? 1.0 : tier === 'CORROBORATED' ? 0.8 : 0.5);
    const category = representative.category || 'must_have';

    const entry = {
      id: `${category.replace('_', '-').slice(0, 2)}-${++idCounter}`,
      claim: representative.claim,
      confidence_tier: tier,
      weight,
      vertical: representative.vertical || 'general',
      corroborating_models: [...models],
      corroborating_sources: allEvidence.slice(0, 3),
      dealbreaker_notes: `${tier}: ${modelCount} model(s), ${platformCount} platform(s)`,
    };

    if (category === 'red_flag') red_flags.push(entry);
    else if (category === 'nice_to_have') nice_to_haves.push(entry);
    else must_haves.push(entry);
  }

  // Sort by weight desc within each category
  must_haves.sort((a, b) => b.weight - a.weight);
  nice_to_haves.sort((a, b) => b.weight - a.weight);
  red_flags.sort((a, b) => b.weight - a.weight);

  // Build vertical lenses pivot
  const verticals = Object.keys(personas.verticals || {});
  const vertical_lenses = {};
  for (const v of verticals) {
    vertical_lenses[v] = {
      must_haves: must_haves.filter(m => m.vertical === v || m.vertical === 'general').map(m => m.id),
      red_flags: red_flags.filter(r => r.vertical === v || r.vertical === 'general').map(r => r.id),
    };
  }

  // Write audit appendix
  let audit_path = null;
  if (runDir) {
    const lines = [
      '# Dealbreaker Audit Appendix',
      '',
      `**Run date:** ${new Date().toISOString()}`,
      `**Claims accepted:** ${must_haves.length + nice_to_haves.length + red_flags.length}`,
      `**Claims rejected:** ${rejected.length}`,
      '',
      '## Rejected Claims',
      '',
    ];
    for (const r of rejected) {
      lines.push(`- **${r.reason}**: "${r.claim?.slice(0, 120)}" (models: ${r.models.join(', ')})`);
    }
    lines.push('');
    lines.push('## Accepted Claims by Tier');
    lines.push('');
    for (const m of must_haves) lines.push(`- [${m.confidence_tier}] MUST-HAVE (${m.vertical}): ${m.claim?.slice(0, 100)}`);
    for (const n of nice_to_haves) lines.push(`- [${n.confidence_tier}] NICE-TO-HAVE (${n.vertical}): ${n.claim?.slice(0, 100)}`);
    for (const f of red_flags) lines.push(`- [${f.confidence_tier}] RED-FLAG (${f.vertical}): ${f.claim?.slice(0, 100)}`);

    audit_path = join(runDir, 'dealbreaker-audit.md');
    try {
      mkdirSync(dirname(audit_path), { recursive: true });
      writeFileSync(audit_path, lines.join('\n'), 'utf-8');
    } catch { /* non-fatal */ }
  }

  return { must_haves, nice_to_haves, red_flags, vertical_lenses, audit_path };
}

/** Normalize a claim to a grouping key (first 60 chars, lowercased, punctuation stripped). */
function normalizeClaimKey(claim) {
  return claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 60);
}

/**
 * Write the dealbreaker-adjudicated rubric to disk + return its path.
 */
export function writeRubricCache(rubric) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(rubric, null, 2), 'utf-8');
  return CACHE_PATH;
}

export { CACHE_PATH as RUBRIC_CACHE_PATH, PERSONAS_PATH, CACHE_TTL_MS };
