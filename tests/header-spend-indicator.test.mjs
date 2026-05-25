#!/usr/bin/env node
/**
 * tests/header-spend-indicator.test.mjs
 *
 * Tests for the dashboard header pre-apply spend chip — Worker A deferred-UI
 * ship 2026-05-25. The UI logic lives inside the giant outer template literal
 * at scripts/build-dashboard.mjs, so we test by:
 *   1) reading the built dashboard/index.html
 *   2) extracting the relevant JS function via regex
 *   3) eval-ing in a sandboxed VM with a fake fetch + DOM stubs
 *
 * Separately, we test:
 *   - The endpoint contract by hitting GET /api/pre-apply-spend's underlying
 *     lib/pre-apply-spend-tracker.mjs (already covered in pre-apply-spend-
 *     tracker.test.mjs; this file's E2E hit is a smaller belt-and-suspenders)
 *   - The classifier function _preApplyClassify (extracted + invoked directly)
 *   - The HTML output (build-dashboard.mjs emits #mc-spend chip in mc-strip)
 *   - The CSS state binding (data-state="neutral"/"soft-warn"/"amber")
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { recordSpend, getDailySpend, _internal } from '../lib/pre-apply-spend-tracker.mjs';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BUILT_HTML = join(ROOT, 'dashboard/index.html');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('OK  ' + name); pass++; }
  else {
    console.error('FAIL ' + name);
    if (detail !== undefined) {
      try { console.error('  detail:', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Section 1: HTML output — built dashboard contains the chip
// ──────────────────────────────────────────────────────────────────────

if (!existsSync(BUILT_HTML)) {
  console.error('ERROR: dashboard/index.html does not exist; run `node scripts/build-dashboard.mjs` first.');
  process.exit(2);
}
const html = readFileSync(BUILT_HTML, 'utf-8');

check('T1-1 chip element renders into dashboard',
  /id="mc-spend"/.test(html), null);

check('T1-2 chip has default data-state="neutral"',
  /<div[^>]*id="mc-spend"[^>]*data-state="neutral"/.test(html), null);

check('T1-3 chip has child span#mc-spend-text',
  /id="mc-spend-text"/.test(html), null);

check('T1-4 chip CSS rule exists (.mc-spend)',
  /\.mc-spend\s*\{/.test(html), null);

check('T1-5 chip has amber state CSS',
  /\.mc-spend\[data-state="amber"\]/.test(html), null);

check('T1-6 chip has soft-warn state CSS',
  /\.mc-spend\[data-state="soft-warn"\]/.test(html), null);

check('T1-7 chip has neutral state CSS',
  /\.mc-spend\[data-state="neutral"\]/.test(html), null);

check('T1-8 mobile breakpoint hides chip text on narrow widths',
  /\.mc-spend \.mc-spend-text\s*\{\s*display:\s*none/.test(html), null);

check('T1-9 chip placed in mc-strip (sibling to mc-health)',
  /id="mc-health"[\s\S]*?id="mc-spend"/.test(html), 'mc-spend not found after mc-health in html');

check('T1-10 refreshPreApplySpendChip function defined',
  /function refreshPreApplySpendChip\s*\(/.test(html), null);

check('T1-11 30s polling setInterval present',
  /setInterval\([\s\S]{0,200}refreshPreApplySpendChip[\s\S]{0,100}30000/.test(html), null);

check('T1-12 hidden-tab guard present (document.visibilityState === "visible")',
  /document\.visibilityState\s*===\s*['"]visible['"][\s\S]*?refreshPreApplySpendChip/.test(html), null);

check('T1-13 initial fetch call to /api/pre-apply-spend present',
  /fetch\(['"]\/api\/pre-apply-spend['"]/.test(html), null);

// ──────────────────────────────────────────────────────────────────────
// Section 2: _preApplyClassify — invoke directly inside a VM sandbox
// ──────────────────────────────────────────────────────────────────────

const classifyMatch = html.match(/function _preApplyClassify\(totalUsd\)\s*\{[\s\S]*?\n\}/);
check('T2-0 classifier function extractable from built html', !!classifyMatch, null);

if (classifyMatch) {
  const sandbox = {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(classifyMatch[0] + '\n; module = { exports: _preApplyClassify };', ctx);
  const _preApplyClassify = sandbox.module.exports;

  // Below soft-warn — neutral
  check('T2-1 classify(0) === neutral', _preApplyClassify(0) === 'neutral', _preApplyClassify(0));
  check('T2-2 classify(0.5) === neutral', _preApplyClassify(0.5) === 'neutral', _preApplyClassify(0.5));
  check('T2-3 classify(0.99) === neutral', _preApplyClassify(0.99) === 'neutral', _preApplyClassify(0.99));

  // $1-$2 — soft-warn
  check('T2-4 classify(1) === soft-warn', _preApplyClassify(1) === 'soft-warn', _preApplyClassify(1));
  check('T2-5 classify(1.50) === soft-warn', _preApplyClassify(1.50) === 'soft-warn', _preApplyClassify(1.50));
  check('T2-6 classify(1.99) === soft-warn', _preApplyClassify(1.99) === 'soft-warn', _preApplyClassify(1.99));

  // >= $2 — amber
  check('T2-7 classify(2) === amber', _preApplyClassify(2) === 'amber', _preApplyClassify(2));
  check('T2-8 classify(3.50) === amber', _preApplyClassify(3.50) === 'amber', _preApplyClassify(3.50));
  check('T2-9 classify(100) === amber', _preApplyClassify(100) === 'amber', _preApplyClassify(100));

  // Edge: NaN / negative defensive — current contract treats as neutral (< 1)
  check('T2-10 classify(NaN) === neutral (defensive)', _preApplyClassify(NaN) === 'neutral', _preApplyClassify(NaN));
  check('T2-11 classify(-1) === neutral (defensive)', _preApplyClassify(-1) === 'neutral', _preApplyClassify(-1));
}

// ──────────────────────────────────────────────────────────────────────
// Section 3: refreshPreApplySpendChip — invoke with mocked fetch + DOM
// ──────────────────────────────────────────────────────────────────────

// Extract just refreshPreApplySpendChip body via regex on the built html.
// The function is plain async/await; we evaluate in a sandbox with minimal
// global stubs (document.getElementById + fetch + console).
const refreshFnMatch = html.match(/async function refreshPreApplySpendChip\s*\(\)\s*\{[\s\S]*?\n\}/);
check('T3-0 refresh function extractable from built html', !!refreshFnMatch, null);

if (refreshFnMatch && classifyMatch) {
  // Helper to build a DOM stub with two elements.
  function makeDom() {
    const chip = {
      _attrs: { 'data-state': 'neutral' },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return this._attrs[k] || null; },
    };
    const txt = { textContent: 'Pre-apply: —' };
    const elements = { 'mc-spend': chip, 'mc-spend-text': txt };
    const documentStub = {
      getElementById(id) { return elements[id] || null; },
    };
    return { chip, txt, documentStub };
  }

  async function runRefreshWith(fetchImpl) {
    const { chip, txt, documentStub } = makeDom();
    const sandbox = {
      document: documentStub,
      fetch: fetchImpl,
      console,
      window: {},
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(classifyMatch[0] + '\n' + refreshFnMatch[0] + '\nrun = () => refreshPreApplySpendChip();', ctx);
    await ctx.run();
    return { chip, txt };
  }

  // T3-1: total $0 → neutral state
  {
    const ok = { ok: true, total_usd: 0, call_count: 0, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => ok, status: 200 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-1 zero-spend → neutral data-state', chip.getAttribute('data-state') === 'neutral', chip._attrs);
    check('T3-1 zero-spend → text "Pre-apply: $0.00"', txt.textContent === 'Pre-apply: $0.00', txt.textContent);
    check('T3-1 zero-spend → tooltip includes total + calls',
      /Pre-apply spend today: \$0\.00/.test(chip.getAttribute('title')) &&
      /Calls: 0/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-2: total $1.50 → soft-warn
  {
    const data = { ok: true, total_usd: 1.5, call_count: 33, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-2 $1.50 → soft-warn data-state', chip.getAttribute('data-state') === 'soft-warn', chip._attrs);
    check('T3-2 $1.50 → text "Pre-apply: $1.50"', txt.textContent === 'Pre-apply: $1.50', txt.textContent);
    check('T3-2 $1.50 → tooltip includes "approaching threshold"',
      /soft-warn/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-3: total $2.50 → amber
  {
    const data = { ok: true, total_usd: 2.5, call_count: 55, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-3 $2.50 → amber data-state', chip.getAttribute('data-state') === 'amber', chip._attrs);
    check('T3-3 $2.50 → text "Pre-apply: $2.50"', txt.textContent === 'Pre-apply: $2.50', txt.textContent);
    check('T3-3 $2.50 → tooltip mentions AMBER',
      /AMBER/i.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-4: fetch error / non-200 → falls back to neutral with "?"
  {
    const fakeFetch = async () => ({ ok: false, json: async () => ({}), status: 500 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-4 HTTP 500 → neutral fallback', chip.getAttribute('data-state') === 'neutral', chip._attrs);
    check('T3-4 HTTP 500 → text "Pre-apply: ?"', txt.textContent === 'Pre-apply: ?', txt.textContent);
    check('T3-4 HTTP 500 → tooltip says unavailable',
      /unavailable/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-5: server returns ok:false → neutral fallback with error
  {
    const data = { ok: false, error: 'tracker not available' };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-5 ok:false → neutral fallback', chip.getAttribute('data-state') === 'neutral', chip._attrs);
    check('T3-5 ok:false → text "Pre-apply: ?"', txt.textContent === 'Pre-apply: ?', txt.textContent);
    check('T3-5 ok:false → tooltip includes error msg',
      /tracker not available/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-6: thrown fetch (network failure) → caught, neutral fallback
  {
    const fakeFetch = async () => { throw new Error('NetworkError'); };
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-6 network error → neutral fallback (no throw)', chip.getAttribute('data-state') === 'neutral', chip._attrs);
    check('T3-6 network error → text "Pre-apply: ?"', txt.textContent === 'Pre-apply: ?', txt.textContent);
    check('T3-6 network error → tooltip includes NetworkError',
      /NetworkError/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-7: large totals — formatting
  {
    const data = { ok: true, total_usd: 99.99, call_count: 1000, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip, txt } = await runRefreshWith(fakeFetch);
    check('T3-7 large total → still amber', chip.getAttribute('data-state') === 'amber', chip._attrs);
    check('T3-7 large total → text formatted to 2 decimals', txt.textContent === 'Pre-apply: $99.99', txt.textContent);
  }

  // T3-8: avg per call calculation
  {
    const data = { ok: true, total_usd: 1.0, call_count: 20, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip } = await runRefreshWith(fakeFetch);
    check('T3-8 avg per call surfaces in tooltip',
      /Average per call: \$0\.0500/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-9: zero calls → "no calls yet" text in tooltip
  {
    const data = { ok: true, total_usd: 0, call_count: 0, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip } = await runRefreshWith(fakeFetch);
    check('T3-9 zero calls → "No pre-apply calls yet" in tooltip',
      /No pre-apply calls yet/.test(chip.getAttribute('title')), chip.getAttribute('title'));
  }

  // T3-10: aria-label updates with each refresh
  {
    const data = { ok: true, total_usd: 5.55, call_count: 100, threshold: 2 };
    const fakeFetch = async () => ({ ok: true, json: async () => data, status: 200 });
    const { chip } = await runRefreshWith(fakeFetch);
    check('T3-10 aria-label includes spend total + call count',
      /\$5\.55/.test(chip.getAttribute('aria-label')) &&
      /100 calls/.test(chip.getAttribute('aria-label')), chip.getAttribute('aria-label'));
  }
}

// ──────────────────────────────────────────────────────────────────────
// Section 4: lib/pre-apply-spend-tracker E2E — endpoint contract sanity
// ──────────────────────────────────────────────────────────────────────

const TMP_ROOT = join(tmpdir(), 'header-spend-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
mkdirSync(join(TMP_ROOT, 'data'), { recursive: true });

try {
  // T4-1: empty disk returns zero state with threshold
  {
    const r = getDailySpend(TMP_ROOT);
    check('T4-1 endpoint shape: { day, total_usd, call_count, warn, threshold }',
      typeof r.day === 'string' && r.day.length === 10 &&
      typeof r.total_usd === 'number' && r.total_usd === 0 &&
      typeof r.call_count === 'number' && r.call_count === 0 &&
      typeof r.warn === 'boolean' && r.warn === false &&
      typeof r.threshold === 'number' && r.threshold === _internal.DEFAULT_WARN_USD, r);
  }

  // T4-2: under threshold → warn=false
  {
    recordSpend(TMP_ROOT, 0.50, { slug: 'test-1' });
    const r = getDailySpend(TMP_ROOT);
    check('T4-2 below threshold → warn=false', r.warn === false && r.total_usd === 0.5, r);
  }

  // T4-3: at threshold → warn=true
  {
    recordSpend(TMP_ROOT, 1.50, { slug: 'test-2' });
    const r = getDailySpend(TMP_ROOT);
    check('T4-3 at-threshold $2.00 → warn=true', r.warn === true && Math.abs(r.total_usd - 2.0) < 1e-6, r);
  }
} finally {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
}

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log('Summary: ' + pass + ' pass, ' + fail + ' fail (' + (pass + fail) + ' total)');
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  -', f.name);
  process.exit(1);
}
process.exit(0);
