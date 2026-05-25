// lib/bug-resolver/vendor-router.mjs
//
// Phase → vendor dispatch for the bug-resolver pipeline. Wraps lib/council.mjs
// with per-phase vendor pinning, per-phase default opts (maxTokens/timeoutMs),
// circuit-breaker (disables vendor after 3 consecutive failures within a run),
// env-flag disable support, and mandatory leak-guard pre-flight on citations.
//
// Cost-cap enforcement lives in the main orchestrator (scripts/agents/bug-resolver.mjs)
// — this module is dispatch-only.
//
// Spec: data/bug-resolver-plan.md § Phase 2.1 (LLM matrix) + § Refinements.

import { callCouncil } from '../council.mjs';
import { assertNoInlineQuotesFromSensitivePaths } from '../leak-guard.mjs';

// Phase → vendor binding. MAX QUALITY routing locked 2026-05-25 — quality
// preserved on the load-bearing phases (audit/research/adjudicate/action_plan/
// implement), Flash speedup on the lightweight phases (verify/harden).
// See data/bug-resolver-plan.md § Phase 2.1 + the 2026-05-25 redistribution
// interview locked decisions.
export const PHASE_VENDORS = {
  audit:       'google:gemini-2.5-pro',   // long context + grounded
  research:    'google:gemini-2.5-pro',   // same vendor as audit; long context
  adjudicate:  'xai:grok-4',              // independent reasoning bias (full Grok-4)
  action_plan: 'xai:grok-4',              // same vendor as adjudicate
  implement:   'openai:gpt-5-5-pro',      // highest-tier non-Anthropic code gen
  verify:      'google:gemini-3-flash',   // fast pattern-match — Flash is plenty
  harden:      'google:gemini-3-flash',   // fast markdown gen — Flash is plenty
};

// Per-phase default opts. maxTokens accounts for reasoning-model overhead
// (Gemini 2.5 Pro / GPT-5.5-Pro / Grok-4 all burn thinking tokens before output —
// smoke-test 2026-05-23 confirmed 20 tokens is too low; ≥200 needed for
// even trivial prompts). Flash phases use shorter timeouts since Flash is fast.
export const PHASE_DEFAULTS = {
  audit:       { maxTokens: 4000, timeoutMs: 120_000 },
  research:    { maxTokens: 4000, timeoutMs: 120_000 },
  adjudicate:  { maxTokens: 2000, timeoutMs: 60_000 },
  action_plan: { maxTokens: 3000, timeoutMs: 90_000 },
  implement:   { maxTokens: 8000, timeoutMs: 180_000 },
  verify:      { maxTokens: 1500, timeoutMs: 45_000 },  // Flash — faster
  harden:      { maxTokens: 3000, timeoutMs: 60_000 },  // Flash — faster
};

// ─── Circuit-breaker state (per-process; cleared on resetBreaker()) ─────────
// Keyed by full vendor string (e.g. "google:gemini-2.5-pro") so each model
// gets its own 3-strikes counter — a Flash blip does NOT disable Pro.
const breakerState = new Map(); // vendor → { consecutiveFails, disabled }

// Family-level kill switch — disables ALL models in a vendor family.
// Use when an entire provider's API is having issues.
function familyEnvDisableFlag(vendor) {
  if (vendor.includes('gemini')) return 'BUG_RESOLVER_VENDOR_DISABLED_GEMINI';
  if (vendor.includes('gpt-5')) return 'BUG_RESOLVER_VENDOR_DISABLED_GPT5';
  if (vendor.includes('grok')) return 'BUG_RESOLVER_VENDOR_DISABLED_GROK4';
  return null;
}

// Per-model kill switch — disables ONE specific model while leaving siblings
// in the same vendor family active. Naming: BUG_RESOLVER_MODEL_DISABLED_<SLUG>
// where SLUG is the model id with `.`/`-` mapped to `_` and uppercased.
// Examples:
//   google:gemini-2.5-pro   → BUG_RESOLVER_MODEL_DISABLED_GEMINI_2_5_PRO
//   google:gemini-3-flash   → BUG_RESOLVER_MODEL_DISABLED_GEMINI_3_FLASH
//   xai:grok-4              → BUG_RESOLVER_MODEL_DISABLED_GROK_4
//   openai:gpt-5-5-pro      → BUG_RESOLVER_MODEL_DISABLED_GPT_5_5_PRO
function modelEnvDisableFlag(vendor) {
  const parts = vendor.split(':');
  const model = parts[parts.length - 1];
  const slug = model.replace(/[.-]/g, '_').toUpperCase();
  return `BUG_RESOLVER_MODEL_DISABLED_${slug}`;
}

