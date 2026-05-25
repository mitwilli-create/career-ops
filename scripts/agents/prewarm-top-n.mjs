#!/usr/bin/env node
/**
 * scripts/agents/prewarm-top-n.mjs — Scheduled pre-warm for top-N apply-now drawer caches
 *
 * PR-06 of the Apply-Now Dashboard UX Overhaul (2026-05-25).
 *
 * Keeps apply-now drawer caches fresh so opening a drawer is instant
 * (<100ms from disk) rather than 2-5s LLM call. Targets 3 slots per row:
 *   - hm-chance          → data/hm-chance/<padded-slug>.json
 *   - interview-likelihood → data/interview-likelihood/<padded-slug>.json
 *   - team-health        → data/team-health/<company-slug>.json
 *
 * Tiered schedule (auto-detected from weekday + CLI flag):
 *   Daily (Mon-Sat):  top-15 rows + $50 hard cap
 *   Weekly (Sunday):  all active rows (≤35) + $105 hard cap
 *
 * CLI:
 *   node scripts/agents/prewarm-top-n.mjs --top 15
 *   node scripts/agents/prewarm-top-n.mjs --top 15 --dry-run
 *   node scripts/agents/prewarm-top-n.mjs --weekly
 *   node scripts/agents/prewarm-top-n.mjs --top 5 --dry-run   # smoke test
 *
 * Cost caps (hard, best-effort pre-call projection + post-call enforcement):
 *   Daily:  $50 / cycle  (PREWARM_DAILY_CAP_USD env override)
 *   Weekly: $105 / cycle (PREWARM_WEEKLY_CAP_USD env override)
 *
 * Cross-fork-leak guard: NEVER log hm-intel raw content — hash + summary only.
 * Per AGENTS.md § regression-guard-cross-fork-leak.
 *
 * Hang-prevention: every slot call uses spawnSync with explicit timeout.
 * NDJSON heartbeat to stderr every row boundary.
 * Per AGENTS.md § missing-timeout-on-long-running-operation.
 *
 * Status written to data/prewarm-status/<YYYY-MM-DD>.json after each run.
 * The dashboard drawer footer reads this file for the "Pre-warm: X/Y ready" line.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DAILY_CAP_USD = Number(process.env.PREWARM_DAILY_CAP_USD) || 50;
const WEEKLY_CAP_USD = Number(process.env.PREWARM_WEEKLY_CAP_USD) || 105;

// Rough per-slot cost estimates for dry-run projection only (not enforcement).
// Real costs from actual agent runs are summed post-call.
const ESTIMATED_COST_PER_SLOT = {
  'hm-chance': 1.00,
  'interview-likelihood': 1.50,
  'team-health': 0.05,
};

const STATUS_DIR = join(ROOT, 'data', 'prewarm-status');
const QUEUE_PATH = join(ROOT, 'data', 'apply-now-queue.json');
const NODE_BIN = process.execPath;
const HM_CHANCE_SCRIPT = join(ROOT, 'scripts', 'agents', 'hm-chance.mjs');
const IL_SCRIPT = join(ROOT, 'scripts', 'agents', 'interview-likelihood.mjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch (_) {}
}

function readJsonSafe(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function padNum(n) {
  const s = String(n);
  if (s.length >= 3) return s;
  return s.padStart(3, '0');
}

/**
 * Build the padded slug used by hm-chance + interview-likelihood agents.
 * Format: <padded-num>-<company-slug>-<role-slug>
 * Matches the pattern in scripts/agents/hm-chance.mjs and intel-refresh.mjs.
 */
function buildRoleSlug(row) {
  return `${padNum(row.num)}-${slugify(row.company)}-${slugify(row.role)}`;
}

/**
 * Build the company slug used by team-health.
 * Format: <company-slug>  (no num prefix — shared across roles at same company)
 */
function buildCompanySlug(row) {
  return slugify(row.company);
}

/**
 * Cache freshness check: reads mtime from the file (not generated_at field)
 * for robustness across all 3 slot types.
 */
function isCacheFresh(filePath, ttlMs = CACHE_TTL_MS) {
  if (!existsSync(filePath)) return false;
  try {
    const age = Date.now() - statSync(filePath).mtimeMs;
    return age < ttlMs;
  } catch { return false; }
}

/**
 * Cache age in whole days (for skip-reason messages).
 */
