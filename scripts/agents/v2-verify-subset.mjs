#!/usr/bin/env node
// scripts/agents/v2-verify-subset.mjs
//
// v2 (2026-05-25) — 5-step post-merge verification subset for the v2
// autonomous-remediation pipeline. PR #4 of 10.
//
// Spec: data/decisions-pending-regression-auto-action-2026-05-25.md § Q5
// (gitignored). Total budget ~$2, ~5 min wall-clock.
//
// Invocation:
//   node scripts/agents/v2-verify-subset.mjs --fix-sha <sha> --files file1,file2,...
//   node scripts/agents/v2-verify-subset.mjs --dry-run        # validates orchestration without side effects
//
// Step matrix:
//   0. Daemon restart (via scripts/lib/file-to-daemon-map.mjs, PR #3)
//   1. regression-guard mini re-run (--canary-only mode; no Sonnet synthesis)
//   2. Canary suite pass (folded into step 1 — regression-guard --canary-only IS the canary suite)
//   3. Dashboard 200 OK (curl)
//   4. Heartbeat machinery validation (node --check scripts/heartbeat.mjs)
//      Note: spec called for HEARTBEAT_DRYRUN=1 invocation, but heartbeat.mjs
//      doesn't currently support that flag. v2.1 follow-up will add real
//      dryrun support; for now syntax-check is the proxy signal.
//   5. Chrome MCP screenshot (UI-touching fixes only) with curl+grep fallback per Q9
//
// Exit codes:
//   0 — PASS (all eligible steps green)
//   1 — FAIL (one or more steps failed; caller triggers auto-revert)
//   2 — bad args
//   3 — invocation error (not related to verification outcome)

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mapFilesToDaemons,
  restartDaemons,
} from '../lib/file-to-daemon-map.mjs';
// v2 PR #8: fix-log writes on PASS/FAIL + auto-revert trigger on FAIL.
import { appendV2FixLogEntry } from '../../lib/v2-fix-log.mjs';
import { recordRollback } from '../../lib/v2-thrash-counter.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

// File extensions / paths that warrant the Chrome MCP screenshot step.
const UI_TOUCH_PATTERNS = [
  /^scripts\/build-dashboard\.mjs$/,
  /^dashboard-server\.mjs$/,
  /^dashboard\//,
  /\.html$/,
  /\.css$/,
];

const DASHBOARD_PUBLIC_URL = 'https://dashboard.careers-ops.com/';

// ─── Helpers ───────────────────────────────────────────────────────────────

