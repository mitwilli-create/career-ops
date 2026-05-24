/**
 * lib/jd-url-canonicalizer.mjs — JD URL canonicalization (LinkedIn → ATS canonical)
 *
 * Phase 3.1 of the 2026-05-22 master resolution prompt. Solves the
 * "LinkedIn-only url (canonical not resolved)" gate failure reason from
 * lib/apply-now-queue-gate.mjs.
 *
 * Phase 1.5-a (2026-05-23): added the title+company ATS fallback path
 * (`title-company-fallback`) for LinkedIn DOM changes that hide the Apply
 * button. Scrapes role title + company from LinkedIn, looks up the company
 * in a known ATS-host registry, fetches the ATS index, and fuzzy-matches the
 * title to recover the canonical URL.
 *
 * Exports:
 *   canonicalize(url, opts)        → { canonical, source, evidenceUrl, confidence, original }
 *   canonicalizeBatch(urls, opts)  → array of results (sequential per the project
 *                                    rule against parallel Playwright)
 *   isLinkedInJobUrl(url)          → boolean (quick check for the queue-gate caller)
 *   extractTitleAndCompany(page)   → { title, company } from a LinkedIn page DOM
 *   getAtsCandidatesForCompany(company) → ordered list of ATS index URLs to try
 *
 * Detection sources (ranked by confidence):
 *   'already-canonical'         (confidence 1.0)  — input is already a non-LinkedIn ATS URL
 *   'apply-link'                (confidence 0.95) — LinkedIn "Apply" button href extracted
 *   'ats-redirect'              (confidence 0.90) — LinkedIn redirected to a known ATS host
 *   'title-company-fallback'    (confidence 0.85) — title + company → ATS index fuzzy match
 *   'page-text'                 (confidence 0.70) — found canonical URL in LinkedIn page body
 *   'unresolved'                (confidence 0.0)  — could not resolve
 *
 * Known ATS hosts (suffix-matched in URL.hostname):
 *   greenhouse.io, ashbyhq.com, lever.co, workday.com, eightfold.ai,
 *   jobvite.com, smartrecruiters.com, icims.com, taleo.net, bamboohr.com,
 *   gem.com, oraclecloud.com, successfactors.com
 *
 * Why Playwright, not WebFetch: LinkedIn renders job postings client-side.
 * WebFetch returns a skeleton without the "Apply" button or any job content.
 * Playwright with the existing storage-state auth (data/linkedin-storage-state.json,
 * refreshable via scripts/setup-auth.mjs) sees the full page DOM.
 *
 * Project rule: Playwright runs are sequential, never parallel. Each URL takes
 * ~5-15s depending on LinkedIn hydration.
 *
 * Usage:
 *   import { canonicalize } from '../lib/jd-url-canonicalizer.mjs';
 *   const result = await canonicalize('https://www.linkedin.com/jobs/view/12345/');
 *   // → { canonical: 'https://job-boards.greenhouse.io/.../jobs/67890',
 *   //     source: 'apply-link', evidenceUrl: '...', confidence: 0.95,
 *   //     original: 'https://www.linkedin.com/jobs/view/12345/' }
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LINKEDIN_STORAGE_STATE = join(REPO_ROOT, 'data/linkedin-storage-state.json');

const KNOWN_ATS_HOSTS = [
  'greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.greenhouse.io',
  'ashbyhq.com',
  'jobs.ashbyhq.com',
  'lever.co',
  'jobs.lever.co',
  'workday.com',
  'myworkdayjobs.com',
  'eightfold.ai',
  'careers.eightfold.ai',
  'jobvite.com',
  'jobs.jobvite.com',
  'smartrecruiters.com',
  'careers.smartrecruiters.com',
  'icims.com',
  'taleo.net',
  'bamboohr.com',
  'jobs.gem.com',
  'oraclecloud.com',
  'successfactors.com',
];

const LINKEDIN_JOB_RE = /https?:\/\/(?:www\.)?linkedin\.com\/jobs\/(?:view|search)/i;

/** @param {string} url */
export function isLinkedInJobUrl(url) {
  return LINKEDIN_JOB_RE.test(String(url || ''));
}

