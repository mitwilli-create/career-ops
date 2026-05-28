#!/usr/bin/env node
// scripts/persona-monthly-review.mjs
//
// Wave 3 task 12 of 14. Final persona-system deliverable. Manual-trigger
// CLI that reads the trailing-30-day findings ledger, groups by persona,
// computes occurrence stats per persona, and writes a NEEDS-APPROVAL
// omega-proposal for Mitchell to review.
//
// Per locked decision #8: precision <30% → demote-to-opt-in proposal;
// precision >60% → keep-standing proposal; 30-60% → hold-current-authority-
// for-one-more-month per locked Q9.
//
// CURRENT v1 SCOPE (2026-05-28): emits counts + severity distribution per
// persona. The "precision" metric (correctness of each finding) requires
// human-in-the-loop confirmation against bug-ledger.jsonl outcomes — that
// correlation logic is deferred to v1.1 when the system has ≥30 days of
// real findings to validate the algorithm. For now Mitchell reviews each
// persona manually via the omega-approval workflow.
//
// CLI:
//   node scripts/persona-monthly-review.mjs
//     [--window-days 30]
//     [--min-findings 5]   (skip personas with fewer findings)
//     [--dry-run]          (print to stdout, don't write proposal file)
//     [--json]             (emit JSON instead of markdown)
//
// Output (when not --dry-run): data/persona-monthly-review-<DATE>.md
// (gitignored personal data per .gitignore extension shipped Wave 1 Task 4)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const FINDINGS_LEDGER = join(REPO_ROOT, 'data', 'persona-findings.jsonl');
const OUTPUT_DIR = join(REPO_ROOT, 'data');

