#!/usr/bin/env node
/**
 * scripts/scan-linkedin-saved-jobs.mjs
 *
 * 2026-07-08 — Scheduled scrape of LinkedIn Saved Jobs → data/pipeline.md.
 *
 * Jobs Mitchell manually saves on LinkedIn (linkedin.com/my-items/saved-jobs/)
 * only reached the pipeline when a Gmail alert also mentioned them. This script
 * closes that gap: it opens the Saved Jobs list, extracts /jobs/view/{id}
 * anchors, dedupes against the canonical seen-set (loadSeenUrls: scan-history
 * + pipeline.md + applications.md) plus a local state file, applies the
 * Rejection Gate (scripts/rejection-scan.mjs hardExclude — AGENTS.md mandates
 * it before any flow that surfaces new JDs), and appends new rows to the
 * "## Pendientes" section of data/pipeline.md. Downstream, triage
 * Phase 0a canonicalizes the LinkedIn URL to the real ATS URL — this script
 * does NO ATS resolution and NO LLM calls ($0/run).
 *
 * Auth is CDP-FIRST (lib/cdp-browser.mjs): attach to the live daemon Chrome
 * at 127.0.0.1:9222 (com.mitchell.career-ops.chrome-debugging plist) so the
 * scrape rides Mitchell's real logged-in session. Fallback: headless Chromium
 * with data/linkedin-storage-state.json. Live-fire 2026-07-08 proved why CDP
 * is primary: a freshly minted storage-state session was invalidated by
 * LinkedIn bot-detection within ~3 minutes (page 1 scraped, ?start=10 hit a
 * login wall, then the whole session bounced), while the same navigation via
 * CDP returned both pages cleanly.
 *
 * Extraction is anchor-based (a[href*="/jobs/view/"]), never LinkedIn's
 * obfuscated class names. Title/company are best-effort card text — cosmetic
 * only, since triage re-derives both from the JD.
 *
 * Silent-zero guard: page 1 with zero anchors AND no "No saved jobs"
 * empty-state text is a PARSE FAILURE (exit 3), never "success, 0 new".
 * Selector rot must alarm, not rot quietly.
 *
 * Usage:
 *   node scripts/scan-linkedin-saved-jobs.mjs                 # DRY RUN (default) — writes nothing
 *   node scripts/scan-linkedin-saved-jobs.mjs --apply         # append new rows
 *   node scripts/scan-linkedin-saved-jobs.mjs --apply --limit=10 --max-pages=2
 *   node scripts/scan-linkedin-saved-jobs.mjs --apply --scheduled   # launchd path (kill-switch gated)
 *
 * Flags:
 *   --apply         write pipeline.md + scan-history.tsv + state file (default: dry-run)
 *   --dry-run       explicit no-op alias for the default
 *   --limit=N       max new rows appended per run (default 25)
 *   --max-pages=N   pagination hard cap (default 5; env SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES)
 *   --scheduled     launchd marker: honors SCAN_LINKEDIN_SAVED_JOBS_ENABLED kill switch
 *                   (unset or !== 'true' → exit 0 no-op). Manual runs ignore the switch.
 *
 * Exit codes:
 *   0 — success (incl. genuinely 0 new, confirmed-empty list, dry-run, disabled no-op)
 *   2 — auth: login-wall/authwall redirect, OR no CDP listener AND no storage state
 *       → recover: ensure the chrome-debugging daemon Chrome is running + logged
 *         into LinkedIn (node scripts/launch-debug-chrome.mjs), or legacy:
 *         node scripts/scrape-contact-photo.mjs --setup-auth
 *   3 — parse failure: page-1 zero anchors without empty-state indicator (likely DOM change)
 *   4 — environment: playwright missing / browser launch failure
 *   5 — rejection gate unavailable (rejection-scan.mjs --json failed) — fail-closed,
 *       never surface ungated jobs (AGENTS.md § Rejection Gate is mandatory)
 *   1 — unexpected exception
 *
 * All nonzero exits should alarm (fleet-watchdog + heartbeat) — nothing is
 * registered in data/fleet-watchdog-expected-exits.json by design.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { canonicalize, loadSeenUrls } from '../lib/gmail-alert-parser.mjs';
import { safeReadFileSync, safeWriteFileSync, safeAppendFileSync } from '../lib/icloud-safe-fs.mjs';
import { isoNowPT } from '../lib/scan-history-utils.mjs';
import { isCdpAvailable, connectToChromeCDP } from '../lib/cdp-browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');
export const SCAN_HISTORY_PATH = join(ROOT, 'data/scan-history.tsv');
export const STATE_PATH = join(ROOT, 'data/linkedin-saved-jobs-state.json');
export const STORAGE_STATE_PATH = join(ROOT, 'data/linkedin-storage-state.json');

const SAVED_JOBS_URL = 'https://www.linkedin.com/my-items/saved-jobs/';
const PAGE_SIZE = 10; // LinkedIn's ?start=N pagination step
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_LIMIT = 25;

// Same UA as scripts/scrape-contact-photo.mjs — consistent fingerprint across scrapers.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ── Telemetry (NDJSON to stderr, human summary to stdout) ──────────────────

function emit(event, extra = {}) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), event, ...extra }) + '\n');
}

// ── Pure functions (unit-testable, no I/O) ─────────────────────────────────

const LOGIN_WALL_RE = /linkedin\.com\/(?:login|authwall|checkpoint|uas)\b/i;
const EMPTY_STATE_RE = /no saved (?:jobs|items)|nothing saved|you haven.?t saved/i;

/**
 * Classify what a scraped saved-jobs page represents.
 * @returns 'login_wall' | 'ok' | 'empty_confirmed' | 'ambiguous_zero'
 */
