/**
 * scripts/agents/regression-guard/lib/config.mjs
 *
 * Central config + module-level constants for the regression-guard agent.
 *
 * All paths derived from REPO_ROOT + HOME. All env-driven knobs documented
 * in .env.example with rationale. Mitchell's locked decision overrides are
 * called out inline.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { parseSilentPeriods, DEFAULT_SILENT_PERIODS_CSV } from './silent-period.mjs';

// ─── Paths ──────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = scripts/agents/regression-guard/lib  → REPO_ROOT 4 levels up
export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const HOME = homedir();
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude/projects');
export const BRAIN_DIR = join(HOME, '.claude/knowledge/brain');
export const COUNCIL_OS_DIR = join(HOME, 'Documents/council-os');
export const SECOND_BRAIN_DIR = join(REPO_ROOT, 'data/second-brain-extracted/second brain');

export const PROJECT_ENCODED = '-Users-mitchellwilliams-Documents-career-ops';
export const PROJECT_TRANSCRIPTS_DIR = join(CLAUDE_PROJECTS_DIR, PROJECT_ENCODED);
export const PROJECT_MEMORY_DIR = join(PROJECT_TRANSCRIPTS_DIR, 'memory');

// ─── PT date helpers ────────────────────────────────────────────────────────
export function ptDateStamp(d = new Date()) {
  const ms = d.getTime() - 7 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}
export function ptIso(d = new Date()) {
  const ms = d.getTime() - 7 * 3600 * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}
export const TODAY = ptDateStamp();

// ─── Log paths ──────────────────────────────────────────────────────────────
export const LOG_DIR = join(REPO_ROOT, 'data/logs');
export const LOG_PATH = join(LOG_DIR, `regression-guard-${TODAY}.log`);

// ─── Env getters with explicit defaults ─────────────────────────────────────
export function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(true|1|yes|on)$/i.test(v);
}
export function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
export function envStr(name, dflt) {
  const v = process.env[name];
  return v == null || v === '' ? dflt : v;
}

// ─── Mitchell's locked decisions (see agent JSDoc + AGENTS.md env-var table) ─
export const ENABLED                  = envBool('REGRESSION_GUARD_ENABLED', true);
export const AUTO_ACTION              = envBool('REGRESSION_GUARD_AUTO_ACTION', false);
// Recalibrated 2026-05-26: deterministic scans cost $0; deep forensics ~$0.50-2.
// $10 allows 5+ deep runs before firing. Was $20 (never approached).
export const DAILY_USD_CAP            = envNum('REGRESSION_GUARD_DAILY_USD', 10);
export const PER_CALL_WARN_USD        = envNum('REGRESSION_GUARD_PER_CALL_WARN_USD', 5);
export const CANARY_FAIL_SHUT         = envBool('REGRESSION_GUARD_CANARY_FAIL_SHUT', true);
export const BASELINE_EXPIRY_DAYS     = envNum('REGRESSION_GUARD_BASELINE_EXPIRY_DAYS', 30);
export const SELF_THROTTLE_THRESHOLD  = envNum('REGRESSION_GUARD_SELF_THROTTLE_THRESHOLD', 8);
export const TRANSCRIPT_BASELINE_ON   = envBool('REGRESSION_GUARD_TRANSCRIPT_BASELINE_ENABLED', false);
export const CROSS_SESSION_CADENCE    = envStr('REGRESSION_GUARD_CROSS_SESSION_CADENCE', 'daily');
export const GEMINI_TIER              = envStr('REGRESSION_GUARD_GEMINI_TIER', 'preview');
// Recalibrated 2026-05-26 alongside DAILY_USD_CAP. Was $20.
export const DEEP_BUDGET_USD          = envNum('REGRESSION_GUARD_DEEP_BUDGET_USD', 10);
export const SILENT_PERIOD_BY_TYPE    = parseSilentPeriods(
  envStr('REGRESSION_GUARD_SILENT_PERIOD_DAYS_BY_TYPE', DEFAULT_SILENT_PERIODS_CSV)
);

// ─── Storage paths ──────────────────────────────────────────────────────────
export const SPEND_LEDGER_PATH = join(DATA_DIR, 'regression-guard-spend.jsonl');
export const STATE_PATH = join(DATA_DIR, 'regression-guard-state.json');
export const BASELINE_DIR = join(DATA_DIR, 'regression-baselines');
export const BASELINE_PROVENANCE_PATH = join(BASELINE_DIR, '_provenance.jsonl');

// ─── v1.1 multi-session deep budget ────────────────────────────────────────
export const MAX_BUDGET_USD = 200;
