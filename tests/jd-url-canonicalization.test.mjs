#!/usr/bin/env node
/**
 * tests/jd-url-canonicalization.test.mjs
 *
 * 2026-05-29 — Unit tests for lib/jd-url-canonicalizer.mjs::canonicalize().
 *
 * Mocks the Playwright layer by passing a stub `context` (and through that, a
 * stub `page`) into canonicalize(). This bypasses the live LinkedIn fetch
 * entirely. The lazy `await import('playwright')` still runs but its result
 * is unused on the mocked path.
 *
 * Cases:
 *   1. Already-canonical Greenhouse URL → unchanged, source='already-canonical'
 *   2. Empty/null input → {canonical: null, error}, no throw
 *   3. Unknown host → passes through with confidence 0.30
 *   4. LinkedIn URL with valid Apply button → resolves to ATS URL (source='apply-link')
 *   5. LinkedIn URL with no Apply button + no fallback → {canonical: null, error}
 *   6. LinkedIn URL with 404 → {canonical: null, error: 'linkedin HTTP 404'}
 *   7. LinkedIn URL that redirects to a canonical ATS host → source='ats-redirect'
 *   8. classifyUrl + isLinkedInJobUrl helpers — pure-function spot checks
 *
 * Exit codes:
 *   0 — all pass
 *   1 — at least one assertion failed
 */