export function classifyPageState({ url, anchorCount, bodyText }) {
  if (LOGIN_WALL_RE.test(url || '')) return 'login_wall';
  if (anchorCount > 0) return 'ok';
  if (EMPTY_STATE_RE.test(bodyText || '')) return 'empty_confirmed';
  return 'ambiguous_zero';
}

/** Strip pipes/tabs/newlines so a scraped string can't break row formats. */
export function sanitizeField(s) {
  return String(s || '')
    .replace(/[|\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert raw per-anchor eval results into deduped card objects.
 * Canonicalizes hrefs to https://www.linkedin.com/jobs/view/{id} (shared
 * normalization from lib/gmail-alert-parser.mjs so dedup keys match the
 * email-alert ingest path) and dedupes by job id within the run.
 * @param {Array<{href, anchorText, cardText}>} rawAnchors
 * @returns {Array<{url, title, company}>}
 */
export function extractCardsFromEvalResult(rawAnchors) {
  const byUrl = new Map();
  for (const a of rawAnchors || []) {
    if (!a || !a.href) continue;
    // Validate host + path on the RAW href before canonicalizing —
    // canonicalize() substring-matches "linkedin.com/jobs/view/{id}" anywhere
    // in the URL, so a crafted href on another host (e.g. ?u=linkedin.com/
    // jobs/view/123) could otherwise be rewritten into an accepted URL.
    let parsedHref;
    try {
      parsedHref = new URL(a.href);
    } catch {
      continue;
    }
    if (!/(^|\.)linkedin\.com$/i.test(parsedHref.hostname)) continue;
    const jobPath = parsedHref.pathname.match(/^\/(?:comm\/)?jobs\/view\/(\d+)\/?$/i);
    if (!jobPath) continue;
    const url = canonicalize(`https://www.linkedin.com/jobs/view/${jobPath[1]}`);
    if (!/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/i.test(url)) continue;
    if (byUrl.has(url)) continue;
    // Observed my-items card shape (live-probed 2026-07-08; anchor text is
    // empty — the anchor wraps the card visuals, not the title text):
    //   "DevRel \n, Verified\nComet\nUnited States (Remote)\nPosted 1h ago"
    // → line 1 = title, ", Verified" = badge artifact, next line = company.
    // Cosmetic only — triage re-derives title/company from the JD.
    const lines = (a.cardText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^,?\s*verified$/i.test(l));
    const title = sanitizeField((a.anchorText || '').split('\n')[0]) || sanitizeField(lines[0]) || 'Unknown';
    const titleIdx = lines.findIndex((l) => sanitizeField(l) === title);
    const candidate = (titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines.slice(1))
      .find((l) => !/^posted\s/i.test(l));
    const company = candidate ? sanitizeField(candidate).slice(0, 120) || 'Unknown' : 'Unknown';
    byUrl.set(url, { url, title, company });
  }
  return [...byUrl.values()];
}

/**
 * Filter out cards whose canonical URL is already known anywhere in the
 * system (loadSeenUrls union) or in this scraper's own state file.
 */
export function dedupeAgainstSeen(cards, seenSet, localSeen = {}) {
  return (cards || []).filter((c) => !seenSet.has(c.url) && !(c.url in localSeen));
}

/**
 * Rejection Gate (AGENTS.md § Rejection Gate — MANDATORY before any flow that
 * surfaces new JDs): drop cards whose company+role exact-match a hardExclude
 * entry from scripts/rejection-scan.mjs. Case-insensitive trim compare —
 * scraped titles are heuristic, so only exact pairs are dropped (matches the
 * EXCLUDE verdict's exact-company+role semantics).
 * @param {Array<{url, title, company}>} cards
 * @param {Array<{company, role}>|null} exclusions — null/empty = nothing to drop
 *   (the CALLER is responsible for treating a null gate as fail-closed; main()
 *   aborts with exit 5 before this runs)
 */
export function filterRejected(cards, exclusions) {
  if (!Array.isArray(exclusions) || exclusions.length === 0) return { kept: cards || [], dropped: [] };
  const key = (co, ro) => `${String(co || '').trim().toLowerCase()}|${String(ro || '').trim().toLowerCase()}`;
  const excluded = new Set(exclusions.map((e) => key(e.company, e.role)));
  const kept = [];
  const dropped = [];
  for (const c of cards || []) {
    (excluded.has(key(c.company, c.title)) ? dropped : kept).push(c);
  }
  return { kept, dropped };
}

/** Load the hardExclude set from rejection-scan.mjs --json. Fail-open: null on any error. */
export function loadRejectionExclusions() {
  try {
    // process.execPath (not bare 'node') so the subprocess always uses the
    // active interpreter even under launchd's minimal PATH.
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/rejection-scan.mjs'), '--json'], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed.hardExclude) ? parsed.hardExclude : null;
  } catch (err) {
    emit('rejection_gate_unavailable', { error: String(err && err.message || err) });
    return null;
  }
}

/**
 * Pipeline row. URL MUST be the first token after the checkbox — triage.mjs
 * parsePipeline matches /^- \[ \] (https?:\/\/\S+)/ and warns on drift
 * (bug class pipeline-ingest-format-drift).
 */
export function formatPipelineRow({ url, company, title }, date) {
  return `- [ ] ${url} | ${sanitizeField(company) || 'Unknown'} | ${sanitizeField(title) || 'Unknown'} | ${date}`;
}

/** scan-history.tsv row: url\tfirst_seen\tportal\ttitle\tcompany\tstatus */
export function formatScanHistoryRow({ url, title, company }, isoTs) {
  return `${url}\t${isoTs}\tlinkedin-saved\t${sanitizeField(title) || 'Unknown'}\t${sanitizeField(company) || 'Unknown'}\tadded`;
}

// ── Browser layer (injectable { context } for tests) ───────────────────────

// Runs inside the page. Anchor-first extraction — LinkedIn class names are
// obfuscated and rotate; a[href*="/jobs/view/"] is the stable contract.
function pageExtractor() {
  const anchors = [];
  for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
    let card = a.closest('li');
    if (!card) {
      // Fallback: walk up to the smallest ancestor that still reads like one card.
      let el = a.parentElement;
      for (let depth = 0; el && depth < 6; depth++) {
        const len = (el.innerText || '').length;
        if (len > 0 && len < 400) card = el;
        if (len >= 400) break;
        el = el.parentElement;
      }
    }
    anchors.push({
      href: a.href,
      anchorText: (a.innerText || '').trim().slice(0, 200),
      cardText: card ? (card.innerText || '').slice(0, 400) : '',
    });
  }
  return {
    anchors,
    anchorCount: anchors.length,
    bodyTextSample: ((document.body && document.body.innerText) || '').slice(0, 3000),
  };
}

/**
 * Scrape the saved-jobs list. Accepts an injected Playwright `context` (tests
 * pass a stub; real runs pass a live one). Sequential, one page object.
 *
 * @returns {Promise<{state, cards, pagesScraped}>}
 *   state: 'ok' | 'login_wall' | 'empty_confirmed' | 'ambiguous_zero'
 */
export async function scrapeSavedJobs({ context, maxPages = DEFAULT_MAX_PAGES, log = emit }) {
  const page = await context.newPage();
  const collected = new Map(); // canonical url → card
  let pagesScraped = 0;

  try {
    for (let i = 0; i < maxPages; i++) {
      const target = i === 0 ? SAVED_JOBS_URL : `${SAVED_JOBS_URL}?start=${i * PAGE_SIZE}`;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // LinkedIn hydrates the list client-side after domcontentloaded. Wait on
      // the extraction selector (not a fixed sleep) so slow hydration can't
      // misclassify as ambiguous_zero; swallow only the timeout so genuinely
      // empty pages still reach classifyPageState.
      await page
        .waitForSelector('a[href*="/jobs/view/"]', { timeout: 8_000 })
        .catch(() => { /* empty list / login wall — classification decides */ });
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));

      const postLoadUrl = page.url();
      if (LOGIN_WALL_RE.test(postLoadUrl)) {
        log('login_wall', { page: i + 1, url: postLoadUrl });
        return { state: 'login_wall', cards: [], pagesScraped };
      }

      const raw = await page.evaluate(pageExtractor);
      pagesScraped++;
      const pageState = classifyPageState({
        url: postLoadUrl,
        anchorCount: raw.anchorCount,
        bodyText: raw.bodyTextSample,
      });

      if (i === 0 && pageState === 'ambiguous_zero') {
        // Zero cards with no empty-state indicator = parse failure, NOT an
        // empty list. Silent-zero bug class — must alarm.
        log('ambiguous_zero', { url: postLoadUrl, bodySample: (raw.bodyTextSample || '').slice(0, 200) });
        return { state: 'ambiguous_zero', cards: [], pagesScraped };
      }
      if (i === 0 && pageState === 'empty_confirmed') {
        log('empty_confirmed', {});
        return { state: 'empty_confirmed', cards: [], pagesScraped };
      }

      const cards = extractCardsFromEvalResult(raw.anchors);
      if (i === 0 && raw.anchorCount > 0 && cards.length === 0) {
        // Anchors matched the selector but none survived extraction/validation
        // — href-shape drift, the same silent-zero class as zero anchors.
        log('ambiguous_zero', { url: postLoadUrl, anchors: raw.anchorCount, extracted: 0 });
        return { state: 'ambiguous_zero', cards: [], pagesScraped };
      }
      const before = collected.size;
      for (const c of cards) if (!collected.has(c.url)) collected.set(c.url, c);
      log('page_scraped', { page: i + 1, anchors: raw.anchorCount, new_cards: collected.size - before });

      // Stop: empty page past page 1, or a page that adds nothing new
      // (LinkedIn repeats the last page for out-of-range start offsets).
      if (cards.length === 0 || collected.size === before) break;
    }
  } finally {
    try { await page.close(); } catch { /* stub pages may not implement close */ }
  }

  return { state: 'ok', cards: [...collected.values()], pagesScraped };
}

