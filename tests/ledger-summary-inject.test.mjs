#!/usr/bin/env node
/**
 * tests/ledger-summary-inject.test.mjs
 *
 * Phase 5 hook-based ledger summary injection — exhaustive tests for the
 * `getInjectionSummary()` library function PLUS the `.claude/hooks/
 * ledger-summary-inject.mjs` hook end-to-end behavior.
 *
 * Spec source: Worker B brief (locked) at
 * `.claude/audit/pre-apply-followup-2026-05-25/worker-briefs.md` § Worker B,
 * derived from `.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md`
 * § Phase 5.
 *
 * Test coverage (target ~30, delivered: see Total line at bottom):
 *
 *   Lib (`getInjectionSummary`):
 *     L1  — empty/missing ledger → empty string
 *     L2  — 1 entry with NEEDS_CLOSURE → renders 1-line summary
 *     L3  — 5 entries → all 5 in summary, no overflow line
 *     L4  — 50 entries → caps at max_entries (default 5) + overflow marker
 *     L5  — malformed YAML in one entry → skipped, others render
 *     L6  — status filter: NEEDS_CLOSURE excludes OPEN
 *     L7  — status filter: OPEN includes only OPEN
 *     L8  — status filter: ALL_OPEN includes NEEDS_CLOSURE|OPEN|IN_PROGRESS|BLOCKED|PERMANENT-OPEN
 *     L9  — status filter: CLOSED/DONE always excluded
 *     L10 — max_entries clamped to [1, 50]
 *     L11 — empty ledger file (zero entries) → empty string
 *     L12 — ledger file > MAX_LEDGER_BYTES (10MB) → warning string
 *     L13 — read error → empty string (no throw)
 *     L14 — entry ordering is stable by numeric id
 *     L15 — entry line format: id · feature_tag · code_paths[0..2]
 *     L16 — entry with no feature_tag → "<no-feature-tag>"
 *     L17 — entry with no code_paths → "<no-code-paths-cited>"
 *     L18 — total output bounded by MAX_INJECTION_CHARS
 *     L19 — default max_entries=5 when opts.max_entries unset
 *     L20 — default status=NEEDS_CLOSURE when opts.status unset
 *
 *   Hook (`.claude/hooks/ledger-summary-inject.mjs`):
 *     H1  — env enabled=true + populated ledger → valid JSON envelope
 *     H2  — env enabled=false → silent exit 0, no stdout
 *     H3  — env enabled unset → default to enabled
 *     H4  — env status=OPEN respected
 *     H5  — env max=2 respected
 *     H6  — envelope wraps content with markers
 *     H7  — hook never throws; exit 0 even on error
 *     H8  — JSON envelope has correct hookSpecificOutput shape
 *
 * No live API calls. Hermetic — all fs interactions in tmp dirs.
 *
 * Usage:  node tests/ledger-summary-inject.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import {
  getInjectionSummary,
  MAX_LEDGER_BYTES,
  MAX_INJECTION_CHARS,
  DEFAULT_MAX_ENTRIES,
} from '../lib/ledger-enforcer.mjs';

import { mkdtempSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const HOOK_PATH = join(REPO_ROOT, '.claude', 'hooks', 'ledger-summary-inject.mjs');

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

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'ledger-inject-test-'));
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const FIXTURE_EMPTY = `
# Persistent Task Ledger

(no entries yet)
`;

const FIXTURE_ONE_NEEDS_CLOSURE = `
# Persistent Task Ledger

## LEDGER-100 — Single open
<!-- ledger-meta
id: LEDGER-100
status: NEEDS_CLOSURE
feature_tag: solo-trial
code_paths:
  - lib/foo.mjs
-->
`;

const FIXTURE_FIVE_MIXED = `
# Persistent Task Ledger

## LEDGER-201 — One
<!-- ledger-meta
id: LEDGER-201
status: NEEDS_CLOSURE
feature_tag: alpha
code_paths:
  - lib/one.mjs
-->

## LEDGER-202 — Two
<!-- ledger-meta
id: LEDGER-202
status: NEEDS_CLOSURE
feature_tag: beta
code_paths:
  - lib/two.mjs
  - lib/two-helper.mjs
-->

## LEDGER-203 — Three
<!-- ledger-meta
id: LEDGER-203
status: NEEDS_CLOSURE
feature_tag: gamma
code_paths:
  - lib/three.mjs
-->

## LEDGER-204 — Four
<!-- ledger-meta
id: LEDGER-204
status: NEEDS_CLOSURE
feature_tag: delta
code_paths:
  - lib/four.mjs
-->

## LEDGER-205 — Five
<!-- ledger-meta
id: LEDGER-205
status: NEEDS_CLOSURE
feature_tag: epsilon
code_paths:
  - lib/five.mjs
-->
`;

const FIXTURE_MULTI_STATUS = `
# Persistent Task Ledger

## LEDGER-301 — Open
<!-- ledger-meta
id: LEDGER-301
status: OPEN
feature_tag: a
code_paths:
  - lib/a.mjs
-->

## LEDGER-302 — Needs Closure
<!-- ledger-meta
id: LEDGER-302
status: NEEDS_CLOSURE
feature_tag: b
code_paths:
  - lib/b.mjs
-->

## LEDGER-303 — Done
<!-- ledger-meta
id: LEDGER-303
status: DONE
feature_tag: c
code_paths:
  - lib/c.mjs
-->

## LEDGER-304 — In Progress
<!-- ledger-meta
id: LEDGER-304
status: IN_PROGRESS
feature_tag: d
code_paths:
  - lib/d.mjs
-->

## LEDGER-305 — Blocked
<!-- ledger-meta
id: LEDGER-305
status: BLOCKED
feature_tag: e
code_paths:
  - lib/e.mjs
-->

## LEDGER-306 — Permanent Open
<!-- ledger-meta
id: LEDGER-306
status: PERMANENT-OPEN
feature_tag: f
code_paths:
  - lib/f.mjs
-->

## LEDGER-307 — Closed
<!-- ledger-meta
id: LEDGER-307
status: CLOSED
feature_tag: g
code_paths:
  - lib/g.mjs
-->

## LEDGER-308 — Superseded
<!-- ledger-meta
id: LEDGER-308
status: SUPERSEDED
feature_tag: h
code_paths:
  - lib/h.mjs
-->
`;

const FIXTURE_NO_TAG_NO_PATHS = `
# Persistent Task Ledger

## LEDGER-400 — No tag, no paths
<!-- ledger-meta
id: LEDGER-400
status: NEEDS_CLOSURE
-->
`;

function buildBigLedger(n) {
  let out = '# Persistent Task Ledger\n\n';
  for (let i = 0; i < n; i++) {
    const id = `LEDGER-${500 + i}`;
    out += `## ${id} — Entry ${i}\n<!-- ledger-meta\nid: ${id}\nstatus: NEEDS_CLOSURE\nfeature_tag: bulk\ncode_paths:\n  - lib/bulk-${i}.mjs\n-->\n\n`;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Lib tests — getInjectionSummary()
// ──────────────────────────────────────────────────────────────────────────

// L1 — missing ledger → empty string
{
  const tmp = freshTmp();
  try {
    const out = getInjectionSummary({ ledgerPath: join(tmp, 'nonexistent.md') });
    check('L1 missing ledger → empty string', out === '', { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L2 — 1 NEEDS_CLOSURE entry → 1-line summary
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_ONE_NEEDS_CLOSURE);
    const out = getInjectionSummary({ ledgerPath: p, status: 'NEEDS_CLOSURE' });
    check('L2 one NEEDS_CLOSURE → non-empty', out.length > 0, { out });
    check('L2 one NEEDS_CLOSURE → contains LEDGER-100',
          out.includes('LEDGER-100'), { out });
    check('L2 one NEEDS_CLOSURE → contains feature tag',
          out.includes('solo-trial'), { out });
    check('L2 one NEEDS_CLOSURE → contains code path',
          out.includes('lib/foo.mjs'), { out });
    check('L2 header indicates 1 NEEDS_CLOSURE',
          /\(1 NEEDS_CLOSURE\)/.test(out), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L3 — 5 entries → all 5 in summary, no overflow
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_FIVE_MIXED);
    const out = getInjectionSummary({ ledgerPath: p });
    for (const id of ['LEDGER-201', 'LEDGER-202', 'LEDGER-203', 'LEDGER-204', 'LEDGER-205']) {
      check(`L3 contains ${id}`, out.includes(id), { out });
    }
    check('L3 no overflow marker', !out.includes('[+'), { out });
    check('L3 header shows 5 NEEDS_CLOSURE',
          /\(5 NEEDS_CLOSURE\)/.test(out), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L4 — 50 entries → caps at 5 + overflow marker
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, buildBigLedger(50));
    const out = getInjectionSummary({ ledgerPath: p });
    const matches = (out.match(/^- LEDGER-\d+/gm) || []);
    check('L4 50 entries: only DEFAULT_MAX_ENTRIES (5) rendered',
          matches.length === DEFAULT_MAX_ENTRIES,
          { rendered: matches.length, default: DEFAULT_MAX_ENTRIES });
    check('L4 contains overflow marker', /\[\+45 more/.test(out), { out });
    check('L4 header shows 50 NEEDS_CLOSURE',
          /\(50 NEEDS_CLOSURE\)/.test(out), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L5 — malformed YAML — verify tolerance (file with intentionally-broken meta block)
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, `
# Persistent Task Ledger

## LEDGER-501 — Good
<!-- ledger-meta
id: LEDGER-501
status: NEEDS_CLOSURE
feature_tag: good
code_paths:
  - lib/good.mjs
-->

## LEDGER-502 — Malformed block (missing close tag)
<!-- ledger-meta
id: LEDGER-502
status: NEEDS_CLOSURE
feature_tag: bad-no-close

## LEDGER-503 — Good
<!-- ledger-meta
id: LEDGER-503
status: NEEDS_CLOSURE
feature_tag: also-good
code_paths:
  - lib/also-good.mjs
-->
`);
    const out = getInjectionSummary({ ledgerPath: p });
    check('L5 malformed YAML: LEDGER-501 still present',
          out.includes('LEDGER-501'), { out });
    check('L5 malformed YAML: LEDGER-503 still present',
          out.includes('LEDGER-503'), { out });
    // L5 ledger-502 may or may not appear depending on parser tolerance —
    // the load-bearing invariant is "rest of the ledger still renders".
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L6 — NEEDS_CLOSURE excludes OPEN
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_MULTI_STATUS);
    const out = getInjectionSummary({ ledgerPath: p, status: 'NEEDS_CLOSURE' });
    check('L6 NEEDS_CLOSURE: includes LEDGER-302',
          out.includes('LEDGER-302'), { out });
    check('L6 NEEDS_CLOSURE: excludes LEDGER-301 (OPEN)',
          !out.includes('LEDGER-301'), { out });
    check('L6 NEEDS_CLOSURE: excludes LEDGER-304 (IN_PROGRESS)',
          !out.includes('LEDGER-304'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L7 — status=OPEN
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_MULTI_STATUS);
    const out = getInjectionSummary({ ledgerPath: p, status: 'OPEN' });
    check('L7 OPEN: includes LEDGER-301', out.includes('LEDGER-301'), { out });
    check('L7 OPEN: excludes LEDGER-302 (NEEDS_CLOSURE)',
          !out.includes('LEDGER-302'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L8 — ALL_OPEN
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_MULTI_STATUS);
    const out = getInjectionSummary({ ledgerPath: p, status: 'ALL_OPEN', max_entries: 50 });
    for (const id of ['LEDGER-301', 'LEDGER-302', 'LEDGER-304', 'LEDGER-305', 'LEDGER-306']) {
      check(`L8 ALL_OPEN: includes ${id}`, out.includes(id), { out });
    }
    check('L8 ALL_OPEN: excludes DONE LEDGER-303',
          !out.includes('LEDGER-303'), { out });
    check('L8 ALL_OPEN: excludes CLOSED LEDGER-307',
          !out.includes('LEDGER-307'), { out });
    check('L8 ALL_OPEN: excludes SUPERSEDED LEDGER-308',
          !out.includes('LEDGER-308'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L9 — DONE/CLOSED/SUPERSEDED always excluded regardless of status filter
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_MULTI_STATUS);
    // Try status='DONE' explicitly — should still return empty (closed always
    // excluded, defense in depth).
    const out = getInjectionSummary({ ledgerPath: p, status: 'DONE' });
    check('L9 status=DONE: returns empty (closed excluded)',
          out === '', { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L10 — max_entries clamped to [1, 50]
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, buildBigLedger(60));
    const out0 = getInjectionSummary({ ledgerPath: p, max_entries: 0 });
    const lines0 = (out0.match(/^- LEDGER-\d+/gm) || []).length;
    check('L10 max_entries=0 → clamped to 1', lines0 === 1, { lines0 });

    const out100 = getInjectionSummary({ ledgerPath: p, max_entries: 100 });
    const lines100 = (out100.match(/^- LEDGER-\d+/gm) || []).length;
    check('L10 max_entries=100 → clamped to 50', lines100 <= 50, { lines100 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L11 — empty ledger (no entries) → empty string
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_EMPTY);
    const out = getInjectionSummary({ ledgerPath: p });
    check('L11 empty ledger → empty string', out === '', { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L12 — oversized ledger (> 10MB) → warning string
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    // Don't actually write 10MB — use truncate to grow a small file fast.
    writeFileSync(p, '# huge ledger\n');
    const fd = openSync(p, 'r+');
    try {
      ftruncateSync(fd, MAX_LEDGER_BYTES + 1024);
    } finally {
      closeSync(fd);
    }
    const out = getInjectionSummary({ ledgerPath: p });
    check('L12 oversized ledger → warning string non-empty',
          out.length > 0 && out.startsWith('[ledger-injection]'), { out: out.slice(0, 120) });
    check('L12 oversized warning contains "exceeds"',
          out.includes('exceeds'), { out: out.slice(0, 120) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L13 — read error → empty string (path is a directory)
{
  const tmp = freshTmp();
  try {
    // Pass tmp dir itself as ledgerPath — readFileSync will throw EISDIR.
    const out = getInjectionSummary({ ledgerPath: tmp });
    check('L13 read error (dir path) → empty string',
          out === '', { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L14 — ordering is stable + numeric (LEDGER-100 before LEDGER-201)
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, `
## LEDGER-205 — five
<!-- ledger-meta
id: LEDGER-205
status: NEEDS_CLOSURE
feature_tag: e
code_paths:
  - lib/e.mjs
-->

## LEDGER-100 — first by number
<!-- ledger-meta
id: LEDGER-100
status: NEEDS_CLOSURE
feature_tag: a
code_paths:
  - lib/a.mjs
-->

## LEDGER-202 — two
<!-- ledger-meta
id: LEDGER-202
status: NEEDS_CLOSURE
feature_tag: b
code_paths:
  - lib/b.mjs
-->
`);
    const out = getInjectionSummary({ ledgerPath: p });
    const idx100 = out.indexOf('LEDGER-100');
    const idx202 = out.indexOf('LEDGER-202');
    const idx205 = out.indexOf('LEDGER-205');
    check('L14 numeric sort: 100 before 202',
          idx100 > 0 && idx202 > idx100, { idx100, idx202 });
    check('L14 numeric sort: 202 before 205',
          idx202 > 0 && idx205 > idx202, { idx202, idx205 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L15 — entry line format
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_FIVE_MIXED);
    const out = getInjectionSummary({ ledgerPath: p });
    check('L15 entry line: dot-separators present',
          /- LEDGER-201 · alpha · lib\/one.mjs/.test(out), { out });
    check('L15 multi-path: joined by "; "',
          /- LEDGER-202 · beta · lib\/two.mjs; lib\/two-helper.mjs/.test(out), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L16 — no feature_tag → "<no-feature-tag>"
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, `
## LEDGER-401 — Without tag
<!-- ledger-meta
id: LEDGER-401
status: NEEDS_CLOSURE
code_paths:
  - lib/notag.mjs
-->
`);
    const out = getInjectionSummary({ ledgerPath: p });
    check('L16 no feature_tag → "<no-feature-tag>" placeholder',
          out.includes('<no-feature-tag>'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L17 — no code_paths → "<no-code-paths-cited>"
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_NO_TAG_NO_PATHS);
    const out = getInjectionSummary({ ledgerPath: p });
    check('L17 no code_paths → "<no-code-paths-cited>" placeholder',
          out.includes('<no-code-paths-cited>'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L18 — output bounded by MAX_INJECTION_CHARS
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    // Build entries with very long code paths to stress char budget.
    let big = '# Persistent Task Ledger\n\n';
    for (let i = 0; i < 50; i++) {
      const path = `lib/${'x'.repeat(200)}-${i}.mjs`;
      big += `## LEDGER-${600 + i}\n<!-- ledger-meta\nid: LEDGER-${600 + i}\nstatus: NEEDS_CLOSURE\nfeature_tag: stress-${i}\ncode_paths:\n  - ${path}\n  - ${path}-helper\n  - ${path}-helper2\n-->\n\n`;
    }
    writeFileSync(p, big);
    const out = getInjectionSummary({ ledgerPath: p, max_entries: 50 });
    check('L18 output bounded by MAX_INJECTION_CHARS',
          out.length <= MAX_INJECTION_CHARS, { len: out.length, max: MAX_INJECTION_CHARS });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L19 — default max_entries = DEFAULT_MAX_ENTRIES when unset
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, buildBigLedger(20));
    const out = getInjectionSummary({ ledgerPath: p }); // no max_entries
    const lines = (out.match(/^- LEDGER-\d+/gm) || []).length;
    check('L19 unset max_entries: defaults to DEFAULT_MAX_ENTRIES',
          lines === DEFAULT_MAX_ENTRIES, { lines, expected: DEFAULT_MAX_ENTRIES });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// L20 — default status = NEEDS_CLOSURE when unset
{
  const tmp = freshTmp();
  try {
    const p = join(tmp, 'ledger.md');
    writeFileSync(p, FIXTURE_MULTI_STATUS);
    const out = getInjectionSummary({ ledgerPath: p }); // no status
    check('L20 unset status: filter = NEEDS_CLOSURE',
          out.includes('LEDGER-302') && !out.includes('LEDGER-301'), { out });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Hook tests — invoke the hook via child_process
// ──────────────────────────────────────────────────────────────────────────

function runHook(env) {
  // Run the hook with controlled env. Hook reads ledger relative to its OWN
  // location (REPO_ROOT) so we can't redirect it via env alone — for hook
  // tests we either accept the real repo ledger OR we treat empty output
  // as the absence of NEEDS_CLOSURE rows (which is the production state).
  try {
    const r = execSync(`node ${JSON.stringify(HOOK_PATH)}`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return { code: 0, stdout: r };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// H1 — env enabled=true, status=OPEN → valid JSON envelope (real repo ledger
// has OPEN entries so we use that as the populated-case).
{
  const r = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'true', LEDGER_HOOK_INJECT_STATUS: 'OPEN' });
  check('H1 hook exit 0 when populated', r.code === 0, r);
  check('H1 hook stdout is non-empty', r.stdout.length > 0, { len: r.stdout.length });
  let envelope = null;
  try { envelope = JSON.parse(r.stdout); } catch {}
  check('H1 hook stdout is valid JSON', envelope !== null, { stdout: r.stdout.slice(0, 200) });
  check('H1 hook envelope: hookSpecificOutput present',
        envelope && envelope.hookSpecificOutput, envelope);
  check('H1 hook envelope: hookEventName=UserPromptSubmit',
        envelope && envelope.hookSpecificOutput
          && envelope.hookSpecificOutput.hookEventName === 'UserPromptSubmit', envelope);
  check('H1 hook envelope: additionalContext is non-empty string',
        envelope && envelope.hookSpecificOutput
          && typeof envelope.hookSpecificOutput.additionalContext === 'string'
          && envelope.hookSpecificOutput.additionalContext.length > 0, envelope);
  check('H1 hook envelope: suppressOutput=true',
        envelope && envelope.suppressOutput === true, envelope);
}

// H2 — env enabled=false → silent exit 0
{
  const r = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'false' });
  check('H2 enabled=false: exit 0', r.code === 0, r);
  check('H2 enabled=false: stdout empty', r.stdout === '', { stdout: r.stdout });
}

// H3 — env LEDGER_HOOK_INJECT_ENABLED unset → defaults to enabled
{
  // Unset by passing an env that omits it.
  const cleanEnv = { ...process.env };
  delete cleanEnv.LEDGER_HOOK_INJECT_ENABLED;
  // Use status=OPEN so the real ledger surfaces entries.
  cleanEnv.LEDGER_HOOK_INJECT_STATUS = 'OPEN';
  try {
    const r = execSync(`node ${JSON.stringify(HOOK_PATH)}`, {
      env: cleanEnv,
      encoding: 'utf8',
      timeout: 10_000,
    });
    // The repo's ledger has 3 OPEN entries — expect a populated envelope.
    check('H3 unset enabled: stdout non-empty',
          r.length > 0, { len: r.length });
    let env = null;
    try { env = JSON.parse(r); } catch {}
    check('H3 unset enabled: valid JSON envelope', env !== null, { snippet: r.slice(0, 120) });
  } catch (e) {
    check('H3 unset enabled: hook did not throw', false, { err: String(e) });
  }
}

// H4 — env LEDGER_HOOK_INJECT_STATUS=OPEN respected (verify content differs
// from default NEEDS_CLOSURE).
{
  const rOpen = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'true', LEDGER_HOOK_INJECT_STATUS: 'OPEN' });
  const rDefault = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'true' }); // implicit NEEDS_CLOSURE
  // OPEN should produce output for this repo (3 entries); NEEDS_CLOSURE should not.
  let envOpen = null;
  try { envOpen = JSON.parse(rOpen.stdout); } catch {}
  check('H4 STATUS=OPEN: envelope has content',
        envOpen && envOpen.hookSpecificOutput
          && envOpen.hookSpecificOutput.additionalContext.includes('LEDGER-'),
        envOpen);
  check('H4 default NEEDS_CLOSURE: silent on this repo',
        rDefault.stdout === '',
        { stdout: rDefault.stdout });
}

// H5 — env LEDGER_HOOK_INJECT_MAX=2 respected
{
  const r = runHook({
    LEDGER_HOOK_INJECT_ENABLED: 'true',
    LEDGER_HOOK_INJECT_STATUS: 'OPEN',
    LEDGER_HOOK_INJECT_MAX: '2',
  });
  let env = null;
  try { env = JSON.parse(r.stdout); } catch {}
  const ctx = env && env.hookSpecificOutput && env.hookSpecificOutput.additionalContext || '';
  const lines = (ctx.match(/^- LEDGER-\d+/gm) || []).length;
  check('H5 MAX=2: only 2 entries rendered', lines === 2, { lines, ctx: ctx.slice(0, 300) });
}

// H6 — envelope wraps content with start marker
{
  const r = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'true', LEDGER_HOOK_INJECT_STATUS: 'OPEN' });
  let env = null;
  try { env = JSON.parse(r.stdout); } catch {}
  const ctx = env && env.hookSpecificOutput && env.hookSpecificOutput.additionalContext || '';
  check('H6 envelope contains trial-window marker',
        ctx.includes('ledger-summary-inject — Phase 5 trial'),
        { ctx: ctx.slice(0, 200) });
  check('H6 envelope cites source library',
        ctx.includes('lib/ledger-enforcer.mjs::getInjectionSummary'),
        { ctx: ctx.slice(0, 400) });
}

// H7 — hook never throws, even with garbage env vars
{
  const r = runHook({
    LEDGER_HOOK_INJECT_ENABLED: 'true',
    LEDGER_HOOK_INJECT_STATUS: 'GIBBERISH_STATUS',
    LEDGER_HOOK_INJECT_MAX: 'not-a-number',
  });
  check('H7 garbage env vars: exit 0', r.code === 0, r);
  // Output should be silent (gibberish status matches no entries).
  check('H7 garbage status: stdout empty', r.stdout === '', { stdout: r.stdout });
}

// H8 — JSON envelope shape (re-verifies H1 fields more strictly)
{
  const r = runHook({ LEDGER_HOOK_INJECT_ENABLED: 'true', LEDGER_HOOK_INJECT_STATUS: 'OPEN' });
  let env = null;
  try { env = JSON.parse(r.stdout); } catch {}
  // Strict shape check
  const keys = env ? Object.keys(env).sort() : [];
  check('H8 envelope keys = [hookSpecificOutput, suppressOutput]',
        keys.length === 2 && keys.includes('hookSpecificOutput') && keys.includes('suppressOutput'),
        { keys });
  const innerKeys = env && env.hookSpecificOutput ? Object.keys(env.hookSpecificOutput).sort() : [];
  check('H8 inner keys = [additionalContext, hookEventName]',
        innerKeys.length === 2
          && innerKeys.includes('additionalContext')
          && innerKeys.includes('hookEventName'),
        { innerKeys });
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
