// lib/preflight-gates.mjs — pre-flight orchestrator for the reliability
// sensor mesh (Cluster J, 2026-05-21).
//
// Wraps provider-health + quota-tracker + run-metrics + hardware checks
// into a single function any agent calls before spending money on an LLM
// stage. Returns blockers (HARD — agent should abort), warnings (SOFT —
// agent should log + continue), and a summary suitable for NDJSON heartbeat.
//
// Usage:
//   import { runPreflight } from '../lib/preflight-gates.mjs';
//   const pre = await runPreflight({
//     provider: 'anthropic',
//     stage: 'cv-tailor',
//     estimatedTokens: 30_000,
//     estCostUSD: 0.50,
//   });
//   if (pre.blockers.length) {
//     console.error(JSON.stringify({ t: new Date().toISOString(), phase: 'preflight', blockers: pre.blockers }));
//     return;  // or throw
//   }
//   for (const w of pre.warnings) console.warn('[preflight]', w);
//   // ... proceed with the LLM call ...
//
// Timing budget: this function returns in <5s on a healthy system. The
// whoami ping is gated behind `validateWhoami: true` because it costs
// ~$0.0001 — set to true on the first call of a session and false on
// subsequent calls (or rely on the 60s cache).

import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { checkStatusPage, whoamiAnthropic } from './provider-health.mjs';
import { reserveQuota, snapshot as quotaSnapshot } from './quota-tracker.mjs';
import { getFlakyStages } from './run-metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MIN_DISK_FREE_BYTES = 1_073_741_824;   // 1 GB
const MAX_FD_PCT = 0.80;                      // <80% open file descriptors
const VALID_MODELS = new Set([
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  'gpt-5', 'gpt-5-mini',
  'grok-4', 'grok-4-x-search', 'grok-4-heavy',
  'sonar-deep-research', 'sonar-reasoning-pro',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview',
]);

function checkDiskFree() {
  try {
    // df returns 1K blocks on macOS; field 4 is available.
    const out = execSync('df -k /Users/mitchellwilliams', { encoding: 'utf-8', timeout: 5_000 });
    const lines = out.trim().split('\n');
    const cols = lines[1].split(/\s+/);
    const availKB = parseInt(cols[3], 10);
    const availBytes = availKB * 1024;
    return { ok: availBytes >= MIN_DISK_FREE_BYTES, availBytes, availGB: (availBytes / 1024 / 1024 / 1024).toFixed(2) };
  } catch (e) {
    return { ok: true, error: e.message?.slice(0, 80), warn: 'disk check failed; allowing' };
  }
}

function checkFileDescriptors() {
  try {
    // ulimit -n is the per-process cap; count open across all PIDs via lsof
    // is too heavy. Use the simpler proxy: count of node-process FDs.
    const max = parseInt(execSync('ulimit -n', { encoding: 'utf-8', shell: '/bin/bash', timeout: 5_000 }).trim(), 10);
    const open = parseInt(execSync('lsof -u $(id -u) 2>/dev/null | wc -l', { encoding: 'utf-8', shell: '/bin/bash', timeout: 10_000 }).trim(), 10);
    const pct = open / (max * 200);  // user-wide ceiling is ~max * (process count); approximate
    return { ok: pct < MAX_FD_PCT, open, max, pct: (pct * 100).toFixed(1) + '%' };
  } catch (e) {
    return { ok: true, error: e.message?.slice(0, 80), warn: 'fd check failed; allowing' };
  }
}

function checkZombieMcpPdf() {
  try {
    // Pattern-G of the bug catalog: MCP PDF servers leak ptys. >50 stuck
    // procs is a sign the pool is filling up.
    const count = parseInt(execSync('ps aux | grep -c "[m]cp-pdf"', { encoding: 'utf-8', shell: '/bin/bash', timeout: 5_000 }).trim(), 10);
    return { ok: count < 50, count };
  } catch (e) {
    return { ok: true, count: 0 };
  }
}

