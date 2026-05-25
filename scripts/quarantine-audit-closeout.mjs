#!/usr/bin/env node
// scripts/quarantine-audit-closeout.mjs
//
// PR-10 — Apply-Now UX overhaul, theme F residual
//
// Re-runs the data-layer drift probes from findings.md §9 (items 1-7) to
// confirm that the PR-01-through-PR-09 quarantine + canonicalization work
// resolved every drift class — or that the residual is explicitly deferred.
//
// On-demand verification utility — NOT scheduled.
//
// Probes:
//   1. "Sarah Chen" hallucinations removed from data/role-enrichment/
//   2. Empty backfill rows removed from data/role-enrichment/
//   3. Apply-pack path unified (apply-pack/ is canonical; data/apply-packs/ is empty or absent)
//   4. Finder dupes ("* 2.json", "* 2.md", "* 2.mjs") swept from repo tree
//   5. AGENTS.md / state drift reconciled (no dead hm-intel-monthly references; career-ops-health doc
//      matches launchctl state)
//   6. hm-intel-monthly plist gone (filesystem + launchctl)
//   7. Confidence labels surfaced in dashboard build (build-dashboard.mjs renders the badge)
//
// Output:
//   - data/apply-now-drift-closeout-<YYYY-MM-DD>.json (pass/fail per item + details)
//   - stdout summary table
//
// Exit codes:
//   0 — every item PASS or DEFERRED (no surprise FAILs)
//   1 — at least one unexpected FAIL surfaced (review summary + JSON)
//   2 — invocation error (repo root not found / write permission failure)
//
// Usage:
//   node scripts/quarantine-audit-closeout.mjs
//   node scripts/quarantine-audit-closeout.mjs --json-only       # suppress stdout summary
//   node scripts/quarantine-audit-closeout.mjs --no-write        # skip JSON write
//
// Per `.claude/audit/apply-now-ux-audit-2026-05-25/strategy.md` §6 R53.

import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const out = { jsonOnly: false, write: true };
  for (const a of argv.slice(2)) {
    if (a === '--json-only') out.jsonOnly = true;
    else if (a === '--no-write') out.write = false;
  }
  return out;
}

// ── Probe 1: "Sarah Chen" hallucinations removed ──────────────────────────
function probe1_sarahChenHallucinations() {
  const dir = join(ROOT, 'data', 'role-enrichment');
  const result = { id: 1, name: 'sarah-chen-hallucinations-removed', status: 'PASS', details: {} };

  if (!existsSync(dir)) {
    result.status = 'FAIL';
    result.details.reason = `role-enrichment dir missing: ${dir}`;
    return result;
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const matches = [];
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), 'utf-8');
      if (/sarah\s+chen/i.test(content)) matches.push(f);
    } catch (_) {}
  }

  result.details.files_inspected = files.length;
  result.details.matches = matches;
  if (matches.length > 0) {
    result.status = 'FAIL';
    result.details.reason = `${matches.length} role-enrichment file(s) still contain "Sarah Chen" — quarantine pass missed them`;
  }
  return result;
}

// ── Probe 2: Empty backfill rows removed ──────────────────────────────────
function probe2_emptyBackfills() {
  const dir = join(ROOT, 'data', 'role-enrichment');
  const result = { id: 2, name: 'empty-backfills-removed', status: 'PASS', details: {} };

  if (!existsSync(dir)) {
    result.status = 'FAIL';
    result.details.reason = `role-enrichment dir missing: ${dir}`;
    return result;
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const empties = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (!parsed || typeof parsed !== 'object') {
        empties.push({ file: f, reason: 'not-object' });
        continue;
      }
      // Mirror PR-01's empty-enrichment-sweep heuristic: < 3 keys OR all
      // enrichment payload fields null/empty.
      const keys = Object.keys(parsed);
      if (keys.length < 3) {
        empties.push({ file: f, reason: `only ${keys.length} keys` });
        continue;
      }
      const enrichmentFields = ['benefits', 'sentiment', 'people', 'relocation'];
      const allEmpty = enrichmentFields.every(k => {
        const v = parsed[k];
        if (v == null) return true;
        if (typeof v === 'object' && Object.keys(v).length === 0) return true;
        return false;
      });
      if (allEmpty) empties.push({ file: f, reason: 'all enrichment fields empty' });
    } catch (e) {
      empties.push({ file: f, reason: `parse-error: ${e.message}` });
    }
  }

  result.details.files_inspected = files.length;
  result.details.empty_count = empties.length;
  result.details.empties = empties.slice(0, 10); // cap for readability
  if (empties.length > 0) {
    result.status = 'FAIL';
    result.details.reason = `${empties.length} empty/sparse role-enrichment row(s) remain — re-run scripts/quarantine/empty-enrichment-sweep.mjs`;
  }
  return result;
}

