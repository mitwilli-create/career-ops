#!/usr/bin/env node
/**
 * scripts/agents/hang-watchdog.mjs — career-ops hang detector + postmortem.
 *
 * Watches every career-ops node process and flags hangs by signature:
 *   wall > MIN_WALL_MIN AND CPU% < MAX_CPU_PCT AND silent > MAX_SILENT_MIN
 *
 * Tracks consecutive flags per PID in data/hang-watchdog-state.json. After
 * REPORT_AFTER_FLAGS consecutive flags, captures a 3s stack sample +
 * postmortem to data/hang-postmortem-<date>-<pid>.md. After KILL_AFTER_FLAGS
 * consecutive flags (and only if --auto-kill is passed), SIGTERMs then
 * SIGKILLs the process. Default mode is REPORT-ONLY.
 *
 * Whitelisted daemons (never flagged as hangs):
 *   - telegram-bot.mjs           (long-running poll)
 *   - dashboard-server.mjs       (HTTP server)
 *   - signal-monitor.mjs         (long-running listener)
 *   - cloudflared / Cloudflared  (tunnel daemon)
 *   - hang-watchdog.mjs itself   (recursion guard)
 *
 * CLI:
 *   --interval-sec=60      poll cadence (default 60s)
 *   --min-wall-min=10      min wall-clock minutes to consider a hang
 *   --max-cpu-pct=1.0      max CPU% to consider a hang
 *   --max-silent-min=5     max minutes since last NDJSON log write
 *   --report-after=3       consecutive flags before postmortem
 *   --kill-after=5         consecutive flags before kill (only with --auto-kill)
 *   --auto-kill            enable SIGTERM/SIGKILL on KILL_AFTER threshold
 *   --once                 single pass instead of loop (useful for testing)
 *
 * Designed to run every 5 minutes via launchd (interval=300) in REPORT-ONLY
 * mode (com.mitchell.career-ops.hang-watchdog.plist). Mitchell must
 * explicitly enable --auto-kill in the plist when he's ready.
 *
 * Self-defense: every external call (sample, ps, etc.) has a spawn timeout.
 * NDJSON heartbeat emit every 30s. Hang-prone patterns from 2026-05-19
 * audit (patterns 1-10) — this script must NOT become a hang itself.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const LOG_DIR = join(DATA_DIR, 'logs');
const STATE_PATH = join(DATA_DIR, 'hang-watchdog-state.json');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ─── Config ────────────────────────────────────────────────────────────────────

function readNumFlag(name, fallback) {
  const eqIdx = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (eqIdx < 0) return fallback;
  const arg = process.argv[eqIdx];
  const val = arg.includes('=') ? arg.split('=')[1] : process.argv[eqIdx + 1];
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function hasFlag(name) { return process.argv.some(a => a === `--${name}`); }

const INTERVAL_SEC = readNumFlag('interval-sec', 60);
const MIN_WALL_MIN = readNumFlag('min-wall-min', 10);
const MAX_CPU_PCT = readNumFlag('max-cpu-pct', 1.0);
const MAX_SILENT_MIN = readNumFlag('max-silent-min', 5);
const REPORT_AFTER_FLAGS = readNumFlag('report-after', 3);
const KILL_AFTER_FLAGS = readNumFlag('kill-after', 5);
const AUTO_KILL = hasFlag('auto-kill');
const ONCE = hasFlag('once');
const HEARTBEAT_INTERVAL_MS = 30_000;

const WHITELIST_BASENAMES = new Set([
  'telegram-bot.mjs',
  'dashboard-server.mjs',
  'signal-monitor.mjs',
  'hang-watchdog.mjs',     // recursion guard — never flag ourselves
]);
// Path-substring matches (for non-mjs daemons)
const WHITELIST_SUBSTRINGS = ['cloudflared', 'Cloudflared'];

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return { pidFlags: {}, lastRun: null, history: [] };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { pidFlags: {}, lastRun: null, history: [] }; }
}
function saveState(state) {
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
  catch (e) { stderr(`saveState error: ${e.message}`); }
}

// ─── NDJSON heartbeat + emit ──────────────────────────────────────────────────

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* never block on stdout */ }
}
function stderr(msg) {
  try { process.stderr.write(`[hang-watchdog] ${msg}\n`); } catch {}
}

// ─── ps + log scanning ────────────────────────────────────────────────────────