/**
 * Main entry. Returns { ok, blockers, warnings, snapshot } where:
 *   - blockers: array of { check, reason } — HARD failures, abort the work
 *   - warnings: array of { check, reason } — SOFT, log and continue
 *   - snapshot: object suitable for NDJSON heartbeat emission
 */
export async function runPreflight({
  provider = 'anthropic',
  stage,
  estimatedTokens = 0,
  estCostUSD = 0,
  validateWhoami = false,
  checkHardware = true,
  checkProviderStatus = true,
} = {}) {
  const blockers = [];
  const warnings = [];
  const snapshot = {
    provider,
    stage,
    estimatedTokens,
    estCostUSD,
    checkedAt: new Date().toISOString(),
  };

  // Provider status page
  if (checkProviderStatus) {
    const status = await checkStatusPage(provider);
    snapshot.statusPage = { indicator: status.indicator, description: status.description };
    if (status.indicator === 'critical') {
      blockers.push({ check: 'status_page', reason: `${provider} status: ${status.description}` });
    } else if (status.indicator === 'major') {
      warnings.push({ check: 'status_page', reason: `${provider} degraded: ${status.description}` });
    }
  }

  // Whoami (opt-in — costs ~$0.0001)
  if (validateWhoami && provider === 'anthropic') {
    const w = await whoamiAnthropic();
    snapshot.whoami = { ok: w.ok, latencyMs: w.latencyMs };
    if (!w.ok) {
      blockers.push({ check: 'whoami', reason: `Anthropic auth/quota failed: ${w.error}` });
    } else if (w.latencyMs > 3_000) {
      warnings.push({ check: 'whoami', reason: `Anthropic latency ${w.latencyMs}ms — provider degraded?` });
    }
  }

  // Local quota
  if (estimatedTokens > 0) {
    const q = reserveQuota(provider, estimatedTokens);
    snapshot.quota = { usedTokens: q.usedTokens, cap: q.cap, headroom: q.headroom };
    if (!q.ok) {
      blockers.push({ check: 'quota', reason: `Would exceed ${provider} rate cap (used ${q.usedTokens}/${q.cap}, need ${estimatedTokens})` });
    } else if (q.warn === 'approaching_cap') {
      warnings.push({ check: 'quota', reason: `${provider} at ${((q.usedTokens / q.cap) * 100).toFixed(0)}% of minute cap` });
    }
  }

  // Stage flakiness (warn-only)
  if (stage) {
    const flaky = getFlakyStages({ minSuccessRate: 0.9, minCount: 5, lookbackHours: 24 }).find(f => f.stage === stage);
    if (flaky) {
      warnings.push({ check: 'flaky_stage', reason: `${stage} success rate ${(flaky.successRate * 100).toFixed(0)}% over last 24h (${flaky.successes}/${flaky.total})` });
      snapshot.flaky = { successRate: flaky.successRate, total: flaky.total };
    }
  }

  // Hardware
  if (checkHardware) {
    const disk = checkDiskFree();
    snapshot.disk = { availGB: disk.availGB };
    if (!disk.ok) {
      blockers.push({ check: 'disk', reason: `Free disk ${disk.availGB}GB below 1GB floor` });
    }
    const fd = checkFileDescriptors();
    if (!fd.ok) {
      warnings.push({ check: 'fd', reason: `File descriptors at ${fd.pct}` });
    }
    const mcpPdf = checkZombieMcpPdf();
    if (!mcpPdf.ok) {
      warnings.push({ check: 'mcp_pdf', reason: `${mcpPdf.count} zombie MCP-PDF processes — pty pool risk` });
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    snapshot,
  };
}

/**
 * Emit a single-line NDJSON heartbeat to stderr. Wraps the snapshot in a
 * standard envelope so the dashboard tailers can parse it.
 */
export function emitHeartbeat({ phase, step, snapshot, extra = {} }) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    phase,
    step,
    ...snapshot,
    ...extra,
  });
  try { process.stderr.write(line + '\n'); } catch {}
}
