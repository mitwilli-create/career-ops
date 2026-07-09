#!/usr/bin/env node
/**
 * tests/scan-linkedin-saved-jobs.test.mjs
 *
 * 2026-07-08 — Unit tests for scripts/scan-linkedin-saved-jobs.mjs.
 *
 * Mocks the Playwright layer by passing a stub `context` into
 * scrapeSavedJobs() (same injection pattern as tests/jd-url-canonicalization
 * .test.mjs). $0, no network, no real Chromium.
 *
 * Cases:
 *   1.  Happy path — 2 pages, dupes + tracking params → canonical set, pagination stop
 *   1b. maxPages cap — all-distinct pages still stop at the cap
 *   2.  Login wall — /login, /authwall, /checkpoint post-load URLs → state='login_wall'
 *   3.  Ambiguous zero — page 1, 0 anchors, generic body → state='ambiguous_zero' (silent-zero guard)
 *   3b. Anchors-without-cards — page-1 anchors all fail validation → ambiguous_zero
 *   4.  Confirmed empty — 0 anchors + "No saved jobs" body → state='empty_confirmed'
 *   4b. Real my-items card shape — empty anchor text, ", Verified" badge line (live-probed)
 *   5.  Dedup — seen-set (canonicalized) + local state map both skip
 *   5b. Rejection gate — hardExclude company+role pairs dropped; null exclusions pass through
 *   6.  Pipeline row format invariant — matches triage parse regex; pipes/newlines sanitized
 *   7.  scan-history row — 6 tab-separated cols, portal linkedin-saved, status added
 *   8.  Pendientes insertion — rows land inside '## Pendientes' before next '## ' (temp fixture)
 *   9.  Persistence round-trips — appendScanHistory header/rows; loadState/saveState
 *   10. parseArgs — defaults, flags, env override, clamps
 *   11. Scheduled kill-switch — disabled scheduled run exits 0 no-op (subprocess)
 *   11b. Kill-switch scope predicate — manual runs ignore the switch (pure)
 *
 * Exit codes: 0 all pass, 1 any failure.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyPageState,
  extractCardsFromEvalResult,
  dedupeAgainstSeen,
  filterRejected,
  formatPipelineRow,
  parseArgs,
  formatScanHistoryRow,
  appendRowsToPipeline,
  appendScanHistory,
  loadState,
  saveState,
  scrapeSavedJobs,
  shouldNoopScheduledRun,
} from '../scripts/scan-linkedin-saved-jobs.mjs';

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
  assert(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Mock factory ────────────────────────────────────────────────────────
// scenario.pages[i] = { anchors, bodyTextSample } returned by the i-th
// page.evaluate call. scenario.postLoadUrl overrides page.url() (login-wall
// simulation). goto() records requested URLs in scenario._gotos.
function makeMockContext(scenario) {
  scenario._gotos = [];
  let evalCount = 0;
  const page = {
    _currentUrl: '',
    goto: async (url) => {
      scenario._gotos.push(url);
      page._currentUrl = scenario.postLoadUrl || url;
      return { status: () => 200 };
    },
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    url: () => page._currentUrl,
    evaluate: async () => {
      const p = scenario.pages[Math.min(evalCount, scenario.pages.length - 1)];
      evalCount++;
      return {
        anchors: p.anchors || [],
        anchorCount: (p.anchors || []).length,
        bodyTextSample: p.bodyTextSample || '',
      };
    },
    close: async () => {},
  };
  return { newPage: async () => page };
}

const silentLog = () => {};

// ── Case 1: happy path ──────────────────────────────────────────────────
console.log('1. happy path — 2 pages, dupes + tracking params');
{
  const anchor = (id, title, company, extra = '') => ({
    href: `https://www.linkedin.com/jobs/view/${id}/${extra}`,
    anchorText: title,
    cardText: `${title}\n${company}\nSeattle, WA (Remote)`,
  });
  const context = makeMockContext({
    pages: [
      {
        anchors: [
          anchor(111, 'AI Solutions Architect', 'Anthropic', '?trackingId=abc&refId=xyz'),
          anchor(222, 'Forward Deployed Engineer', 'Sierra'),
          anchor(111, 'AI Solutions Architect', 'Anthropic'), // in-page dupe of 111
        ],
      },
      { anchors: [anchor(333, 'Executive Comms Manager', 'AMD')] },
      { anchors: [anchor(333, 'Executive Comms Manager', 'AMD')] }, // repeat page → stop
    ],
  });
  const r = await scrapeSavedJobs({ context, maxPages: 5, log: silentLog });
  assertEq(r.state, 'ok', '  state=ok');
  assertEq(r.cards.length, 3, '  3 unique cards across pages');
  const urls = r.cards.map((c) => c.url).sort();
  assertEq(urls[0], 'https://www.linkedin.com/jobs/view/111', '  tracking params stripped, canonical form');
  assert(urls.every((u) => /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/.test(u)), '  all URLs canonical');
  const card = r.cards.find((c) => c.url.endsWith('/222'));
  assertEq(card.title, 'Forward Deployed Engineer', '  title from anchor text');
  assertEq(card.company, 'Sierra', '  company from card text line 2');
  assertEq(r.pagesScraped, 3, '  stopped after repeat page (3 scraped, not maxPages)');
}

// ── Case 1b: maxPages cap with all-distinct pages ───────────────────────
console.log('1b. maxPages cap honored when every page has fresh cards');
{
  // 6 pages of unique jobs — without the cap the loop would keep going.
  const pages = Array.from({ length: 6 }, (_, p) => ({
    anchors: Array.from({ length: 10 }, (_, j) => ({
      href: `https://www.linkedin.com/jobs/view/${1000 + p * 10 + j}/`,
      anchorText: `Role ${p}-${j}`,
      cardText: `Role ${p}-${j}\nCo ${p}-${j}\nSeattle, WA`,
    })),
  }));
  const context = makeMockContext({ pages });
  const r = await scrapeSavedJobs({ context, maxPages: 3, log: silentLog });
  assertEq(r.state, 'ok', '  state=ok');
  assertEq(r.pagesScraped, 3, '  stopped at maxPages=3 despite fresh cards');
  assertEq(r.cards.length, 30, '  cards bounded by pages scraped (3×10)');
}

// ── Case 2: login wall ──────────────────────────────────────────────────
console.log('2. login wall detection');
for (const wall of [
  'https://www.linkedin.com/login?redirect=x',
  'https://www.linkedin.com/authwall?trk=y',
  'https://www.linkedin.com/checkpoint/challenge/abc',
]) {
  const context = makeMockContext({ postLoadUrl: wall, pages: [{ anchors: [] }] });
  const r = await scrapeSavedJobs({ context, maxPages: 3, log: silentLog });
  assertEq(r.state, 'login_wall', `  ${new URL(wall).pathname} → login_wall`);
  assertEq(r.cards.length, 0, '  no cards returned');
}

// ── Case 3: ambiguous zero (silent-zero guard) ──────────────────────────
console.log('3. ambiguous zero — parse failure, never success');
{
  const context = makeMockContext({
    pages: [{ anchors: [], bodyTextSample: 'My items\nSome unrelated LinkedIn chrome text' }],
  });
  const r = await scrapeSavedJobs({ context, maxPages: 3, log: silentLog });
  assertEq(r.state, 'ambiguous_zero', '  state=ambiguous_zero');
}

// ── Case 3b: anchors present but none survive extraction ────────────────
console.log('3b. page-1 anchors that all fail validation → ambiguous_zero (href-shape drift)');
{
  const context = makeMockContext({
    pages: [{
      // Selector matched (anchorCount > 0) but every href fails host/path
      // validation — extraction yields 0 cards. Must alarm, not report "ok".
      anchors: [
        { href: 'https://evil.example.com/?u=https://www.linkedin.com/jobs/view/1', anchorText: 'x', cardText: 'x' },
        { href: 'https://www.linkedin.com/jobs/view/not-a-number', anchorText: 'x', cardText: 'x' },
      ],
    }],
  });
  const r = await scrapeSavedJobs({ context, maxPages: 3, log: silentLog });
  assertEq(r.state, 'ambiguous_zero', '  state=ambiguous_zero, not ok');
}

// ── Case 4: confirmed empty ─────────────────────────────────────────────
console.log('4. confirmed empty list');
{
  const context = makeMockContext({
    pages: [{ anchors: [], bodyTextSample: 'My items\nNo saved jobs yet. Jobs you save will appear here.' }],
  });
  const r = await scrapeSavedJobs({ context, maxPages: 3, log: silentLog });
  assertEq(r.state, 'empty_confirmed', '  state=empty_confirmed');
  assertEq(r.cards.length, 0, '  0 cards');
}

// classifyPageState pure spot-checks
{
  assertEq(classifyPageState({ url: 'https://www.linkedin.com/my-items/saved-jobs/', anchorCount: 5, bodyText: '' }), 'ok', '  classify: anchors → ok');
  assertEq(classifyPageState({ url: 'https://www.linkedin.com/uas/login-submit', anchorCount: 0, bodyText: '' }), 'login_wall', '  classify: /uas/ → login_wall');
  assertEq(classifyPageState({ url: 'https://www.linkedin.com/my-items/saved-jobs/', anchorCount: 0, bodyText: "You haven't saved anything" }), 'empty_confirmed', "  classify: haven't saved → empty_confirmed");
}

// ── Case 4b: real my-items card shape (live-probed 2026-07-08) ──────────
console.log('4b. real card shape — empty anchor text, ", Verified" badge line');
{
  const cards = extractCardsFromEvalResult([
    {
      href: 'https://www.linkedin.com/jobs/view/4387606812/?refId=abc',
      anchorText: '',
      cardText: 'DevRel \n, Verified\nComet\nUnited States (Remote)\nPosted 1h ago',
    },
    {
      href: 'https://www.linkedin.com/jobs/view/4426860461/',
      anchorText: '',
      cardText: 'Integrated Communications Director \n, Verified\nBlue Origin\nArlington, VA (On-site)\nPosted 15h ago',
    },
  ]);
  assertEq(cards[0].title, 'DevRel', '  title from card line 1 (anchor text empty)');
  assertEq(cards[0].company, 'Comet', '  company skips the ", Verified" badge line');
  assertEq(cards[1].title, 'Integrated Communications Director', '  multi-word title');
  assertEq(cards[1].company, 'Blue Origin', '  company line correct');

  // Host/path validation on the RAW href — crafted non-LinkedIn hrefs whose
  // query/path merely CONTAINS a LinkedIn job URL must be rejected, not
  // rewritten into accepted URLs by canonicalize()'s substring match.
  const hostile = extractCardsFromEvalResult([
    { href: 'https://evil.example.com/?u=https://www.linkedin.com/jobs/view/999', anchorText: 'x', cardText: 'x\nY' },
    { href: 'https://evil.example.com/jobs/view/998', anchorText: 'x', cardText: 'x\nY' },
    { href: 'not a url at all /jobs/view/997', anchorText: 'x', cardText: 'x\nY' },
    { href: 'https://www.linkedin.com/jobs/view/996/?refId=ok', anchorText: 'Real', cardText: 'Real\nRealCo' },
  ]);
  assertEq(hostile.length, 1, '  only the genuine linkedin.com href survives');
  assertEq(hostile[0].url, 'https://www.linkedin.com/jobs/view/996', '  the survivor is the real one');
}

// ── Case 5: dedup ───────────────────────────────────────────────────────
console.log('5. dedup against seen-set + local state');
{
  const cards = extractCardsFromEvalResult([
    { href: 'https://www.linkedin.com/jobs/view/444/?trk=flag', anchorText: 'Role A', cardText: 'Role A\nCoA' },
    { href: 'https://www.linkedin.com/jobs/view/555/', anchorText: 'Role B', cardText: 'Role B\nCoB' },
    { href: 'https://www.linkedin.com/jobs/view/666/', anchorText: 'Role C', cardText: 'Role C\nCoC' },
  ]);
  const seen = new Set(['https://www.linkedin.com/jobs/view/444']); // canonical form of the tracking-param'd input
  const localSeen = { 'https://www.linkedin.com/jobs/view/555': '2026-07-01T00:00:00Z' };
  const fresh = dedupeAgainstSeen(cards, seen, localSeen);
  assertEq(fresh.length, 1, '  only 1 survives both gates');
  assertEq(fresh[0].url, 'https://www.linkedin.com/jobs/view/666', '  the unseen one');
}

// ── Case 5b: rejection gate ─────────────────────────────────────────────
console.log('5b. rejection gate drops hardExclude pairs');
{
  const cards = [
    { url: 'https://www.linkedin.com/jobs/view/1', title: 'Director, Executive Communications', company: 'ExampleCo' },
    { url: 'https://www.linkedin.com/jobs/view/2', title: 'DevRel', company: 'Comet' },
  ];
  const exclusions = [{ company: 'exampleco ', role: ' director, executive communications' }];
  const { kept, dropped } = filterRejected(cards, exclusions);
  assertEq(dropped.length, 1, '  exact company+role match dropped (case/whitespace-insensitive)');
  assertEq(dropped[0].company, 'ExampleCo', '  the rejected role is the dropped one');
  assertEq(kept.length, 1, '  non-matching card kept');
  const passthrough = filterRejected(cards, null);
  assertEq(passthrough.kept.length, 2, '  null exclusions (gate unavailable) → fail-open, all kept');
  const partial = filterRejected(cards, [{ company: 'ExampleCo', role: 'Different Role' }]);
  assertEq(partial.kept.length, 2, '  same company + different role NOT dropped (exact-pair semantics)');
}

// ── Case 6: pipeline row format invariant ───────────────────────────────
console.log('6. pipeline row format matches triage parse contract');
{
  const row = formatPipelineRow(
    { url: 'https://www.linkedin.com/jobs/view/777', company: 'Evil|Pipe\nCo', title: 'Head of AI | Comms' },
    '2026-07-08',
  );
  // triage.mjs parsePipeline: /^- \[ \] (https?:\/\/\S+)/
  const m = row.match(/^- \[ \] (https?:\/\/\S+)/);
  assert(!!m, '  row matches triage parse regex');
  assertEq(m && m[1], 'https://www.linkedin.com/jobs/view/777', '  URL is first token');
  assert(!row.includes('\n'), '  no newlines in row');
  assertEq(row.split(' | ').length, 4, '  exactly 4 pipe-separated fields (url|company|title|date)');
  const blank = formatPipelineRow({ url: 'https://x.com/1', company: '', title: null }, '2026-07-08');
  assert(blank.includes('| Unknown | Unknown |'), '  empty company/title fall back to Unknown');
}

// ── Case 7: scan-history row ────────────────────────────────────────────
console.log('7. scan-history.tsv row format');
{
  const row = formatScanHistoryRow(
    { url: 'https://www.linkedin.com/jobs/view/888', title: 'Tab\there', company: 'Acme' },
    '2026-07-08T07:15:00-07:00',
  );
  const cols = row.split('\t');
  assertEq(cols.length, 6, '  6 tab-separated columns');
  assertEq(cols[0], 'https://www.linkedin.com/jobs/view/888', '  col 0 = url');
  assertEq(cols[2], 'linkedin-saved', '  col 2 = portal linkedin-saved');
  assertEq(cols[3], 'Tab here', '  tab inside title sanitized');
  assertEq(cols[5], 'added', '  col 5 = status added');
}

// ── Case 8: Pendientes insertion ────────────────────────────────────────
console.log('8. appendRowsToPipeline inserts inside ## Pendientes');
{
  const dir = mkdtempSync(join(tmpdir(), 'saved-jobs-test-'));
  const fixture = join(dir, 'pipeline.md');
  try {
    writeFileSync(fixture, [
      '# Pipeline', '',
      '## Pendientes', '',
      '### Tier 1 — Target Companies',
      '- [ ] https://example.com/existing | Old Co | Old Role | 2026-07-01', '',
      '## Procesadas', '',
      '- [x] https://example.com/done | Done Co | Done | 2026-06-01', '',
    ].join('\n'), 'utf-8');

    const n = appendRowsToPipeline(
      [{ url: 'https://www.linkedin.com/jobs/view/999', company: 'NewCo', title: 'New Role' }],
      { pipelinePath: fixture, date: '2026-07-08' },
    );
    assertEq(n, 1, '  1 row appended');
    const text = readFileSync(fixture, 'utf-8');
    const newIdx = text.indexOf('jobs/view/999');
    assert(newIdx > text.indexOf('## Pendientes'), '  row after Pendientes marker');
    assert(newIdx < text.indexOf('## Procesadas'), '  row before Procesadas heading');
    assert(text.includes('- [x] https://example.com/done'), '  existing Procesadas content preserved');
    assert(text.includes('- [ ] https://example.com/existing'), '  existing pending row preserved');

    // Missing-marker fallback: fresh file with no sections
    const bare = join(dir, 'bare.md');
    writeFileSync(bare, '# Pipeline\n', 'utf-8');
    appendRowsToPipeline(
      [{ url: 'https://www.linkedin.com/jobs/view/1000', company: 'C', title: 'T' }],
      { pipelinePath: bare, date: '2026-07-08' },
    );
    const bareText = readFileSync(bare, 'utf-8');
    assert(bareText.includes('## Pendientes'), '  fallback creates ## Pendientes');
    assert(bareText.includes('jobs/view/1000'), '  fallback row written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Case 9: persistence round-trips (scan-history + state file) ─────────
console.log('9. appendScanHistory + loadState/saveState round-trip');
{
  const dir = mkdtempSync(join(tmpdir(), 'saved-jobs-persist-'));
  try {
    // scan-history: header auto-created, rows appended, 6-column contract
    const tsv = join(dir, 'scan-history.tsv');
    const cards = [
      { url: 'https://www.linkedin.com/jobs/view/1', title: 'T1', company: 'C1' },
      { url: 'https://www.linkedin.com/jobs/view/2', title: 'T2', company: 'C2' },
    ];
    appendScanHistory(cards, { scanHistoryPath: tsv, isoTs: '2026-07-08T07:15:00-07:00' });
    appendScanHistory([cards[0]], { scanHistoryPath: tsv, isoTs: '2026-07-09T07:15:00-07:00' });
    const lines = readFileSync(tsv, 'utf-8').trim().split('\n');
    assertEq(lines[0], 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus', '  header created once');
    assertEq(lines.length, 4, '  3 rows appended across 2 calls (header not duplicated)');
    assert(lines.slice(1).every((l) => l.split('\t').length === 6), '  every row has 6 columns');

    // state: fresh default → save → load round-trip; parent dir auto-created
    const statePath = join(dir, 'nested', 'state.json');
    const fresh = loadState(statePath);
    assertEq(fresh.runs, 0, '  missing state file → default shape');
    fresh.last_run = '2026-07-09T00:00:00Z';
    fresh.last_exit = 0;
    fresh.runs = 1;
    fresh.seen['https://www.linkedin.com/jobs/view/1'] = '2026-07-09T00:00:00Z';
    saveState(fresh, statePath);
    const reloaded = loadState(statePath);
    assertEq(reloaded.runs, 1, '  runs round-trips');
    assertEq(reloaded.seen['https://www.linkedin.com/jobs/view/1'], '2026-07-09T00:00:00Z', '  seen map round-trips');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Case 10: CLI arg parsing ────────────────────────────────────────────
console.log('10. parseArgs — defaults, flags, env override');
{
  const prevEnv = process.env.SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES;
  process.env.SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES = '7';
  try {
    const defaults = parseArgs([]);
    assertEq(defaults.apply, false, '  dry-run is the default');
    assertEq(defaults.scheduled, false, '  not scheduled by default');
    assertEq(defaults.limit, 25, '  default limit 25');
    assertEq(defaults.maxPages, 7, '  max-pages default honors env var');

    const full = parseArgs(['--apply', '--scheduled', '--limit=10', '--max-pages=2']);
    assertEq(full.apply, true, '  --apply parsed');
    assertEq(full.scheduled, true, '  --scheduled parsed');
    assertEq(full.limit, 10, '  --limit parsed');
    assertEq(full.maxPages, 2, '  CLI --max-pages beats env default');

    assertEq(parseArgs(['--apply', '--dry-run']).apply, false, '  --dry-run overrides --apply');
    assertEq(parseArgs(['--limit=0']).limit, 1, '  limit clamped to ≥1');
  } finally {
    if (prevEnv === undefined) delete process.env.SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES;
    else process.env.SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES = prevEnv;
  }
}

// ── Case 11: scheduled kill-switch short-circuits (subprocess) ──────────
console.log('11. --scheduled without SCAN_LINKEDIN_SAVED_JOBS_ENABLED=true → exit 0 no-op');
{
  const { execFileSync } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const scriptPath = fileURLToPath(new URL('../scripts/scan-linkedin-saved-jobs.mjs', import.meta.url));
  // Gate fires before any browser/network work, so this is fast and $0.
  const env = { ...process.env, SCAN_LINKEDIN_SAVED_JOBS_ENABLED: 'false' };
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [scriptPath, '--apply', '--scheduled'], {
      encoding: 'utf-8',
      env,
      timeout: Math.max(5_000, Number(process.env.TEST_CHILD_TIMEOUT_MS) || 60_000),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status ?? 1;
    out = (err.stdout || '') + (err.stderr || '');
  }
  assertEq(code, 0, '  disabled scheduled run exits 0 (must not alarm)');
  assert(/disabled/i.test(out), '  no-op message mentions the kill switch');
}

// ── Case 11b: kill-switch scope (pure predicate) ────────────────────────
console.log('11b. shouldNoopScheduledRun — scheduled-only kill switch');
{
  assertEq(shouldNoopScheduledRun({ scheduled: true }, undefined), true, '  scheduled + unset env → no-op');
  assertEq(shouldNoopScheduledRun({ scheduled: true }, 'false'), true, '  scheduled + false → no-op');
  assertEq(shouldNoopScheduledRun({ scheduled: true }, 'true'), false, '  scheduled + true → runs');
  assertEq(shouldNoopScheduledRun({ scheduled: false }, 'false'), false, '  MANUAL run ignores the kill switch');
  assertEq(shouldNoopScheduledRun({ scheduled: false }, undefined), false, '  manual + unset env → runs');
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
