#!/usr/bin/env node
/**
 * scripts/audit-current-queue-against-new-gates.mjs
 *
 * Backfill audit for the 2026-05-29 triage-eval quality gate work.
 *
 * Walks every row currently in data/apply-now-queue.json and re-runs:
 *   - applyHardDisqualifiers() against the row's source JD (jds/<slug>.md)
 *     OR the report text as a fallback
 *   - gateCompFloor() against the row's report (reports/<slug>.md)
 *
 * Prints summary + per-row verdict. Deterministic, $0 cost (regex only).
 *
 * Mitchell reads the summary, decides which rows to keep via
 * data/triage-overrides.json (per spec § 1+2 override mechanism).
 *
 * Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 8
 *
 * Usage:
 *   node scripts/audit-current-queue-against-new-gates.mjs
 *   node scripts/audit-current-queue-against-new-gates.mjs --verbose
 *   node scripts/audit-current-queue-against-new-gates.mjs --json
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ARGS = new Set(process.argv.slice(2));
const VERBOSE = ARGS.has('--verbose');
const JSON_OUT = ARGS.has('--json');

// In a git worktree, gitignored files like reports/*.md + apply-now-queue.json
// + jds/*.md live ONLY in the main worktree path. Detect + redirect reads to
// the main repo path when the current ROOT is empty. Without this, a fresh
// worktree branched from origin/main can't audit Mitchell's actual queue.
function resolveDataRoot() {
  if (process.env.CAREER_OPS_DATA_ROOT) return process.env.CAREER_OPS_DATA_ROOT;
  // Heuristic: if reports/ in current ROOT has < 5 .md files, we're probably
  // in a fresh worktree. Look for the main worktree path.
  try {
    const reportsHere = existsSync(join(ROOT, 'reports'))
      ? readdirSync(join(ROOT, 'reports')).filter(f => f.endsWith('.md')).length
      : 0;
    if (reportsHere >= 5) return ROOT;
    // Use git to find the main worktree
    const out = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf-8' });
    // First "worktree" entry is the main one
    const m = out.match(/worktree\s+(\S+)/);
    if (m && m[1] !== ROOT && existsSync(join(m[1], 'reports'))) {
      const mainCount = readdirSync(join(m[1], 'reports')).filter(f => f.endsWith('.md')).length;
      if (mainCount > reportsHere) {
        if (!JSON_OUT) console.error(`[audit] using main worktree for data: ${m[1]}`);
        return m[1];
      }
    }
  } catch { /* fall through */ }
  return ROOT;
}

const DATA_ROOT = resolveDataRoot();
const QUEUE_FILE = join(DATA_ROOT, 'data', 'apply-now-queue.json');

const { applyHardDisqualifiers } = await import(join(ROOT, 'lib', 'triage-hard-disqualifier-filter.mjs'));
const { gateCompFloor } = await import(join(ROOT, 'lib', 'comp-floor-gate.mjs'));

// Match the same extractor batch-runner-batches.mjs uses for parity
function extractLocationFromReport(reportText) {
  if (!reportText || typeof reportText !== 'string') return 'remote';
  const tableMatch = reportText.match(/\|\s*(?:Remote(?:\s+policy)?|Location)\s*\|\s*([^\n|]+)/i);
  const probe = tableMatch ? tableMatch[1].toLowerCase() : reportText.slice(0, 2000).toLowerCase();
  if (/\bseattle\b/.test(probe)) return 'seattle';
  if (/\bsan\s*francisco\b|\bsf\b(?!\w)|\bbay\s*area\b/.test(probe)) return 'sf';
  if (/\bnew\s*york\b|\bnyc\b|\bmanhattan\b/.test(probe)) return 'nyc';
  return 'remote';
}

function extractReportPath(reportField) {
  // "[1142](reports/1142-sierra-developer-relations-engineer-sf-2026-05-08.md)"
  if (!reportField || typeof reportField !== 'string') return null;
  const m = reportField.match(/\(([^)]+\.md)\)/);
  return m ? m[1] : null;
}

function safeReadFile(relPath) {
  if (!relPath) return '';
  // Try DATA_ROOT first (main worktree if we're in a fresh one), fall back to ROOT
  const candidates = [join(DATA_ROOT, relPath), join(ROOT, relPath)];
  for (const full of candidates) {
    if (existsSync(full)) {
      try {
        return readFileSync(full, 'utf-8');
      } catch { /* try next */ }
    }
  }
  return '';
}

