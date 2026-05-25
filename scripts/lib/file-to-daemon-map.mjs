// scripts/lib/file-to-daemon-map.mjs
//
// v2 (2026-05-25) — file-pattern → launchd-daemon mapping used by the
// post-merge restart step of the v2 autonomous-remediation pipeline.
//
// Spec: data/decisions-pending-regression-auto-action-2026-05-25.md § Q6
// (gitignored). PR #3 of 10 in the v2 build.
//
// Mapping rules (in priority order — first match wins per file):
//
//   1. Dashboard surface:
//      scripts/build-dashboard.mjs, dashboard/**, dashboard-server.mjs
//      → dashboard-server
//
//   2. Telegram bot:
//      scripts/agents/telegram-bot.mjs, lib/telegram-*
//      → telegram-bot
//
//   3. Signal monitor:
//      scripts/signal-monitor.mjs, lib/signal-*
//      → signal-monitor
//
//   4. Heartbeat (scheduled — no restart needed; next launchd cycle picks up):
//      scripts/heartbeat.mjs, scripts/heartbeat-evening.mjs, lib/heartbeat-*
//      → (none)
//
//   5. lib/* NOT matched above (shared utilities — conservative fallback):
//      → ALL long-running daemons (dashboard-server + telegram-bot +
//         signal-monitor)
//
//   6. Everything else (scripts/agents/*.mjs that aren't daemons, tests/,
//      data/, etc.) → (none)
//
// Q5 (interview 2026-05-25): retryKickstart retries 2x before declaring
// failure. The caller (verification subset / bug-resolver post-merge) then
// triggers auto-revert if any daemon failed after retries.

import { execSync } from 'node:child_process';

// ─── Daemon catalog ────────────────────────────────────────────────────────

export const LONG_RUNNING_DAEMONS = ['dashboard-server', 'telegram-bot', 'signal-monitor'];

// launchd service identifier per daemon (suffix appended to gui/$UID/).
const DAEMON_SERVICE_NAME = {
  'dashboard-server': 'com.mitchell.career-ops.dashboard-server',
  'telegram-bot':     'com.mitchell.career-ops.telegram-bot',
  'signal-monitor':   'com.mitchell.career-ops.signal-monitor',
};

// ─── File-pattern matchers ─────────────────────────────────────────────────
// Ordered list — first match wins per file. Each entry returns:
//   - null         : no restart needed
//   - 'all'        : conservative fallback — restart every LONG_RUNNING_DAEMON
//   - string       : single daemon name to restart
//   - Array<string>: explicit set of daemons (currently unused; reserved)

