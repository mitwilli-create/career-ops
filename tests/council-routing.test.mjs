#!/usr/bin/env node
/**
 * tests/council-routing.test.mjs
 *
 * Cost-distribution Part 2 (2026-05-25) — verifies routing + vendor caps
 * in lib/council.mjs. No live API calls.
 *
 * Usage: node --test tests/council-routing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LINEUP,
  COUNCIL_FANOUT_LINEUP,
  TASK_ROUTING_MATRIX,
  VENDOR_MONTHLY_CAP_DEFAULTS,
  routeByArchetype,
  vendorFamilyOf,
  getVendorMonthlyCapUsd,
  getVendorMonthlySpendUsd,
  checkVendorCap,
  callCouncil,
} from '../lib/council.mjs';

test('T1 routeByArchetype returns expected vendor', () => {
  assert.deepEqual(routeByArchetype('long_form_research'), ['perplexity:sonar-pro']);
  assert.deepEqual(routeByArchetype('code_refactor_multifile'), ['anthropic:claude-opus-4-7']);
  assert.deepEqual(routeByArchetype('structured_extraction'), ['anthropic:claude-sonnet-4-6']);
  assert.deepEqual(routeByArchetype('realtime_x_twitter'), ['xai:grok-4']);
  assert.deepEqual(routeByArchetype('voice_match_writing'), ['anthropic:claude-opus-4-7']);
  assert.deepEqual(routeByArchetype('strategic_reasoning'), ['anthropic:claude-opus-4-7']);
  assert.deepEqual(routeByArchetype('agent_orchestration_mcp'), ['anthropic:claude-opus-4-7']);
  assert.deepEqual(routeByArchetype('conversational_chat'), ['google:gemini-2.5-flash']);
  assert.deepEqual(routeByArchetype('image_understanding'), ['google:gemini-2.5-flash']);
  assert.deepEqual(routeByArchetype('long_context_500k_plus'), ['google:gemini-2.5-pro']);
});

test('T2 routeByArchetype unknown / null / undefined → DEFAULT_LINEUP', () => {
  assert.deepEqual(routeByArchetype('completely_unknown_archetype'), DEFAULT_LINEUP);
  assert.deepEqual(routeByArchetype(null), DEFAULT_LINEUP);
  assert.deepEqual(routeByArchetype(undefined), DEFAULT_LINEUP);
  assert.deepEqual(routeByArchetype(''), DEFAULT_LINEUP);
  assert.deepEqual(routeByArchetype(123), DEFAULT_LINEUP);
});

test('T3 DEFAULT_LINEUP is single-vendor Sonnet 4.6', () => {
  assert.deepEqual(DEFAULT_LINEUP, ['anthropic:claude-sonnet-4-6']);
});

test('T4 COUNCIL_FANOUT_LINEUP preserves 4-vendor fan-out shape', () => {
  assert.equal(COUNCIL_FANOUT_LINEUP.length, 4);
  assert.ok(COUNCIL_FANOUT_LINEUP.includes('anthropic:claude-sonnet-4-6'));
  assert.ok(COUNCIL_FANOUT_LINEUP.includes('openai:gpt-5'));
  assert.ok(COUNCIL_FANOUT_LINEUP.includes('google:gemini-2.5-pro'));
  assert.ok(COUNCIL_FANOUT_LINEUP.includes('perplexity:sonar-pro'));
});

test('T5 vendorFamilyOf parses provider:model correctly', () => {
  assert.equal(vendorFamilyOf('anthropic:claude-sonnet-4-6'), 'anthropic');
  assert.equal(vendorFamilyOf('openai:gpt-5'), 'openai');
  assert.equal(vendorFamilyOf('xai:grok-4'), 'xai');
  assert.equal(vendorFamilyOf('perplexity:sonar-pro'), 'perplexity');
  assert.equal(vendorFamilyOf('google:gemini-2.5-flash'), 'google');
  assert.equal(vendorFamilyOf('ANTHROPIC:claude'), 'anthropic');
  assert.equal(vendorFamilyOf('nope'), null);
  assert.equal(vendorFamilyOf(''), null);
  assert.equal(vendorFamilyOf(null), null);
  assert.equal(vendorFamilyOf(undefined), null);
});

test('T6 getVendorMonthlyCapUsd uses env override when set', () => {
  const prior = process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
  try {
    process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = '999';
    assert.equal(getVendorMonthlyCapUsd('anthropic'), 999);
    process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = '0';
    assert.equal(getVendorMonthlyCapUsd('anthropic'), 0);
    process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = 'abc';
    assert.equal(getVendorMonthlyCapUsd('anthropic'), VENDOR_MONTHLY_CAP_DEFAULTS.anthropic);
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
    else process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = prior;
  }
});

test('T7 getVendorMonthlyCapUsd falls back to defaults', () => {
  const prior = process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD;
  try {
    delete process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD;
    assert.equal(getVendorMonthlyCapUsd('openai'), 70);
    assert.equal(getVendorMonthlyCapUsd('xai'), 50);
    assert.equal(getVendorMonthlyCapUsd('perplexity'), 50);
    assert.equal(getVendorMonthlyCapUsd('google'), 50);
    assert.equal(getVendorMonthlyCapUsd('unknown'), 0);
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD;
    else process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD = prior;
  }
});

test('T8 checkVendorCap returns ok:true when spend << cap', () => {
  const prior = process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
  try {
    process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = '400';
    const r = checkVendorCap('anthropic:claude-sonnet-4-6', 1.50);
    assert.equal(r.ok, true);
    assert.equal(r.vendor, 'anthropic');
    assert.equal(r.cap, 400);
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
    else process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = prior;
  }
});

test('T9 checkVendorCap returns ok:false when spend exceeds cap', () => {
  const prior = process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD;
  try {
    process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD = '0.01';
    const r = checkVendorCap('openai:gpt-5', 100);
    assert.equal(r.ok, false);
    assert.equal(r.vendor, 'openai');
    assert.equal(r.cap, 0.01);
    assert.ok(r.message.includes('COUNCIL_CAP_REACHED'));
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD;
    else process.env.COUNCIL_OPENAI_MONTHLY_CAP_USD = prior;
  }
});

test('T10 checkVendorCap message format matches spec', () => {
  const prior = process.env.COUNCIL_XAI_MONTHLY_CAP_USD;
  try {
    process.env.COUNCIL_XAI_MONTHLY_CAP_USD = '0.01';
    const r = checkVendorCap('xai:grok-4', 5);
    assert.equal(r.ok, false);
    assert.match(r.message, /^COUNCIL_CAP_REACHED:/);
    assert.match(r.message, /vendor=xai/);
    assert.match(r.message, /month=\$\d+\.\d{2}/);
    assert.match(r.message, /cap=\$\d+\.\d{2}/);
    assert.match(r.message, /set COUNCIL_XAI_MONTHLY_CAP_USD higher/);
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_XAI_MONTHLY_CAP_USD;
    else process.env.COUNCIL_XAI_MONTHLY_CAP_USD = prior;
  }
});

test('T11 checkVendorCap with cap=0 always returns ok:true', () => {
  const prior = process.env.COUNCIL_PERPLEXITY_MONTHLY_CAP_USD;
  try {
    process.env.COUNCIL_PERPLEXITY_MONTHLY_CAP_USD = '0';
    const r = checkVendorCap('perplexity:sonar-pro', 999999);
    assert.equal(r.ok, true);
    assert.equal(r.cap, 0);
  } finally {
    if (prior === undefined) delete process.env.COUNCIL_PERPLEXITY_MONTHLY_CAP_USD;
    else process.env.COUNCIL_PERPLEXITY_MONTHLY_CAP_USD = prior;
  }
});

test('T12 callCouncil with no models AND no taskType → DEFAULT_LINEUP', async () => {
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await callCouncil({
      prompt: 'noop',
      opts: { timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.results.length, 0);
    assert.equal(r.missingKeys.length, 1);
    assert.equal(r.missingKeys[0].model, 'anthropic:claude-sonnet-4-6');
  } finally {
    if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
  }
});

test('T13 callCouncil with opts.taskType → routes per matrix', async () => {
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await callCouncil({
      prompt: 'noop',
      opts: { taskType: 'voice_match_writing', timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.missingKeys.length, 1);
    assert.equal(r.missingKeys[0].model, 'anthropic:claude-opus-4-7');
  } finally {
    if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
  }
});

test('T14 callCouncil with explicit models always wins over taskType', async () => {
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await callCouncil({
      prompt: 'noop',
      models: ['openai:gpt-5'],
      opts: { taskType: 'structured_extraction', timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.missingKeys.length, 1);
    assert.equal(r.missingKeys[0].model, 'openai:gpt-5');
  } finally {
    if (prior !== undefined) process.env.OPENAI_API_KEY = prior;
  }
});

test('T15 callCouncil capReached flag set when cap exceeded', async () => {
  const priorCap = process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = '0.0001';
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  try {
    const r = await callCouncil({
      prompt: 'noop',
      opts: { taskType: 'structured_extraction', timeoutMs: 100, maxTokens: 1000 },
    });
    assert.equal(r.results.length, 1);
    const result = r.results[0];
    assert.equal(result.capReached, true);
    assert.match(result.error, /COUNCIL_CAP_REACHED/);
  } finally {
    if (priorCap === undefined) delete process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD;
    else process.env.COUNCIL_ANTHROPIC_MONTHLY_CAP_USD = priorCap;
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
  }
});

test('T16 google:gemini-2.5-flash accepts EITHER free or paid key', async () => {
  const priorFree = process.env.GEMINI_FREE_API_KEY;
  const priorPaid = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_FREE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_FREE_API_KEY = 'free-test';
    let r = await callCouncil({
      prompt: 'noop',
      models: ['google:gemini-2.5-flash'],
      opts: { timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.missingKeys.length, 0);

    delete process.env.GEMINI_FREE_API_KEY;
    process.env.GEMINI_API_KEY = 'paid-test';
    r = await callCouncil({
      prompt: 'noop',
      models: ['google:gemini-2.5-flash'],
      opts: { timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.missingKeys.length, 0);

    delete process.env.GEMINI_API_KEY;
    r = await callCouncil({
      prompt: 'noop',
      models: ['google:gemini-2.5-flash'],
      opts: { timeoutMs: 1, vendorCapsDisabled: true },
    });
    assert.equal(r.missingKeys.length, 1);
    assert.match(r.missingKeys[0].missingEnvVar, /FREE_API_KEY or GEMINI_API_KEY/);
  } finally {
    if (priorFree === undefined) delete process.env.GEMINI_FREE_API_KEY;
    else process.env.GEMINI_FREE_API_KEY = priorFree;
    if (priorPaid === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorPaid;
  }
});

test('T17 TASK_ROUTING_MATRIX exposed + every value is non-empty array', () => {
  assert.ok(typeof TASK_ROUTING_MATRIX === 'object' && TASK_ROUTING_MATRIX !== null);
  const keys = Object.keys(TASK_ROUTING_MATRIX);
  assert.ok(keys.length >= 14);
  for (const k of keys) {
    assert.ok(Array.isArray(TASK_ROUTING_MATRIX[k]), `archetype ${k} must be array`);
    assert.ok(TASK_ROUTING_MATRIX[k].length >= 1, `archetype ${k} must be non-empty`);
    for (const m of TASK_ROUTING_MATRIX[k]) {
      assert.match(m, /^[a-z]+:[a-z0-9.-]+$/, `archetype ${k} model "${m}" must be provider:model shape`);
    }
  }
});

test('T18 getVendorMonthlySpendUsd handles missing data dir gracefully', () => {
  const r = getVendorMonthlySpendUsd('anthropic', '/nonexistent/path');
  assert.equal(r, 0);
  assert.equal(getVendorMonthlySpendUsd(null), 0);
  assert.equal(getVendorMonthlySpendUsd(undefined), 0);
});