function logStep(stepName, status, detail = '') {
  const ts = new Date().toISOString();
  const symbol = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [v2-verify] ${symbol} ${stepName}: ${status}${detail ? ' — ' + detail : ''}`);
}

function isUiTouching(files) {
  return files.some(f => UI_TOUCH_PATTERNS.some(re => re.test(f)));
}

// ─── Step 0: Daemon restart (PR #3) ────────────────────────────────────────

async function step0DaemonRestart(files, dryRun) {
  const daemons = mapFilesToDaemons(files);
  if (daemons.size === 0) {
    logStep('step-0 daemon-restart', 'PASS', 'no daemons impacted');
    return { ok: true, restarted: [], skipped: true };
  }
  if (dryRun) {
    logStep('step-0 daemon-restart', 'PASS', `dry-run — would restart ${[...daemons].join(',')}`);
    return { ok: true, restarted: [...daemons], dryRun: true };
  }
  const result = await restartDaemons(daemons, { times: 2, delayMs: 5000 });
  if (result.failed.length > 0) {
    logStep('step-0 daemon-restart', 'FAIL',
      `${result.failed.length} daemon(s) failed after retries: ` +
      result.failed.map(f => `${f.daemonName} (${f.attempts}x)`).join(', '));
    return {
      ok: false,
      restarted: result.success,
      failed: result.failed,
    };
  }
  logStep('step-0 daemon-restart', 'PASS', `restarted ${result.success.join(',')}`);
  return { ok: true, restarted: result.success };
}

// ─── Steps 1 + 2: regression-guard --canary-only ───────────────────────────

function step12RegressionGuardCanary(dryRun) {
  if (dryRun) {
    logStep('step-1+2 regression-guard --canary-only', 'PASS', 'dry-run skip');
    return { ok: true, dryRun: true };
  }
  try {
    const out = execSync(
      `node scripts/agents/regression-guard.mjs --canary-only`,
      { cwd: REPO_ROOT, timeout: 60_000, stdio: 'pipe', encoding: 'utf-8' }
    );
    // --canary-only logs "✓ canary-suite — N/N" or "✗ canary-suite — degraded"
    // Look for any degraded signal in stderr/stdout.
    const passed = !/canary.*degraded|✗|CRIT/.test(out);
    if (passed) {
      logStep('step-1+2 regression-guard --canary-only', 'PASS', 'canary suite green');
      return { ok: true };
    } else {
      logStep('step-1+2 regression-guard --canary-only', 'FAIL', 'canary degraded — see regression-guard report');
      return { ok: false, error: 'canary-degraded', output: out.slice(0, 500) };
    }
  } catch (err) {
    logStep('step-1+2 regression-guard --canary-only', 'FAIL',
      `invocation error: ${err.message.slice(0, 200)}`);
    return { ok: false, error: 'invocation-error', message: err.message };
  }
}

// ─── Step 3: Dashboard 200 OK ──────────────────────────────────────────────

function step3DashboardLive(dryRun) {
  if (dryRun) {
    logStep('step-3 dashboard-200', 'PASS', 'dry-run skip');
    return { ok: true, dryRun: true };
  }
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --max-time 15 ${DASHBOARD_PUBLIC_URL}`,
      { encoding: 'utf-8', timeout: 20_000 }
    ).trim();
    if (code === '200') {
      logStep('step-3 dashboard-200', 'PASS', `${DASHBOARD_PUBLIC_URL} → 200`);
      return { ok: true, statusCode: 200 };
    } else {
      logStep('step-3 dashboard-200', 'FAIL', `expected 200, got ${code}`);
      return { ok: false, statusCode: code };
    }
  } catch (err) {
    logStep('step-3 dashboard-200', 'FAIL', `curl error: ${err.message.slice(0, 120)}`);
    return { ok: false, error: 'curl-failed', message: err.message };
  }
}

// ─── Step 4: Heartbeat machinery validation ────────────────────────────────
// Note: spec called for HEARTBEAT_DRYRUN=1, but heartbeat.mjs doesn't support
// that flag yet. v2.1 follow-up will add real dryrun. For now we
// node-check the script as a proxy — catches syntax-level regressions.

function step4HeartbeatSyntax(dryRun) {
  if (dryRun) {
    logStep('step-4 heartbeat-syntax', 'PASS', 'dry-run skip');
    return { ok: true, dryRun: true };
  }
  try {
    execSync(`node --check scripts/heartbeat.mjs`, {
      cwd: REPO_ROOT, timeout: 10_000, stdio: 'pipe',
    });
    logStep('step-4 heartbeat-syntax', 'PASS', 'node --check OK (HEARTBEAT_DRYRUN deferred to v2.1)');
    return { ok: true, mode: 'syntax-check', note: 'HEARTBEAT_DRYRUN not yet supported' };
  } catch (err) {
    logStep('step-4 heartbeat-syntax', 'FAIL', `syntax error: ${err.message.slice(0, 200)}`);
    return { ok: false, error: 'syntax-error', message: err.message };
  }
}

// ─── Step 5: UI verification (Chrome MCP OR curl+grep fallback) ────────────

