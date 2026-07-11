// tests/stale-tracker-status-pass.test.mjs
//
// Verifies scripts/agents/stale-tracker-status-pass.mjs:
//   - parseTrackerLines: strict num/date/score; corrupted rows → malformed
//   - normalizeStatus / computeAgeDays helpers
//   - buildClassification bucketing: fresh / out-of-scope / unparseable /
//     override / purge / discard / refresh / refresh-unmapped / score-unknown
//   - classifyRow gating order (override → expired-purge → score-unknown →
//     below-floor-discard → keeper-refresh)
//   - DRY-RUN is the default and mutates NOTHING
//   - --apply REFUSES without STALE_STATUS_PASS_ENABLED=true (exit 3)
//   - --apply WITH the env gate performs the in-place flip + snapshot + archive
//     + audit JSONL, and NEVER touches out-of-scope / unparseable / fresh rows
//
// Hermetic: pure functions tested directly; subprocess tests use a temp tracker
// with --skip-liveness so no Playwright / no real data is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'agents', 'stale-tracker-status-pass.mjs');

const mod = await import('../scripts/agents/stale-tracker-status-pass.mjs');
const {
  parseTrackerLines, normalizeStatus, computeAgeDays, classifyRow, buildClassification,
  SCORE_FLOOR, STALE_DAYS_DEFAULT, IN_SCOPE_STATUSES,
} = mod;

// Fixed "now" so age math is deterministic. Reference: 2026-06-14.
// These are ONLY safe for the pure-function tests, which pass todayMs: NOW —
// the subprocess tests run the real script on the REAL clock and must use the
// relative dates below. Hardcoded dates in the subprocess fixture were a
// time-bomb: '2026-06-10' ("fresh") crossed the 30-day STALE_DAYS threshold at
// 2026-07-11T00:00Z and every CI run started failing (2 discards ≠ expected 1).
const NOW = Date.parse('2026-06-14T12:00:00Z');
const old = '2026-04-01'; // ~74d before NOW → stale
const fresh = '2026-06-10'; // ~4d before NOW → fresh
// Relative dates for subprocess fixtures (script uses Date.now(); no --today flag).
const isoDaysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const oldLive = isoDaysAgo(74);  // always stale, whatever the wall clock says
const freshLive = isoDaysAgo(4); // always fresh
const ctxBase = { todayMs: NOW, staleDays: STALE_DAYS_DEFAULT, overrideSet: new Set(), queueIndex: new Map(), livenessMap: new Map() };

function trackerLine({ num, date, company, role, score, status, report = '', notes = '' }) {
  return `| ${num} | ${date} | ${company} | ${role} | ${score} | ${status} | ❌ | ${report} | ${notes} |`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

test('normalizeStatus maps aliases + strips markdown', () => {
  assert.equal(normalizeStatus('Evaluated'), 'evaluated');
  assert.equal(normalizeStatus('**Applied**'), 'applied');
  assert.equal(normalizeStatus('sent'), 'applied');
  assert.equal(normalizeStatus('SKIP'), 'discarded');
  assert.equal(normalizeStatus('Discarded'), 'discarded');
});

test('computeAgeDays handles ISO dates + rejects garbage', () => {
  assert.equal(computeAgeDays('2026-06-14', NOW), 0);
  assert.equal(computeAgeDays('2026-06-04', NOW), 10);
  assert.equal(computeAgeDays('langchain', NOW), null);
  assert.equal(computeAgeDays('', NOW), null);
});

// ── parser ───────────────────────────────────────────────────────────────────

test('parseTrackerLines: well-formed row parses; score/num strict', () => {
  const text = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    trackerLine({ num: 100, date: old, company: 'Anthropic', role: 'AI PgM', score: '4.3/5', status: 'Evaluated' }),
  ].join('\n');
  const rows = parseTrackerLines(text);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.malformed, false);
  assert.equal(r.num, 100);
  assert.equal(r.dateOk, true);
  assert.equal(r.scoreKnown, true);
  assert.equal(r.score, 4.3);
  assert.equal(normalizeStatus(r.status), 'evaluated');
});

test('parseTrackerLines: corrupted/column-swapped row (à la 2721) → unactionable', () => {
  // Real-world shape: | 2721 | langchain | — | SKIP | ❌ | Evaluated | — | ... |
  const text = '| 2721 | langchain | — | SKIP | ❌ | Evaluated | — | score 1.5/5 | APAC hard skip |';
  const rows = parseTrackerLines(text);
  assert.equal(rows.length, 1);
  // num parses (2721) but the DATE cell is "langchain" → dateOk false → buildClassification refuses.
  assert.equal(rows[0].dateOk, false);
  const cls = buildClassification(rows[0], ctxBase);
  assert.equal(cls.bucket, 'skip-unparseable');
  assert.equal(cls.action, 'noop');
});

