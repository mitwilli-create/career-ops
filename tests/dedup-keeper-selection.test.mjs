#!/usr/bin/env node
/**
 * dedup-keeper-selection.test.mjs — regression tests for the 2026-07-06
 * dedup-tracker incident (15 live rows deleted at 23:59 by the no-flag
 * legacy --delete default; Discarded #2535 won keepership over Evaluated
 * #2582/#2547 on a score tie via earliest-num, orphaning #2582's
 * hardened-pipeline apply-pack dir).
 *
 * Locks in two fixes (2026-07-07):
 *   1. The no-flag default mode is --mark (non-destructive: rows preserved,
 *      dupes get a DUPE-of-#N audit note). --delete is explicit-only.
 *   2. Keeper preference is live status > has apply-pack dir
 *      (apply-pack/<num>-*) > score > earliest num.
 *
 * Black-box: the script hard-codes its data paths relative to its own
 * location, so each test copies dedup-tracker.mjs into a fresh temp tree
 * with a fixture data/applications.md (+ apply-pack dirs) and runs it as a
 * subprocess. No live personal data is ever touched.
 *
 * Run: node --test tests/dedup-keeper-selection.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { validateTrackerRow } from '../lib/tracker-row.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_SRC = join(REPO_ROOT, 'dedup-tracker.mjs');

// Hang-watchdog ceiling for the subprocess runs. Env-tiered (shares
// TEST_CHILD_TIMEOUT_MS with test-all.mjs); clamp [5s, 10min].
const CHILD_TIMEOUT_MS = Math.min(600_000, Math.max(5_000, Number(process.env.TEST_CHILD_TIMEOUT_MS) || 60_000));

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
].join('\n');

function row(num, company, role, score, status, note = 'fixture') {
  return `| ${num} | 2026-07-01 | ${company} | ${role} | ${score} | ${status} | ❌ | [${num}](reports/${num}-x.md) | ${note} |`;
}

// Fixture clusters (roles within a cluster are string-identical so the
// roleMatch fast-path fires; clusters use distinct companies so grouping
// keeps them apart):
//   A — Ramp regression: score tie 4.5, Discarded row has the earliest num.
//       Pre-fix keeper = #10 (Discarded). Post-fix keeper = #20 (live).
//   B — apply-pack tiebreak among equal-score live rows: pack row #50 must
//       beat earlier-num packless #40.
//   C — pack beats score among live rows: #70 (4.2 + pack) must beat #60
//       (4.6, no pack) so dedupe never orphans a pack dir.
//   D — earliest num as last-resort tiebreak: #80 beats #90.
//   E — pipe-safety (Qodo finding, PR #393): role carries an escaped `\|`
//       (canonical: row #2535) and the rows carry an extra pipe-separated
//       `triage X.X/5` note cell. A naive split('|') + fixed slice rebuild
//       shifts columns / drops the suffix; the marked row must stay
//       structurally valid with the suffix intact.
const PIPED_ROLE = 'AI Operations Specialist \\| Agentic Workflows';
const FIXTURE_ROWS = [
  row(10, 'Ramp', 'AI Operations Specialist, Agentic Workflows', '4.5/5', 'Discarded', 'terminal — own audit trail'),
  row(20, 'Ramp', 'AI Operations Specialist, Agentic Workflows', '4.5/5', 'Evaluated'),
  row(30, 'Ramp', 'AI Operations Specialist, Agentic Workflows', '4.3/5', 'Evaluated'),
  row(40, 'Acme', 'Solutions Architect', '4.2/5', 'Evaluated'),
  row(50, 'Acme', 'Solutions Architect', '4.2/5', 'Evaluated'),
  row(60, 'Globex', 'Platform Deployment Strategist', '4.6/5', 'Evaluated'),
  row(70, 'Globex', 'Platform Deployment Strategist', '4.2/5', 'Evaluated'),
  row(80, 'Initech', 'Applied AI Lead', '4.0/5', 'Evaluated'),
  row(90, 'Initech', 'Applied AI Lead', '4.0/5', 'Evaluated'),
  row(100, 'Umbrella', PIPED_ROLE, '4.4/5', 'Evaluated') + ' triage 4.3/5 |',
  row(110, 'Umbrella', PIPED_ROLE, '4.2/5', 'Evaluated') + ' triage 4.1/5 |',
];

const PACK_DIRS = ['50-acme-solutions-architect', '70-globex-platform-deployment-strategist'];

function makeFixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-keeper-test-'));
  copyFileSync(SCRIPT_SRC, join(dir, 'dedup-tracker.mjs'));
  // The script imports ./lib/tracker-row.mjs relative to its own location —
  // mirror it into the temp tree so the copy resolves.
  mkdirSync(join(dir, 'lib'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'lib/tracker-row.mjs'), join(dir, 'lib/tracker-row.mjs'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/applications.md'), HEADER + '\n' + FIXTURE_ROWS.join('\n') + '\n');
  for (const p of PACK_DIRS) mkdirSync(join(dir, 'apply-pack', p), { recursive: true });
  return dir;
}

function runDedup(dir, args = []) {
  const res = spawnSync('node', ['dedup-tracker.mjs', ...args], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
  });
  return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

function readApps(dir) {
  return readFileSync(join(dir, 'data/applications.md'), 'utf-8');
}

test('keeper selection: live status > apply-pack > score > earliest num (--check)', () => {
  const dir = makeFixtureTree();
  try {
    const { status, out } = runDedup(dir, ['--check']);
    assert.strictEqual(status, 2, `--check must exit 2 when collisions exist\n${out}`);

    const keepers = [...out.matchAll(/keeper #(\d+)/g)].map(m => parseInt(m[1], 10)).sort((a, b) => a - b);
    // A: live #20 beats Discarded #10 despite the 4.5 score tie + #10's earlier num
    assert.ok(keepers.includes(20), `Ramp-regression: keeper must be live #20, got keepers [${keepers}]\n${out}`);
    assert.ok(!keepers.includes(10), `Discarded #10 must never win keepership over live rows\n${out}`);
    // B: apply-pack row #50 beats earlier-num packless #40 at equal score
    assert.ok(keepers.includes(50), `apply-pack tiebreak: keeper must be #50 (has pack dir), got [${keepers}]\n${out}`);
    // C: pack presence outranks score among live rows (never orphan a pack)
    assert.ok(keepers.includes(70), `pack-beats-score: keeper must be #70 (4.2 + pack) over #60 (4.6, no pack), got [${keepers}]\n${out}`);
    // D: earliest num remains the last-resort tiebreak
    assert.ok(keepers.includes(80), `earliest-num tiebreak: keeper must be #80, got [${keepers}]\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no-flag default is --mark: rows preserved with DUPE audit note, nothing deleted', () => {
  const dir = makeFixtureTree();
  try {
    const before = [...readApps(dir).matchAll(/^\| (\d+) \|/gm)].length;
    const { status, out } = runDedup(dir, []); // NO flags — the incident invocation shape
    assert.strictEqual(status, 0, `default mode must exit 0\n${out}`);
    assert.match(out, /duplicates marked Discarded/, `default mode must be --mark\n${out}`);
    assert.doesNotMatch(out, /duplicates removed/, `default mode must NEVER delete rows (2026-07-06 incident)\n${out}`);

    const after = readApps(dir);
    const afterCount = [...after.matchAll(/^\| (\d+) \|/gm)].length;
    assert.strictEqual(afterCount, before, 'default run must not remove any rows');
    for (const num of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      assert.ok(new RegExp(`^\\| ${num} \\|`, 'm').test(after), `row #${num} must survive the default run`);
    }
    // Marked dupes carry the audit note pointing at the correct keeper
    assert.match(after, /\| 30 \|.*DUPE of #20/, 'dupe #30 must be marked DUPE of keeper #20');
    assert.match(after, /\| 40 \|.*DUPE of #50/, 'dupe #40 must be marked DUPE of keeper #50');
    // Already-terminal #10 keeps its own audit trail — not re-marked
    assert.match(after, /\| 10 \|.*terminal — own audit trail/, 'terminal dupe #10 note must be preserved verbatim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--delete remains available but only when passed explicitly', () => {
  const dir = makeFixtureTree();
  try {
    const { status, out } = runDedup(dir, ['--delete']);
    assert.strictEqual(status, 0, `--delete must exit 0\n${out}`);
    assert.match(out, /duplicates removed/, `explicit --delete must still delete (legacy path preserved)\n${out}`);
    const after = readApps(dir);
    assert.ok(!/^\| 30 \|/m.test(after), 'explicit --delete removes dupe #30');
    assert.ok(/^\| 20 \|/m.test(after), 'keeper #20 survives --delete');
    assert.ok(/^\| 10 \|/m.test(after), 'terminal #10 is skipped by --delete (audit trail preserved)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipe-safety: escaped \\| in role + triage note suffix survive a default mark run', () => {
  const dir = makeFixtureTree();
  try {
    const { status, out } = runDedup(dir, []);
    assert.strictEqual(status, 0, `default run must exit 0\n${out}`);
    const after = readApps(dir);

    const line110 = after.split('\n').find(l => /^\| 110 \|/.test(l));
    assert.ok(line110, 'dupe row #110 must survive the mark run');
    const v = validateTrackerRow(line110);
    assert.ok(v.ok, `marked row must stay structurally valid: ${v.ok ? '' : v.reason}\n${line110}`);
    assert.ok(line110.includes('Specialist \\| Agentic'), `escaped pipe must remain escaped in the role cell\n${line110}`);
    assert.match(line110, /DUPE of #100/, 'dupe must point at keeper #100');
    assert.match(line110, /triage 4\.1\/5/, 'extra pipe-separated note cell (triage suffix) must be preserved');
    const cells = line110.split(/(?<!\\)\|/).map(s => s.trim());
    assert.strictEqual(cells[6], 'Discarded', 'status must land in the status column, not shift into a neighbor');

    const line100 = after.split('\n').find(l => /^\| 100 \|/.test(l));
    assert.ok(line100, 'keeper row #100 must survive untouched');
    assert.match(line100, /triage 4\.3\/5/, 'keeper triage suffix must be preserved');
    assert.ok(validateTrackerRow(line100).ok, 'keeper row must stay structurally valid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--mark --dry-run writes nothing (test-all.mjs §2 invocation shape)', () => {
  const dir = makeFixtureTree();
  try {
    const before = readApps(dir);
    const { status, out } = runDedup(dir, ['--mark', '--dry-run']);
    assert.strictEqual(status, 0, `--mark --dry-run must exit 0\n${out}`);
    assert.match(out, /dry-run — no changes written/, `dry-run must announce no writes\n${out}`);
    assert.strictEqual(readApps(dir), before, 'dry-run must leave applications.md byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