function listCareerOpsProcesses() {
  // spawnSync with timeout — must not hang the watchdog itself
  const r = spawnSync('ps', ['-ax', '-o', 'pid,etime,pcpu,command'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) {
    stderr(`ps failed (status=${r.status}, signal=${r.signal})`);
    return [];
  }
  const out = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    if (!line.trim()) continue;
    if (!/career-ops\/scripts|career-ops\/dashboard-server|career-ops\/telegram-bot|career-ops\/lib/.test(line)) continue;
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, etime, pcpu, command] = m;
    out.push({
      pid: Number(pid),
      etime,
      etimeSec: parseEtime(etime),
      cpuPct: Number(pcpu),
      command,
    });
  }
  return out;
}

function parseEtime(etime) {
  // formats: SS, MM:SS, HH:MM:SS, DD-HH:MM:SS
  const parts = etime.split(/[-:]/).map(Number);
  if (etime.includes('-')) {
    const [d, h, m, s] = parts;
    return d * 86_400 + h * 3_600 + m * 60 + s;
  }
  if (parts.length === 3) return parts[0] * 3_600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function isWhitelisted(command) {
  for (const b of WHITELIST_BASENAMES) {
    if (command.includes(`/${b}`)) return true;
  }
  for (const s of WHITELIST_SUBSTRINGS) {
    if (command.includes(s)) return true;
  }
  return false;
}

function findLastLogWriteMs(command) {
  // Best-effort: try to match command → log file by agent slug
  // Most agents log to data/logs/<agent>-YYYY-MM-DD.log or .out/.err
  const m = command.match(/scripts\/agents\/([\w-]+)\.mjs/);
  const slug = m ? m[1] : null;
  if (!slug) return null;
  // Find most recent log file matching the slug
  let bestMtime = null;
  try {
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith(slug + '-') && !f.startsWith(slug + '.')) continue;
      const full = join(LOG_DIR, f);
      try {
        const stat = statSync(full);
        if (bestMtime === null || stat.mtimeMs > bestMtime) bestMtime = stat.mtimeMs;
      } catch { /* skip */ }
    }
  } catch { return null; }
  return bestMtime;
}

// ─── Postmortem capture ───────────────────────────────────────────────────────