test('parseTrackerLines: "n/a" score → scoreKnown false', () => {
  const text = trackerLine({ num: 101, date: old, company: 'OpenAI', role: 'Lead', score: 'n/a', status: 'Evaluated' });
  const rows = parseTrackerLines(text);
  assert.equal(rows[0].scoreKnown, false);
  assert.equal(rows[0].score, null);
});

// ── classification buckets ────────────────────────────────────────────────────

test('fresh row (≤30d) → noop fresh', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 1, date: fresh, company: 'Co', role: 'R', score: '3.0/5', status: 'Evaluated' }));
  const cls = buildClassification(row, ctxBase);
  assert.equal(cls.bucket, 'fresh');
});

test('stale but out-of-scope status (Applied) → never touched', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 2, date: old, company: 'Co', role: 'R', score: '2.0/5', status: 'Applied' }));
  const cls = buildClassification(row, ctxBase);
  assert.equal(cls.bucket, 'out-of-scope');
  assert.equal(cls.action, 'noop');
});

test('stale Interview row → never auto-discarded even below floor', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 3, date: old, company: 'Co', role: 'R', score: '1.0/5', status: 'Interview' }));
  assert.equal(buildClassification(row, ctxBase).bucket, 'out-of-scope');
});

test('stale Evaluated, below floor, live → DISCARD', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 4, date: old, company: 'Co', role: 'R', score: '3.4/5', status: 'Evaluated' }));
  const cls = buildClassification(row, ctxBase);
  assert.equal(cls.bucket, 'discard');
  assert.equal(cls.action, 'discard');
});

test('stale Evaluated, keeper ≥4.0, in queue → REFRESH with queue num', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 9999, date: old, company: 'Anthropic', role: 'AI PgM', score: '4.5/5', status: 'Evaluated' }));
  const queueIndex = new Map([[`${mod.normKey('Anthropic', 'AI PgM')}`, '59']]);
  const cls = buildClassification(row, { ...ctxBase, queueIndex });
  assert.equal(cls.bucket, 'refresh');
  assert.equal(cls.action, 'refresh');
  assert.equal(cls.queueNum, '59'); // queue num, NOT the applications.md num 9999
});

test('stale Evaluated, keeper ≥4.0, NOT in queue → refresh-unmapped (no spend, no guess)', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 9999, date: old, company: 'Obscure', role: 'Role', score: '4.5/5', status: 'Evaluated' }));
  const cls = buildClassification(row, ctxBase);
  assert.equal(cls.bucket, 'refresh-unmapped');
  assert.equal(cls.action, 'noop');
});

test('stale Evaluated, score unknown (n/a) → score-unknown (human review, no discard)', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 5, date: old, company: 'Co', role: 'R', score: 'n/a', status: 'Evaluated' }));
  const cls = buildClassification(row, ctxBase);
  assert.equal(cls.bucket, 'score-unknown');
  assert.equal(cls.action, 'noop');
});

test('expired liveness PURGES regardless of score (keeper at a dead posting)', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 6, date: old, company: 'Co', role: 'R', score: '4.8/5', status: 'Evaluated' }));
  row.url = 'https://jobs.example.com/x';
  const livenessMap = new Map([['https://jobs.example.com/x', { result: 'expired', reason: 'HTTP 404' }]]);
  const cls = buildClassification(row, { ...ctxBase, livenessMap });
  assert.equal(cls.bucket, 'purge');
  assert.equal(cls.action, 'purge');
});

test('uncertain liveness does NOT purge — falls through to score', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 7, date: old, company: 'Co', role: 'R', score: '3.0/5', status: 'Evaluated' }));
  row.url = 'https://jobs.example.com/y';
  const livenessMap = new Map([['https://jobs.example.com/y', { result: 'uncertain', reason: '' }]]);
  const cls = buildClassification(row, { ...ctxBase, livenessMap });
  assert.equal(cls.bucket, 'discard'); // not purge
});

test('override allowlist short-circuits all destructive actions', () => {
  const [row] = parseTrackerLines(trackerLine({ num: 8, date: old, company: 'Co', role: 'R', score: '1.0/5', status: 'Evaluated' }));
  row.url = 'https://x/dead';
  const overrideSet = new Set([8]);
  const livenessMap = new Map([['https://x/dead', { result: 'expired', reason: '404' }]]);
  const cls = buildClassification(row, { ...ctxBase, overrideSet, livenessMap });
  assert.equal(cls.bucket, 'override');
  assert.equal(cls.action, 'noop');
});

// ── subprocess: dry-run safety + apply kill-switch ────────────────────────────

