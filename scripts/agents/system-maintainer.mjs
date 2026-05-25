#!/usr/bin/env node
/**
 * scripts/agents/system-maintainer.mjs — SRE/maintenance sub-agent.
 *
 * Built as part of epsilon Ε.8 (2026-05-19). Provides a single CLI that
 * mirrors the overnight EPSILON workflow:
 *
 *   --health     System-health snapshot → data/system-health-<DATE>.md
 *   --cleanup    Reversible dedup + archive (orphans, /tmp leaks)
 *   --review     Re-scan dashboard-server.mjs for security regressions
 *                (path-traversal in *Slug args, unguarded fetches, etc.)
 *   --expand     Fire researcher subprocess: surface 10 pre-IPO companies
 *                NOT in portals.yml that match Mitchell's archetypes
 *   --ats-watch  Fire researcher subprocess: ATS AI-detection landscape
 *                last 90 days
 *   --all        Run --health → --cleanup → --review (skip LLM-heavy
 *                --expand + --ats-watch, which are weekly/quarterly)
 *
 * Runs without LLM by default — only --expand and --ats-watch spend money.
 *
 * Logs to data/logs/system-maintainer-<ISO-DATE>.log.
 *
 * Output files (always dated):
 *   data/system-health-YYYY-MM-DD.md
 *   data/system-maintenance-log-YYYY-MM-DD.md
 *   data/system-review-findings-YYYY-MM-DD.md
 *   data/portals-expansion-log-YYYY-MM-DD.md   (--expand only)
 *   data/ats-landscape-YYYY-MM-DD.md           (--ats-watch only)
 *
 * Reusable from launchd:
 *   nightly 03:00 PT via com.mitchell.career-ops.system-maintainer.plist
 *
 * Anti-hallucination + anti-sycophancy reminders:
 *  - Reports raw counts, not "all healthy ✓" boilerplate.
 *  - When something is missing or flapping, says so plainly with exit codes.
 *  - Never claims a fix shipped that didn't.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  findRepoRoot, snapshotAll,
  checkLaunchdPlists, checkApplicationsTracker, checkHmIntelAge,
  checkReportOrphans, checkApplyPacks, checkTmpLeaks,
  checkPipelineState, checkDashboardServer,
} from '../../lib/system-health-snapshot.mjs';
import {
  archiveReverseOrphanHtmls, archiveOrphanApplyPacks,
  archiveStaleHmIntel, sweepTmpLeaks,
} from '../../lib/system-health-cleanup.mjs';
import { installRunRecord } from '../../lib/job-runs-ledger.mjs';
import { escapeBackslashAndChar } from '../../lib/sanitize.mjs';

const __jobRun = installRunRecord('system-maintainer');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(__dirname);

function ptDateStamp(d = new Date()) {
  const ms = d.getTime() - (7 * 3600 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function ptIsoStamp(d = new Date()) {
  const ms = d.getTime() - (7 * 3600 * 1000);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}

const dateStamp = ptDateStamp();
const logDir = join(ROOT, 'data/logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `system-maintainer-${dateStamp}.log`);

function log(line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${line}\n`;
  process.stdout.write(entry);
  try { appendFileSync(logPath, entry); } catch { /* don't crash on log write */ }
}

// ───────────────────────────────────────────────────────────────────────────
// --health
// ───────────────────────────────────────────────────────────────────────────

async function runHealth() {
  log('▶ --health: snapshotting system state');
  const snap = await snapshotAll(ROOT);
  const outPath = join(ROOT, `data/system-health-${dateStamp}.md`);
  const md = renderHealthMarkdown(snap);
  writeFileSync(outPath, md);
  log(`✓ wrote ${outPath} (${md.length} chars)`);
  // Surface the headline counts to stdout so launchd logs are useful.
  // Use ?? guards everywhere — when a data file is missing the lib returns
  // { exists: false } with no other fields. Don't crash the launchd job.
  log(`  launchd: ${snap.launchd.loaded}/${snap.launchd.total} loaded; ${snap.launchd.flapping.length} flapping`);
  log(`  tracker: ${snap.tracker.totalRows ?? '?'} rows, ${(snap.tracker.duplicateIds ?? []).length} dupe IDs`);
  log(`  hm-intel: ${snap.hmIntel.totalFiles ?? '?'} files, ${snap.hmIntel.staleCount ?? '?'} stale (>30d)`);
  log(`  reports: ${snap.orphans.mdCount ?? '?'} md, ${snap.orphans.htmlCount ?? '?'} html, ${(snap.orphans.reverseOrphans ?? []).length} reverse-orphan`);
  log(`  apply-packs: ${snap.applyPacks.totalPacks ?? '?'}; ${(snap.applyPacks.noTrackerRef ?? []).length} no-tracker-ref`);
  log(`  /tmp leaks: ${snap.tmpLeaks.leakedCount}`);
  log(`  dashboard listening on :3097: ${snap.dashboardServer.listening}`);
  return snap;
}

/**
 * Load and return the launchd-wrapper state JSON, or null on any error.
 * Never throws — health snapshot must be resilient to missing / corrupt state.
 */
function loadWrapperStats(root) {
  const statePath = join(root, 'data', 'launchd-wrapper-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.labels) return null;
    return parsed;
  } catch {
    return null;
  }
}

