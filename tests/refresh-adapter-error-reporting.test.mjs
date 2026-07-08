/**
 * tests/refresh-adapter-error-reporting.test.mjs
 *
 * Locks in the 2026-07-08 refresh-master fixes:
 *
 *  A. Provider adapters NEVER return ok:false without a non-empty errors[]
 *     (6 WRITER_FAILED rows persisted error:"" — swallowed-error, bug class
 *     findings-exit-code-conflated-with-spawn-failure).
 *  B. finish_reason=length / stop_reason=max_tokens is a writer FAILURE with
 *     an explicit truncation error, even when a JSON prefix parses.
 *  C. The verifier prompt never presents a valid writer JSON cut mid-string
 *     without labeling it a display excerpt (15/29 VERIFIER_REJECTED wave:
 *     `JSON.stringify(json,null,2).slice(0,6000)` made every >6KB output
 *     look truncated to the verifier).
 *  D. buildSchemaSkeleton derives a writer-promptable skeleton from a prior
 *     cache, stripping orchestrator envelope keys.
 *  E. Static contracts: refresh-master persists verifier notes on
 *     VERIFIER_REJECTED and never persists an empty WRITER_FAILED error.
 *
 * $0 — all provider calls are mocked via global.fetch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { refresh: perplexityRefresh } = await import('../lib/provider-adapters/perplexity-agent-api.mjs');
const { refresh: grokRefresh } = await import('../lib/provider-adapters/grok-4-x-search.mjs');
const { renderJsonForPrompt, buildSchemaSkeleton } = await import('../lib/refresh-verifier.mjs');

const CACHE = { id: 'role_enrichment' };
const ROW = { num: 2607, company: 'Sierra', role: 'Agent Strategist' };

function mockFetchOnce(payload) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  return () => { global.fetch = original; };
}

function pplxPayload({ content, finishReason, citations = ['https://example.com/a'] }) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    citations,
  };
}

// ── A + B: perplexity adapter ───────────────────────────────────────────────

test('perplexity: finish_reason=length → ok:false with explicit truncation error', async () => {
  const restore = mockFetchOnce(pplxPayload({
    content: '{"company": "Sierra", "role": {"title": "Agent Strategist", "desc": "cut off mid-str',
    finishReason: 'length',
  }));
  try {
    process.env.PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || 'test-key';
    const r = await perplexityRefresh(CACHE, ROW, { model: 'sonar-pro', maxTokens: 3500 });
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'errors[] must be non-empty');
    assert.match(r.errors[0], /TRUNCATED/i);
    assert.match(r.errors[0], /max_tokens/);
    assert.equal(r.providerMetadata.finish_reason, 'length');
  } finally { restore(); }
});

test('perplexity: unparseable output → ok:false with parse-failure diagnostics (never empty)', async () => {
  const restore = mockFetchOnce(pplxPayload({
    content: 'Here is my analysis of the role, unfortunately not JSON at all.',
    finishReason: 'stop',
  }));
  try {
    const r = await perplexityRefresh(CACHE, ROW, { model: 'sonar-pro' });
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'errors[] must be non-empty');
    assert.match(r.errors[0], /not parseable as JSON/);
    assert.match(r.errors[0], /finish_reason=stop/);
    assert.match(r.errors[0], /Tail:/);
  } finally { restore(); }
});

test('perplexity: complete valid JSON + finish_reason=stop → ok:true', async () => {
  const restore = mockFetchOnce(pplxPayload({
    content: JSON.stringify({ company: 'Sierra', role: 'Agent Strategist', source_urls: ['https://example.com/a'] }),
    finishReason: 'stop',
  }));
  try {
    const r = await perplexityRefresh(CACHE, ROW, { model: 'sonar-pro' });
    assert.equal(r.ok, true);
    assert.equal(r.contentJson.company, 'Sierra');
    assert.equal(r.errors, undefined);
  } finally { restore(); }
});

// ── A + B: grok adapter ─────────────────────────────────────────────────────

test('grok: unparseable output → ok:false with non-empty errors[]', async () => {
  const restore = mockFetchOnce({
    choices: [{ message: { content: 'prose, not JSON' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    citations: ['https://example.com/x'],
  });
  try {
    process.env.XAI_API_KEY = process.env.XAI_API_KEY || 'test-key';
    const r = await grokRefresh(CACHE, ROW, {});
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'errors[] must be non-empty');
    assert.match(r.errors[0], /not parseable as JSON/);
  } finally { restore(); }
});

test('grok: finish_reason=length → ok:false with truncation error even when prefix parses', async () => {
  const restore = mockFetchOnce({
    choices: [{ message: { content: '{"a": 1}' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    citations: ['https://example.com/x'],
  });
  try {
    const r = await grokRefresh(CACHE, ROW, {});
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /TRUNCATED/i);
  } finally { restore(); }
});

// ── C: verifier prompt display-truncation labeling ──────────────────────────

test('renderJsonForPrompt: small JSON embeds complete with key inventory, no excerpt note', () => {
  const { block, truncatedForDisplay } = renderJsonForPrompt({ a: 1, b: 'x' }, 24000, 'writer output');
  assert.equal(truncatedForDisplay, false);
  assert.match(block, /key inventory \(2\): a, b/);
  assert.ok(block.includes('{"a":1,"b":"x"}'));
  assert.ok(!block.includes('EXCERPT'));
});

test('renderJsonForPrompt: oversized JSON is labeled as display excerpt with full key inventory', () => {
  const big = { relocation: 'r'.repeat(500), benefits: 'b'.repeat(500), sentiment: 's'.repeat(500), people: 'p'.repeat(500) };
  const { block, truncatedForDisplay } = renderJsonForPrompt(big, 300, 'writer output');
  assert.equal(truncatedForDisplay, true);
  assert.match(block, /key inventory \(4\): relocation, benefits, sentiment, people/);
  assert.match(block, /EXCERPT/);
  assert.match(block, /Do NOT report the excerpt cutoff as writer truncation/);
});

test('renderJsonForPrompt: null → (none)', () => {
  assert.equal(renderJsonForPrompt(null, 1000).block, '(none)');
});

// ── D: schema skeleton from prior cache ─────────────────────────────────────

test('buildSchemaSkeleton: strips envelope keys, keeps content structure', () => {
  const prior = {
    source_urls: ['https://x.com'],
    retrieved_at: '2026-07-01T00:00:00Z',
    model: 'sonar-pro',
    verifier_passed: true,
    diff_summary: 'updated',
    provider_metadata: { latency_ms: 1 },
    company: 'Sierra',
    relocation: { offered: true, details: 'full package' },
    benefits: { '401k_match': '4%', healthcare: 'PPO' },
    sentiment: { blind_score: 4.1 },
    people: { likely_recruiter: 'unknown' },
  };
  const skeleton = buildSchemaSkeleton(prior);
  assert.ok(skeleton, 'skeleton should not be null');
  assert.ok(!skeleton.includes('retrieved_at'), 'envelope key retrieved_at must be stripped');
  assert.ok(!skeleton.includes('verifier_passed'), 'envelope key verifier_passed must be stripped');
  assert.ok(!skeleton.includes('provider_metadata'), 'envelope key provider_metadata must be stripped');
  for (const key of ['company', 'relocation', 'benefits', 'sentiment', 'people', 'source_urls']) {
    assert.ok(skeleton.includes(`"${key}"`), `content key ${key} must survive`);
  }
  assert.ok(skeleton.includes('<string>'), 'leaf values become type placeholders');
});

test('buildSchemaSkeleton: null / non-object input → null', () => {
  assert.equal(buildSchemaSkeleton(null), null);
  assert.equal(buildSchemaSkeleton('a string'), null);
  assert.equal(buildSchemaSkeleton([1, 2]), null);
});

test('buildSchemaSkeleton: oversized skeleton falls back to top-level key list (never mid-JSON cut)', () => {
  const wide = {};
  for (let i = 0; i < 400; i++) wide[`field_with_a_reasonably_long_name_${i}`] = { nested: 'value' };
  const skeleton = buildSchemaSkeleton(wide, { maxChars: 500 });
  assert.ok(skeleton.startsWith('Top-level keys (all REQUIRED):'), `got: ${skeleton.slice(0, 80)}`);
});

// ── E: static contracts on refresh-master.mjs ───────────────────────────────

test('refresh-master persists verifier notes + verdict on VERIFIER_REJECTED', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'refresh-master.mjs'), 'utf8');
  const block = src.slice(src.indexOf(`result: 'VERIFIER_REJECTED'`) - 400, src.indexOf(`result: 'VERIFIER_REJECTED'`) + 400);
  assert.match(block, /notes:/, 'VERIFIER_REJECTED state entry must persist verifier notes');
  assert.match(block, /verdict:/, 'VERIFIER_REJECTED state entry must persist the raw verdict');
});

test('refresh-master never persists an empty WRITER_FAILED error', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'refresh-master.mjs'), 'utf8');
  assert.match(src, /adapter returned ok:false with no error detail/, 'WRITER_FAILED path must have a non-empty fallback diagnostic');
});

test('refresh-master passes schemaHint to writer adapter and verifier', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'refresh-master.mjs'), 'utf8');
  assert.match(src, /buildSchemaSkeleton\(priorCache\)/);
  assert.match(src, /schemaHint,\s*\n\s*\.\.\.q\.cache\.providerOpts/, 'writer adapter call must include schemaHint');
  assert.match(src, /verifierProvider: q\.cache\.verifierProvider, schemaHint/, 'verifyCacheWrite opts must include schemaHint');
});

test('refresh-verifier never embeds pretty-printed sliced JSON without excerpt labeling', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'refresh-verifier.mjs'), 'utf8');
  assert.ok(
    !/JSON\.stringify\([^)]*,\s*null,\s*2\)\.slice\(0,\s*[456]000\)/.test(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'the raw slice(0,~6000) pattern that caused the 2026-07-08 false-rejection wave must not return'
  );
});

test('registry: large research caches declare maxTokens above the 3500 orchestrator default', async () => {
  const { getCacheById } = await import('../lib/refresh-cache-registry.mjs');
  assert.ok(getCacheById('role_enrichment').maxTokens >= 8000);
  assert.ok(getCacheById('toxicity_composite').maxTokens >= 8000);
  assert.ok(getCacheById('positioning').maxTokens >= 6000);
});
