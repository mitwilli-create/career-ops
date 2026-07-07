/**
 * lib/connection-close-fetch.mjs — per-request Connection: close fetch wrapper.
 *
 * Convergence blueprint Phase 0 (2026-07-07). Replaces the `globalThis.fetch`
 * monkey-patch that `scripts/agents/apply-pack-polish.mjs` applied at
 * orchestrator entry since 2026-05-19 (the 2h41m polish-hang fix). The
 * monkey-patch was flagged 7/7 by the council + dealbreaker adjudication
 * (`~/.claude/agents/runs/dealbreaker-final-20260706-111713.md` finding #8)
 * as a "global monkey-patch as load-bearing infra" anti-pattern: it mutated
 * process-global state invisibly for every fetch consumer in the process.
 *
 * This wrapper delivers the SAME per-request semantics (Connection: close
 * header + keepalive: false, so no undici keep-alive socket can outlive the
 * request and wedge Promise.all in the polish critic fan-out) but as an
 * EXPLICIT, opt-in, module-scoped binding:
 *
 *   - `lib/council.mjs` shadows its module-local `fetch` with
 *     `wrapFetchConnectionClose(globalThis.fetch, isConnectionCloseMode)`.
 *     When the mode is OFF (default), the wrapper is a zero-overhead
 *     pass-through — byte-identical behavior for every other council caller.
 *   - The polish orchestrator enables the mode at entry via
 *     `setConnectionCloseMode(true)` (exported from council.mjs) instead of
 *     mutating `globalThis.fetch`.
 *
 * Improvement over the old patch: `{ ...(init.headers || {}) }` silently
 * produced `{}` when callers passed a `Headers` instance or an array of
 * pairs. This wrapper normalizes all three header shapes before merging.
 *
 * Retirement path: once the LiteLLM gateway (blueprint Phase 2) owns the
 * connection lifecycle for all callCouncil paths, this wrapper and the mode
 * flag retire with the direct-vendor code paths.
 *
 * No LLM calls. No I/O. Pure function factory.
 */

/**
 * Normalize a fetch `headers` init (plain object | Headers | Array<[k,v]>)
 * into a plain object. Later duplicate keys win, matching Headers semantics
 * closely enough for header-merge purposes.
 *
 * @param {*} headers
 * @returns {Record<string, string>}
 */
export function normalizeHeaders(headers) {
  if (!headers) return {};
  // Headers instance (or anything iterable yielding [k, v] pairs)
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    const out = {};
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    const out = {};
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  if (typeof headers === 'object') return { ...headers };
  return {};
}

/**
 * Wrap a fetch implementation so that, WHEN ENABLED, every request carries
 * `Connection: close` + `keepalive: false`. When disabled, calls pass
 * through to `realFetch` with the original arguments untouched.
 *
 * @param {typeof fetch} realFetch - the underlying fetch implementation
 * @param {() => boolean} isEnabled - probe evaluated per-request
 * @returns {typeof fetch}
 */
export function wrapFetchConnectionClose(realFetch, isEnabled) {
  if (typeof realFetch !== 'function') throw new TypeError('wrapFetchConnectionClose: realFetch must be a function');
  if (typeof isEnabled !== 'function') throw new TypeError('wrapFetchConnectionClose: isEnabled must be a function');
  return function connectionCloseFetch(input, init = {}) {
    if (!isEnabled()) return realFetch(input, init);
    const headers = normalizeHeaders(init.headers);
    // Drop any pre-existing connection header REGARDLESS of casing
    // ('connection', 'Connection', 'CONNECTION', …) before setting the one
    // canonical key — a naive spread would otherwise emit duplicate /
    // conflicting Connection headers when the caller already set one in a
    // different case (Qodo finding, PR #408).
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'connection') delete headers[k];
    }
    headers.Connection = 'close';
    return realFetch(input, { ...init, headers, keepalive: false });
  };
}
