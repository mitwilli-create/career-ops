#!/usr/bin/env node
// scripts/agents/v2-rollback.mjs
//
// v2 (2026-05-25) — manual rollback CLI for v2 fixes. PR #5 of 10.
// Spec § Q10 (rollback paths) + interview Q8 (3-second cancel window).
//
// Usage:
//   node scripts/agents/v2-rollback.mjs <commit-sha>
//   node scripts/agents/v2-rollback.mjs <commit-sha> --yes        # skip 3s window
//   node scripts/agents/v2-rollback.mjs <commit-sha> --dry-run    # plan only
//
// Behavior (Q8 — "print plan + 3s window to cancel, then execute"):
//   1. Validate <commit-sha> exists in git.
//   2. Print the revert plan: "About to revert <sha> '<subject>' on branch
//      <current> — cancelling in 3s with Ctrl+C..."
//   3. Sleep 3 seconds. SIGINT during sleep aborts the operation.
//   4. Run `git revert --no-edit <sha>`.
//   5. Push the resulting commit.
//   6. Record the rollback in data/v2-rollback-counter.jsonl with
//      trigger="manual" (Q6: manual rollbacks DON'T count toward freeze).
//
// Exit codes:
//   0 — revert + push successful
//   1 — revert/push failed
//   2 — bad args / sha not found
//   3 — cancelled (Ctrl+C during 3s window)
//   4 — v2 currently frozen (caller must wait for freeze to expire)

import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recordRollback,
  isV2Frozen,
  getActiveFreeze,
} from '../../lib/v2-thrash-counter.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

function gitRun(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function parseArgs(argv) {
  const opts = { sha: null, yes: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.sha) opts.sha = a;
    else {
      console.error(`Unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
v2-rollback — manual rollback of a v2 fix commit.

Usage:
  node scripts/agents/v2-rollback.mjs <commit-sha>
  node scripts/agents/v2-rollback.mjs <commit-sha> --yes      # skip 3s window
  node scripts/agents/v2-rollback.mjs <commit-sha> --dry-run

Behavior:
  Prints the revert plan, then waits 3 seconds (Ctrl+C cancels), then runs
  \`git revert --no-edit <sha>\` and pushes. Records the rollback in
  data/v2-rollback-counter.jsonl with trigger="manual".

Per v2 interview Q6: manual rollbacks log to the counter for audit but do
NOT contribute to the 3-in-24h freeze threshold. Only auto-reverts (from
verification-subset failures) freeze v2.

If v2 is currently frozen (by prior auto-reverts), the CLI exits with code 4
and does not run the revert — the caller must wait for the freeze to expire.

Exit codes: 0 OK / 1 revert-fail / 2 bad-args / 3 cancelled / 4 frozen
`.trim());
}

function resolveSha(sha) {
  try {
    return gitRun(`git rev-parse --verify ${sha}^{commit}`).trim();
  } catch {
    return null;
  }
}

function shaSubject(sha) {
  try {
    return gitRun(`git log -1 --pretty=format:%s ${sha}`).trim();
  } catch {
    return '(unable to read subject)';
  }
}

async function sleepCancellable(ms) {
  // Wrap sleep in a cancellable promise that resolves on SIGINT.
  return new Promise((resolveSleep) => {
    let cancelled = false;
    const onInt = () => {
      cancelled = true;
      // eslint-disable-next-line no-console
      console.log('\n[v2-rollback] cancelled (SIGINT during 3s window)');
      process.removeListener('SIGINT', onInt);
      resolveSleep({ cancelled: true });
    };
    process.on('SIGINT', onInt);
    setTimeout(() => {
      process.removeListener('SIGINT', onInt);
      resolveSleep({ cancelled });
    }, ms);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }
  if (!opts.sha) {
    console.error('v2-rollback: missing <commit-sha>. Run with --help for usage.');
    return 2;
  }

  // Frozen check (Q10 — when v2 is in 24h thrash freeze)
  if (isV2Frozen()) {
    const freeze = getActiveFreeze();
    console.error(
      `[v2-rollback] REFUSING: v2 is currently frozen until ${freeze.frozen_until}` +
      ` (3+ auto-reverts in 24h triggered the freeze). Wait for freeze to expire` +
      ` or override by directly running \`git revert\` + \`git push\`.`
    );
    return 4;
  }

  // Validate the sha exists
  const fullSha = resolveSha(opts.sha);
  if (!fullSha) {
    console.error(`[v2-rollback] sha "${opts.sha}" not found in git`);
    return 2;
  }
  const subject = shaSubject(fullSha);
  const currentBranch = gitRun('git rev-parse --abbrev-ref HEAD').trim();

  // Plan + 3s cancel window (Q8)
  // eslint-disable-next-line no-console
  console.log('');
  console.log('═══ v2-rollback plan ═══');
  console.log(`  Commit:    ${fullSha.slice(0, 12)}`);
  console.log(`  Subject:   ${subject.slice(0, 80)}`);
  console.log(`  Branch:    ${currentBranch}`);
  console.log(`  Action:    git revert --no-edit ${fullSha.slice(0, 12)} + git push`);
  console.log(`  Counter:   data/v2-rollback-counter.jsonl (trigger=manual — does NOT count toward freeze)`);
  console.log('═══════════════════════');

  if (opts.dryRun) {
    console.log('[v2-rollback] dry-run — no revert performed');
    return 0;
  }

  if (!opts.yes) {
    console.log('[v2-rollback] cancelling in 3s with Ctrl+C...');
    const r = await sleepCancellable(3000);
    if (r.cancelled) return 3;
  }

  // Execute the revert
  try {
    gitRun(`git revert --no-edit ${fullSha}`);
    // eslint-disable-next-line no-console
    console.log(`[v2-rollback] revert commit created on ${currentBranch}`);
  } catch (err) {
    console.error(`[v2-rollback] revert FAILED: ${err.message.slice(0, 240)}`);
    return 1;
  }

  // Push (best-effort — caller can push manually if this fails)
  try {
    gitRun(`git push origin ${currentBranch}`);
    // eslint-disable-next-line no-console
    console.log(`[v2-rollback] pushed to origin/${currentBranch}`);
  } catch (err) {
    console.error(`[v2-rollback] WARN: push failed (${err.message.slice(0, 120)}). Revert committed locally; push manually.`);
    // Don't return error — the revert IS recorded; push retry is the user's call
  }

  // Record in counter (trigger=manual)
  try {
    const entry = recordRollback({
      fix_sha: fullSha,
      reason: 'cli-manual',
      trigger: 'manual',
    });
    // eslint-disable-next-line no-console
    console.log(`[v2-rollback] recorded in counter (${entry.at})`);
  } catch (err) {
    console.error(`[v2-rollback] WARN: counter write failed: ${err.message}`);
  }

  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack || '');
  process.exit(1);
});