function cacheAgeDays(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const ageMs = Date.now() - statSync(filePath).mtimeMs;
    return Math.floor(ageMs / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

/**
 * SHA-256 hash of a file path for cross-fork-leak-safe logging.
 */
function hashPath(p) {
  return 'sha256:' + createHash('sha256').update(p).digest('hex').slice(0, 12);
}

/**
 * Load active rows from apply-now-queue.json, sorted by composite desc.
 */
function loadActiveRows() {
  const queue = readJsonSafe(QUEUE_PATH);
  if (!queue || !Array.isArray(queue.ranked)) {
    throw new Error('apply-now-queue.json missing or malformed');
  }
  return queue.ranked
    .filter(r => !r._dropped && !r.too_late_flag)
    .sort((a, b) => (b.composite || 0) - (a.composite || 0));
}

/**
 * Detect if today is Sunday (day 0 in JS).
 */
function isSunday() {
  return new Date().getDay() === 0;
}

// ─── Slot implementations ─────────────────────────────────────────────────────

/**
 * Warm the hm-chance slot for one row.
 * Shells out to hm-chance.mjs --row <num> to match the canonical agent.
 */
async function warmHmChance(row, opts = {}) {
  const slug = buildRoleSlug(row);
  const cachePath = join(ROOT, 'data', 'hm-chance', `${slug}.json`);
  if (!opts.force && isCacheFresh(cachePath)) {
    return { ok: true, cached: true, cache_age_days: cacheAgeDays(cachePath), cost_usd: 0, cache_path_hash: hashPath(cachePath) };
  }
  if (!existsSync(HM_CHANCE_SCRIPT)) {
    return { ok: false, error: 'hm-chance script not found', cost_usd: 0 };
  }
  emit({ slot: 'hm-chance', row: row.num, phase: 'starting', slug_hash: hashPath(slug) });
  const result = spawnSync(NODE_BIN, [HM_CHANCE_SCRIPT, '--row', String(row.num)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
    timeout: 600_000, // 10 min hard timeout
  });
  const ok = result.status === 0;
  const costUsd = ok ? estimateCostFromCache(cachePath) : 0;
  emit({ slot: 'hm-chance', row: row.num, phase: 'done', ok, exit_code: result.status });
  return { ok, exit_code: result.status, cost_usd: costUsd, cache_path_hash: hashPath(cachePath) };
}

/**
 * Warm the interview-likelihood slot for one row.
 */
async function warmInterviewLikelihood(row, opts = {}) {
  const slug = buildRoleSlug(row);
  const cachePath = join(ROOT, 'data', 'interview-likelihood', `${slug}.json`);
  if (!opts.force && isCacheFresh(cachePath)) {
    return { ok: true, cached: true, cache_age_days: cacheAgeDays(cachePath), cost_usd: 0, cache_path_hash: hashPath(cachePath) };
  }
  if (!existsSync(IL_SCRIPT)) {
    return { ok: false, error: 'interview-likelihood script not found', cost_usd: 0 };
  }
  emit({ slot: 'interview-likelihood', row: row.num, phase: 'starting', slug_hash: hashPath(slug) });
  const result = spawnSync(NODE_BIN, [IL_SCRIPT, '--row', String(row.num)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
    timeout: 600_000,
  });
  const ok = result.status === 0;
  const costUsd = ok ? estimateCostFromCache(cachePath) : 0;
  emit({ slot: 'interview-likelihood', row: row.num, phase: 'done', ok, exit_code: result.status });
  return { ok, exit_code: result.status, cost_usd: costUsd, cache_path_hash: hashPath(cachePath) };
}

/**
 * Warm the team-health slot for one row (company-level cache, not role-level).
 */
async function warmTeamHealth(row, opts = {}) {
  const companySlug = buildCompanySlug(row);
  const cachePath = join(ROOT, 'data', 'team-health', `${companySlug}.json`);
  if (!opts.force && isCacheFresh(cachePath)) {
    return { ok: true, cached: true, cache_age_days: cacheAgeDays(cachePath), cost_usd: 0 };
  }
  emit({ slot: 'team-health', row: row.num, phase: 'starting', company: companySlug });
  try {
    const { synthesizeTeamHealth } = await import('../../lib/team-health-synthesis.mjs');
    const result = await synthesizeTeamHealth({
      slug: companySlug,
      opts: {
        companyName: row.company,
        roleName: row.role,
        rowId: String(row.num),
        force: opts.force,
      },
    });
    const ok = result.status === 'SYNTHESIZED' || result.status === 'CACHED';
    const costUsd = typeof result.cost_usd === 'number' ? result.cost_usd
      : (typeof result.cost_usd_estimate === 'number' ? result.cost_usd_estimate : 0);
    emit({ slot: 'team-health', row: row.num, phase: 'done', ok, status: result.status, cost_usd: costUsd });
    return { ok, status: result.status, cost_usd: costUsd };
  } catch (err) {
    emit({ slot: 'team-health', row: row.num, phase: 'error', error: err.message });
    return { ok: false, error: err.message, cost_usd: 0 };
  }
}

/**
 * Read cost_usd from a freshly-written cache file.
 * Returns 0 if file missing / no cost field.
 */
function estimateCostFromCache(cachePath) {
  const j = readJsonSafe(cachePath);
  return (j && typeof j.cost_usd === 'number') ? j.cost_usd : 0;
}

// ─── Main run loop ────────────────────────────────────────────────────────────

async function run(opts = {}) {
  const { dryRun = false, nTarget = 15, weekly = false, force = false } = opts;

  // Kill switch
  if (process.env.PREWARM_ENABLED === 'false') {
    console.log('[prewarm] PREWARM_ENABLED=false — exiting');
    process.exit(0);
  }

  // Determine mode: weekly wins if flag set OR (daily nTarget=15 AND Sunday)
  const isWeekly = weekly || (nTarget === 15 && isSunday());
  const mode = isWeekly ? 'weekly' : 'daily';
  const cap = isWeekly ? WEEKLY_CAP_USD : DAILY_CAP_USD;
  const n = isWeekly ? 35 : nTarget;

  emit({ phase: 'run-start', mode, n_target: n, cap_usd: cap, dry_run: dryRun });

  // Load and slice rows
  const allActive = loadActiveRows();
  const targetRows = allActive.slice(0, n);

  emit({ phase: 'rows-loaded', active_total: allActive.length, n_target: targetRows.length });

  if (dryRun) {
    return runDryRun(targetRows, mode, cap, n);
  }

  // ─── Live run ───────────────────────────────────────────────────────────────
  mkdirSync(STATUS_DIR, { recursive: true });

  let cumulativeCostUsd = 0;
  let nProcessed = 0;
  let nEnriched = 0;
  let nSkipped = 0;
  let nFailed = 0;
  const skippedRows = [];
  const failedRows = [];
  const deferrals = [];

  const SLOTS = ['hm-chance', 'interview-likelihood', 'team-health'];

  for (const row of targetRows) {
    emit({ phase: 'row-start', num: row.num, company: row.company, composite: row.composite });
    nProcessed++;

    let rowCost = 0;
    let rowHadWork = false;
    let rowFailed = false;

    for (const slot of SLOTS) {
      // Pre-call budget projection — project remaining cost for this slot
      const remaining = cap - cumulativeCostUsd;
      const estSlotCost = ESTIMATED_COST_PER_SLOT[slot] || 1.0;
      if (remaining < estSlotCost && remaining < 0.5) {
        // Not enough budget for even a minimal slot call
        const deferMsg = `budget cap $${cap} nearly reached ($${cumulativeCostUsd.toFixed(2)} used)`;
        deferrals.push({ slug: buildRoleSlug(row), slot, reason: deferMsg });
        emit({ phase: 'budget-cap-near', slot, row: row.num, cumulative_usd: cumulativeCostUsd, cap_usd: cap });
        continue;
      }

      let result;
      try {
        if (slot === 'hm-chance') result = await warmHmChance(row, { force });
        else if (slot === 'interview-likelihood') result = await warmInterviewLikelihood(row, { force });
        else if (slot === 'team-health') result = await warmTeamHealth(row, { force });
        else result = { ok: false, error: `unknown slot ${slot}`, cost_usd: 0 };
      } catch (err) {
        result = { ok: false, error: err.message, cost_usd: 0 };
      }

      const slotCost = typeof result.cost_usd === 'number' ? result.cost_usd : 0;
      rowCost += slotCost;
      cumulativeCostUsd += slotCost;

      if (result.cached) {
        nSkipped++;
        skippedRows.push({
          slug: buildRoleSlug(row),
          slot,
          reason: `${slot} cache fresh (${result.cache_age_days ?? '?'}d old)`,
        });
      } else if (result.ok) {
        nEnriched++;
        rowHadWork = true;
      } else if (result.error) {
        nFailed++;
        rowFailed = true;
        failedRows.push({
          slug: buildRoleSlug(row),
          slot,
          // tone-safe: describe what happened, not what's broken
          reason: `${slot} cache could not be refreshed — will retry next cycle`,
        });
        emit({ phase: 'slot-error', slot, row: row.num, error: result.error });
      }

      // Post-call hard cap check
      if (cumulativeCostUsd >= cap) {
        const capMsg = `budget cap $${cap} reached after $${cumulativeCostUsd.toFixed(2)} spent`;
        emit({ phase: 'budget-cap-hit', cumulative_usd: cumulativeCostUsd, cap_usd: cap });
        // Defer all remaining rows + slots
        for (const remainingRow of targetRows.slice(nProcessed)) {
          for (const s of SLOTS) {
            deferrals.push({ slug: buildRoleSlug(remainingRow), slot: s, reason: capMsg });
          }
        }
        // Exit inner loop + outer loop
        goto_done = true;
        break;
      }
    }

    if (goto_done) break; // eslint-disable-line no-use-before-define
  }

  var goto_done = false; // hoisted flag — set inside loop on cap hit

  // ─── Write status file ───────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const statusPath = join(STATUS_DIR, `${today}.json`);
  const status = {
    run_at: new Date().toISOString(),
    mode,
    n_target: n,
    n_processed: nProcessed,
    enriched: nEnriched,
    skipped: nSkipped,
    failed: nFailed,
    skipped_rows: skippedRows,
    failed_rows: failedRows,
    cost_usd: Number(cumulativeCostUsd.toFixed(4)),
    cap_usd: cap,
    deferrals,
  };

  writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf-8');
  emit({ phase: 'run-done', ...status });

  console.log(`[prewarm] ${mode} run complete: ${nEnriched} enriched, ${nSkipped} skipped, ${nFailed} failed, $${cumulativeCostUsd.toFixed(2)} spent`);
  process.exit(nFailed > 0 ? 1 : 0);
}

// ─── Dry-run mode ─────────────────────────────────────────────────────────────

function runDryRun(targetRows, mode, cap, n) {
  const today = new Date().toISOString().slice(0, 10);
  const SLOTS = ['hm-chance', 'interview-likelihood', 'team-health'];

  console.log(`\n[prewarm] DRY RUN — ${mode} mode, top-${n} rows, cap $${cap}`);
  console.log(`[prewarm] Today: ${today}\n`);

  let totalEstCost = 0;
  let nWouldEnrich = 0;
  let nWouldSkip = 0;

  const plan = [];

  for (const row of targetRows) {
    const roleSlug = buildRoleSlug(row);
    const companySlug = buildCompanySlug(row);
    const rowPlan = {
      num: row.num,
      company: row.company,
      role: row.role.slice(0, 50),
      composite: row.composite,
      slots: {},
    };

    for (const slot of SLOTS) {
      let cachePath;
      if (slot === 'hm-chance') cachePath = join(ROOT, 'data', 'hm-chance', `${roleSlug}.json`);
      else if (slot === 'interview-likelihood') cachePath = join(ROOT, 'data', 'interview-likelihood', `${roleSlug}.json`);
      else cachePath = join(ROOT, 'data', 'team-health', `${companySlug}.json`);

      const fresh = isCacheFresh(cachePath);
      const ageDays = cacheAgeDays(cachePath);
      const estCost = fresh ? 0 : (ESTIMATED_COST_PER_SLOT[slot] || 1.0);
      totalEstCost += estCost;

      if (fresh) {
        nWouldSkip++;
        rowPlan.slots[slot] = { action: 'skip', reason: `cache fresh (${ageDays}d old)`, est_cost: 0 };
      } else {
        nWouldEnrich++;
        rowPlan.slots[slot] = { action: 'warm', reason: ageDays === null ? 'no cache' : `cache stale (${ageDays}d)`, est_cost: estCost };
      }
    }

    plan.push(rowPlan);
  }

  // Print plan
  for (const r of plan) {
    console.log(`  #${r.num} ${r.company} / ${r.role} (composite: ${r.composite})`);
    for (const [slot, s] of Object.entries(r.slots)) {
      const tag = s.action === 'skip' ? '  ✓ skip' : '  → warm';
      console.log(`      ${tag}  [${slot}]  ${s.reason}  (est $${s.est_cost.toFixed(2)})`);
    }
  }

  console.log('');
  console.log(`[prewarm] Summary:`);
  console.log(`  Rows targeted:      ${targetRows.length}`);
  console.log(`  Slots to warm:      ${nWouldEnrich}`);
  console.log(`  Slots to skip:      ${nWouldSkip} (cache fresh)`);
  console.log(`  Estimated cost:     $${totalEstCost.toFixed(2)}`);
  console.log(`  Budget cap:         $${cap.toFixed(2)}`);
  console.log(`  Within budget:      ${totalEstCost <= cap ? 'YES' : 'NO — would stop early'}`);
  console.log('');
  console.log('[prewarm] DRY RUN complete — no LLM calls made');
  process.exit(0);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[k] = next;
        i += 1;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const dryRun = args['dry-run'] === true || args['dry-run'] === '1' || args['dry-run'] === 'true';
const weekly = args.weekly === true;
const force = args.force === true;
let nTarget = 15;
if (args.top) {
  const parsed = parseInt(String(args.top), 10);
  if (!isNaN(parsed) && parsed > 0) nTarget = parsed;
}

run({ dryRun, nTarget, weekly, force }).catch(err => {
  emit({ phase: 'fatal-error', error: err.message });
  console.error('[prewarm] Fatal error:', err.message);
  process.exit(1);
});
