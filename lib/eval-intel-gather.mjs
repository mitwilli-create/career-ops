/**
 * lib/eval-intel-gather.mjs — Pre-evaluation intel pack collector.
 *
 * For each Phase 3b survivor, fans out 6 parallel intel queries and assembles
 * the result into a structured pack that the council of models consumes.
 * Each source is best-effort — a missing source degrades gracefully without
 * failing the whole pack.
 *
 * Intel sources (all parallel):
 *   1. JD verification        — primary URL HTTP fetch + page text
 *   2. Cross-surface check    — same role on alt sources (LinkedIn / company page) — flag discrepancies
 *   3. Grok current intel     — recent news, leadership, layoffs, X sentiment via scripts/grok-research.mjs hook
 *   4. Comp reconciliation    — Levels.fyi / Glassdoor lookups (best-effort, often blocked)
 *   5. Outcome priors         — applications.md lookup: prior evals at this company + their outcomes
 *   6. Proof-point extraction — cv.md + article-digest.md spans that match the JD's named requirements
 *   7. Network signal         — LinkedIn 1st/2nd-degree at this company (from lib/linkedin-network.mjs)
 *
 * Returns:
 *   {
 *     url, company, role, fetched_at,
 *     jd: { text, status, source_url, alive },
 *     cross_surface: { sources_checked, discrepancies },
 *     grok: { text, query, timestamp },
 *     comp: { jd_band, levels_fyi, glassdoor, reconciled_estimate },
 *     priors: { count, by_status, recent_outcomes },
 *     proof_points: { cv_md_lines, article_digest_lines, claims },
 *     network: { first_degree, second_degree, warm_intro_paths },
 *     issues: [...]   // soft warnings, never fatal
 *   }
 *
 * Usage from eval-council.mjs or phase3b-evaluator.mjs:
 *   import { gatherIntel } from './lib/eval-intel-gather.mjs';
 *   const pack = await gatherIntel({ url, company, role });
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// Load .env for API keys (Grok, Anthropic, Gemini). override:true because
// Mitchell's shell pre-sets ANTHROPIC_API_KEY to empty string.
try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });
} catch { /* dotenv optional */ }

import { networkSummary } from './linkedin-network.mjs';
import { renderPage as renderPageInBrowser } from './browser-pool.mjs';
import { scoreJDCoverage } from './jd-coverage-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── SPA-host allowlist ────────────────────────────────────────────────────
// Hosts known to ship JD content via client-side XHR. For these, skip plain
// fetch() and go straight to Playwright. Other hosts: fetch() first,
// Playwright as fallback if coverage scoring marks WEAK or FAIL.
const SPA_HOST_PATTERNS = [
  /(?:^|\.)ashbyhq\.com$/i,
  /(?:^|\.)workable\.com$/i,
  /(?:^|\.)lever\.co$/i,
  /(?:^|\.)jobs\.lever\.co$/i,
  /(?:^|\.)greenhouse\.io$/i,
  /(?:^|\.)boards\.greenhouse\.io$/i,
  /(?:^|\.)job-boards\.greenhouse\.io$/i,
  /(?:^|\.)smartrecruiters\.com$/i,
  /(?:^|\.)icims\.com$/i,
  /(?:^|\.)workdayjobs\.com$/i,
  /(?:^|\.)myworkdayjobs\.com$/i,
  /(?:^|\.)jobvite\.com$/i,
  /(?:^|\.)wellfound\.com$/i,
  /(?:^|\.)builtin\.com$/i,
];
const SPA_URL_PATTERNS = [/\blinkedin\.com\/jobs\//i];
function isSpaHost(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  if (SPA_HOST_PATTERNS.some((re) => re.test(host))) return true;
  if (SPA_URL_PATTERNS.some((re) => re.test(url))) return true;
  return false;
}
function looksLikeCloudflareChallenge(html) {
  if (!html) return false;
  return (
    /cf-chl-/i.test(html) ||
    /challenge-platform/i.test(html) ||
    /<title>\s*just a moment\.{3}\s*<\/title>/i.test(html)
  );
}
const ROOT = join(__dirname, '..');

// ── 1. JD fetch ────────────────────────────────────────────────────────────
// Three-layer scrape pipeline:
//   1. Plain fetch() — static-HTML hosts. Skipped for SPA-allowlisted hosts.
//   2. Coverage scoring via jd-coverage-check.mjs → GOOD / WEAK / FAIL.
//   3. Playwright fallback via browser-pool.mjs when verdict != GOOD or host is SPA.
// Audit trail: scrape_method, raw_char_count, coverage_score, coverage_verdict,
// sections_found, scraped_at all flow back in the returned object.
// FAIL verdict after both attempts → alive=false, error='JD_SCRAPE_FAILED' so
// the caller (phase3b-evaluator) can skip the LLM call and auto-queue for
// re-scrape instead of emitting a confidently-low-quality eval.

const STATIC_TEXT_CAP   = 18_000;
const RENDERED_TEXT_CAP = 30_000;
const DEAD_SIGNAL_RE = /(no longer accepting|position has been filled|posting (?:has expired|is closed)|this role is no longer available)/i;

function _stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function _fetchPlain(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 career-ops-eval/2.0' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const html = await res.text();
    return { status: res.status, finalUrl: res.url, html, ok: res.ok };
  } finally { clearTimeout(t); }
}

