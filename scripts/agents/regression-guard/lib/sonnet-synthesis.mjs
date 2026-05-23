/**
 * scripts/agents/regression-guard/lib/sonnet-synthesis.mjs
 *
 * Sonnet 4.6 synthesis call. Used by:
 *   - decision-doc narrative generation (when scheduled run detects findings)
 *   - v1.1 cross-session synthesis (crossSessionSynthesize)
 *   - geminiIngestWithFallback as the fallback path on Gemini 5xx/timeout
 *
 * Spec source: dealbreaker-final § Audit Item 2 — Sonnet is the fallback
 * model (NOT Opus, NOT Haiku, NOT Gemini).
 *
 * Hang-prevention contract: AbortSignal.timeout on fetch + bodyTimeoutMs on
 * the JSON read (lib/safe-fetch.mjs handles both).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly — same model id, same cost arithmetic, same
 * dry-run behavior, same error path.
 */

import { fetchJson } from '../../../../lib/safe-fetch.mjs';
import { log, heartbeat, recordSpend } from './log-spend.mjs';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
// The actual Sonnet 4.6 API id; canonical name in code.
export const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

export async function sonnetSynthesis(prompt, opts = {}) {
  if (!ANTHROPIC_KEY) {
    return { content: null, error: 'ANTHROPIC_API_KEY not set', usd: 0 };
  }
  if (opts.dryRun) return { content: '<dry-run sonnet>', usd: 0 };
  const timeoutMs = opts.timeoutMs || 180_000;
  try {
    heartbeat('sonnet-synthesis', 'fetch-start', { promptLen: prompt.length });
    const j = await fetchJson(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: opts.maxTokens || 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      { bodyTimeoutMs: 90_000, errPrefix: 'sonnet' }
    );
    const content = (j?.content || []).map(b => b.text || '').join('\n');
    const tokens_in = j?.usage?.input_tokens || 0;
    const tokens_out = j?.usage?.output_tokens || 0;
    // Sonnet 4.6 is $3/$15 per 1M tokens
    const usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000;
    recordSpend({
      model: SONNET_MODEL, usd, tokens_in, tokens_out,
      label: opts.label || 'synthesis',
    });
    heartbeat('sonnet-synthesis', 'done', { usd, tokens_in, tokens_out });
    return { content, usd, tokens_in, tokens_out };
  } catch (err) {
    log(`sonnet error: ${err.message}`, 'warn');
    return { content: null, error: err.message, usd: 0 };
  }
}
