#!/usr/bin/env node
/**
 * tests/applications-column-integrity-invariant.test.mjs
 *
 * 2026-07-06 — Invariant test that fails CI if any data row in
 * `data/applications.md` has a corrupted STRUCTURAL column count — i.e. an
 * unescaped `|` in a company/role string shifted the fixed front columns
 * (num / date / score / status), OR a non-row (e.g. a leaked triage-skip)
 * was written as a row.
 *
 * NOTE-AWARE by construction: pipes in the trailing notes column are legit
 * (batch-runner-batches.mjs emits `field | field | field` notes on purpose;
 * ~114 rows carry a `| triage X.X/5` suffix). The validator splits on
 * UNESCAPED pipes and only type-checks num/date/score/status positions, so
 * note pipes and backslash-escaped role pipes both pass.
 *
 * The TRIPWIRE. Any future PR that touches an applications.md writer
 * (triage.mjs / merge-tracker.mjs / batch-runner-batches.mjs /
 * dedup-tracker.mjs / normalize-statuses.mjs / rebuild-apply-now-queue.mjs)
 * must keep this green. Root cause + fix: docs/BUG-CLASSES.md §
 * pipeline-ingest-format-drift.
 *
 * Exit codes:
 *   0 — clean (or applications.md absent — CI / fresh setup)
 *   2 — malformed row(s) found (prints offending rows so the operator can act)
 *
 * Real-data path resolution (in priority order):
 *   1. $CAREER_OPS_DATA_ROOT/applications.md   (run against the main tree from a worktree)
 *   2. <repo>/data/applications.md
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateTrackerRow, isTrackerDataRow, escapeTableCell } from '../lib/tracker-row.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_PATH = process.env.CAREER_OPS_DATA_ROOT
  ? join(process.env.CAREER_OPS_DATA_ROOT, 'applications.md')
  : join(ROOT, 'data', 'applications.md');

let failures = 0;
const fail = (m) => { console.log(`  ❌ ${m}`); failures++; };
const ok = (m) => console.log(`  ✅ ${m}`);

// ── Part A: hermetic fixtures (always run, CI-safe) ──────────────────────
// Clean rows + the two 2026-07-06 leak shapes + note-pipe + escaped-role.
const CLEAN = '| 2547 | 2026-05-29 | Ramp | AI Operations Specialist, Agentic Workflows | 4.4/5 | Evaluated | ❌ | [1046](reports/1046-ramp-2026-05-29.md) | Re-eval. |';
const NOTE_PIPES = '| 2535 | 2026-07-07 | Ramp | AI Operations Specialist | 4.5/5 | Discarded | ❌ | [1030](reports/1030-ramp.md) | Re-eval (4.3→4.5). Internal AI enablement… | triage 4.3/5 |';
const NA_SCORE = '| 2590 | 2026-05-27 | Celonis | Senior Applied AI Solutions Architect | N/A | Discarded | ❌ | [2554](reports/2554-celonis.md) | LINK EXPIRED. |';
// Leak 1: unescaped pipe in role shifts score into a text cell.
const LEAK_ROLE_PIPE = '| 2535 | 2026-07-07 | Ramp | AI Operations Specialist | Agentic Workflows | 4.5/5 | Discarded | ❌ | [1030](reports/1030-ramp.md) | note |';
// Leak 2: a triage-skip log line merged as a row (columns shifted, "date" = company).
const LEAK_SKIP_ROW = '| 2756 | celonis | — | SKIP | ❌ | Evaluated | — | score 1.2/5 < threshold 4.2 | dead |';
// Post-fix: escaping the role pipe → `\|` keeps the columns aligned.
const FIXED_ROLE = `| 2535 | 2026-07-07 | Ramp | ${escapeTableCell('AI Operations Specialist | Agentic Workflows')} | 4.5/5 | Discarded | ❌ | [1030](reports/1030-ramp.md) | note |`;
// Leak 1b: unescaped pipe in COMPANY (not just role) also shifts columns.
const LEAK_COMPANY_PIPE = '| 2600 | 2026-07-07 | Acme | Corp | Solutions Architect | 4.2/5 | Evaluated | ❌ | [1099](reports/1099-acme.md) | note |';
// A legit row whose NOTES contain "---" must still be scanned + pass — guards the
// isTrackerDataRow false negative: a substring "---" is not a table separator.
const NOTES_WITH_DASHES = '| 2601 | 2026-07-07 | Acme | Solutions Architect | 4.2/5 | Evaluated | ❌ | [1100](reports/1100-acme.md) | span 2010---2012, see report |';

// The "---"-in-notes row must be recognized as a DATA row (not skipped as a separator).
if (isTrackerDataRow(NOTES_WITH_DASHES)) ok('isTrackerDataRow: notes containing "---" is still a data row');
else fail('isTrackerDataRow: a data row with "---" in notes was wrongly skipped (false negative)');

for (const [label, line, expectOk] of [
  ['clean row passes', CLEAN, true],
  ['note-pipe (| triage X/5) row passes', NOTE_PIPES, true],
  ['N/A score passes', NA_SCORE, true],
  ['escaped-role pipe (\\|) passes', FIXED_ROLE, true],
  ['notes containing "---" passes', NOTES_WITH_DASHES, true],
  ['unescaped role pipe FLAGGED (leak #2535)', LEAK_ROLE_PIPE, false],
  ['unescaped company pipe FLAGGED', LEAK_COMPANY_PIPE, false],
  ['leaked triage-skip row FLAGGED (leak #2756)', LEAK_SKIP_ROW, false],
]) {
  const res = validateTrackerRow(line);
  if (res.ok === expectOk) ok(`fixture: ${label}`);
  else fail(`fixture: ${label} — got ${JSON.stringify(res)}`);
}

// escapeTableCell must actually neutralize the pipe AND be idempotent.
if (escapeTableCell('a | b') === 'a \\| b') ok('escapeTableCell escapes an unescaped pipe');
else fail(`escapeTableCell('a | b') = ${JSON.stringify(escapeTableCell('a | b'))}`);
if (escapeTableCell('a \\| b') === 'a \\| b') ok('escapeTableCell is idempotent on \\|');
else fail(`escapeTableCell not idempotent: ${JSON.stringify(escapeTableCell('a \\| b'))}`);

// ── Part B: scan the live applications.md (skips gracefully if absent) ────
if (!existsSync(APPS_PATH)) {
  console.log(`  ⏭️  applications.md not present at ${APPS_PATH} — skipping live scan (CI / fresh setup)`);
} else {
  const lines = readFileSync(APPS_PATH, 'utf-8').split('\n');
  const offenders = [];
  let rows = 0;
  for (const line of lines) {
    if (!isTrackerDataRow(line)) continue;
    rows++;
    const res = validateTrackerRow(line);
    if (!res.ok) offenders.push({ line: line.slice(0, 160), reason: res.reason });
  }
  if (offenders.length === 0) {
    ok(`live scan: all ${rows} applications.md data rows structurally valid`);
  } else {
    fail(`live scan: ${offenders.length}/${rows} malformed applications.md rows`);
    for (const o of offenders.slice(0, 20)) {
      console.log(`     • ${o.reason}`);
      console.log(`       ${o.line}…`);
    }
    console.log('     → Fix: escape the offending company/role pipe (\\|) or remove the leaked non-row.');
  }
}

console.log('');
if (failures > 0) {
  console.log(`🔴 applications.md column-integrity invariant VIOLATED (${failures})`);
  process.exit(2);
}
console.log('🟢 applications.md column-integrity invariant clean');
process.exit(0);