// ── File I/O ────────────────────────────────────────────────────────────────

/**
 * Insert rows inside "## Pendientes", before the next "## " heading.
 * Mirrors lib/gmail-alert-parser.mjs::appendToPipeline (verified 2026-07-08)
 * but through the iCloud-safe wrappers — pipeline.md is a hot fileproviderd
 * target (bug class icloud-fileprovider-edeadlk-on-hot-state-file).
 */
export function appendRowsToPipeline(cards, { pipelinePath = PIPELINE_PATH, date } = {}) {
  if (!cards.length) return 0;
  mkdirSync(dirname(pipelinePath), { recursive: true });
  const day = date || new Date().toISOString().slice(0, 10);
  const rows = cards.map((c) => formatPipelineRow(c, day));
  let text = existsSync(pipelinePath) ? safeReadFileSync(pipelinePath, 'utf-8') : '';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + rows.join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + rows.join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  safeWriteFileSync(pipelinePath, text, 'utf-8');
  return rows.length;
}

export function appendScanHistory(cards, { scanHistoryPath = SCAN_HISTORY_PATH, isoTs } = {}) {
  if (!cards.length) return 0;
  const ts = isoTs || isoNowPT();
  mkdirSync(dirname(scanHistoryPath), { recursive: true });
  if (!existsSync(scanHistoryPath)) {
    safeWriteFileSync(scanHistoryPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = cards.map((c) => formatScanHistoryRow(c, ts)).join('\n') + '\n';
  safeAppendFileSync(scanHistoryPath, lines, 'utf-8');
  return cards.length;
}

export function loadState(statePath = STATE_PATH) {
  // Merge over defaults so a hand-edited/partial state file can never strip
  // the seen map out from under the apply path.
  const defaults = { last_run: null, last_exit: null, runs: 0, seen: {} };
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(safeReadFileSync(statePath, 'utf-8'));
      const state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...defaults, ...parsed } : { ...defaults };
      if (!state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen)) state.seen = {};
      return state;
    }
  } catch (err) {
    emit('state_read_error', { error: String(err && err.message || err) });
  }
  return defaults;
}

