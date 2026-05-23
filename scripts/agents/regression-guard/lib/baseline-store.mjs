/**
 * scripts/agents/regression-guard/lib/baseline-store.mjs
 *
 * Thin agent-scoped wrapper over scripts/lib/regression-baselines.mjs.
 * Pre-binds the regression-guard-specific baselineDir, provenancePath, and
 * setByLabel so detectors can call `loadBaseline(type)` / `writeBaseline(type,
 * data, kind, via)` without threading config through every callsite.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 */

import * as base from '../../../lib/regression-baselines.mjs';
import {
  BASELINE_DIR, BASELINE_PROVENANCE_PATH, BASELINE_EXPIRY_DAYS, TODAY,
} from './config.mjs';

export const BASELINE_KINDS = base.BASELINE_KINDS;

export function loadBaseline(type) {
  return base.loadBaseline(BASELINE_DIR, type);
}

export function writeBaseline(type, data, kind = 'data', via = 'scheduled') {
  return base.writeBaseline({
    baselineDir: BASELINE_DIR,
    provenancePath: BASELINE_PROVENANCE_PATH,
    type, data, kind, via,
    setByLabel: `regression-guard @ ${TODAY}`,
    expiryDays: BASELINE_EXPIRY_DAYS,
  });
}

export const baselineExpired = base.baselineExpired;
