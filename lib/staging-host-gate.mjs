// lib/staging-host-gate.mjs
// Origin Host-gate for the no-auth staging dashboard mirror (2026-07-09).
//
// Both staging-dashboard.* (fronted by the CSP Worker) and the raw
// staging-origin.* tunnel ingress funnel through the SAME origin
// (localhost:3097). This module is the single chokepoint they share: a request
// whose Host contains "staging" must carry a matching X-Staging-Token or be
// refused. Fail-closed: if no secret is configured, ALL staging traffic is
// refused. Prod (dashboard.careers-ops.com, behind CF Access) and localhost
// are non-staging Hosts and always pass through untouched.
//
// Born from a confirmed leak: an LLM live-retrieval crawler (sonar-deep-research)
// was observed fetching a staging report page, exposing the full personal
// pipeline (applications / hm-intel / company data). robots.txt is advisory and
// does not stop LLM crawlers, so the gate is real auth at the origin.
//
// Extracted from the inline server gate per CodeRabbit review of PR #418 so the
// decision is pure + unit-testable without booting the HTTP server.
import { timingSafeEqual } from 'node:crypto';

/**
 * True when the request Host targets a staging hostname.
 *
 * Deliberately a broad substring match, NOT an exact allowlist. This powers the
 * server-side gate, whose job is to PROTECT: over-matching only ever causes MORE
 * requests to require the token (fail-closed / fail-safe). An exact allowlist
 * would fail OPEN if a new `staging-*` hostname were ever added, serving it with
 * no auth, which is exactly the leak this gate exists to prevent. Only hosts
 * that route to this origin through the Cloudflare tunnel can reach it, so there
 * is no over-match risk. (The canary in scripts/dashboard-headless-canary.mjs
 * ADDS the secret header and therefore uses an exact allowlist instead, since
 * over-matching there would leak the token off-origin.)
 */
export function isStagingHost(host) {
  return typeof host === 'string' && host.toLowerCase().includes('staging');
}

/**
 * Constant-time token comparison. Returns false on any type mismatch, empty
 * value, or length mismatch (never calls timingSafeEqual on unequal-size
 * buffers, which would throw).
 */
export function safeTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Authorization decision for one request.
 * @param {string|undefined} host      req.headers.host
 * @param {string|undefined} got       the X-Staging-Token request header
 * @param {string|undefined} expected  process.env.STAGING_DASHBOARD_TOKEN
 * @returns {boolean} true if the request may proceed.
 *   Non-staging Hosts always pass. Staging Hosts require a configured secret
 *   AND a timing-safe token match (fail-closed).
 */
export function isStagingRequestAuthorized(host, got, expected) {
  if (!isStagingHost(host)) return true;   // not staging: unaffected
  if (!expected) return false;             // fail-closed: no secret configured
  return safeTokenEquals(got, expected);
}