export async function fetchJD(url, { timeoutMs = 15000 } = {}) {
  const scraped_at = new Date().toISOString();

  // Path A: try plain fetch first (skip for SPA-allowlisted hosts).
  let plainText = '', plainStatus = 0, plainUrl = url, plainErr = null;
  if (!isSpaHost(url)) {
    try {
      const r = await _fetchPlain(url, timeoutMs);
      plainStatus = r.status;
      plainUrl    = r.finalUrl || url;
      if (!looksLikeCloudflareChallenge(r.html)) plainText = _stripHtmlToText(r.html);
    } catch (err) { plainErr = err.message || String(err); }
  }
  if (plainText) {
    const cov = scoreJDCoverage(plainText);
    if (cov.verdict === 'GOOD') {
      const deadSignal = DEAD_SIGNAL_RE.test(plainText);
      return {
        text: plainText.slice(0, STATIC_TEXT_CAP),
        status: plainStatus, source_url: plainUrl,
        alive: (plainStatus >= 200 && plainStatus < 400) && !deadSignal,
        dead_signal_in_body: deadSignal,
        scrape_method: 'fetch', raw_char_count: plainText.length,
        coverage_score: cov.coverage_score, coverage_verdict: cov.verdict,
        coverage_reason: cov.reason, sections_found: cov.sections_found,
        prose_word_count: cov.prose_word_count, scraped_at,
      };
    }
  }

  // Path B: Playwright render.
  let renderResult = null, renderErr = null;
  try {
    renderResult = await renderPageInBrowser(url, { waitFor: 'networkidle', timeoutMs: Math.max(timeoutMs, 30_000) });
  } catch (err) { renderErr = err.message || String(err); }

  if (renderResult && renderResult.text) {
    const cov = scoreJDCoverage(renderResult.text);
    const deadSignal = DEAD_SIGNAL_RE.test(renderResult.text);
    const scrape_method = plainText ? 'fetch+playwright' : 'playwright';
    const status = renderResult.status || plainStatus || 0;
    const finalUrl = renderResult.finalUrl || plainUrl;
    if (cov.verdict === 'FAIL') {
      return {
        text: renderResult.text.slice(0, RENDERED_TEXT_CAP),
        status, source_url: finalUrl,
        alive: false, error: 'JD_SCRAPE_FAILED',
        dead_signal_in_body: deadSignal,
        scrape_method, raw_char_count: renderResult.text.length,
        coverage_score: cov.coverage_score, coverage_verdict: cov.verdict,
        coverage_reason: cov.reason, sections_found: cov.sections_found,
        prose_word_count: cov.prose_word_count, shell_signals: cov.shell_signals,
        scraped_at,
      };
    }
    return {
      text: renderResult.text.slice(0, RENDERED_TEXT_CAP),
      status, source_url: finalUrl,
      alive: (status >= 200 && status < 400) && !deadSignal,
      dead_signal_in_body: deadSignal,
      scrape_method, raw_char_count: renderResult.text.length,
      coverage_score: cov.coverage_score, coverage_verdict: cov.verdict,
      coverage_reason: cov.reason, sections_found: cov.sections_found,
      prose_word_count: cov.prose_word_count, scraped_at,
    };
  }

  // Path C: both layers failed.
  const fb = plainText || '';
  const fbCov = fb ? scoreJDCoverage(fb) : { verdict: 'FAIL', coverage_score: 0, reason: 'No content from either fetch or Playwright', sections_found: [], prose_word_count: 0, shell_signals: [] };
  return {
    text: fb.slice(0, STATIC_TEXT_CAP),
    status: plainStatus, source_url: plainUrl,
    alive: false, error: renderErr || plainErr || 'JD_SCRAPE_FAILED',
    dead_signal_in_body: fb ? DEAD_SIGNAL_RE.test(fb) : false,
    scrape_method: plainText ? 'fetch+playwright(fail)' : 'playwright(fail)',
    raw_char_count: fb.length,
    coverage_score: fbCov.coverage_score, coverage_verdict: fbCov.verdict,
    coverage_reason: fbCov.reason, sections_found: fbCov.sections_found || [],
    prose_word_count: fbCov.prose_word_count || 0, shell_signals: fbCov.shell_signals || [],
    scraped_at,
  };
}