function capturePostmortem(proc, reason) {
  const pid = proc.pid;
  const today = new Date().toISOString().slice(0, 10);
  const path = join(DATA_DIR, `hang-postmortem-${today}-${pid}.md`);

  // Stack sample (best-effort, 3s wait, 10s spawn timeout)
  let sampleOut = '<sample failed>';
  try {
    const samplePath = `/tmp/sample-${pid}-${Date.now()}.txt`;
    const r = spawnSync('sample', [String(pid), '3', '-file', samplePath], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (r.status === 0 && existsSync(samplePath)) {
      sampleOut = readFileSync(samplePath, 'utf-8').slice(0, 8000);
    } else {
      sampleOut = `sample exit=${r.status} signal=${r.signal}\nstderr: ${(r.stderr || '').slice(0, 400)}`;
    }
  } catch (e) { sampleOut = `sample error: ${e.message}`; }

  // lsof snapshot (10s timeout)
  let lsofOut = '<lsof failed>';
  try {
    const r = spawnSync('lsof', ['-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (r.status === 0) lsofOut = (r.stdout || '').split('\n').slice(0, 80).join('\n');
    else lsofOut = `lsof exit=${r.status}`;
  } catch (e) { lsofOut = `lsof error: ${e.message}`; }

  const body = `# Hang postmortem — PID ${pid} (${today})

**Reason:** ${reason}
**Process:**
- PID: ${pid}
- Wall: ${proc.etime} (${proc.etimeSec}s)
- CPU%: ${proc.cpuPct}
- Command: \`${proc.command}\`

## Stack sample (3s)

\`\`\`
${sampleOut}
\`\`\`

## Open file descriptors (top 80)

\`\`\`
${lsofOut}
\`\`\`

## Next step

If this hang signature matches a known pattern (LLM API hang, MCP-pty leak,
body-read stall), check the existing pattern entry in:
- \`~/.claude/projects/-Users-mitchellwilliams-Documents-career-ops/memory/feedback_hang_prevention_patterns.md\`
- \`AGENTS.md\` § "Bug class: missing-timeout-on-long-running-operation"

Generated by scripts/agents/hang-watchdog.mjs
`;

  try { writeFileSync(path, body); } catch (e) { stderr(`postmortem write error: ${e.message}`); }
  return path;
}

function killProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try { process.kill(pid, 0); /* still alive */ process.kill(pid, 'SIGKILL'); }
      catch { /* already dead */ }
    }, 10_000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Main pass ────────────────────────────────────────────────────────────────

function runPass() {
  const state = loadState();
  state.lastRun = new Date().toISOString();

  const procs = listCareerOpsProcesses();
  const now = Date.now();
  const alivePids = new Set(procs.map(p => String(p.pid)));

  // Garbage-collect state for dead PIDs
  for (const pid of Object.keys(state.pidFlags)) {
    if (!alivePids.has(pid)) delete state.pidFlags[pid];
  }

  const flagged = [];
  for (const p of procs) {
    if (isWhitelisted(p.command)) continue;
    const wallMin = p.etimeSec / 60;
    if (wallMin < MIN_WALL_MIN) continue;
    if (p.cpuPct >= MAX_CPU_PCT) continue;

    const lastLogMs = findLastLogWriteMs(p.command);
    const silentMin = lastLogMs ? (now - lastLogMs) / 60_000 : Infinity;
    if (silentMin < MAX_SILENT_MIN) continue;

    flagged.push({ ...p, silentMin: Number.isFinite(silentMin) ? silentMin.toFixed(1) : 'unknown' });

    const pidKey = String(p.pid);
    state.pidFlags[pidKey] = (state.pidFlags[pidKey] || 0) + 1;
  }

  for (const p of flagged) {
    const flags = state.pidFlags[String(p.pid)];
    if (flags === REPORT_AFTER_FLAGS) {
      const pmPath = capturePostmortem(p, `flagged ${flags}× consecutive: wall=${p.etimeSec}s CPU=${p.cpuPct}% silent=${p.silentMin}min`);
      emit({ event: 'postmortem', pid: p.pid, flags, postmortem: pmPath });
      state.history.push({ ts: state.lastRun, event: 'postmortem', pid: p.pid, postmortem: pmPath });
    }
    if (flags >= KILL_AFTER_FLAGS && AUTO_KILL) {
      const r = killProcess(p.pid);
      emit({ event: 'kill-attempt', pid: p.pid, flags, ok: r.ok, error: r.error });
      state.history.push({ ts: state.lastRun, event: 'killed', pid: p.pid });
      delete state.pidFlags[String(p.pid)];
    }
  }

  // Trim history to last 100 entries
  if (state.history.length > 100) state.history = state.history.slice(-100);
  saveState(state);

  emit({
    event: 'pass-complete',
    procs_scanned: procs.length,
    flagged_count: flagged.length,
    auto_kill_mode: AUTO_KILL,
    pids_tracked: Object.keys(state.pidFlags).length,
  });

  return { flaggedCount: flagged.length, procsScanned: procs.length };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

let heartbeatTimer = null;
function startHeartbeat() {
  heartbeatTimer = setInterval(() => emit({ event: 'heartbeat', auto_kill_mode: AUTO_KILL }), HEARTBEAT_INTERVAL_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

process.on('SIGTERM', () => { stopHeartbeat(); process.exit(0); });
process.on('SIGINT', () => { stopHeartbeat(); process.exit(0); });

async function main() {
  emit({
    event: 'start',
    interval_sec: INTERVAL_SEC,
    min_wall_min: MIN_WALL_MIN,
    max_cpu_pct: MAX_CPU_PCT,
    max_silent_min: MAX_SILENT_MIN,
    report_after: REPORT_AFTER_FLAGS,
    kill_after: KILL_AFTER_FLAGS,
    auto_kill: AUTO_KILL,
    once: ONCE,
  });

  if (ONCE) {
    runPass();
    emit({ event: 'shutdown', reason: 'once-mode' });
    return;
  }

  startHeartbeat();
  try {
    while (true) {
      try { runPass(); }
      catch (e) { emit({ event: 'pass-error', error: e.message }); }
      // sleep until next interval — using AbortSignal for SIGTERM responsiveness
      await new Promise(resolve => setTimeout(resolve, INTERVAL_SEC * 1000));
    }
  } finally {
    stopHeartbeat();
  }
}

main().catch(e => {
  emit({ event: 'fatal', error: e.message });
  stopHeartbeat();
  process.exit(1);
});