import { canonicalize, isLinkedInJobUrl, classifyUrl } from '../lib/jd-url-canonicalizer.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; }
  else {
    failed++;
    failures.push(label);
    console.error(`✗ ${label}`);
  }
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  assert(ok, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Mock factory ────────────────────────────────────────────────────────
// makeMockBrowserContext({ scenario }) returns a stub Playwright Browser+Context
// that drives canonicalize() down the chosen code path without touching network.
//
// Call order inside canonicalize() (lib/jd-url-canonicalizer.mjs):
//   1. page.goto(original) → 2. page.url() postLoadUrl check
//   3. evaluate #1: extractApplyDestination strategy-1 (querySelectorAll → applyHref)
//   4. evaluate #2: extractApplyDestination strategy-2 (body.innerText → textHref)
//   5. evaluate #3: bodyText for "no longer accepting" check
//   6. evaluate #4+: extractTitleAndCompany (title + company)
//
// Each evaluate call increments _evalCount; the mock returns the scenario value
// that corresponds to that call position.
function makeMockBrowserContext(scenario) {
  const page = {
    _currentUrl: '',
    _evalCount: 0,
    setDefaultTimeout: () => {},
    goto: async (url) => {
      page._currentUrl = scenario.postLoadUrl || url;
      return { status: () => scenario.status ?? 200 };
    },
    waitForTimeout: async () => {},
    url: () => page._currentUrl,
    evaluate: async (fn, _arg) => {
      page._evalCount++;
      if (page._evalCount === 1) return scenario.applyHref || null;       // strategy-1
      if (page._evalCount === 2) return scenario.textHref || null;        // strategy-2
      if (page._evalCount === 3) return scenario.bodyText || '';          // no-longer-accepting check
      // Subsequent evaluates fall into extractTitleAndCompany — return shape ({title, company}).
      return scenario.titleCompany || { title: '', company: '' };
    },
    close: async () => {},
  };
  const context = {
    newPage: async () => page,
    close: async () => {},
  };
  const browser = {
    newContext: async () => context,
    close: async () => {},
  };
  return { browser, context };
}

// ── Case 1: Already-canonical Greenhouse URL ────────────────────────────
console.log('1. already-canonical Greenhouse URL');
{
  const result = await canonicalize('https://job-boards.greenhouse.io/anthropic/jobs/5138099008');
  assertEq(result.canonical, 'https://job-boards.greenhouse.io/anthropic/jobs/5138099008', '  canonical unchanged');
  assertEq(result.source, 'already-canonical', '  source=already-canonical');
  assertEq(result.confidence, 1.0, '  confidence=1.0');
}

// ── Case 2: Empty/null input ────────────────────────────────────────────
console.log('2. empty/null input');
{
  const empty = await canonicalize('');
  assertEq(empty.canonical, null, '  empty: canonical=null');
  assert(typeof empty.error === 'string', '  empty: error is string');

  const nullish = await canonicalize(null);
  assertEq(nullish.canonical, null, '  null: canonical=null');
}

// ── Case 3: Unknown host ────────────────────────────────────────────────
console.log('3. unknown host pass-through');
{
  const r = await canonicalize('https://example.com/some-job-page');
  assertEq(r.canonical, 'https://example.com/some-job-page', '  canonical=input');
  assertEq(r.source, 'unresolved', '  source=unresolved');
  assertEq(r.confidence, 0.30, '  confidence=0.30');
}

// ── Case 4: LinkedIn URL with valid Apply button ────────────────────────
console.log('4. LinkedIn URL with valid Apply button');
{
  const { browser, context } = makeMockBrowserContext({
    status: 200,
    applyHref: 'https://job-boards.greenhouse.io/anthropic/jobs/12345',
  });
  const r = await canonicalize('https://www.linkedin.com/jobs/view/4255886677/', { browser, context, timeoutMs: 5000 });
  assertEq(r.canonical, 'https://job-boards.greenhouse.io/anthropic/jobs/12345', '  canonical=apply-href');
  assertEq(r.source, 'apply-link', '  source=apply-link');
  assertEq(r.confidence, 0.95, '  confidence=0.95');
}

// ── Case 5: LinkedIn URL with no Apply button + no fallback ─────────────
console.log('5. LinkedIn URL with no Apply button + no fallback');
{
  const { browser, context } = makeMockBrowserContext({
    status: 200,
    applyHref: null,
    textHref: null,
    bodyText: 'Some content with no canonical ATS link',
    titleCompany: { title: '', company: '' },
  });
  const r = await canonicalize('https://www.linkedin.com/jobs/view/4255886677/', { browser, context, timeoutMs: 5000 });
  assertEq(r.canonical, null, '  canonical=null');
  assertEq(r.source, 'unresolved', '  source=unresolved');
  assert(typeof r.error === 'string', '  error is string');
}

// ── Case 6: LinkedIn URL with HTTP 404 ──────────────────────────────────
console.log('6. LinkedIn URL with HTTP 404');
{
  const { browser, context } = makeMockBrowserContext({
    status: 404,
    postLoadUrl: 'https://www.linkedin.com/jobs/view/4255886677/',
  });
  const r = await canonicalize('https://www.linkedin.com/jobs/view/4255886677/', { browser, context, timeoutMs: 5000 });
  assertEq(r.canonical, null, '  canonical=null on 404');
  assert(/HTTP 404/.test(r.error || ''), '  error contains HTTP 404');
}

// ── Case 7: LinkedIn URL that redirects to canonical ATS host ───────────
console.log('7. LinkedIn URL redirecting to canonical ATS host');
{
  const { browser, context } = makeMockBrowserContext({
    status: 200,
    postLoadUrl: 'https://jobs.ashbyhq.com/perplexity/2df92d4a',
  });
  const r = await canonicalize('https://www.linkedin.com/jobs/view/4255886677/', { browser, context, timeoutMs: 5000 });
  assertEq(r.canonical, 'https://jobs.ashbyhq.com/perplexity/2df92d4a', '  canonical=ATS-redirect-target');
  assertEq(r.source, 'ats-redirect', '  source=ats-redirect');
  assertEq(r.confidence, 0.90, '  confidence=0.90');
}

// ── Case 8: pure-function helpers ───────────────────────────────────────
console.log('8. isLinkedInJobUrl + classifyUrl helpers');
{
  assert(isLinkedInJobUrl('https://www.linkedin.com/jobs/view/4255886677/'), '  isLinkedInJobUrl: canonical view URL');
  assert(isLinkedInJobUrl('https://linkedin.com/jobs/search?keywords=ai'), '  isLinkedInJobUrl: search URL');
  assert(!isLinkedInJobUrl('https://linkedin.com/in/mitwilli'), '  isLinkedInJobUrl: profile URL false');
  assert(!isLinkedInJobUrl('https://greenhouse.io/jobs/123'), '  isLinkedInJobUrl: Greenhouse false');
  assert(!isLinkedInJobUrl(''), '  isLinkedInJobUrl: empty false');
  assert(!isLinkedInJobUrl(null), '  isLinkedInJobUrl: null false');

  const gh = classifyUrl('https://job-boards.greenhouse.io/anthropic/jobs/5138099008');
  assertEq(gh.type, 'already-canonical', '  classifyUrl: Greenhouse=already-canonical');
  const li = classifyUrl('https://www.linkedin.com/jobs/view/4255886677/');
  assertEq(li.type, 'linkedin', '  classifyUrl: LinkedIn=linkedin');
  const ex = classifyUrl('https://example.com/job');
  assertEq(ex.type, 'unknown', '  classifyUrl: example.com=unknown');
}

// ── Report ──────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('🟢 All jd-url-canonicalization tests passed');
process.exit(0);