function makeFixtureTracker(dir) {
  const tracker = join(dir, 'applications.md');
  const lines = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    trackerLine({ num: 200, date: oldLive, company: 'LowCo', role: 'Analyst', score: '3.2/5', status: 'Evaluated', notes: 'stale below floor' }),
    trackerLine({ num: 201, date: oldLive, company: 'HiCo', role: 'AI PgM', score: '4.6/5', status: 'Evaluated', notes: 'keeper' }),
    trackerLine({ num: 202, date: oldLive, company: 'AppliedCo', role: 'Eng', score: '1.0/5', status: 'Applied', notes: 'out of scope' }),
    trackerLine({ num: 203, date: freshLive, company: 'FreshCo', role: 'PM', score: '2.0/5', status: 'Evaluated', notes: 'fresh' }),
    '| 204 | langchain | — | SKIP | ❌ | Evaluated | — | corrupted | do not touch |',
  ].join('\n');
  writeFileSync(tracker, lines + '\n');
  return tracker;
}

test('DRY-RUN (default) mutates NOTHING + reports correct counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-dry-'));
  try {
    const tracker = makeFixtureTracker(dir);
    const before = readFileSync(tracker, 'utf-8');
    const res = spawnSync('node', [SCRIPT, '--tracker', tracker, '--skip-liveness', '--json', '--queue', join(dir, 'nope.json'), '--overrides', join(dir, 'nope.json')], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.mode, 'dry-run');
    assert.equal(out.would_discard, 1);       // #200
    assert.equal(out.refresh_unmapped, 1);     // #201 keeper, no queue map
    assert.equal(out.out_of_scope, 1);         // #202 Applied
    assert.equal(out.fresh, 1);                // #203
    assert.equal(out.skip_unparseable, 1);     // #204 corrupted
    assert.equal(out.would_purge, 0);          // --skip-liveness
    assert.equal(readFileSync(tracker, 'utf-8'), before, 'tracker must be byte-identical after dry-run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--apply REFUSES without STALE_STATUS_PASS_ENABLED=true (exit 3, no mutation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-gate-'));
  try {
    const tracker = makeFixtureTracker(dir);
    const before = readFileSync(tracker, 'utf-8');
    const env = { ...process.env }; delete env.STALE_STATUS_PASS_ENABLED;
    const res = spawnSync('node', [SCRIPT, '--tracker', tracker, '--skip-liveness', '--apply'], { cwd: ROOT, encoding: 'utf-8', env, timeout: 60_000 });
    assert.equal(res.status, 3, 'must exit 3 when env gate is off');
    assert.match(res.stderr, /REFUSING --apply/);
    assert.equal(readFileSync(tracker, 'utf-8'), before, 'tracker unchanged when --apply is refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--apply WITH env gate flips only in-scope stale rows + snapshots + audits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-apply-'));
  try {
    const tracker = makeFixtureTracker(dir);
    const archiveDir = join(dir, 'archive');
    const auditJsonl = join(dir, 'audit.jsonl');
    const env = { ...process.env, STALE_STATUS_PASS_ENABLED: 'true' };
    const res = spawnSync('node', [
      SCRIPT, '--tracker', tracker, '--skip-liveness', '--apply', '--json',
      '--archive-dir', archiveDir, '--audit-jsonl', auditJsonl,
      '--queue', join(dir, 'nope.json'), '--overrides', join(dir, 'nope.json'),
      '--report-dir', join(dir, 'report'),
    ], { cwd: ROOT, encoding: 'utf-8', env, timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.mode, 'apply');
    assert.equal(out.applied.mutated, 1, 'exactly one row (the below-floor #200) flipped');

    const after = readFileSync(tracker, 'utf-8');
    // #200 must now be Discarded with an audit note; others untouched.
    assert.match(after, /\| 200 \|[^\n]*\| Discarded \|[^\n]*stale-pass/);
    assert.match(after, /\| 201 \|[^\n]*\| Evaluated \|/, '#201 keeper stays Evaluated (refresh, not discard)');
    assert.match(after, /\| 202 \|[^\n]*\| Applied \|/, '#202 Applied untouched');
    assert.match(after, /\| 203 \|[^\n]*\| Evaluated \|/, '#203 fresh untouched');
    assert.match(after, /\| 204 \| langchain \|/, '#204 corrupted untouched');

    // snapshot + audit exist
    assert.ok(existsSync(out.applied.snapshot), 'snapshot file written');
    assert.ok(existsSync(auditJsonl), 'audit JSONL written');
    const audit = readFileSync(auditJsonl, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'discard');
    assert.equal(audit[0].num, 200);
    assert.equal(audit[0].prior_status, 'Evaluated');
    assert.equal(audit[0].new_status, 'Discarded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log('✓ stale-tracker-status-pass: all assertions passed');
