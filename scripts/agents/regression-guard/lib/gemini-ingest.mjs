/**
 * scripts/agents/regression-guard/lib/gemini-ingest.mjs
 *
 * Gemini 3.1 Pro Preview ingest with Sonnet 4.6 fallback on 5xx/timeout.
 *
 * MANDATORY per dealbreaker-final § Audit Item 2 — 503 instability during
 * peak load. Detector fires Sonnet fallback automatically; result includes
 * `fallback_fired` boolean + `fallback_reason` string for observability.
 *
 * Returns { content, usd, fallback_fired, fallback_reason? }.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly — same model id, same cost arithmetic, same
 * 5xx/timeout detection, same fallback wiring.
 */

import { fetchJson } from '../../../../lib/safe-fetch.mjs';
import { log, heartbeat, recordSpend } from './log-spend.mjs';
import { sonnetSynthesis } from './sonnet-synthesis.mjs';

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_MODEL = 'gemini-3-1-pro-preview';

export async function geminiIngestWithFallback(prompt, opts = {}) {
  if (opts.dryRun) {
    // Simulate Gemini 5xx + Sonnet fallback for smoke testing.
    if (opts.simulateGemini5xx || opts.simulateGeminiTimeout) {
      const reason = opts.simulateGemini5xx ? 'gemini_5xx' : 'gemini_timeout';
      const fb = await sonnetSynthesis(prompt, { ...opts, dryRun: true, label: 'fallback-from-gemini' });
      return {
        content: fb.content,
        usd: fb.usd,
        fallback_fired: true,
        fallback_reason: reason,
      };
    }
    return { content: '<dry-run gemini>', usd: 0, fallback_fired: false };
  }
  if (!GEMINI_KEY) {
    log('GEMINI_API_KEY not set — falling back to Sonnet for ingest', 'warn');
    const r = await sonnetSynthesis(prompt, { ...opts, label: 'fallback-no-gemini-key' });
    return { ...r, fallback_fired: true, fallback_reason: 'no_key' };
  }
  const timeoutMs = opts.timeoutMs || 120_000;
  try {
    heartbeat('gemini-ingest', 'fetch-start', { promptLen: prompt.length });
    const j = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: opts.maxTokens || 8192 },
        }),
      },
      { bodyTimeoutMs: 120_000, errPrefix: 'gemini' }
    );
    const content = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || '';
    const tokens_in = j?.usageMetadata?.promptTokenCount || 0;
    const tokens_out = j?.usageMetadata?.candidatesTokenCount || 0;
    // Gemini 3.1 Pro pricing: $2/$12 below 200k, $4/$18 above. Use base rate (most calls < 200k).
    const usd = (tokens_in * 2 + tokens_out * 12) / 1_000_000;
    recordSpend({
      model: GEMINI_MODEL, usd, tokens_in, tokens_out,
      label: opts.label || 'ingest',
    });
    heartbeat('gemini-ingest', 'done', { usd, tokens_in, tokens_out });
    return { content, usd, fallback_fired: false };
  } catch (err) {
    const msg = String(err.message || err);
    const is5xx = /HTTP 5\d\d/.test(msg);
    const isTimeout = /timeout/i.test(msg) || err?.name === 'AbortError';
    // 404 on model-not-found is the Preview-tier-shape-mismatch class that
    // A4 validation surfaced 2026-05-23 — gemini-3-1-pro-preview returns 404
    // from the live v1beta endpoint. Treat this as fallback-eligible since
    // the failure isn't with the prompt or the user; it's with the model
    // availability. Sonnet provides equivalent capability for ingest.
    const isModelNotFound = /HTTP 404/.test(msg) && /(not found|not supported|ModelService\.ListModels)/i.test(msg);
    if (is5xx || isTimeout || isModelNotFound) {
      const reason = is5xx ? 'gemini_5xx' : (isTimeout ? 'gemini_timeout' : 'gemini_model_not_found');
      log(`gemini ${reason}: ${msg.slice(0, 200)} — firing Sonnet fallback`, 'warn');
      const fb = await sonnetSynthesis(prompt, { ...opts, label: 'fallback-from-gemini' });
      return {
        content: fb.content,
        usd: fb.usd,
        fallback_fired: true,
        fallback_reason: reason,
      };
    }
    log(`gemini non-fallback error: ${msg}`, 'warn');
    return { content: null, error: msg, usd: 0, fallback_fired: false };
  }
}
