// Perplexity sonar-reasoning-pro Reddit synthesis source.
//
// Mitchell's Q4 maximal-sources answer (2026-05-27 interview) — Perplexity is
// the canonical Reddit + cross-platform synthesis model (per Council OS KB).
// Used for Monday convos (r/MachineLearning, r/AI_Agents, r/LocalLLaMA,
// r/MLOps, r/AiBuilders, r/cscareerquestions, r/datascience, r/artificial).
//
// Routes through lib/council.mjs callCouncil() with model
// `perplexity:sonar-reasoning-pro`. Returns shape: { ts, source, items: [...] }
// where each item is { title, url, summary, subreddit, score, comments }.

import { callCouncil } from '../council.mjs';

const PERPLEXITY_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_ITEMS = 8;

const DEFAULT_SUBREDDITS = [
  'MachineLearning',
  'AI_Agents',
  'LocalLLaMA',
  'MLOps',
  'AiBuilders',
  'cscareerquestions',
  'datascience',
  'artificial',
  'singularity',
  'OpenAI',
];

const SYSTEM_PROMPT = `You are an AI-builder content curator. You will be given a search query and asked to find recent Reddit discussions across builder-focused subreddits.

Return ONLY a JSON array (no prose, no markdown fence) of items matching this shape:
[
  {
    "title": "<post title verbatim>",
    "url": "<direct reddit.com/r/<sub>/comments/... link>",
    "summary": "<3-5 sentence summary of what the post says + top-comment consensus, plus why it's notable for an AI Forward Deployed Engineer / Solutions Architect / AI Program Manager job seeker targeting Anthropic / OpenAI / Perplexity / Cursor / Cognition>",
    "subreddit": "<r/MachineLearning style>",
    "posted_at": "<relative like '6h ago' or ISO>",
    "score": "<upvotes if available, integer or string>",
    "comments": "<comment count if available, integer or string>"
  }
]

Constraints:
- Posts must be from the last 72 hours
- Skip help-me-debug-my-homework threads; favor architecture discussions, eval methodology, agentic patterns, hiring patterns, war stories, retrospectives, model-release impressions
- Avoid duplicates from the same author
- 5-10 items maximum
- If you cannot find good matches, return an empty array []`;

export async function scrapePerplexityReddit({
  query,
  subreddits = DEFAULT_SUBREDDITS,
  maxItems = DEFAULT_MAX_ITEMS,
  timeoutMs = PERPLEXITY_TIMEOUT_MS,
} = {}) {
  if (!query) throw new Error('scrapePerplexityReddit: query is required');

  const userPrompt = `Search Reddit across these builder-focused subreddits for the most signal-rich recent discussions: ${subreddits.map(s => `r/${s}`).join(', ')}

Topic: ${query}

Return up to ${maxItems} items as the JSON array described in the system prompt. Posts must be from the last 72 hours.`;

  const startTime = Date.now();
  let result;
  try {
    result = await callCouncil({
      prompt: userPrompt,
      systemPrompt: SYSTEM_PROMPT,
      models: ['perplexity:sonar-reasoning-pro'],
      opts: {
        timeoutMs,
        cacheCaller: 'content-sources:perplexity-reddit',
      },
    });
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'perplexity-reddit',
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
      source: 'perplexity-reddit',
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
      source: 'perplexity-reddit',
      query,
      items: [],
      error: `parse_failed: ${err.message}`,
      raw_content: response.content.slice(0, 500),
      elapsed_ms: Date.now() - startTime,
    };
  }

  return {
    ts: new Date().toISOString(),
    source: 'perplexity-reddit',
    query,
    items: items.slice(0, maxItems),
    elapsed_ms: Date.now() - startTime,
    cost_usd: result.costUsd || 0,
  };
}
