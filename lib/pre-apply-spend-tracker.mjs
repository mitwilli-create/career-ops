// Pre-apply spend tracker — Step 7 cost-governance per dealbreaker spec.
//
// Records per-call cost estimates for /api/pre-apply-check into a
// daily-bucketed JSON file at data/pre-apply-spend-<YYYY-MM-DD>.json.
// Pre-apply has its OWN spend bucket separate from polish-loop (which has
// its own cost-confirmation modal).
//
// Threshold: amber-warn at ≥ $2/day cumulative (env-configurable via
// PRE_APPLY_DAILY_WARN_USD=2). NO hard daily cap — see dealbreaker
// Impasse #2 break + Mitchell's locked NO-hard-cap decision (legitimate
// 3-4 day bursts shouldn't block).
//
// Cost arithmetic (per dealbreaker verified-finding 17 + Anthropic pricing
// docs):
//   HM-match Sonnet 4.6 cached prefix hot: ~$0.003-0.006/call
//   HM-match Sonnet 4.6 cold (first call): ~$0.015-0.045/call
//   ATS check (pure rule):                  $0
//   Voice rule-only:                        $0
//   Voice deep (Pangram v3):                $0.04-0.16/call
//
// We conservatively over-estimate (assume cold for HM-match every time)
// rather than under-estimate — the warn-fatigue cost is lower than the
// silent-overrun cost. Real cost ≤ estimated cost.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_WARN_USD = 2.0;

function _warnThreshold() {
  const v = parseFloat(process.env.PRE_APPLY_DAILY_WARN_USD || String(DEFAULT_WARN_USD));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WARN_USD;
}

function _todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function _spendPath(rootDir, day) {
  return join(rootDir, 'data', 'pre-apply-spend-' + day + '.json');
}

/**
 * Append a spend record to today's bucket. Total recomputed from sum of all calls.
 * @param {string} rootDir
 * @param {number} usd  - estimated cost of THIS call (≥ 0)
 * @param {object} [meta] - optional { slug, deep, status, ... } for the audit trail
 * @returns {{ day, total_usd, call_count, warn, threshold }} - current state after append
 */
export function recordSpend(rootDir, usd, meta = {}) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  const day = _todayISO();
  const dir = join(rootDir, 'data');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* permission or race — non-fatal, spend is informational */ }

  const path = _spendPath(rootDir, day);
  let data = { day, calls: [], total_usd: 0 };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (parsed && parsed.day === day && Array.isArray(parsed.calls)) {
        data = parsed;
      }
    } catch { /* malformed → start fresh */ }
  }
  data.calls.push({
    ts: new Date().toISOString(),
    usd: Math.round(usd * 10000) / 10000,
    ...meta,
  });
  data.total_usd = data.calls.reduce((acc, c) => acc + (typeof c.usd === 'number' ? c.usd : 0), 0);
  data.total_usd = Math.round(data.total_usd * 10000) / 10000;
  try {
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch { /* disk full / read-only → return memory state regardless */ }

  return {
    day: data.day,
    total_usd: data.total_usd,
    call_count: data.calls.length,
    warn: data.total_usd >= _warnThreshold(),
    threshold: _warnThreshold(),
  };
}

/**
 * Read today's (or specified day's) spend.
 * @param {string} rootDir
 * @param {string} [dayOverride] - YYYY-MM-DD; defaults to today
 * @returns {{ day, total_usd, call_count, warn, threshold }}
 */
export function getDailySpend(rootDir, dayOverride = null) {
  const day = dayOverride || _todayISO();
  const path = _spendPath(rootDir, day);
  const threshold = _warnThreshold();
  if (!existsSync(path)) {
    return { day, total_usd: 0, call_count: 0, warn: false, threshold };
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const total = typeof data.total_usd === 'number' ? data.total_usd : 0;
    return {
      day,
      total_usd: total,
      call_count: Array.isArray(data.calls) ? data.calls.length : 0,
      warn: total >= threshold,
      threshold,
    };
  } catch {
    return { day, total_usd: 0, call_count: 0, warn: false, threshold };
  }
}

/**
 * Estimate the cost of a single /api/pre-apply-check call based on what
 * sub-checks were actually executed. Conservative over-estimate.
 * @param {object} orchestratorResult - typed contract from composePreApplyCheck
 * @returns {number} estimated USD
 */
export function estimatePreApplyCost(orchestratorResult) {
  if (!orchestratorResult || !orchestratorResult.checks) return 0;
  const { hm, ats, voice } = orchestratorResult.checks;
  let usd = 0;
  // HM-match: only charges if the check actually ran (not unavailable/error).
  // Assume cold price ($0.045) — over-estimate is safer than under-estimate.
  if (hm && hm.status !== 'unavailable' && hm.status !== 'error') {
    usd += 0.045;
  }
  // ATS + voice rule-only: free. Voice deep adds Pangram (~$0.10 mid-range).
  if (voice && voice.deep_used === true && voice.status !== 'unavailable' && voice.status !== 'error') {
    usd += 0.10;
  }
  return Math.round(usd * 10000) / 10000;
}

/**
 * Last 7 days of spend (for trend display). Each day = today's shape.
 */
export function getWeeklySpend(rootDir) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dayISO = d.toISOString().slice(0, 10);
    days.push(getDailySpend(rootDir, dayISO));
  }
  return days.reverse(); // oldest first
}

export const _internal = Object.freeze({
  DEFAULT_WARN_USD,
  _warnThreshold,
  _todayISO,
  _spendPath,
});
