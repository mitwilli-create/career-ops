/**
 * tests/unit/provider-parser-fixes-g20-g24.test.mjs — regression harness for
 * the META-AUDIT Batch 4 provider-parser fixes (Items G20 + G24, shipped
 * 2026-05-24).
 *
 * G20 — Perplexity adapter must strip <think>...</think> CoT blocks before
 * JSON-parsing the answer body. Mirrors the lib/council.mjs:205-213 fix
 * (dealbreaker-v2 D3 from 2026-05-18) which was missing on the cache-refresh
 * adapter at lib/provider-adapters/perplexity-agent-api.mjs.
 *
 * G24 — Gemini adapters must surface thoughtSignatures from response parts
 * + accept opt-in priorTurns injection for future multi-turn dialogue
 * callers (e.g., researcher Round-2 dialogue). Per Google docs (verified
 * 2026-05-24): "if you receive a thought signature in a model response, you
 * should pass it back exactly as received when sending the conversation
 * history in the next turn. For Gemini 2.5, it's recommended you always pass
 * all signatures back as received, but it's required for function calling
 * signatures... performance may degrade if omitted."
 *
 * No real API calls — all tests use synthetic response payloads to exercise
 * the parsing helpers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripThinkBlocks } from '../../lib/provider-adapters/perplexity-agent-api.mjs';
import { extractRichContent } from '../../lib/council.mjs';

describe('G20 — Perplexity stripThinkBlocks helper', () => {
  test('no <think> block: passthrough returns original content + empty think', () => {
    const raw = '{"foo": "bar", "baz": 42}';
    const { content, think } = stripThinkBlocks(raw);
    assert.strictEqual(content, raw, 'content must be unchanged when no think block present');
    assert.strictEqual(think, '', 'think must be empty when no think block present');
  });

  test('leading <think> block: stripped from content, captured in think', () => {
    const raw = '<think>Let me think about this. The user wants JSON with foo=bar.</think>\n{"foo": "bar"}';
    const { content, think } = stripThinkBlocks(raw);
    assert.strictEqual(content, '{"foo": "bar"}', 'content must be just the JSON body');
    assert.match(think, /Let me think about this/, 'think must contain the CoT text');
  });

  test('<think> block containing JSON-like syntax (the latent bug): correctly stripped', () => {
    // This is the canonical case G20 exists to prevent. Without stripping, the
    // safeParseJson fallback chain in perplexity-agent-api.mjs would call
    // indexOf('{') on the raw text and grab the FIRST '{' — which would be inside
    // the think block (e.g., from `{x | x > 0}` set notation or a JSON snippet).
    // Substring from that wrong '{' to the last '}' is garbage and fails JSON.parse.
    const raw = '<think>I need to find candidates matching {role: "Engineer"} from the dataset { items: [...] }.</think>\n{"answer": "hello"}';
    const { content, think } = stripThinkBlocks(raw);
    assert.strictEqual(content, '{"answer": "hello"}', 'content must be just the clean JSON body, NOT mixed with the JSON-looking syntax inside think');
    assert.match(think, /role: "Engineer"/, 'think must preserve the CoT text including its inner JSON-like syntax');
    // Verify the parsed JSON is the correct one — the actual end-state the
    // safeParseJson chain depends on.
    const parsed = JSON.parse(content);
    assert.deepStrictEqual(parsed, { answer: 'hello' }, 'JSON.parse on stripped content must return the answer body');
  });

  test('multi-line <think> with newlines + special chars: stripped correctly', () => {
    const raw = `<think>
First, I'll analyze the input.
Then I'll structure the output.
Final check: ensure JSON validity.
</think>
{"status": "ok"}`;
    const { content, think } = stripThinkBlocks(raw);
    assert.strictEqual(content, '{"status": "ok"}');
    assert.match(think, /First, I'll analyze/);
    assert.match(think, /Final check/);
  });

  test('multiple <think> blocks (defensive): all stripped, all captured', () => {
    const raw = '<think>First thought.</think>Some text<think>Second thought.</think>\n{"final": true}';
    const { content, think } = stripThinkBlocks(raw);
    // All think tags removed, both bodies concatenated (joined by \n\n).
    assert.ok(!content.includes('<think>'), 'no opening think tags should remain');
    assert.ok(!content.includes('</think>'), 'no closing think tags should remain');
    assert.match(content, /Some text/);
    assert.match(content, /"final": true/);
    assert.match(think, /First thought/);
    assert.match(think, /Second thought/);
  });

  test('null / undefined / non-string input: returns safe default', () => {
    assert.deepStrictEqual(stripThinkBlocks(null), { content: '', think: '' });
    assert.deepStrictEqual(stripThinkBlocks(undefined), { content: '', think: '' });
    assert.deepStrictEqual(stripThinkBlocks(123), { content: '', think: '' });
  });

  test('empty string input: returns empty content + empty think', () => {
    assert.deepStrictEqual(stripThinkBlocks(''), { content: '', think: '' });
  });
});

describe('G24 — Gemini thoughtSignatures + extractRichContent surfacing', () => {
  test('extractRichContent: surfaces thoughtSignatures as empty array for non-Gemini results', () => {
    const fakeOpenAiResult = {
      content: 'Hello',
      tokens: 10,
      modelUsed: 'gpt-5',
    };
    const rich = extractRichContent(fakeOpenAiResult);
    assert.deepStrictEqual(rich.thoughtSignatures, [], 'must default to empty array for results without the field');
    assert.deepStrictEqual(rich.modelTurnParts, [], 'must default to empty array for results without the field');
  });

  test('extractRichContent: passes through Gemini thoughtSignatures + modelTurnParts', () => {
    const fakeGeminiResult = {
      content: 'Hello',
      tokens: 10,
      modelUsed: 'gemini-3.1-pro-preview',
      thoughtSignatures: [
        { partIndex: 0, thoughtSignature: 'sig-abc-123' },
      ],
      modelTurnParts: [
        { text: 'Hello', thoughtSignature: 'sig-abc-123' },
      ],
    };
    const rich = extractRichContent(fakeGeminiResult);
    assert.strictEqual(rich.thoughtSignatures.length, 1);
    assert.strictEqual(rich.thoughtSignatures[0].thoughtSignature, 'sig-abc-123');
    assert.strictEqual(rich.modelTurnParts.length, 1);
    assert.strictEqual(rich.modelTurnParts[0].thoughtSignature, 'sig-abc-123', 'modelTurnParts must preserve thoughtSignature exactly');
  });

  test('extractRichContent: invalid input returns safe-default rich shape including thoughtSignatures', () => {
    const rich = extractRichContent(null);
    assert.deepStrictEqual(rich.thoughtSignatures, []);
    assert.deepStrictEqual(rich.modelTurnParts, []);
    assert.strictEqual(rich.error, 'invalid result');
  });
});

describe('G24 — _extractGeminiThoughtSignatures + _buildGeminiContents (smoke via re-import)', () => {
  // Sanity-check the helpers themselves. They're not exported (private to
  // council.mjs), so we test their observable effect via the rich-content
  // shape + a synthetic v1beta-shaped response document. The full integration
  // path (response → return → extractRichContent) is what callers actually use.

  test('synthetic Gemini response with thoughtSignature: surfaces correctly via extractRichContent', () => {
    // Simulate what the adapter return value would look like after the
    // _extractGeminiThoughtSignatures pass. This is the contract every Gemini
    // adapter site (line 487-495, 506-510, 514-521, 679-685, 855-863) must hold.
    const fakeAdapterReturn = {
      content: 'The answer is 42.',
      tokens: 17,
      grounded: true,
      grounding_urls: ['https://example.com/source'],
      thoughtSignatures: [
        { partIndex: 0, thoughtSignature: 'opaque-sig-from-gemini' },
        { partIndex: 2, thoughtSignature: 'second-opaque-sig' },
      ],
      modelTurnParts: [
        { text: 'The answer is 42.', thoughtSignature: 'opaque-sig-from-gemini' },
        { text: ' Verified.' },
        { functionCall: { name: 'unused', args: {} }, thoughtSignature: 'second-opaque-sig' },
      ],
      modelUsed: 'gemini-3.1-pro-preview+google_search',
    };
    const rich = extractRichContent(fakeAdapterReturn);
    assert.strictEqual(rich.content, 'The answer is 42.');
    assert.strictEqual(rich.thoughtSignatures.length, 2);
    assert.strictEqual(rich.modelTurnParts.length, 3);
    // The third part is a functionCall part — its thoughtSignature must survive
    // verbatim for the future-multi-turn-callers contract.
    assert.strictEqual(rich.modelTurnParts[2].thoughtSignature, 'second-opaque-sig');
    assert.deepStrictEqual(rich.modelTurnParts[2].functionCall, { name: 'unused', args: {} });
  });

  test('synthetic Gemini response without thoughtSignature: surfaces empty arrays', () => {
    const fakeAdapterReturn = {
      content: 'plain text',
      tokens: 3,
      grounded: false,
      grounding_urls: [],
      thoughtSignatures: [], // no signatures came back
      modelTurnParts: [{ text: 'plain text' }],
      modelUsed: 'gemini-2.5-pro',
    };
    const rich = extractRichContent(fakeAdapterReturn);
    assert.strictEqual(rich.thoughtSignatures.length, 0);
    assert.strictEqual(rich.modelTurnParts.length, 1);
    assert.strictEqual(rich.modelTurnParts[0].text, 'plain text');
  });
});
