#!/usr/bin/env node
/**
 * tests/intel-refresh-state-consistency.test.mjs
 *
 * Smoke test for the 2026-05-26 PR-E state-disk drift fix:
 *   - scripts/agents/intel-refresh.mjs § computeRowStateAfterRun (pure)
 *   - scripts/agents/intel-refresh.mjs § verifyChildScriptDiskWrite (fs-touching)
 *   - scripts/agents/intel-refresh.mjs § orchestrator wiring (static)
 *
 * Canonical incident — 2026-05-26 row 2387 (ExampleCo — Sr FDE). Deep refresh
 * wrote 7 of 10 slot artifacts to disk, but state.json::rows.2387.slots_done
 * claimed all 10 (because line 647 wrote Object.keys(results) unconditionally
 * regardless of whether each slot's child-script actually produced a target
 * file). Dashboard read disk (not state file) and correctly showed "never
 * refreshed" — but the state file was lying, and a targeted retry would have
 * overwritten slots_done with only the 3 retried slots, losing the 7 known-good.
 *
 * Coverage:
 *   T1. fresh row, all 10 slots ok:true             → slots_done has 10, no slots_failed
 *   T2. partial run, 7 ok + 3 failed                → slots_done has 7, slots_failed has 3
 *   T3. prior 7 done + retry 3 missing all ok       → slots_done UNION = 10 (no loss)
 *   T4. prior 10 done + retry 1 slot, it fails      → slots_done = 9 (removed failed), slots_failed = [the 1]
 *   T5. empty results object                        → slots_done = prior preserved
 *   T6. cache:hit + cache:skipped count as done     → both included in slots_done
 *   T7. slots_failed entry shape: {slot,error,attempted_at}
 *   T8. slots_done is sorted (stable for diffing)
 *
 *   V1. verifyChildScriptDiskWrite — exit 0, file present, non-empty → ok:true
 *   V2. verifyChildScriptDiskWrite — exit 1                          → ok:false, error matches /exit_code=1/
 *   V3. verifyChildScriptDiskWrite — exit 0, file MISSING            → ok:false, error matches /no-disk-artifact/
 *   V4. verifyChildScriptDiskWrite — exit 0, file empty (size 0)     → ok:false, error matches /empty-file/
 *
 *   S1. orchestrator no longer contains the legacy Object.keys(results) shape
 *   S2. orchestrator calls computeRowStateAfterRun
 *   S3. all 4 spawnSync slots call verifyChildScriptDiskWrite
 *   S4. saveState uses atomic rename (renameSync + .tmp.)
 *
 * No live API calls. No spawnSync. No network. Pure local + tmpdir filesystem.
 *
 * Usage:  node tests/intel-refresh-state-consistency.test.mjs
 * Exits 0 on pass; 1 on any failure.
 */

import { computeRowStateAfterRun, verifyChildScriptDiskWrite } from '../scripts/agents/intel-refresh.mjs';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
    if (detail !== undefined) console.error('  detail:', detail);
    fail++;
    failures.push(name);
  }
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─────────────────────────────────────────────────────────────────────────
// computeRowStateAfterRun — pure-function tests
// ─────────────────────────────────────────────────────────────────────────

const NOW = '2026-05-27T00:00:00.000Z';
const ALL_SLOTS = ['hm-intel','toxicity','strategy-ceiling','positioning','liveness','ats-detection','role-enrichment','hm-chance','interview-likelihood','team-health'];

// T1 — fresh row, all 10 slots succeed
{
  const results = Object.fromEntries(ALL_SLOTS.map(s => [s, { ok: true, path: `/x/${s}.json` }]));
  const out = computeRowStateAfterRun({ prevRowState: null, results, now: NOW });
  check('T1: fresh + all-ok → slots_done has all 10', out.slots_done.length === 10, out);
  check('T1: fresh + all-ok → no slots_failed', out.slots_failed === undefined, out);
  check('T1: last_refresh propagated', out.last_refresh === NOW);
}

// T2 — partial: 7 succeed, 3 fail
{
  const results = Object.fromEntries(ALL_SLOTS.map((s, i) => [
    s,
    i < 7 ? { ok: true, path: `/x/${s}.json` } : { ok: false, error: 'silent-write-fail' }
  ]));
  const out = computeRowStateAfterRun({ prevRowState: null, results, now: NOW });
  check('T2: 7 ok + 3 fail → slots_done.length === 7', out.slots_done.length === 7, out);
  check('T2: 7 ok + 3 fail → slots_failed.length === 3', out.slots_failed?.length === 3, out);
  check('T2: slots_done does NOT contain failed slots',
    !out.slots_done.includes(ALL_SLOTS[7]) && !out.slots_done.includes(ALL_SLOTS[8]) && !out.slots_done.includes(ALL_SLOTS[9]),
    out
  );
}

