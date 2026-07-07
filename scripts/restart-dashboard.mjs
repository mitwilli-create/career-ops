#!/usr/bin/env node
/**
 * scripts/restart-dashboard.mjs
 *
 * Hard-restart the career-ops dashboard server.
 *
 * The dashboard runs as a nohup-detached process managed by:
 *   scripts/launchd/dashboard-server-nohup.sh  (nohup wrapper script)
 *   com.mitchell.career-ops.dashboard-server-nohup-wrapper.plist
 *                                               (RunAtLoad=true, StartInterval=300)
 *
 * This is Pattern F (launchd-keepalive-tahoe): kickstarting the plist alone
 * is NOT enough — the nohup child process lives outside launchd's job tree, so
 * launchd cannot kill it. Correct sequence:
 *   1. pkill the nohup'd node process (SIGTERM → SIGKILL)
 *   2. Wait for :3097 to go silent
 *   3. launchctl kickstart -k to re-fire the nohup-wrapper plist
 *      (which runs dashboard-server-nohup.sh → spawns a fresh nohup node)
 *   4. Poll :3097 until HTTP 200 or timeout
 *
 * Usage:
 *   node scripts/restart-dashboard.mjs
 *   node scripts/restart-dashboard.mjs --no-verify   (skip HTTP 200 check)
 *   node scripts/restart-dashboard.mjs --host http://localhost:3097
 *
 * Exit 0 = success (server responding), 1 = failure.
 */

import { execSync, spawnSync } from 'child_process';

const NO_VERIFY = process.argv.includes('--no-verify');
const hostFlag  = process.argv.indexOf('--host');
const HOST      = hostFlag !== -1 ? process.argv[hostFlag + 1] : (process.env.DASHBOARD_URL || 'http://localhost:3097');
const PORT      = 3097;

const PLIST_LABEL = 'com.mitchell.career-ops.dashboard-server-nohup-wrapper';
const UID         = execSync('id -u', { encoding: 'utf-8', timeout: 10_000 }).trim();
const PLIST_DOMAIN = `gui/${UID}/${PLIST_LABEL}`;

function log(msg)  { console.log(`[restart-dashboard] ${msg}`); }
function warn(msg) { console.warn(`[restart-dashboard] WARN ${msg}`); }
function fail(msg) { console.error(`[restart-dashboard] ✗ ${msg}`); process.exit(1); }

// ─── Step 1: pkill the running dashboard-server.mjs ──────────────────────────
log('Step 1 — killing dashboard-server.mjs (SIGTERM)…');
const pkillTerm = spawnSync('pkill', ['-f', 'dashboard-server.mjs'], { encoding: 'utf-8', timeout: 10_000 });
if (pkillTerm.status === 0) {
  log('  SIGTERM sent; waiting 2s for graceful shutdown…');
  await sleep(2000);
} else if (pkillTerm.status === 1) {
  log('  no matching process — nothing to kill (already stopped)');
} else {
  warn(`pkill SIGTERM returned ${pkillTerm.status}: ${pkillTerm.stderr.trim()}`);
}

// Belt + suspenders: SIGKILL if still up
const stillUp = spawnSync('pgrep', ['-f', 'dashboard-server.mjs'], { encoding: 'utf-8', timeout: 10_000 });
if (stillUp.status === 0) {
  log('  still alive after SIGTERM — sending SIGKILL…');
  spawnSync('pkill', ['-9', '-f', 'dashboard-server.mjs'], { encoding: 'utf-8', timeout: 10_000 });
  await sleep(1000);
}

// ─── Step 2: Wait for :PORT to go silent ─────────────────────────────────────
log(`Step 2 — waiting for :${PORT} to stop listening…`);
const DEAD_TIMEOUT = 8000;
const DEAD_POLL    = 300;
const deadDeadline = Date.now() + DEAD_TIMEOUT;
while (Date.now() < deadDeadline) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 10_000 });
  if (lsof.status !== 0) { log(`  :${PORT} gone silent — OK`); break; }
  await sleep(DEAD_POLL);
}
// If still up, warn but continue (kickstart may overwrite it anyway)
{
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 10_000 });
  if (lsof.status === 0) warn(`  :${PORT} still shows a listener — kickstart may overwrite`);
}

// ─── Step 3: launchctl kickstart -k ──────────────────────────────────────────
log(`Step 3 — kickstarting ${PLIST_DOMAIN}…`);
const kick = spawnSync('launchctl', ['kickstart', '-k', PLIST_DOMAIN], { encoding: 'utf-8', timeout: 10_000 });
if (kick.status === 0) {
  log(`  kickstart OK → ${kick.stdout.trim() || '(no output)'}`);
} else {
  // Domain not loaded is recoverable — try load first, then kickstart
  warn(`  kickstart returned ${kick.status}: ${kick.stderr.trim()}`);
  log('  attempting launchctl load first (plist may not be bootstrapped)…');
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist`;
  const load = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf-8', timeout: 10_000 });
  if (load.status !== 0) fail(`launchctl load failed: ${load.stderr.trim()}`);
  const kick2 = spawnSync('launchctl', ['kickstart', PLIST_DOMAIN], { encoding: 'utf-8', timeout: 10_000 });
  if (kick2.status !== 0) fail(`kickstart after load failed: ${kick2.stderr.trim()}`);
  log(`  kickstart OK (after load) → ${kick2.stdout.trim() || '(no output)'}`);
}

// ─── Step 4: Poll until HTTP 200 (or --no-verify) ────────────────────────────
if (NO_VERIFY) {
  log('Step 4 — --no-verify; skipping HTTP check');
  log('✅ restart-dashboard: server kicked; verify manually at ' + HOST);
  process.exit(0);
}

log(`Step 4 — polling ${HOST} for HTTP 200…`);
const UP_TIMEOUT = 30_000;
const UP_POLL    = 800;
const upDeadline = Date.now() + UP_TIMEOUT;
let lastStatus   = null;

while (Date.now() < upDeadline) {
  try {
    const r = await fetch(HOST, { signal: AbortSignal.timeout(3000) });
    lastStatus = r.status;
    if (r.status === 200) {
      log(`  HTTP 200 received — server is up`);
      break;
    }
    // 503 / 502 = came up but upstream Cloudflare isn't connected yet (OK)
    if (r.status === 503 || r.status === 502) {
      log(`  HTTP ${r.status} — server up but CF tunnel not yet live; retrying…`);
    }
  } catch (e) {
    // ECONNREFUSED = not up yet, keep polling
    lastStatus = null;
  }
  await sleep(UP_POLL);
}

if (lastStatus === 200) {
  console.log(`\n✅ restart-dashboard: ${HOST} responded HTTP 200 — server is live`);
  process.exit(0);
} else {
  console.error(`\n✗ restart-dashboard: timed out after ${UP_TIMEOUT / 1000}s — last status: ${lastStatus ?? 'ECONNREFUSED'}`);
  console.error(`  Check logs: ~/Library/Logs/career-ops/dashboard-server-nohup.err`);
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
