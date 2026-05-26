#!/usr/bin/env node
/**
 * tests/process-all-tier-validation.test.mjs
 *
 * Regression guard for the 2026-05-26 contract-drift-across-layers bug
 * (AGENTS.md § bug-class: contract-drift-across-layers).
 *
 * The 3-tier modal (lib/process-all-tiers.mjs) ships tier='1'|'2'|'3' to
 * /api/pipeline/process-all. The HTTP validator + spawnProcessAll were
 * originally written for 'normal'|'5' and silently rejected/downgraded
 * the new values. This test asserts the contract stays aligned across
 * all four layers: UI radio values → HTTP validator → spawn args →
 * orchestrator resolveTier().
 *
 * Static analysis only — does not require a running server. Catches the
 * regression at test time, before the modal drifts again.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveTier, TIERS } from '../lib/process-all-tiers.mjs';

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

const dashboardSrc   = readFileSync(join(ROOT, 'dashboard-server.mjs'), 'utf8');
const buildSrc       = readFileSync(join(ROOT, 'scripts/build-dashboard.mjs'), 'utf8');

// ─── Layer 1: lib/process-all-tiers.mjs — canonical tier resolver ───
console.log('\nLayer 1: resolveTier() canonical mapping');
assert(resolveTier('1').id === 1,        'resolveTier("1") → Tier 1');
assert(resolveTier('2').id === 2,        'resolveTier("2") → Tier 2');
assert(resolveTier('3').id === 3,        'resolveTier("3") → Tier 3');
assert(resolveTier('normal').id === 1,   'resolveTier("normal") → Tier 1 (legacy alias)');
assert(resolveTier('5').id === 2,        'resolveTier("5") → Tier 2 (legacy Tier-5 button)');
assert(resolveTier(undefined).id === 1,  'resolveTier(undefined) → Tier 1 (default)');
assert(resolveTier('99').id === 1,       'resolveTier("99") → Tier 1 (safe fallback for invalid)');
assert(TIERS[3].eval_model.includes('opus'), 'Tier 3 routes to Opus eval model');
assert(TIERS[1].triage_use_sonnet_jd === false, 'Tier 1 uses Haiku triage (cheap path)');
assert(TIERS[3].triage_use_sonnet_jd === true,  'Tier 3 uses Sonnet triage (premium path)');

// ─── Layer 2: HTTP validator in dashboard-server.mjs ───
console.log('\nLayer 2: HTTP validator in /api/pipeline/process-all');
assert(/VALID_TIERS\s*=\s*\[[^\]]*'1'[^\]]*\]/.test(dashboardSrc),
       "validator's VALID_TIERS includes '1'");
assert(/VALID_TIERS\s*=\s*\[[^\]]*'2'[^\]]*\]/.test(dashboardSrc),
       "validator's VALID_TIERS includes '2'");
assert(/VALID_TIERS\s*=\s*\[[^\]]*'3'[^\]]*\]/.test(dashboardSrc),
       "validator's VALID_TIERS includes '3'");
assert(/VALID_TIERS\s*=\s*\[[^\]]*'normal'[^\]]*\]/.test(dashboardSrc),
       "validator's VALID_TIERS includes 'normal' (legacy)");
assert(/VALID_TIERS\s*=\s*\[[^\]]*'5'[^\]]*\]/.test(dashboardSrc),
       "validator's VALID_TIERS includes '5' (legacy Tier-5 button)");

// ─── Layer 3: spawnProcessAll uses resolveTier() + always passes --tier=N ───
console.log('\nLayer 3: spawnProcessAll wiring');
assert(/import\s*\{[^}]*resolveTier[^}]*\}\s*from\s*'\.\/lib\/process-all-tiers\.mjs'/.test(dashboardSrc),
       'dashboard-server.mjs imports resolveTier from lib/process-all-tiers.mjs');
assert(/_resolveTier\(tier\)/.test(dashboardSrc),
       'spawnProcessAll calls _resolveTier(tier) — no manual tier-id mapping');
assert(/args\.push\(`--tier=\$\{tierId\}`\)/.test(dashboardSrc),
       'spawnProcessAll always passes --tier=N (not conditional on isTier5)');
assert(!/const\s+isTier5\s*=\s*String\(tier\)\s*===\s*['"]5['"]/.test(dashboardSrc),
       'legacy isTier5 boolean branch removed (was the silent-downgrade trap)');

// ─── Layer 4: UI radio values in build-dashboard.mjs ───
console.log('\nLayer 4: UI radio values match canonical tier IDs');
assert(/name="pcp-tier"\s+value="1"/.test(buildSrc), 'UI emits radio value="1"');
assert(/name="pcp-tier"\s+value="2"/.test(buildSrc), 'UI emits radio value="2"');
assert(/name="pcp-tier"\s+value="3"/.test(buildSrc), 'UI emits radio value="3"');
assert(/window\._pcpGetSelectedTier\s*=\s*function/.test(buildSrc),
       'UI exposes _pcpGetSelectedTier() for the fetch payload');

// ─── Layer 5: cap raise + audit log invariants ───
console.log('\nLayer 5: cap policy + audit log');
assert(/clampEnvFloat\(\s*'PER_RUN_CAP_PROCESS_ALL_USD',\s*1000/.test(dashboardSrc),
       'PER_RUN_CAP_PROCESS_ALL default is $1000 (was $250 pre-2026-05-26)');
assert(/PROCESS_ALL_AUDIT_THRESHOLD_USD/.test(dashboardSrc),
       'PROCESS_ALL_AUDIT_THRESHOLD_USD constant defined');
assert(/process-all-audit\.jsonl/.test(dashboardSrc),
       'audit log writes to data/process-all-audit.jsonl');
assert(/if\s*\(\s*costForCap\s*>\s*PROCESS_ALL_AUDIT_THRESHOLD_USD\s*\)/.test(dashboardSrc),
       'audit log gated by PROCESS_ALL_AUDIT_THRESHOLD_USD');

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