export function saveState(state, statePath = STATE_PATH) {
  mkdirSync(dirname(statePath), { recursive: true });
  safeWriteFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ── Env / CLI ───────────────────────────────────────────────────────────────

// Minimal .env parse (same lightweight approach as scripts/launchd-wrapper.mjs)
// — only consulted for keys not already in process.env.
function envValue(key) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    const envPath = join(ROOT, '.env');
    if (!existsSync(envPath)) return undefined;
    for (const line of safeReadFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) {
        let v = m[2].trim();
        if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '').trim(); // strip unquoted trailing comment
        return v;
      }
    }
  } catch { /* fail open — env parse must never kill the run */ }
  return undefined;
}

// Non-numeric → fallback; numeric → clamped to ≥1 (so --limit=0 means 1, not
// a silent fall-through to the default — `|| fallback` would swallow the 0).
function clampPositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(1, n) : fallback;
}

/**
 * Kill-switch scope: ONLY scheduled runs no-op when the env var isn't exactly
 * 'true'. Manual runs always proceed so first-run review works pre-enablement.
 */
export function shouldNoopScheduledRun({ scheduled }, enabledValue) {
  return !!scheduled && enabledValue !== 'true';
}

export function parseArgs(argv) {
  const args = { apply: false, scheduled: false, limit: DEFAULT_LIMIT, maxPages: null };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--scheduled') args.scheduled = true;
    else if (a.startsWith('--limit=')) args.limit = clampPositiveInt(a.slice(8), DEFAULT_LIMIT);
    else if (a.startsWith('--max-pages=')) args.maxPages = clampPositiveInt(a.slice(12), DEFAULT_MAX_PAGES);
  }
  if (args.maxPages === null) {
    args.maxPages = clampPositiveInt(envValue('SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES'), DEFAULT_MAX_PAGES);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Kill switch — scheduled runs only. A disabled scheduled job exits 0 (a
  // disabled job must not alarm); manual runs always proceed.
  if (shouldNoopScheduledRun(args, envValue('SCAN_LINKEDIN_SAVED_JOBS_ENABLED'))) {
    emit('disabled_noop', { reason: 'SCAN_LINKEDIN_SAVED_JOBS_ENABLED !== true' });
    console.log('scan-linkedin-saved-jobs: disabled (SCAN_LINKEDIN_SAVED_JOBS_ENABLED) — no-op.');
    return 0;
  }

  emit('scan_start', { apply: args.apply, max_pages: args.maxPages, limit: args.limit });

  // CDP-first session (same architecture as phase-B-prime-mechanical-enrich):
  // the daemon Chrome's live session never drifts; freshly minted headless
  // storage-state sessions get invalidated by LinkedIn bot-detection.
  let dispose = async () => {};
  let scrape;
  try {
    let context;
    if (await isCdpAvailable()) {
      // The probe can race Chrome shutting down between check and attach —
      // an attach failure falls through to storage-state instead of aborting.
      try {
        const cdp = await connectToChromeCDP();
        emit('auth_mode', { mode: 'cdp' });
        // scrapeSavedJobs only calls context.newPage(); adapt the CDP helper so
        // pages open in the daemon Chrome's default (logged-in) context.
        context = { newPage: () => cdp.newPageInDefaultContext() };
        dispose = () => cdp.disconnect();
      } catch (err) {
        emit('cdp_attach_failed', { error: String(err && err.message || err) });
      }
    }
    if (!context && existsSync(STORAGE_STATE_PATH)) {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch (err) {
        emit('env_failure', { error: String(err && err.message || err) });
        console.error(`Playwright unavailable: ${err && err.message}`);
        return 4;
      }
      let browser;
      try {
        browser = await chromium.launch({ headless: true });
        emit('auth_mode', { mode: 'storage-state' });
        context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent: USER_AGENT,
          storageState: STORAGE_STATE_PATH,
        });
        dispose = () => browser.close();
      } catch (err) {
        emit('env_failure', { error: String(err && err.message || err) });
        console.error(`Browser launch/context failed: ${err && err.message}`);
        try { await browser?.close(); } catch { /* best-effort */ }
        return 4;
      }
    }
    if (!context) {
      emit('auth_missing', { cdp: false, storageState: false });
      console.error('No CDP listener at 127.0.0.1:9222 AND no LinkedIn storage state.');
      console.error('Recover: node scripts/launch-debug-chrome.mjs (recommended) or node scripts/scrape-contact-photo.mjs --setup-auth');
      return 2;
    }
    scrape = await scrapeSavedJobs({ context, maxPages: args.maxPages });
  } finally {
    try { await dispose(); } catch { /* disconnect/close best-effort */ }
  }

  if (scrape.state === 'login_wall') {
    console.error('LinkedIn login wall — session not authenticated.');
    console.error('CDP mode: log into LinkedIn once in the daemon Chrome (node scripts/launch-debug-chrome.mjs).');
    console.error('Storage-state mode: node scripts/scrape-contact-photo.mjs --setup-auth');
    return 2;
  }
  if (scrape.state === 'ambiguous_zero') {
    console.error('Zero saved-job cards but no empty-state indicator — likely LinkedIn DOM change. Refusing to report success.');
    return 3;
  }

  // Canonicalize the seen-set so raw URLs recorded by other writers (tracking
  // params, /comm/ prefixes) still match our canonical card URLs.
  const seen = new Set([...loadSeenUrls()].map((url) => canonicalize(url)));
  const state = loadState();
  const deduped = dedupeAgainstSeen(scrape.cards, seen, state.seen);
  // Rejection Gate (AGENTS.md — MANDATORY): never surface or persist a role
  // Mitchell was already rejected from. FAIL-CLOSED: if the deterministic
  // local helper errors while there ARE candidates to surface, abort loudly.
  // Nothing new to surface → gate not consulted (a dupes-only run must not
  // fail on gate availability).
  let fresh = deduped;
  let rejectedDrops = [];
  if (deduped.length > 0) {
    const exclusions = loadRejectionExclusions();
    if (exclusions === null) {
      console.error('Rejection gate unavailable (scripts/rejection-scan.mjs --json failed) — refusing to surface ungated jobs.');
      return 5;
    }
    ({ kept: fresh, dropped: rejectedDrops } = filterRejected(deduped, exclusions));
  }
  const capped = fresh.slice(0, args.limit);
  const skippedDupes = scrape.cards.length - deduped.length;

  for (const c of rejectedDrops) {
    emit('rejection_gate_skip', { url: c.url, company: c.company, title: c.title });
  }
  for (const c of scrape.cards) {
    if (rejectedDrops.includes(c)) continue;
    emit(fresh.includes(c) ? 'saved_job_new' : 'saved_job_dup_skipped', { url: c.url, company: c.company, title: c.title });
  }

  const rejectedNote = rejectedDrops.length ? `, ${rejectedDrops.length} dropped by rejection gate` : '';
  if (!args.apply) {
    console.log(`DRY RUN — scraped ${scrape.pagesScraped} page(s), ${scrape.cards.length} saved job(s), ${skippedDupes} already known${rejectedNote}.`);
    if (capped.length) {
      console.log(`Would append ${capped.length} row(s) to data/pipeline.md:`);
      const day = new Date().toISOString().slice(0, 10);
      for (const c of capped) console.log('  ' + formatPipelineRow(c, day));
    } else {
      console.log('Nothing new to append.');
    }
    if (fresh.length > capped.length) console.log(`(${fresh.length - capped.length} more held back by --limit=${args.limit})`);
    emit('scan_done', { mode: 'dry-run', total: scrape.cards.length, new: capped.length, dupes: skippedDupes });
    return 0;
  }

  const nowIso = new Date().toISOString();
  const appended = appendRowsToPipeline(capped);
  appendScanHistory(capped);
  for (const c of capped) state.seen[c.url] = nowIso;
  state.last_run = nowIso;
  state.last_exit = 0;
  state.runs = (state.runs || 0) + 1;
  saveState(state);

  for (const c of capped) emit('appended', { url: c.url });
  console.log(`Scraped ${scrape.pagesScraped} page(s), ${scrape.cards.length} saved job(s): appended ${appended} new, skipped ${skippedDupes} known${rejectedNote}.`);
  if (fresh.length > capped.length) console.log(`(${fresh.length - capped.length} more held back by --limit=${args.limit} — next run picks them up)`);
  emit('scan_done', { mode: 'apply', total: scrape.cards.length, appended, dupes: skippedDupes });
  return 0;
}

// ── Entry point (import-guarded so tests can import functions) ─────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      emit('unexpected_error', { error: String(err && err.stack || err) });
      console.error(err);
      process.exit(1);
    });
}