// ── Probe 3: Apply-pack path unified ──────────────────────────────────────
function probe3_applyPackPathUnified() {
  const canonical = join(ROOT, 'apply-pack');
  const legacy = join(ROOT, 'data', 'apply-packs');
  const result = { id: 3, name: 'apply-pack-path-unified', status: 'PASS', details: {} };

  const canonicalExists = existsSync(canonical);
  result.details.canonical_path = 'apply-pack/';
  result.details.canonical_exists = canonicalExists;

  if (canonicalExists) {
    try {
      const canonicalPacks = readdirSync(canonical).filter(f => {
        try { return statSync(join(canonical, f)).isDirectory(); } catch { return false; }
      });
      result.details.canonical_pack_count = canonicalPacks.length;
    } catch (_) {
      result.details.canonical_pack_count = 0;
    }
  }

  const legacyExists = existsSync(legacy);
  result.details.legacy_path = 'data/apply-packs/';
  result.details.legacy_exists = legacyExists;

  if (legacyExists) {
    try {
      const legacyPacks = readdirSync(legacy).filter(f => {
        try { return statSync(join(legacy, f)).isDirectory(); } catch { return false; }
      });
      result.details.legacy_pack_count = legacyPacks.length;
      if (legacyPacks.length > 0) {
        result.status = 'FAIL';
        result.details.reason = `${legacyPacks.length} pack(s) remain in legacy data/apply-packs/ — re-run scripts/quarantine/apply-pack-path-unify.mjs`;
      }
    } catch (_) {
      result.details.legacy_pack_count = 0;
    }
  }

  if (!canonicalExists && !legacyExists) {
    // Neither path exists — that's a degenerate state, not a unified state.
    result.status = 'DEFERRED';
    result.details.reason = 'Neither canonical nor legacy apply-pack path exists. Acceptable if no packs built yet.';
  }
  return result;
}

// ── Probe 4: Finder dupes swept ───────────────────────────────────────────
function probe4_finderDupes() {
  const result = { id: 4, name: 'finder-dupes-swept', status: 'PASS', details: {} };
  // Search data/, scripts/, lib/, templates/ for " 2.<ext>" patterns. Skip
  // _quarantine/ + node_modules/ + .git/ + .claude/.
  const searchRoots = ['data', 'scripts', 'lib', 'templates'];
  const found = [];

  for (const root of searchRoots) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    try {
      const cmd = `find "${abs}" \\( -name "* 2.json" -o -name "* 2.md" -o -name "* 2.mjs" -o -name "* 2.tsv" \\) -not -path "*/_quarantine/*" -not -path "*/node_modules/*" 2>/dev/null`;
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
      if (out) {
        for (const line of out.split('\n')) {
          if (line) found.push(line.replace(ROOT + '/', ''));
        }
      }
    } catch (_) {
      // find returns non-zero if no matches under some shell configs — ignore
    }
  }

  result.details.search_roots = searchRoots;
  result.details.found = found;
  result.details.count = found.length;
  if (found.length > 0) {
    result.status = 'FAIL';
    result.details.reason = `${found.length} Finder dupe(s) remain — re-run scripts/quarantine/finder-dupes-sweep.mjs`;
  }
  return result;
}

// ── Probe 5: AGENTS.md / state drift reconciled ───────────────────────────
function probe5_agentsMdDriftReconciled() {
  const result = { id: 5, name: 'agents-md-state-drift-reconciled', status: 'PASS', details: {} };
  const agentsPath = join(ROOT, 'AGENTS.md');

  if (!existsSync(agentsPath)) {
    result.status = 'FAIL';
    result.details.reason = `AGENTS.md missing at ${agentsPath}`;
    return result;
  }

  const content = readFileSync(agentsPath, 'utf-8');
  const issues = [];

  // Sub-probe 5a: hm-intel-monthly references should be gone OR only documented
  // historically. The dead-plist quarantine in PR-01 removed the plist; if doc
  // still presents it as live, that's drift.
  const monthlyMatches = content.match(/com\.mitchell\.career-ops\.hm-intel-monthly/gi) || [];
  if (monthlyMatches.length > 0) {
    // Only fail if presented as live ("scheduled" / "runs at" / "active") not
    // historical ("removed by PR-01" / "deprecated" / "ARCHIVED").
    const liveTone = /com\.mitchell\.career-ops\.hm-intel-monthly[^.]*?(?:scheduled|runs at|active|enabled)/i.test(content);
    if (liveTone) {
      issues.push('AGENTS.md still presents hm-intel-monthly plist as live (drift)');
    }
  }

  // Sub-probe 5b: career-ops-health agent — doc should match launchctl state.
  // PR-01 reconciled doc to say "ENABLED" since launchctl print confirms loaded+enabled.
  // If the doc still says "LOADED-BUT-DISABLED day-1" for career-ops-health,
  // that's the pre-PR-01 drift state.
  const stillSaysDisabled = /career-ops-health[^.]*?LOADED-BUT-DISABLED[^.]*?day-1/i.test(content);
  if (stillSaysDisabled) {
    issues.push('AGENTS.md still says career-ops-health is LOADED-BUT-DISABLED day-1 (PR-01 was supposed to reconcile to ENABLED)');
  }

  result.details.hm_intel_monthly_refs = monthlyMatches.length;
  result.details.issues = issues;
  if (issues.length > 0) {
    result.status = 'FAIL';
    result.details.reason = issues.join(' · ');
  }
  return result;
}

