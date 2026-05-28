// Hacker News content source — free public API, no auth needed.
//
// Mitchell's Q4 maximal-sources answer (2026-05-27 interview). HN is the
// canonical signal for AI engineering articles + retros + Show HN demos
// relevant to FDE / Solutions Architect / AI PgM positioning.
//
// API: https://github.com/HackerNews/API (free, no auth)
//   - topstories.json:  top 500 stories
//   - beststories.json: best stories in last 24h
//   - item/<id>.json:   per-item details
//
// Returns shape: { ts, source, items: [...] } where each item is
// { title, url, summary, author, posted_at, score, comments, hn_url }.

import { fetchJson } from '../safe-fetch.mjs';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HN_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ITEMS = 8;

// Match builder-relevant content based on title + URL hostname
const AI_KEYWORDS = /\b(ai|llm|gpt|claude|anthropic|openai|gemini|grok|perplexity|cursor|cognition|mcp|model context protocol|agent|agentic|rag|prompt|inference|embed|transformer|fine.?tun|eval|hallucin|context window|tool.use|forward.deploy|fde|solutions.architect|applied.ai|deepmind)\b/i;
const NOISE_KEYWORDS = /^(ask hn|tell hn|launch hn): /i;
const DEFAULT_HN_HOSTS = [
  'github.com',
  'arxiv.org',
  'huggingface.co',
  'anthropic.com',
  'openai.com',
  'deepmind.google',
  'simonwillison.net',
  'latent.space',
  'eugeneyan.com',
  'jackclark.net',
];

export async function scrapeHN({
  maxItems = DEFAULT_MAX_ITEMS,
  feed = 'beststories', // beststories | topstories | newstories
  windowHours = 72,
} = {}) {
  const startTime = Date.now();
  let storyIds;
  try {
    storyIds = await fetchJson(
      `${HN_API}/${feed}.json`,
      { signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS) },
      { bodyTimeoutMs: 10_000, errPrefix: 'hn-storyids' },
    );
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'hn',
      items: [],
      error: `fetch_storyids_failed: ${err.message}`,
      elapsed_ms: Date.now() - startTime,
    };
  }

  if (!Array.isArray(storyIds) || storyIds.length === 0) {
    return {
      ts: new Date().toISOString(),
      source: 'hn',
      items: [],
      error: 'empty_storyids',
      elapsed_ms: Date.now() - startTime,
    };
  }

  const items = [];
  const minPostedAt = Date.now() / 1000 - windowHours * 3600;
  const candidates = storyIds.slice(0, 80);

  for (const id of candidates) {
    if (items.length >= maxItems) break;
    let item;
    try {
      item = await fetchJson(
        `${HN_API}/item/${id}.json`,
        { signal: AbortSignal.timeout(HN_FETCH_TIMEOUT_MS) },
        { bodyTimeoutMs: 5_000, errPrefix: `hn-item-${id}` },
      );
    } catch (_) {
      continue;
    }
    if (!item || item.dead || item.deleted) continue;
    if (item.type !== 'story') continue;
    if (!item.title || !item.url) continue;
    if (item.time < minPostedAt) continue;
    if (NOISE_KEYWORDS.test(item.title)) continue;

    const titleMatch = AI_KEYWORDS.test(item.title);
    const hostMatch = DEFAULT_HN_HOSTS.some(host => item.url.includes(host));
    if (!titleMatch && !hostMatch) continue;

    items.push({
      title: item.title,
      url: item.url,
      summary: '', // HN has no summary — would need GPT pass to add one
      author: item.by,
      posted_at: new Date(item.time * 1000).toISOString(),
      score: item.score || 0,
      comments: item.descendants || 0,
      hn_url: `https://news.ycombinator.com/item?id=${item.id}`,
    });
  }

  return {
    ts: new Date().toISOString(),
    source: 'hn',
    feed,
    items,
    elapsed_ms: Date.now() - startTime,
    cost_usd: 0,
  };
}
