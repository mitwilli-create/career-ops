/**
 * lib/github-cleaner/budget.mjs — cross-cutting budget gate for github-cleaner.
 *
 * Runs BEFORE each costly phase. Reads:
 *   - GITHUB_CLEANER_RUN_CAP_USD (default 50)
 *   - GITHUB_CLEANER_MONTHLY_CAP_USD (default 250)
 *
 * Tracks running spend in data/github-cleaner/spend-ledger.json. The ledger
 * is a rolling 30-day record of every council/Sonnet/Opus/detector call
 * with its $ amount + phase + run-id.
 *
 * If a phase would push the run-total over the per-run cap → refuse + log.
 * If at start the rolling 30d sum exceeds the monthly cap → refuse + write
 * data/github-cleaner-budget-blocked.md so Mitchell can override.
 *
 * See: data/github-cleaner-design-2026-05-22.md § Budget model.
 *
 * Status: SKELETON — function signatures locked, ledger persistence pending.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const LEDGER_PATH = join(ROOT, 'data', 'github-cleaner', 'spend-ledger.json');
const BLOCKED_PATH = join(ROOT, 'data', 'github-cleaner-budget-blocked.md');

// Defaults bumped 2026-05-22 to accommodate per-model brief Phase 2 research
// (15 verticals × 7 sources, dealbreaker adjudication). See .env.example +
// data/github-cleaner-design-2026-05-22.md § Budget model for sizing.
const DEFAULT_RUN_CAP_USD = Number(process.env.GITHUB_CLEANER_RUN_CAP_USD ?? 75);
const DEFAULT_MONTHLY_CAP_USD = Number(process.env.GITHUB_CLEANER_MONTHLY_CAP_USD ?? 400);

const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Budget model';

/**
 * Read the ledger; auto-prune entries older than the rolling window.
 */
export function readLedger() {
  if (!existsSync(LEDGER_PATH)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf-8'));
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    const entries = (raw.entries || []).filter(e => new Date(e.at).getTime() >= cutoff);
    return { entries };
  } catch { return { entries: [] }; }
}

/**
 * Sum spend in the rolling window.
 */
export function monthlySpendSoFar() {
  const { entries } = readLedger();
  return entries.reduce((sum, e) => sum + (Number(e.cost_usd) || 0), 0);
}

/**
 * Sum spend for a single run-id.
 */
export function runSpendSoFar(runId) {
  const { entries } = readLedger();
  return entries
    .filter(e => e.run_id === runId)
    .reduce((sum, e) => sum + (Number(e.cost_usd) || 0), 0);
}

/**
 * Pre-phase check. Returns { ok: true } or { ok: false, reason, blockedPath }.
 * Call before each phase that spends money.
 */
export function preCheck({ runId, phase, estimatedCostUsd, runCapUsd = DEFAULT_RUN_CAP_USD, monthlyCapUsd = DEFAULT_MONTHLY_CAP_USD } = {}) {
  const monthly = monthlySpendSoFar();
  if (monthly + estimatedCostUsd > monthlyCapUsd) {
    writeBlockedReport({ runId, phase, monthly, estimatedCostUsd, monthlyCapUsd });
    return { ok: false, reason: 'monthly_cap_exceeded', monthly, monthlyCapUsd, blockedPath: BLOCKED_PATH };
  }
  const runSum = runSpendSoFar(runId);
  if (runSum + estimatedCostUsd > runCapUsd) {
    return { ok: false, reason: 'run_cap_exceeded', runSum, runCapUsd };
  }
  return { ok: true, monthly, runSum };
}

/**
 * Append a spend entry to the ledger. Called after each costly call returns.
 */
export function recordSpend({ runId, phase, model, cost_usd, kind = 'llm' }) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const cur = readLedger();
  cur.entries.push({
    at: new Date().toISOString(), run_id: runId, phase, model, cost_usd: Number(cost_usd) || 0, kind,
  });
  writeFileSync(LEDGER_PATH, JSON.stringify(cur, null, 2), 'utf-8');
}

/**
 * Write the budget-blocked report. Surfaced to Mitchell on the dashboard
 * so he can review and either wait, or set GITHUB_CLEANER_MONTHLY_CAP_USD
 * higher and re-run.
 */
function writeBlockedReport({ runId, phase, monthly, estimatedCostUsd, monthlyCapUsd }) {
  const body = [
    `# github-cleaner — monthly budget blocked`,
    ``,
    `**Run:** ${runId}`,
    `**Phase that triggered the block:** ${phase}`,
    `**30-day rolling spend so far:** $${monthly.toFixed(2)}`,
    `**Estimated cost of next phase:** $${estimatedCostUsd.toFixed(2)}`,
    `**Monthly cap (\`GITHUB_CLEANER_MONTHLY_CAP_USD\`):** $${monthlyCapUsd.toFixed(2)}`,
    ``,
    `## To unblock`,
    `1. Wait until the rolling window pushes spend below the cap, OR`,
    `2. Raise the cap in \`.env\` (\`GITHUB_CLEANER_MONTHLY_CAP_USD\`) and re-run.`,
    ``,
    `See: ${DESIGN_DOC_REF}`,
  ].join('\n');
  mkdirSync(dirname(BLOCKED_PATH), { recursive: true });
  writeFileSync(BLOCKED_PATH, body, 'utf-8');
}

export { LEDGER_PATH, BLOCKED_PATH, DEFAULT_RUN_CAP_USD, DEFAULT_MONTHLY_CAP_USD };
