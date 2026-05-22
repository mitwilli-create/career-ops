// lib/provider-health.mjs — provider status-page + whoami-ping checks
// (Cluster J pre-flight band, 2026-05-21).
//
// Two layers of provider-health signal:
//
//   1. STATUS PAGE — read each provider's public JSON status endpoint.
//      Fast (no auth, no key consumed), but lags reality: status pages take
//      minutes-to-hours to reflect outages.
//
//   2. WHOAMI PING — send a 1-token Sonnet call to Anthropic (or equivalent
//      to the provider you're about to use). Costs ~$0.0001 per check.
//      Validates: API key still active, account has quota, request path is
//      reachable. This catches "your key was rotated 5 minutes ago" before
//      the agent burns a 30K-token request to discover it.
//
// Both are wrapped in lib/safe-fetch.mjs and respect a per-process in-memory
// cache (default 60s) so a flurry of agents during pre-flight doesn't
// hammer the status pages.
//
// Pre-flight gate (lib/preflight-gates.mjs) calls these and returns blockers
// if a needed provider is degraded or the key is invalid.

import { fetchJson, readJson } from './safe-fetch.mjs';

const CACHE_TTL_MS = 60_000;
const _cache = new Map();  // key -> { value, expires }

function cacheGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) { _cache.delete(key); return null; }
  return v.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  _cache.set(key, { value, expires: Date.now() + ttl });
}

// ─────────────────────────────────────────────────────────────────────────
// Status pages

const STATUS_ENDPOINTS = {
  anthropic: 'https://status.anthropic.com/api/v2/status.json',
  openai: 'https://status.openai.com/api/v2/status.json',
  xai: 'https://status.x.ai/api/v2/status.json',
  perplexity: 'https://status.perplexity.com/api/v2/status.json',
  google: 'https://status.cloud.google.com/incidents.json',
};

/**
 * Returns { ok: boolean, indicator: 'none|minor|major|critical', description: string }
 * On fetch failure, returns { ok: true, indicator: 'unknown', description: '...' } —
 * a status-page outage should NOT block agent work.
 */
export async function checkStatusPage(provider) {
  if (!STATUS_ENDPOINTS[provider]) {
    return { ok: true, indicator: 'unknown', description: `no status endpoint configured for ${provider}` };
  }
  const cacheKey = `status:${provider}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const j = await fetchJson(STATUS_ENDPOINTS[provider], {
      signal: AbortSignal.timeout(5_000),
      headers: { 'user-agent': 'career-ops-preflight/1.0' },
    }, { bodyTimeoutMs: 5_000, errPrefix: `status-${provider}` });

    let indicator = 'none';
    let description = 'All systems operational';
    if (j?.status?.indicator) {
      indicator = j.status.indicator;
      description = j.status.description || description;
    } else if (Array.isArray(j) && j.length > 0) {
      // Google status uses an array of incidents.
      const open = j.filter(i => !i.end && i.status_impact && i.status_impact !== 'SERVICE_INFORMATION');
      if (open.length > 0) {
        indicator = open.some(i => i.severity === 'high') ? 'major' : 'minor';
        description = open[0].external_desc || `${open.length} open incidents`;
      }
    }
    const result = {
      ok: indicator === 'none' || indicator === 'minor' || indicator === 'unknown',
      indicator,
      description,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    const result = {
      ok: true,
      indicator: 'unknown',
      description: `status check failed: ${e.message?.slice(0, 80) || 'unknown'}`,
    };
    cacheSet(cacheKey, result, 30_000);  // shorter TTL on fetch failure
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Whoami ping — Anthropic (most relevant since most agents call Sonnet)

/**
 * 1-token Sonnet call. Returns { ok, latencyMs, error? }.
 * Cost: ~$0.0001 per ping. Caller responsible for caching (default 60s here).
 */
export async function whoamiAnthropic({ apiKey = process.env.ANTHROPIC_API_KEY, model = 'claude-haiku-4-5-20251001' } = {}) {
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  }
  const cacheKey = `whoami:anthropic:${model}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const started = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
    });
    const latencyMs = Date.now() - started;
    if (!r.ok) {
      const txt = await readJson(r, 5_000, 'whoami-anthropic').catch(() => null);
      const result = {
        ok: false,
        latencyMs,
        status: r.status,
        error: txt?.error?.message || `HTTP ${r.status}`,
      };
      cacheSet(cacheKey, result, 30_000);
      return result;
    }
    const result = { ok: true, latencyMs };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    const result = {
      ok: false,
      latencyMs: Date.now() - started,
      error: e.message || 'unknown',
    };
    cacheSet(cacheKey, result, 30_000);
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Bulk check — used by pre-flight and the dashboard hygiene panel

/**
 * Check status pages for an array of providers in parallel.
 * Returns { provider, ok, indicator, description }[].
 */
export async function checkAllStatuses(providers = ['anthropic', 'openai', 'xai', 'perplexity', 'google']) {
  const results = await Promise.all(
    providers.map(async (p) => {
      const r = await checkStatusPage(p);
      return { provider: p, ...r };
    })
  );
  return results;
}

export function clearCache() {
  _cache.clear();
}