function renderHealthMarkdown(snap) {
  const lines = [];
  lines.push(`# System Health Snapshot — ${dateStamp}`);
  lines.push('');
  lines.push(`**Captured:** ${snap.capturedAt}`);
  lines.push(`**Tool:** scripts/agents/system-maintainer.mjs --health`);
  lines.push('');
  lines.push('## launchd inventory');
  lines.push('');
  lines.push(`Total plists in scripts/launchd/: **${snap.launchd.total}**`);
  lines.push(`Loaded: **${snap.launchd.loaded}** · Unloaded: **${snap.launchd.unloaded}** · Flapping: **${snap.launchd.flapping.length}**`);
  lines.push('');
  if (snap.launchd.flapping.length > 0) {
    lines.push('### Flapping jobs (NEEDS_HUMAN)');
    lines.push('');
    for (const f of snap.launchd.flapping) {
      lines.push(`- \`${f.label}\` — last exit ${f.exitCode}, pid ${f.pid}, plist ${f.plistFile}`);
    }
    lines.push('');
  }
  lines.push('| Plist | Loaded | Last exit |');
  lines.push('|---|---|---|');
  for (const e of snap.launchd.entries) {
    lines.push(`| ${e.label} | ${e.loaded ? 'yes' : 'NO'} | ${e.exitCode ?? 'n/a'} |`);
  }
  lines.push('');

  // ── Wrapper-state stats (from data/launchd-wrapper-state.json) ──────────────
  lines.push('## Wrapper job health (launchd-wrapper-state.json)');
  lines.push('');
  const wrapperStats = loadWrapperStats(ROOT);
  if (!wrapperStats) {
    lines.push('_No wrapper state file yet — run jobs through launchd-wrapper.mjs to populate._');
  } else {
    const labelKeys = Object.keys(wrapperStats.labels ?? {}).sort();
    if (labelKeys.length === 0) {
      lines.push('_Wrapper state file exists but has no label entries yet._');
    } else {
      lines.push('| Label | Runs (last 20) | Success rate | Last exit | Last run |');
      lines.push('|---|---|---|---|---|');
      for (const label of labelKeys) {
        const history = wrapperStats.labels[label] ?? [];
        const total = history.length;
        const successes = history.filter(e => e.exit_code === 0).length;
        const pct = total > 0 ? Math.round((successes / total) * 100) : 0;
        const last = history[history.length - 1] ?? null;
        const lastExit = last ? last.exit_code : 'n/a';
        const lastRun = last ? last.finished_at.slice(0, 16).replace('T', ' ') : 'n/a';
        const successRateStr = total > 0 ? `${pct}% (${successes}/${total})` : 'no data';
        const rowFlag = (last && last.exit_code !== 0) ? ' ⚠' : '';
        lines.push(`| ${label}${rowFlag} | ${total} | ${successRateStr} | ${lastExit} | ${lastRun} |`);
      }
    }
  }
  lines.push('');

  lines.push('## Tracker (data/applications.md)');
  lines.push('');
  lines.push(`- Rows: **${snap.tracker.totalRows ?? 0}**`);
  lines.push(`- Unique IDs: **${snap.tracker.uniqueIds ?? 0}**`);
  lines.push(`- Duplicate IDs: **${snap.tracker.duplicateIds?.length ?? 0}**`);
  lines.push(`- Duplicate (company, role) pairs: **${snap.tracker.duplicateCompanyRoles?.length ?? 0}**`);
  if ((snap.tracker.duplicateIds ?? []).length) {
    lines.push('');
    for (const d of snap.tracker.duplicateIds) {
      lines.push(`  - id ${d.id} appears ${d.count}×`);
    }
  }
  lines.push('');
  lines.push('## HM-intel cache');
  lines.push('');
  lines.push(`- Total: **${snap.hmIntel.totalFiles ?? 0}**`);
  lines.push(`- Fresh (<${snap.hmIntel.staleDaysThreshold ?? 30}d): **${snap.hmIntel.freshCount ?? 0}**`);
  lines.push(`- Stale: **${snap.hmIntel.staleCount ?? 0}**`);
  lines.push('');
  lines.push('## Report ↔ dashboard html consistency');
  lines.push('');
  lines.push(`- reports/*.md: **${snap.orphans.mdCount ?? 0}**`);
  lines.push(`- dashboard/reports/*.html: **${snap.orphans.htmlCount ?? 0}**`);
  lines.push(`- Forward orphans (md without html): **${(snap.orphans.forwardOrphans ?? []).length}**`);
  lines.push(`- Reverse orphans (html without md): **${(snap.orphans.reverseOrphans ?? []).length}**`);
  if ((snap.orphans.reverseOrphans ?? []).length) {
    lines.push('');
    for (const s of snap.orphans.reverseOrphans) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push('## Apply-packs');
  lines.push('');
  lines.push(`- Total: **${snap.applyPacks.totalPacks ?? 0}**`);
  lines.push(`- No tracker reference: **${(snap.applyPacks.noTrackerRef ?? []).length}**`);
  if ((snap.applyPacks.noTrackerRef ?? []).length) {
    lines.push('');
    for (const s of snap.applyPacks.noTrackerRef) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push('## Pipeline state');
  lines.push('');
  lines.push(`- pipeline.md lines: **${snap.pipeline.pipelineLines}**`);
  lines.push(`- batch/batch-input.tsv lines: **${snap.pipeline.batchLines}**`);
  lines.push(`- scan-history.tsv lines: **${snap.pipeline.scanHistoryLines}**`);
  lines.push(`- scan-history age (hours): **${snap.pipeline.scanHistoryAgeHours ?? 'n/a'}**`);
  lines.push('');
  lines.push('## /tmp leaks');
  lines.push('');
  lines.push(`- Files >24h matching agent patterns: **${snap.tmpLeaks.leakedCount}**`);
  if (snap.tmpLeaks.samples?.length) {
    for (const s of snap.tmpLeaks.samples) lines.push(`  - ${s}`);
  }
  lines.push('');
  lines.push('## Dashboard server');
  lines.push('');
  lines.push(`- Listening on :${snap.dashboardServer.port}: **${snap.dashboardServer.listening ? 'YES' : 'NO'}**`);
  if (!snap.dashboardServer.listening) {
    lines.push('- **NEEDS_HUMAN** — launch dashboard-server.mjs via `launchctl kickstart -k gui/$(id -u)/com.mitchell.career-ops.dashboard-server` and check `data/logs/dashboard-server.err`');
  }
  lines.push('');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// --cleanup
// ───────────────────────────────────────────────────────────────────────────

async function runCleanup(snap) {
  log('▶ --cleanup: archiving orphans + /tmp sweep');
  if (!snap) snap = await snapshotAll(ROOT);

  const actions = [];

  // Reverse-orphan dashboard HTMLs
  const orphanResult = archiveReverseOrphanHtmls(ROOT, snap.orphans.reverseOrphans ?? []);
  if (orphanResult.archived.length) {
    actions.push({ kind: 'archive-reverse-orphans', count: orphanResult.archived.length, dest: orphanResult.destDir, items: orphanResult.archived });
    log(`  archived ${orphanResult.archived.length} reverse-orphan HTMLs → ${orphanResult.destDir}`);
  }

  // Orphan apply-packs (no tracker ref) — but only "000-unknown-unknown" or
  // similar placeholder slugs, NOT recent forward-built packs.
  const placeholderApplyPacks = (snap.applyPacks.noTrackerRef ?? []).filter(s => /^0+-/.test(s));
  if (placeholderApplyPacks.length) {
    const ap = archiveOrphanApplyPacks(ROOT, placeholderApplyPacks);
    if (ap.archived.length) {
      actions.push({ kind: 'archive-placeholder-apply-packs', count: ap.archived.length, dest: ap.destDir, items: ap.archived });
      log(`  archived ${ap.archived.length} placeholder apply-packs → ${ap.destDir}`);
    }
  }

  // Stale hm-intel (>30d AND Discarded) — pass tracker text for the Discarded check
  const trackerPath = join(ROOT, 'data/applications.md');
  const trackerText = existsSync(trackerPath) ? readFileSync(trackerPath, 'utf-8') : '';
  const sh = archiveStaleHmIntel(ROOT, snap.hmIntel.stale ?? [], trackerText);
  if (sh.archived.length) {
    actions.push({ kind: 'archive-stale-hm-intel', count: sh.archived.length, dest: sh.destDir, items: sh.archived });
    log(`  archived ${sh.archived.length} stale hm-intel files → ${sh.destDir}`);
  }

  // /tmp leaks
  const tmp = sweepTmpLeaks(1);
  if (tmp.removed.length) {
    actions.push({ kind: 'tmp-sweep', count: tmp.removed.length, items: tmp.removed });
    log(`  removed ${tmp.removed.length} /tmp leaks (>24h)`);
  }

  // Write cleanup log
  const outPath = join(ROOT, `data/system-maintenance-log-${dateStamp}.md`);
  writeFileSync(outPath, renderCleanupMarkdown(actions));
  log(`✓ wrote ${outPath}`);
  return actions;
}

function renderCleanupMarkdown(actions) {
  const lines = [];
  lines.push(`# System Maintenance Log — ${dateStamp}`);
  lines.push('');
  lines.push(`**Tool:** scripts/agents/system-maintainer.mjs --cleanup`);
  lines.push(`**Captured:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('All actions are reversible (archive, not delete) except `/tmp` sweep.');
  lines.push('');
  if (actions.length === 0) {
    lines.push('Nothing to clean up. System is healthy.');
    return lines.join('\n');
  }
  for (const a of actions) {
    lines.push(`## ${a.kind}`);
    lines.push('');
    lines.push(`- Count: **${a.count}**`);
    if (a.dest) lines.push(`- Archived to: \`${a.dest}\``);
    if (a.items?.length) {
      lines.push('');
      for (const it of a.items.slice(0, 30)) lines.push(`  - ${typeof it === 'string' ? it : JSON.stringify(it)}`);
      if (a.items.length > 30) lines.push(`  - ... (${a.items.length - 30} more)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// --review
// ───────────────────────────────────────────────────────────────────────────

async function runReview() {
  log('▶ --review: scanning dashboard-server.mjs for security regressions');
  const findings = [];
  const dsPath = join(ROOT, 'dashboard-server.mjs');
  if (!existsSync(dsPath)) {
    log('  dashboard-server.mjs not found — skipping');
    return findings;
  }
  const src = readFileSync(dsPath, 'utf-8');

  // Regression check 1 — both saveEvidence and buildVerifyPayload reference
  // REPORT_SLUG_RE before joining reportSlug into a path.
  const slugRePresent = /const REPORT_SLUG_RE\s*=/.test(src);
  if (!slugRePresent) {
    findings.push({
      severity: 'HIGH',
      file: 'dashboard-server.mjs',
      issue: 'REPORT_SLUG_RE constant missing — saveEvidence/buildVerifyPayload may be regressed to path-traversal',
    });
  }

  // Regression check 2 — every join(ROOT, 'reports', X) is preceded by a check
  // on REPORT_SLUG_RE within ~30 lines above.
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/join\(ROOT,\s*['"]reports['"],\s*(\w+)\)/);
    if (!m) continue;
    const varName = m[1];
    // Look 30 lines back for a REPORT_SLUG_RE.test(<varName>) guard
    const slice = lines.slice(Math.max(0, i - 30), i).join('\n');
    if (!new RegExp(`REPORT_SLUG_RE\\.test\\(${varName}\\)`).test(slice)) {
      findings.push({
        severity: 'HIGH',
        file: `dashboard-server.mjs:${i + 1}`,
        issue: `join(ROOT, 'reports', ${varName}) without REPORT_SLUG_RE guard in preceding 30 lines — potential path-traversal regression`,
      });
    }
  }

  // Regression check 3 — every fetch( in scripts/agents/* has AbortSignal or signal: somewhere within 15 lines.
  for (const agentFile of ['cv-tailor.mjs', 'cover-letter.mjs', 'form-fields.mjs', 'linkedin-dm.mjs', 'why-statement.mjs']) {
    const p = join(ROOT, 'scripts/agents', agentFile);
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf-8').split('\n');
    for (let i = 0; i < txt.length; i++) {
      if (!/fetch\(/.test(txt[i])) continue;
      const slice = txt.slice(i, Math.min(txt.length, i + 15)).join('\n');
      if (!/AbortSignal|signal:|opts\.signal/.test(slice)) {
        findings.push({
          severity: 'MEDIUM',
          file: `scripts/agents/${agentFile}:${i + 1}`,
          issue: `fetch() without AbortSignal in next 15 lines — verify timeout coverage`,
        });
      }
    }
  }

  log(`  ${findings.length} findings`);

  const outPath = join(ROOT, `data/system-review-findings-${dateStamp}.md`);
  writeFileSync(outPath, renderReviewMarkdown(findings));
  log(`✓ wrote ${outPath}`);
  return findings;
}

function renderReviewMarkdown(findings) {
  const lines = [];
  lines.push(`# System Code-Review Findings — ${dateStamp}`);
  lines.push('');
  lines.push(`**Tool:** scripts/agents/system-maintainer.mjs --review`);
  lines.push('');
  lines.push('Automated regression checks. Manual deep-audit is a separate workflow.');
  lines.push('');
  lines.push(`Total findings: **${findings.length}**`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('No regressions detected. Path-traversal guards present, fetch timeouts intact.');
    return lines.join('\n');
  }
  lines.push('| Severity | File:line | Issue |');
  lines.push('|---|---|---|');
  for (const f of findings) lines.push(`| ${f.severity} | ${f.file} | ${f.issue} |`);
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// --decision-doc (B4.1 / 2026-05-20) — force-ranked findings + recommendations
// + Decisions Required block. Matches the pattern of the 2026-05-20 completion
// audit so Mitchell receives one consolidated decision doc per weekly run
// instead of having to read 4 separate dated snapshots.
// ───────────────────────────────────────────────────────────────────────────

function rankSeverity(s) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s] ?? 9;
}

// Researcher-chain stale-handoff sweep (added 2026-05-23)
// Scans ~/.claude/agents/runs/_handoffs/dealbreaker-*.json for pending
// envelopes older than 24h. The handoff-file contract makes the chain
// invariant under harness restrictions, but if the main session crashes
// between researcher write and dealbreaker dispatch, the envelope sits
// at status:pending. This sweep surfaces those to the daily decision doc.
function scanStaleHandoffs() {
  const dir = join(homedir(), '.claude', 'agents', 'runs', '_handoffs');
  if (!existsSync(dir)) return { staleCount: 0, stalePaths: [], pendingCount: 0 };
  const stalePaths = [];
  let pendingCount = 0;
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;
  let entries;
  try { entries = readdirSync(dir); } catch { return { staleCount: 0, stalePaths: [], pendingCount: 0 }; }
  for (const f of entries) {
    if (!f.startsWith('dealbreaker-') || !f.endsWith('.json')) continue;
    const p = join(dir, f);
    try {
      const h = JSON.parse(readFileSync(p, 'utf8'));
      if (h.status !== 'pending') continue;
      pendingCount += 1;
      const created = new Date(h.created_at).getTime();
      if (Number.isFinite(created) && now - created > STALE_MS) {
        stalePaths.push({
          path: p,
          ageHours: Math.round((now - created) / 3.6e6),
          mode: h.mode || 'unknown',
          ceilingUsd: h.ceiling_usd ?? null,
          question: h.original_question || '',
        });
      }
    } catch { /* skip malformed envelope */ }
  }
  return { staleCount: stalePaths.length, stalePaths, pendingCount };
}

function buildDecisionFindings(snap, reviewFindings) {
  const out = [];

  // launchd findings — unloaded source plists are surfaced as MEDIUM unless
  // the unloaded count climbs above 15 (then HIGH — drift accelerating).
  const unloadedCount = snap.launchd.total - snap.launchd.loaded;
  if (unloadedCount > 0) {
    out.push({
      severity: unloadedCount > 15 ? 'HIGH' : 'MEDIUM',
      area: 'launchd',
      finding: `${unloadedCount} source plist(s) NOT loaded in ~/Library/LaunchAgents/`,
      recommendation: `Review data/launchd-deferred-*.md OR bootstrap via the documented Tahoe sequence`,
      decisionPrompt: `For each unloaded plist: KEEP_DEFERRED, BOOTSTRAP_NOW, or ARCHIVE_SOURCE.`,
    });
  }

  // Flapping plists — always CRITICAL, indicates a job is hard-failing.
  // Handles both legacy string entries and new object shape ({label, exitCode, pid, plistFile})
  // produced by lib/system-health-snapshot.mjs after 2026-05-23. Without the
  // shape-tolerant accessor, `${lbl}` would render "[object Object]" and
  // `.replace()` would throw TypeError — pre-existing bug surfaced 2026-05-23.
  for (const lbl of snap.launchd.flapping || []) {
    const label = (typeof lbl === 'string') ? lbl : (lbl.label || String(lbl));
    const exitCode = (typeof lbl === 'object' && lbl.exitCode != null) ? lbl.exitCode : '?';
    out.push({
      severity: 'CRITICAL',
      area: 'launchd',
      finding: `Plist flapping (last exit ${exitCode}): ${label}`,
      recommendation: `Tail data/logs/${label.replace('com.mitchell.career-ops.','')}-launchd.err for stack trace`,
      decisionPrompt: `Decision: FIX_SCRIPT, BOOTOUT_AND_DEFER, or RUN_MANUALLY?`,
    });
  }

  // Tracker findings
  if ((snap.tracker.duplicateIds ?? []).length > 0) {
    out.push({
      severity: 'HIGH',
      area: 'tracker',
      finding: `${snap.tracker.duplicateIds.length} duplicate row IDs in data/applications.md`,
      recommendation: `node scripts/dedup-tracker.mjs --dry-run, then commit if clean`,
      decisionPrompt: `Run dedup now or batch with next tracker maintenance pass?`,
    });
  }

  // HM intel age
  const stale = snap.hmIntel.staleCount ?? 0;
  if (stale > 5) {
    out.push({
      severity: 'MEDIUM',
      area: 'hm-intel',
      finding: `${stale} HM intel file(s) > 30d old (in data/hm-intel/)`,
      recommendation: `Re-run /intel-refresh per row (~$35 each) OR archive the rows out of apply-now if no longer pursuing`,
      decisionPrompt: `Refresh now (LLM spend) or defer until row reaches Tier-A?`,
    });
  }

  // Report orphans
  const ro = (snap.orphans.reverseOrphans ?? []).length;
  if (ro > 0) {
    out.push({
      severity: 'LOW',
      area: 'reports',
      finding: `${ro} dashboard reverse-orphan HTML reports (no corresponding .md)`,
      recommendation: `Run --cleanup to archive`,
      decisionPrompt: `(--cleanup auto-fires nightly; usually safe to ignore unless count climbs above 50)`,
    });
  }

  // Apply-pack orphans
  const no = (snap.applyPacks.noTrackerRef ?? []).length;
  if (no > 0) {
    out.push({
      severity: 'LOW',
      area: 'apply-packs',
      finding: `${no} apply-pack folder(s) with no matching tracker row`,
      recommendation: `Run --cleanup to archive (preserves to .claude/audit/)`,
      decisionPrompt: `Archive now or wait for next --cleanup nightly run?`,
    });
  }

  // /tmp leaks
  if (snap.tmpLeaks.leakedCount > 5) {
    out.push({
      severity: snap.tmpLeaks.leakedCount > 20 ? 'HIGH' : 'MEDIUM',
      area: '/tmp',
      finding: `${snap.tmpLeaks.leakedCount} career-ops /tmp leak(s) detected`,
      recommendation: `--cleanup auto-sweeps; if leaks persist daily, find the leaking script`,
      decisionPrompt: `Investigate source, or rely on auto-sweep?`,
    });
  }

  // Dashboard server liveness
  if (!snap.dashboardServer.listening) {
    out.push({
      severity: 'CRITICAL',
      area: 'dashboard-server',
      finding: `dashboard-server.mjs not listening on :3097`,
      recommendation: `launchctl kickstart -k gui/$(id -u)/com.mitchell.career-ops.dashboard-server`,
      decisionPrompt: `Restart now or investigate launchd state first?`,
    });
  }

  // Researcher-chain stale-handoff sweep (added 2026-05-23)
  const handoffs = scanStaleHandoffs();
  if (handoffs.staleCount > 0) {
    const sample = handoffs.stalePaths.slice(0, 3).map(s => `${basename(s.path)} (${s.ageHours}h)`).join(', ');
    out.push({
      severity: handoffs.staleCount > 3 ? 'HIGH' : 'MEDIUM',
      area: 'researcher-chain',
      finding: `${handoffs.staleCount} dealbreaker handoff(s) stuck at status:pending > 24h (${sample}${handoffs.staleCount > 3 ? '…' : ''})`,
      recommendation: `Per stale envelope: run /dealbreaker <handoff-path> to resume; OR rm <handoff-path> to abandon. Paths in ~/.claude/agents/runs/_handoffs/.`,
      decisionPrompt: `RESOLVE_NOW (dispatch dealbreaker per envelope), ABANDON (rm), or INVESTIGATE (read report_path first)?`,
    });
  }
  // Attach for renderDecisionDoc Wins line
  snap._handoffs = handoffs;

  // Review findings (security regressions in dashboard-server)
  for (const f of (reviewFindings || [])) {
    out.push({
      severity: f.severity,
      area: 'security',
      finding: `${f.file} — ${f.issue}`,
      recommendation: `Patch the regression in the indicated file`,
      decisionPrompt: `Fix immediately or open a tracking issue?`,
    });
  }

  // Sort: CRITICAL → HIGH → MEDIUM → LOW
  out.sort((a, b) => rankSeverity(a.severity) - rankSeverity(b.severity));
  return out;
}

function renderDecisionDoc(snap, reviewFindings) {
  const findings = buildDecisionFindings(snap, reviewFindings);
  const tally = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) tally[f.severity] = (tally[f.severity] || 0) + 1;
  const totalActionable = findings.length;

  const lines = [];
  lines.push(`# System-Maintenance Decision Doc — ${dateStamp}`);
  lines.push('');
  lines.push(`**Captured:** ${snap.capturedAt}`);
  lines.push(`**Tool:** scripts/agents/system-maintainer.mjs --decision-doc`);
  lines.push(`**Companion snapshots:** data/system-health-${dateStamp}.md · data/system-maintenance-log-${dateStamp}.md · data/system-review-findings-${dateStamp}.md`);
  lines.push('');

  // TL;DR
  lines.push('## TL;DR');
  lines.push('');
  if (totalActionable === 0) {
    lines.push(`All snapshots green. ${snap.launchd.loaded}/${snap.launchd.total} plists loaded, 0 flapping, 0 duplicate tracker IDs, dashboard-server listening. No decisions required.`);
  } else {
    const summaryBits = [];
    if (tally.CRITICAL) summaryBits.push(`${tally.CRITICAL} CRITICAL`);
    if (tally.HIGH)     summaryBits.push(`${tally.HIGH} HIGH`);
    if (tally.MEDIUM)   summaryBits.push(`${tally.MEDIUM} MEDIUM`);
    if (tally.LOW)      summaryBits.push(`${tally.LOW} LOW`);
    lines.push(`**${totalActionable} actionable finding(s)** — ${summaryBits.join(' · ')}.`);
    lines.push('');
    lines.push('See the Findings table below for full rankings. Decisions Required block at end of doc.');
  }
  lines.push('');

  // Wins (force-positive framing per Win-Burial counter-protocol)
  lines.push('## Wins');
  lines.push('');
  const wins = [];
  wins.push(`✓ ${snap.launchd.loaded}/${snap.launchd.total} launchd plists loaded, ${snap.launchd.flapping.length} flapping`);
  if (snap.dashboardServer.listening) wins.push(`✓ dashboard-server listening on :3097`);
  if ((snap.tracker.duplicateIds ?? []).length === 0) wins.push(`✓ Tracker has zero duplicate row IDs (${snap.tracker.totalRows ?? '?'} rows)`);
  if (snap.tmpLeaks.leakedCount === 0) wins.push(`✓ /tmp clean — no career-ops leaks`);
  if ((reviewFindings || []).length === 0) wins.push(`✓ Code-review: 0 security regressions in dashboard-server.mjs`);
  if (snap._handoffs && snap._handoffs.staleCount === 0) {
    const pc = snap._handoffs.pendingCount;
    wins.push(`✓ Researcher chain: no stale dealbreaker handoffs${pc > 0 ? ` (${pc} in flight, all <24h)` : ''}`);
  }
  if (wins.length === 0) wins.push(`(none — investigate findings below before declaring health)`);
  for (const w of wins) lines.push(`- ${w}`);
  lines.push('');

  // Findings table (force-ranked)
  if (totalActionable > 0) {
    lines.push('## Findings (force-ranked)');
    lines.push('');
    lines.push('| # | Severity | Area | Finding | Recommendation |');
    lines.push('|---|---|---|---|---|');
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      // Pipe-safe cells: escape `|` in user-facing text. Centralized via
      // lib/sanitize.mjs — defeats CodeQL `js/incomplete-sanitization`
      // alert #95 by escaping backslash FIRST so a literal `\` in the
      // input cannot bypass the pipe escape.
      const cell = (s) => escapeBackslashAndChar(s, '|');
      lines.push(`| ${i + 1} | ${f.severity} | ${f.area} | ${cell(f.finding)} | ${cell(f.recommendation)} |`);
    }
    lines.push('');

    // Decisions Required — copy-paste-back format
    lines.push('## Decisions Required');
    lines.push('');
    lines.push('Paste back to executor with your decisions inline. Default is the recommendation in the table above.');
    lines.push('');
    lines.push('```');
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      lines.push(`# ${i + 1}. [${f.severity}] ${f.area}: ${f.finding}`);
      lines.push(`#    ${f.decisionPrompt}`);
      lines.push(`DECISION_${i + 1}=____`);
      lines.push('');
    }
    lines.push('```');
    lines.push('');
  }

  // Health snapshot rollup
  lines.push('## Snapshot rollup');
  lines.push('');
  lines.push(`- launchd: ${snap.launchd.loaded}/${snap.launchd.total} loaded · ${snap.launchd.flapping.length} flapping`);
  lines.push(`- tracker: ${snap.tracker.totalRows ?? '?'} rows · ${(snap.tracker.duplicateIds ?? []).length} dupe IDs`);
  lines.push(`- hm-intel: ${snap.hmIntel.totalFiles ?? '?'} files · ${snap.hmIntel.staleCount ?? '?'} stale (>30d)`);
  lines.push(`- reports: ${snap.orphans.mdCount ?? '?'} md · ${snap.orphans.htmlCount ?? '?'} html · ${(snap.orphans.reverseOrphans ?? []).length} reverse-orphan`);
  lines.push(`- apply-packs: ${snap.applyPacks.totalPacks ?? '?'} · ${(snap.applyPacks.noTrackerRef ?? []).length} no-tracker-ref`);
  lines.push(`- /tmp leaks: ${snap.tmpLeaks.leakedCount}`);
  lines.push(`- dashboard-server listening on :3097: ${snap.dashboardServer.listening}`);
  if (snap._handoffs) {
    lines.push(`- researcher-chain handoffs: ${snap._handoffs.pendingCount} pending · ${snap._handoffs.staleCount} stale (>24h)`);
  }
  lines.push('');

  return lines.join('\n');
}

async function runDecisionDoc(snap, reviewFindings) {
  log('▶ --decision-doc: consolidating findings into decision doc');
  if (!snap) snap = await runHealth();
  // If reviewFindings wasn't passed in, re-run --review to get fresh findings.
  // runReview() returns its array even when --all dispatched it earlier.
  if (!reviewFindings) reviewFindings = await runReview();
  const outPath = join(ROOT, `data/system-maintenance-decision-doc-${dateStamp}.md`);
  const md = renderDecisionDoc(snap, reviewFindings);
  writeFileSync(outPath, md);
  log(`✓ wrote ${outPath} (${md.length} chars, ${(md.match(/^\| \d+/gm) || []).length} findings)`);
  return outPath;
}

// ───────────────────────────────────────────────────────────────────────────
// --expand (LLM, $$$) — wraps researcher subprocess
// ───────────────────────────────────────────────────────────────────────────

async function runExpand() {
  log('▶ --expand: deferred — invoke /researcher manually for pre-IPO companies');
  const outPath = join(ROOT, `data/portals-expansion-log-${dateStamp}.md`);
  const md = [
    `# Portals Expansion — ${dateStamp}`,
    '',
    '`scripts/agents/system-maintainer.mjs --expand` is a stub.',
    '',
    'The actual pre-IPO research runs via the researcher agent because:',
    '1. It costs $10-15 in API spend per pass (Sonar Deep + Grok-x-search)',
    '2. The researcher agent already exists, is well-tested, and routes per the Council OS KB',
    '3. Re-implementing inline would duplicate orchestration logic',
    '',
    'To run the expansion manually:',
    '```',
    '/researcher "Surface 10 pre-IPO AI companies matching Mitchell\'s archetypes NOT in portals.yml | --fast"',
    '```',
    '',
    'Or invoke the agent programmatically — see `epsilon-portals-expansion-log-2026-05-19.md` for the canonical research prompt + return shape.',
  ].join('\n');
  writeFileSync(outPath, md);
  log(`✓ wrote ${outPath} (stub — see file)`);
}

// ───────────────────────────────────────────────────────────────────────────
// --ats-watch (LLM, $$$) — wraps researcher subprocess
// ───────────────────────────────────────────────────────────────────────────

async function runAtsWatch() {
  log('▶ --ats-watch: deferred — invoke /researcher manually for ATS landscape');
  const outPath = join(ROOT, `data/ats-landscape-${dateStamp}.md`);
  const md = [
    `# ATS Landscape Watch — ${dateStamp}`,
    '',
    '`scripts/agents/system-maintainer.mjs --ats-watch` is a stub.',
    '',
    'ATS-detection landscape research runs via the researcher agent. See',
    '`data/epsilon-ats-landscape-2026-05-19.md` for the canonical prompt + format.',
    '',
    'To re-run:',
    '```',
    '/researcher "ATS AI-detection capabilities shipped in last 90 days: Workday, Greenhouse, Ashby, Lever, iCIMS, Taleo, SuccessFactors | --fast"',
    '```',
  ].join('\n');
  writeFileSync(outPath, md);
  log(`✓ wrote ${outPath} (stub — see file)`);
}

// ───────────────────────────────────────────────────────────────────────────
// --archive-old-cache (PR-09, 2026-05-25)
// Walks each cache directory from CACHE_FRESHNESS_THRESHOLDS_MS (9 dirs).
// Files with mtime > ARCHIVE_AGE_DAYS are moved to data/_archive/<cache-dir>/.
// Never deletes — purely reversible archival.
// ───────────────────────────────────────────────────────────────────────────

// Cache directories and their data/ subdirectory path.
// align with lib/cache-freshness.mjs CACHE_FRESHNESS_THRESHOLDS_MS keys.
const CACHE_DIR_PATHS = {
  'hm-intel':             join(ROOT, 'data', 'hm-intel'),
  'team-health':          join(ROOT, 'data', 'team-health'),
  'context-notes':        join(ROOT, 'data', 'context-notes'),
  'role-enrichment':      join(ROOT, 'data', 'role-enrichment'),
  'strategy-ceiling':     join(ROOT, 'data', 'strategy-cache'),
  'interview-likelihood': join(ROOT, 'data', 'interview-likelihood'),
  'hm-chance':            join(ROOT, 'data', 'hm-chance'),
  // 'apply-pack' is Infinity — never archive
  'network-database':     join(ROOT, 'data', 'network-database'),
};

const ARCHIVE_AGE_DAYS = 90;
const ARCHIVE_BASE     = join(ROOT, 'data', '_archive');

async function runArchiveOldCache(opts = {}) {
  const dryRun = opts.dryRun !== false; // default: dry-run
  const ageThresholdMs = ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  log(`▶ --archive-old-cache: scanning 9 cache dirs for files > ${ARCHIVE_AGE_DAYS}d (${dryRun ? 'DRY-RUN' : 'APPLY'})`);

  const report = [];
  let totalMoved = 0;
  let totalSkipped = 0;
  let totalErrors  = 0;

  for (const [cacheKey, cacheDir] of Object.entries(CACHE_DIR_PATHS)) {
    if (!existsSync(cacheDir)) {
      log(`  [skip] ${cacheKey}: ${cacheDir} does not exist`);
      report.push({ cacheKey, cacheDir, status: 'dir-missing', files: [] });
      continue;
    }

    let files;
    try {
      files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
    } catch (err) {
      log(`  [warn] ${cacheKey}: cannot read dir — ${err.message}`);
      totalErrors++;
      report.push({ cacheKey, cacheDir, status: 'read-error', files: [] });
      continue;
    }

    const destDir = join(ARCHIVE_BASE, cacheKey);
    const moved   = [];
    const kept    = [];

    for (const f of files) {
      const fp = join(cacheDir, f);
      let mtimeMs;
      try { mtimeMs = statSync(fp).mtimeMs; }
      catch { totalErrors++; continue; }

      const ageMs = now - mtimeMs;
      if (ageMs < ageThresholdMs) { kept.push(f); continue; }

      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const dest    = join(destDir, f);

      if (!dryRun) {
        try {
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
          renameSync(fp, dest);
          moved.push({ file: f, ageDays });
          totalMoved++;
        } catch (err) {
          log(`  [warn] ${cacheKey}/${f}: rename failed — ${err.message}`);
          totalErrors++;
        }
      } else {
        moved.push({ file: f, ageDays }); // would move in dry-run
        totalMoved++;
      }
    }

    const lineVerb = dryRun ? 'would move' : 'moved';
    log(`  ${cacheKey}: ${lineVerb} ${moved.length}/${files.length} files; kept ${kept.length}`);
    if (moved.length) {
      for (const m of moved.slice(0, 5)) {
        log(`    ${lineVerb}: ${m.file} (${m.ageDays}d old) → _archive/${cacheKey}/`);
      }
      if (moved.length > 5) log(`    … and ${moved.length - 5} more`);
    }
    report.push({ cacheKey, cacheDir, destDir, status: 'ok', moved, kept });
  }

  // Summary
  log('');
  log('── Cache archive summary ────────────────────────────────────────');
  log(`  Mode       : ${dryRun ? 'DRY-RUN (pass --apply to write)' : 'APPLY'}`);
  log(`  Threshold  : > ${ARCHIVE_AGE_DAYS} days old`);
  log(`  ${dryRun ? 'Would archive' : 'Archived'}: ${totalMoved} files`);
  log(`  Errors     : ${totalErrors}`);
  log('──────────────────────────────────────────────────────────────────');

  // Write summary doc
  const outPath = join(ROOT, `data/cache-archive-log-${dateStamp}.md`);
  const lines = [
    `# Cache Archive Log — ${dateStamp}`,
    '',
    `Mode: **${dryRun ? 'DRY-RUN' : 'APPLY'}** · Threshold: > ${ARCHIVE_AGE_DAYS} days`,
    '',
    '| Cache dir | Total files | Archived | Kept |',
    '|---|---|---|---|',
    ...report.map(r => {
      const total = (r.moved?.length ?? 0) + (r.kept?.length ?? 0);
      return `| ${r.cacheKey} | ${total} | ${r.moved?.length ?? 0} | ${r.kept?.length ?? 0} |`;
    }),
    '',
    dryRun ? '_Re-run with `--apply` to write the archive._' : '_Archive complete. Files are recoverable from `data/_archive/`._',
  ];
  try {
    writeFileSync(outPath, lines.join('\n'));
    log(`✓ wrote ${outPath}`);
  } catch (err) {
    log(`[warn] Could not write cache-archive log: ${err.message}`);
  }

  return { totalMoved, totalErrors, dryRun };
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  if (flags.size === 0 || flags.has('--help') || flags.has('-h')) {
    console.log(`scripts/agents/system-maintainer.mjs — SRE/maintenance sub-agent

Usage:
  node scripts/agents/system-maintainer.mjs [flags]

Flags:
  --health                System-health snapshot
  --cleanup               Reversible archive + /tmp sweep
  --review                Re-scan dashboard-server.mjs for security regressions
  --decision-doc          Consolidated force-ranked findings + Decisions Required (B4.1)
  --expand                Stub — see --help body
  --ats-watch             Stub — see --help body
  --all                   Run --health → --cleanup → --review → --decision-doc
  --archive-old-cache     Move files older than 90d from each cache dir to
                          data/_archive/<cache-dir>/ (reversible).
                          Default: dry-run. Pass --apply to write.

Always logs to data/logs/system-maintainer-<DATE>.log
`);
    process.exit(0);
  }

  log(`system-maintainer started — flags: [${[...flags].join(', ')}]`);

  let snap = null;
  let reviewFindings = null;

  if (flags.has('--all') || flags.has('--health')) {
    snap = await runHealth();
  }
  if (flags.has('--all') || flags.has('--cleanup')) {
    await runCleanup(snap);
  }
  if (flags.has('--all') || flags.has('--review')) {
    reviewFindings = await runReview();
  }
  if (flags.has('--all') || flags.has('--decision-doc')) {
    await runDecisionDoc(snap, reviewFindings);
  }
  if (flags.has('--expand')) {
    await runExpand();
  }
  if (flags.has('--ats-watch')) {
    await runAtsWatch();
  }
  if (flags.has('--archive-old-cache')) {
    // --apply means do actual renameSync; otherwise dry-run.
    const applyMode = flags.has('--apply');
    await runArchiveOldCache({ dryRun: !applyMode });
  }

  log('system-maintainer done');
}

main().catch(err => {
  log(`✗ ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
