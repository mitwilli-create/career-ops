#!/usr/bin/env node
/**
 * scripts/fleet-watchdog.mjs — Daily deterministic health check for the
 * career-ops automation fleet. No LLM calls, no network beyond one optional
 * alert email. Built 2026-07-06.
 *
 * Checks, in order:
 *   1. launchd exit statuses for every loaded com.mitchell.* job
 *      (launchctl list). Nonzero last-exit status = FAILING.
 *   2. Heartbeat liveness: data/heartbeat-YYYY-MM-DD.md must exist for today
 *      once the local clock passes 09:30 (heartbeat fires 09:00, archives land
 *      by ~09:15). Before 09:30, yesterday's archive is checked instead.
 *      Absence = the digest channel itself is down, which is the
 *      highest-severity finding.
 *   3. Scanner cron health via the existing lib/cron-health.mjs parser
 *      (FAILING / STALE jobs bubble up as issues).
 *
 * Output:
 *   - data/fleet-health.json (always) — machine-readable snapshot
 *   - stdout summary (always)
 *   - Alert email via nodemailer + ~/.career-ops-secrets (only when issues
 *     were found, or --force-email). Silence-when-healthy is intentional:
 *      the daily heartbeat email is the positive liveness signal; this
 *      watchdog is the alarm path, and check #2 makes the two watch each
 *      other.
 *
 * Flags:
 *   --dry-run      run all checks, write JSON, print, but never email
 *   --force-email  send the email even when healthy (end-to-end test)
 *
 * Suppressions: add label strings to data/fleet-watchdog-ignore.json
 * (a JSON array) to mute known-bad or intentionally-disabled jobs.
 *
 * launchd schedule: scripts/launchd/com.mitchell.career-ops.fleet-watchdog.plist
 * (daily 09:45, after the 09:00 heartbeat).
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE_EMAIL = args.includes('--force-email');

function loadSecrets() {
  const p = join(os.homedir(), '.career-ops-secrets');
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // Quoted values are taken verbatim inside the quotes (a password may
    // legitimately contain "#"); unquoted values strip trailing inline
    // comments (2026-07-07 review finding #9: `PASS=abc # note` previously
    // captured "abc # note" as the value).
    const quoted = v.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quoted) v = quoted[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

function loadIgnoreList() {
  const p = join(DATA, 'fleet-watchdog-ignore.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- Check 1: launchd job statuses -----------------------------------------

function checkLaunchd(ignore) {
  // 30s timeout: a stalled launchctl must not hang the watchdog (Qodo PR #407
  // finding 1 — every child-process invocation carries a timeout). The call is
  // wrapped because execFileSync THROWS on timeout/non-zero exit (Qodo round-2
  // finding): an unhandled throw here would kill the watchdog before it writes
  // fleet-health.json or sends the alert email — the remaining checks must
  // still run and the failure must surface as an issue, not a crash.
  let raw;
  try {
    raw = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 30_000 });
  } catch (err) {
    return { jobs: [], failing: [], error: String(err?.message || err) };
  }
  const jobs = [];
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, status, label] = parts;
    if (!label.startsWith('com.mitchell.')) continue;
    // launchctl emits '-' as a no-exit-status sentinel; Number('-') is NaN and
    // NaN !== 0 read as "failing" (Qodo PR #407 finding 3 — false alarms).
    // Store null for the sentinel and only treat finite nonzero codes as
    // failures, matching the repo's other health tooling.
    const parsedStatus = Number(status);
    jobs.push({
      label,
      pid: pid === '-' ? null : Number(pid),
      lastExitStatus: Number.isFinite(parsedStatus) ? parsedStatus : null,
      rawStatus: status,
      ignored: ignore.includes(label),
    });
  }
  const failing = jobs.filter(j => !j.ignored && Number.isFinite(j.lastExitStatus) && j.lastExitStatus !== 0);
  return { jobs, failing, error: null };
}

// --- Check 2: heartbeat archive liveness ------------------------------------

function checkHeartbeat() {
  const now = new Date();
  // Heartbeat fires 09:00 and archives land 09:00–09:15; demand today's file
  // once the local clock passes 09:30. The cutoff is minutes-aware (2026-07-07
  // review finding #2: an hours-only `< 10` cutoff meant the scheduled 09:45
  // run always graded YESTERDAY's heartbeat, so a morning failure was detected
  // a full day late — the today-branch only ever ran on manual invocations).
  const target = new Date(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  if (minutesNow < 9 * 60 + 30) target.setDate(target.getDate() - 1);
  const expected = `heartbeat-${localDateString(target)}.md`;
  const ok = existsSync(join(DATA, expected));
  return { expectedFile: expected, ok };
}

// --- Check 3: scanner cron health via existing parser ------------------------

async function checkCron() {
  try {
    const { getCronHealth } = await import('../lib/cron-health.mjs');
    const health = getCronHealth();
    // getCronHealth shape is owned by lib/cron-health.mjs; treat defensively.
    const entries = Array.isArray(health) ? health : (health?.jobs || []);
    const bad = entries.filter(e => {
      const s = String(e.status || e.state || '').toUpperCase();
      return s === 'FAILING' || s === 'STALE';
    });
    return { entries, bad, error: null };
  } catch (err) {
    return { entries: [], bad: [], error: String(err?.message || err) };
  }
}

// --- Alert email --------------------------------------------------------------

async function sendAlert(secrets, subject, body) {
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
  });
  const to = secrets.HEARTBEAT_TO || secrets.GMAIL_USER;
  const info = await transporter.sendMail({ from: secrets.GMAIL_USER, to, subject, text: body });
  return info.messageId;
}

// --- Main ----------------------------------------------------------------------

const ignore = loadIgnoreList();
const launchd = checkLaunchd(ignore);
const heartbeat = checkHeartbeat();
const cron = await checkCron();

const issues = [];
if (!heartbeat.ok) {
  issues.push({
    severity: 'critical',
    what: `Heartbeat email archive missing: data/${heartbeat.expectedFile}`,
    recover: 'Run: cd ~/Documents/career-ops && node scripts/heartbeat.mjs --send, then check ~/Library/Logs/career-ops/heartbeat-launchd.err',
  });
}
if (launchd.error) {
  issues.push({
    severity: 'warning',
    what: `launchctl list failed (${launchd.error}) — launchd job statuses unchecked this run`,
    recover: 'Run `launchctl list` manually; if it hangs or errors, check system load / launchd health, then rerun the watchdog',
  });
}
for (const j of launchd.failing) {
  issues.push({
    severity: 'warning',
    what: `launchd job ${j.label} last exited with status ${j.lastExitStatus}`,
    recover: `Check its plist log paths under ~/Library/Logs/career-ops/, then: launchctl kickstart -k gui/$(id -u)/${j.label}`,
  });
}
for (const e of cron.bad) {
  issues.push({
    severity: 'warning',
    what: `Scanner job ${e.name || e.label || 'unknown'} is ${e.status || e.state}`,
    recover: 'Inspect data/logs/scan-YYYY-MM-DD.log for the failing section',
  });
}
if (cron.error) {
  issues.push({
    severity: 'info',
    what: `cron-health parser unavailable: ${cron.error}`,
    recover: 'Non-blocking; launchd + heartbeat checks still ran',
  });
}

const snapshot = {
  checkedAt: new Date().toISOString(),
  healthy: issues.filter(i => i.severity !== 'info').length === 0,
  issueCount: issues.length,
  issues,
  launchdJobs: launchd.jobs,
  heartbeat,
  ignoredLabels: ignore,
};
writeFileSync(join(DATA, 'fleet-health.json'), JSON.stringify(snapshot, null, 2) + '\n');

const lines = [];
lines.push(`Fleet watchdog ${localDateString()} : ${snapshot.healthy ? 'HEALTHY' : `${issues.length} issue(s)`}`);
for (const i of issues) {
  lines.push(`  [${i.severity}] ${i.what}`);
  lines.push(`      recover: ${i.recover}`);
}
lines.push(`  launchd jobs seen: ${launchd.jobs.length} (${launchd.failing.length} failing, ${ignore.length} ignored)`);
lines.push(`  heartbeat archive: ${heartbeat.expectedFile} ${heartbeat.ok ? 'present' : 'MISSING'}`);
const summary = lines.join('\n');
console.log(summary);

const shouldEmail = (!snapshot.healthy || FORCE_EMAIL) && !DRY_RUN;
if (shouldEmail) {
  const secrets = loadSecrets();
  if (!secrets.GMAIL_USER || !secrets.GMAIL_APP_PASSWORD) {
    console.error('fleet-watchdog: cannot email, GMAIL_USER/GMAIL_APP_PASSWORD missing from ~/.career-ops-secrets');
    process.exitCode = 1;
  } else {
    const subject = snapshot.healthy
      ? `Fleet watchdog test: all healthy (${localDateString()})`
      : `Fleet watchdog: ${issues.filter(i => i.severity !== 'info').length} issue(s) need a look (${localDateString()})`;
    try {
      const id = await sendAlert(secrets, subject, summary + '\n\nFull snapshot: ~/Documents/career-ops/data/fleet-health.json\n');
      console.log(`fleet-watchdog: alert sent (${id})`);
    } catch (err) {
      console.error(`fleet-watchdog: email send failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  }
}