/** @param {string} url */
function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** @param {string} url */
function isCanonicalAtsUrl(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  return KNOWN_ATS_HOSTS.some(ats => host === ats || host.endsWith('.' + ats));
}

/**
 * Quick URL classification without any network call.
 * @param {string} url
 * @returns {{ type: 'already-canonical' | 'linkedin' | 'unknown', host: string }}
 */
export function classifyUrl(url) {
  if (!url) return { type: 'unknown', host: '' };
  if (isLinkedInJobUrl(url)) return { type: 'linkedin', host: hostnameOf(url) };
  if (isCanonicalAtsUrl(url)) return { type: 'already-canonical', host: hostnameOf(url) };
  return { type: 'unknown', host: hostnameOf(url) };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ canonical: string|null, evidenceUrl: string }>}
 */
async function extractApplyDestination(page) {
  // Strategy 1: find a visible Apply button with an href pointing to a known ATS.
  const applyHref = await page.evaluate((atsHosts) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const isAtsHost = (href) => {
      try {
        const h = new URL(href).hostname;
        return atsHosts.some(a => h === a || h.endsWith('.' + a));
      } catch { return false; }
    };
    // Look for anchors that LOOK like an Apply CTA AND point to an ATS host.
    for (const a of anchors) {
      const text = (a.innerText || a.getAttribute('aria-label') || '').toLowerCase();
      const href = a.href;
      if (!href) continue;
      if (!isAtsHost(href)) continue;
      if (/apply|view\s+on\s+\w+|see\s+\w+\s+job/i.test(text)) return href;
    }
    // Fallback: any anchor pointing to a known ATS that's not in nav/footer.
    for (const a of anchors) {
      const href = a.href;
      if (!href || !isAtsHost(href)) continue;
      if (a.closest('nav, header, footer')) continue;
      const style = window.getComputedStyle(a);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      return href;
    }
    return null;
  }, KNOWN_ATS_HOSTS);

  if (applyHref) {
    return { canonical: applyHref, evidenceUrl: page.url() };
  }

  // Strategy 2: scan visible body text for any ATS URL.
  const textHref = await page.evaluate((atsHosts) => {
    const text = document.body?.innerText || '';
    const urlRe = /https?:\/\/[^\s<>"']+/g;
    const candidates = (text.match(urlRe) || []);
    for (const c of candidates) {
      try {
        const h = new URL(c).hostname;
        if (atsHosts.some(a => h === a || h.endsWith('.' + a))) return c;
      } catch { /* ignore */ }
    }
    return null;
  }, KNOWN_ATS_HOSTS);

  return { canonical: textHref || null, evidenceUrl: page.url() };
}

// ── Title + Company fallback (Phase 1.5-a, 2026-05-23) ──────────────────────
// LinkedIn occasionally changes its DOM such that the Apply button href is no
// longer reachable from the public job-view page. When that happens the 3
// existing paths (apply-link / ats-redirect / page-text) all fail, but the
// role title + company name are still extractable. This fallback uses them.

/**
 * Company → ordered list of ATS index-page URLs. The first that returns a
 * fuzzy-matching role title wins. Ordering matters: list the most-likely host
 * first (usually the one in `portals.example.yml` for that company).
 *
 * To extend: add a new entry. The KEY is the lowercased + whitespace-stripped
 * company name (so "LangChain" → "langchain", "Hume AI" → "humeai").
 *
 * For companies NOT in the map, `getAtsCandidatesForCompany()` also generates
 * speculative Greenhouse + Ashby URLs from a slug, in priority order.
 */
