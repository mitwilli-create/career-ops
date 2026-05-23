#!/usr/bin/env node
// scripts/test-cost-calculator.mjs
//
// Regression test for the lib/council.mjs estimateCostUsd() function.
//
// Guards against re-introducing the per-1K-vs-per-1M units bug fixed in
// commit 8e83ffa (2026-05-19). That bug inflated every Anthropic Opus +
// Sonnet cost by ~1000x and produced $904.95 reports for $0.90 calls.
//
// For each model in the table, we assert that the computed cost is within
// 5% of the published blended rate for a known token count.

import { estimateCostUsd } from '../lib/council.mjs';

let passed = 0;
let failed = 0;

function approxEq(actual, expected, tolerance = 0.05, label = '') {
  const lo = expected * (1 - tolerance);
  const hi = expected * (1 + tolerance);
  const ok = actual >= lo && actual <= hi;
  if (ok) {
    console.log(`  ✅ ${label} — got $${actual.toFixed(5)}, expected ~$${expected.toFixed(5)}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — got $${actual.toFixed(5)}, expected $${lo.toFixed(5)}-$${hi.toFixed(5)} (±${tolerance * 100}%)`);
    failed++;
  }
}

console.log('\n🧪 estimateCostUsd regression suite\n');

// Fixtures: model key, token count, expected $ at blended rate.
// Blended rates from lib/council.mjs MODEL_COST_RATES (verified 2026-05-22).
// Expected = tokens × blended_rate_per_M / 1_000_000.
const fixtures = [
  // Anthropic — these were the 1000x-inflated models pre-8e83ffa
  { model: 'anthropic:claude-opus-4-7',      tokens: 10_000,  expected: 0.45,   label: 'Opus 4.7 @ 10K tokens (blended $45/M)' },
  { model: 'anthropic:claude-opus-4-7',      tokens: 20_110,  expected: 0.905,  label: 'Opus 4.7 @ 20,110 tokens (the original $904.95 phantom)' },
  { model: 'anthropic:claude-sonnet-4-6',    tokens: 10_000,  expected: 0.09,   label: 'Sonnet 4.6 @ 10K tokens (blended $9/M)' },
  { model: 'anthropic:claude-sonnet-4-6',    tokens: 6_700,   expected: 0.0603, label: 'Sonnet 4.6 @ 6,700 tokens' },
  { model: 'anthropic:claude-haiku-4-5',     tokens: 10_000,  expected: 0.0075, label: 'Haiku 4.5 @ 10K tokens (blended $0.75/M)' },
  // OpenAI
  { model: 'openai:gpt-5',                   tokens: 10_000,  expected: 0.20,   label: 'gpt-5 @ 10K tokens (blended $20/M)' },
  { model: 'openai:gpt-5-5-pro',             tokens: 10_000,  expected: 0.25,   label: 'gpt-5.5-pro @ 10K tokens (blended $25/M)' },
  // Google
  { model: 'google:gemini-2.5-pro',          tokens: 10_000,  expected: 0.07,   label: 'gemini-2.5-pro @ 10K tokens (blended $7/M)' },
  { model: 'google:gemini-3-flash',          tokens: 10_000,  expected: 0.0175, label: 'gemini-3-flash @ 10K tokens (blended $1.75/M)' },
  // Perplexity
  { model: 'perplexity:sonar-deep-research', tokens: 10_000,  expected: 0.05,   label: 'sonar-deep-research @ 10K tokens (blended $5/M)' },
  { model: 'perplexity:sonar-pro',           tokens: 10_000,  expected: 0.09,   label: 'sonar-pro @ 10K tokens (blended $9/M)' },
  // xAI
  { model: 'xai:grok-4',                     tokens: 10_000,  expected: 0.09,   label: 'grok-4 @ 10K tokens (blended $9/M)' },
  { model: 'xai:grok-4-x-search',            tokens: 10_000,  expected: 0.03,   label: 'grok-4-x-search @ 10K tokens (blended $3/M)' },
];

console.log('Per-model rate checks (±5%):');
for (const fx of fixtures) {
  const actual = estimateCostUsd(fx.model, fx.tokens);
  approxEq(actual, fx.expected, 0.05, fx.label);
}

console.log('\nUnits-bug guard (single-call ceiling):');
// No single call at typical context sizes should approach $100. If the rates
// table ever drifts back to per-1K units, a 10K-token Opus call would report
// $450 instead of $0.45 — this assertion catches that regression.
const opusBigCall = estimateCostUsd('anthropic:claude-opus-4-7', 50_000);
if (opusBigCall < 5) {
  console.log(`  ✅ Opus 50K-token call = $${opusBigCall.toFixed(4)} (sane, well under $5 ceiling)`);
  passed++;
} else {
  console.log(`  ❌ Opus 50K-token call = $${opusBigCall.toFixed(4)} — units-bug regression suspected (expected ~$2.25)`);
  failed++;
}

console.log('\nFallback rate for unknown models:');
const unknownCost = estimateCostUsd('fictional:nonexistent-model', 10_000);
// FALLBACK_RATE_PER_TOKEN = 5 / 1_000_000, so 10K tokens = $0.05
approxEq(unknownCost, 0.05, 0.01, 'unknown-model fallback @ 10K tokens (blended $5/M)');

console.log('\nZero-token + missing-model edge cases:');
const zeroCost = estimateCostUsd('anthropic:claude-opus-4-7', 0);
if (zeroCost === 0) {
  console.log('  ✅ zero tokens → $0');
  passed++;
} else {
  console.log(`  ❌ zero tokens → $${zeroCost} (expected $0)`);
  failed++;
}
const nullCost = estimateCostUsd('anthropic:claude-opus-4-7', null);
if (nullCost === 0) {
  console.log('  ✅ null tokens → $0');
  passed++;
} else {
  console.log(`  ❌ null tokens → $${nullCost} (expected $0)`);
  failed++;
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
