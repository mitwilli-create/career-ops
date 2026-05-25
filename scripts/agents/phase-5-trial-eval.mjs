#!/usr/bin/env node
// scripts/agents/phase-5-trial-eval.mjs
//
// Phase 5 ledger-summary-injection trial evaluation.
//
// The Phase 5 hook (.claude/hooks/ledger-summary-inject.mjs) was shipped in
// PR #211 as a 4-week trial. This script evaluates whether the hook is
// empirically improving closure-prompt completion by comparing ledger state
// at trial start (2026-05-25) vs current state.
//
// Output: data/phase-5-trial-eval-<DATE>.md
//
// Scheduled to fire on 2026-06-22 via launchd plist
// (com.mitchell.career-ops.phase-5-trial-eval) AND via /schedule remote
// agent (belt-and-suspenders). Manual runs allowed any time.
//
// Usage:
//   node scripts/agents/phase-5-trial-eval.mjs [--check] [--quiet]
//   --check   : write the report + exit 0 if trial supports keeping hook,
//               exit 2 if trial does not support keeping
//   --quiet   : suppress stdout summary

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(__filename)));
const LEDGER_PATH = join(ROOT, 'data', 'persistent-task-ledger.md');

const TRIAL_START = '2026-05-25';   // PR #211 merge date
const TRIAL_END = '2026-06-22';     // 4 weeks later (locked decision)

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const QUIET = args.includes('--quiet');

function log(msg) { if (!QUIET) console.log(msg); }

