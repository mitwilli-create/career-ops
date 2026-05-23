/**
 * lib/jd-url-canonicalizer.mjs — JD URL canonicalization (LinkedIn → ATS canonical)
 *
 * Phase 3.1 of the 2026-05-22 master resolution prompt. Solves the
 * "LinkedIn-only url (canonical not resolved)" gate failure reason from
 * lib/apply-now-queue-gate.mjs.
 *
 * Exports:
 *   canonicalize(url, opts)        → { canonical, source, evidenceUrl, confidence, original }
 *   canonicalizeBatch(urls, opts)  → array of results (sequential per the project
 *                                    rule against parallel Playwright)
 *   isLinkedInJobUrl(url)          → boolean (quick check for the queue-gate caller)
 *
 * Detection sources (ranked by confidence):
 *   'already-canonical' (confidence 1.0) — input is already a non-LinkedIn ATS URL
 *   'apply-link'        (confidence 0.95) — LinkedIn "Apply" button href extracted
 *   'ats-redirect'      (confidence 0.90) — LinkedIn redirected to a known ATS host
 *   'page-text'         (confidence 0.70) — found canonical URL in LinkedIn page body
 *   'unresolved'        (confidence 0.0)  — could not resolve
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

/**
 * @typedef {{ canonical: string|null, source: string, evidenceUrl: string,
 *             confidence: number, original: string, error?: string }} CanonicalizeResult
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
    return { canonical: null, source: 'unresolved', evidenceUrl: '', confidence: 0, original, error: 'empty url' };
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
    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: 0, original, error: 'playwright not installed' };
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
      return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: 0, original, error: `linkedin HTTP ${status}` };
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
      return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: 0, original, error: 'job no longer accepting applications' };
    }

    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: 0, original, error: 'no canonical URL found on page' };
  } catch (err) {
    return { canonical: null, source: 'unresolved', evidenceUrl: original, confidence: 0, original, error: `playwright error: ${String(err.message || err).split('\n')[0]}` };
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
      result = { canonical: null, source: 'unresolved', evidenceUrl: url, confidence: 0, original: url, error: String(e.message || e) };
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

const isCLI = import.meta.url === `file://${process.argv[1]}`;
if (isCLI) {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf('--file');
  const queueFlag = args.includes('--queue');

  let urls = [];

  if (fileFlag !== -1 && args[fileFlag + 1]) {
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
    urls = args.filter(a => !a.startsWith('--'));
  }

  if (urls.length === 0) {
    console.error('Usage: node lib/jd-url-canonicalizer.mjs <url1> [url2] ...');
    console.error('       node lib/jd-url-canonicalizer.mjs --file urls.txt');
    console.error('       node lib/jd-url-canonicalizer.mjs --queue');
    process.exit(2);
  }

  console.log(`[canonicalizer] processing ${urls.length} URL(s) sequentially…\n`);

  const results = await canonicalizeBatch(urls, {
    onProgress: ({ i, total, url, result }) => {
      const icon = result.canonical ? '✓' : '×';
      const head = `${icon} [${i}/${total}] ${result.source.padEnd(18)} (conf=${result.confidence.toFixed(2)})`;
      console.log(head);
      console.log(`    in:  ${url}`);
      if (result.canonical) console.log(`    out: ${result.canonical}`);
      if (result.error) console.log(`    err: ${result.error}`);
    },
  });

  const resolved = results.filter(r => r.canonical).length;
  console.log(`\n[canonicalizer] resolved ${resolved}/${urls.length}`);
  process.exit(resolved === urls.length ? 0 : 1);
}
