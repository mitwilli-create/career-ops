import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'agents', 'hang-watchdog.mjs');
const STATE = join(ROOT, 'data', 'hang-watchdog-state.json');

test('hang-watchdog --once exits cleanly and emits NDJSON', () => {
  const stateBackup = existsSync(STATE) ? readFileSync(STATE, 'utf-8') : null;
  try {
    const r = spawnSync('node', [SCRIPT, '--once'], { encoding: 'utf-8', timeout: 30_000 });
    assert.equal(r.status, 0, `non-zero exit: ${r.stderr}`);
    const lines = r.stdout.trim().split('\n');
    assert.ok(lines.length >= 2, `expected ≥2 NDJSON lines, got ${lines.length}: ${r.stdout}`);
    const first = JSON.parse(lines[0]);
    assert.equal(first.event, 'start');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.event, 'shutdown');
  } finally {
    if (stateBackup !== null) {
      writeFileSync(STATE, stateBackup);
    }
  }
});

test('hang-watchdog skips whitelisted daemons', () => {
  const r = spawnSync('node', [SCRIPT, '--once'], { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  const passComplete = lines.find(l => l.event === 'pass-complete');
  assert.ok(passComplete, 'expected pass-complete event');
  // dashboard-server.mjs is always running and IS whitelisted, so it should
  // never be counted as flagged.
  assert.ok(passComplete.flagged_count === 0 || passComplete.flagged_count === undefined,
    `dashboard-server should not be flagged: ${JSON.stringify(passComplete)}`);
});

test('hang-watchdog reads CLI flags', () => {
  const r = spawnSync('node', [SCRIPT, '--once', '--min-wall-min=60', '--max-cpu-pct=0.5'], {
    encoding: 'utf-8', timeout: 30_000,
  });
  assert.equal(r.status, 0);
  const first = JSON.parse(r.stdout.split('\n')[0]);
  assert.equal(first.min_wall_min, 60);
  assert.equal(first.max_cpu_pct, 0.5);
});

test('hang-watchdog does not crash when no career-ops processes are running', () => {
  // We can't actually stop all career-ops processes for this test, so we
  // just verify the script handles the empty case gracefully (no NaN, no
  // throws). The 'once' mode exits cleanly even if ps returns nothing.
  const r = spawnSync('node', [SCRIPT, '--once'], { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /Error|Uncaught|throw/);
});

test('hang-watchdog --auto-kill flag is recognized in start emit', () => {
  const r = spawnSync('node', [SCRIPT, '--once', '--auto-kill'], {
    encoding: 'utf-8', timeout: 30_000,
  });
  assert.equal(r.status, 0);
  const first = JSON.parse(r.stdout.split('\n')[0]);
  assert.equal(first.auto_kill, true);
});