const COMPANY_TO_ATS = {
  // From portals.example.yml — keep in sync when adding companies there.
  anthropic: [
    'https://job-boards.greenhouse.io/anthropic',
    'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs',
  ],
  langchain: [
    'https://jobs.ashbyhq.com/langchain',
  ],
  ema: [
    // Not in portals.example.yml — Ema's careers page is at ema.co/careers,
    // which redirects to Ashby. Slug confirmed via WebFetch 2026-05-23.
    'https://jobs.ashbyhq.com/ema',
  ],
  openai: [
    'https://openai.com/careers/search',
  ],
  polyai: [
    'https://job-boards.eu.greenhouse.io/polyai',
    'https://boards-api.greenhouse.io/v1/boards/polyai/jobs',
  ],
  parloa: [
    'https://job-boards.eu.greenhouse.io/parloa',
    'https://boards-api.greenhouse.io/v1/boards/parloa/jobs',
  ],
  intercom: [
    'https://job-boards.greenhouse.io/intercom',
    'https://boards-api.greenhouse.io/v1/boards/intercom/jobs',
  ],
  humeai: [
    'https://job-boards.greenhouse.io/humeai',
  ],
  elevenlabs: [
    'https://jobs.ashbyhq.com/elevenlabs',
  ],
  deepgram: [
    'https://jobs.ashbyhq.com/deepgram',
  ],
  vapi: [
    'https://jobs.ashbyhq.com/vapi',
  ],
  blandai: [
    'https://jobs.ashbyhq.com/bland',
  ],
  bland: [
    'https://jobs.ashbyhq.com/bland',
  ],
  airtable: [
    'https://job-boards.greenhouse.io/airtable',
  ],
  vercel: [
    'https://job-boards.greenhouse.io/vercel',
  ],
  temporal: [
    'https://job-boards.greenhouse.io/temporal',
  ],
  arizeai: [
    'https://job-boards.greenhouse.io/arizeai',
  ],
  runpod: [
    'https://job-boards.greenhouse.io/runpod',
  ],
  coreweave: [
    'https://job-boards.greenhouse.io/coreweave',
  ],
  glean: [
    'https://job-boards.greenhouse.io/gleanwork',
  ],
};

/** Normalize a company name to a registry / slug key. */
function companyKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Return an ordered list of ATS index URL candidates for a given company.
 * @param {string} company
 * @returns {string[]}
 */
export function getAtsCandidatesForCompany(company) {
  const key = companyKey(company);
  if (!key) return [];
  const mapped = COMPANY_TO_ATS[key];
  if (mapped && mapped.length) return mapped;
  // Speculative fallbacks for unknown companies — most common AI / dev-tools
  // companies live on Greenhouse or Ashby with a slug = lowercased name.
  return [
    `https://job-boards.greenhouse.io/${key}`,
    `https://boards.greenhouse.io/${key}`,
    `https://jobs.ashbyhq.com/${key}`,
    `https://jobs.lever.co/${key}`,
  ];
}

/**
 * Extract role title + company from a LinkedIn job page. Uses multiple
 * fallback selectors per field because LinkedIn periodically restructures
 * the DOM.
 *
 * Returns `{ title: '', company: '' }` if neither could be found.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ title: string, company: string }>}
 */
