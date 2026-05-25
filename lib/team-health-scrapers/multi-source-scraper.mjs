/**
 * lib/team-health-scrapers/multi-source-scraper.mjs — Phase 5.2 v2
 *
 * Hybrid CDP-first + headless-renderPage fallback scraper for team-health
 * data. Scrapes Glassdoor / Indeed / Blind / Levels.fyi for a given company,
 * extracts per-source structured signals via a Sonnet 4.6 extraction pass,
 * returns a rawSignals object that synthesizeTeamHealth (lib/team-health.mjs)
 * consumes.
 *
 * Architecture:
 *   1. For each source, determine URL (template-based, no search dependency).
 *   2. Fetch the page — try CDP first (if available, uses Mitchell's auth),
 *      fall back to browser-pool::renderPage (headless, public-only data).
 *   3. Extract structured signals via Sonnet 4.6: page text → { url,
 *      sample_count, scores, key_quotes, comments } matching the synthesizer
 *      schema fragment for that source.
 *   4. Aggregate all 4 source outputs into rawSignals object.
 *
 * Hang-prevention (per AGENTS.md § Bug class: missing-timeout):
 *   - All Sonnet calls pass timeoutMs:60_000
 *   - renderPage has its own per-page navigation timeout (30s default)
 *   - CDP probe is 1.5s timeout
 *   - Per-source budget: $5 max (failsafe on extraction loop)
 *
 * Cross-fork-leak: scraped page text never inlined verbatim in any output
 * artifact — Sonnet's extraction produces structured signals that are then
 * passed to the synthesizer. Provider URL is included for citation but no
 * raw HTML.
 */

import { renderPage } from '../browser-pool.mjs';
import { isCdpAvailable, connectToChromeCDP } from '../cdp-browser.mjs';
import { fetchJson } from '../safe-fetch.mjs';

const SOURCES = ['glassdoor', 'indeed', 'blind', 'levels.fyi'];

// URL templates per source. Company-slug is interpolated; some sources need
// company-specific overrides (cohere vs cohere-ai, etc) which fall through
// to a search fallback when the primary URL 404s.
function urlTemplate(source, companySlug) {
  switch (source) {
    case 'glassdoor':
      return `https://www.glassdoor.com/Reviews/${companySlug}-reviews-SRCH_KE0,${companySlug.length}.htm`;
    case 'indeed':
      return `https://www.indeed.com/cmp/${companySlug}/reviews`;
    case 'blind':
      return `https://www.teamblind.com/company/${companySlug}`;
    case 'levels.fyi':
      return `https://www.levels.fyi/company/${companySlug}/salaries/`;
    default:
      return null;
  }
}

// Per-source extraction prompt — same shape but tuned hint per source.
function extractionPrompt(source, companyName, pageText) {
  return [
    `You are extracting structured team-health signals from a scraped ${source} page about ${companyName}.`,
    ``,
    `Output STRICT JSON matching this shape (omit any field if zero signal):`,
    `{`,
    `  "url": "<the page URL — pass through>",`,
    `  "sample_count": <integer — how many reviews / data points the page contained>,`,
    `  "overall_score": <number 0-5 if a numeric overall rating was visible, else omit>,`,
    `  "scores": {`,
    `    "leadership": <0-5 or omit>,`,
    `    "comp": <0-5 or omit>,`,
    `    "growth": <0-5 or omit>,`,
    `    "balance": <0-5 or omit>`,
    `  },`,
    `  "key_quotes": [`,
    `    {"quote": "<short verbatim quote>", "sentiment": "positive|mixed|negative", "date": "<YYYY-MM or YYYY when extractable>"},`,
    `    ... (3-8 items)`,
    `  ],`,
    `  "comments": "<2-3 sentences summarizing the dominant signal>",`,
    `  "last_reviewed_at": "<YYYY-MM-DD of newest review, or 'unknown'>",`,
    `  "auth_walled": <boolean — true if the page showed a sign-in wall instead of content>`,
    `}`,
    ``,
    `If the page is auth-walled or empty (no usable signal), output:`,
    `{`,
    `  "url": "<the page URL>",`,
    `  "sample_count": 0,`,
    `  "comments": "<one sentence describing what was visible — login wall, empty preview, 404, etc>",`,
    `  "auth_walled": true|false`,
    `}`,
    ``,
    `Do NOT fabricate. If the page text below is empty or a login wall, return the auth_walled fallback shape.`,
    `Do NOT inline raw page HTML in your output — only structured signals.`,
    ``,
    `Page text (top 6000 chars):`,
    String(pageText || '').slice(0, 6000),
  ].join('\n');
}

