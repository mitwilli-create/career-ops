/**
 * scripts/agents/regression-guard/lib/log-spend.mjs
 *
 * Logging, heartbeat-NDJSON, and per-LLM-call spend tracking + soft per-call
 * WARN. Daily-cap arithmetic.
 *
 * Spec source:
 *   - Mitchell's locked: $20 daily cap, NO hard per-call sub-cap, SOFT $5/call WARN
 *   - Hang-prevention contract: heartbeat NDJSON to stderr every ≤30s
 *   - dealbreaker-final § Audit Item 1 — daily cap + per-call soft warn
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly — same log format, same WARN threshold, same
 * spend-ledger filter (mock entries excluded from production cap math).
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync,
} from 'node:fs';

import {
  LOG_DIR, LOG_PATH, SPEND_LEDGER_PATH, TODAY,
  DAILY_USD_CAP, PER_CALL_WARN_USD,
} from './config.mjs';

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

let HEARTBEAT_LAST = Date.now();

export function log(line, level = 'info') {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] [${level}] ${line}\n`;
  process.stdout.write(entry);
  try { appendFileSync(LOG_PATH, entry); } catch { /* never crash on log write */ }
  HEARTBEAT_LAST = Date.now();
}

export function heartbeat(phase, step, extra = {}) {
  const rec = { t: new Date().toISOString(), phase, step, ...extra };
  try { process.stderr.write(JSON.stringify(rec) + '\n'); } catch { /* swallow */ }
  HEARTBEAT_LAST = Date.now();
}

export function getHeartbeatLast() {
  return HEARTBEAT_LAST;
}

// ─── Cost tracker ───────────────────────────────────────────────────────────
export function getTodaySpend() {
  if (!existsSync(SPEND_LEDGER_PATH)) return 0;
  try {
    const raw = readFileSync(SPEND_LEDGER_PATH, 'utf-8');
    let sum = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // Filter mock entries (smoke-test artifacts) — they record the WARN but
        // don't count toward production daily-cap math.
        if (r.model === 'mock' || r.label === 'smoke-test-warn') continue;
        if (typeof r.date === 'string' && r.date === TODAY && typeof r.usd === 'number') {
          sum += r.usd;
        }
      } catch { /* skip malformed */ }
    }
    return sum;
  } catch { return 0; }
}

export function recordSpend({ model, usd, tokens_in, tokens_out, label, chunk_id }) {
  const rec = {
    date: TODAY,
    timestamp: new Date().toISOString(),
    model,
    usd: Number(usd) || 0,
    tokens_in: tokens_in || null,
    tokens_out: tokens_out || null,
    label: label || null,
    chunk_id: chunk_id || null,
  };
  try {
    appendFileSync(SPEND_LEDGER_PATH, JSON.stringify(rec) + '\n');
  } catch (err) {
    log(`failed to append spend record: ${err.message}`, 'warn');
  }
  // SOFT per-call WARN per Mitchell's locked decision (no hard sub-cap)
  if (rec.usd > PER_CALL_WARN_USD) {
    log(
      `WARN: per-call cost ${rec.usd.toFixed(4)} USD exceeded $${PER_CALL_WARN_USD} ` +
      `(model=${model}, label=${label}) — review the run; not a block.`,
      'warn'
    );
  }
  return rec;
}

export function checkDailyCap(capUsd = DAILY_USD_CAP) {
  const spent = getTodaySpend();
  if (spent >= capUsd) {
    return { exhausted: true, spent, cap: capUsd };
  }
  return { exhausted: false, spent, cap: capUsd };
}