// T3 — set-union: prior 7 done + retry 3 OTHER missing slots succeed
// Mirrors row 2387's actual case: prior run wrote toxicity, strategy-ceiling,
// positioning, liveness, hm-chance, interview-likelihood, team-health (7);
// targeted retry now writes hm-intel, ats-detection, role-enrichment (3).
{
  const RETRY_3 = ['hm-intel', 'ats-detection', 'role-enrichment'];
  const priorDone = ALL_SLOTS.filter(s => !RETRY_3.includes(s));  // 7 unique slots
  const prevRowState = { last_refresh: '2026-05-26T20:00:00.000Z', slots_done: priorDone };
  const results = Object.fromEntries(RETRY_3.map(s => [s, { ok: true, path: `/x/${s}.json` }]));
  const out = computeRowStateAfterRun({ prevRowState, results, now: NOW });
  check('T3: targeted-retry of 3 disjoint slots preserves prior 7 → 10 total', out.slots_done.length === 10, out);
  check('T3: slots_done is set-union (no duplicates)', new Set(out.slots_done).size === 10);
  check('T3: contains both prior and newly-done slots',
    priorDone.every(s => out.slots_done.includes(s)) &&
    RETRY_3.every(s => out.slots_done.includes(s))
  );
  check('T3: no slots_failed when nothing failed', out.slots_failed === undefined);
}

// T3b — set-union when retry-set OVERLAPS with prior — verifies dedup
{
  const priorDone = ['hm-intel', 'toxicity', 'team-health'];
  const prevRowState = { last_refresh: '2026-05-26T20:00:00.000Z', slots_done: priorDone };
  const results = {
    'toxicity':      { ok: true, path: '/x/t.json' },  // already in prior
    'team-health':   { ok: true, cache: 'hit' },        // already in prior, cache hit
    'positioning':   { ok: true, path: '/x/p.json' },  // new
  };
  const out = computeRowStateAfterRun({ prevRowState, results, now: NOW });
  check('T3b: overlap retry → set-union dedups correctly (no duplicates)',
    out.slots_done.length === 4 && new Set(out.slots_done).size === 4,
    out
  );
  check('T3b: includes both retried-overlap + retried-new',
    out.slots_done.includes('hm-intel') &&
    out.slots_done.includes('toxicity') &&
    out.slots_done.includes('team-health') &&
    out.slots_done.includes('positioning')
  );
}

// T4 — slot that was previously done but FAILS on this run is REMOVED
{
  const prevRowState = { last_refresh: '2026-05-26T20:00:00.000Z', slots_done: [...ALL_SLOTS] };
  // Retry hm-intel; it fails
  const results = { 'hm-intel': { ok: false, error: 'spawn-timeout' } };
  const out = computeRowStateAfterRun({ prevRowState, results, now: NOW });
  check('T4: failed retry removes from slots_done', !out.slots_done.includes('hm-intel'), out);
  check('T4: slots_done.length === 9', out.slots_done.length === 9, out);
  check('T4: slots_failed has hm-intel', out.slots_failed?.[0]?.slot === 'hm-intel', out);
}

// T5 — empty results → preserve prior
{
  const prevRowState = { last_refresh: '2026-05-26T20:00:00.000Z', slots_done: ['hm-intel', 'toxicity'] };
  const out = computeRowStateAfterRun({ prevRowState, results: {}, now: NOW });
  check('T5: empty results preserves prior slots_done', deepEq(out.slots_done.sort(), ['hm-intel', 'toxicity']), out);
  check('T5: last_refresh bumped even on no-op', out.last_refresh === NOW);
}

// T6 — cache:hit and cache:skipped both count as done
{
  const results = {
    'liveness':       { ok: true, cache: 'skipped', reason: 'no-url' },
    'team-health':    { ok: true, cache: 'hit', path: '/x/th.json' },
    'ats-detection':  { ok: true, cache: 'skipped', reason: 'no-pack' },
  };
  const out = computeRowStateAfterRun({ prevRowState: null, results, now: NOW });
  check('T6: ok:true with cache:hit/skipped → in slots_done', out.slots_done.length === 3, out);
}

// T7 — slots_failed entry shape
{
  const results = { 'hm-intel': { ok: false, error: 'script-exited-0-but-no-disk-artifact' } };
  const out = computeRowStateAfterRun({ prevRowState: null, results, now: NOW });
  const entry = out.slots_failed[0];
  check('T7: slots_failed entry has {slot,error,attempted_at}',
    entry.slot === 'hm-intel' &&
    typeof entry.error === 'string' && entry.error.length > 0 &&
    entry.attempted_at === NOW,
    entry
  );
}

