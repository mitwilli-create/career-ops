#!/usr/bin/env node
/**
 * tests/batch-budget-guard.test.mjs — static contract assertions for the
 * --cap-override propagation chain across dashboard-server → middleware →
 * batch-runner. Closes the bug class
 * `force-override-not-propagated-to-internal-guard` (see AGENTS.md).
 *
 * Why static-only: spawning batch-runner-batches.mjs as an integration test
 * requires fake API key + temp triage-advance.tsv + cv/digest/profile fixtures
 * + bounded child-process management — high complexity for marginal coverage
 * beyond what the static chain assertions + the /deploy-verify Phase 6 live
 * smoke (Chrome MCP force-override dispatch) already cover. Static here +
 * live smoke during deploy = full contract verification.
 *
 * Run: `node tests/batch-budget-guard.test.mjs`
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${label}\n    ${e.message}`);
    fail++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertMatch(text, re, msg) {
  if (!re.test(text)) throw new Error(msg || `pattern not found: ${re}`);
}
function assertNoMatch(text, re, msg) {
  if (re.test(text)) throw new Error(msg || `unexpected pattern present: ${re}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 0 — Server: dashboard-server.mjs passes --cap-override on force=true
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Layer 0: dashboard-server.mjs (HTTP → spawn) ──\n');

const dashServer = read('dashboard-server.mjs');

test('spawnBatchOnly adds --cap-override to argv when force=true', () => {
  // Function signature uses { force } destructure; somewhere in its body it
  // pushes --cap-override into args[] conditional on force.
  const fn = dashServer.match(/function spawnBatchOnly\([\s\S]*?\n\}\n/);
  assert(fn, 'could not locate spawnBatchOnly function');
  assertMatch(fn[0], /if\s*\(\s*force\s*\)\s*args\.push\(\s*['"]--cap-override['"]/,
    'spawnBatchOnly does not push --cap-override on force');
});

test('Process All spawn (spawnPipelineProcessAll or inline) passes --cap-override on force', () => {
  // Look for both possible spawn names + the inline /api/pipeline/process-all
  // body. At least ONE site near "process-all-pipeline.mjs" must push the flag.
  const block = dashServer.match(/process-all-pipeline\.mjs[\s\S]{0,800}args\.push\(\s*['"]--cap-override['"]/);
  assert(block, 'no --cap-override push found within 800 chars of process-all-pipeline.mjs spawn');
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — Middleware: batch-only-pipeline.mjs parses + forwards
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Layer 1a: scripts/batch-only-pipeline.mjs ──\n');

const batchOnly = read('scripts/batch-only-pipeline.mjs');

test('batch-only-pipeline parses CAP_OVERRIDE from argv', () => {
  assertMatch(batchOnly, /const\s+CAP_OVERRIDE\s*=\s*!!ARGS\[\s*['"]cap-override['"]\s*\]/,
    'CAP_OVERRIDE constant not declared');
});

test('phaseBatch forwards --cap-override into batch-runner-batches.mjs argv', () => {
  // Look for: const batchArgs = ['run']; if (CAP_OVERRIDE) batchArgs.push('--cap-override');
  const phase = batchOnly.match(/async\s+function\s+phaseBatch\(\)[\s\S]*?^\}/m);
  assert(phase, 'phaseBatch function not found');
  assertMatch(phase[0], /batchArgs/, 'phaseBatch does not use batchArgs variable');
  assertMatch(phase[0], /if\s*\(\s*CAP_OVERRIDE\s*\)\s*batchArgs\.push\(\s*['"]--cap-override['"]/,
    'phaseBatch does not forward --cap-override conditionally on CAP_OVERRIDE');
  assertMatch(phase[0], /runScript\(\s*['"]batch-runner-batches\.mjs['"]\s*,\s*batchArgs/,
    'phaseBatch does not call runScript with batchArgs');
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 1b — Middleware: process-all-pipeline.mjs parses + forwards
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Layer 1b: scripts/process-all-pipeline.mjs ──\n');

const processAll = read('scripts/process-all-pipeline.mjs');

test('process-all-pipeline parses CAP_OVERRIDE from argv', () => {
  assertMatch(processAll, /const\s+CAP_OVERRIDE\s*=\s*!!ARGS\[\s*['"]cap-override['"]\s*\]/,
    'CAP_OVERRIDE constant not declared');
});

test('phaseBatch forwards --cap-override into batch-runner-batches.mjs argv', () => {
  // The phaseBatch in process-all-pipeline builds batchArgs with --limit + --model +
  // SCOPED_ARGS already; we added the conditional --cap-override push.
  const phase = processAll.match(/async\s+function\s+phaseBatch\(\)[\s\S]*?^\}/m);
  assert(phase, 'phaseBatch function not found');
  assertMatch(phase[0], /if\s*\(\s*CAP_OVERRIDE\s*\)\s*batchArgs\.push\(\s*['"]--cap-override['"]/,
    'phaseBatch does not forward --cap-override conditionally on CAP_OVERRIDE');
  assertMatch(phase[0], /runScript\(\s*['"]batch-runner-batches\.mjs['"]\s*,\s*batchArgs/,
    'phaseBatch does not call runScript with batchArgs');
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — Deepest: batch-runner-batches.mjs receives + respects + hoists
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Layer 2: batch-runner-batches.mjs ──\n');

const batchRunner = read('batch-runner-batches.mjs');

test('batch-runner-batches parses CAP_OVERRIDE from argv', () => {
  assertMatch(batchRunner, /const\s+CAP_OVERRIDE\s*=\s*ARGS\[\s*['"]cap-override['"]\s*\]\s*===\s*true\s*\|\|\s*ARGS\[\s*['"]cap-override['"]\s*\]\s*===\s*['"]true['"]/,
    'CAP_OVERRIDE not parsed with truthy-or-string-true pattern (matches DRY_RUN style)');
});

test('runBudgetGuard helper exists at module level', () => {
  assertMatch(batchRunner, /function\s+runBudgetGuard\s*\(\s*\{\s*capOverride\s*=\s*false\s*\}\s*=\s*\{\}\s*\)/,
    'runBudgetGuard signature does not match expected destructure pattern');
});

test('runBudgetGuard reads MONTHLY_BUDGET_USD and short-circuits when <= 0', () => {
  const fn = batchRunner.match(/function\s+runBudgetGuard[\s\S]*?\n\}\n/);
  assert(fn, 'could not locate runBudgetGuard function body');
  assertMatch(fn[0], /MONTHLY_BUDGET_USD/, 'runBudgetGuard does not reference MONTHLY_BUDGET_USD env');
  assertMatch(fn[0], /MONTHLY_BUDGET\s*<=\s*0/, 'runBudgetGuard missing disabled-guard short-circuit');
});

test('runBudgetGuard logs WARN + returns when capOverride && over-budget', () => {
  const fn = batchRunner.match(/function\s+runBudgetGuard[\s\S]*?\n\}\n/);
  assert(fn, 'runBudgetGuard not found');
  // Must contain both: a WARN log mentioning "bypassed", AND a return that
  // happens BEFORE the abort path. We verify ordering by string position.
  const warnIdx  = fn[0].search(/console\.warn\([\s\S]*?Budget guard bypassed/);
  const abortIdx = fn[0].search(/process\.exit\(1\)/);
  assert(warnIdx >= 0, 'no WARN log mentioning "Budget guard bypassed"');
  assert(abortIdx >= 0, 'no process.exit(1) abort path');
  assert(warnIdx < abortIdx, 'WARN branch must appear before abort branch in source');
  // The WARN branch must have a return so the abort path is skipped
  const between = fn[0].slice(warnIdx, abortIdx);
  assertMatch(between, /\breturn\b/, 'no return between WARN log and abort path');
});

test('runBudgetGuard called PRE-FLIGHT in phaseSubmit (before JD fetch loop)', () => {
  // phaseSubmit calls runBudgetGuard, and this call must appear BEFORE the
  // for-loop that calls await fetchJD(...).
  const sub = batchRunner.match(/async\s+function\s+phaseSubmit[\s\S]*?\n\}\n/);
  assert(sub, 'phaseSubmit function not found');
  const guardIdx  = sub[0].search(/runBudgetGuard\(/);
  const fetchIdx  = sub[0].search(/await\s+fetchJD\(/);
  assert(guardIdx >= 0, 'phaseSubmit never calls runBudgetGuard');
  assert(fetchIdx >= 0, 'phaseSubmit never calls fetchJD (sanity check failed)');
  assert(guardIdx < fetchIdx, 'runBudgetGuard must be called BEFORE the JD fetch loop');
});

test('phaseSubmit passes capOverride: CAP_OVERRIDE to runBudgetGuard', () => {
  const sub = batchRunner.match(/async\s+function\s+phaseSubmit[\s\S]*?\n\}\n/);
  assert(sub, 'phaseSubmit function not found');
  assertMatch(sub[0], /runBudgetGuard\(\s*\{\s*capOverride:\s*CAP_OVERRIDE\s*\}\s*\)/,
    'runBudgetGuard call does not pass { capOverride: CAP_OVERRIDE }');
});

test('phaseSubmit pre-flight guard is gated by !DRY_RUN', () => {
  const sub = batchRunner.match(/async\s+function\s+phaseSubmit[\s\S]*?\n\}\n/);
  assert(sub, 'phaseSubmit function not found');
  // The guard call must be inside an `if (!DRY_RUN) { ... }` block
  assertMatch(sub[0], /if\s*\(\s*!DRY_RUN\s*\)\s*\{[\s\S]*?runBudgetGuard\(/,
    'pre-flight runBudgetGuard call is not gated by !DRY_RUN');
});

test('old in-line guard block (pre-fetch duplicate) removed', () => {
  // The pre-fix code had a duplicate guard at "// Budget guard — abort if rolling
  // 30-day spend" appearing AFTER the fetch loop. Make sure it's gone.
  assertNoMatch(batchRunner, /\/\/\s*Budget guard\s*—\s*abort if rolling 30-day spend exceeds MONTHLY_BUDGET_USD/,
    'pre-fix duplicate guard comment still present (should have been removed)');
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 3 — UI: build-dashboard modal copy reflects post-fix behavior
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Layer 3: scripts/build-dashboard.mjs (modal copy) ──\n');

const buildDash = read('scripts/build-dashboard.mjs');

test('_renderCapWarning includes end-to-end bypass sub-line', () => {
  const fn = buildDash.match(/function\s+_renderCapWarning[\s\S]*?\n\}\n/);
  assert(fn, '_renderCapWarning function not found');
  assertMatch(fn[0], /Bypasses per-run \+ monthly caps end-to-end/,
    '_renderCapWarning missing post-fix bypass sub-line');
});

test('_renderScopedCapWarning includes end-to-end bypass sub-line', () => {
  const fn = buildDash.match(/function\s+_renderScopedCapWarning[\s\S]*?\n\}\n/);
  assert(fn, '_renderScopedCapWarning function not found');
  assertMatch(fn[0], /Bypasses per-run \+ monthly caps end-to-end/,
    '_renderScopedCapWarning missing post-fix bypass sub-line');
});

test('both modal renderers reference the batch-runner internal guard', () => {
  // Sanity that the copy connects the user to the technical layer name.
  assertMatch(buildDash, /batch-runner internal guard/,
    'modal copy does not mention batch-runner internal guard');
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────`);
console.log(`Results: ${pass} pass, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);