// ── 2. Cross-surface check ────────────────────────────────────────────────
// Same role often appears on Greenhouse/Ashby/Lever plus LinkedIn plus the
// company's own careers page. Try to derive alt URLs from the primary URL,
// fetch each, and flag discrepancies in title/comp/location.
async function crossSurfaceCheck(primaryUrl, role, jdText) {
  const sourcesChecked = [primaryUrl];
  const discrepancies = [];
  // Heuristic: if the primary URL is on greenhouse/ashby/lever, the company's
  // own page often mirrors at company.com/careers or jobs.{company}.com.
  // For now we just log the primary as the single source; deeper cross-
  // surface checking is a Phase 4 enhancement.
  return { sources_checked: sourcesChecked, discrepancies };
}

// ── 3. Grok current intel ─────────────────────────────────────────────────
// Brief, focused query about this specific company + role. Different from the
// daily scripts/grok-research.mjs (which is broad market intel) — this is a
// targeted ~$0.10 call per survivor. Falls back to empty pack if XAI_API_KEY
// not set or the daily Grok cap has been hit.
async function fetchGrokIntel({ company, role, jdText }) {
  if (!process.env.XAI_API_KEY) {
    return { text: '', query: '', skipped: 'XAI_API_KEY not set' };
  }
  const query = `Quick brief on ${company} for a job-search evaluation:
1. Recent news / leadership changes / layoffs in the past 90 days?
2. Funding stage and runway signals?
3. Sentiment among employees on X / Blind / Glassdoor (only post-2024)?
4. Anything specific about the "${role}" team or hiring scope?
Be concise (under 200 words). Cite sources where possible.`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    const res = await fetch('https://api.x.ai/v1/responses', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:        process.env.XAI_MODEL || 'grok-4-fast-reasoning',
        input:        query,
        max_output_tokens: 800,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { text: '', query, error: `Grok HTTP ${res.status}` };
    const data = await res.json();
    let text = data.output_text || '';
    if (!text && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) if (c.type === 'output_text' && c.text) text += c.text;
        }
      }
    }
    return { text: text.slice(0, 2000), query, timestamp: new Date().toISOString() };
  } catch (err) {
    return { text: '', query, error: err.message };
  }
}

