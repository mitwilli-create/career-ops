#!/usr/bin/env node
// scripts/agents/bug-resolver.mjs
//
// Bug-resolver main orchestrator. Walks data/bug-ledger.jsonl by severity
// priority (CRIT > HIGH > MED > LOW), runs each bug through the 7-phase
// pipeline (lib/bug-resolver/pipeline.mjs), opens DRAFT PRs for completed
// patches via lib/bug-resolver/draft-pr.mjs, updates ledger status.
//
// Scheduled: Mon/Thu 02:00 PT via launchd plist (DISABLED day-1 — Mitchell
// reviews trial runs first).
//
// CLI:
//   node scripts/agents/bug-resolver.mjs                       # full run, default caps
//   node scripts/agents/bug-resolver.mjs --dry-run             # pre-flight only, no LLM calls
//   node scripts/agents/bug-resolver.mjs --bug bug-2026-05-23-003   # single bug
//   node scripts/agents/bug-resolver.mjs --max-bugs 3          # override per-run cap
//   node scripts/agents/bug-resolver.mjs --cap-override 50     # raise per-bug cap (logged)
//   node scripts/agents/bug-resolver.mjs --help
//
// Exit codes:
//   0 — clean run
//   1 — fatal error
//   2 — unknown flag / bad arg
//   3 — disabled via env (BUG_RESOLVER_ENABLED=false)
//   4 — daily cap already exceeded before any bug processed

import 'dotenv/config';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processBug, CostCapExceeded } from '../../lib/bug-resolver/pipeline.mjs';
import { createDraftPr, DraftPrError } from '../../lib/bug-resolver/draft-pr.mjs';
import { resetBreaker, getBreakerStatus } from '../../lib/bug-resolver/vendor-router.mjs';
import { appendHardeningSuggestion } from '../../lib/bug-resolver/hardening-writer.mjs';
// v2 (2026-05-25): unified-queue routes by id prefix (bug-... → bug-ledger.jsonl,
// rg-... → regression-bug-queue.jsonl). Per
// data/decisions-pending-regression-auto-action-2026-05-25.md (gitignored).
import { loadUnifiedQueue, updateUnifiedEntry, entrySource } from '../../lib/bug-resolver/unified-queue.mjs';
// v2 PR #8: freeze enforcement + fix-log writes.
import { isV2Frozen, getActiveFreeze } from '../../lib/v2-thrash-counter.mjs';
import { appendV2FixLogEntry } from '../../lib/v2-fix-log.mjs';
// v2 PR #9: unified $300/day v2 budget gate.
import { checkV2Budget, BUDGET_USD_CAP as V2_BUDGET_CAP } from '../../lib/v2-budget.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const SPEND_LEDGER = join(DATA_DIR, 'bug-resolver-spend.jsonl');
const REPORTS_DIR = join(DATA_DIR, 'bug-resolver-reports');

// ─── PT helpers ─────────────────────────────────────────────────────────────
function ptDateStamp() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function ptIsoNow() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}

// ─── Env getters ────────────────────────────────────────────────────────────
function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(true|1|yes|on)$/i.test(v);
}
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const ENABLED        = envBool('BUG_RESOLVER_ENABLED', true);
const DAILY_USD_CAP  = envNum('BUG_RESOLVER_DAILY_USD', 150);
// Per-bug cap bumped 30 → 50 on 2026-05-25 as part of the MAX QUALITY
// routing change — gpt-5-5-pro implement phase widens worst-case spend on
// a single stubborn bug. Daily cap holds at $150 (~3 such bugs/day max).
const PER_BUG_CAP    = envNum('BUG_RESOLVER_PER_BUG_CAP', 50);
const MAX_BUGS       = envNum('BUG_RESOLVER_MAX_BUGS_PER_RUN', 5);

// ─── CLI parse ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dryRun: false, bugId: null, maxBugs: null,
    capOverride: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--bug') opts.bugId = argv[++i];
    else if (a === '--max-bugs') opts.maxBugs = Number(argv[++i]);
    else if (a === '--cap-override') opts.capOverride = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
bug-resolver — walks the bug ledger, runs each bug through the 7-phase
pipeline, opens DRAFT PRs for resolved bugs.

Usage:
  node scripts/agents/bug-resolver.mjs [options]

Options:
  --dry-run                    Pre-flight only; no LLM calls (free)
  --bug <id>                   Process single bug by ID
  --max-bugs <N>               Override BUG_RESOLVER_MAX_BUGS_PER_RUN (default 5)
  --cap-override <usd>         One-time per-bug cap raise (logged)
  --help                       Show this message

