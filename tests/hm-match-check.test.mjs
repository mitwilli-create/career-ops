#!/usr/bin/env node
/**
 * tests/hm-match-check.test.mjs
 *
 * Fixture tests for lib/hm-match-check.mjs (Step 2b of pre-apply-check
 * deepening). Mocks callCouncil + loadHmIntel via opts injection — zero
 * live API calls; total runtime sub-second.
 *
 * Covers (per dealbreaker-final-pre-apply-2026-05-24.md):
 *   T1  happy path — model returns score 0.85 → status:'pass'
 *   T2  caveats threshold — score 0.65 → status:'caveats'
 *   T3  fail threshold — score 0.30 → status:'fail'
 *   T4  hm-intel file missing → status:'unavailable'
 *   T5  callCouncil throws → status:'error'
 *   T6  malformed JSON response → status:'error' with parse-error message
 *   T7  PRE_APPLY_HM_MODEL env var respected (verifies model arg)
 *   T8  cache-stable persona block wired (verifies cacheStableContent in opts)
 *
 * Usage:  node tests/hm-match-check.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import {
  hmMatchCheck,
  resolveModel,
  buildPersonaBlock,
  parseHmMatchResponse,
  _internal,
} from '../lib/hm-match-check.mjs';

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

// ── Fixture HM intel (synthetic — not based on any real person) ───────────

const FIXTURE_INTEL = Object.freeze({
  company: 'TestLabs',
  role: 'Test Solutions Architect',
  url: 'https://example.invalid/jobs/123',
  synthesized_at: '2026-05-25T00:00:00Z',
  providers_called: ['anthropic:claude-sonnet-4-6'],
  providers_succeeded: ['anthropic:claude-sonnet-4-6'],
  role_summary: 'A forward-deployed engineer-slash-solutions-architect role bridging customer-facing technical work with production agent development.',
  alignment_with_goals: 'Mitchell\'s comms-to-builder arc fits this role\'s blend of customer trust + technical depth.',
  fit_evidence: {
    career_history: 'AJ+ then Google internal comms then production agent shipping.',
    skills_match: 'Agent dev, customer-facing solutioning, cross-functional comms.',
    narrative_arc: 'Domain-expert-turned-builder pattern.',
  },
  hiring_managers: [{ name: 'unknown', title: 'unknown' }],
  recruiters: [{ name: 'unknown', title: 'Recruiter' }],
  comp_intelligence: { base_range: '$130k-$280k', equity_summary: 'RSU', total_comp_estimate: '$350-550k', comp_sources: [] },
  outreach_strategy: {
    best_first_move: 'Warm-path intro from prior Google colleagues.',
    lead_with: 'Production agent + vertical-domain combo.',
  },
  signals: [
    'ships production agent systems',
    'bridges customer-facing solutioning + technical depth',
    'fluent in vertical-domain workflow context',
    'translates technical capability into business outcomes',
    'cross-functional comms across eng + GTM',
  ],
  _meta: { owner: 'test-fixture', method: 'unit-test', cost_usd: 0 },
});

const FIXTURE_ARTIFACTS = Object.freeze({
  cv: 'Senior engineer with 8 years of forward-deployed production agent work...'.repeat(20),
  cover_letter: 'I have shipped production agent systems and bridged technical depth with customer-facing solutioning...'.repeat(10),
});

const FIXTURE_JD = 'Test Solutions Architect role at TestLabs requiring production agent skills, vertical-domain fluency, and cross-functional comms.';

// ── Mock factory for callCouncil ──────────────────────────────────────────

function mockCouncil({ score = 0.85, signals = ['ships production agent systems'], gaps = [], rationale = 'Test rationale.', throwError = false, returnEmpty = false, returnRaw = null } = {}) {
  const calls = [];
  const fn = async ({ prompt, models, opts } = {}) => {
    calls.push({ prompt, models, opts });
    if (throwError) {
      throw new Error('simulated network error');
    }
    if (returnEmpty) {
      return { results: [], missingKeys: [], totalMs: 1, report: { totalCost: 0, totalTokens: 0, modelCount: 0 } };
    }
    const content = returnRaw !== null
      ? returnRaw
      : JSON.stringify({ score, signals, gaps, rationale });
    return {
      results: [{
        model: models[0],
        content,
        tokens: 100,
        costUsd: 0.005,
        ms: 1,
      }],
      missingKeys: [],
      totalMs: 1,
      report: { totalCost: 0.005, totalTokens: 100, modelCount: 1 },
    };
  };
  fn.calls = calls;
  return fn;
}

const COMMON_INPUT = Object.freeze({
  slug: 'testlabs-test-solutions-architect',
  jdText: FIXTURE_JD,
  artifacts: FIXTURE_ARTIFACTS,
});

// ── T1: happy path — score 0.85 → status:'pass' ─────────────────────────
{
  const mock = mockCouncil({ score: 0.85, signals: ['ships production agent systems', 'bridges customer-facing solutioning + technical depth'], gaps: ['fluent in vertical-domain workflow context'], rationale: 'Strong artifact alignment.' });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T1 score 0.85 → status:pass', r.status === 'pass', r);
  check('T1 score persisted', r.score === 0.85, r);
  check('T1 signals[] non-empty', Array.isArray(r.signals) && r.signals.length === 2, r);
  check('T1 gaps[] surfaced', Array.isArray(r.gaps) && r.gaps.length === 1, r);
  check('T1 model_used set', typeof r.model_used === 'string' && r.model_used.startsWith('anthropic:'), r);
  check('T1 persona_signals_count set from intel', r.persona_signals_count === 5, r);
  check('T1 rationale present', typeof r.rationale === 'string' && r.rationale.length > 0, r);
  check('T1 mock called once', mock.calls.length === 1, { calls: mock.calls.length });
}

// ── T2: caveats threshold — score 0.65 → status:'caveats' ────────────────
{
  const mock = mockCouncil({ score: 0.65, signals: ['ships production agent systems'], gaps: ['fluent in vertical-domain workflow context', 'cross-functional comms across eng + GTM'] });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T2 score 0.65 → status:caveats', r.status === 'caveats', r);
  check('T2 score persisted', r.score === 0.65, r);
  check('T2 gaps[] surfaced for suggestion building', r.gaps.length === 2, r);
}

// ── T3: fail threshold — score 0.30 → status:'fail' ─────────────────────
{
  const mock = mockCouncil({ score: 0.30, signals: [], gaps: ['ships production agent systems', 'bridges customer-facing solutioning + technical depth'] });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T3 score 0.30 → status:fail', r.status === 'fail', r);
  check('T3 score persisted', r.score === 0.30, r);
  check('T3 signals[] empty when no match', r.signals.length === 0, r);
  check('T3 gaps[] surfaced for suggestion building', r.gaps.length === 2, r);
}

// ── T4: hm-intel file missing → status:'unavailable' ────────────────────
{
  const mock = mockCouncil();
  const r = await hmMatchCheck({
    slug: 'no-such-slug-exists-123',
    artifacts: FIXTURE_ARTIFACTS,
    opts: { callCouncil: mock, loadHmIntel: () => null },
  });
  check('T4 missing intel → status:unavailable', r.status === 'unavailable', r);
  check('T4 error message names the slug', typeof r.error === 'string' && r.error.includes('no-such-slug-exists-123'), r);
  check('T4 error mentions hiring-manager-research', typeof r.error === 'string' && /hiring-manager-research/.test(r.error), r);
  check('T4 no model call dispatched', mock.calls.length === 0, { calls: mock.calls.length });
}

// ── T5: callCouncil throws → status:'error' ─────────────────────────────
{
  const mock = mockCouncil({ throwError: true });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T5 throw → status:error', r.status === 'error', r);
  check('T5 error mentions threw', typeof r.error === 'string' && /threw/.test(r.error), r);
  check('T5 score is null on error (silent-zero guard)', r.score === null, r);
  check('T5 unavailable flag set on error', r.unavailable === true, r);
  check('T5 signals empty on error', r.signals.length === 0, r);
  check('T5 gaps empty on error', r.gaps.length === 0, r);
}

// ── T6: malformed JSON response → status:'error' with parse-error ───────
{
  const mock = mockCouncil({ returnRaw: 'I cannot do that. (no JSON here.)' });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T6 malformed → status:error', r.status === 'error', r);
  check('T6 error mentions parse', typeof r.error === 'string' && /parse|JSON|json/.test(r.error), r);
}

// Bonus: parseHmMatchResponse direct coverage — out-of-range score
{
  let threw = false;
  try { parseHmMatchResponse(JSON.stringify({ score: 1.5, signals: [], gaps: [] })); }
  catch (e) { threw = true; }
  check('T6b parseHmMatchResponse rejects score > 1', threw);
}
{
  let threw = false;
  try { parseHmMatchResponse(JSON.stringify({ score: -0.1, signals: [], gaps: [] })); }
  catch (e) { threw = true; }
  check('T6c parseHmMatchResponse rejects score < 0', threw);
}
// Tolerates code-fence wrapping
{
  const wrapped = '```json\n' + JSON.stringify({ score: 0.7, signals: ['a'], gaps: ['b'], rationale: 'ok' }) + '\n```';
  const parsed = parseHmMatchResponse(wrapped);
  check('T6d parseHmMatchResponse handles ```json fences', parsed.score === 0.7 && parsed.signals[0] === 'a');
}

// ── T7: PRE_APPLY_HM_MODEL env var respected ──────────────────────────
{
  const originalEnv = process.env.PRE_APPLY_HM_MODEL;

  // Default (no env): resolveModel returns anthropic:claude-sonnet-4-6
  delete process.env.PRE_APPLY_HM_MODEL;
  check('T7a default model is sonnet 4.6', resolveModel() === 'anthropic:claude-sonnet-4-6');

  // Supported override: google:gemini-3.1-pro-preview
  process.env.PRE_APPLY_HM_MODEL = 'google:gemini-3.1-pro-preview';
  check('T7b gemini override accepted', resolveModel() === 'google:gemini-3.1-pro-preview');

  // Verify the env var actually flows through to the callCouncil dispatch.
  const mock = mockCouncil({ score: 0.8 });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T7c env var routes the dispatch (models arg)',
        mock.calls.length === 1 && Array.isArray(mock.calls[0].models) && mock.calls[0].models[0] === 'google:gemini-3.1-pro-preview',
        mock.calls[0]);
  check('T7c result.model_used matches', r.model_used === 'google:gemini-3.1-pro-preview', r);

  // Unknown value: falls back to default with a warning (we just verify the fallback)
  process.env.PRE_APPLY_HM_MODEL = 'definitely-not-a-real-model';
  // Capture warn so test output stays clean
  const origWarn = console.warn;
  let warned = false;
  console.warn = (...args) => { warned = true; };
  try {
    check('T7d unknown env value falls back to default', resolveModel() === 'anthropic:claude-sonnet-4-6');
    check('T7d unknown env value emits warning', warned === true);
  } finally {
    console.warn = origWarn;
  }

  // Restore original env state
  if (originalEnv === undefined) {
    delete process.env.PRE_APPLY_HM_MODEL;
  } else {
    process.env.PRE_APPLY_HM_MODEL = originalEnv;
  }
}

// ── T8: cache-stable persona block is set in opts ────────────────────────
{
  const mock = mockCouncil({ score: 0.85 });
  const r = await hmMatchCheck({
    ...COMMON_INPUT,
    opts: { callCouncil: mock, loadHmIntel: () => FIXTURE_INTEL },
  });
  check('T8 a call was dispatched', mock.calls.length === 1, { calls: mock.calls.length });
  const callOpts = mock.calls[0]?.opts || {};
  check('T8 cacheStableContent is an array', Array.isArray(callOpts.cacheStableContent), { cacheStableContent: callOpts.cacheStableContent });
  check('T8 cacheStableContent has one persona block', Array.isArray(callOpts.cacheStableContent) && callOpts.cacheStableContent.length === 1, callOpts);
  const block = (callOpts.cacheStableContent || [])[0] || '';
  check('T8 persona block contains scoring rubric heading', /HM-match scoring rubric/i.test(block), { block_preview: block.slice(0, 200) });
  check('T8 persona block contains signals[] from fixture intel',
        /ships production agent systems/.test(block) && /fluent in vertical-domain workflow context/.test(block),
        { block_preview: block.slice(0, 400) });
  check('T8 cacheCaller tagged for cost-tracing', callOpts.cacheCaller === 'hm-match', callOpts);
  check('T8 timeoutMs set to 180_000', callOpts.timeoutMs === 180_000, callOpts);
}

// ── Bonus: buildPersonaBlock unit coverage ──────────────────────────────
{
  const block = buildPersonaBlock(FIXTURE_INTEL, 'testlabs-test-solutions-architect');
  check('bonus buildPersonaBlock returns non-empty string', typeof block === 'string' && block.length > 200);
  check('bonus buildPersonaBlock includes role_summary', block.includes('forward-deployed engineer-slash-solutions-architect'));
  check('bonus buildPersonaBlock includes outreach lead_with', block.includes('Production agent + vertical-domain combo'));
}

// Pre-migration backward-compat: file with no signals[] field still produces a block.
{
  const intelNoSignals = { ...FIXTURE_INTEL };
  delete intelNoSignals.signals;
  const block = buildPersonaBlock(intelNoSignals, 'slug');
  check('bonus buildPersonaBlock survives missing signals[]', block.includes('no migrated signals[]'));
}

// ── Summary ────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) {
    console.error(`  - ${f.name}`);
  }
  process.exit(1);
}
process.exit(0);
