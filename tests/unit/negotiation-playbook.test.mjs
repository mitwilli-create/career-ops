import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNegotiationPlaybook,
  renderPlaybookHtml,
  FLOOR_BASE,
  TARGET_TC_LOW,
  TARGET_TC_HIGH,
  AUTO_ACTIVATE_THRESHOLD,
} from '../../lib/negotiation-playbook.mjs';

// ─── Constants verification ───────────────────────────────────────────────────

test('example default constants are wired', () => {
  assert.equal(FLOOR_BASE, 150_000, 'floor base example default');
  assert.equal(TARGET_TC_LOW, 200_000, 'target TC low example default');
  assert.equal(TARGET_TC_HIGH, 275_000, 'target TC high example default');
  assert.equal(AUTO_ACTIVATE_THRESHOLD, 250_000, 'auto-activate example default');
});

// ─── getNegotiationPlaybook: activation logic ─────────────────────────────────

test('playbook activates at $300K offer', () => {
  const result = getNegotiationPlaybook({ offer_total: 300_000, stage: 'series-c', ai_native: true });
  assert.ok(result.activate, 'activate is true at $300K');
  assert.ok(result.scripts.length >= 3, 'at least 3 scripts');
});

test('playbook activates with competing offer even below $300K', () => {
  const result = getNegotiationPlaybook({
    offer_total: 240_000,
    stage: 'series-c',
    candidate_leverage: { competing_offers: 1 },
  });
  assert.ok(result.activate, 'competing offer triggers activation');
  assert.equal(result.reason, 'competing_offer_leverage');
});

test('playbook does NOT activate below threshold with no leverage', () => {
  const result = getNegotiationPlaybook({ offer_total: 200_000, stage: 'series-c', ai_native: false });
  assert.ok(!result.activate, 'inactive below threshold');
  assert.equal(result.scripts.length, 0);
  assert.equal(result.talking_points.length, 0);
});

test('playbook includes cash-equity-flip script for ai_native', () => {
  const result = getNegotiationPlaybook({ offer_total: 320_000, stage: 'series-c', ai_native: true });
  const scenarios = result.scripts.map(s => s.scenario);
  assert.ok(scenarios.includes('cash_equity_flip'), 'ai_native gets cash-equity flip script');
});

test('playbook does NOT include cash-equity-flip for non-ai-native', () => {
  const result = getNegotiationPlaybook({ offer_total: 320_000, stage: 'series-b', ai_native: false });
  const scenarios = result.scripts.map(s => s.scenario);
  assert.ok(!scenarios.includes('cash_equity_flip'), 'non-ai-native no cash-equity flip');
});

test('all scripts have required fields', () => {
  const result = getNegotiationPlaybook({ offer_total: 350_000, stage: 'series-c', ai_native: true });
  for (const script of result.scripts) {
    assert.ok(script.scenario, 'has scenario');
    assert.ok(script.opener, 'has opener');
    assert.ok(script.counter_anchor, 'has counter_anchor');
    assert.ok(script.fallback, 'has fallback');
    assert.ok(script.walk_away, 'has walk_away');
  }
});

test('walk_away script always references $110K floor', () => {
  const result = getNegotiationPlaybook({ offer_total: 300_000, stage: 'series-c' });
  const baseScript = result.scripts.find(s => s.scenario === 'base_counter_anchor');
  assert.ok(baseScript, 'base_counter_anchor script exists');
  assert.ok(baseScript.walk_away.includes('150,000') || baseScript.walk_away.includes('$150K'), 'walk_away references floor');
});

test('expected_uplift is positive and p90 >= p50', () => {
  const result = getNegotiationPlaybook({
    offer_total: 320_000,
    stage: 'series-c',
    ai_native: true,
    candidate_leverage: { competing_offers: 2 },
  });
  assert.ok(result.expected_uplift.p50 > 0, 'p50 uplift positive');
  assert.ok(result.expected_uplift.p90 >= result.expected_uplift.p50, 'p90 >= p50');
});

test('talking_points include floor and target range', () => {
  const result = getNegotiationPlaybook({ offer_total: 310_000, stage: 'series-c', ai_native: true });
  const tpText = result.talking_points.join(' ');
  assert.ok(tpText.includes('150,000') || tpText.includes('$150K'), 'talking points mention floor');
  assert.ok(tpText.includes('200,000') || tpText.includes('200'), 'talking points mention target low');
  assert.ok(tpText.includes('275,000') || tpText.includes('275'), 'talking points mention target high');
});

test('throws on invalid offer_total', () => {
  assert.throws(() => getNegotiationPlaybook({ offer_total: 0 }), /positive number/);
  assert.throws(() => getNegotiationPlaybook({ offer_total: -100 }), /positive number/);
  assert.throws(() => getNegotiationPlaybook({ offer_total: 'abc' }), /positive number/);
});

// ─── renderPlaybookHtml ───────────────────────────────────────────────────────

test('renderPlaybookHtml: returns HTML when active', () => {
  const playbook = getNegotiationPlaybook({ offer_total: 320_000, stage: 'series-c', ai_native: true });
  const html = renderPlaybookHtml(playbook);
  assert.ok(typeof html === 'string' && html.length > 100);
  assert.ok(html.includes('negotiation-playbook-widget'), 'has widget class');
  assert.ok(html.includes('ACTIVE'), 'shows ACTIVE label');
});

test('renderPlaybookHtml: returns inactive message when not active', () => {
  const playbook = getNegotiationPlaybook({ offer_total: 190_000, stage: 'series-c' });
  const html = renderPlaybookHtml(playbook);
  assert.ok(html.includes('inactive'), 'shows inactive message');
});