function envFlagTruthy(name) {
  if (!name) return false;
  return /^(true|1|yes|on)$/i.test(process.env[name] || '');
}

export function isVendorDisabled(vendor) {
  // family-level env flag (vendor-wide kill)
  if (envFlagTruthy(familyEnvDisableFlag(vendor))) return true;
  // per-model env flag (finer override)
  if (envFlagTruthy(modelEnvDisableFlag(vendor))) return true;
  // auto circuit-breaker (per-model — keyed by full vendor string)
  const state = breakerState.get(vendor);
  return state ? state.disabled : false;
}

function noteFailure(vendor) {
  const state = breakerState.get(vendor) || { consecutiveFails: 0, disabled: false };
  state.consecutiveFails++;
  if (state.consecutiveFails >= 3) state.disabled = true;
  breakerState.set(vendor, state);
}

function noteSuccess(vendor) {
  breakerState.set(vendor, { consecutiveFails: 0, disabled: false });
}

export function resetBreaker() {
  breakerState.clear();
}

export function getBreakerStatus() {
  const out = {};
  for (const [vendor, state] of breakerState.entries()) {
    out[vendor] = { ...state };
  }
  return out;
}

// ─── Custom error for disabled-vendor case ──────────────────────────────────
export class VendorDisabledError extends Error {
  constructor(msg, vendor, phase) {
    super(msg);
    this.name = 'VendorDisabledError';
    this.vendor = vendor;
    this.phase = phase;
  }
}

// Pre-flight check: which vendor would callPhase use for this phase?
// Use this in the orchestrator to skip phases whose vendor is disabled,
// rather than catching the throw mid-pipeline.
export function vendorForPhase(phase) {
  const v = PHASE_VENDORS[phase];
  if (!v) throw new Error(`vendorForPhase: unknown phase "${phase}"`);
  return v;
}

// ─── Main dispatch ──────────────────────────────────────────────────────────
//
// callPhase({ phase, prompt, opts?, citations? })
//   phase      — one of PHASE_VENDORS keys
//   prompt     — the user-prompt string sent to the vendor
//   opts       — overrides for PHASE_DEFAULTS (e.g., { maxTokens: 8000 })
//   citations  — Array<{path, mode}>. Each citation passed through leak-guard
//                before dispatch. mode='quote_inline' from sensitive paths
//                THROWS (bug should auto-escalate to NEEDS_HUMAN).
//
// Returns:
//   { phase, vendor, content, tokens, costUsd, ms, error? }
//
// On vendor failure: breaker incremented; returns object with .error set.
// On disabled vendor: throws VendorDisabledError.
// On leak-guard violation: throws (caller should escalate the bug).
export async function callPhase({ phase, prompt, opts = {}, citations = [] }) {
  const vendor = PHASE_VENDORS[phase];
  if (!vendor) throw new Error(`callPhase: unknown phase "${phase}"`);
  if (isVendorDisabled(vendor)) {
    throw new VendorDisabledError(`Vendor ${vendor} disabled for phase ${phase}`, vendor, phase);
  }

  // Leak-guard pre-flight on every dispatch
  if (citations.length > 0) {
    assertNoInlineQuotesFromSensitivePaths(citations);
  }

  const mergedOpts = { ...PHASE_DEFAULTS[phase], ...opts };
  const t0 = Date.now();

  let result;
  try {
    result = await callCouncil({
      prompt,
      models: [vendor],
      opts: mergedOpts,
    });
  } catch (err) {
    noteFailure(vendor);
    return {
      phase, vendor,
      content: '',
      error: String(err.message || err),
      tokens: 0,
      costUsd: 0,
      ms: Date.now() - t0,
    };
  }

  const r = result.results?.[0];
  if (!r || r.error || !r.content) {
    noteFailure(vendor);
    return {
      phase, vendor,
      content: r?.content || '',
      error: r?.error || 'empty-content',
      tokens: r?.tokens || 0,
      costUsd: Number(r?.costUsd) || 0,
      ms: Date.now() - t0,
    };
  }

  noteSuccess(vendor);
  return {
    phase, vendor,
    content: r.content,
    tokens: r.tokens || 0,
    costUsd: Number(r.costUsd) || 0,
    ms: Date.now() - t0,
  };
}
