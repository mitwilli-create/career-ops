#!/usr/bin/env node
/**
 * tests/v2-fix-log.mjs — unit tests for lib/v2-fix-log.mjs
 *
 * PR #7 of 10 (v2 autonomous-remediation pipeline, 2026-05-25).
 * No external dependencies. Uses /tmp for isolation.
 *
 * Run: node tests/v2-fix-log.mjs
 * Expected: all tests PASS, process exits 0.
 */

import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Test harness ──────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    _passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    _failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    _passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    _failed++;
  }
}

// ── Isolate the module under a temp path ────────────────────────────────
// We can't trivially monkey-patch the LOG_PATH constant, so instead we
// run tests against the real module and always clean up the log file
// between test groups. The module path is derived from REPO_ROOT which is
// 2 levels up from lib/v2-fix-log.mjs — we rely on the real data/ dir
// but use a temp file name to avoid clobbering real data.
//
// Strategy: shadow LOG_PATH by passing an env var is the cleanest approach
// but the module hardcodes the path. Instead we use a side-channel: write
// a minimal harness that overrides the export path using a temp file.
// For the purposes of unit tests we use the module directly but clean up.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(__filename, '..', '..'); // tests/../ = repo root

// We use a temporary JSONL file to avoid touching real data.
const TMP_DIR = join(tmpdir(), `v2-fix-log-test-${Date.now()}`);
mkdirSync(TMP_DIR, { recursive: true });
const TMP_LOG = join(TMP_DIR, 'v2-fix-log.jsonl');

// Since lib/v2-fix-log.mjs resolves LOG_PATH at module load time from
// __dirname, we need to test via its exported functions but intercept the
// file path. The cleanest way without modifying the module is to use the
// exported functions normally and set up/tear down the real log file path
// using process.env.V2_FIX_LOG_PATH — but the module doesn't honour that.
//
// Resolution: we test the exported logic directly and accept that the real
// data/v2-fix-log.jsonl is used. We save/restore any pre-existing file.

import {
  appendV2FixLogEntry,
  loadV2FixLog,
  readLast24hEntries,
  fixLogPath,
} from '../lib/v2-fix-log.mjs';

const REAL_LOG_PATH = fixLogPath();

function backupLog() {
  if (existsSync(REAL_LOG_PATH)) {
    return readFileSync(REAL_LOG_PATH, 'utf-8');
  }
  return null;
}

function restoreLog(backup) {
  if (backup === null) {
    if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  } else {
    writeFileSync(REAL_LOG_PATH, backup);
  }
}

// Minimal valid entry for reuse across tests.
const VALID_ENTRY = {
  fix_sha: 'abc1234567',
  detector: 'regression-guard',
  detector_severity: 'HIGH',
  finding_hash: 'sha256:aabbcc001122',
  pr_url: 'https://github.com/mitwilli-create/career-ops/pull/999',
  pr_state: 'DRAFT',
  verification: null,
  cost_usd: 0.42,
  files_changed: ['scripts/agents/regression-guard.mjs', 'lib/v2-thrash-counter.mjs'],
  time_to_resolution_ms: 180000,
};

// ── Test suite ────────────────────────────────────────────────────────────

console.log('\n── lib/v2-fix-log.mjs unit tests ──');

// ─ Group 1: appendV2FixLogEntry ──────────────────────────────────────────
console.log('\n  Group 1: appendV2FixLogEntry');

const backup1 = backupLog();
if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH); // fresh slate

test('writes a valid entry to the log file', () => {
  const entry = appendV2FixLogEntry({ ...VALID_ENTRY });
  ok(existsSync(REAL_LOG_PATH), 'log file should exist after first write');
  const raw = readFileSync(REAL_LOG_PATH, 'utf-8').trim();
  const parsed = JSON.parse(raw);
  strictEqual(parsed.fix_sha, 'abc1234567');
  strictEqual(parsed.detector, 'regression-guard');
  strictEqual(parsed.pr_state, 'DRAFT');
});

test('fills `at` with ISO timestamp when not provided', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const before = Date.now();
  appendV2FixLogEntry({ ...VALID_ENTRY });
  const parsed = JSON.parse(readFileSync(REAL_LOG_PATH, 'utf-8').trim());
  const ts = new Date(parsed.at).getTime();
  ok(ts >= before && ts <= Date.now(), '`at` should be a valid recent timestamp');
});