export async function extractTitleAndCompany(page) {
  return page.evaluate(() => {
    function firstText(selectors) {
      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t) return t;
          }
        } catch { /* ignore bad selector */ }
      }
      return '';
    }

    const titleSelectors = [
      'h1.top-card-layout__title',
      'h1.t-24',
      'h1[data-test-job-title]',
      'h1.topcard__title',
      'h1.jobs-unified-top-card__job-title',
      '[data-test-job-title]',
      'section.top-card-layout h1',
      'main h1',
      'h1',
    ];

    const companySelectors = [
      'a.topcard__org-name-link',
      '.topcard__org-name-link',
      '[data-test-employer-name]',
      'a.jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      'span.topcard__flavor a',
      'span.topcard__flavor',
      '.jobs-poster__company',
      'section.top-card-layout a[data-tracking-control-name*="company"]',
    ];

    let title = firstText(titleSelectors);
    let company = firstText(companySelectors);

    // Fallback: scrape from <title> tag, format is usually
    //   "Company hiring Role in Location | LinkedIn"  OR
    //   "Role at Company | LinkedIn"
    if ((!title || !company) && document.title) {
      const docTitle = document.title.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
      const hiringMatch = docTitle.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+.+)?$/i);
      const atMatch = docTitle.match(/^(.+?)\s+at\s+(.+?)$/i);
      if (hiringMatch) {
        company = company || hiringMatch[1].trim();
        title = title || hiringMatch[2].trim();
      } else if (atMatch) {
        title = title || atMatch[1].trim();
        company = company || atMatch[2].trim();
      }
    }

    // og:title is sometimes the cleanest source (Company is in og:site_name).
    if (!title) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) title = (ogTitle.getAttribute('content') || '').trim();
    }

    return { title: title || '', company: company || '' };
  });
}

/**
 * Normalize a job title for fuzzy comparison:
 *   - lowercase
 *   - strip seniority prefixes ("senior", "staff", "principal", "lead", "sr.")
 *   - collapse whitespace, drop punctuation
 *   - strip parenthetical suffixes ("(remote)", "(US)")
 */
