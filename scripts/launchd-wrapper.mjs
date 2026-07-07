#!/usr/bin/env node
/**
 * scripts/launchd-wrapper.mjs — Retry wrapper for launchd-scheduled jobs.
 *
 * Insulates every launchd job from transient failures (network blips, ATS
 * rate-limit spikes, macOS Tahoe KeepAlive miss) by recording each run to a
 * rolling state file and retrying on non-zero exit.
 *
 * Usage:
 *   node scripts/launchd-wrapper.mjs \
 *     --label=<job-label> \
 *     [--max-retries=2] \
 *     [--retry-backoff-sec=60] \
 *     -- <command> [args...]
 *
 * Examples:
 *   node scripts/launchd-wrapper.mjs \
 *     --label=com.mitchell.career-ops.scan \
 *     --max-retries=2 --retry-backoff-sec=60 \
 *     -- node /path/to/scan-unattended.mjs
 *
 *   node scripts/launchd-wrapper.mjs \
 *     --label=com.mitchell.career-ops.liveness-sweep \
 *     -- node scripts/liveness-sweep.mjs
 *
 * State file: data/launchd-wrapper-state.json
 * Schema:
 *   {
 *     "labels": {
 *       "<label>": [
 *         { "started_at": "ISO", "finished_at": "ISO",
 *           "exit_code": 0, "attempts_used": 1, "duration_sec": 12.4 },
 *         ...  (last 20 entries per label)
 *       ]
 *     }
 *   }
 *
 * Design invariants:
 * - NEVER throws. Even disk-full / JSON-parse errors are swallowed with a
 *   stderr warning so the wrapped command still runs.
 * - stdio is inherited — wrapped job's logs still flow to launchd's
 *   StdoutPath / StderrPath.
 * - Atomic state writes (write to .tmp then rename) prevent state corruption
 *   on interrupt.
 * - Backoff sleep is non-blocking (setTimeout/Promise).
 * - Wrapper exits with the actual command's final exit code.
 *
 * Part of P1-8 from the adjudicated council report (2026-05-19).
 * See: data/council-input-quality-audit-2026-05-19-adjudicated.md § P1-8
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root is one directory up from scripts/
const ROOT = join(__dirname, '..');
const STATE_PATH = join(ROOT, 'data', 'launchd-wrapper-state.json');
const STATE_TMP_PATH = STATE_PATH + '.tmp';
const MAX_HISTORY = 20;

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2); // drop 'node' and script path

  let label = null;
  let maxRetries = 2;
  let retryBackoffSec = 60;
  let dashDashIdx = -1;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      dashDashIdx = i;
      break;
    }
    const labelMatch = a.match(/^--label=(.+)$/);
    if (labelMatch) { label = labelMatch[1]; continue; }
    const retriesMatch = a.match(/^--max-retries=(\d+)$/);
    if (retriesMatch) { maxRetries = parseInt(retriesMatch[1], 10); continue; }
    const backoffMatch = a.match(/^--retry-backoff-sec=(\d+)$/);
    if (backoffMatch) { retryBackoffSec = parseInt(backoffMatch[1], 10); continue; }
  }

  const command = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : [];

  return { label, maxRetries, retryBackoffSec, command };
}

// ── State I/O — all errors swallowed ─────────────────────────────────────────

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { labels: {} };
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.labels) {
      warnState('state file has unexpected shape — resetting to empty');
      return { labels: {} };
    }
    return parsed;
  } catch (err) {
    warnState(`could not load state (${err.message}) — continuing with empty state`);
    return { labels: {} };
  }
}

function saveState(state) {
  try {
    const dataDir = join(ROOT, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    // Atomic write: write to .tmp then rename
    writeFileSync(STATE_TMP_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(STATE_TMP_PATH, STATE_PATH);
  } catch (err) {
    warnState(`could not save state (${err.message}) — continuing anyway`);
  }
}

function appendRun(label, entry) {
  const state = loadState();
  if (!state.labels[label]) state.labels[label] = [];
  state.labels[label].push(entry);
  // Trim to last MAX_HISTORY entries
  if (state.labels[label].length > MAX_HISTORY) {
    state.labels[label] = state.labels[label].slice(-MAX_HISTORY);
  }
  saveState(state);
}

function warnState(msg) {
  process.stderr.write(`[launchd-wrapper] WARN: ${msg}\n`);
}

function info(msg) {
  process.stderr.write(`[launchd-wrapper] ${msg}\n`);
}

// ── Dead-man heartbeat pings (convergence Phase 0, 2026-07-07) ───────────────
//
// Every scheduled launchd job pings a self-hosted Healthchecks instance on
// start and on completion, so a silently-dead job is detected by a MISSED
// ping instead of by a human noticing stale data ~24h later. Adjudicated
// decision (dealbreaker-final-20260706-111713.md Impasse B): keep launchd,
// add self-hosted Healthchecks/Uptime Kuma heartbeats, do NOT adopt PM2.
//
// Config: HEARTBEAT_PING_BASE in the repo .env (or process env), e.g.
//   HEARTBEAT_PING_BASE=http://127.0.0.1:8787/ping/<project-ping-key>
// Slug-based pings with ?create=1 auto-provision the check on first ping —
// zero per-job setup. See infra/healthchecks/README.md.
//
// FAIL-OPEN INVARIANT: unset config → no-op; server down / timeout / any
// error → swallowed with a stderr warn. A heartbeat problem must NEVER
// affect the wrapped job or the exit code launchd sees.

const HEARTBEAT_TIMEOUT_MS = 10_000;      // fetch abort ceiling (black-holed-server guard)
// Wait budgets (Qodo finding, PR #408): a down-but-hanging heartbeat server
// must not add ~10s per ping to every job. Each awaited ping is raced
// against a small budget — healthy localhost responds in ms; a black-holed
// server costs at most ~5.5s total per job instead of ~20s. The fetch keeps
// running to its own 10s abort in the background (start ping) or is dropped
// at process exit (completion ping) — acceptable, fail-open either way.
//
// Why the START ping is NOT pure fire-and-forget: the wrapped command runs
// via spawnSync, which BLOCKS the event loop — an unawaited fetch would not
// even be dispatched until the job finishes, arriving together with the
// completion ping and defeating the /start signal (runtime measurement,
// "never started" vs "hung" distinction). The small race budget keeps the
// start ping meaningful while bounding the delay it can add.
const HEARTBEAT_START_WAIT_BUDGET_MS = 2_500;
const HEARTBEAT_EXIT_WAIT_BUDGET_MS = 3_000;

export function resolveHeartbeatBase(env = process.env, envFilePath = join(ROOT, '.env')) {
  const fromEnv = (env.HEARTBEAT_PING_BASE || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  // Lightweight .env parse (no dotenv dep — wrapper must never throw)
  try {
    if (!existsSync(envFilePath)) return '';
    const raw = readFileSync(envFilePath, 'utf-8');
    const m = raw.match(/^\s*HEARTBEAT_PING_BASE\s*=\s*("?)([^"\n#]*)\1[^\n]*$/m);
    return m ? m[2].trim().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

export function heartbeatSlug(label) {
  // 'com.mitchell.career-ops.scan' → 'scan'. Healthchecks slugs accept
  // [a-zA-Z0-9_-]; launchd labels are dot-separated lowercase, so map any
  // residual disallowed chars to '-' defensively.
  return String(label).replace(/^com\.mitchell\.career-ops\./, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/**
 * Ping the heartbeat server. `signal` is 'start' | exit code (number).
 * Healthchecks semantics: /<slug>/start marks a run beginning (enables
 * runtime measurement); /<slug>/<exit-code> reports completion — 0 =
 * success, 1-255 = failure. ?create=1 auto-provisions unknown slugs.
 * Never throws; never rejects.
 */
