/**
 * lib/browser-pool.mjs — Playwright warm browser singleton.
 *
 * Problem: lib/eval-intel-gather.mjs and other eval-time scrapers need to
 * render SPA-hosted JDs (Workable, Ashby, Lever, Greenhouse SPA, LinkedIn,
 * Cloudflare-gated sites). Spinning up a fresh Chromium instance per scrape
 * costs ~1.5s of cold-start; pooling drops that to ~50-200ms per page after
 * the first.
 *
 * This module owns ONE Chromium browser instance, lazily launched on first
 * use, auto-closed after IDLE_TIMEOUT_MS of inactivity. Concurrency-safe:
 * acquire()/release() refcount the open contexts so the pool stays alive as
 * long as any caller still holds a context.
 *
 * Usage:
 *   import { renderPage } from './browser-pool.mjs';
 *   const { text, status, finalUrl } = await renderPage(url, { waitFor: 'networkidle', timeoutMs: 30_000 });
 *
 * Internals:
 *   - Single shared browser, headless
 *   - Per-call context (so cookies/storage don't leak between scrapes)
 *   - waitForLoadState('networkidle') by default so XHR-loaded JDs finish
 *   - Idle-shutdown timer cleans up after IDLE_TIMEOUT_MS
 *
 * Mandatory hang-prevention (per global CLAUDE.md):
 *   - AbortSignal on fetch (n/a here — Playwright handles its own timeouts)
 *   - Per-page navigation timeout
 *   - Idle-timer auto-cleanup
 *   - shutdown() exported for explicit cleanup in long-running daemons
 */

const IDLE_TIMEOUT_MS = 90_000; // close browser after 90s of no activity
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_STATE = 'networkidle';

let _browser = null;
let _refcount = 0;
let _idleTimer = null;
let _launching = null; // Promise gate so concurrent first-callers don't double-launch

async function _getBrowser() {
  if (_browser) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: true,
      // The --disable-blink-features=AutomationControlled flag reduces the
      // odds of a Cloudflare bot check rejecting the headless browser. Not
      // a bypass — just keeps the navigator.webdriver signal off.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
      ],
    });
    _browser = browser;
    _launching = null;
    return browser;
  })();
  return _launching;
}

function _scheduleIdleShutdown() {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_refcount > 0) return; // still in use
  _idleTimer = setTimeout(async () => {
    if (_refcount > 0) return; // racey: someone re-acquired before timer fired
    if (_browser) {
      try { await _browser.close(); } catch { /* swallow — best-effort cleanup */ }
      _browser = null;
    }
  }, IDLE_TIMEOUT_MS);
  // Don't keep the event loop alive solely for this timer — scripts that
  // finish their work should exit cleanly.
  if (_idleTimer.unref) _idleTimer.unref();
}

/**
 * Render a URL via headless Chromium and return the rendered text + metadata.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.waitFor]    — 'load' | 'domcontentloaded' | 'networkidle' (default: 'networkidle')
 * @param {number} [opts.timeoutMs]  — navigation timeout in ms (default: 30000)
 * @param {string} [opts.userAgent]  — override default UA
 * @returns {Promise<{ text: string, status: number, finalUrl: string, html: string, error?: string }>}
 */
export async function renderPage(url, opts = {}) {
  const waitFor   = opts.waitFor   || DEFAULT_WAIT_STATE;
  const timeoutMs = opts.timeoutMs || DEFAULT_NAV_TIMEOUT_MS;
  const userAgent = opts.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  _refcount++;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }

  let context;
  let page;
  try {
    const browser = await _getBrowser();
    context = await browser.newContext({
      userAgent,
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: true,
      // Some ATSes geo-gate; pretend US.
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);

    let status = 0;
    page.on('response', (resp) => {
      // Capture the top-document response status only.
      if (resp.url() === url || resp.request().resourceType() === 'document') {
        const s = resp.status();
        if (s && !status) status = s;
      }
    });

    let navError;
    try {
      const resp = await page.goto(url, { waitUntil: waitFor, timeout: timeoutMs });
      if (resp && !status) status = resp.status();
    } catch (e) {
      navError = e.message || String(e);
    }

    // Even if networkidle timed out, the page may still have content (Cloudflare
    // challenge loops, slow trackers). Grab what we have.
    const finalUrl = page.url();
    const text = await page.evaluate(() => {
      try { return document.body ? document.body.innerText : ''; } catch { return ''; }
    });
    const html = await page.content().catch(() => '');

    return {
      text:     (text || '').trim(),
      html,
      status:   status || (navError ? 0 : 200),
      finalUrl,
      error:    navError,
    };
  } catch (err) {
    return {
      text:     '',
      html:     '',
      status:   0,
      finalUrl: url,
      error:    err.message || String(err),
    };
  } finally {
    try { if (page) await page.close({ runBeforeUnload: false }); } catch { /* swallow */ }
    try { if (context) await context.close(); } catch { /* swallow */ }
    _refcount--;
    _scheduleIdleShutdown();
  }
}

/**
 * Explicit shutdown — call from long-running daemons before exit.
 * Safe to call repeatedly; no-op if pool isn't initialized.
 */
export async function shutdown() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_browser) {
    try { await _browser.close(); } catch { /* swallow */ }
    _browser = null;
  }
  _refcount = 0;
  _launching = null;
}

/**
 * For tests / observability. Returns { open: bool, refcount: number }.
 */
export function poolStatus() {
  return { open: !!_browser, refcount: _refcount };
}