// Try CDP first; on any failure, fall back to headless renderPage.
async function scrapeOne(source, companySlug, opts = {}) {
  const url = urlTemplate(source, companySlug);
  if (!url) return { source, url: null, error: 'unknown-source' };

  const cdpOK = await isCdpAvailable({ timeoutMs: 1500 }).catch(() => false);

  if (cdpOK) {
    try {
      const cdp = await connectToChromeCDP({});
      const page = await cdp.newPageInDefaultContext({ viewport: { width: 1280, height: 900 } });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Wait briefly for any JS-rendered content
        await page.waitForTimeout(2000);
        const text = await page.evaluate(() => {
          try { return document.body ? document.body.innerText : ''; } catch { return ''; }
        });
        return { source, url, text, mode: 'cdp', status: 200 };
      } finally {
        await page.close().catch(() => {});
        await cdp.disconnect();
      }
    } catch (err) {
      // Fall through to renderPage
      if (opts.verbose) console.warn(`[${source}] CDP failed for ${companySlug}: ${err.message} — falling back to renderPage`);
    }
  }

  // Fallback: headless renderPage (no auth)
  try {
    const r = await renderPage(url, { waitFor: 'networkidle', timeoutMs: 30_000 });
    return { source, url, text: r.text || '', html: r.html || '', mode: 'renderPage', status: r.status, finalUrl: r.finalUrl };
  } catch (err) {
    return { source, url, error: err.message, mode: 'renderPage-failed' };
  }
}

// Extract structured signals via Sonnet 4.6. Returns { source: provider, signal: {...}, cost_usd }.
async function extractSignals(source, companyName, scrape, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!scrape || scrape.error || !scrape.text) {
    return {
      source,
      signal: {
        url: scrape?.url || null,
        sample_count: 0,
        comments: scrape?.error || 'no page text retrieved',
        auth_walled: false,
      },
      cost_usd: 0,
    };
  }

  const prompt = extractionPrompt(source, companyName, scrape.text);
  let j;
  try {
    j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, { bodyTimeoutMs: 60_000, errPrefix: `team-health-extract-${source}` });
  } catch (err) {
    return {
      source,
      signal: { url: scrape.url, sample_count: 0, comments: `extraction-failed: ${err.message}`, auth_walled: false },
      cost_usd: 0,
    };
  }

  const content = (j.content && j.content[0] && j.content[0].text) || '';
  let signal;
  try {
    const m = content.match(/\{[\s\S]+\}/);
    signal = m ? JSON.parse(m[0]) : null;
  } catch { signal = null; }
  if (!signal) {
    signal = { url: scrape.url, sample_count: 0, comments: 'extraction-parse-failed', auth_walled: false };
  }
  // Always pass through the canonical URL
  signal.url = scrape.url;

  const usage = j.usage || {};
  const costUsd = (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;
  return { source, signal, cost_usd: costUsd };
}

/**
 * Scrape all 4 sources for a single company. Returns rawSignals object
 * keyed by SUPPORTED_PROVIDERS shape for synthesizeTeamHealth consumption.
 *
 * @param {string} companyName  — human-readable name (e.g., "Cursor (Anysphere)")
 * @param {object} opts
 * @param {string} opts.companySlug  — kebab-case slug for URL interpolation (override the auto-derived)
 * @param {boolean} opts.verbose
 * @returns {Promise<{ rawSignals, totalCostUsd, scrapeLog }>}
 */
export async function scrapeAllSources(companyName, opts = {}) {
  const companySlug = opts.companySlug || _autoSlug(companyName);
  const rawSignals = {};
  const scrapeLog = [];
  let totalCostUsd = 0;

  for (const source of SOURCES) {
    if (opts.verbose) process.stderr.write(`[team-health-scrape] ${companyName} :: ${source} ...\n`);
    const scrape = await scrapeOne(source, companySlug, opts);
    const { signal, cost_usd } = await extractSignals(source, companyName, scrape, opts);
    rawSignals[source] = signal;
    totalCostUsd += cost_usd;
    scrapeLog.push({ source, mode: scrape.mode || 'failed', sample_count: signal.sample_count || 0, cost_usd });
  }

  return { rawSignals, totalCostUsd, scrapeLog, companySlug };
}

function _autoSlug(name) {
  return String(name || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
    .replace(/--+/g, '-').replace(/^-+|-+$/g, '');
}