// ── 4. Comp reconciliation ────────────────────────────────────────────────
// Pull comp signal from multiple sources, flag discrepancies. Levels.fyi and
// Glassdoor often block direct fetches; this is a best-effort try with
// graceful fallback to "JD band only."
async function reconcileComp({ jdText, company, role }) {
  // Pull comp range from JD if present (common pattern: "$X – $Y" or "X-Y")
  const compMatch = jdText.match(/\$\s*([\d,]+)\s*[-–]\s*\$?\s*([\d,]+)/);
  const jdBand = compMatch
    ? { low: parseInt(compMatch[1].replace(/,/g, ''), 10), high: parseInt(compMatch[2].replace(/,/g, ''), 10), raw: compMatch[0] }
    : null;
  // Levels.fyi / Glassdoor scraping is fragile and frequently rate-limited.
  // Stub for now — Phase 4 wires real lookups via Chrome MCP.
  return {
    jd_band:             jdBand,
    levels_fyi:          { status: 'not implemented', value: null },
    glassdoor:           { status: 'not implemented', value: null },
    reconciled_estimate: jdBand ? `JD: $${jdBand.low.toLocaleString()}–$${jdBand.high.toLocaleString()} (no external corroboration)` : 'comp not disclosed in JD',
  };
}

// ── 5. Outcome priors ─────────────────────────────────────────────────────
// Query applications.md for prior evals at the same company. Returns a
// summary: how many evals, by status, and the most-recent 3 outcomes.
function getOutcomePriors(company) {
  const trackerPath = join(ROOT, 'data/applications.md');
  if (!existsSync(trackerPath)) return { count: 0, by_status: {}, recent_outcomes: [], note: 'tracker not found' };
  const text = readFileSync(trackerPath, 'utf-8');
  const lines = text.split('\n').filter(l => l.startsWith('| ') && !l.includes('| # |'));
  const matches = [];
  const norm = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const l of lines) {
    const cols = l.split('|').map(c => c.trim());
    if (cols.length < 10) continue;
    const rowCompany = (cols[3] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!rowCompany.includes(norm) && !norm.includes(rowCompany)) continue;
    matches.push({
      num:    cols[1],
      date:   cols[2],
      role:   cols[4],
      score:  cols[5],
      status: cols[6],
      notes:  cols[9]?.slice(0, 200) || '',
    });
  }
  const byStatus = {};
  for (const m of matches) byStatus[m.status] = (byStatus[m.status] || 0) + 1;
  // Most-recent 3 by date
  const recent = matches
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 3);
  return { count: matches.length, by_status: byStatus, recent_outcomes: recent };
}

// ── 6. Proof-point extraction ─────────────────────────────────────────────
// Pull lines from cv.md + article-digest.md that match JD-named requirements.
// Returns claim-to-source spans the council can cite. Uses keyword overlap;
// not LLM-grade matching, but cheap and good enough for source pointers.
function extractProofPoints(jdText) {
  const cvPath = join(ROOT, 'cv.md');
  const digestPath = join(ROOT, 'article-digest.md');
  const proof = { cv_md_lines: [], article_digest_lines: [], claims: [] };

  // Extract keywords from JD: company names, tech terms, role keywords.
  // Simple noun-phrase heuristic — looks for capitalized 2-3 word phrases
  // and known tech/role terms.
  const jdLower = jdText.toLowerCase();
  const keywords = new Set();
  // Pull capitalized phrases (likely proper nouns / tech names)
  const caps = jdText.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g) || [];
  for (const c of caps) {
    if (c.length > 3 && c.length < 40) keywords.add(c.toLowerCase());
  }
  // Pull known tech/role keywords
  const TECH = ['python', 'typescript', 'node', 'javascript', 'react', 'agent', 'llm', 'rag', 'voice dna', 'forward deployed', 'fde', 'solutions architect', 'developer relations', 'devrel', 'evangelist', 'communications', 'editorial', 'enablement', 'ai-native', 'anthropic', 'openai', 'sonnet', 'opus', 'haiku', 'claude', 'gemini', 'grok', 'agentic'];
  for (const t of TECH) if (jdLower.includes(t)) keywords.add(t);

  // Scan cv.md and article-digest.md for keyword matches
  for (const [path, key] of [[cvPath, 'cv_md_lines'], [digestPath, 'article_digest_lines']]) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ll = line.toLowerCase();
      const hits = [...keywords].filter(k => ll.includes(k));
      if (hits.length >= 2) {  // require ≥2 keyword overlap to reduce noise
        proof[key].push({
          line:     i + 1,
          text:     line.trim().slice(0, 280),
          keywords: hits.slice(0, 6),
        });
      }
    }
  }
  return proof;
}

