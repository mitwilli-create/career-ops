// lib/v2-budget.mjs
//
// v2 (2026-05-25) — unified $300/day budget enforcement for the v2
// autonomous-remediation pipeline. PR #9 of 10.
//
// Spec: data/decisions-pending-regression-auto-action-2026-05-25.md § Q8
// (gitignored). Per Mitchell's locked decision: $300/day cap reflects the
// upper-bound of pay-per-token pricing; actual spend is lower (subscription
// credits). Don't over-engineer; just enforce the hard cap.
//
// Spend sources summed for the unified v2 budget:
//   data/regression-guard-spend.jsonl  — regression-guard LLM calls
//   data/bug-resolver-spend.jsonl      — bug-resolver 7-phase pipeline
//   data/v2-verify-spend.jsonl         — v2-verify-subset (future, small)
//
// Spend JSONL schema (one JSON per line, per-source):
//   { date: "YYYY-MM-DD", usd: 0.50, ... }
//   (other fields ignored — only date + usd are consumed here)
//
// Usage:
//   import { checkV2Budget } from '../../lib/v2-budget.mjs';
//   const { ok, spent, remaining } = checkV2Budget({ estimatedNextPhase: 5.0 });
//   if (!ok) { /* abort, emit CRIT finding */ }

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DATA_DIR = join(REPO_ROOT, 'data');

/**
 * Hard daily cap. Configurable via V2_BUDGET_USD env var.
 * Default: $300 (per Mitchell's locked Q8 decision — upper-bound pay-per-token).
 * Safety clamp: max $1000. Below $1 is not useful.
 */
export const BUDGET_USD_CAP = Math.min(
  1000,
  Math.max(1, Number(process.env.V2_BUDGET_USD) || 300),
);

const SPEND_FILES = [
  join(DATA_DIR, 'regression-guard-spend.jsonl'),
  join(DATA_DIR, 'bug-resolver-spend.jsonl'),
  join(DATA_DIR, 'v2-verify-spend.jsonl'),
];

/**
 * Return the PT date stamp for "today" (same logic as the agents use).
 * PT = UTC-7 during PDT (March 2nd Sunday – November 1st Sunday), UTC-8 otherwise.
 * For simplicity we use a fixed -7 offset (PDT covers the typical working window).
 * This matches the `date` field format in the spend ledgers.
 */
function ptDateStamp(asOfMs = Date.now()) {
  const ptOffset = -7 * 60 * 60 * 1000; // PDT = UTC-7
  const ptMs = asOfMs + ptOffset;
  const d = new Date(ptMs);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Parse spend from a single JSONL file for today's PT date.
 * Returns the sum of `usd` fields where `date === today`.
 * Silently skips missing files and malformed lines.
 */
function parseSpendFile(filePath, today) {
  if (!existsSync(filePath)) return 0;
  let sum = 0;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.date === today && typeof rec.usd === 'number') sum += rec.usd;
      } catch { /* skip malformed line */ }
    }
  } catch { /* never crash on read */ }
  return sum;
}

/**
 * Sum today's spend across all v2 pipeline spend ledgers.
 * @param {{ asOfMs?: number }} opts
 * @returns {number} total USD spent today in the v2 pipeline
 */
export function getTodaySpend({ asOfMs = Date.now() } = {}) {
  const today = ptDateStamp(asOfMs);
  return SPEND_FILES.reduce((sum, f) => sum + parseSpendFile(f, today), 0);
}

/**
 * Pre-flight + mid-pipeline budget gate.
 *
 * @param {{ estimatedNextPhase?: number, asOfMs?: number }} opts
 *   estimatedNextPhase — estimated cost of the next pipeline step (USD).
 *     If (spent + estimatedNextPhase) > cap, returns ok:false even if the
 *     cap is not yet breached. Pass 0 for a simple "am I over the cap?" check.
 *
 * @returns {{
 *   ok: boolean,
 *   spent: number,
 *   cap: number,
 *   remaining: number,
 *   abortReason?: string
 * }}
 */
export function checkV2Budget({ estimatedNextPhase = 0, asOfMs = Date.now() } = {}) {
  const spent = getTodaySpend({ asOfMs });
  const cap = BUDGET_USD_CAP;
  const remaining = Math.max(0, cap - spent);

  if (spent >= cap) {
    return {
      ok: false,
      spent,
      cap,
      remaining: 0,
      abortReason: `v2 daily budget exhausted: $${spent.toFixed(2)} spent (cap $${cap})`,
    };
  }

  if (estimatedNextPhase > 0 && spent + estimatedNextPhase > cap) {
    return {
      ok: false,
      spent,
      cap,
      remaining,
      abortReason: `v2 daily budget would be exceeded: $${spent.toFixed(2)} spent + $${estimatedNextPhase.toFixed(2)} estimated > $${cap} cap`,
    };
  }

  return { ok: true, spent, cap, remaining };
}

/**
 * Append a spend record to data/v2-verify-spend.jsonl.
 * Used by v2-verify-subset in the future (v2.1) when it starts making LLM calls.
 * Currently unused but ships with PR #9 to close the unified budget loop.
 *
 * @param {{ usd: number, phase: string, label?: string }} entry
 */
export function recordV2VerifySpend({ usd, phase, label = '' }) {
  if (typeof usd !== 'number') throw new Error('recordV2VerifySpend: usd must be a number');
  const verifySpendPath = join(DATA_DIR, 'v2-verify-spend.jsonl');
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const rec = {
    date: ptDateStamp(),
    timestamp: new Date().toISOString(),
    usd,
    phase,
    label,
    source: 'v2-verify-subset',
  };
  try {
    appendFileSync(verifySpendPath, JSON.stringify(rec) + '\n');
  } catch { /* never crash on log write */ }
}

/**
 * Return the spend file paths for test introspection.
 */
export function spendFilePaths() {
  return [...SPEND_FILES];
}
