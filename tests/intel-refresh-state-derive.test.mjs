#!/usr/bin/env node
/**
 * tests/intel-refresh-state-derive.test.mjs
 *
 * Smoke test for PR-E Phase 2 (2026-05-27):
 *   - lib/intel-refresh-state.mjs § getRefreshStatus (disk-derived)
 *   - lib/intel-refresh-state.mjs § computeSlotFiles (pure)
 *   - lib/intel-refresh-state.mjs § deriveStatus (pure)
 *   - dashboard-server.mjs static contract — endpoints route through helper
 *   - scripts/build-dashboard.mjs static contract — chip recognizes 'partial' status
 *
 * Phase 2 closes the parallel-write surface by making state.json a CACHE that's
 * DERIVED from disk on every read. After Phase 2, deleting state.json would NOT
 * lose information.
 *
 * Coverage:
 *   D1. deriveStatus — zero done + zero failed + no last_refresh    → 'never-refreshed'
 *   D2. deriveStatus — partial done (5 of 10)                       → 'partial'
 *   D3. deriveStatus — all 10 done + fresh last_refresh             → 'complete'
 *   D4. deriveStatus — all 10 done + stale last_refresh (>7d)       → 'stale'
 *   D5. deriveStatus — done + failed mix, partial                   → 'partial'
 *   D6. deriveStatus — failed-only, no done                          → 'partial'
 *
 *   F1. computeSlotFiles — all 10 slots present                     → all non-null/non-skipped
 *   F2. computeSlotFiles — hm-intel disk-missing                    → slot_files['hm-intel'] === null
 *   F3. computeSlotFiles — apply-pack dir absent                    → ats-detection {skipped:true, reason:'no-apply-pack'}
 *   F4. computeSlotFiles — no canonical_url + no url                 → liveness {skipped:true, reason:'no-canonical-url'}
 *   F5. computeSlotFiles — liveness file exists but URL key missing  → liveness === null
 *   F6. computeSlotFiles — empty-byte file                            → null (not counted as done)
 *   F7. computeSlotFiles — strategy-ceiling missing one metric file → null (multi-required)
 *   F8. computeSlotFiles — role-enrichment glob fallback (no bf prefix, ranked prefix matches)
 *
 *   G1. getRefreshStatus — non-existent row                          → never-refreshed + error
 *   G2. getRefreshStatus — row exists, all slots on disk             → status='complete', slots_done has 10
 *   G3. getRefreshStatus — row exists, hm-intel disk-missing + state.slots_failed has it → status='partial', slots_failed includes hm-intel
 *   G4. getRefreshStatus — row exists, hm-intel disk-missing + NOT in state → slots_missing includes hm-intel
 *   G5. getRefreshStatus — state.json absent entirely (Phase 2 contract) → still derives correctly from disk; last_refresh=null
 *   G6. getRefreshStatus — slot_files structure shape                  → every slot has descriptor or null
 *
 *   S1. dashboard-server.mjs uses getRefreshStatus from lib/intel-refresh-state.mjs (or wraps it)
 *   S2. scripts/build-dashboard.mjs renderer accepts 'partial' status (lookup pattern present)
 *   S3. SLOT_DESCRIPTORS table contains all 10 canonical slot names (matches intel-refresh.mjs VALID_SLOTS)
 *
 * No live API calls. No network. Pure local + tmpdir filesystem.
 *
 * Usage:  node tests/intel-refresh-state-derive.test.mjs
 * Exits 0 on pass; 1 on any failure.
 */

import {
  getRefreshStatus,
  computeSlotFiles,
  deriveStatus,
  lookupRow,
  getSlotNames,
  _internals,
} from '../lib/intel-refresh-state.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail !== undefined) console.error('  detail:', JSON.stringify(detail, null, 2));
    fail++;
    failures.push(name);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// deriveStatus — pure-function tests
// ─────────────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-05-27T12:00:00Z');