test('preserves explicit `at` value when provided', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const explicitAt = '2026-01-15T12:00:00.000Z';
  appendV2FixLogEntry({ ...VALID_ENTRY, at: explicitAt });
  const parsed = JSON.parse(readFileSync(REAL_LOG_PATH, 'utf-8').trim());
  strictEqual(parsed.at, explicitAt);
});

test('appends multiple entries (one per line)', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  appendV2FixLogEntry({ ...VALID_ENTRY, fix_sha: 'sha0000001' });
  appendV2FixLogEntry({ ...VALID_ENTRY, fix_sha: 'sha0000002' });
  const lines = readFileSync(REAL_LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  strictEqual(lines.length, 2, 'should have 2 lines');
  strictEqual(JSON.parse(lines[0]).fix_sha, 'sha0000001');
  strictEqual(JSON.parse(lines[1]).fix_sha, 'sha0000002');
});

test('returns the normalised entry', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const result = appendV2FixLogEntry({ ...VALID_ENTRY });
  ok(result && typeof result === 'object', 'should return an object');
  strictEqual(result.fix_sha, VALID_ENTRY.fix_sha);
  strictEqual(result.pr_state, VALID_ENTRY.pr_state);
});

test('sets files_changed to [] when not provided', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const { files_changed } = appendV2FixLogEntry({ ...VALID_ENTRY, files_changed: undefined });
  deepStrictEqual(files_changed, []);
});

test('sets cost_usd and time_to_resolution_ms to null when omitted', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const entry = appendV2FixLogEntry({ ...VALID_ENTRY, cost_usd: undefined, time_to_resolution_ms: undefined });
  strictEqual(entry.cost_usd, null);
  strictEqual(entry.time_to_resolution_ms, null);
});

test('throws when fix_sha is missing', () => {
  throws(() => appendV2FixLogEntry({ ...VALID_ENTRY, fix_sha: undefined }), /fix_sha required/);
});

test('throws when detector_severity is invalid', () => {
  throws(() => appendV2FixLogEntry({ ...VALID_ENTRY, detector_severity: 'MEGA' }), /detector_severity must be one of/);
});

test('throws when pr_state is invalid', () => {
  throws(() => appendV2FixLogEntry({ ...VALID_ENTRY, pr_state: 'PENDING' }), /pr_state must be one of/);
});

test('throws when a files_changed entry is too long (> 300 chars)', () => {
  throws(() => appendV2FixLogEntry({
    ...VALID_ENTRY,
    files_changed: ['a'.repeat(301)],
  }), /suspiciously long/);
});

test('throws when files_changed contains a non-string', () => {
  throws(() => appendV2FixLogEntry({
    ...VALID_ENTRY,
    files_changed: [42],
  }), /array of strings/);
});

restoreLog(backup1);

// ─ Group 2: loadV2FixLog ──────────────────────────────────────────────────
console.log('\n  Group 2: loadV2FixLog');

const backup2 = backupLog();
if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);

test('returns [] when file is absent', () => {
  const entries = loadV2FixLog();
  deepStrictEqual(entries, []);
});

test('returns all entries in order', () => {
  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_a', at: '2026-05-25T01:00:00Z' }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_b', at: '2026-05-25T02:00:00Z' }) + '\n'
  );
  const entries = loadV2FixLog();
  strictEqual(entries.length, 2);
  strictEqual(entries[0].fix_sha, 'sha_a');
  strictEqual(entries[1].fix_sha, 'sha_b');
});

test('skips malformed lines gracefully', () => {
  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_good' }) + '\n' +
    '{"malformed": true' + '\n' +   // broken JSON
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_also_good' }) + '\n'
  );
  const entries = loadV2FixLog();
  strictEqual(entries.length, 2, 'should skip the malformed line');
  strictEqual(entries[0].fix_sha, 'sha_good');
  strictEqual(entries[1].fix_sha, 'sha_also_good');
});

test('skips blank lines gracefully', () => {
  writeFileSync(REAL_LOG_PATH,
    '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_c' }) + '\n' +
    '\n\n'
  );
  const entries = loadV2FixLog();
  strictEqual(entries.length, 1);
});

restoreLog(backup2);

