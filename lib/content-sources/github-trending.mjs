// GitHub trending repos source — uses gh CLI (already auth'd) to surface
// AI/ML/LLM-related trending repos for Wednesday articles + Thursday tips.
//
// Mitchell's Q4 maximal-sources answer + Q5 all-mitwilli-create-repos answer
// (2026-05-27 interview). GitHub trending is the canonical signal for "what
// AI builders are starring/forking this week" which feeds the tips & tricks
// research synthesis in PR-C.
//
// Returns shape: { ts, source, items: [...] } where each item is
// { name, url, description, language, stars_added, total_stars, topics }.
//
// Implementation note: GitHub's trending page (https://github.com/trending)
// does not have an official API. We use the gh CLI search-repos API with
// date-bounded created/pushed filters to approximate "trending this week".

import { execSync } from 'child_process';

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_LOOKBACK_DAYS = 7;

const AI_TOPICS = ['ai', 'llm', 'agent', 'mcp', 'rag', 'embeddings', 'evaluation', 'prompt-engineering', 'fine-tuning', 'multimodal', 'reasoning'];

export async function scrapeGitHubTrending({
  maxItems = DEFAULT_MAX_ITEMS,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  topics = AI_TOPICS,
} = {}) {
  const startTime = Date.now();
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);

  // gh search repos does not support OR-joined topics in the positional QUERY.
  // Use --topic flags (which are AND semantics in gh CLI), and to widen to OR
  // we'd need N separate searches. Pragmatic v1: search by `topic:ai` (the
  // broadest AI catch-all topic) + a few keyword-style filters. PR-D follow-up
  // can do N parallel searches per topic + merge.
  const query = `topic:ai pushed:>=${since} stars:>50`;

  let raw;
  try {
    // `topics` is NOT a valid --json field for `gh search repos` (verified
     // 2026-05-27); to enrich with topics we'd need a per-repo `gh repo view`
     // pass — deferred to PR-D. For now we ship without topics in the output.
    const cmd = `gh search repos --json fullName,url,description,language,stargazersCount --limit ${maxItems * 2} --sort stars --order desc -- ${JSON.stringify(query)}`;
    raw = execSync(cmd, { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'github-trending',
      items: [],
      error: `gh_search_failed: ${err.message?.slice(0, 200) || 'unknown'}`,
      elapsed_ms: Date.now() - startTime,
    };
  }

  let repos;
  try {
    repos = JSON.parse(raw);
    if (!Array.isArray(repos)) throw new Error('not_an_array');
  } catch (err) {
    return {
      ts: new Date().toISOString(),
      source: 'github-trending',
      items: [],
      error: `parse_failed: ${err.message}`,
      elapsed_ms: Date.now() - startTime,
    };
  }

  const items = repos.slice(0, maxItems).map(r => ({
    name: r.fullName,
    url: r.url,
    description: r.description || '',
    language: r.language || '',
    total_stars: r.stargazersCount || 0,
    topics: [], // see comment above — deferred to PR-D
    stars_added_window: null,
  }));

  return {
    ts: new Date().toISOString(),
    source: 'github-trending',
    query,
    items,
    elapsed_ms: Date.now() - startTime,
    cost_usd: 0,
  };
}
