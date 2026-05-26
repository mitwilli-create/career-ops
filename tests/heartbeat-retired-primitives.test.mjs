#!/usr/bin/env node
/**
 * tests/heartbeat-retired-primitives.test.mjs
 *
 * Regression guard: scans heartbeat scripts for retired primitive names.
 * Fails if any reference to a retired model/variable is found in executable code.
 *
 * Per Phase 6B (closeout-comprehensive-2026-05-25): stale-coupling-after-primitive-removal
 * bug class — same-PR consumer sweep should eliminate retired-primitive references;
 * this test enforces the invariant post-retirement.
 *
 * Retired primitives (as of 2026-05-25, bug-2026-05-25-225):
 *   - runwayAlert / runwayAlertFiring
 *   - runwayState (as a variable — the string 'healthy' / 'critical' is allowed)
 *   - computeRunwayDensityForHeartbeat
 *   - renderRunwayAlertTiered
 *   - renderRunwayAlert (function definition only)
 *   - RUNWAY_WEEKS used as a runway model input (env var for scheduling only)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function readScript(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * Extract only executable lines — strips single-line comments (//) and
 * block-comment lines (* ...) so retired names in documentation comments
 * don't trigger false positives.
 */
function executableLines(src) {
  return src.split('\n').filter(line => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

console.log('\nheartbeat-retired-primitives.test.mjs\n');

// ── T1: heartbeat.mjs — no runwayAlert variable ─────────────────────────────
{
  console.log('T1 — heartbeat.mjs: no runwayAlert / runwayAlertFiring in executable code');
  const src = executableLines(readScript('scripts/heartbeat.mjs'));
  assert(!src.includes('runwayAlert'), 'no runwayAlert in exec code');
  assert(!src.includes('runwayAlertFiring'), 'no runwayAlertFiring in exec code');
}

// ── T2: heartbeat.mjs — no runwayState variable declaration ─────────────────
{
  console.log('\nT2 — heartbeat.mjs: no runwayState variable in exec code');
  const src = executableLines(readScript('scripts/heartbeat.mjs'));
  // runwayState as a variable name should be gone; literal string 'healthy' is fine
  assert(!src.match(/\brunwayState\b/), 'no runwayState identifier in exec code');
}

// ── T3: heartbeat.mjs — no retired function names ───────────────────────────
{
  console.log('\nT3 — heartbeat.mjs: no retired compute/render function calls');
  const src = executableLines(readScript('scripts/heartbeat.mjs'));
  assert(!src.includes('computeRunwayDensityForHeartbeat'), 'no computeRunwayDensityForHeartbeat');
  assert(!src.includes('renderRunwayAlertTiered'), 'no renderRunwayAlertTiered');
  // renderRunwayAlert as a function call (not just the string)
  assert(!src.match(/renderRunwayAlert\s*\(/), 'no renderRunwayAlert() call');
}

// ── T4: heartbeat-dispatch.mjs — no runwayAlert ─────────────────────────────
{
  console.log('\nT4 — heartbeat-dispatch.mjs: no runwayAlert in exec code');
  const src = executableLines(readScript('scripts/heartbeat-dispatch.mjs'));
  assert(!src.includes('runwayAlert'), 'heartbeat-dispatch: no runwayAlert');
}

// ── T5: heartbeat-evening.mjs — no runwayAlert ──────────────────────────────
{
  console.log('\nT5 — heartbeat-evening.mjs: no runwayAlert in exec code');
  const src = executableLines(readScript('scripts/heartbeat-evening.mjs'));
  assert(!src.includes('runwayAlert'), 'heartbeat-evening: no runwayAlert');
}

// ── T6: templates/heartbeat-dispatch.mjml — no runway widget ────────────────
{
  console.log('\nT6 — heartbeat-dispatch.mjml: no runway widget section');
  const src = readScript('templates/heartbeat-dispatch.mjml');
  assert(!src.toLowerCase().includes('runway alert'), 'no "runway alert" in mjml template');
  assert(!src.includes('runwayAlert'), 'no runwayAlert in mjml template');
}

// ── T7: data/dispatch/forecast-templates.json — no runway references ─────────
{
  console.log('\nT7 — forecast-templates.json: no runway variable references');
  const src = readScript('data/dispatch/forecast-templates.json');
  assert(!src.includes('{runway.'), 'no {runway.*} template vars');
  assert(!src.includes('runway_alert'), 'no runway_alert key');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFAIL — retired runway primitives found in heartbeat scripts.');
  console.error('Fix: run the stale-coupling sweep per AGENTS.md bug-class: stale-coupling-after-primitive-removal');
  process.exit(1);
}
console.log('PASS');