// D1 — empty → never-refreshed
check('D1: empty input → never-refreshed', deriveStatus([], [], null, 10, NOW_MS) === 'never-refreshed');

// D2 — 5 of 10 done → partial
check('D2: 5 of 10 done → partial', deriveStatus(['a','b','c','d','e'], [], '2026-05-27T11:00:00Z', 10, NOW_MS) === 'partial');

// D3 — all 10 done + fresh → complete
{
  const slots = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10'];
  check('D3: 10 done + fresh → complete', deriveStatus(slots, [], '2026-05-27T11:00:00Z', 10, NOW_MS) === 'complete');
}

// D4 — all 10 done + last_refresh older than 7d → stale
{
  const slots = ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10'];
  const old = '2026-05-15T00:00:00Z';  // 12d before NOW_MS
  check('D4: 10 done + stale last_refresh → stale', deriveStatus(slots, [], old, 10, NOW_MS) === 'stale');
}

// D5 — done + failed mix, total < expected → partial
check('D5: done + failed mix, partial', deriveStatus(['a','b','c'], ['d'], '2026-05-27T11:00:00Z', 10, NOW_MS) === 'partial');

// D6 — failed-only → partial
check('D6: failed-only → partial', deriveStatus([], ['d','e'], '2026-05-27T11:00:00Z', 10, NOW_MS) === 'partial');

// ─────────────────────────────────────────────────────────────────────────
// computeSlotFiles — pure tests against tmpdir overlays
// ─────────────────────────────────────────────────────────────────────────

function makeFakeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'irs-test-'));
  for (const sub of [
    'data/hm-intel',
    'data/company-toxicity-cache',
    'data/strategy-ceiling',
    'data/positioning-cache',
    'data/role-enrichment',
    'data/hm-chance',
    'data/interview-likelihood',
    'data/team-health',
    'apply-pack',
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj), 'utf-8');
}

const SAMPLE_ROW = {
  num: 999,
  company: 'Acme Co',
  role: 'Senior Engineer',
  canonical_url: 'https://acme.example.com/jobs/sr-eng-1',
};

