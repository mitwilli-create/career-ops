#!/usr/bin/env node
/**
 * tests/ledger-enforcer.test.mjs
 *
 * Fixture tests for lib/ledger-enforcer.mjs (Step 6 of pre-apply-check
 * deepening, per .claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md
 * § Step 6 + § "Anti-regression (Option C anti-fatigue design)").
 *
 * Covers the load-bearing invariants:
 *   T1  — parseLedger extracts entries from sample LEDGER text
 *   T2  — parseLedger tolerates entries WITHOUT YAML metadata
 *           (returns metadata_present: false, doesn't throw)
 *   T3  — findStaleArtifacts flags cited-but-missing closure files
 *           (the LEDGER-022 / LEDGER-023 / LEDGER-030 fabrication pattern)
 *   T4  — findStaleArtifacts SKIPS closed entries
 *   T5  — findStaleCodePaths flags renamed / deleted code files
 *   T6  — checkModifiedPaths: exact path match fires; near-match does NOT
 *           (conservative-only contract; no glob inference, no prefix-match)
 *   T7  — checkModifiedPaths: only OPEN/NEEDS_CLOSURE entries trigger
 *           (CLOSED / DONE / SUPERSEDED skipped)
 *   T8  — checkModifiedPaths: violations include human-readable message
 *           ready for hook / PR-comment output
 *   T9  — parseLedger: same entry id with later metadata block overrides
 *           earlier (last write wins for fields)
 *   T10 — auditLedger: high-level summary stats match individual queries
 *
 * No live API calls. No git invocations. Fully hermetic — uses a temp
 * directory for file-existence assertions.
 *
 * Usage:  node tests/ledger-enforcer.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import {
  parseLedger,
  findStaleArtifacts,
  findStaleCodePaths,
  checkModifiedPaths,
  auditLedger,
  parseMiniYaml,
} from '../lib/ledger-enforcer.mjs';

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail !== undefined) {
      try { console.error('  detail:', JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// Build a fresh temp directory for each filesystem-touching test.
function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'ledger-enforcer-test-'));
}

// ── Sample LEDGER text fixture ────────────────────────────────────────────
const SAMPLE_LEDGER = `
# Persistent Task Ledger

## LEDGER-001 — Always open
Some prose about this entry.

<!-- ledger-meta
id: LEDGER-001
status: PERMANENT-OPEN
feature_tag: maintenance
code_paths:
  - data/persistent-task-ledger.md
-->

## LEDGER-026 — Master execution Part 3
Some prose.

<!-- ledger-meta
status: NEEDS_CLOSURE
feature_tag: master-execution
code_paths:
  - lib/strategy-ceiling.mjs
  - scripts/build-dashboard.mjs
closure_artifacts:
  - data/master-resolution-2026-05-22.md
  - .claude/audit/master-execution-part-3-2026-05-23/index.md
-->

## LEDGER-027 — No metadata yet
This entry is intentionally without a metadata block to test tolerance.

## LEDGER-018 — DONE entry
| ID | Aliases | Closed |
| LEDGER-018 | 4.13 | 2026-05-22 |

<!-- ledger-meta
status: DONE
feature_tag: closure-08
code_paths:
  - dashboard-server.mjs
closure_artifacts:
  - .claude/audit/closure-08-2026-05-22/notes-08.3-resume-button.md
-->

## LEDGER-099 — Fabrication-pattern test
This entry cites a closure_artifacts path that does not exist.

<!-- ledger-meta
status: NEEDS_CLOSURE
feature_tag: fabrication-test
code_paths:
  - lib/ledger-enforcer.mjs
closure_artifacts:
  - data/closure-prompt-08-regex-sweep-and-413-followups-2026-05-22.md
-->
`;

// ── T1: parseLedger extracts entries ──────────────────────────────────────
{
  const entries = parseLedger(SAMPLE_LEDGER);
  const ids = entries.map(e => e.id);
  check('T1 parseLedger: extracts LEDGER-001', ids.includes('LEDGER-001'), ids);
  check('T1 parseLedger: extracts LEDGER-026', ids.includes('LEDGER-026'), ids);
  check('T1 parseLedger: extracts LEDGER-099', ids.includes('LEDGER-099'), ids);
  check('T1 parseLedger: at least 5 entries', entries.length >= 5, { n: entries.length, ids });

  const e026 = entries.find(e => e.id === 'LEDGER-026');
  check('T1 LEDGER-026: status NEEDS_CLOSURE', e026 && e026.status === 'NEEDS_CLOSURE', e026);
  check('T1 LEDGER-026: code_paths has 2 entries',
        e026 && e026.code_paths.length === 2,
        e026 && e026.code_paths);
  check('T1 LEDGER-026: code_paths includes strategy-ceiling',
        e026 && e026.code_paths.includes('lib/strategy-ceiling.mjs'),
        e026 && e026.code_paths);
  check('T1 LEDGER-026: closure_artifacts has 2 entries',
        e026 && e026.closure_artifacts.length === 2,
        e026 && e026.closure_artifacts);
  check('T1 LEDGER-026: feature_tag = master-execution',
        e026 && e026.feature_tag === 'master-execution',
        e026 && e026.feature_tag);
  check('T1 LEDGER-026: metadata_present true',
        e026 && e026.metadata_present === true,
        e026);
}

// ── T2: parseLedger tolerates entries WITHOUT metadata ────────────────────
{
  const entries = parseLedger(SAMPLE_LEDGER);
  const e027 = entries.find(e => e.id === 'LEDGER-027');
  check('T2 LEDGER-027: present despite no YAML block', !!e027, entries.map(e => e.id));
  check('T2 LEDGER-027: metadata_present false',
        e027 && e027.metadata_present === false, e027);
  check('T2 LEDGER-027: code_paths is empty array',
        e027 && Array.isArray(e027.code_paths) && e027.code_paths.length === 0, e027);
  check('T2 LEDGER-027: closure_artifacts is empty array',
        e027 && Array.isArray(e027.closure_artifacts) && e027.closure_artifacts.length === 0, e027);
  check('T2 LEDGER-027: status is null',
        e027 && e027.status === null, e027);
}

// ── T3: findStaleArtifacts catches the fabrication pattern ────────────────
{
  const tmp = freshTmp();
  try {
    // Create only LEDGER-026's two artifacts on disk — LEDGER-099 is fabricated.
    mkdirSync(join(tmp, 'data'), { recursive: true });
    mkdirSync(join(tmp, '.claude/audit/master-execution-part-3-2026-05-23'), { recursive: true });
    writeFileSync(join(tmp, 'data/master-resolution-2026-05-22.md'), 'sample\n');
    writeFileSync(join(tmp, '.claude/audit/master-execution-part-3-2026-05-23/index.md'), 'sample\n');
    // Also create LEDGER-018's (DONE) artifact so we can verify DONE entries are skipped.
    mkdirSync(join(tmp, '.claude/audit/closure-08-2026-05-22'), { recursive: true });
    writeFileSync(join(tmp, '.claude/audit/closure-08-2026-05-22/notes-08.3-resume-button.md'), 'sample\n');

    const entries = parseLedger(SAMPLE_LEDGER);
    const stale = findStaleArtifacts(entries, tmp);
    // LEDGER-099 cites a closure-prompt-08 file that doesn't exist.
    check('T3 findStaleArtifacts: flags LEDGER-099 fabricated artifact',
          stale.some(s => s.startsWith('LEDGER-099::') && s.includes('closure-prompt-08')),
          stale);
    check('T3 findStaleArtifacts: does NOT flag LEDGER-026 (artifacts exist)',
          !stale.some(s => s.startsWith('LEDGER-026::')),
          stale);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── T4: findStaleArtifacts skips closed entries ───────────────────────────
{
  const tmp = freshTmp();
  try {
    // Note: do NOT create LEDGER-018's artifact this time.
    const entries = parseLedger(SAMPLE_LEDGER);
    const stale = findStaleArtifacts(entries, tmp);
    check('T4 findStaleArtifacts: closed (DONE) LEDGER-018 NOT flagged even though artifact missing',
          !stale.some(s => s.startsWith('LEDGER-018::')),
          stale);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── T5: findStaleCodePaths flags renamed/deleted code files ───────────────
{
  const tmp = freshTmp();
  try {
    // Create LEDGER-026's code_paths on disk; LEDGER-099 cites lib/ledger-enforcer.mjs
    // which we WILL create. The interesting case: create NOTHING for LEDGER-001's
    // ledger path → so we expect stale flag for LEDGER-001's data/persistent-task-ledger.md.
    mkdirSync(join(tmp, 'lib'), { recursive: true });
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    writeFileSync(join(tmp, 'lib/strategy-ceiling.mjs'), '// stub\n');
    writeFileSync(join(tmp, 'scripts/build-dashboard.mjs'), '// stub\n');
    writeFileSync(join(tmp, 'lib/ledger-enforcer.mjs'), '// stub\n');
    // Intentionally do NOT create dashboard-server.mjs (LEDGER-018, DONE — should
    // be skipped) or data/persistent-task-ledger.md (LEDGER-001, PERMANENT-OPEN
    // — should fire).

    const entries = parseLedger(SAMPLE_LEDGER);
    const stale = findStaleCodePaths(entries, tmp);
    check('T5 findStaleCodePaths: flags LEDGER-001 missing ledger file',
          stale.some(s => s.startsWith('LEDGER-001::')),
          stale);
    check('T5 findStaleCodePaths: skips LEDGER-018 (DONE)',
          !stale.some(s => s.startsWith('LEDGER-018::')),
          stale);
    check('T5 findStaleCodePaths: does NOT flag LEDGER-026 (paths exist)',
          !stale.some(s => s.startsWith('LEDGER-026::')),
          stale);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── T6: checkModifiedPaths — exact match ON, near-match OFF ───────────────
{
  const entries = parseLedger(SAMPLE_LEDGER);
  // LEDGER-026 tracks lib/strategy-ceiling.mjs + scripts/build-dashboard.mjs
  // LEDGER-099 tracks lib/ledger-enforcer.mjs

  // Exact match — should fire on LEDGER-026
  const v1 = checkModifiedPaths({
    entries,
    modifiedPaths: ['lib/strategy-ceiling.mjs'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T6 exact-match: lib/strategy-ceiling.mjs triggers LEDGER-026',
        v1.length === 1 && v1[0].entry_id === 'LEDGER-026',
        v1);

  // Near-match (different extension) — must NOT fire
  const v2 = checkModifiedPaths({
    entries,
    modifiedPaths: ['lib/strategy-ceiling.test.mjs'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T6 near-match: lib/strategy-ceiling.test.mjs does NOT trigger LEDGER-026',
        v2.length === 0, v2);

  // Prefix-match — must NOT fire
  const v3 = checkModifiedPaths({
    entries,
    modifiedPaths: ['lib/strategy-ceiling'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T6 prefix-match: lib/strategy-ceiling (no ext) does NOT trigger',
        v3.length === 0, v3);

  // Substring-match (basename only) — must NOT fire
  const v4 = checkModifiedPaths({
    entries,
    modifiedPaths: ['strategy-ceiling.mjs'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T6 basename-only: strategy-ceiling.mjs (no dir) does NOT trigger',
        v4.length === 0, v4);
}

// ── T7: only OPEN/NEEDS_CLOSURE trigger; CLOSED skipped ───────────────────
{
  const entries = parseLedger(SAMPLE_LEDGER);
  // LEDGER-018 is DONE; it tracks dashboard-server.mjs.
  const v = checkModifiedPaths({
    entries,
    modifiedPaths: ['dashboard-server.mjs'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T7 CLOSED entry: LEDGER-018 (DONE) does NOT trigger on dashboard-server.mjs',
        !v.some(x => x.entry_id === 'LEDGER-018'), v);

  // PERMANENT-OPEN entries (LEDGER-001 tracks the ledger file itself) by
  // design never close — they enforce a recurring discipline, not one-time
  // closure. Modifying their tracked code_paths IS the success condition of
  // their existence, not a closure-required event. checkModifiedPaths skips
  // them. (Stale-artifact audits via findStaleArtifacts/findStaleCodePaths
  // still cover them — see T3 + T4.)
  const v2 = checkModifiedPaths({
    entries,
    modifiedPaths: ['data/persistent-task-ledger.md'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T7 PERMANENT-OPEN: LEDGER-001 does NOT trigger on ledger modification (by design)',
        !v2.some(x => x.entry_id === 'LEDGER-001'), v2);
}

// ── T8: violations include actionable message ─────────────────────────────
{
  const entries = parseLedger(SAMPLE_LEDGER);
  const v = checkModifiedPaths({
    entries,
    modifiedPaths: ['lib/ledger-enforcer.mjs'],
    repoRoot: '/tmp/fake-repo-root',
  });
  check('T8 violation: includes message string',
        v.length === 1 && typeof v[0].message === 'string' && v[0].message.length > 30,
        v);
  check('T8 violation: message names the entry id',
        v.length === 1 && v[0].message.includes('LEDGER-099'),
        v);
  check('T8 violation: message references the path',
        v.length === 1 && v[0].message.includes('lib/ledger-enforcer.mjs'),
        v);
}

// ── T9: last-metadata-block-wins on duplicate id ──────────────────────────
{
  const dupLedger = `
## LEDGER-200
<!-- ledger-meta
status: NEEDS_CLOSURE
code_paths:
  - lib/foo.mjs
-->

Some intervening prose about LEDGER-200.

<!-- ledger-meta
id: LEDGER-200
status: DONE
code_paths:
  - lib/foo.mjs
  - lib/bar.mjs
-->
`;
  const entries = parseLedger(dupLedger);
  const e200 = entries.find(e => e.id === 'LEDGER-200');
  check('T9 dup-id: only one entry created', entries.filter(e => e.id === 'LEDGER-200').length === 1, entries);
  check('T9 dup-id: later status wins (DONE)', e200 && e200.status === 'DONE', e200);
  check('T9 dup-id: later code_paths wins (2 entries)',
        e200 && e200.code_paths.length === 2, e200 && e200.code_paths);
}

// ── T10: auditLedger summary aligns with low-level queries ────────────────
{
  const tmp = freshTmp();
  try {
    mkdirSync(join(tmp, 'lib'), { recursive: true });
    writeFileSync(join(tmp, 'lib/strategy-ceiling.mjs'), '// stub\n');
    // No other paths created → most artifacts/code_paths will be stale.

    const entries = parseLedger(SAMPLE_LEDGER);
    const result = auditLedger({ entries, repoRoot: tmp });

    check('T10 auditLedger: entry_count matches entries.length',
          result.entry_count === entries.length, result);
    check('T10 auditLedger: with_metadata + without_metadata === entry_count',
          result.with_metadata + result.without_metadata === result.entry_count, result);
    check('T10 auditLedger: open_needs_closure is non-empty',
          result.open_needs_closure.length >= 2,
          result.open_needs_closure.map(e => e.id));
    check('T10 auditLedger: stale lists match individual queries',
          result.stale_artifacts.length === findStaleArtifacts(entries, tmp).length &&
          result.stale_code_paths.length === findStaleCodePaths(entries, tmp).length,
          { audit_artifacts: result.stale_artifacts.length, audit_code: result.stale_code_paths.length });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Bonus: parseMiniYaml smoke ────────────────────────────────────────────
{
  const y = parseMiniYaml(`
status: NEEDS_CLOSURE
feature_tag: pre-apply-check-deepen
code_paths:
  - lib/pre-apply-orchestrator.mjs
  - lib/ats-check.mjs
closure_artifacts:
  - .claude/audit/x/y.md
`);
  check('parseMiniYaml: scalar', y.status === 'NEEDS_CLOSURE', y);
  check('parseMiniYaml: list of 2', Array.isArray(y.code_paths) && y.code_paths.length === 2, y);
  check('parseMiniYaml: feature_tag survives',
        y.feature_tag === 'pre-apply-check-deepen', y);
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

console.log('');
console.log(`Total: ${pass + fail}  Pass: ${pass}  Fail: ${fail}`);
if (fail > 0) {
  console.error(`\nFailures:`);
  for (const f of failures) {
    console.error(`  ✗ ${f.name}`);
  }
  process.exit(1);
}
process.exit(0);
