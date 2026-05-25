// lib/v2-thrash-counter.mjs
//
// v2 (2026-05-25) — append-only rollback counter for the v2 autonomous-
// remediation pipeline. PR #5 of 10. Spec § Q10 + interview Q6.
//
// File: data/v2-rollback-counter.jsonl
// Schema (one JSON per line):
//   {
//     at: "...iso...",          // timestamp of the revert
//     fix_sha: "abc123",        // commit SHA that was reverted
//     reason: "verification-subset-fail" | "cli-manual" | "...",
//     trigger: "auto" | "manual",
//     frozen_until: null | "...iso..."   // set on the entry that triggers freeze
//   }
//
// Q6 (interview): manual rollbacks (`node v2-rollback.mjs <sha>`) DO log
// to the counter for audit BUT do NOT count toward the 3/24h freeze
// threshold. Only auto-reverts (trigger: "auto") contribute to the freeze.
//
// Freeze policy (spec):
//   - If auto-revert count in the last 24h reaches 3, set frozen_until on
//     the 3rd entry to (now + 24h).
//   - Any subsequent v2 pipeline invocation checks isV2Frozen() before
//     starting; if frozen, refuse + write a CRIT finding for the evening
//     heartbeat recap.

import {
  readFileSync, writeFileSync, appendFileSync, existsSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const COUNTER_PATH = join(REPO_ROOT, 'data/v2-rollback-counter.jsonl');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_THRESHOLD = 3;  // 3 auto-reverts in 24h → freeze

export function counterPath() {
  return COUNTER_PATH;
}

function isoNow() {
  return new Date().toISOString();
}

/**
 * Read every entry currently in the counter file.
 * Skips malformed lines silently (defensive).
 */
export function loadCounter() {
  if (!existsSync(COUNTER_PATH)) return [];
  const raw = readFileSync(COUNTER_PATH, 'utf-8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  return entries;
}

/**
 * Count auto-reverts in the last 24h. Manual rollbacks excluded (Q6).
 */
export function autoRevertsLast24h({ asOfMs = Date.now() } = {}) {
  const cutoff = asOfMs - ONE_DAY_MS;
  return loadCounter().filter(e => {
    if (e.trigger !== 'auto') return false;
    const t = new Date(e.at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Is v2 currently frozen? Returns true if any counter entry has
 * frozen_until > now. The freeze auto-expires after 24h.
 */
export function isV2Frozen({ asOfMs = Date.now() } = {}) {
  const entries = loadCounter();
  for (const e of entries) {
    if (!e.frozen_until) continue;
    const t = new Date(e.frozen_until).getTime();
    if (Number.isFinite(t) && t > asOfMs) return true;
  }
  return false;
}

/**
 * Returns the active freeze entry if any, else null.
 */
export function getActiveFreeze({ asOfMs = Date.now() } = {}) {
  const entries = loadCounter();
  for (const e of entries) {
    if (!e.frozen_until) continue;
    const t = new Date(e.frozen_until).getTime();
    if (Number.isFinite(t) && t > asOfMs) return e;
  }
  return null;
}

/**
 * Record a rollback. trigger="auto" contributes to the 24h count; the 3rd
 * auto-revert in 24h triggers freeze (sets frozen_until on the entry).
 * trigger="manual" logs for audit but never freezes.
 *
 * Returns the appended entry so caller can surface freeze state in logs /
 * heartbeat recap.
 */
export function recordRollback({ fix_sha, reason, trigger }) {
  if (!fix_sha) throw new Error('recordRollback: fix_sha required');
  if (!reason) throw new Error('recordRollback: reason required');
  if (trigger !== 'auto' && trigger !== 'manual') {
    throw new Error(`recordRollback: trigger must be "auto" or "manual" (got ${trigger})`);
  }

  let frozen_until = null;
  if (trigger === 'auto') {
    // Count includes THIS new entry — so we count existing-auto + 1
    const existingAuto = autoRevertsLast24h().length;
    if (existingAuto + 1 >= AUTO_THRESHOLD) {
      frozen_until = new Date(Date.now() + ONE_DAY_MS).toISOString();
    }
  }

  const entry = {
    at: isoNow(),
    fix_sha,
    reason,
    trigger,
    frozen_until,
  };
  appendFileSync(COUNTER_PATH, JSON.stringify(entry) + '\n');
  return entry;
}