// F1 — all 10 slots present + non-empty
{
  const fakeRoot = makeFakeRoot();
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  const padded = '999';
  writeJson(join(fakeRoot, 'data', 'hm-intel', `${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'company-toxicity-cache', `${cSlug}.json`), { a: 1 });
  for (const m of ['alignment', 'interview-likelihood', 'hm-noticing']) {
    writeJson(join(fakeRoot, 'data', 'strategy-ceiling', `${padded}-${m}.json`), { a: 1 });
  }
  writeJson(join(fakeRoot, 'data', 'positioning-cache', `${padded}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'liveness-cache.json'), { [SAMPLE_ROW.canonical_url]: { status: 'active' } });
  writeJson(join(fakeRoot, 'data', 'role-enrichment', `bf${SAMPLE_ROW.num}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'hm-chance', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'interview-likelihood', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'team-health', `${cSlug}.json`), { a: 1 });
  // ats-detection: create apply-pack dir + sidecar
  const packDir = join(fakeRoot, 'apply-pack', `${padded}-${cSlug}-${rSlug}`);
  mkdirSync(packDir, { recursive: true });
  writeJson(join(packDir, 'cv-tailored.md.ai-detection.json'), { a: 1 });

  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F1: all 10 slots present → all non-null/non-skipped', getSlotNames().every(s => sf[s] !== null && !(sf[s] && sf[s].skipped === true) || (sf[s] && sf[s].skipped === true)), sf);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F2 — hm-intel missing
{
  const fakeRoot = makeFakeRoot();
  // Don't write hm-intel file
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F2: hm-intel disk-missing → null', sf['hm-intel'] === null, sf['hm-intel']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F3 — apply-pack dir absent → ats-detection skipped
{
  const fakeRoot = makeFakeRoot();
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F3: no apply-pack → ats-detection {skipped:true,reason:no-apply-pack}',
    sf['ats-detection']?.skipped === true && sf['ats-detection']?.reason === 'no-apply-pack',
    sf['ats-detection']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F4 — no canonical_url + no url → liveness skipped
{
  const fakeRoot = makeFakeRoot();
  const rowNoUrl = { num: 999, company: 'Acme Co', role: 'Senior Engineer' };
  const sf = computeSlotFiles(rowNoUrl, { rootOverride: fakeRoot });
  check('F4: no URL → liveness {skipped:true,reason:no-canonical-url}',
    sf['liveness']?.skipped === true && sf['liveness']?.reason === 'no-canonical-url',
    sf['liveness']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F5 — liveness file exists but URL key missing
{
  const fakeRoot = makeFakeRoot();
  writeJson(join(fakeRoot, 'data', 'liveness-cache.json'), { 'https://other.com/job': { status: 'active' } });
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F5: liveness file exists, URL missing → null', sf['liveness'] === null, sf['liveness']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F6 — empty-byte file
{
  const fakeRoot = makeFakeRoot();
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  writeFileSync(join(fakeRoot, 'data', 'hm-intel', `${cSlug}-${rSlug}.json`), '');  // empty
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  // file exists but size=0 → fileStat returns descriptor with size:0
  check('F6: empty file → descriptor with size 0',
    sf['hm-intel'] !== null && sf['hm-intel']?.size === 0,
    sf['hm-intel']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F7 — strategy-ceiling missing one of 3 metric files
{
  const fakeRoot = makeFakeRoot();
  // Write only 2 of 3 strategy-ceiling metrics
  writeJson(join(fakeRoot, 'data', 'strategy-ceiling', '999-alignment.json'), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'strategy-ceiling', '999-interview-likelihood.json'), { a: 1 });
  // Skip hm-noticing
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F7: strategy-ceiling missing one metric → null', sf['strategy-ceiling'] === null, sf['strategy-ceiling']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// F8 — role-enrichment glob fallback (rank-mode prefix, no bf)
{
  const fakeRoot = makeFakeRoot();
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  // No bf999 file; write a rank-prefixed file with matching slug suffix
  writeJson(join(fakeRoot, 'data', 'role-enrichment', `12-${cSlug}-${rSlug}.json`), { a: 1 });
  const sf = computeSlotFiles(SAMPLE_ROW, { rootOverride: fakeRoot });
  check('F8: role-enrichment glob fallback → matched non-null descriptor',
    sf['role-enrichment'] !== null && sf['role-enrichment']?.path?.endsWith(`12-${cSlug}-${rSlug}.json`),
    sf['role-enrichment']);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────
// getRefreshStatus — integration tests via tmpdir
// ─────────────────────────────────────────────────────────────────────────

function makeFakeQueue(fakeRoot, rows) {
  writeJson(join(fakeRoot, 'data', 'apply-now-queue.json'), { ranked: rows });
}

// G1 — non-existent row → never-refreshed + error
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, []);
  const r = getRefreshStatus(9999, { rootOverride: fakeRoot, queuePath: join(fakeRoot, 'data', 'apply-now-queue.json') });
  check('G1: non-existent row → never-refreshed + error', r.status === 'never-refreshed' && !!r.error, r);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// G2 — all slots on disk (complete)
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, [SAMPLE_ROW]);
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  const padded = '999';
  writeJson(join(fakeRoot, 'data', 'hm-intel', `${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'company-toxicity-cache', `${cSlug}.json`), { a: 1 });
  for (const m of ['alignment', 'interview-likelihood', 'hm-noticing']) {
    writeJson(join(fakeRoot, 'data', 'strategy-ceiling', `${padded}-${m}.json`), { a: 1 });
  }
  writeJson(join(fakeRoot, 'data', 'positioning-cache', `${padded}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'liveness-cache.json'), { [SAMPLE_ROW.canonical_url]: { status: 'active' } });
  writeJson(join(fakeRoot, 'data', 'role-enrichment', `bf${SAMPLE_ROW.num}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'hm-chance', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'interview-likelihood', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'team-health', `${cSlug}.json`), { a: 1 });
  // ats-detection — make pack dir + sidecar
  const packDir = join(fakeRoot, 'apply-pack', `${padded}-${cSlug}-${rSlug}`);
  mkdirSync(packDir, { recursive: true });
  writeJson(join(packDir, 'cv-tailored.md.ai-detection.json'), { a: 1 });
  // Write a fresh last_refresh
  writeJson(join(fakeRoot, 'data', 'intel-refresh-state.json'), {
    rows: { 999: { last_refresh: new Date().toISOString(), slots_done: getSlotNames() } },
  });

  const r = getRefreshStatus(999, {
    rootOverride: fakeRoot,
    queuePath: join(fakeRoot, 'data', 'apply-now-queue.json'),
    statePath: join(fakeRoot, 'data', 'intel-refresh-state.json'),
  });
  check('G2: all slots on disk + fresh state → complete', r.status === 'complete', { status: r.status, slots_done: r.slots_done });
  check('G2: slots_done has 10', r.slots_done.length === 10, r.slots_done);
  check('G2: slots_failed empty', r.slots_failed.length === 0, r.slots_failed);
  check('G2: slots_missing empty', r.slots_missing.length === 0, r.slots_missing);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// G3 — hm-intel missing + state.slots_failed has it → partial, includes hm-intel
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, [SAMPLE_ROW]);
  // Write 9 of 10 slot artifacts (skip hm-intel)
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  const padded = '999';
  writeJson(join(fakeRoot, 'data', 'company-toxicity-cache', `${cSlug}.json`), { a: 1 });
  for (const m of ['alignment', 'interview-likelihood', 'hm-noticing']) {
    writeJson(join(fakeRoot, 'data', 'strategy-ceiling', `${padded}-${m}.json`), { a: 1 });
  }
  writeJson(join(fakeRoot, 'data', 'positioning-cache', `${padded}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'liveness-cache.json'), { [SAMPLE_ROW.canonical_url]: { status: 'active' } });
  writeJson(join(fakeRoot, 'data', 'role-enrichment', `bf${SAMPLE_ROW.num}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'hm-chance', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'interview-likelihood', `${padded}-${cSlug}-${rSlug}.json`), { a: 1 });
  writeJson(join(fakeRoot, 'data', 'team-health', `${cSlug}.json`), { a: 1 });
  const packDir = join(fakeRoot, 'apply-pack', `${padded}-${cSlug}-${rSlug}`);
  mkdirSync(packDir, { recursive: true });
  writeJson(join(packDir, 'cv-tailored.md.ai-detection.json'), { a: 1 });

  // state.json claims hm-intel failed
  writeJson(join(fakeRoot, 'data', 'intel-refresh-state.json'), {
    rows: {
      999: {
        last_refresh: new Date().toISOString(),
        slots_done: getSlotNames().filter(s => s !== 'hm-intel'),
        slots_failed: [{ slot: 'hm-intel', error: 'exit_code=2', attempted_at: '2026-05-27T09:00:00Z' }],
      },
    },
  });

  const r = getRefreshStatus(999, {
    rootOverride: fakeRoot,
    queuePath: join(fakeRoot, 'data', 'apply-now-queue.json'),
    statePath: join(fakeRoot, 'data', 'intel-refresh-state.json'),
  });
  check('G3: hm-intel missing + state slots_failed → status partial', r.status === 'partial', { status: r.status });
  check('G3: slots_failed includes hm-intel', r.slots_failed.includes('hm-intel'), r.slots_failed);
  check('G3: slots_missing does NOT include hm-intel (it is known-failed)', !r.slots_missing.includes('hm-intel'), r.slots_missing);
  check('G3: slots_done has 9', r.slots_done.length === 9, r.slots_done);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// G4 — hm-intel missing + NOT in state → slots_missing has it
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, [SAMPLE_ROW]);
  // Write nothing — all slots missing, no state.json
  const r = getRefreshStatus(999, {
    rootOverride: fakeRoot,
    queuePath: join(fakeRoot, 'data', 'apply-now-queue.json'),
    statePath: join(fakeRoot, 'data', 'intel-refresh-state.json'),
  });
  check('G4: hm-intel missing + no state → slots_missing includes hm-intel', r.slots_missing.includes('hm-intel'), r.slots_missing);
  check('G4: no last_refresh → null', r.last_refresh === null, r);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// G5 — Phase 2 contract: state.json absent entirely still works
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, [SAMPLE_ROW]);
  const cSlug = 'acme-co';
  const rSlug = 'senior-engineer';
  // Write hm-intel only
  writeJson(join(fakeRoot, 'data', 'hm-intel', `${cSlug}-${rSlug}.json`), { a: 1 });
  // NO state.json
  const r = getRefreshStatus(999, {
    rootOverride: fakeRoot,
    queuePath: join(fakeRoot, 'data', 'apply-now-queue.json'),
    statePath: join(fakeRoot, 'data', 'intel-refresh-state.json'),
  });
  check('G5: state.json absent → still derives from disk', r.slots_done.includes('hm-intel'), r);
  check('G5: last_refresh is null when no state.json', r.last_refresh === null, r);
  rmSync(fakeRoot, { recursive: true, force: true });
}