function countStatuses(ledgerText) {
  // Match `status: <STATUS>` lines from each LEDGER block's metadata.
  const re = /^status:\s*(\S+)/gm;
  const counts = {};
  let m;
  while ((m = re.exec(ledgerText))) {
    const status = m[1];
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function countLedgerIds(ledgerText) {
  // Match LEDGER-NNN entries
  const re = /^## LEDGER-(\d+)\b/gm;
  const ids = new Set();
  let m;
  while ((m = re.exec(ledgerText))) {
    ids.add(parseInt(m[1], 10));
  }
  return ids;
}

function getLedgerAtCommit(sha) {
  try {
    return execSync(`git show ${sha}:data/persistent-task-ledger.md`, {
      cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

function findCommitNearDate(dateStr) {
  // Get the most recent commit ON or BEFORE the given date that touched the ledger.
  try {
    const sha = execSync(
      `git log --until="${dateStr}T23:59:59" -1 --format="%H" -- data/persistent-task-ledger.md`,
      { cwd: ROOT, encoding: 'utf-8' }
    ).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function main() {
  if (!existsSync(LEDGER_PATH)) {
    console.error(`[phase-5-eval] ledger not found at ${LEDGER_PATH}`);
    process.exit(1);
  }

  log(`[phase-5-eval] window: ${TRIAL_START} → ${TRIAL_END}`);

  // Baseline (trial start)
  const baselineSha = findCommitNearDate(TRIAL_START);
  if (!baselineSha) {
    log(`[phase-5-eval] no ledger commits on or before ${TRIAL_START} — using current as baseline`);
  }
  const baselineText = baselineSha ? getLedgerAtCommit(baselineSha) : null;
  const baselineStatuses = baselineText ? countStatuses(baselineText) : {};
  const baselineIds = baselineText ? countLedgerIds(baselineText) : new Set();

  // Current state
  const currentText = readFileSync(LEDGER_PATH, 'utf-8');
  const currentStatuses = countStatuses(currentText);
  const currentIds = countLedgerIds(currentText);

  // Compute deltas
  const allStatuses = new Set([...Object.keys(baselineStatuses), ...Object.keys(currentStatuses)]);
  const statusDeltas = {};
  for (const s of allStatuses) {
    statusDeltas[s] = (currentStatuses[s] || 0) - (baselineStatuses[s] || 0);
  }

  const newIds = [...currentIds].filter(id => !baselineIds.has(id));
  const removedIds = [...baselineIds].filter(id => !currentIds.has(id));

  const openClosedRatio = (() => {
    const open = (currentStatuses.OPEN || 0);
    const done = (currentStatuses.DONE || 0);
    return done > 0 ? (done / (open + done)).toFixed(2) : '0';
  })();

  // Recommendation heuristic — quality > speed move per Mitchell's locked policy
  // for the trial: keep the hook if closure rate (% DONE / total) >= 50% AND
  // delta-DONE > delta-OPEN during the trial.
  const deltaDone = statusDeltas.DONE || 0;
  const deltaOpen = statusDeltas.OPEN || 0;
  const recommend = (deltaDone >= deltaOpen && deltaDone > 0) ? 'KEEP' : 'EVALUATE_MANUALLY';

  // Render report
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = join(ROOT, 'data', `phase-5-trial-eval-${today}.md`);
  const report = [
    '---',
    'classification: "[PERSONAL — DO NOT PUBLISH]"',
    'agent: phase-5-trial-eval',
    `date: ${today}`,
    `trial_window: "${TRIAL_START} to ${TRIAL_END}"`,
    `recommendation: ${recommend}`,
    '---',
    '',
    '# Phase 5 hook-based ledger-injection — Trial Evaluation',
    '',
    `**Recommendation**: \`${recommend}\``,
    '',
    '## Trial baseline (2026-05-25 — PR #211 merge)',
    '',
    baselineSha ? `Baseline commit: \`${baselineSha.slice(0, 12)}\`` : 'No baseline commit found — eval against empty baseline.',
    '',
    'Status counts at baseline:',
    '',
    ...Object.entries(baselineStatuses).map(([s, c]) => `- ${s}: ${c}`),
    `- **Total entries: ${baselineIds.size}**`,
    '',
    '## Current state',
    '',
    'Status counts now:',
    '',
    ...Object.entries(currentStatuses).map(([s, c]) => `- ${s}: ${c}`),
    `- **Total entries: ${currentIds.size}**`,
    '',
    '## Deltas during trial',
    '',
    ...Object.entries(statusDeltas).map(([s, d]) => `- ${s}: ${d > 0 ? '+' : ''}${d}`),
    `- New entries added: ${newIds.length}`,
    `- Entries removed (typically SUPERSEDED→DONE merges): ${removedIds.length}`,
    '',
    `**Closure ratio (DONE / OPEN+DONE) now: ${openClosedRatio}**`,
    '',
    '## Interpretation',
    '',
    recommend === 'KEEP'
      ? 'Trial supports keeping the Phase 5 hook. Closure rate improved during the trial window + DONE delta exceeded OPEN delta. Recommend: lock the hook on permanently by removing the `LEDGER_HOOK_INJECT_ENABLED` kill switch from the env documentation as a "decommissioned trial flag."'
      : 'Trial results are ambiguous or do not support keeping the hook. DONE delta did not clearly exceed OPEN delta during the trial window. Recommend: human-driven analysis — read the actual ledger churn pattern + decide. If keeping, document why; if removing, remove the hook + revert .claude/settings.json.',
    '',
    '## Sample of new entries added during trial',
    '',
    newIds.length > 0
      ? newIds.slice(0, 10).map(id => `- LEDGER-${String(id).padStart(3, '0')}`).join('\n')
      : '(none)',
    '',
    '## Next step',
    '',
    recommend === 'KEEP'
      ? 'Mitchell reviews this doc, then merges the "lock the hook on" follow-up PR.'
      : 'Mitchell reviews ledger entries from the trial window manually and decides keep/remove.',
    '',
  ].join('\n');

  writeFileSync(reportPath, report);
  log(`[phase-5-eval] wrote report: ${reportPath}`);
  log(`[phase-5-eval] recommendation: ${recommend}`);

  if (CHECK) {
    process.exit(recommend === 'KEEP' ? 0 : 2);
  }
}

main();
