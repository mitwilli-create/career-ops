/**
 * lib/github-cleaner/generate.mjs — Phase 4A of github-cleaner.
 *
 * Generates the actual content for each recommendation from Phase 3.
 * Sonnet for READMEs/descriptions/topics; Opus for profile README + bio.
 *
 * Every artifact is grounded in cv.md + article-digest.md + actual repo state.
 * Claim-grounding pre-check rejects any prompt that would lean on a metric
 * not present in source corpus.
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 4.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readText } from '../safe-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const SONNET = 'claude-sonnet-4-6';
const OPUS = 'claude-opus-4-7';

function emit(obj) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'generate', ...obj }) + '\n');
}

/* ─────────────────────── Corpus loader ───────────────────────────────────── */

let _corpusCache = null;

/**
 * Load Mitchell's content corpus (cv.md + article-digest.md + voice-reference).
 * Cached in-process per run.
 */
export function loadCorpus() {
  if (_corpusCache) return _corpusCache;

  const corpus = { cv: '', articleDigest: '', voiceReference: '', claims: [] };

  for (const [rel, key] of [
    ['cv.md', 'cv'],
    ['article-digest.md', 'articleDigest'],
    ['writing-samples/voice-reference.md', 'voiceReference'],
  ]) {
    const p = join(ROOT, rel);
    if (existsSync(p)) {
      try { corpus[key] = readFileSync(p, 'utf-8').slice(0, 8000); }
      catch { /* skip */ }
    }
  }

  // Pre-extract all numeric claims from cv.md + article-digest for grounding check
  const combined = corpus.cv + '\n' + corpus.articleDigest;
  const numericPattern = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|x|×|M|B|K|million|billion|thousand|users?|customers?|followers?|views?|articles?|episodes?|years?|months?|weeks?|days?|hours?)\b/gi;
  const matches = combined.matchAll(numericPattern);
  for (const m of matches) corpus.claims.push(m[0].toLowerCase().trim());

  _corpusCache = corpus;
  return corpus;
}

/** Clear corpus cache — used in tests. */
export function _clearCorpusCache() { _corpusCache = null; }

/* ────────────────────── Claim grounding ─────────────────────────────────── */

/**
 * Claim-grounding pre-check. Every numeric metric the artifact references
 * must trace to cv.md / article-digest / actual repo state.
 * Returns list of un-grounded claims.
 */
export function preflightGroundingCheck(draftContent, corpus) {
  const ungrounded = [];
  const METRIC_PATTERN = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|x|×|M|B|K|million|billion|thousand|users?|customers?|followers?|views?|articles?|episodes?|years?|months?|weeks?|days?|hours?)\b/gi;

  const matches = [...(draftContent || '').matchAll(METRIC_PATTERN)];
  const knownClaims = new Set(corpus?.claims || []);

  for (const m of matches) {
    const normalized = m[0].toLowerCase().trim();
    // Check if any known claim contains this metric
    const grounded = [...knownClaims].some(c => c.includes(normalized.replace(/,/g, ''))) ||
      (corpus?.cv || '').toLowerCase().includes(normalized.replace(/,/g, '')) ||
      (corpus?.articleDigest || '').toLowerCase().includes(normalized.replace(/,/g, ''));
    if (!grounded) {
      ungrounded.push({ metric: m[0], normalized });
    }
  }

  return ungrounded;
}

/* ───────────────────── Anthropic API call helper ─────────────────────────── */