function parseArgs(argv) {
  const out = { windowDays: 30, minFindings: 5, dryRun: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window-days') out.windowDays = parseInt(argv[++i], 10) || 30;
    else if (a === '--min-findings') out.minFindings = parseInt(argv[++i], 10) || 5;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/persona-monthly-review.mjs [--window-days 30] [--min-findings 5] [--dry-run] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function aggregateLedger({ windowDays, minFindings }) {
  if (!existsSync(FINDINGS_LEDGER)) {
    return { perPersona: {}, totalFindings: 0, ledgerExists: false };
  }
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const perPersona = {};
  let totalFindings = 0;

  const raw = readFileSync(FINDINGS_LEDGER, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec) continue;
    const ts = Date.parse(rec.first_seen || rec.last_updated || rec.date || '');
    if (Number.isFinite(ts) && ts < cutoff) continue;

    const persona = String(rec.persona || 'unknown');
    if (!perPersona[persona]) {
      perPersona[persona] = {
        persona,
        findings_count: 0,
        severity_distribution: { HIGH: 0, MED: 0, LOW: 0 },
        bug_classes: new Set(),
        phases: new Set(),
      };
    }
    const p = perPersona[persona];
    p.findings_count++;
    totalFindings++;
    const sev = String(rec.severity || 'LOW').toUpperCase();
    p.severity_distribution[sev] = (p.severity_distribution[sev] || 0) + 1;
    if (rec.bug_class) p.bug_classes.add(rec.bug_class);
    if (rec.phase) p.phases.add(rec.phase);
  }

  // Filter to min-findings + convert Sets to arrays for output
  const filtered = {};
  for (const [persona, stats] of Object.entries(perPersona)) {
    if (stats.findings_count < minFindings) continue;
    filtered[persona] = {
      ...stats,
      bug_classes: Array.from(stats.bug_classes).sort(),
      phases: Array.from(stats.phases).sort(),
    };
  }

  return { perPersona: filtered, totalFindings, ledgerExists: true };
}

function renderMarkdown({ perPersona, totalFindings, ledgerExists, windowDays, minFindings, allPersonaRecords }) {
  const date = new Date().toISOString().slice(0, 10);
  const personaNames = Object.keys(perPersona);

  const lines = [
    '---',
    'title: Persona Monthly Review (NEEDS-APPROVAL)',
    `date: ${date}`,
    `window_days: ${windowDays}`,
    `min_findings_threshold: ${minFindings}`,
    'classification: "[PERSONAL — DO NOT PUBLISH]"',
    'source: scripts/persona-monthly-review.mjs',
    `personas_reviewed: ${personaNames.length}`,
    `total_findings: ${totalFindings}`,
    'status: NEEDS-APPROVAL',
    '---',
    '',
    '# Persona Monthly Review',
    '',
    `**Window:** trailing ${windowDays} days · **Findings:** ${totalFindings} ·`,
    `**Personas with ≥${minFindings} findings:** ${personaNames.length}`,
    '',
    !ledgerExists
      ? '⚠️ No findings ledger at `data/persona-findings.jsonl` — the persona-system has not yet generated findings. Re-run after first /deploy-verify Phase 3.5 invocation.'
      : '',
    '',
    '## Locked decision #8 + Q9 recap',
    '',
    'Per interview lock:',
    '- Precision **<30%** → auto-demote persona to **opt-in** status',
    '- Precision **>60%** → persona stays **standing** with current authority',
    '- Precision **30-60%** → **hold current authority for one more month**, re-evaluate',
    '',
    '**Note (v1, 2026-05-28):** automated precision computation requires correlating each persona finding against a confirmed bug-ledger outcome. That correlation logic is deferred to v1.1. For v1, Mitchell reviews each persona\'s findings sample below and decides manually via the omega-approval workflow.',
    '',
    '## Per-persona summary',
    '',
    '| Persona | Findings | HIGH | MED | LOW | Distinct bug_classes | Phases |',
    '|---|---|---|---|---|---|---|',
    ...Object.values(perPersona).map(p => [
      p.persona,
      p.findings_count,
      p.severity_distribution.HIGH || 0,
      p.severity_distribution.MED || 0,
      p.severity_distribution.LOW || 0,
      p.bug_classes.length,
      p.phases.join(', '),
    ].join(' | ')),
    '',
    '## Mitchell review checklist',
    '',
    'For each persona above:',
    '1. Sample 5-10 findings from `data/persona-findings.jsonl` (filter by persona)',
    '2. Decide for each: was the finding correct? (real bug, real risk?)',
    '3. Estimate precision (correct / total)',
    '4. Append decision to `data/omega-approvals.md`:',
    '   - `APPROVE persona/<name>/keep-standing` if precision >60%',
    '   - `APPROVE persona/<name>/hold-one-month` if precision 30-60%',
    '   - `APPROVE persona/<name>/demote-to-opt-in` if precision <30%',
    '',
    '## Personas below ' + minFindings + '-findings threshold',
    '',
    'These personas had <' + minFindings + ' findings in window; insufficient signal to review:',
    '',
    ...(allPersonaRecords
      .filter(p => !perPersona[p.name])
      .map(p => `- ${p.name} (status: ${p.status}, authority: ${p.blockingAuthority})`)),
  ].filter(l => l !== '');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const aggregate = aggregateLedger(args);

  // Load all persona records for the "below threshold" section
  const { allPersonas } = await import('../lib/council-personas.mjs');
  const allRecords = allPersonas();

  if (args.json) {
    console.log(JSON.stringify({ ...aggregate, allPersonas: allRecords.map(p => p.name) }, null, 2));
    process.exit(0);
  }

  const md = renderMarkdown({
    ...aggregate,
    windowDays: args.windowDays,
    minFindings: args.minFindings,
    allPersonaRecords: allRecords,
  });

  if (args.dryRun) {
    console.log(md);
    process.exit(0);
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(OUTPUT_DIR, `persona-monthly-review-${date}.md`);
  writeFileSync(path, md);
  console.log(JSON.stringify({
    ok: true,
    path,
    personas_reviewed: Object.keys(aggregate.perPersona).length,
    total_findings: aggregate.totalFindings,
  }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(1);
});
