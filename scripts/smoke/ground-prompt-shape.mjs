#!/usr/bin/env node
/**
 * scripts/smoke/ground-prompt-shape.mjs
 *
 * Smoke test for lib/ground-prompt.mjs return shape + voice purity behavior.
 * Validates the contract that Stream B integrations (strategy-ceiling.mjs,
 * interview-likelihood.mjs, hm-chance.mjs) rely on.
 *
 * Exits 0 on pass, 1 on any assertion failure.
 *
 * Optional: STRATEGY_CEILING_VOICE_CLASSIFIER=1 enables the live Haiku LLM
 * classifier check (~$0.005). Default off.
 *
 * Usage:
 *   node scripts/smoke/ground-prompt-shape.mjs
 *   node scripts/smoke/ground-prompt-shape.mjs --verbose
 */

import { buildGroundedPrompt, checkVoicePurity, classifyVoicePurity } from '../../lib/ground-prompt.mjs';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    pass++;
    if (VERBOSE) console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

console.log('— smoke: buildGroundedPrompt return shape —');

// Case 1: standard call returns documented shape
const r1 = buildGroundedPrompt({
  task: 'alignment',
  rowId: '48',
  role: 'Engineering Editorial Lead',
  company: 'Anthropic',
  metricKey: 'alignment',
  currentValue: 40,
  jdText: 'We are looking for a senior editorial lead.',
  hmIntel: null,
  responseSchema: '{ "ceiling": <number> }',
});

assert(typeof r1 === 'object', 'returns object');
assert(typeof r1.prompt === 'string' && r1.prompt.length > 0, 'prompt is non-empty string');
assert(typeof r1.system === 'string' && r1.system.length > 0, 'system is non-empty string');
assert(Array.isArray(r1.cacheStableContent), 'cacheStableContent is array');
assert(r1.cacheStableContent.length === 2, 'cacheStableContent length is exactly 2 (personality + profile)');
assert(typeof r1.cacheKey === 'string' && r1.cacheKey.includes('48'), 'cacheKey includes rowId');
assert(typeof r1.metadata === 'object', 'metadata is object');
assert(r1.metadata.task === 'alignment', 'metadata.task echoes input task');
assert(typeof r1.metadata.contentHash === 'string', 'metadata.contentHash is string');
assert(typeof r1.metadata.generatedAt === 'number', 'metadata.generatedAt is timestamp number');

// Case 2: system prompt enforces voice rules
const sysHasAnalyst = r1.system.toLowerCase().includes('analyst');
const sysHasMitchell = r1.system.includes('Mitchell');
const sysHasRSD = r1.system.toLowerCase().includes('tone') || r1.system.toLowerCase().includes('safety') || r1.system.includes('failed') || r1.system.includes('broken');
const sysHasThirdPerson = r1.system.toLowerCase().includes('third-person') || r1.system.toLowerCase().includes('third person');
assert(sysHasAnalyst, 'system prompt mentions "analyst"');
assert(sysHasMitchell, 'system prompt names Mitchell');
assert(sysHasRSD, 'system prompt addresses tone-safety rules');
assert(sysHasThirdPerson, 'system prompt enforces third-person voice');

// Case 3: user prompt includes the role context + response schema
const userHasRole = r1.prompt.includes('Engineering Editorial Lead');
const userHasCompany = r1.prompt.includes('Anthropic');
const userHasMetric = r1.prompt.includes('40');
const userHasSchema = r1.prompt.includes('"ceiling"');
assert(userHasRole, 'user prompt includes role');
assert(userHasCompany, 'user prompt includes company');
assert(userHasMetric, 'user prompt includes currentValue');
assert(userHasSchema, 'user prompt includes responseSchema');

// Case 4: cacheStableContent values are strings (even if empty in worktree without corpus)
assert(typeof r1.cacheStableContent[0] === 'string', 'cacheStableContent[0] (personality) is string');
assert(typeof r1.cacheStableContent[1] === 'string', 'cacheStableContent[1] (profile) is string');

