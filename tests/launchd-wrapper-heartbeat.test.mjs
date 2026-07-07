#!/usr/bin/env node
/**
 * tests/launchd-wrapper-heartbeat.test.mjs — Phase 0 dead-man heartbeat
 * pings in scripts/launchd-wrapper.mjs (+ the cron-run.sh hb_ping contract).
 *
 * $0 — no LLM, no external network. A local node:http listener stands in
 * for the self-hosted Healthchecks instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = join(ROOT, 'scripts', 'launchd-wrapper.mjs');
const CRON_RUN = join(ROOT, 'scripts', 'wrappers', 'cron-run.sh');

const { resolveHeartbeatBase, heartbeatSlug } = await import('../scripts/launchd-wrapper.mjs');

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('heartbeatSlug strips the label prefix and sanitizes', () => {
  assert.equal(heartbeatSlug('com.mitchell.career-ops.scan'), 'scan');
  assert.equal(heartbeatSlug('com.mitchell.career-ops.builder-log'), 'builder-log');
  assert.equal(heartbeatSlug('some.other.label'), 'some-other-label');
});

test('resolveHeartbeatBase: env wins, trailing slash stripped, unset → empty', () => {
  assert.equal(resolveHeartbeatBase({ HEARTBEAT_PING_BASE: 'http://127.0.0.1:8787/ping/key/' }, '/nonexistent'), 'http://127.0.0.1:8787/ping/key');
  assert.equal(resolveHeartbeatBase({}, '/nonexistent/.env'), '');
});

test('resolveHeartbeatBase: reads from .env file (plain, quoted, comment)', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '# comment\nOTHER=x\nHEARTBEAT_PING_BASE=http://127.0.0.1:9999/ping/abc # inline comment\n');
  assert.equal(resolveHeartbeatBase({}, envPath), 'http://127.0.0.1:9999/ping/abc');
  writeFileSync(envPath, 'HEARTBEAT_PING_BASE="http://127.0.0.1:9999/ping/quoted"\n');
  assert.equal(resolveHeartbeatBase({}, envPath), 'http://127.0.0.1:9999/ping/quoted');
});

// ── End-to-end: wrapper CLI → local heartbeat listener ───────────────────────

function startListener(hits) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200);
      res.end('OK');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('wrapper pings start + 0 on success, exit code passes through', async () => {
  const hits = [];
  const srv = await startListener(hits);
  const base = `http://127.0.0.1:${srv.address().port}/ping/testkey`;
  try {
    const { stdout } = await execFileP(process.execPath, [
      WRAPPER, '--label=com.mitchell.career-ops.hb-smoke', '--max-retries=0', '--',
      process.execPath, '-e', 'console.log("job-ran")',
    ], { env: { ...process.env, HEARTBEAT_PING_BASE: base }, timeout: 30_000 });
    assert.match(stdout, /job-ran/);
    assert.deepEqual(hits, [
      '/ping/testkey/hb-smoke/start?create=1',
      '/ping/testkey/hb-smoke/0?create=1',
    ]);
  } finally {
    srv.close();
  }
});

test('wrapper pings failure code on non-zero exit AND still exits with that code', async () => {
  const hits = [];
  const srv = await startListener(hits);
  const base = `http://127.0.0.1:${srv.address().port}/ping/testkey`;
  try {
    let code = null;
    try {
      await execFileP(process.execPath, [
        WRAPPER, '--label=com.mitchell.career-ops.hb-smoke', '--max-retries=0', '--',
        process.execPath, '-e', 'process.exit(7)',
      ], { env: { ...process.env, HEARTBEAT_PING_BASE: base }, timeout: 30_000 });
    } catch (err) {
      code = err.code;
    }
    assert.equal(code, 7, 'wrapper must exit with the wrapped command exit code');
    assert.deepEqual(hits, [
      '/ping/testkey/hb-smoke/start?create=1',
      '/ping/testkey/hb-smoke/7?create=1',
    ]);
  } finally {
    srv.close();
  }
});

test('FAIL-OPEN: unreachable heartbeat server does not affect the job or exit code', async () => {
  // Port 9 (discard) refused locally — ping fails, job must still succeed.
  const { stdout } = await execFileP(process.execPath, [
    WRAPPER, '--label=com.mitchell.career-ops.hb-smoke', '--max-retries=0', '--',
    process.execPath, '-e', 'console.log("survived")',
  ], { env: { ...process.env, HEARTBEAT_PING_BASE: 'http://127.0.0.1:9/ping/deadkey' }, timeout: 40_000 });
  assert.match(stdout, /survived/);
});

test('WAIT BUDGET: a black-holed heartbeat server delays the job by bounded time only', async () => {
  // Server accepts connections but never responds — worst case for an
  // awaited ping. Budgets: start 2.5s + exit 3s → total added wait must be
  // well under the old 2x10s ceiling. Generous margin for CI jitter.
  const srv = await new Promise((resolve) => {
    const s = createServer(() => { /* never respond */ });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}/ping/blackhole`;
  try {
    const t0 = Date.now();
    const { stdout } = await execFileP(process.execPath, [
      WRAPPER, '--label=com.mitchell.career-ops.hb-smoke', '--max-retries=0', '--',
      process.execPath, '-e', 'console.log("job-done")',
    ], { env: { ...process.env, HEARTBEAT_PING_BASE: base }, timeout: 30_000 });
    const elapsed = Date.now() - t0;
    assert.match(stdout, /job-done/);
    assert.ok(elapsed < 9_000, `wrapper took ${elapsed}ms with a black-holed server — wait budgets not enforced`);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('cron-run.sh hb_ping: pings label + exit code, fail-open when unset', async () => {
  const hits = [];
  const srv = await startListener(hits);
  const base = `http://127.0.0.1:${srv.address().port}/ping/cronkey`;
  try {
    // cadence-guard 'always' + trivial command
    await execFileP('bash', [CRON_RUN, 'hb-cron-smoke', 'always', 'true'], {
      env: { ...process.env, HEARTBEAT_PING_BASE: base }, timeout: 30_000,
    });
    assert.deepEqual(hits, ['/ping/cronkey/hb-cron-smoke/0?create=1']);
    // Unset base → no ping, still exit 0
    hits.length = 0;
    const env2 = { ...process.env, HEARTBEAT_PING_BASE: '' };
    await execFileP('bash', [CRON_RUN, 'hb-cron-smoke', 'always', 'true'], { env: env2, timeout: 30_000 });
    assert.equal(hits.length, 0);
  } finally {
    srv.close();
  }
});
