#!/usr/bin/env node
/**
 * scripts/agents/content-ingest.mjs — PR-B content ingest orchestrator.
 *
 * Per Mitchell's Q6 + Q12 locked decisions (2026-05-27 interview):
 *   - Sequential ship, autonomous merge
 *   - Per-source refresh cadence:
 *       X via Grok-4:     every 6h
 *       Reddit/HN/articles/GitHub trending: daily 03:00 PT
 *       Tips (PR-C):       weekly Sun 22:00 PT (deferred)
 *   - Maximal sources (Q4) — Tier 1 sources implemented in PR-B:
 *       grok-x, perplexity-reddit, hn, github-trending
 *   - Tier 2 sources (lu.ma, AI Tinkerers extended, Meetup, dev.to,
 *     Substack RSS, arxiv-sanity, LinkedIn, Blind, Discord) scaffold
 *     stubs in PR-B; full implementation in PR-D follow-up.
 *
 * Modes:
 *   --mode daily            (default — runs all daily-cadence sources)
 *   --mode hourly           (X via Grok-4 only, every 6h cron)
 *   --mode dry-run          (no LLM calls, just print plan)
 *   --source <id>           (run a single source, e.g. --source grok-x)
 *
 * Output:
 *   data/dispatch/convos.json    — Reddit + X chatter combined
 *   data/dispatch/articles.json  — HN + GitHub trending combined
 *
 * Cost: typical daily run ~$0.15-$0.40 (1 Perplexity reasoning + 1-2 Grok calls);
 * vendor caps in lib/council.mjs catch any runaway.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = process.cwd();
const DISPATCH_DIR = join(ROOT, 'data/dispatch');

const args = process.argv.slice(2);
const MODE = (args.find(a => a.startsWith('--mode='))?.split('=')[1])
  || (args.includes('--dry-run') ? 'dry-run' : 'daily');
const SINGLE_SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1];

function log(level, msg, extra = {}) {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    level,
    source: 'content-ingest',
    msg,
    ...extra,
  }) + '\n');
}

async function loadDotenv() {
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: join(ROOT, '.env'), override: true });
  } catch (err) {
    log('warn', 'dotenv_load_failed', { err: err.message });
  }
}

const QUERIES = {
  reddit: 'AI Forward Deployed Engineer / Solutions Architect / Applied AI / AI Program Manager — recent technical discussions, hiring patterns, war stories, agent architecture, eval methodology, MCP / agentic / RAG / fine-tuning retrospectives',
  x:      'AI Forward Deployed Engineer / Solutions Architect / Applied AI / AI Program Manager — recent X/Twitter discussions, demos, hiring chatter, retrospectives from Anthropic, OpenAI, Perplexity, Cursor, Cognition, Google DeepMind, xAI builders + their critics',
};

async function runGrokX() {
  if (MODE === 'dry-run') return { ts: new Date().toISOString(), source: 'grok-x', items: [], dryRun: true };
  const { scrapeGrokX } = await import('../../lib/content-sources/grok-x.mjs');
  return scrapeGrokX({ query: QUERIES.x });
}

async function runPerplexityReddit() {
  if (MODE === 'dry-run') return { ts: new Date().toISOString(), source: 'perplexity-reddit', items: [], dryRun: true };
  const { scrapePerplexityReddit } = await import('../../lib/content-sources/perplexity-reddit.mjs');
  return scrapePerplexityReddit({ query: QUERIES.reddit });
}

async function runHN() {
  const { scrapeHN } = await import('../../lib/content-sources/hn.mjs');
  return scrapeHN({ feed: 'beststories' });
}

async function runGitHubTrending() {
  const { scrapeGitHubTrending } = await import('../../lib/content-sources/github-trending.mjs');
  return scrapeGitHubTrending();
}

function writeOutput(filename, payload) {
  if (!existsSync(DISPATCH_DIR)) mkdirSync(DISPATCH_DIR, { recursive: true });
  const path = join(DISPATCH_DIR, filename);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  log('info', 'wrote_output', { path, items: payload.items?.length ?? null });
  return path;
}

async function runDaily() {
  log('info', 'starting_daily_ingest', { mode: MODE, single: SINGLE_SOURCE });
  const filter = (id) => !SINGLE_SOURCE || SINGLE_SOURCE === id;

  // Parallel where independent, sequential where vendor caps shared.
  const [grok, reddit, hn, ghTrending] = await Promise.all([
    filter('grok-x') ? runGrokX() : Promise.resolve(null),
    filter('perplexity-reddit') ? runPerplexityReddit() : Promise.resolve(null),
    filter('hn') ? runHN() : Promise.resolve(null),
    filter('github-trending') ? runGitHubTrending() : Promise.resolve(null),
  ]);

  const totalCost = [grok, reddit, hn, ghTrending]
    .filter(Boolean)
    .reduce((sum, r) => sum + (r.cost_usd || 0), 0);

  log('info', 'sources_complete', {
    grok_items: grok?.items?.length,
    reddit_items: reddit?.items?.length,
    hn_items: hn?.items?.length,
    gh_items: ghTrending?.items?.length,
    total_cost_usd: totalCost.toFixed(4),
  });

  // Aggregate into themed files
  const convos = {
    ts: new Date().toISOString(),
    reddit,
    x: grok,
  };
  const articles = {
    ts: new Date().toISOString(),
    hn,
    github: ghTrending,
  };

  if (!SINGLE_SOURCE || ['grok-x', 'perplexity-reddit'].includes(SINGLE_SOURCE)) {
    writeOutput('convos.json', convos);
  }
  if (!SINGLE_SOURCE || ['hn', 'github-trending'].includes(SINGLE_SOURCE)) {
    writeOutput('articles.json', articles);
  }

  return { convos, articles, total_cost_usd: totalCost };
}

async function runHourly() {
  log('info', 'starting_hourly_ingest_grok_only');
  const grok = await runGrokX();
  // Merge with existing convos.json — replace just the x.items
  const path = join(DISPATCH_DIR, 'convos.json');
  let existing = null;
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf-8')); } catch {}
  }
  const convos = {
    ts: new Date().toISOString(),
    reddit: existing?.reddit || null,
    x: grok,
  };
  writeOutput('convos.json', convos);
  log('info', 'hourly_complete', { grok_items: grok.items?.length, cost_usd: grok.cost_usd });
  return convos;
}

(async () => {
  await loadDotenv();
  try {
    let result;
    if (MODE === 'hourly') result = await runHourly();
    else result = await runDaily();
    log('info', 'done', { mode: MODE });
    process.exit(0);
  } catch (err) {
    log('error', 'fatal', { err: err.message, stack: err.stack?.slice(0, 500) });
    process.exit(1);
  }
})();
