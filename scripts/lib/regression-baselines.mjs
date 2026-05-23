/**
 * scripts/lib/regression-baselines.mjs
 *
 * Baseline store — load / write / expiry / provenance API.
 *
 * Spec source: dealbreaker-final § Audit Item 3 — stale-baseline-poisoning
 * prevention. Every baseline file carries set_at + set_via + expires_at
 * (30-day expiry default). Expired baselines hard-block comparison.
 * Provenance log at _provenance.jsonl (append-only) records every write.
 *
 * Designed as a SHARED library at scripts/lib/ so future agents
 * (system-maintainer, omega-steward, etc.) can also write baselines through
 * the same contract.
 *
 * Extracted from the v1.0 regression-guard.mjs monolith during the Q5
 * lib-split (2026-05-23). Behavior preserved exactly.
 *
 * Callers pass `baselineDir` + `expiryDays` explicitly — keeps this module
 * config-agnostic + reusable across agents.
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

export const BASELINE_KINDS = new Set([
  'code', 'data', 'structural', 'behavioral', 'memory', 'transcript', 'none-applicable',
]);

export function baselinePath(baselineDir, type) {
  return join(baselineDir, `${type}.json`);
}

export function loadBaseline(baselineDir, type) {
  const p = baselinePath(baselineDir, type);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Write a baseline file + append a provenance row.
 *
 * @param {object} opts
 * @param {string} opts.baselineDir   absolute dir to store baselines in
 * @param {string} opts.provenancePath absolute path to the _provenance.jsonl
 * @param {string} opts.type          baseline name (e.g., 'ui-dashboard-bytes')
 * @param {*}      opts.data          arbitrary baseline payload
 * @param {string} opts.kind          one of BASELINE_KINDS
 * @param {string} opts.via           who/what set this (e.g., 'scheduled', 'seed-baselines')
 * @param {string} opts.setByLabel    free-form set_by label (e.g., 'regression-guard @ 2026-05-23')
 * @param {number} opts.expiryDays    days until baseline expires
 * @returns {object} the full baseline record written to disk
 */
export function writeBaseline({
  baselineDir, provenancePath, type, data, kind = 'data',
  via = 'scheduled', setByLabel = '', expiryDays = 30,
}) {
  if (!BASELINE_KINDS.has(kind)) {
    throw new Error(`writeBaseline: invalid kind="${kind}". Must be one of: ${[...BASELINE_KINDS].join(', ')}`);
  }
  if (!existsSync(baselineDir)) mkdirSync(baselineDir, { recursive: true });
  const now = new Date();
  const expires = new Date(now.getTime() + expiryDays * 24 * 3600 * 1000);
  const baseline = {
    type,
    baseline_kind: kind,
    set_at: now.toISOString(),
    set_by: setByLabel,
    set_via: via,
    expires_at: expires.toISOString(),
    data,
  };
  writeFileSync(baselinePath(baselineDir, type), JSON.stringify(baseline, null, 2));
  if (provenancePath) {
    appendFileSync(provenancePath, JSON.stringify({
      type, kind, action: 'set', at: now.toISOString(), via,
    }) + '\n');
  }
  return baseline;
}

export function baselineExpired(b) {
  if (!b || !b.expires_at) return true;
  return new Date(b.expires_at).getTime() < Date.now();
}
