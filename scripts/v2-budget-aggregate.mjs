#!/usr/bin/env node
/**
 * scripts/v2-budget-aggregate.mjs
 *
 * Aggregates v2-pipeline spend across the main repo + every active git
 * worktree so the V2_BUDGET_USD daily cap can be checked against the true
 * cumulative spend, not just the local working tree.
 *
 * Why this exists (closes bug-2026-05-25-046):
 *   lib/v2-budget.mjs sums spend from data/regression-guard-spend.jsonl +
 *   data/bug-resolver-spend.jsonl + data/v2-verify-spend.jsonl relative to
 *   the script's own repo root. In a worktree, that resolves to the
 *   WORKTREE's data/, not main's. Multiple worktree-isolated agent runs
 *   (4 bug-resolver experiments in 4 worktrees on 2026-05-25, total $0.48)
 *   write to 4 different spend ledgers; v2-budget.mjs running in any one of
 *   them sees only that one's slice. The actual cumulative spend isn't
 *   visible to any single check — the cap can be silently exceeded.
 *
 * What this script does:
 *   1. Runs `git worktree list --porcelain` to enumerate every worktree.
 *   2. For each worktree path, reads {regression-guard,bug-resolver,
 *      v2-verify}-spend.jsonl from that worktree's data/ dir.
 *   3. Aggregates today's spend (PT date) across all of them.
 *   4. Prints a per-worktree breakdown + the union sum.
 *   5. Exits 0 if union sum < cap; exits 1 if at-or-over.
 *
 * Usage:
 *   node scripts/v2-budget-aggregate.mjs               # default report
 *   node scripts/v2-budget-aggregate.mjs --json        # JSON output for tooling
 *   node scripts/v2-budget-aggregate.mjs --date=YYYY-MM-DD   # different day
 *   V2_BUDGET_USD=300 node scripts/v2-budget-aggregate.mjs   # cap override
 *
 * NOT a runtime replacement for lib/v2-budget.mjs — that module is hot-path
 * inside the agents and would need invasive changes to consult this. This
 * is an operator tool for "what's my real spend right now?" + can be wired
 * into a launchd scheduled check or a heartbeat panel later.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const DATE_ARG = (args.find(a => a.startsWith('--date=')) || '').slice(7);

const BUDGET_CAP = Math.min(
  1000,
  Math.max(1, Number(process.env.V2_BUDGET_USD) || 300),
);

// PT date stamp same shape as the agents use.
function ptDateStamp(d = new Date()) {
  const opts = { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

const TODAY = DATE_ARG || ptDateStamp();

const SPEND_FILES = [
  'regression-guard-spend.jsonl',
  'bug-resolver-spend.jsonl',
  'v2-verify-spend.jsonl',
];

function enumerateWorktrees() {
  let out;
  try {
    out = execSync('git worktree list --porcelain', { encoding: 'utf-8' });
  } catch (e) {
    return [];
  }
  const worktrees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) worktrees.push(cur);
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch refs/heads/'.length).trim();
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim().slice(0, 9);
    } else if (line === 'bare') {
      if (cur) cur.bare = true;
    }
  }
  if (cur) worktrees.push(cur);
  return worktrees;
}

function readSpendForDate(worktreePath, dateStr) {
  let total = 0;
  for (const f of SPEND_FILES) {
    const p = join(worktreePath, 'data', f);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln);
        if (o.date === dateStr && typeof o.usd === 'number') total += o.usd;
      } catch { /* skip malformed */ }
    }
  }
  return total;
}

function main() {
  const worktrees = enumerateWorktrees();
  if (worktrees.length === 0) {
    console.error('[v2-budget-aggregate] no worktrees found — is this a git repo?');
    process.exit(2);
  }

  const breakdown = [];
  let unionTotal = 0;
  for (const wt of worktrees) {
    if (wt.bare) continue;
    const spent = readSpendForDate(wt.path, TODAY);
    breakdown.push({ ...wt, spent_usd: Number(spent.toFixed(4)) });
    unionTotal += spent;
  }
  unionTotal = Number(unionTotal.toFixed(4));

  const remaining = Number((BUDGET_CAP - unionTotal).toFixed(4));
  const overcap = unionTotal >= BUDGET_CAP;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      date: TODAY,
      budget_cap_usd: BUDGET_CAP,
      union_spent_usd: unionTotal,
      remaining_usd: remaining,
      overcap,
      worktrees: breakdown,
    }, null, 2));
  } else {
    console.log(`v2-budget aggregate · ${TODAY}`);
    console.log(`Cap: $${BUDGET_CAP.toFixed(2)} · Spent: $${unionTotal.toFixed(4)} · Remaining: $${remaining.toFixed(4)}`);
    if (overcap) console.log(`⚠ OVERCAP`);
    console.log('');
    console.log('Per-worktree breakdown:');
    for (const wt of breakdown) {
      const tag = wt.spent_usd > 0 ? `$${wt.spent_usd.toFixed(4)}` : '$0.0000';
      console.log(`  ${tag.padStart(10)} · ${wt.branch || '(detached)'} · ${wt.path}`);
    }
  }

  process.exit(overcap ? 1 : 0);
}

main();