function step5UiVerify(files, dryRun) {
  const uiTouching = isUiTouching(files);
  if (!uiTouching) {
    logStep('step-5 ui-verify', 'PASS', 'no UI files touched — skipped');
    return { ok: true, skipped: true, reason: 'no-ui-touch' };
  }
  if (dryRun) {
    logStep('step-5 ui-verify', 'PASS', 'dry-run skip');
    return { ok: true, dryRun: true };
  }

  // Chrome MCP path is interactive-only (requires Chrome extension active).
  // In headless / batch / launchd contexts we always take the curl + grep
  // fallback per CLAUDE.md UI-Change Verification rule + Q9 of the v2 interview.
  //
  // Future enhancement: detect Chrome MCP availability via env / IPC and
  // upgrade to screenshot path when present. For now: curl + grep is the
  // documented baseline.

  const expectedPatterns = [
    'apply-now',          // sidebar widget
    'pipeline',           // pipeline activity area
    'dashboard',          // page chrome
  ];

  try {
    const html = execSync(
      `curl -sS --max-time 20 ${DASHBOARD_PUBLIC_URL}`,
      { encoding: 'utf-8', timeout: 25_000 }
    );
    const missing = expectedPatterns.filter(p => !html.toLowerCase().includes(p));
    if (missing.length === 0) {
      logStep('step-5 ui-verify', 'PASS',
        `curl+grep fallback — found all ${expectedPatterns.length} expected patterns (mcp-fallback)`);
      return {
        ok: true,
        mode: 'curl-grep-fallback',
        patterns_checked: expectedPatterns.length,
      };
    } else {
      logStep('step-5 ui-verify', 'FAIL',
        `curl+grep — missing patterns: ${missing.join(',')}`);
      return {
        ok: false,
        mode: 'curl-grep-fallback',
        missing_patterns: missing,
      };
    }
  } catch (err) {
    logStep('step-5 ui-verify', 'FAIL', `curl error: ${err.message.slice(0, 120)}`);
    return { ok: false, error: 'curl-failed', message: err.message };
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export async function verifyV2Fix({ fixSha, changedFiles, dryRun = false }) {
  const startMs = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] [v2-verify] start — fix=${fixSha || 'unknown'} files=${(changedFiles || []).length} dryRun=${dryRun}`);

  const result = {
    fixSha: fixSha || null,
    changedFiles: (changedFiles || []).slice(),
    startedAt: new Date().toISOString(),
    steps: {},
    overall: 'PASS',
    failReason: null,
    elapsedMs: 0,
    dryRun,
  };

  // Step 0 (gate — if daemon restart fails, abort before verification)
  result.steps.daemon_restart = await step0DaemonRestart(changedFiles || [], dryRun);
  if (!result.steps.daemon_restart.ok) {
    result.overall = 'FAIL';
    result.failReason = 'daemon-restart-failed';
    result.elapsedMs = Date.now() - startMs;
    return result;
  }

  // Steps 1+2
  result.steps.canary = step12RegressionGuardCanary(dryRun);
  if (!result.steps.canary.ok) {
    result.overall = 'FAIL';
    result.failReason = 'canary-degraded';
  }

  // Step 3
  result.steps.dashboard_live = step3DashboardLive(dryRun);
  if (!result.steps.dashboard_live.ok) {
    result.overall = 'FAIL';
    result.failReason = result.failReason || 'dashboard-not-200';
  }

  // Step 4
  result.steps.heartbeat = step4HeartbeatSyntax(dryRun);
  if (!result.steps.heartbeat.ok) {
    result.overall = 'FAIL';
    result.failReason = result.failReason || 'heartbeat-syntax-error';
  }

  // Step 5 (conditional on UI-touching)
  result.steps.ui_verify = step5UiVerify(changedFiles || [], dryRun);
  if (!result.steps.ui_verify.ok) {
    result.overall = 'FAIL';
    result.failReason = result.failReason || 'ui-verify-failed';
  }

  result.elapsedMs = Date.now() - startMs;
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] [v2-verify] done — overall=${result.overall} elapsed=${(result.elapsedMs / 1000).toFixed(1)}s`);

  // v2 PR #8: write fix-log entry and, on FAIL, trigger auto-revert.
  // Only when fixSha is known (CLI invocation always passes it; guard for API callers).
  if (fixSha && !dryRun) {
    const logEntry = {
      fix_sha: fixSha,
      detector: 'bug-resolver',
      detector_severity: 'MED',   // severity not available in verify scope; MED is conservative
      finding_hash: 'sha256:' + fixSha.slice(0, 12),
      pr_url: null,                // PR URL not passed to verifyV2Fix; heartbeat reads from DRAFT entry
      pr_state: result.overall === 'PASS' ? 'VERIFIED' : 'REVERTED',
      verification: {
        overall: result.overall,
        ...(result.failReason ? { fail_reason: result.failReason } : {}),
      },
      cost_usd: null,             // verify itself has negligible LLM cost
      files_changed: (changedFiles || []).map(f => String(f).slice(0, 300)),
      time_to_resolution_ms: result.elapsedMs,
    };

    try {
      appendV2FixLogEntry(logEntry);
    } catch (logErr) {
      // Non-fatal — fix-log is observability infrastructure, not load-bearing.
      console.warn(`[v2-verify] WARN: fix-log write failed: ${logErr.message}`);
    }

    if (result.overall === 'FAIL') {
      // Auto-revert: directly call recordRollback with trigger='auto' so it
      // counts toward the 3/24h freeze threshold. This is the auto-revert code
      // path — distinct from the CLI path which always records trigger='manual'.
      // Per Q6 (locked): manual rollbacks do NOT count toward the freeze; only
      // auto-reverts do. The CLI v2-rollback.mjs records 'manual'; we record 'auto'.
      try {
        const rollbackEntry = recordRollback({
          fix_sha: fixSha,
          reason: 'verification-subset-fail',
          trigger: 'auto',
        });
        console.warn(`[v2-verify] auto-revert recorded (trigger=auto): fix_sha=${fixSha}` +
          (rollbackEntry.frozen_until ? ` FREEZE until ${rollbackEntry.frozen_until}` : ''));
      } catch (rbErr) {
        console.error(`[v2-verify] CRITICAL: auto-revert recordRollback failed: ${rbErr.message}`);
        // Don't rethrow — returning result with overall=FAIL is the authoritative signal.
      }
    }
  }

  return result;
}

