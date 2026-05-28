// Grok-4 X/Twitter chatter source — surfaces real-time AI-builder discussions
// from X/Twitter for Monday convos + ad-hoc real-time signals.
//
// Mitchell's Q4 maximal-sources answer + explicit "use grok and gpt as signals"
// directive (2026-05-27 interview) — Grok-4 is the canonical X-grounding model.
//
// Routes through lib/council.mjs callCouncil() with model `xai:grok-4` which
// has native X search grounding. Returns shape: { ts, source, items: [...] }
// where each item is { title, url, summary, author, score, posted_at }.

import { callCouncil } from '../council.mjs';

const GROK_X_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_ITEMS = 8;

const SYSTEM_PROMPT = `You are an AI-builder content curator. You will be given a search query and asked to find recent X/Twitter posts.

Return ONLY a JSON array (no prose, no markdown fence) of items matching this shape:
[
  {
    "title": "<concise headline for the post, max 90 chars>",
    "url": "<direct X.com link>",
    "summary": "<2-3 sentence summary of what the post says and why it's notable for an AI Forward Deployed Engineer / Solutions Architect / AI Program Manager job seeker targeting Anthropic / OpenAI / Perplexity / Cursor / Cognition>",
    "author": "<@handle>",
    "posted_at": "<ISO timestamp or relative like '6h ago'>",
    "score": "<approximate engagement signal: high/medium/low>"
  }
]

Constraints:
- Posts must be from the last 72 hours
- Skip pure promotional content; favor builder-perspective discussions, retro analyses, demos, technical critiques
- Avoid duplicates from the same author
- 5-10 items maximum
- If you cannot find good matches, return an empty array []`;

export async function scrapeGrokX({
  query,
  maxItems = DEFAULT_MAX_ITEMS,
  timeoutMs = GROK_X_TIMEOUT_MS,
} = {}) {
  if (!query) throw new Error('scrapeGrokX: query is required');

  const userPrompt = `Search X/Twitter for the most signal-rich recent posts about: ${query}

Return up to ${maxItems} items as the JSON array described in the system prompt. Posts must be from the last 72 hours.`;

  const startTime = Date.now();
  let result;
  try {
    result = await callCouncil({
      prompt: userPrompt,
      systemPrompt: SYSTEM_PROMPT,
      models: ['xai:grok-4'],
      opts: {
        timeoutMs,
        cacheCaller: 'content-sources:grok-x',
      },
    });
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'grok-x',
      query,
      items: [],
      error: `callCouncil_failed: ${err.message}`,
      elapsed_ms: Date.now() - startTime,
    };
  }

  const response = result?.responses?.[0];
  if (!response || response.error || !response.content) {
    return {
      ts: new Date().toISOString(),
      source: 'grok-x',
      query,
      items: [],
      error: response?.error || 'no_content',
      elapsed_ms: Date.now() - startTime,
    };
  }

  let items;
  try {
    const content = response.content.trim();
    const jsonStart = content.indexOf('[');
    const jsonEnd = content.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('no_json_array_found');
    items = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    if (!Array.isArray(items)) throw new Error('not_an_array');
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'grok-x',
      query,
      items: [],
      error: `parse_failed: ${err.message}`,
      raw_content: response.content.slice(0, 500),
      elapsed_ms: Date.now() - startTime,
    };
  }

  return {
    ts: new Date().toISOString(),
    source: 'grok-x',
    query,
    items: items.slice(0, maxItems),
    elapsed_ms: Date.now() - startTime,
    cost_usd: result.costUsd || 0,
  };
}