async function pingHeartbeat(label, signal) {
  const base = resolveHeartbeatBase();
  if (!base) return; // heartbeats not configured — silent no-op
  const slug = heartbeatSlug(label);
  const suffix = signal === 'start' ? 'start' : String(Math.min(Math.max(Number(signal) || 0, 0), 255));
  const url = `${base}/${slug}/${suffix}?create=1`;
  try {
    await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      headers: { 'User-Agent': 'career-ops-launchd-wrapper' },
    });
  } catch (err) {
    warnState(`heartbeat ping failed for ${slug} (${err?.message || err}) — continuing (fail-open)`);
  }
}

// ── Backoff sleep ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function run() {
  const { label, maxRetries, retryBackoffSec, command } = parseArgs(process.argv);

  // Validate required args
  if (!label) {
    process.stderr.write(
      'launchd-wrapper: missing required argument --label\n' +
      'Usage: node scripts/launchd-wrapper.mjs --label=<job-label> [--max-retries=N] [--retry-backoff-sec=N] -- <command> [args...]\n'
    );
    process.exit(2);
  }

  if (command.length === 0) {
    process.stderr.write(
      `launchd-wrapper: missing command after --\n` +
      'Usage: node scripts/launchd-wrapper.mjs --label=<job-label> -- <command> [args...]\n'
    );
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const [cmd, ...cmdArgs] = command;

  info(`starting label=${label} cmd=${cmd} args=[${cmdArgs.join(', ')}] max-retries=${maxRetries} backoff=${retryBackoffSec}s`);

  // Dead-man heartbeat: mark run start (fail-open no-op when unconfigured).
  // Race-capped so a hanging heartbeat server can't delay the job by more
  // than HEARTBEAT_START_WAIT_BUDGET_MS — see the wait-budget block above.
  await Promise.race([pingHeartbeat(label, 'start'), sleep(HEARTBEAT_START_WAIT_BUDGET_MS)]);

  let lastExitCode = 1;
  let attemptsUsed = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attemptsUsed = attempt + 1;

    if (attempt > 0) {
      // Exponential backoff: backoff * 2^(attempt-1)
      const delayMs = retryBackoffSec * Math.pow(2, attempt - 1) * 1000;
      info(`retry ${attempt}/${maxRetries} for label=${label} — waiting ${delayMs / 1000}s`);
      await sleep(delayMs);
    }

    // spawnSync with stdio:inherit so the wrapped job's stdout/stderr flow
    // directly to launchd's configured StdoutPath / StderrPath.
    // timeout: 0 means no timeout — the wrapped script is responsible for its
    // own timeouts (hang-watchdog provides the backstop at the process level).
    let result;
    try {
      result = spawnSync(cmd, cmdArgs, {
        stdio: 'inherit',
        timeout: 0,
      });
    } catch (spawnErr) {
      // spawnSync itself threw (e.g., command not found as an ENOENT)
      lastExitCode = 127;
      info(`attempt ${attemptsUsed} failed to spawn (${spawnErr.message}) — exit code 127`);
      if (attempt < maxRetries) continue;
      break;
    }

    // spawnSync can return status=null on signal-kill or timeout
    if (result.status === null) {
      lastExitCode = 1;
      const reason = result.signal ? `killed by signal ${result.signal}` : 'unknown (status=null)';
      info(`attempt ${attemptsUsed} ${reason}`);
      if (result.error) {
        info(`spawn error: ${result.error.message}`);
      }
      if (attempt < maxRetries) continue;
      break;
    }

    lastExitCode = result.status;

    if (lastExitCode === 0) {
      info(`attempt ${attemptsUsed} succeeded (exit 0) for label=${label}`);
      break;
    }

    info(`attempt ${attemptsUsed} failed (exit ${lastExitCode}) for label=${label}`);
    // Loop continues if retries remain
  }

  const finishedAt = new Date().toISOString();
  const durationSec = Math.round((Date.now() - startMs) / 100) / 10; // 1 decimal

  // Record to state file — errors here must never affect exit code
  try {
    appendRun(label, {
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: lastExitCode,
      attempts_used: attemptsUsed,
      duration_sec: durationSec,
    });
  } catch (recordErr) {
    warnState(`appendRun threw unexpectedly (${recordErr.message}) — state may be incomplete`);
  }

  info(`done label=${label} exit=${lastExitCode} attempts=${attemptsUsed} duration=${durationSec}s`);

  // Dead-man heartbeat: report completion with the real exit code
  // (0 = success, non-zero = failure on the Healthchecks side). Fail-open.
  // Awaited with a small race budget — NOT pure fire-and-forget, because a
  // pending fetch at process.exit would be dropped before it ever hits the
  // wire even on the healthy path; the race bounds the down-server cost
  // while letting the fast localhost ping land normally.
  await Promise.race([pingHeartbeat(label, lastExitCode), sleep(HEARTBEAT_EXIT_WAIT_BUDGET_MS)]);

  // Exit with the actual command's final exit code so launchd sees real status
  process.exit(lastExitCode);
}

// Import guard (added 2026-07-07 alongside the heartbeat pings): only run the
// CLI when executed directly, so tests can import resolveHeartbeatBase /
// heartbeatSlug without side effects. launchd invocation is unchanged.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