// ─── CLI entrypoint ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { fixSha: null, files: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix-sha') opts.fixSha = argv[++i];
    else if (a === '--files') {
      opts.files = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
v2-verify-subset — post-merge verification for v2 autonomous-remediation fixes.

Usage:
  node scripts/agents/v2-verify-subset.mjs --fix-sha <sha> --files <f1,f2,...>
  node scripts/agents/v2-verify-subset.mjs --dry-run

Args:
  --fix-sha <sha>    The merged commit SHA being verified
  --files <list>     Comma-separated repo-relative paths touched by the fix
  --dry-run          Skip all side effects; print orchestration plan only
  --help, -h         Show this message

Steps (5):
  0. Daemon restart (via scripts/lib/file-to-daemon-map.mjs)
  1+2. regression-guard --canary-only (canary suite)
  3. Dashboard 200 OK at https://dashboard.careers-ops.com/
  4. Heartbeat syntax check (HEARTBEAT_DRYRUN deferred to v2.1)
  5. UI verify (curl + grep fallback per Q9) — only if UI files touched

Exit codes:
  0 — PASS
  1 — FAIL (caller triggers auto-revert)
  2 — bad args
`.trim());
}

// If invoked directly (not imported), run as CLI.
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const opts = parseArgs(process.argv.slice(2));
  verifyV2Fix({
    fixSha: opts.fixSha,
    changedFiles: opts.files,
    dryRun: opts.dryRun,
  }).then(result => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.overall === 'PASS' ? 0 : 1);
  }).catch(err => {
    console.error(`FATAL: ${err.message}`);
    console.error(err.stack || '');
    process.exit(3);
  });
}