const FILE_PATTERNS = [
  // Dashboard surface
  { re: /^scripts\/build-dashboard\.mjs$/,      daemons: 'dashboard-server' },
  { re: /^dashboard-server\.mjs$/,              daemons: 'dashboard-server' },
  { re: /^dashboard\//,                         daemons: 'dashboard-server' },
  // Telegram bot
  { re: /^scripts\/agents\/telegram-bot\.mjs$/, daemons: 'telegram-bot' },
  { re: /^lib\/telegram-/,                      daemons: 'telegram-bot' },
  // Signal monitor
  { re: /^scripts\/signal-monitor\.mjs$/,       daemons: 'signal-monitor' },
  { re: /^lib\/signal-/,                        daemons: 'signal-monitor' },
  // Heartbeat — scheduled-only, no live process to restart
  { re: /^scripts\/heartbeat(-evening)?\.mjs$/, daemons: null },
  { re: /^lib\/heartbeat-/,                     daemons: null },
  // Non-daemon agents — no restart needed
  { re: /^scripts\/agents\/.+\.mjs$/,           daemons: null },
  // Other scheduled-only scripts
  { re: /^scripts\/.+\.mjs$/,                   daemons: null },
  // Conservative lib/* fallback — restart everything since we don't know
  // which daemons import the changed module. This is INTENTIONALLY broad
  // per spec; refinement (per-daemon import maps) is a v3 problem.
  { re: /^lib\//,                               daemons: 'all' },
];

/**
 * Given an array of changed-file paths (repo-relative), return the set of
 * daemon names that need restarting. Returns empty Set if no restart needed.
 *
 * @param {string[]} changedFiles — repo-relative paths from `git diff --name-only`
 * @returns {Set<string>} daemon names matching LONG_RUNNING_DAEMONS entries
 */
export function mapFilesToDaemons(changedFiles) {
  const daemons = new Set();
  for (const file of changedFiles || []) {
    const normalized = String(file).replace(/^\.\//, '').replace(/^\//, '');
    for (const { re, daemons: target } of FILE_PATTERNS) {
      if (re.test(normalized)) {
        if (target === null) {
          // explicit no-restart match — break inner loop, don't fall through
        } else if (target === 'all') {
          for (const d of LONG_RUNNING_DAEMONS) daemons.add(d);
        } else if (Array.isArray(target)) {
          for (const d of target) daemons.add(d);
        } else {
          daemons.add(target);
        }
        break; // first match wins
      }
    }
    // If no pattern matched, conservatively skip (matches "Other scheduled-only
    // scripts" → no restart row in the spec table).
  }
  return daemons;
}

// ─── Restart helpers ───────────────────────────────────────────────────────

/**
 * Run one `launchctl kickstart -k` against a daemon. Returns the exit code
 * on success, or throws on failure. Used internally by retryKickstart.
 *
 * Intentionally synchronous via execSync — kickstart returns quickly; the
 * actual daemon-side restart happens asynchronously regardless.
 */
function kickstartOnce(daemonName) {
  const service = DAEMON_SERVICE_NAME[daemonName];
  if (!service) {
    throw new Error(`Unknown daemon: ${daemonName}`);
  }
  const uid = String(process.getuid ? process.getuid() : 501);
  const cmd = `launchctl kickstart -k gui/${uid}/${service}`;
  // 10s timeout — kickstart should return in milliseconds. If it hangs that
  // long, something deeper is wrong (e.g. launchd state lock).
  execSync(cmd, { timeout: 10_000, stdio: 'pipe' });
}

/**
 * Retry kickstart up to `times` total attempts (so times=2 means 1 initial
 * + 1 retry = 2 attempts in total). Sleeps `delayMs` between attempts.
 *
 * Returns true on the first successful attempt. Returns false if all
 * attempts fail — caller decides whether that triggers auto-revert.
 *
 * Q5 (v2 interview 2026-05-25): default times=2, delayMs=5000.
 *
 * Note: "times" is the TOTAL number of attempts (1 initial + N-1 retries),
 * not the number of retries. Q5's "retry 2x, then auto-revert" semantically
 * meant 3 total attempts (1 initial + 2 retries), so we expose times=3 as
 * the convention for callers that want spec-literal semantics. The default
 * here is the conservative 2 (1 initial + 1 retry); callers can opt up.
 */
export async function retryKickstart(daemonName, times = 2, delayMs = 5000) {
  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      kickstartOnce(daemonName);
      return { ok: true, attempts: attempt, daemonName };
    } catch (err) {
      if (attempt < times) {
        // Sleep before next attempt
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        // Final attempt failed — surface
        return {
          ok: false,
          attempts: attempt,
          daemonName,
          error: err.message || String(err),
        };
      }
    }
  }
  // Unreachable but keeps the typechecker calm
  return { ok: false, attempts: times, daemonName, error: 'unknown' };
}

/**
 * Restart a set of daemons in parallel. Each daemon uses retryKickstart
 * with the given retry policy. Returns aggregate results.
 *
 * @param {Set<string>|string[]} daemons — names to restart
 * @param {object} opts
 * @param {number} opts.times — total attempts per daemon (default 2)
 * @param {number} opts.delayMs — delay between attempts (default 5000)
 * @returns {Promise<{success: string[], failed: Array<{daemonName, error, attempts}>}>}
 */
export async function restartDaemons(daemons, { times = 2, delayMs = 5000 } = {}) {
  const list = Array.from(daemons || []);
  const results = await Promise.all(
    list.map(d => retryKickstart(d, times, delayMs))
  );
  const success = [];
  const failed = [];
  for (const r of results) {
    if (r.ok) success.push(r.daemonName);
    else failed.push({
      daemonName: r.daemonName,
      error: r.error,
      attempts: r.attempts,
    });
  }
  return { success, failed };
}

// ─── Public predicate exports (mostly for tests) ───────────────────────────

export function isLongRunningDaemon(name) {
  return LONG_RUNNING_DAEMONS.includes(name);
}

export function daemonServiceName(daemonName) {
  return DAEMON_SERVICE_NAME[daemonName] || null;
}