// Try to find a JD .md file matching the row's report slug.
// Naming convention: jds/<num>-<slug>.md or jds/<slug>.md (varies historically).
function findJdText(row, reportPath) {
  if (reportPath) {
    // reports/1142-sierra-developer-relations-engineer-sf-2026-05-08.md →
    // try jds/1142-sierra-developer-relations-engineer-sf-2026-05-08.md
    const candidate = reportPath.replace(/^reports\//, 'jds/');
    const jdText = safeReadFile(candidate);
    if (jdText) return { text: jdText, source: candidate };
  }
  // Fallback: scan jds/ for a file containing the slug
  return { text: '', source: null };
}

function summarizeViolations(violations) {
  if (!violations || violations.length === 0) return '';
  return violations.join(', ');
}

function main() {
  if (!existsSync(QUEUE_FILE)) {
    console.error(`ERROR: queue file not found at ${QUEUE_FILE}`);
    process.exit(2);
  }

  const queue = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  const rows = queue.ranked || [];

  const results = {
    total: rows.length,
    would_skip_hard_dq: [],
    would_demote_comp: [],
    unknown_comp: [],
    would_pass: [],
    no_report: [],
  };

  for (const row of rows) {
    const reportPath = extractReportPath(row.report);
    const reportText = safeReadFile(reportPath);
    if (!reportText) {
      results.no_report.push({ num: row.num, company: row.company, role: row.role, reason: `report not found: ${reportPath || '(no path)'}` });
      continue;
    }

    // 1) Hard-disqualifier check — prefer JD text but fall back to report
    //    body (which contains JD excerpts in CV Match section)
    const jdLookup = findJdText(row, reportPath);
    const filterSource = jdLookup.text || reportText;
    const archetype = row.archetype || (row.factors?.tier === 'A2a' ? 'A2a' : null);
    const dq = applyHardDisqualifiers({ jdText: filterSource, archetype, rowNum: row.num });

    // 2) Comp-floor gate
    const location = extractLocationFromReport(reportText);
    const comp = gateCompFloor({ reportText, location, rowNum: row.num });

    const rowSummary = {
      num: row.num,
      company: row.company,
      role: row.role,
      score: row.eval_score,
      location,
      filter_source: jdLookup.source || `${reportPath} (report fallback)`,
    };

    if (dq.decision === 'SKIP' && !dq.disabled && !dq.overridden) {
      results.would_skip_hard_dq.push({ ...rowSummary, violations: summarizeViolations(dq.violations) });
    } else if (comp.gate === 'BELOW_FLOOR' && !comp.disabled && !comp.overridden) {
      results.would_demote_comp.push({ ...rowSummary, comp_note: comp.note, baseLow: comp.baseLow, floor: comp.floor });
    } else if (comp.gate === 'unknown') {
      results.unknown_comp.push({ ...rowSummary, reason: 'no extractable comp in report' });
    } else {
      results.would_pass.push(rowSummary);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Human-readable summary
  console.log(`\n=== Backfill audit — apply-now-queue × new gates ===`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Spec: data/spec-triage-eval-quality-gate-2026-05-29.md`);
  console.log(`Total ranked rows scanned: ${results.total}`);
  console.log('');
  console.log(`  🛑 Would SKIP via hard-disqualifier:  ${results.would_skip_hard_dq.length}`);
  console.log(`  ⬇️  Would DEMOTE for comp-below-floor: ${results.would_demote_comp.length}`);
  console.log(`  ❓ Comp UNKNOWN (no auto-demote):     ${results.unknown_comp.length}`);
  console.log(`  ✅ Would PASS all gates:               ${results.would_pass.length}`);
  console.log(`  ⚠️  Report missing on disk:            ${results.no_report.length}`);
  console.log('');

  if (results.would_skip_hard_dq.length > 0) {
    console.log(`--- Hard-disqualifier SKIP candidates (review for override) ---`);
    for (const r of results.would_skip_hard_dq) {
      console.log(`  #${r.num} ${r.company} (${r.score}) — ${r.role}`);
      console.log(`     violations: ${r.violations}`);
      if (VERBOSE) console.log(`     filter source: ${r.filter_source}`);
    }
    console.log('');
  }

  if (results.would_demote_comp.length > 0) {
    console.log(`--- Comp-below-floor DEMOTE candidates (review for override) ---`);
    for (const r of results.would_demote_comp) {
      const floorK = Math.round(r.floor / 1000);
      const baseLowK = r.baseLow ? Math.round(r.baseLow / 1000) : '?';
      console.log(`  #${r.num} ${r.company} (${r.score}) — ${r.role}  [${r.location} floor $${floorK}k, found $${baseLowK}k]`);
    }
    console.log('');
  }

  if (results.unknown_comp.length > 0 && VERBOSE) {
    console.log(`--- Comp UNKNOWN (surfaced for human review, no auto-action) ---`);
    for (const r of results.unknown_comp) {
      console.log(`  #${r.num} ${r.company} (${r.score}) — ${r.role}`);
    }
    console.log('');
  }

  if (results.no_report.length > 0) {
    console.log(`--- Reports missing on disk (gates could not be re-evaluated) ---`);
    for (const r of results.no_report) {
      console.log(`  #${r.num} ${r.company} — ${r.reason}`);
    }
    console.log('');
  }

  console.log('--- Override mechanism ---');
  console.log(`To bypass a gate for a specific row, append to data/triage-overrides.json::overrides:`);
  console.log(`  { "rowNum": <num>, "gate": "hard-disqualifier" | "comp-floor", "reason": "<why>", "addedAt": "${new Date().toISOString().slice(0,10)}" }`);
  console.log('');
  console.log('Exit code: 0 (audit is informational; gates do not run here)');
}

main();