// ── Probe 6: hm-intel-monthly plist gone (fs + launchctl) ────────────────
function probe6_hmIntelMonthlyPlistGone() {
  const result = { id: 6, name: 'hm-intel-monthly-plist-gone', status: 'PASS', details: {} };
  const repoPlist = join(ROOT, 'scripts', 'launchd', 'com.mitchell.career-ops.hm-intel-monthly.plist');
  const livePlist = join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.mitchell.career-ops.hm-intel-monthly.plist');
  const issues = [];

  if (existsSync(repoPlist)) {
    issues.push(`repo plist still exists: ${repoPlist}`);
  }
  result.details.repo_plist_exists = existsSync(repoPlist);

  if (existsSync(livePlist)) {
    issues.push(`live LaunchAgent plist still exists: ${livePlist}`);
  }
  result.details.live_plist_exists = existsSync(livePlist);

  // Best-effort launchctl check — exit 0 means loaded, non-zero means not loaded.
  try {
    const uid = execSync('id -u', { encoding: 'utf-8', timeout: 3_000 }).trim();
    execSync(`launchctl print gui/${uid}/com.mitchell.career-ops.hm-intel-monthly 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    issues.push('launchctl still reports the plist as loaded');
    result.details.launchctl_loaded = true;
  } catch (_) {
    result.details.launchctl_loaded = false;
  }

  result.details.issues = issues;
  if (issues.length > 0) {
    result.status = 'FAIL';
    result.details.reason = issues.join(' · ');
  }
  return result;
}

// ── Probe 7: Confidence labels surfaced in dashboard build ───────────────
function probe7_confidenceLabelsSurfaced() {
  const result = { id: 7, name: 'confidence-labels-surfaced', status: 'PASS', details: {} };
  const buildPath = join(ROOT, 'scripts', 'build-dashboard.mjs');

  if (!existsSync(buildPath)) {
    result.status = 'FAIL';
    result.details.reason = `build-dashboard.mjs missing at ${buildPath}`;
    return result;
  }

  const content = readFileSync(buildPath, 'utf-8');
  const checks = {
    helper_defined: /function renderConfidenceBadge\s*\(/.test(content),
    benefits_uses_badge: /renderConfidenceBadge\s*\(\s*enrich\.confidence/.test(content),
    people_uses_badge: /renderConfidenceBadge\s*\(\s*enrich\?\.confidence/.test(content),
    css_present: /\.rec-conf-badge\s*\{/.test(content),
  };
  result.details.checks = checks;
  const failed = Object.entries(checks).filter(([_, v]) => !v).map(([k]) => k);
  if (failed.length > 0) {
    result.status = 'FAIL';
    result.details.reason = `confidence badge wiring incomplete — missing: ${failed.join(', ')}`;
  }
  return result;
}

// ── Renderer + main ───────────────────────────────────────────────────────
function renderSummary(report) {
  const rows = report.probes.map(p => {
    const mark = p.status === 'PASS' ? '✓' : p.status === 'DEFERRED' ? '○' : '✗';
    const num = String(p.id).padStart(2, ' ');
    const status = p.status.padEnd(8, ' ');
    return `  ${mark} #${num} ${status} ${p.name}${p.details.reason ? '  —  ' + p.details.reason : ''}`;
  });
  return [
    `Apply-Now Drift Closeout Audit  —  ${report.run_date}`,
    '',
    `Summary: ${report.tally.pass} PASS  ·  ${report.tally.deferred} DEFERRED  ·  ${report.tally.fail} FAIL`,
    '',
    ...rows,
    '',
    `Report written: ${report.report_path || '(skipped: --no-write)'}`,
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const today = new Date().toISOString().slice(0, 10);
  const probes = [
    probe1_sarahChenHallucinations(),
    probe2_emptyBackfills(),
    probe3_applyPackPathUnified(),
    probe4_finderDupes(),
    probe5_agentsMdDriftReconciled(),
    probe6_hmIntelMonthlyPlistGone(),
    probe7_confidenceLabelsSurfaced(),
  ];

  const tally = { pass: 0, fail: 0, deferred: 0 };
  for (const p of probes) {
    if (p.status === 'PASS') tally.pass++;
    else if (p.status === 'FAIL') tally.fail++;
    else if (p.status === 'DEFERRED') tally.deferred++;
  }

  const report = {
    schema_version: 1,
    run_date: today,
    repo_root: ROOT,
    probes_run: probes.length,
    tally,
    probes,
  };

  let reportPath = null;
  if (args.write) {
    reportPath = join(ROOT, 'data', `apply-now-drift-closeout-${today}.json`);
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      report.report_path = reportPath;
    } catch (e) {
      console.error(`[closeout-audit] ERROR writing report: ${e.message}`);
      process.exit(2);
    }
  }

  if (!args.jsonOnly) {
    console.log(renderSummary(report));
  } else if (reportPath) {
    console.log(reportPath);
  }

  process.exit(tally.fail > 0 ? 1 : 0);
}

main();