function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(senior|staff|principal|lead|sr\.?|jr\.?|junior)\b/g, ' ')
    .replace(/[^\w\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token-set Jaccard similarity (0–1). Symmetric, handles word reordering.
 * @param {string} a
 * @param {string} b
 */
function titleSimilarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(/\s+/).filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const uni = ta.size + tb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Scrape a candidate ATS index page and return all { title, href } pairs.
 * Supports Greenhouse JSON API, Greenhouse HTML index, Ashby HTML index,
 * and Lever HTML index. Falls through to a generic anchor scrape if shape
 * isn't recognized.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} atsIndexUrl
 * @param {number} timeoutMs
 * @returns {Promise<Array<{ title: string, href: string }>>}
 */
async function fetchAtsJobIndex(context, atsIndexUrl, timeoutMs) {
  // 1) Greenhouse API: returns JSON directly via fetch (no Playwright needed).
  if (/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs/.test(atsIndexUrl)) {
    try {
      const r = await fetch(atsIndexUrl, { signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)) });
      if (!r.ok) return [];
      const j = await r.json();
      const jobs = Array.isArray(j.jobs) ? j.jobs : [];
      return jobs.map(job => ({
        title: String(job.title || '').trim(),
        href: String(job.absolute_url || '').trim(),
      })).filter(p => p.title && p.href);
    } catch {
      return [];
    }
  }

  // 1b) Ashby SPA: their HTML page is a JS shell; use the public posting-API
  //     instead. Slug = the path segment after /jobs.ashbyhq.com/.
  const ashbyMatch = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i.exec(atsIndexUrl);
  if (ashbyMatch) {
    const slug = ashbyMatch[1];
    try {
      const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
      const r = await fetch(apiUrl, {
        signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
        headers: { 'user-agent': 'career-ops-canonicalizer/1.0 (+contact via repo)' },
      });
      if (!r.ok) return [];
      const j = await r.json();
      const jobs = Array.isArray(j.jobs) ? j.jobs : [];
      return jobs.map(job => ({
        title: String(job.title || '').trim(),
        href: String(job.jobUrl || job.applyUrl || '').trim(),
      })).filter(p => p.title && p.href);
    } catch {
      return [];
    }
  }

  // 2) Otherwise: render the page via Playwright (these are SPAs that need JS).
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    const resp = await page.goto(atsIndexUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!resp || resp.status() >= 400) return [];
    // Give the SPA a beat to hydrate (Ashby + Greenhouse-HTML are JS-rendered).
    await page.waitForTimeout(2500);

    const pairs = await page.evaluate(() => {
      const out = [];
      // Greenhouse HTML: <div class="opening"><a href="...">Title</a></div>
      // Greenhouse new template: <a class="cell" href="..."><h3>Title</h3>…</a>
      // Ashby: <a href="..."><h3>Title</h3></a> or <div class="job-posting-brief"><a>…
      // Lever: <a class="posting-title"><h5>Title</h5></a>
      // Workday: cards with <a>…
      const anchorSet = new Set();
      const allAnchors = Array.from(document.querySelectorAll('a[href]'));
      for (const a of allAnchors) {
        const href = a.href;
        if (!href) continue;
        // Filter out obvious non-job anchors
        if (/^(mailto|tel|javascript):/i.test(href)) continue;
        if (anchorSet.has(href)) continue;

        // Heuristic: candidate job link if href contains "/jobs/" or "/job/" or
        // path matches /<numeric or hash> at end (Greenhouse style).
        const looksLikeJob = /\/jobs?\/[^/]+/i.test(href)
          || /\/postings\/[a-f0-9-]+/i.test(href) // Lever
          || /\/applications\/[a-f0-9-]+/i.test(href); // Ashby
        if (!looksLikeJob) continue;

        // Title from anchor text, fallback to nested <h3>/<h5>/<h2>
        let title = (a.innerText || '').trim();
        if (!title) {
          const h = a.querySelector('h1,h2,h3,h4,h5');
          if (h) title = (h.innerText || h.textContent || '').trim();
        }
        if (!title) continue;
        anchorSet.add(href);
        out.push({ title, href });
      }
      return out;
    });

    return pairs;
  } catch {
    return [];
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

/**
 * Try to find a canonical URL on the company's ATS host by fuzzy-matching
 * the LinkedIn role title.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} title
 * @param {string} company
 * @param {number} timeoutMs
 * @returns {Promise<{ canonical: string|null, evidenceUrl: string, score: number|null, atsHost: string }>}
 */
async function findCanonicalByTitleCompany(context, title, company, timeoutMs) {
  if (!title || !company) {
    return { canonical: null, evidenceUrl: '', score: null, atsHost: '' };
  }
  const candidates = getAtsCandidatesForCompany(company);
  const MIN_SCORE = 0.5;

  for (const atsUrl of candidates) {
    process.stderr.write(JSON.stringify({
      t: new Date().toISOString(),
      kind: 'canonicalize-ats-probe',
      atsUrl,
      title,
      company,
    }) + '\n');

    const pairs = await fetchAtsJobIndex(context, atsUrl, timeoutMs);
    if (pairs.length === 0) continue;

    let best = { title: '', href: '', score: 0 };
    for (const p of pairs) {
      const s = titleSimilarity(title, p.title);
      if (s > best.score) best = { ...p, score: s };
    }

    if (best.score >= MIN_SCORE) {
      return {
        canonical: best.href,
        evidenceUrl: atsUrl,
        score: best.score,
        atsHost: atsUrl,
      };
    }
  }

  return { canonical: null, evidenceUrl: '', score: null, atsHost: '' };
}

/**
 * @typedef {{ canonical: string|null, source: string, evidenceUrl: string,
 *             confidence: number|null, original: string, error?: string,
 *             title?: string, company?: string, matchScore?: number|null }} CanonicalizeResult
 *
 * INSTANCE C (2026-05-24, GAP-RES-26 follow-up): `confidence` + `matchScore`
 * are explicitly nullable. Failure paths (canonical: null) set both fields to
 * `null` to be schema-consistent with the cohort-flag semantic. Callers
 * MUST `!= null` guard before any arithmetic (`.toFixed()`, comparisons,
 * `reduce`, etc.). Caller-impact analysis at
 * `data/instance-c-2026-05-24/researcher-report.md`.
 */

/**
 * Canonicalize a single JD URL. Sequential — see the project rule against
 * parallel Playwright in check-liveness.mjs.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {import('playwright').Browser} [opts.browser]  — reuse a browser instance
 *                                                          across many calls
 * @param {import('playwright').BrowserContext} [opts.context]  — reuse auth context
 * @param {number} [opts.timeoutMs=20000]  — per-call hard cap
 * @returns {Promise<CanonicalizeResult>}
 */
export async function canonicalize(url, opts = {}) {
  const original = String(url || '');
  if (!original) {
    return { canonical: null, source: 'unresolved', evidenceUrl: '', confidence: null, original, error: 'empty url' };
  }

  const cls = classifyUrl(original);
  if (cls.type === 'already-canonical') {
    return { canonical: original, source: 'already-canonical', evidenceUrl: original, confidence: 1.0, original };
  }
  if (cls.type !== 'linkedin') {
    // Non-LinkedIn, non-known-ATS — pass through with low confidence; caller can decide.
    return { canonical: original, source: 'unresolved', evidenceUrl: original, confidence: 0.30, original, error: 'unknown host (not LinkedIn, not known ATS)' };
  }

  // LinkedIn → need Playwright. Lazy-import so consumers that never hit a
  // LinkedIn URL don't pay the Playwright load cost.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: null, original, error: 'playwright not installed' };
  }

  const timeoutMs = Number(opts.timeoutMs ?? 20_000);
  let browser = opts.browser;
  let ownsBrowser = false;
  if (!browser) {
    browser = await chromium.launch({ headless: true });
    ownsBrowser = true;
  }

  let context = opts.context;
  let ownsContext = false;
  if (!context) {
    const storageState = existsSync(LINKEDIN_STORAGE_STATE) ? LINKEDIN_STORAGE_STATE : undefined;
    context = await browser.newContext({ storageState });
    ownsContext = true;
  }

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    const navResp = await page.goto(original, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = navResp?.status() ?? 0;
    // Let LinkedIn hydrate
    await page.waitForTimeout(3000);
    const postLoadUrl = page.url();

    // Edge case: LinkedIn redirected us OFF linkedin to a canonical ATS URL.
    if (!isLinkedInJobUrl(postLoadUrl) && isCanonicalAtsUrl(postLoadUrl)) {
      return { canonical: postLoadUrl, source: 'ats-redirect', evidenceUrl: original, confidence: 0.90, original };
    }

    if (status === 404 || status === 410) {
      return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: null, original, error: `linkedin HTTP ${status}` };
    }

    // Look for an Apply button or in-page ATS link.
    const { canonical, evidenceUrl } = await extractApplyDestination(page);
    if (canonical && isCanonicalAtsUrl(canonical)) {
      return { canonical, source: 'apply-link', evidenceUrl, confidence: 0.95, original };
    }
    if (canonical) {
      // Found a URL but it's not on a known ATS host. Lower confidence.
      return { canonical, source: 'page-text', evidenceUrl, confidence: 0.70, original };
    }

    // Check for explicit "No longer accepting applications" pattern.
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/no longer accepting applications|this job is no longer available|posting has been removed/i.test(bodyText)) {
      return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: null, original, error: 'job no longer accepting applications' };
    }

    // ── Fallback: title + company → ATS host fuzzy match ──────────────────
    // Phase 1.5-a (2026-05-23). When LinkedIn's DOM hides the Apply button,
    // role title + company are usually still extractable. Look up the
    // company's known ATS host and search for a matching title.
    try {
      const tc = await extractTitleAndCompany(page);
      if (tc.title && tc.company) {
        process.stderr.write(JSON.stringify({
          t: new Date().toISOString(),
          kind: 'canonicalize-fallback-attempt',
          title: tc.title,
          company: tc.company,
        }) + '\n');
        const tcFallbackTimeout = Math.min(timeoutMs, 30_000);
        const match = await findCanonicalByTitleCompany(context, tc.title, tc.company, tcFallbackTimeout);
        if (match.canonical) {
          return {
            canonical: match.canonical,
            source: 'title-company-fallback',
            evidenceUrl: match.evidenceUrl,
            confidence: 0.85,
            original,
            title: tc.title,
            company: tc.company,
            // INSTANCE C (2026-05-24): match.score is guaranteed non-null on
            // this branch (the for-loop in findCanonicalByTitleCompany only
            // returns canonical: <truthy> when best.score >= 0.5), but the
            // guard is added for symmetry with the failure path below at L675.
            matchScore: match.score != null ? Number(match.score.toFixed(3)) : null,
          };
        }
        // Surface the attempted-but-failed metadata so callers can debug.
        return {
          canonical: null,
          source: 'unresolved',
          evidenceUrl: original,
          confidence: null,
          original,
          error: `title-company fallback failed (no ATS match above 0.5 for "${tc.title}" at "${tc.company}")`,
          title: tc.title,
          company: tc.company,
          // INSTANCE C (2026-05-24): match.score is null here (no candidate ≥
          // 0.5), so guard `.toFixed()` to avoid TypeError post-fix to
          // findCanonicalByTitleCompany.
          matchScore: match.score != null ? Number(match.score.toFixed(3)) : null,
        };
      }
    } catch (fallbackErr) {
      // Fall through to the generic unresolved return below.
      process.stderr.write(JSON.stringify({
        t: new Date().toISOString(),
        kind: 'canonicalize-fallback-error',
        error: String(fallbackErr.message || fallbackErr).split('\n')[0],
      }) + '\n');
    }

    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: null, original, error: 'no canonical URL found on page' };
  } catch (err) {
    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: null, original, error: `playwright error: ${String(err.message || err).split('\n')[0]}` };
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    if (ownsContext) { try { await context.close(); } catch { /* ignore */ } }
    if (ownsBrowser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

/**
 * Canonicalize an array of URLs. Reuses one browser + context across all calls
 * (sequential per the project rule). Emits NDJSON heartbeat to stderr per item.
 *
 * @param {string[]} urls
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {(progress: { i: number, total: number, url: string, result: CanonicalizeResult }) => void} [opts.onProgress]
 * @returns {Promise<CanonicalizeResult[]>}
 */
export async function canonicalizeBatch(urls, opts = {}) {
  const list = Array.isArray(urls) ? urls : [];
  if (list.length === 0) return [];

  // Lazy-import Playwright once; share browser + context across the batch.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const storageState = existsSync(LINKEDIN_STORAGE_STATE) ? LINKEDIN_STORAGE_STATE : undefined;
  const context = await browser.newContext({ storageState });

  const results = [];
  const total = list.length;
  for (let i = 0; i < total; i++) {
    const url = list[i];
    process.stderr.write(JSON.stringify({
      t: new Date().toISOString(),
      kind: 'canonicalize-progress',
      i: i + 1,
      total,
      url,
    }) + '\n');
    let result;
    try {
      result = await canonicalize(url, { ...opts, browser, context });
    } catch (e) {
      // INSTANCE C (2026-05-24): consistent with canonicalize()'s own failure-
      // path shape — confidence is null when no value was computed (matches
      // canonical: null cohort indicator).
      result = { canonical: null, source: 'unresolved', evidenceUrl: url, confidence: null, original: url, error: String(e.message || e) };
    }
    results.push(result);
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress({ i: i + 1, total, url, result }); } catch { /* ignore */ }
    }
  }

  try { await context.close(); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* ignore */ }
  return results;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
