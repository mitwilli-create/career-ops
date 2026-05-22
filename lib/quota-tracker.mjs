// lib/quota-tracker.mjs — local minute-window token counter for LLM providers
// (Cluster J pre-flight band, 2026-05-21).
//
// Wraps lib/run-metrics.mjs token_window table. Lets agents check "am I
// about to hit Anthropic's tier rate limit" BEFORE firing a 200K-token
// request that would 429. The provider quota check inside pre-flight uses
// this alongside the provider whoami ping.
//
// Conservative defaults (provider-specific tunings — adjust as tiers change):
//
//   anthropic   tier-3 input:  300_000 tokens/min   (we warn at 80% = 240k)
//   anthropic   tier-3 output: 100_000 tokens/min
//   openai      tier-3:        200_000 tokens/min
//   xai         grok-4:        200_000 tokens/min (estimate, no published)
//   perplexity  default:        50_000 tokens/min
//
// API:
//   import { reserveQuota, recordTokens } from '../lib/quota-tracker.mjs';
//   const ok = reserveQuota('anthropic', estimatedTokens);
//   if (!ok.ok) { /* warn + backoff or abort per ok.reason */ }
//   // ... do the call ...
//   recordTokens('anthropic', actualTokensIn + actualTokensOut);
//
// recordTokens is also the place every agent reports its actual usage after
// a successful call. The estimate→record pattern means the window stays
// accurate even when the request bursts above our pre-call estimate.

import { recordTokens as _recordTokens, getTokensInWindow, getAllProvidersInWindow } from './run-metrics.mjs';

// Per-provider per-minute caps (input+output combined unless noted). These
// are CONSERVATIVE — provider tier limits change; quota-tracker errs toward
// backing off early.
const PROVIDER_CAPS = {
  anthropic: 300_000,   // tier-3 input
  openai: 200_000,
  xai: 200_000,
  perplexity: 50_000,
  google: 100_000,      // Gemini 2.5 Pro / Flash defaults
};

const WARN_THRESHOLD = 0.8;  // warn at 80% of cap

export function reserveQuota(provider, estimatedTokens, { windowMs = 60_000 } = {}) {
  const cap = PROVIDER_CAPS[provider];
  if (!cap) {
    return { ok: true, reason: 'unknown_provider_no_cap', usedTokens: 0, cap: null, headroom: null };
  }
  const used = getTokensInWindow(provider, windowMs);
  const headroom = cap - used;
  if (estimatedTokens > headroom) {
    return {
      ok: false,
      reason: 'would_exceed_cap',
      usedTokens: used,
      cap,
      headroom,
      estimatedTokens,
      backoffMs: 60_000,  // wait one window
    };
  }
  if (used + estimatedTokens > cap * WARN_THRESHOLD) {
    return {
      ok: true,
      warn: 'approaching_cap',
      usedTokens: used,
      cap,
      headroom,
      estimatedTokens,
    };
  }
  return { ok: true, usedTokens: used, cap, headroom, estimatedTokens };
}

export function recordTokens(provider, tokens) {
  _recordTokens(provider, tokens);
}

export function snapshot(windowMs = 60_000) {
  const rows = getAllProvidersInWindow(windowMs);
  return rows.map(r => ({
    provider: r.provider,
    usedTokens: r.total,
    cap: PROVIDER_CAPS[r.provider] || null,
    pct: PROVIDER_CAPS[r.provider] ? r.total / PROVIDER_CAPS[r.provider] : null,
  }));
}

export const PROVIDERS_WITH_CAPS = Object.keys(PROVIDER_CAPS);