Env vars (defaults shown):
  BUG_RESOLVER_ENABLED=true              kill switch
  BUG_RESOLVER_DAILY_USD=150             daily spend ceiling
  BUG_RESOLVER_PER_BUG_CAP=30            per-bug spend ceiling
  BUG_RESOLVER_MAX_BUGS_PER_RUN=5        bugs per launchd run
  BUG_RESOLVER_VENDOR_DISABLED_GEMINI    skip Gemini phases on true
  BUG_RESOLVER_VENDOR_DISABLED_GROK4     skip Grok-4 phases on true
  BUG_RESOLVER_VENDOR_DISABLED_GPT5      skip GPT-5 phases on true

Output: per-bug decision docs at data/bug-resolver-reports/<DATE>/<bug-id>.md
        + ledger updates (data/bug-ledger.jsonl).
  `.trim());
}

// ─── Spend tracking ─────────────────────────────────────────────────────────
function getTodaySpend() {
  if (!existsSync(SPEND_LEDGER)) return 0;
  const today = ptDateStamp();
  try {
    const raw = readFileSync(SPEND_LEDGER, 'utf-8');
    let sum = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.date === today && typeof r.usd === 'number') sum += r.usd;
      } catch { /* skip malformed */ }
    }
    return sum;
  } catch { return 0; }
}

function recordSpend({ bugId, vendor_log, total_cost_usd }) {
  for (const entry of vendor_log) {
    const rec = {
      date: ptDateStamp(),
      timestamp: ptIsoNow(),
      bug_id: bugId,
      phase: entry.phase,
      vendor: entry.vendor,
      usd: entry.costUsd || 0,
      tokens: entry.tokens || 0,
      ok: entry.ok,
    };
    try { appendFileSync(SPEND_LEDGER, JSON.stringify(rec) + '\n'); }
    catch { /* never crash on log write */ }
  }
}

// ─── Per-bug decision doc ───────────────────────────────────────────────────
function writeDecisionDoc(bug, result, prResult, today) {
  const dateDir = join(REPORTS_DIR, today);
  if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true });
  const docPath = join(dateDir, `${bug.id}.md`);

  const lines = [];
  lines.push(`---`);
  lines.push(`classification: "[PERSONAL — DO NOT PUBLISH]"`);
  lines.push(`bug_id: ${bug.id}`);
  lines.push(`processed_at: ${ptIsoNow()}`);
  lines.push(`status: ${result.status || 'UNKNOWN'}`);
  lines.push(`total_cost_usd: ${(result.total_cost_usd || 0).toFixed(4)}`);
  lines.push(`---`);
  lines.push('');
  lines.push(`# Bug-resolver decision: ${bug.id}`);
  lines.push('');
  lines.push(`**Title:** ${bug.title}`);
  lines.push(`**Severity (intake):** ${bug.severity}`);
  lines.push(`**Source:** \`${bug.source_surface}\``);
  lines.push(`**Status:** ${result.status || 'UNKNOWN'}`);
  lines.push('');

  if (result.audit_summary) {
    lines.push('## Audit summary');
    lines.push(result.audit_summary);
    lines.push('');
  }

  if (result.status === 'WONT_FIX' && result.linked_to) {
    lines.push(`## Resolution: WONT_FIX (semantic duplicate)`);
    lines.push(`Linked to: \`${result.linked_to}\``);
    lines.push('');
  }

  if (result.status === 'NEEDS_HUMAN') {
    lines.push('## Resolution: NEEDS_HUMAN');
    lines.push('');
    lines.push('Reasons:');
    for (const r of result.needs_human_reasons || []) {
      lines.push(`- ${r}`);
    }
    lines.push('');
    if (result.apply_check_error) {
      lines.push('### git apply --check error');
      lines.push('```');
      lines.push(result.apply_check_error);
      lines.push('```');
      lines.push('');
    }
  }

  if (result.status === 'DRAFT_PR' && prResult) {
    lines.push('## Resolution: DRAFT PR created');
    lines.push('');
    lines.push(`- Branch: \`${prResult.branchName}\``);
    lines.push(`- Commit: \`${prResult.commitSha}\``);
    lines.push(`- PR: ${prResult.prUrl}`);
    lines.push('');
    if (result.pr_metadata?.test_plan) {
      lines.push('### Test plan');
      lines.push(result.pr_metadata.test_plan);
      lines.push('');
    }
    if (result.pr_metadata?.rollback_plan) {
      lines.push('### Rollback plan');
      lines.push(result.pr_metadata.rollback_plan);
      lines.push('');
    }
  }

  lines.push('## Vendor log');
  lines.push('| Phase | Vendor | Tokens | Cost ($) | Latency (s) | OK |');
  lines.push('|---|---|---|---|---|---|');
  for (const v of result.vendor_log || []) {
    lines.push(
      `| ${v.phase} | ${v.vendor || '-'} | ${v.tokens || 0} | ` +
      `${(v.costUsd || 0).toFixed(4)} | ${((v.ms || 0) / 1000).toFixed(1)} | ${v.ok ? '✓' : '✗'} |`
    );
  }
  lines.push('');
  lines.push(`**Total cost:** $${(result.total_cost_usd || 0).toFixed(4)}`);

  if (result.hardening_md) {
    lines.push('');
    lines.push('## Hardening guidance');
    lines.push(`Mode: ${result.hardening_mode || '?'}, target: \`${result.hardening_target_pattern || '?'}\``);
    lines.push('');
    lines.push('```markdown');
    lines.push(result.hardening_md);
    lines.push('```');
  }

  writeFileSync(docPath, lines.join('\n'));
  return docPath;
}

