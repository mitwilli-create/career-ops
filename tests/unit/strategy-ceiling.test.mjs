/**
 * tests/unit/strategy-ceiling.test.mjs
 *
 * Unit tests for lib/strategy-ceiling.mjs.
 * All LLM calls use opts.llmClient mock — no real API calls.
 *
 * Run: node --test tests/unit/strategy-ceiling.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CACHE_DIR = join(ROOT, 'data', 'strategy-cache');

// Use a separate test cache dir to avoid polluting real data
const TEST_CACHE_SUFFIX = '-test-' + Date.now();

// 2026-05-25 popout-action-completed-mode — the legacy actions[] tests below
// run under env='0' (legacy mode). A new describe block at the bottom tests
// the new evidence[]/open_gaps[] schema under env='1' (data-first mode).
process.env.POPOUT_DATA_FIRST_MODE = '0';

import {
  computeStrategyCeiling,
  getCachedStrategy,
  forceRefresh,
  renderStrategyCard,
  buildCacheKey,
  currentPopoutMode,
} from '../../lib/strategy-ceiling.mjs';

// ── Mock LLM client factory ─────────────────────────────────────────────────

function makeMockClient(overrides = {}) {
  const validResponse = {
    current: 33,
    ceiling: 70,
    gap_pct: 37,
    actions: [
      { title: 'Strengthen narrative', what: 'Add a comms×AI case study to your cover letter.', why: 'Mirrors JD language directly.', effort: 'medium', expected_lift_pct: 12 },
      { title: 'Activate warm referral', what: 'Find a 2nd-degree LinkedIn connection at ElevenLabs.', why: 'Referrals improve interview rate 3-5×.', effort: 'high', expected_lift_pct: 15 },
      { title: 'Add shipping metric', what: 'Quantify a delivery velocity story in your cover letter.', why: 'ElevenLabs is a fast-shipping org; velocity signals match.', effort: 'low', expected_lift_pct: 8 },
    ],
    reasoning: 'Ceiling capped at 70% given no referral path currently and disclosure of budget is not ideal.',
    ...overrides,
  };
  return {
    call: async () => JSON.stringify(validResponse),
  };
}

function makeInvalidJsonClient() {
  return { call: async () => 'This is not JSON at all!' };
}

function makeInvalidSchemaClient() {
  return {
    call: async () => JSON.stringify({
      current: 33,
      ceiling: 70,
      // missing gap_pct and actions — schema invalid
    }),
  };
}

function makeThrowingClient() {
  return { call: async () => { throw new Error('network error'); } };
}

// ── computeStrategyCeiling — dry mode ───────────────────────────────────────

describe('computeStrategyCeiling — dry mode', () => {
  test('dry mode returns stub without LLM call', async () => {
    const result = await computeStrategyCeiling({
      rowId: 1,
      role: 'Communications Manager',
      company: 'ElevenLabs',
      metricKey: 'interview_likelihood',
      currentValue: 33,
      opts: { dry: true },
    });
    assert.equal(result._dry, true);
    assert.equal(result.current, 33);
    assert.ok(result.ceiling > 33, 'ceiling should exceed current');
    assert.ok(Array.isArray(result.actions));
    assert.ok(result.actions.length >= 3);
  });
});

// ── computeStrategyCeiling — mock LLM ───────────────────────────────────────

describe('computeStrategyCeiling — mock LLM client', () => {
  test('returns valid result from mock LLM response', async () => {
    const result = await computeStrategyCeiling({
      rowId: 50,
      role: 'Communications Manager',
      company: 'ElevenLabs',
      metricKey: 'interview_likelihood',
      currentValue: 33,
      jdText: 'We are looking for a communications lead who ships fast.',
      hmIntel: {},
      opts: { llmClient: makeMockClient(), maxAgeMs: 0 }, // maxAgeMs=0 bypasses cache
    });
    assert.equal(result.current, 33);
    assert.equal(result.ceiling, 70);
    assert.equal(result.gap_pct, 37);
    assert.ok(Array.isArray(result.actions));
    assert.ok(result.actions.length >= 3 && result.actions.length <= 5);
    assert.ok(result.cache_key, 'cache_key should be present');
  });

  test('actions have all required fields', async () => {
    const result = await computeStrategyCeiling({
      rowId: 51,
      role: 'AI Program Manager',
      company: 'Anthropic',
      metricKey: 'fit_score',
      currentValue: 55,
      opts: { llmClient: makeMockClient({ current: 55, ceiling: 85, gap_pct: 30 }), maxAgeMs: 0 },
    });
    for (const action of result.actions) {
      assert.ok(typeof action.title === 'string' && action.title.length > 0, 'title required');
      assert.ok(typeof action.what === 'string' && action.what.length > 0, 'what required');
      assert.ok(typeof action.why === 'string' && action.why.length > 0, 'why required');
      assert.ok(['low', 'medium', 'high'].includes(action.effort), `effort must be low|medium|high, got: ${action.effort}`);
      assert.ok(typeof action.expected_lift_pct === 'number', 'expected_lift_pct must be number');
    }
  });

  test('falls back to degraded result when LLM returns invalid JSON (2 attempts)', async () => {
    const result = await computeStrategyCeiling({
      rowId: 52,
      role: 'AI SA',
      company: 'xAI',
      metricKey: 'interview_likelihood',
      currentValue: 40,
      opts: { llmClient: makeInvalidJsonClient(), maxAgeMs: 0 },
    });
    assert.equal(result._degraded, true, 'should be degraded');
    assert.ok(Array.isArray(result.actions));
    // GAMMA fix 2026-05-19: degraded path emits ONE honest "unavailable" action
    // (not the 3 generic actions with fabricated lift numbers from pre-fix).
    assert.ok(result.actions.length >= 1, 'degraded path emits at least 1 action');
  });

  test('falls back to degraded result when LLM schema is invalid', async () => {
    const result = await computeStrategyCeiling({
      rowId: 53,
      role: 'AI SA',
      company: 'Perplexity',
      metricKey: 'fit_score',
      currentValue: 45,
      opts: { llmClient: makeInvalidSchemaClient(), maxAgeMs: 0 },
    });
    assert.equal(result._degraded, true);
  });

  test('throws when LLM client itself throws', async () => {
    await assert.rejects(
      () => computeStrategyCeiling({
        rowId: 54,
        role: 'AI PM',
        company: 'Cohere',
        metricKey: 'fit_score',
        currentValue: 60,
        opts: { llmClient: makeThrowingClient(), maxAgeMs: 0 },
      }),
      /LLM call failed/,
    );
  });
});

// ── Cache behavior ────────────────────────────────────────────────────────────

describe('getCachedStrategy + forceRefresh', () => {
  test('returns null for a cache key that does not exist', () => {
    const result = getCachedStrategy('nonexistent-key-' + Date.now());
    assert.equal(result, null);
  });

  test('getCachedStrategy returns fresh result after computeStrategyCeiling', async () => {
    const input = {
      rowId: 99,
      role: 'CacheTestRole',
      company: 'CacheTestCo',
      metricKey: 'cache_hit_test',
      currentValue: 50,
      opts: { llmClient: makeMockClient({ current: 50, ceiling: 80, gap_pct: 30 }), maxAgeMs: 60_000 },
    };
    const first = await computeStrategyCeiling(input);
    const cacheKey = first.cache_key;
    const cached = getCachedStrategy(cacheKey, 60_000);
    assert.ok(cached !== null, 'should find the cached entry');
    assert.equal(cached.current, 50);
    assert.equal(cached.ceiling, 80);
  });

  test('forceRefresh expires a cache entry', async () => {
    const input = {
      rowId: 100,
      role: 'ForceRefreshRole',
      company: 'ForceRefreshCo',
      metricKey: 'refresh_test',
      currentValue: 42,
      opts: { llmClient: makeMockClient({ current: 42, ceiling: 72, gap_pct: 30 }), maxAgeMs: 3_600_000 },
    };
    const first = await computeStrategyCeiling(input);
    const cacheKey = first.cache_key;
    forceRefresh(cacheKey);
    const afterRefresh = getCachedStrategy(cacheKey, 3_600_000);
    assert.equal(afterRefresh, null, 'forceRefresh should expire the entry');
  });

  test('computeStrategyCeiling returns _fromCache: true on second call within TTL', async () => {
    const input = {
      rowId: 101,
      role: 'DoubleCacheRole',
      company: 'DoubleCacheCo',
      metricKey: 'double_cache_test',
      currentValue: 60,
      opts: { llmClient: makeMockClient({ current: 60, ceiling: 85, gap_pct: 25 }), maxAgeMs: 3_600_000 },
    };
    const first = await computeStrategyCeiling(input);
    const second = await computeStrategyCeiling(input);
    assert.equal(second._fromCache, true, 'second call should hit cache');
    assert.equal(second.ceiling, 85);
  });
});

// ── buildCacheKey ─────────────────────────────────────────────────────────────

describe('buildCacheKey', () => {
  test('returns a deterministic string', () => {
    const key1 = buildCacheKey({ rowId: 1, metricKey: 'fit_score', company: 'Anthropic', role: 'AI PM' });
    const key2 = buildCacheKey({ rowId: 1, metricKey: 'fit_score', company: 'Anthropic', role: 'AI PM' });
    assert.equal(key1, key2);
  });

  test('differs when company changes', () => {
    const k1 = buildCacheKey({ rowId: 1, metricKey: 'fit_score', company: 'Anthropic', role: 'AI PM' });
    const k2 = buildCacheKey({ rowId: 1, metricKey: 'fit_score', company: 'OpenAI', role: 'AI PM' });
    assert.notEqual(k1, k2);
  });

  test('differs when metricKey changes', () => {
    const k1 = buildCacheKey({ rowId: 1, metricKey: 'fit_score', company: 'Anthropic', role: 'AI PM' });
    const k2 = buildCacheKey({ rowId: 1, metricKey: 'interview_likelihood', company: 'Anthropic', role: 'AI PM' });
    assert.notEqual(k1, k2);
  });
});

// ── renderStrategyCard ────────────────────────────────────────────────────────

describe('renderStrategyCard', () => {
  test('returns an HTML string with action titles', () => {
    const result = {
      current: 33,
      ceiling: 70,
      gap_pct: 37,
      actions: [
        { title: 'Add referral', what: 'Get a warm intro.', why: 'Referrals work.', effort: 'high', expected_lift_pct: 15 },
        { title: 'Tailor cover letter', what: 'Mirror JD language.', why: 'ATS wins.', effort: 'medium', expected_lift_pct: 10 },
        { title: 'Quick win: GitHub link', what: 'Add career-ops link.', why: 'Shows builder cred.', effort: 'low', expected_lift_pct: 5 },
      ],
      reasoning: 'Ceiling constrained by lack of referral path.',
    };
    const html = renderStrategyCard(result);
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('Add referral'), 'should include action title');
    assert.ok(html.includes('33%') || html.includes('>33<'), 'should show current value');
    assert.ok(html.includes('70%') || html.includes('>70<'), 'should show ceiling');
    assert.ok(html.includes('Ceiling constrained'), 'should include reasoning');
  });

  test('renders degraded warning when _degraded is true', () => {
    const result = {
      current: 40,
      ceiling: 60,
      gap_pct: 20,
      actions: [
        { title: 'Manual review', what: 'Check JD.', why: 'LLM unavailable.', effort: 'medium', expected_lift_pct: 5 },
        { title: 'Narrative update', what: 'Update cover letter.', why: 'Match JD framing.', effort: 'medium', expected_lift_pct: 8 },
        { title: 'Warm path', what: 'Find LinkedIn connection.', why: 'Referrals help.', effort: 'high', expected_lift_pct: 15 },
      ],
      _degraded: true,
    };
    const html = renderStrategyCard(result);
    assert.ok(html.includes('LLM unavailable') || html.includes('fallback'), 'should show degraded warning');
  });

  test('handles empty actions array gracefully', () => {
    const result = { current: 50, ceiling: 75, gap_pct: 25, actions: [] };
    const html = renderStrategyCard(result);
    assert.ok(typeof html === 'string');
    // Should not throw even with no actions
  });

  test('shows corpus_ref when present in action', () => {
    const result = {
      current: 50,
      ceiling: 80,
      gap_pct: 30,
      actions: [
        { title: 'Use STAR story', what: 'Tell the Comms Triage story.', why: 'Builder cred.', effort: 'low', expected_lift_pct: 10, corpus_ref: 'story-bank.md: Comms Triage Agent' },
        { title: 'Action 2', what: 'Do X.', why: 'Because Y.', effort: 'medium', expected_lift_pct: 8 },
        { title: 'Action 3', what: 'Do Z.', why: 'Because W.', effort: 'high', expected_lift_pct: 12 },
      ],
    };
    const html = renderStrategyCard(result);
    assert.ok(html.includes('story-bank.md'), 'should include corpus_ref');
  });
});

// ── DATA-FIRST MODE — 2026-05-25 popout-action-completed-mode refactor ───────
//
// New schema: evidence[] (what's on disk) + open_gaps[] (what's missing +
// suggested_agent). Mode dispatched via POPOUT_DATA_FIRST_MODE env (default
// '1'); the existing tests above force '0' for legacy. This block runs under '1'.

describe('computeStrategyCeiling — data-first mode (POPOUT_DATA_FIRST_MODE=1)', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.POPOUT_DATA_FIRST_MODE; process.env.POPOUT_DATA_FIRST_MODE = '1'; });
  afterEach(() => { if (originalEnv == null) delete process.env.POPOUT_DATA_FIRST_MODE; else process.env.POPOUT_DATA_FIRST_MODE = originalEnv; });

  test('currentPopoutMode reports "data-first" when env=1', () => {
    assert.equal(currentPopoutMode(), 'data-first');
  });

  test('currentPopoutMode reports "legacy" when env=0', () => {
    process.env.POPOUT_DATA_FIRST_MODE = '0';
    assert.equal(currentPopoutMode(), 'legacy');
  });

  test('dry mode returns evidence[]+open_gaps[] stub with _mode flag', async () => {
    const result = await computeStrategyCeiling({
      rowId: 200,
      role: 'AI PgM',
      company: 'Anthropic',
      metricKey: 'alignment',
      currentValue: 45,
      opts: { dry: true },
    });
    assert.equal(result._dry, true);
    assert.equal(result._mode, 'data-first');
    assert.ok(Array.isArray(result.evidence));
    assert.ok(Array.isArray(result.open_gaps));
    assert.ok(result.evidence.length + result.open_gaps.length >= 1);
    // Should NOT have legacy actions[] field
    assert.equal(result.actions, undefined);
  });

  test('mock LLM emitting data-first shape passes validation + writes cache', async () => {
    const dataFirstClient = {
      call: async () => JSON.stringify({
        current: 45,
        ceiling: 75,
        gap_pct: 30,
        evidence: [
          { what_data: 'cv.md frontend-comms section', what_it_reveals: 'Mitchell has 4 years of AI-aligned comms experience at Anthropic-adjacent orgs.', source_path: 'cv.md', source_date: '2026-05-24', confidence: 'high' },
          { what_data: 'hm-intel: Sarah Chen LinkedIn 2026-04', what_it_reveals: 'HM posts about AI-PgM hires emphasizing scrappy execution.', source_path: 'data/hm-intel/anthropic-ai-pgm.json', confidence: 'medium' },
        ],
        open_gaps: [
          { what_is_missing: 'apply-pack tailored to this JD', why_it_matters: 'Cover letter currently uses generic framing — should mirror Sarah Chen post language.', suggested_agent: 'build-apply-pack', est_cost_usd: 0.35 },
        ],
        reasoning: 'Strong fit; gap is in artifact polish not in candidate-evidence.',
      }),
    };
    const result = await computeStrategyCeiling({
      rowId: 201,
      role: 'AI PgM',
      company: 'Anthropic',
      metricKey: 'alignment',
      currentValue: 45,
      opts: { llmClient: dataFirstClient, maxAgeMs: 0 },
    });
    assert.equal(result._mode, 'data-first');
    assert.equal(result.current, 45);
    assert.equal(result.ceiling, 75);
    assert.ok(Array.isArray(result.evidence));
    assert.equal(result.evidence.length, 2);
    assert.equal(result.evidence[0].source_path, 'cv.md');
    assert.ok(Array.isArray(result.open_gaps));
    assert.equal(result.open_gaps[0].suggested_agent, 'build-apply-pack');
    // Should NOT have legacy actions[] field
    assert.equal(result.actions, undefined);
  });

  test('validator rejects data-first response when evidence+gaps total is 0', async () => {
    const emptyClient = {
      call: async () => JSON.stringify({
        current: 50,
        ceiling: 80,
        gap_pct: 30,
        evidence: [],
        open_gaps: [],
        reasoning: 'Empty.',
      }),
    };
    const result = await computeStrategyCeiling({
      rowId: 202,
      role: 'AI Architect',
      company: 'OpenAI',
      metricKey: 'interview_likelihood',
      currentValue: 50,
      opts: { llmClient: emptyClient, maxAgeMs: 0 },
    });
    // Validator rejects → 2 attempts fail → degraded
    assert.equal(result._degraded, true);
    assert.equal(result._mode, 'data-first');
    assert.ok(Array.isArray(result.evidence));
    assert.ok(Array.isArray(result.open_gaps));
    // Degraded path emits one honest open_gap explaining the LLM didn't respond
    assert.ok(result.open_gaps.length >= 1);
  });

  test('validator enforces the documented 0-5 cap — over-emitted arrays are truncated with a note', async () => {
    const evidenceItem = (n) => ({
      what_data: `source ${n}`,
      what_it_reveals: `Fact ${n} about the candidate-role fit.`,
      source_path: `data/fixture-${n}.json`,
      confidence: 'medium',
    });
    const gapItem = (n) => ({
      what_is_missing: `missing artifact ${n}`,
      why_it_matters: `Blocks polish step ${n}.`,
      suggested_agent: 'build-apply-pack',
    });
    const overEmittingClient = {
      call: async () => JSON.stringify({
        current: 40,
        ceiling: 70,
        gap_pct: 30,
        evidence: Array.from({ length: 7 }, (_, i) => evidenceItem(i + 1)),
        open_gaps: Array.from({ length: 6 }, (_, i) => gapItem(i + 1)),
        reasoning: 'Over-emitted on purpose.',
      }),
    };
    const result = await computeStrategyCeiling({
      rowId: 203,
      role: 'AI Enablement Lead',
      company: 'Cohere',
      metricKey: 'alignment',
      currentValue: 40,
      opts: { llmClient: overEmittingClient, maxAgeMs: 0 },
    });
    // Not degraded — over-emission is truncated, not rejected
    assert.notEqual(result._degraded, true);
    assert.equal(result._mode, 'data-first');
    assert.equal(result.evidence.length, 5);
    assert.equal(result.open_gaps.length, 5);
    // First 5 items kept in order
    assert.equal(result.evidence[0].what_data, 'source 1');
    assert.equal(result.evidence[4].what_data, 'source 5');
    assert.equal(result.open_gaps[4].what_is_missing, 'missing artifact 5');
    // Truncation note surfaces on the result
    assert.equal(result._evidence_truncated, true);
    assert.equal(result._open_gaps_truncated, true);
  });

  test('validator does not flag truncation when arrays are within the 0-5 cap', async () => {
    const withinCapClient = {
      call: async () => JSON.stringify({
        current: 40,
        ceiling: 70,
        gap_pct: 30,
        evidence: [
          { what_data: 'cv.md', what_it_reveals: 'Relevant experience.', source_path: 'cv.md', confidence: 'high' },
        ],
        open_gaps: [],
        reasoning: 'Within cap.',
      }),
    };
    const result = await computeStrategyCeiling({
      rowId: 204,
      role: 'AI Enablement Lead',
      company: 'Cohere',
      metricKey: 'hm_chance',
      currentValue: 40,
      opts: { llmClient: withinCapClient, maxAgeMs: 0 },
    });
    assert.notEqual(result._degraded, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result._evidence_truncated, undefined);
    assert.equal(result._open_gaps_truncated, undefined);
  });

  test('cache hits enforce the 0-5 cap too — pre-cap oversized entries are truncated on read', () => {
    // Simulate a cache entry written BEFORE the cap existed: 7 evidence + 6 gaps.
    const staleKey = `test-precap-oversized${TEST_CACHE_SUFFIX}`;
    const staleEntry = {
      current: 40,
      ceiling: 70,
      gap_pct: 30,
      evidence: Array.from({ length: 7 }, (_, i) => ({
        what_data: `cached source ${i + 1}`,
        what_it_reveals: `Cached fact ${i + 1}.`,
        source_path: `data/cached-${i + 1}.json`,
      })),
      open_gaps: Array.from({ length: 6 }, (_, i) => ({
        what_is_missing: `cached gap ${i + 1}`,
        why_it_matters: 'Cached.',
        suggested_agent: 'intel-refresh',
      })),
      _mode: 'data-first',
      generated_at: Date.now(),
    };
    mkdirSync(CACHE_DIR, { recursive: true });
    const stalePath = join(CACHE_DIR, `${staleKey}.json`);
    writeFileSync(stalePath, JSON.stringify(staleEntry));
    try {
      const cached = getCachedStrategy(staleKey, 60_000);
      assert.ok(cached, 'fresh cache entry should be served');
      assert.equal(cached.evidence.length, 5);
      assert.equal(cached.open_gaps.length, 5);
      assert.equal(cached.evidence[4].what_data, 'cached source 5');
      assert.equal(cached._evidence_truncated, true);
      assert.equal(cached._open_gaps_truncated, true);
    } finally {
      rmSync(stalePath, { force: true });
    }
  });

  test('cache read cap is a no-op for legacy actions[] entries', () => {
    const legacyKey = `test-precap-legacy${TEST_CACHE_SUFFIX}`;
    const legacyEntry = {
      current: 33,
      ceiling: 70,
      gap_pct: 37,
      actions: [
        { title: 'A', what: 'W', why: 'Y', effort: 'low', expected_lift_pct: 5 },
      ],
      _mode: 'legacy',
      generated_at: Date.now(),
    };
    mkdirSync(CACHE_DIR, { recursive: true });
    const legacyPath = join(CACHE_DIR, `${legacyKey}.json`);
    writeFileSync(legacyPath, JSON.stringify(legacyEntry));
    try {
      const cached = getCachedStrategy(legacyKey, 60_000);
      assert.ok(cached, 'fresh legacy entry should be served');
      assert.equal(cached.actions.length, 1);
      assert.equal(cached._evidence_truncated, undefined);
      assert.equal(cached._open_gaps_truncated, undefined);
    } finally {
      rmSync(legacyPath, { force: true });
    }
  });

  test('cache key includes mode discriminator (data-first vs legacy)', async () => {
    const dataFirstClient = {
      call: async () => JSON.stringify({
        current: 60,
        ceiling: 85,
        gap_pct: 25,
        evidence: [{ what_data: 'X', what_it_reveals: 'Y', source_path: 'cv.md', confidence: 'medium' }],
        open_gaps: [{ what_is_missing: 'X', why_it_matters: 'Y', suggested_agent: 'intel-refresh', est_cost_usd: 1.0 }],
      }),
    };
    const result = await computeStrategyCeiling({
      rowId: 300,
      role: 'CacheModeRole',
      company: 'CacheModeCo',
      metricKey: 'alignment',
      currentValue: 60,
      opts: { llmClient: dataFirstClient, maxAgeMs: 60_000 },
    });
    assert.ok(result.cache_key.endsWith('-data-first'), `cache_key should embed mode, got: ${result.cache_key}`);
  });

  test('renderStrategyCard auto-dispatches data-first shape', () => {
    const result = {
      current: 45,
      ceiling: 75,
      gap_pct: 30,
      evidence: [
        { what_data: 'cv.md AI-comms section', what_it_reveals: 'Mitchell ran AI-bot comms at WDRB.', source_path: 'cv.md', source_date: '2026-05-24', confidence: 'high' },
      ],
      open_gaps: [
        { what_is_missing: 'apply pack', why_it_matters: 'No cover letter yet.', suggested_agent: 'build-apply-pack', est_cost_usd: 0.35 },
      ],
      _mode: 'data-first',
    };
    const html = renderStrategyCard(result);
    assert.ok(typeof html === 'string');
    assert.ok(html.includes('cv.md'), 'should cite source path');
    assert.ok(html.includes('AI-bot comms'), 'should include evidence synthesis');
    assert.ok(html.includes('apply pack'), 'should include open gap');
    assert.ok(html.includes('build-apply-pack'), 'should show suggested_agent in button');
    assert.ok(html.includes('strategy-card--data-first'), 'should tag the card with data-first class');
  });

  test('renderStrategyCard data-first auto-detects via evidence[] presence even without _mode flag', () => {
    const result = {
      current: 50,
      ceiling: 80,
      gap_pct: 30,
      evidence: [{ what_data: 'X', what_it_reveals: 'Y', source_path: 'cv.md', confidence: 'medium' }],
      open_gaps: [],
    };
    const html = renderStrategyCard(result);
    assert.ok(html.includes('strategy-card--data-first'), 'should detect data-first shape from evidence[] presence');
  });

  test('renderStrategyCard surfaces noContent block when both arrays empty', () => {
    const result = {
      current: 50,
      ceiling: 80,
      gap_pct: 30,
      evidence: [],
      open_gaps: [],
      _mode: 'data-first',
    };
    const html = renderStrategyCard(result);
    assert.ok(html.includes('No evidence cited'), 'noContent block should surface');
  });
});