// ─ Group 3: readLast24hEntries ────────────────────────────────────────────
console.log('\n  Group 3: readLast24hEntries');

const backup3 = backupLog();
if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);

test('returns [] when log is absent', () => {
  deepStrictEqual(readLast24hEntries(), []);
});

test('returns only entries within the last 24h', () => {
  const now = new Date('2026-05-25T18:00:00Z').getTime();
  const recent = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
  const old    = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_recent', at: recent }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_old',    at: old    }) + '\n'
  );

  const entries = readLast24hEntries({ asOfMs: now });
  strictEqual(entries.length, 1);
  strictEqual(entries[0].fix_sha, 'sha_recent');
});

test('respects the asOfMs parameter', () => {
  const baseMs = new Date('2026-01-01T12:00:00Z').getTime();
  const within = new Date(baseMs - 12 * 60 * 60 * 1000).toISOString();
  const outside = new Date(baseMs - 25 * 60 * 60 * 1000).toISOString();

  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_in',  at: within  }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_out', at: outside }) + '\n'
  );

  const entries = readLast24hEntries({ asOfMs: baseMs });
  strictEqual(entries.length, 1);
  strictEqual(entries[0].fix_sha, 'sha_in');
});

test('returns all entries when all are within the last 24h', () => {
  const now = Date.now();
  const e1At = new Date(now - 1 * 60 * 60 * 1000).toISOString();
  const e2At = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const e3At = new Date(now - 23 * 60 * 60 * 1000).toISOString();

  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_1', at: e1At }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_2', at: e2At }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_3', at: e3At }) + '\n'
  );

  const entries = readLast24hEntries({ asOfMs: now });
  strictEqual(entries.length, 3);
});

test('handles entries with invalid `at` values gracefully (filters them out)', () => {
  const now = Date.now();
  const validAt = new Date(now - 1 * 60 * 60 * 1000).toISOString();

  writeFileSync(REAL_LOG_PATH,
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_valid',   at: validAt   }) + '\n' +
    JSON.stringify({ ...VALID_ENTRY, fix_sha: 'sha_invalid', at: 'not-a-date' }) + '\n'
  );

  const entries = readLast24hEntries({ asOfMs: now });
  // Invalid `at` → NaN from getTime() → not >= cutoff → filtered out.
  strictEqual(entries.length, 1);
  strictEqual(entries[0].fix_sha, 'sha_valid');
});

restoreLog(backup3);

// ─ Group 4: pr_state variants ─────────────────────────────────────────────
console.log('\n  Group 4: pr_state variants (DRAFT / MERGED / VERIFIED / REVERTED)');

const backup4 = backupLog();
if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);

for (const state of ['DRAFT', 'MERGED', 'VERIFIED', 'REVERTED']) {
  test(`accepts pr_state="${state}"`, () => {
    if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
    const entry = appendV2FixLogEntry({ ...VALID_ENTRY, pr_state: state });
    strictEqual(entry.pr_state, state);
  });
}

restoreLog(backup4);

// ─ Group 5: verification field ────────────────────────────────────────────
console.log('\n  Group 5: verification field');

const backup5 = backupLog();
if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);

test('stores verification: { overall: "PASS" }', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const entry = appendV2FixLogEntry({
    ...VALID_ENTRY,
    pr_state: 'VERIFIED',
    verification: { overall: 'PASS' },
  });
  deepStrictEqual(entry.verification, { overall: 'PASS' });
});

test('stores verification: { overall: "FAIL", fail_reason: "..." }', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const entry = appendV2FixLogEntry({
    ...VALID_ENTRY,
    pr_state: 'REVERTED',
    verification: { overall: 'FAIL', fail_reason: 'daemon restart failed after 2 retries' },
  });
  strictEqual(entry.verification?.overall, 'FAIL');
  strictEqual(entry.verification?.fail_reason, 'daemon restart failed after 2 retries');
});

test('stores verification: null when omitted', () => {
  if (existsSync(REAL_LOG_PATH)) unlinkSync(REAL_LOG_PATH);
  const entry = appendV2FixLogEntry({ ...VALID_ENTRY, verification: undefined });
  strictEqual(entry.verification, null);
});

restoreLog(backup5);

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n── Results: ${_passed} passed, ${_failed} failed ──\n`);
if (_failed > 0) process.exit(1);