// Case 5: legacy rollback mode returns shape with empty cacheStableContent
const r2 = (() => {
  const prev = process.env.STRATEGY_CEILING_GROUNDED_MODE;
  process.env.STRATEGY_CEILING_GROUNDED_MODE = '0';
  try {
    return buildGroundedPrompt({
      task: 'alignment', rowId: '48',
      role: 'Engineering Editorial Lead', company: 'Anthropic',
      metricKey: 'alignment', currentValue: 40,
    });
  } finally {
    if (prev === undefined) delete process.env.STRATEGY_CEILING_GROUNDED_MODE;
    else process.env.STRATEGY_CEILING_GROUNDED_MODE = prev;
  }
})();
assert(Array.isArray(r2.cacheStableContent), 'legacy mode returns array cacheStableContent');
assert(r2.cacheStableContent.length === 0, 'legacy mode returns empty cacheStableContent array');
assert(r2.metadata.mode === 'legacy', 'legacy mode flagged in metadata');

// Case 6: lean mode drops the deprioritized personality docs (only meaningful when corpus exists)
const r3 = buildGroundedPrompt({
  task: 'alignment', rowId: '48',
  role: 'Engineering Editorial Lead', company: 'Anthropic',
  metricKey: 'alignment', currentValue: 40,
  lean: true,
});
assert(r3.metadata.mode === 'lean', 'lean mode flagged in metadata');

console.log('— smoke: checkVoicePurity (Layer 2 regex) —');

// Case 7: voice-purity flags first-person leakage
const v1 = checkVoicePurity('I think my fit for this role is strong because looking at this role I see alignment.');
assert(!v1.ok, 'flags first-person leakage as voice-impure');
assert(v1.score > 0, 'returns positive score on first-person');
assert(Array.isArray(v1.fails), 'returns fails array');
const firstPersonRule = v1.fails.find(f => f.rule === 'first-person-mitchell');
assert(firstPersonRule != null, 'identifies first-person-mitchell rule');

// Case 8: voice-purity flags tone-unsafe language
const v2 = checkVoicePurity('Mitchell\'s background failed to demonstrate this dimension; the proof points are weak and broken.');
assert(!v2.ok, 'flags tone-unsafe language as voice-impure');
const rsdRule = v2.fails.find(f => f.rule === 'rsd-unsafe-language');
assert(rsdRule != null, 'identifies rsd-unsafe-language rule');

// Case 9: voice-purity flags banned corporate vocab
const v3 = checkVoicePurity('Mitchell should leverage his bandwidth to deep-dive this synergy and circle back.');
assert(!v3.ok, 'flags banned corporate vocab as voice-impure');
const corpRule = v3.fails.find(f => f.rule === 'banned-corporate-vocab');
assert(corpRule != null, 'identifies banned-corporate-vocab rule');

// Case 10: voice-purity passes clean third-person analyst output
const v4 = checkVoicePurity('Mitchell\'s alignment for this role shows specific production AI shipping at xGE (cv.md:22-30). His Voice DNA pipeline at 99% stylistic fidelity (cv.md:27-30) anchors the analyst-to-Mitchell framing.');
assert(v4.ok, 'passes clean third-person output');
assert(v4.score === 0, 'returns score 0 on clean output');

console.log('— smoke: classifyVoicePurity (Layer 3 LLM, opt-in) —');

// Case 11: classifier returns shaped result (live API only when explicitly opted in)
if (process.env.STRATEGY_CEILING_VOICE_CLASSIFIER === '1' && process.env.ANTHROPIC_API_KEY) {
  try {
    const { callCouncil } = await import('../../lib/council.mjs');
    const classifyResult = await classifyVoicePurity(
      'Mitchell\'s alignment for the Engineering Editorial Lead role at Anthropic shows specific corpus-grounded fit.',
      callCouncil
    );
    assert(typeof classifyResult === 'object', 'classifyVoicePurity returns object');
    assert(typeof classifyResult.ok === 'boolean', 'has ok boolean');
    assert(classifyResult.score === null || typeof classifyResult.score === 'number', 'has score number or null');
    assert(typeof classifyResult.rationale === 'string', 'has rationale string');
  } catch (e) {
    console.error(`  (classifier live test skipped: ${e.message})`);
  }
} else {
  console.log('  (classifier live test skipped — set STRATEGY_CEILING_VOICE_CLASSIFIER=1 + ANTHROPIC_API_KEY to enable)');
}

// Summary
console.log('');
console.log(`Smoke result: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('FAILED:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('PASS');
process.exit(0);