async function callAnthropic({ model, prompt, maxTokens = 3000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    emit({ step: 'api_key_missing', model });
    return null;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (!model.includes('opus')) body.temperature = 0;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errBody = await readText(res, 30_000, 'generate');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await readJson(res, 90_000, 'generate');
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    // Approximate cost: Sonnet ~$3/M in, $15/M out; Opus ~$15/M in, $75/M out
    const costUsd = model.includes('opus')
      ? (inputTokens * 15 + outputTokens * 75) / 1_000_000
      : (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    return { text, costUsd };
  } catch (e) {
    emit({ step: 'api_error', model, error: String(e.message).slice(0, 200) });
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────────────── Prompt templates ────────────────────────────────── */

function buildReadmePrompt(repo, corpus, rubricContext, findings) {
  const rubrucHints = (rubricContext?.must_haves || []).slice(0, 5)
    .map(m => `- ${m.claim}`).join('\n') || '- Show concrete outcomes\n- Include run/usage instructions\n- Add visual proof (screenshots or badges)';

  return `You are writing a hiring-grade README for Mitchell Williams's GitHub repository.

## Repository: ${repo.name}
- Description: ${repo.description || '(no description yet)'}
- Primary language: ${repo.primary_language || 'unknown'}
- Topics: ${(repo.topics || []).join(', ') || 'none yet'}
- Stars: ${repo.stars}

## What recruiters + hiring managers are looking for:
${rubrucHints}

## Issues to fix:
${findings.map(f => `- ${f.evidence}`).join('\n') || 'Improve overall quality'}

## Mitchell's background (from cv.md / article-digest.md):
${corpus.cv.slice(0, 2000)}

## Voice reference (how Mitchell writes):
${corpus.voiceReference.slice(0, 1500)}

## Requirements:
1. Write in Mitchell's voice — direct, builder-forward, no buzzwords
2. Only include metrics that appear in the corpus above (no fabrication)
3. Include: what it does (1-2 sentences), why it matters, how to run it, what it demonstrates about Mitchell's skills
4. Keep total length under 600 words
5. Include a "## Quick Start" or "## Usage" section with real commands
6. Return ONLY the README markdown — no preamble, no explanation`;
}

function buildDescriptionPrompt(repo, corpus, findings) {
  return `Write a crisp 1-sentence GitHub repository description for: ${repo.name}

Context: ${repo.description || 'no current description'}
Language: ${repo.primary_language || 'unknown'}

The description must:
- Be under 100 characters
- Clearly state what the repo does and its value
- Sound like Mitchell (direct, builder-forward, no buzzwords)
- Be suitable for a recruiter skimming the GitHub profile
- Only use metrics that appear here: ${corpus.cv.slice(0, 500)}

Return ONLY the description text — no quotes, no punctuation at the end beyond a period.`;
}

function buildTopicsPrompt(repo, corpus, rubricContext) {
  const verticals = Object.keys((rubricContext?.vertical_weights || {})).slice(0, 8);
  return `Suggest GitHub topics/labels for this repository: ${repo.name}
Description: ${repo.description || 'none'}
Language: ${repo.primary_language || 'unknown'}
Current topics: ${(repo.topics || []).join(', ') || 'none'}
Target verticals: ${verticals.join(', ')}

Return ONLY a JSON array of 4-6 topic strings (lowercase, hyphenated, no spaces):
["topic-one", "topic-two", ...]

Topics should be: discoverable, aligned with Mitchell's target roles, and standard GitHub convention.`;
}

function buildProfileReadmePrompt(profile, corpus, pinnedRepos, rubricContext) {
  const hints = (rubricContext?.must_haves || []).slice(0, 5)
    .map(m => `- ${m.claim}`).join('\n') || '- Clear professional headline\n- AI/agent builder narrative\n- Link to portfolio\n- Recent work highlights';

  return `You are writing Mitchell Williams's GitHub profile README (github.com/mitwilli-create).
This is the #1 hiring signal surface — it loads first when any recruiter or hiring manager visits his profile.

## Current bio: ${profile.bio || '(empty)'}
## Portfolio: ${profile.blog || '(not set)'}
## Pinned repos: ${pinnedRepos.map(p => p.name).join(', ') || 'none pinned'}

## What recruiters for his target roles want to see:
${hints}

## Mitchell's background:
${corpus.cv.slice(0, 3000)}

## Article digest / proof points:
${corpus.articleDigest.slice(0, 2000)}

## Voice reference:
${corpus.voiceReference.slice(0, 2000)}

## Requirements:
1. Open with a confident, specific headline — who Mitchell is and what he builds (NOT "I'm a developer who...")
2. Show the AI+comms combination clearly — this is his unique positioning
3. Highlight 2-3 concrete projects with REAL outcomes (from corpus above only)
4. Include a "Currently building" or "Recent work" section
5. Link to portfolio (${profile.blog || 'https://storytellermitch.com'})
6. Write in Mitchell's voice — no corporate buzzwords, direct, builder-oriented
7. Keep under 500 words
8. Return ONLY the markdown — no preamble, no explanation`;
}

function buildBioPrompt(profile, corpus) {
  return `Write a GitHub bio (140 chars max) for Mitchell Williams.

Current bio: "${profile.bio || '(empty)'}"

Mitchell's positioning:
- Senior media professional (Google, Al Jazeera, HuffPost Live) pivoting to AI
- Builds production AI agents and automation systems
- Target roles: AI PgM, Comms + AI, Applied AI, Solutions Architecture
- Portfolio: ${profile.blog || 'storytellermitch.com'}

Voice: Direct, builder-forward. No buzzwords. No "passionate about" phrasing.

Return ONLY the bio text (under 140 chars) — no quotes, no explanation.`;
}

/* ─────────────────────── Main generateArtifact ──────────────────────────── */

/**
 * Generate one artifact for one audit recommendation.
 *
 * @param {{ recommendation: object, inventory: object, corpus: object }} ctx
 * @returns {Promise<{ kind: string, content: string, claims_grounded: boolean, model_cost_usd: number }>}
 */
export async function generateArtifact(ctx) {
  const { recommendation, inventory } = ctx;
  const corpus = ctx.corpus && Object.keys(ctx.corpus).length > 0 ? ctx.corpus : loadCorpus();
  const rubricContext = ctx.rubric || null;

  if (!recommendation) throw new Error('generateArtifact: recommendation is required');

  const scope = recommendation.scope;
  const target = recommendation.target;
  const kind = recommendation.recommendation;

  emit({ step: 'start', scope, target, kind });

  const repo = (inventory?.repos || []).find(r => r.full_name === target || r.name === target);

  let prompt = '';
  let model = SONNET;

  if (scope === 'profile' || target === 'profile') {
    if (kind === 'REWRITE-README' || kind === 'RESTRUCTURE') {
      model = OPUS;
      prompt = buildProfileReadmePrompt(
        inventory.profile, corpus, inventory.pinned_repos || [], rubricContext
      );
    } else {
      model = OPUS;
      prompt = buildBioPrompt(inventory.profile, corpus);
    }
  } else if (repo) {
    const findings = recommendation.findings || [];
    if (kind === 'REWRITE-README' || kind === 'ADD-DOCS') {
      model = SONNET;
      prompt = buildReadmePrompt(repo, corpus, rubricContext, findings);
    } else if (kind === 'RESTRUCTURE') {
      model = SONNET;
      prompt = buildReadmePrompt(repo, corpus, rubricContext, findings);
    } else {
      model = SONNET;
      prompt = buildDescriptionPrompt(repo, corpus, findings);
    }
  } else {
    emit({ step: 'repo_not_found', target });
    return { kind: 'unknown', content: '', claims_grounded: false, model_cost_usd: 0 };
  }

  // Thread remediation prefix from regenerateWithRemediation if present
  const remediationPrefix = recommendation._remediation_prefix;
  if (remediationPrefix) {
    prompt = `## REMEDIATION INSTRUCTIONS (apply these before writing)\n${remediationPrefix}\n\n---\n\n${prompt}`;
    emit({ step: 'remediation_prefix_injected', chars: remediationPrefix.length });
  }

  const result = await callAnthropic({ model, prompt, maxTokens: 3000 });
  if (!result) {
    return { kind, content: '', claims_grounded: false, model_cost_usd: 0 };
  }

  // Claim-grounding check
  const ungrounded = preflightGroundingCheck(result.text, corpus);
  if (ungrounded.length > 0) {
    emit({ step: 'grounding_fail', ungrounded_count: ungrounded.length, examples: ungrounded.slice(0, 3) });
    return { kind, content: result.text, claims_grounded: false, ungrounded_claims: ungrounded, model_cost_usd: result.costUsd || 0 };
  }

  emit({ step: 'done', kind, cost_usd: result.costUsd, content_len: result.text.length });
  return { kind, content: result.text, claims_grounded: true, model_cost_usd: result.costUsd || 0 };
}

/**
 * Re-generate with targeted remediation after a gate failure.
 */
export async function regenerateWithRemediation(args) {
  const { originalArtifact, gateFailure, ctx } = args;
  const corpus = ctx.corpus && Object.keys(ctx.corpus).length > 0 ? ctx.corpus : loadCorpus();
  const { recommendation, inventory } = ctx;

  const failureModes = gateFailure?.failure_modes || [];
  const flaggedSentences = gateFailure?.flagged_sentences || [];

  const voiceFail = failureModes.includes('voice_match');
  const detectorFail = failureModes.includes('detector');
  const groundingFail = failureModes.includes('grounding');

  const remediationPrefix = [
    voiceFail ? `VOICE ISSUE: The previous draft didn't match Mitchell's writing style. Avoid: corporate language, passive voice, buzzwords ("leverage", "cutting-edge", "robust"), starting sentences with "I am" or "Mitchell is". Use: direct verbs, builder language, em-dashes, concrete specifics.` : '',
    detectorFail && flaggedSentences.length ? `AI DETECTION ISSUE: These specific sentences read as AI-generated and must be rewritten naturally:\n${flaggedSentences.slice(0, 3).map(s => `- "${s}"`).join('\n')}\nRewrite these in Mitchell's voice without these patterns.` : '',
    detectorFail ? `DETECTOR ISSUE: The previous draft scored as AI-generated. Use shorter sentences, more specific language, and Mitchell's natural directness.` : '',
    groundingFail ? `GROUNDING ISSUE: Remove or qualify any specific metrics (numbers, percentages) not traceable to his resume or article digest.` : '',
  ].filter(Boolean).join('\n\n');

  const originalPrompt = originalArtifact?.prompt || '';
  const remediatedCtx = {
    ...ctx,
    corpus,
    recommendation: {
      ...recommendation,
      _remediation_prefix: remediationPrefix,
    },
  };

  emit({ step: 'remediation', failure_modes: failureModes });
  return generateArtifact(remediatedCtx);
}
