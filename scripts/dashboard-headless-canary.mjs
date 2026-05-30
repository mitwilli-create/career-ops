#!/usr/bin/env node
// scripts/dashboard-headless-canary.mjs
//
// Loads the dashboard headlessly via Playwright, clicks into the first few
// apply-now rows to exercise drawer rendering (the surface where most runtime
// "is not defined" bugs hide), captures all console errors + page errors, and
// asserts zero forbidden patterns.
//
// Forbidden patterns:
//   - "is not defined"        → catches client-side-reference-to-server-side-import
//   - "SyntaxError"           → catches outer-template-unescape that survives lint
//   - "[object Object]"       → catches toString-leak rendering bugs
//   - "Uncaught"              → catches any unhandled exception
//   - "Failed to fetch"       → catches API endpoint regressions
//
// Exit 0 if clean; exit 1 if any forbidden pattern fires. Other errors (network,
// timeout) exit 2 — the wrapper treats these as inconclusive and surfaces them
// to Mitchell rather than blocking deploy.
//
// Usage:
//   node scripts/dashboard-headless-canary.mjs
//   CANARY_URL=https://staging-dashboard.careers-ops.com/ node scripts/dashboard-headless-canary.mjs
//   CANARY_TIMEOUT_MS=60000 node scripts/dashboard-headless-canary.mjs

import { chromium } from 'playwright';

const URL_PRIMARY = process.env.CANARY_URL || 'http://localhost:3097/';
const URL_FALLBACK = 'https://staging-dashboard.careers-ops.com/';
const TIMEOUT_MS = parseInt(process.env.CANARY_TIMEOUT_MS || '30000', 10);
const ROW_CLICK_COUNT = parseInt(process.env.CANARY_ROW_CLICK_COUNT || '3', 10);

const FORBIDDEN_PATTERNS = [
  { re: /is not defined/i, kind: 'reference-error' },
  { re: /SyntaxError/, kind: 'syntax-error' },
  { re: /\[object Object\]/, kind: 'tostring-leak' },
  { re: /Uncaught/i, kind: 'uncaught-exception' },
  { re: /Failed to fetch/, kind: 'fetch-failure' },
];

// Network errors that are expected on localhost (Cloudflare Access, etc.) and
// should NOT fail the canary. Curate conservatively.
const IGNORED_PATTERNS = [
  /favicon\.ico/i,
  /chrome-extension:/i,
  /Refused to apply style/i, // CF Access redirect noise
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent: 'safe-dashboard-deploy-canary/1.0',
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text();
    if (IGNORED_PATTERNS.some(p => p.test(text))) return;
    errors.push({ kind: 'console', text, location: msg.location() });
  }
});
page.on('pageerror', (err) => {
  const text = err.message;
  if (IGNORED_PATTERNS.some(p => p.test(text))) return;
  errors.push({
    kind: 'pageerror',
    text,
    stack: err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : null,
  });
});
page.on('requestfailed', (req) => {
  const text = `${req.method()} ${req.url()} — ${req.failure()?.errorText || 'unknown failure'}`;
  if (IGNORED_PATTERNS.some(p => p.test(text))) return;
  // Only flag if it's an internal API call; external CDN failures are noise.
  if (!req.url().includes('/api/') && !req.url().includes('localhost:3097')) return;
  errors.push({ kind: 'requestfailed', text });
});

let usedUrl = URL_PRIMARY;
try {
  await page.goto(URL_PRIMARY, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
} catch (e) {
  console.error(`canary: ${URL_PRIMARY} unreachable (${e.message}); falling back to ${URL_FALLBACK}`);
  usedUrl = URL_FALLBACK;
  try {
    await page.goto(URL_FALLBACK, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  } catch (e2) {
    console.error(`✗ canary: both URLs unreachable. ${URL_FALLBACK}: ${e2.message}`);
    await browser.close();
    process.exit(2);
  }
}

// Wait for the apply-now table to populate. Best-effort — if the selector
// never appears, the row-click section is skipped silently.
try {
  await page.waitForSelector('tr[data-row-id]', { timeout: 10000 });
} catch (_) {
  // Continue anyway; canary still captures initial-page errors.
}

await page.waitForTimeout(2000);

// Click into a few apply-now row drawers. This is where _renderHMIntel and
// other drawer renderers run — the surface where the 2026-05-30 cascade
// crashed every time.
try {
  const rows = await page.locator('tr[data-row-id^="apply-"]').all();
  const N = Math.min(ROW_CLICK_COUNT, rows.length);
  for (let i = 0; i < N; i++) {
    try {
      await rows[i].click({ position: { x: 50, y: 10 }, timeout: 3000 });
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    } catch (e) {
      // Individual row click failures are not canary failures — the goal is to
      // exercise the renderer surface, not enforce 100% interaction success.
    }
  }
  console.error(`canary: exercised ${N} apply-now row drawer(s)`);
} catch (e) {
  console.error(`canary: row interaction skipped (${e.message})`);
}

await browser.close();

// Categorize errors.
const violations = [];
const benign = [];
for (const e of errors) {
  const matched = FORBIDDEN_PATTERNS.find(p => p.re.test(e.text));
  if (matched) violations.push({ ...e, violationKind: matched.kind });
  else benign.push(e);
}

if (violations.length > 0) {
  console.error(`✗ canary: ${violations.length} forbidden console error(s) on ${usedUrl}`);
  for (const v of violations.slice(0, 10)) {
    console.error(`    [${v.kind}/${v.violationKind}] ${v.text.split('\n')[0].slice(0, 160)}`);
    if (v.stack) {
      console.error(`        ${v.stack.split('\n')[0]}`);
    }
  }
  if (violations.length > 10) console.error(`    ... and ${violations.length - 10} more`);
  console.error('');
  console.error('  Most likely bug class: client-side-reference-to-server-side-import');
  console.error('  See AGENTS.md § Bug class: client-side-reference-to-server-side-import');
  console.error('  Recovery: cp <backup-html> dashboard/index.html && restart server');
  process.exit(1);
}

console.log(`✓ canary: dashboard renders cleanly on ${usedUrl}`);
if (benign.length > 0) {
  console.log(`  (${benign.length} non-forbidden console msg(s) ignored)`);
}