// ── 7. Network signal ─────────────────────────────────────────────────────
function networkAtCompany(company) {
  try {
    const summary = networkSummary(company);
    return {
      first_degree:       summary.firstDegreeCount,
      second_degree:      summary.secondDegreeCount,
      warm_intro_paths:   (summary.secondDegree || []).slice(0, 5).map(p => ({
        target_name: p.name,
        position:    p.title || '',
        mutual_count: (p.mutual_connections || []).length,
        mutuals_resolved: (p.mutuals_resolved || []).slice(0, 3).map(m => ({ name: m.name, position: m.position })),
      })),
    };
  } catch (err) {
    return { first_degree: 0, second_degree: 0, warm_intro_paths: [], error: err.message };
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────
/**
 * gatherIntel — run all 7 sources in parallel, assemble into pack.
 * @param {object} opts
 * @param {string} opts.url      — JD URL (primary source)
 * @param {string} opts.company  — company name for tracker/network lookup
 * @param {string} opts.role     — role title (helps with cross-surface + Grok)
 * @param {object} [opts.gates]  — { skipGrok, skipNetwork, ... } for testing
 * @returns {Promise<object>}    — intel pack
 */
export async function gatherIntel({ url, company, role, gates = {} }) {
  const startedAt = Date.now();
  const issues = [];

  // Step 1 — Fetch JD first (most other steps need it).
  const jd = await fetchJD(url);
  if (!jd.alive) issues.push(`JD fetch returned ${jd.status}; alive=false`);
  if (jd.error === 'JD_SCRAPE_FAILED') {
    issues.push(`JD_SCRAPE_FAILED: ${jd.coverage_reason} (method=${jd.scrape_method}, raw=${jd.raw_char_count}c, sections=${(jd.sections_found || []).length}/6)`);
  } else if (jd.coverage_verdict === 'WEAK') {
    issues.push(`JD coverage WEAK: ${jd.coverage_reason} (method=${jd.scrape_method}, score=${jd.coverage_score})`);
  }

  // Steps 2-7 in parallel.
  const [crossSurface, grok, comp, network] = await Promise.all([
    crossSurfaceCheck(url, role, jd.text),
    gates.skipGrok ? Promise.resolve({ skipped: 'gates.skipGrok' }) : fetchGrokIntel({ company, role, jdText: jd.text }),
    reconcileComp({ jdText: jd.text, company, role }),
    gates.skipNetwork ? Promise.resolve({ skipped: 'gates.skipNetwork' }) : Promise.resolve(networkAtCompany(company)),
  ]);

  // Steps 5-6 are sync — extract priors + proof points from local files.
  const priors = getOutcomePriors(company);
  const proofPoints = extractProofPoints(jd.text);

  if (grok.error) issues.push(`Grok intel: ${grok.error}`);
  if (priors.count > 5 && priors.by_status['Discarded']?.toString() > '3') {
    issues.push(`prior_outcomes_warn: ${priors.count} prior evals at ${company}, ${priors.by_status['Discarded']} discarded — pattern of misalignment`);
  }

  return {
    url,
    company,
    role,
    fetched_at:    new Date().toISOString(),
    elapsed_ms:    Date.now() - startedAt,
    jd,
    cross_surface: crossSurface,
    grok,
    comp,
    priors,
    proof_points:  proofPoints,
    network,
    issues,
  };
}

// CLI smoke test: node lib/eval-intel-gather.mjs <url> <company> <role>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , url, company, role] = process.argv;
  if (!url) {
    console.error('Usage: node lib/eval-intel-gather.mjs <url> <company> <role>');
    process.exit(1);
  }
  const pack = await gatherIntel({ url, company: company || 'Unknown', role: role || 'Unknown' });
  console.log(JSON.stringify(pack, null, 2));
}
