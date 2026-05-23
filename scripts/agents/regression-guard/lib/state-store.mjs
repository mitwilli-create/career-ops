/**
 * scripts/agents/regression-guard/lib/state-store.mjs
 *
 * Per-run agent state — last-run timestamp, watermark SHA, finding-history
 * counters (used by silent-period gate). Persisted at STATE_PATH.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly — same schema, same default shape, same
 * crash-safe load.
 */

import {
  existsSync, readFileSync, writeFileSync,
} from 'node:fs';

import { STATE_PATH } from './config.mjs';

export function loadState() {
  if (!existsSync(STATE_PATH)) {
    return {
      version: '1.0.0',
      lastRun: null,
      watermarkSha: null,
      findingHistory: {}, // type -> {lastFindingAt, count7d}
    };
  }
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { version: '1.0.0', lastRun: null, watermarkSha: null, findingHistory: {} }; }
}

export function saveState(state) {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
