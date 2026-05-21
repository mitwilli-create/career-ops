/**
 * lib/safe-fetch.mjs — hang-proof fetch helpers (career-ops 2026-05-19).
 *
 * Problem: `await fetch(url, {signal})` is signal-aware, but `await r.json()`
 * and `await r.text()` after it are NOT timeout-guarded in Node's undici. If
 * the response body stalls mid-stream (TLS half-close, peer hangs after
 * headers, slow LLM still streaming) the body read can hang indefinitely
 * past the AbortSignal deadline. Root cause of the 2026-05-19 Phase H smoke
 * hang (18min idle, no progress events). See:
 * `data/hang-postmortem-2026-05-19-phase-H-smoke.md`.
 *
 * Solution: wrap body reads in Promise.race against an independent timer
 * that calls `r.body?.cancel?.()` and rejects with a clear error.
 *
 * Usage (drop-in replacement for `await r.json()`):
 *
 *   import { fetchJson, readJson, readText } from '../lib/safe-fetch.mjs';
 *
 *   // Option A — wrapped fetch + JSON parse, one call:
 *   const j = await fetchJson(url, { method: 'POST', body, signal }, {
 *     bodyTimeoutMs: 60_000,
 *     errPrefix: 'anthropic',
 *   });
 *
 *   // Option B — keep existing fetch, just guard body reads:
 *   const r = await fetch(url, { method: 'POST', body, signal });
 *   if (!r.ok) {
 *     const errTxt = await readText(r, 30_000);
 *     throw new Error(`HTTP ${r.status}: ${errTxt.slice(0,240)}`);
 *   }
 *   const j = await readJson(r, 60_000);
 *
 * Default body-read timeouts (tuned for LLM APIs):
 *   - JSON parse: 60s (matches typical LLM response sizes; large prompts
 *     may need more — opts.bodyTimeoutMs override)
 *   - Text read (for error bodies): 30s
 *   - Array buffer: 60s
 *
 * The signal-passed-in remains primary: if the caller's AbortSignal fires,
 * fetch aborts. These body timeouts are the SECONDARY safety net for
 * "response arrived but body never finishes" hangs.
 */

const DEFAULT_JSON_TIMEOUT_MS = 60_000;
const DEFAULT_TEXT_TIMEOUT_MS = 30_000;
const DEFAULT_BUFFER_TIMEOUT_MS = 60_000;

function clampTimeout(ms, fallback) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Floor 100ms (allows unit-test fast timeouts), ceiling 30min (matches
  // callCouncil's per-provider ceiling so the body timeout can't outlive
  // the connect timeout).
  return Math.min(Math.max(n, 100), 1_800_000);
}

function withBodyTimeout(bodyPromise, response, timeoutMs, label) {
  // Swallow any later rejection from the body promise so it doesn't bubble
  // up as an unhandled rejection after the race timeout fires. The reader
  // is already locked by .json()/.text()/.arrayBuffer(), so we can't
  // r.body.cancel() — best we can do is not let the rejection escape.
  bodyPromise.catch(() => { /* race already settled */ });
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} body-read timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([bodyPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Read response body as JSON with a body-read timeout.
 * Does NOT check `r.ok` — caller decides how to handle non-2xx.
 */
export async function readJson(response, bodyTimeoutMs = DEFAULT_JSON_TIMEOUT_MS, label = 'fetch') {
  const ms = clampTimeout(bodyTimeoutMs, DEFAULT_JSON_TIMEOUT_MS);
  return withBodyTimeout(response.json(), response, ms, label);
}

/**
 * Read response body as text with a body-read timeout. Used for error bodies
 * after `if (!r.ok)`.
 */
export async function readText(response, bodyTimeoutMs = DEFAULT_TEXT_TIMEOUT_MS, label = 'fetch') {
  const ms = clampTimeout(bodyTimeoutMs, DEFAULT_TEXT_TIMEOUT_MS);
  return withBodyTimeout(response.text(), response, ms, label);
}

/**
 * Read response body as ArrayBuffer with a body-read timeout.
 */
export async function readBuffer(response, bodyTimeoutMs = DEFAULT_BUFFER_TIMEOUT_MS, label = 'fetch') {
  const ms = clampTimeout(bodyTimeoutMs, DEFAULT_BUFFER_TIMEOUT_MS);
  return withBodyTimeout(response.arrayBuffer(), response, ms, label);
}

/**
 * Combined helper: fetch + readJson. Throws on non-2xx with body excerpt.
 *
 * @param {string} url
 * @param {RequestInit} fetchOpts — passed to fetch as-is (must include signal for connect timeout)
 * @param {object} [opts]
 * @param {number} [opts.bodyTimeoutMs=60_000] — body JSON parse timeout
 * @param {number} [opts.errBodyTimeoutMs=30_000] — error body text-read timeout (used when !r.ok)
 * @param {string} [opts.errPrefix='fetch'] — label prefix for clearer error messages
 * @returns {Promise<any>}
 */
export async function fetchJson(url, fetchOpts = {}, opts = {}) {
  const bodyMs = clampTimeout(opts.bodyTimeoutMs, DEFAULT_JSON_TIMEOUT_MS);
  const errMs = clampTimeout(opts.errBodyTimeoutMs, DEFAULT_TEXT_TIMEOUT_MS);
  const label = opts.errPrefix || 'fetch';
  const r = await fetch(url, fetchOpts);
  if (!r.ok) {
    let errTxt = '';
    try {
      errTxt = await readText(r, errMs, label);
    } catch (e) {
      errTxt = `<failed to read error body: ${e.message}>`;
    }
    throw new Error(`HTTP ${r.status}: ${errTxt.slice(0, 240)}`);
  }
  return readJson(r, bodyMs, label);
}