// ─── Prioritize ledger entries ──────────────────────────────────────────────
const SEV_WEIGHT = { CRIT: 4, HIGH: 3, MED: 2, LOW: 1 };

function prioritize(entries, maxN, singleBugId) {
  if (singleBugId) {
    const one = entries.find(e => e.id === singleBugId);
    if (!one) {
      console.error(`Bug ID not found in ledger: ${singleBugId}`);
      process.exit(2);
    }
    return [one];
  }
  // Filter OPEN entries only
  const open = entries.filter(e => e.status === 'OPEN' && !e.linked_to);
  // Sort by severity desc, then first_seen asc (oldest first within severity)
  open.sort((a, b) => {
    const sa = SEV_WEIGHT[a.severity] || 0;
    const sb = SEV_WEIGHT[b.severity] || 0;
    if (sa !== sb) return sb - sa;
    return String(a.first_seen).localeCompare(String(b.first_seen));
  });
  return open.slice(0, maxN);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  console.log(`[bug-resolver] start ${ptIsoNow()}`);

  if (!ENABLED) {
    console.log(`[bug-resolver] DISABLED via BUG_RESOLVER_ENABLED=false. Exit clean.`);
    process.exit(3);
  }

  // Daily cap pre-check (per-agent: BUG_RESOLVER_DAILY_USD)
  const startSpend = getTodaySpend();
  if (startSpend >= DAILY_USD_CAP) {
    console.error(`[bug-resolver] daily cap $${DAILY_USD_CAP} already exceeded ($${startSpend.toFixed(2)} spent today). Exiting.`);
    process.exit(4);
  }

  // v2 PR #9: unified v2 pipeline budget gate (V2_BUDGET_USD, default $300).
  // Refuses to start if combined v2 spend already exhausts the cross-agent cap.
  if (!opts.dryRun) {
    const v2Budget = checkV2Budget();
    if (!v2Budget.ok) {
      console.error(`[bug-resolver] v2 unified budget exceeded — ${v2Budget.abortReason}`);
      process.exit(4);
    }
    console.log(`[bug-resolver] v2-budget: $${v2Budget.spent.toFixed(2)} of $${V2_BUDGET_CAP} spent today (${v2Budget.remaining.toFixed(2)} remaining)`);
  }

  const effectivePerBugCap = opts.capOverride || PER_BUG_CAP;
  if (opts.capOverride) {
    console.log(`[bug-resolver] PER-BUG-CAP-OVERRIDE applied: $${effectivePerBugCap} (default ${PER_BUG_CAP})`);
  }

  const maxBugsEffective = opts.maxBugs || MAX_BUGS;
  console.log(`[bug-resolver] config: dailyCap=$${DAILY_USD_CAP} perBugCap=$${effectivePerBugCap} maxBugs=${maxBugsEffective} dryRun=${opts.dryRun} startSpendToday=$${startSpend.toFixed(2)}`);

  // Reset circuit-breaker at start of run
  resetBreaker();

  // Load + prioritize. v2: unified queue spans bug-ledger.jsonl + regression-bug-queue.jsonl.
  const allEntries = loadUnifiedQueue();
  const queue = prioritize(allEntries, maxBugsEffective, opts.bugId);

  if (queue.length === 0) {
    console.log(`[bug-resolver] unified queue has no OPEN entries (of ${allEntries.length} total). Nothing to do.`);
    process.exit(0);
  }

  console.log(`[bug-resolver] processing ${queue.length} bug(s):`);
  for (const bug of queue) {
    console.log(`  ${bug.id.padEnd(22)} ${bug.severity.padEnd(5)} ${entrySource(bug.id).padEnd(17)} ${bug.title.slice(0, 80)}`);
  }
  console.log('');

  const today = ptDateStamp();
  const summary = [];

  for (const bug of queue) {
    // Daily cap re-check before each bug
    const currentSpend = getTodaySpend();
    if (currentSpend >= DAILY_USD_CAP) {
      console.log(`[bug-resolver] daily cap $${DAILY_USD_CAP} reached mid-run. Stopping at ${summary.length}/${queue.length}.`);
      break;
    }

    // v2 PR #9: unified v2 budget mid-pipeline check.
    // Abort the loop if the unified $300/day cap is exhausted mid-run.
    if (!opts.dryRun) {
      const v2MidCheck = checkV2Budget();
      if (!v2MidCheck.ok) {
        console.warn(`[bug-resolver] v2 unified budget exhausted mid-run — ${v2MidCheck.abortReason}. Stopping at ${summary.length}/${queue.length}.`);
        break;
      }
    }

    // v2 PR #8: freeze enforcement. rg-* entries (regression-guard findings)
    // respect the v2 freeze; bug-* entries (hand-curated) bypass it since they
    // were not produced by the auto-fix loop. Freeze fires when 3+ auto-reverts
    // occurred in the last 24h — prevents a thrash spiral.
    if (entrySource(bug.id) === 'regression-bug-queue' && isV2Frozen()) {
      const freeze = getActiveFreeze();
      console.warn(`[bug-resolver] v2 FROZEN until ${freeze ? freeze.frozen_until : 'unknown'} — skipping rg-* entry ${bug.id}`);
      summary.push({ id: bug.id, status: 'SKIPPED_FROZEN', cost: 0 });
      continue;
    }

    console.log(`\n[bug-resolver] processing ${bug.id} (${bug.severity}) [${entrySource(bug.id)}]...`);
    if (!opts.dryRun) updateUnifiedEntry(bug.id, { status: 'IN_PROGRESS' });

    let result;
    try {
      result = await processBug(bug, {
        perBugCap: effectivePerBugCap,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      console.error(`  EXCEPTION: ${err.message}`);
      if (!opts.dryRun) {
        updateUnifiedEntry(bug.id, {
          status: 'NEEDS_HUMAN',
          needs_human_reasons: [`orchestrator-exception: ${err.message}`],
        });
      }
      summary.push({ id: bug.id, status: 'NEEDS_HUMAN', cost: 0, error: err.message });
      continue;
    }

    // Record spend regardless of outcome (dry-run has zero spend, so this is harmless)
    if (!opts.dryRun) {
      recordSpend({
        bugId: bug.id,
        vendor_log: result.vendor_log || [],
        total_cost_usd: result.total_cost_usd || 0,
      });
    }

    // Handle each terminal status
    let prResult = null;

    if (result.status === 'DRAFT_PR_READY') {
      // Create the PR (dryRun path skips actual git ops + returns {dryRun:true})
      // v2 (2026-05-25): enableAutoMerge=true per interview Q3 — every
      // bug-resolver PR auto-merges on CI green except those touching
      // sensitive paths (gated inside createDraftPr via findSensitiveTouches).
      try {
        prResult = await createDraftPr({
          bugId: bug.id,
          patch: result.patch,
          prMetadata: result.pr_metadata,
          isDryRun: opts.dryRun,
          enableAutoMerge: true,
        });
        if (!opts.dryRun) {
          updateUnifiedEntry(bug.id, {
            status: 'DRAFT_PR',
            draft_pr_url: prResult.prUrl,
            resolution_commit: prResult.commitSha,
            vendor_log: result.vendor_log,
            total_cost_usd: result.total_cost_usd,
            auto_merge_safe: prResult.autoMergeSafe || false,
            sensitive_touches: prResult.sensitiveTouches || [],
          });
          // v2 PR #8: write v2-fix-log entry on DRAFT_PR creation.
          // Only for rg-* entries (regression-guard findings). bug-* entries
          // are hand-curated and don't go through the auto-fix accountability loop.
          if (entrySource(bug.id) === 'regression-bug-queue') {
            try {
              appendV2FixLogEntry({
                fix_sha: prResult.commitSha || 'unknown',
                detector: 'bug-resolver',
                detector_severity: bug.severity || 'MED',
                finding_hash: bug.citation_hash || ('sha256:' + bug.id),
                pr_url: prResult.prUrl || null,
                pr_state: 'DRAFT',
                verification: null,
                cost_usd: result.total_cost_usd || null,
                files_changed: (result.patch?.changedFiles || []).map(f => String(f).slice(0, 300)),
                time_to_resolution_ms: null, // will be updated by v2-verify-subset on PASS/FAIL
              });
            } catch (logErr) {
              // Non-fatal — fix-log is observability, not load-bearing for the PR flow.
              console.warn(`  WARN [v2-fix-log] write failed: ${logErr.message}`);
            }
          }
        }
        result.status = 'DRAFT_PR'; // for the summary
      } catch (err) {
        const reasons = (result.needs_human_reasons || []).slice();
        reasons.push(`draft-pr-failed (${err instanceof DraftPrError ? err.phase : 'unknown'}): ${err.message}`);
        if (!opts.dryRun) {
          updateUnifiedEntry(bug.id, {
            status: 'NEEDS_HUMAN',
            needs_human_reasons: reasons,
            vendor_log: result.vendor_log,
            total_cost_usd: result.total_cost_usd,
          });
        }
        result.status = 'NEEDS_HUMAN';
        result.needs_human_reasons = reasons;
      }
    } else if (result.status === 'WONT_FIX') {
      // Pipeline already called linkEntries — just record vendor_log
      if (!opts.dryRun) {
        updateUnifiedEntry(bug.id, {
          vendor_log: result.vendor_log,
          total_cost_usd: result.total_cost_usd,
        });
      }
    } else {
      // NEEDS_HUMAN or other — update ledger with reasons
      if (!opts.dryRun) {
        updateUnifiedEntry(bug.id, {
          status: result.status || 'NEEDS_HUMAN',
          needs_human_reasons: result.needs_human_reasons || [],
          vendor_log: result.vendor_log,
          total_cost_usd: result.total_cost_usd,
        });
      }
    }

    // Write decision doc (skip on dry-run to avoid creating ephemeral reports)
    const docPath = opts.dryRun ? '(dry-run — no doc written)' : writeDecisionDoc(bug, result, prResult, today);

    // Append hardening suggestion to pending-review file (only on real runs
    // with generated hardening_md; non-destructive — Mitchell reviews + applies
    // to brain catalog manually).
    if (!opts.dryRun && result.hardening_md) {
      try {
        appendHardeningSuggestion({
          bugId: bug.id,
          mode: result.hardening_mode,
          target_pattern_slug: result.hardening_target_pattern,
          markdown_block: result.hardening_md,
        });
      } catch (err) {
        // non-fatal: hardening suggestion is documentation, not load-bearing
        console.warn(`  WARN: failed to append hardening suggestion: ${err.message}`);
      }
    }

    summary.push({
      id: bug.id,
      status: result.status,
      cost: result.total_cost_usd || 0,
      prUrl: prResult?.prUrl || null,
      docPath,
    });

    console.log(`  → status=${result.status} cost=$${(result.total_cost_usd || 0).toFixed(4)} doc=${docPath}`);
  }

  // ─── Final summary ────────────────────────────────────────────────────
  const endSpend = getTodaySpend();
  console.log(`\n[bug-resolver] run complete`);
  console.log(`Run summary:`);
  console.log(`  Bug ID                Status         Cost($)   PR URL`);
  console.log(`  ------                ------         -------   ------`);
  for (const s of summary) {
    console.log(
      `  ${s.id.padEnd(22)} ${(s.status || '-').padEnd(14)} ` +
      `${s.cost.toFixed(4).padStart(7)}   ${s.prUrl || '-'}`
    );
  }
  console.log('');
  console.log(`Run spend: $${(endSpend - startSpend).toFixed(4)}`);
  console.log(`Today total: $${endSpend.toFixed(4)} / $${DAILY_USD_CAP} cap`);
  console.log(`Circuit-breaker state: ${JSON.stringify(getBreakerStatus())}`);
  console.log(`[bug-resolver] done ${ptIsoNow()}`);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack || '');
  process.exit(1);
});
