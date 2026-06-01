import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractGatesFromReport } from '../../lib/decision-provenance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'reports');

// ── GATE 1.2 (2026-05-31) — STRICT verdict classification ─────────────────────
// A gate enters gates_passed ("JD must-haves you cleanly hit") ONLY when its
// verdict cell is an explicit clean token. MONITOR / N/A / PARTIAL / SOFT /
// em-dash / hyphen / LEARNING / NONE must NEVER appear as cleanly hit.

const CLEAN = new Set(['PASS', 'NO', 'CLEAR', 'MET', 'CLEAN', 'OK']);
const VERDICT_CLASS = {
  PASS: 'clean', NO: 'clean', CLEAR: 'clean', MET: 'clean', CLEAN: 'clean', OK: 'clean',
  YES: 'fired', FIRED: 'fired', FIRES: 'fired',
  MONITOR: 'skip', 'N/A': 'skip', NA: 'skip', PARTIAL: 'skip', SOFT: 'skip',
  LEARNING: 'skip', NONE: 'skip', '—': 'skip', '-': 'skip',
};
function normCell(c) {
  return (c || '').replace(/\*/g, '').replace(/[✅⚠️🟡🟢🔴🟠❌✓✗√🚩❗]/gu, '').trim().toUpperCase();
}
// Independently resolve a gate's verdict CLASS from a report's raw text by
// scanning every cell of its row (format-agnostic — Format A col3 OR Format B
// col2). Returns 'clean' | 'fired' | 'skip' | null.
function resolveVerdictClass(text, gid) {
  for (const line of text.split('\n')) {
    const mm = line.match(new RegExp('^\\s*\\|\\s*' + gid + '\\b'));
    if (!mm) continue;
    const cells = line.split('|').map(c => c.trim());
    for (let i = 1; i < cells.length; i++) {
      const cls = VERDICT_CLASS[normCell(cells[i])];
      if (cls) return cls;
    }
  }
  return null;
}

// Format A: `| Gate | Condition | Fires? | Reason |` (verdict in col3).
function tbl(rows) {
  return [
    '## Bloque H — Gate Check',
    '',
    '| Gate | Condition | Fires? | Reason |',
    '|------|-----------|--------|--------|',
    ...rows,
    '',
  ].join('\n');
}
// Format B: `| Gate | Verdict | Rationale |` (verdict in col2, ✅/⚠️ decorated).
function tblB(rows) {
  return [
    '**Gate verdicts (H1–H12):**',
    '',
    '| Gate | Verdict | Rationale |',
    '|------|---------|-----------|',
    ...rows,
    '',
  ].join('\n');
}

test('clean verdicts (PASS/NO/CLEAR/MET) enter gates_passed', () => {
  const text = tbl([
    '| H1 — Python Primary | cond | **NO** | not required |',
    '| H2 — ML Stack | cond | **PASS** | covered |',
    '| H3 — FDE Title | cond | **CLEAR** | n/a here |',
    '| H4 — Customer-facing | cond | **MET** | strong proof |',
  ]);
  const g = extractGatesFromReport(text);
  assert.deepEqual([...g.gates_passed].sort(), ['H1', 'H2', 'H3', 'H4']);
  assert.equal(g.gates_failed.length, 0);
});

test('non-clean verdicts (MONITOR/N-A/PARTIAL/SOFT/dash) are EXCLUDED from gates_passed', () => {
  const text = tbl([
    '| H1 — Clean | cond | **NO** | ok |',
    '| H8 — Vector-DB Label | cond | **MONITOR** | flag for cover letter only |',
    '| H5 — Metro | cond | **N/A** | not applicable |',
    '| H7 — Agentic | cond | **PARTIAL** | partial match |',
    '| H10 — Stability | cond | **SOFT** | soft gap |',
    '| H11 — Policy | cond | — | no verdict |',
    '| H12 — SWE-bar | cond | - | no verdict |',
  ]);
  const g = extractGatesFromReport(text);
  assert.deepEqual([...g.gates_passed].sort(), ['H1'], 'only the NO gate is cleanly hit');
  for (const leaked of ['H8', 'H5', 'H7', 'H10', 'H11', 'H12']) {
    assert.ok(!g.gates_passed.includes(leaked), `${leaked} must NOT be in gates_passed`);
  }
});