// T8 — slots_done is sorted (deterministic for diffing)
{
  const results = {
    'team-health':          { ok: true },
    'hm-intel':             { ok: true },
    'positioning':          { ok: true },
    'ats-detection':        { ok: true },
  };
  const out = computeRowStateAfterRun({ prevRowState: null, results, now: NOW });
  const sorted = [...out.slots_done].sort();
  check('T8: slots_done is sorted', deepEq(out.slots_done, sorted), out.slots_done);
}

// ─────────────────────────────────────────────────────────────────────────
// verifyChildScriptDiskWrite — filesystem tests (tmpdir-isolated)
// ─────────────────────────────────────────────────────────────────────────

const TMPDIR = mkdtempSync(join(tmpdir(), 'intel-refresh-test-'));
process.on('exit', () => { try { rmSync(TMPDIR, { recursive: true, force: true }); } catch {} });

const fakeRow = { num: 9999, company: 'Test Co', role: 'Test Role' };

// V1 — exit 0 + file present + non-empty → ok:true
{
  const target = join(TMPDIR, 'v1.json');
  writeFileSync(target, '{"hello": "world"}', 'utf-8');
  const out = verifyChildScriptDiskWrite({ slot: 'hm-intel', row: fakeRow, target, spawnResult: { status: 0 } });
  check('V1: exit 0 + file present + non-empty → ok:true', out.ok === true, out);
  check('V1: returns exit_code + path', out.exit_code === 0 && out.path === target);
}

// V2 — exit 1 → ok:false
{
  const target = join(TMPDIR, 'v2.json');
  writeFileSync(target, 'x', 'utf-8');
  const out = verifyChildScriptDiskWrite({ slot: 'hm-intel', row: fakeRow, target, spawnResult: { status: 1 } });
  check('V2: exit 1 → ok:false', out.ok === false, out);
  check('V2: error includes exit_code=1', /exit_code=1/.test(out.error || ''), out);
}

// V3 — exit 0 + file MISSING → ok:false, error mentions no-disk-artifact
{
  const target = join(TMPDIR, 'v3-does-not-exist.json');
  const out = verifyChildScriptDiskWrite({ slot: 'hm-intel', row: fakeRow, target, spawnResult: { status: 0 } });
  check('V3: exit 0 + file MISSING → ok:false', out.ok === false, out);
  check('V3: error mentions no-disk-artifact', /no-disk-artifact/.test(out.error || ''), out);
}

// V4 — exit 0 + file empty → ok:false, error mentions empty-file
{
  const target = join(TMPDIR, 'v4.json');
  writeFileSync(target, '', 'utf-8');
  const out = verifyChildScriptDiskWrite({ slot: 'hm-intel', row: fakeRow, target, spawnResult: { status: 0 } });
  check('V4: exit 0 + empty file → ok:false', out.ok === false, out);
  check('V4: error mentions empty-file', /empty-file/.test(out.error || ''), out);
}

// ─────────────────────────────────────────────────────────────────────────
// Static AST / source-level checks (regression locks)
// ─────────────────────────────────────────────────────────────────────────

const srcPath = new URL('../scripts/agents/intel-refresh.mjs', import.meta.url).pathname;
const src = readFileSync(srcPath, 'utf-8');

// S1 — legacy Object.keys(results[r.num]) shape REMOVED
check(
  'S1: legacy `slots_done: Object.keys(results[r.num])` pattern is GONE',
  !/slots_done:\s*Object\.keys\(\s*results\[r\.num\]\s*\)/.test(src),
  '(if this fails: the orchestrator still writes Object.keys() unconditionally — that is the bug PR-E fixes)'
);

// S2 — orchestrator calls computeRowStateAfterRun
check(
  'S2: orchestrator calls computeRowStateAfterRun',
  /computeRowStateAfterRun\(\s*\{/.test(src),
  '(if this fails: the new state-derivation function is not wired up)'
);

// S3 — each spawnSync slot calls verifyChildScriptDiskWrite
const expectedVerifierCalls = ['hm-intel', 'role-enrichment', 'hm-chance', 'interview-likelihood'];
for (const slotName of expectedVerifierCalls) {
  const re = new RegExp(`verifyChildScriptDiskWrite\\(\\s*\\{[^}]*slot:\\s*['"]${slotName}['"]`, 's');
  check(
    `S3: spawnSync slot "${slotName}" calls verifyChildScriptDiskWrite`,
    re.test(src),
    `(if this fails: slot ${slotName} still trusts exit_code without disk verification)`
  );
}

// S4 — saveState uses atomic rename (renameSync + tmp file)
check(
  'S4: saveState uses atomic rename',
  /function saveState[\s\S]{0,400}\.tmp\.[\s\S]{0,200}renameSync/.test(src),
  '(if this fails: half-written state files are still possible on process death)'
);

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${pass} passed, ${fail} failed (total ${pass + fail})`);
if (fail > 0) {
  console.error('Failures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