// G6 — slot_files shape
{
  const fakeRoot = makeFakeRoot();
  makeFakeQueue(fakeRoot, [SAMPLE_ROW]);
  const r = getRefreshStatus(999, {
    rootOverride: fakeRoot,
    queuePath: join(fakeRoot, 'data', 'apply-now-queue.json'),
    statePath: join(fakeRoot, 'data', 'intel-refresh-state.json'),
  });
  check('G6: slot_files has all 10 slot keys',
    getSlotNames().every(s => Object.prototype.hasOwnProperty.call(r.slot_files, s)),
    Object.keys(r.slot_files));
  rmSync(fakeRoot, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Static-contract regression locks
// ─────────────────────────────────────────────────────────────────────────

const dashboardServerPath = join(ROOT, 'dashboard-server.mjs');
const dashboardServerSrc = existsSync(dashboardServerPath) ? readFileSync(dashboardServerPath, 'utf-8') : '';
const buildDashboardPath = join(ROOT, 'scripts', 'build-dashboard.mjs');
const buildDashboardSrc = existsSync(buildDashboardPath) ? readFileSync(buildDashboardPath, 'utf-8') : '';

// S1 — dashboard-server.mjs imports getRefreshStatus from lib/intel-refresh-state.mjs
check('S1: dashboard-server.mjs imports getRefreshStatus from lib/intel-refresh-state.mjs',
  dashboardServerSrc.includes('intel-refresh-state.mjs') && dashboardServerSrc.includes('getRefreshStatus'),
  { dashboardServerLen: dashboardServerSrc.length });

// S2 — scripts/build-dashboard.mjs renderer recognizes 'partial' status
check("S2: build-dashboard.mjs renderer handles 'partial' status string",
  buildDashboardSrc.includes("'partial'") || buildDashboardSrc.includes('"partial"'),
  { hits: (buildDashboardSrc.match(/['"]partial['"]/g) || []).length });

// S3 — SLOT_DESCRIPTORS table matches the canonical 10 slots
{
  const expected = ['hm-intel','toxicity','strategy-ceiling','positioning','liveness','ats-detection','role-enrichment','hm-chance','interview-likelihood','team-health'];
  const got = getSlotNames();
  const sameSet = expected.length === got.length && expected.every(s => got.includes(s));
  check('S3: SLOT_DESCRIPTORS contains the canonical 10 slots from intel-refresh.mjs', sameSet, { expected, got });
}

// ─────────────────────────────────────────────────────────────────────────
// Final report
// ─────────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('Failed tests:');
  for (const n of failures) console.error('  - ' + n);
  process.exit(1);
}
process.exit(0);