test('fired verdict (YES) → gates_failed, never gates_passed', () => {
  const text = tbl([
    '| H1 — Clean | cond | **NO** | ok |',
    '| H6 — Comp undisclosed | cond | **YES** | comp not disclosed |',
  ]);
  const g = extractGatesFromReport(text);
  assert.ok(g.gates_failed.includes('H6'), 'H6 must be failed');
  assert.ok(!g.gates_passed.includes('H6'), 'H6 must NOT be cleanly hit');
  assert.ok(g.gates_passed.includes('H1'));
});

test('descriptive gate name + reason cell captured per gate', () => {
  const text = tbl([
    '| H4 — External enterprise customer-facing tenure | cond | **NO** | No customer-facing commercial language |',
  ]);
  const g = extractGatesFromReport(text);
  assert.equal(g.gate_names.H4, 'External enterprise customer-facing tenure');
  assert.equal(g.gate_reasons.H4, 'No customer-facing commercial language');
});

test('Format B (verdict in col2, ✅ PASS) — all clean gates enter gates_passed', () => {
  const text = tblB([
    '| H1 — Python Production Primary | ✅ PASS | Role title = Communications Manager. |',
    '| H2 — Classical ML Stack | ✅ PASS | JD names zero ML libraries. |',
    '| H6 — Undisclosed Comp | ⚠️ FIRES | Comp not disclosed; not a named target. |',
    '| H8 — Vector-DB Label | 🟡 MONITOR | Flag for cover letter only. |',
  ]);
  const g = extractGatesFromReport(text);
  assert.ok(g.gates_passed.includes('H1'), 'H1 PASS must be cleanly hit');
  assert.ok(g.gates_passed.includes('H2'), 'H2 PASS must be cleanly hit');
  assert.ok(g.gates_failed.includes('H6'), 'H6 FIRES must be failed');
  assert.ok(!g.gates_passed.includes('H6'), 'H6 must NOT be cleanly hit');
  assert.ok(!g.gates_passed.includes('H8'), 'H8 MONITOR must NOT be cleanly hit');
  assert.equal(g.gate_names.H1, 'Python Production Primary');
});

test('prose fallback: "GATES: none fired" with no table → all-hard-gates-clear', () => {
  const g = extractGatesFromReport('Some report body.\n\n**GATES: none fired**\n');
  assert.deepEqual(g.gates_passed, ['all-hard-gates-clear']);
  assert.equal(g.gates_failed.length, 0);
});

// ── FULL-CORPUS CENSUS (not a sample) ─────────────────────────────────────────
// For EVERY report on disk, EVERY gate in gates_passed must trace back to a
// clean verdict in the source table. This is the regression lock against the
// pre-2026-05-31 "any seen gate not failed = passed" leak.
test('CENSUS: no non-clean verdict leaks into gates_passed across all reports', () => {
  if (!existsSync(REPORTS_DIR)) return; // worktree without reports/ — skip
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const leaks = [];
  let reportsWithPassedGates = 0;
  let totalPassedGates = 0;

  for (const f of files) {
    const text = readFileSync(join(REPORTS_DIR, f), 'utf-8');
    const g = extractGatesFromReport(text);
    const realGates = g.gates_passed.filter(x => x !== 'all-hard-gates-clear');
    if (realGates.length) reportsWithPassedGates++;
    for (const gid of realGates) {
      totalPassedGates++;
      // Independently re-resolve this gate's verdict class from the source,
      // format-agnostically. A passed gate must resolve to 'clean' (or null
      // when it came from a non-table/prose source the scanner can't see).
      const cls = resolveVerdictClass(text, gid);
      if (cls && cls !== 'clean') {
        leaks.push(`${f}: ${gid} resolved verdict class="${cls}" leaked into gates_passed`);
      }
    }
  }

  // Surface the census numbers so the run is auditable, not just pass/fail.
  console.log(`[census] ${files.length} reports · ${reportsWithPassedGates} with passed gates · ${totalPassedGates} passed-gate instances checked · ${leaks.length} leaks`);
  assert.deepEqual(leaks, [], 'non-clean verdicts must never appear as cleanly hit:\n' + leaks.slice(0, 25).join('\n'));
});