// node lib/jd-url-canonicalizer.mjs <url1> [url2] ...
// node lib/jd-url-canonicalizer.mjs --file urls.txt
// node lib/jd-url-canonicalizer.mjs --queue                # process every LinkedIn URL in apply-now-queue.json
// node lib/jd-url-canonicalizer.mjs --fixtures             # run the 5 Phase 1.5-a fallback fixtures
// node lib/jd-url-canonicalizer.mjs --timeout-ms 60000 ... # per-URL timeout (default 20000)

const FALLBACK_FIXTURES_2026_05_23 = [
  'https://www.linkedin.com/jobs/view/4322199961',
  'https://www.linkedin.com/jobs/view/4403698664',
  'https://www.linkedin.com/jobs/view/4354790731',
  'https://www.linkedin.com/jobs/view/4402785364',
  'https://www.linkedin.com/jobs/view/4409830555',
];

const isCLI = import.meta.url === `file://${process.argv[1]}`;
if (isCLI) {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf('--file');
  const queueFlag = args.includes('--queue');
  const fixturesFlag = args.includes('--fixtures');
  const timeoutFlag = args.indexOf('--timeout-ms');
  const cliTimeoutMs = timeoutFlag !== -1 && args[timeoutFlag + 1]
    ? Number(args[timeoutFlag + 1])
    : 20_000;

  let urls = [];

  if (fixturesFlag) {
    urls = FALLBACK_FIXTURES_2026_05_23.slice();
    console.log(`[canonicalizer] running ${urls.length} Phase 1.5-a fallback fixtures`);
  } else if (fileFlag !== -1 && args[fileFlag + 1]) {
    const content = readFileSync(args[fileFlag + 1], 'utf-8');
    urls = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else if (queueFlag) {
    const queuePath = join(REPO_ROOT, 'data/apply-now-queue.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    urls = (queue.ranked || [])
      .filter(r => !r._dropped && r.url && isLinkedInJobUrl(r.url))
      .map(r => r.url);
    if (urls.length === 0) {
      console.log('[canonicalizer] no LinkedIn-only URLs in apply-now-queue.json');
      process.exit(0);
    }
    console.log(`[canonicalizer] found ${urls.length} LinkedIn-only URL(s) in queue`);
  } else {
    urls = args.filter((a, i) => {
      if (a.startsWith('--')) return false;
      const prev = args[i - 1];
      if (prev === '--timeout-ms') return false; // value of previous flag
      return true;
    });
  }

  if (urls.length === 0) {
    console.error('Usage: node lib/jd-url-canonicalizer.mjs <url1> [url2] ...');
    console.error('       node lib/jd-url-canonicalizer.mjs --file urls.txt');
    console.error('       node lib/jd-url-canonicalizer.mjs --queue');
    console.error('       node lib/jd-url-canonicalizer.mjs --fixtures');
    console.error('       (any of the above can take --timeout-ms <N>; default 20000)');
    process.exit(2);
  }

  console.log(`[canonicalizer] processing ${urls.length} URL(s) sequentially…  timeout=${cliTimeoutMs}ms\n`);

  const t0 = Date.now();
  const results = await canonicalizeBatch(urls, {
    timeoutMs: cliTimeoutMs,
    onProgress: ({ i, total, url, result }) => {
      const icon = result.canonical ? '✓' : '×';
      // INSTANCE C (2026-05-24): result.confidence is null on failure paths
      // post-fix to canonicalize(). Guard `.toFixed()` to avoid TypeError.
      const head = `${icon} [${i}/${total}] ${result.source.padEnd(24)} (conf=${result.confidence != null ? result.confidence.toFixed(2) : '—'})`;
      console.log(head);
      console.log(`    in:  ${url}`);
      if (result.canonical) console.log(`    out: ${result.canonical}`);
      if (result.title || result.company) {
        console.log(`    meta: title="${result.title || ''}" company="${result.company || ''}"${result.matchScore != null ? ` score=${result.matchScore}` : ''}`);
      }
      if (result.error) console.log(`    err: ${result.error}`);
    },
  });

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  const resolved = results.filter(r => r.canonical).length;
  console.log(`\n[canonicalizer] resolved ${resolved}/${urls.length} in ${totalSec}s`);
  process.exit(resolved === urls.length ? 0 : 1);
}
