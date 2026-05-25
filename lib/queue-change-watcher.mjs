/**
 * lib/queue-change-watcher.mjs — Watch apply-now-queue.json for changes
 *
 * PR-06 of the Apply-Now Dashboard UX Overhaul (2026-05-25).
 *
 * Watches data/apply-now-queue.json for mtime changes. On change, diffs
 * the current state against the last-seen state (persisted in
 * data/queue-change-state.json). Fires a callback per changed row.
 *
 * Change types:
 *   'composite' — row's composite score changed
 *   'status'    — row's status changed
 *   'both'      — composite AND status changed
 *
 * Default callback behavior (no custom callback):
 *   Touches data/cache-invalidate-<slug>.flag for each changed row so the
 *   next prewarm cycle knows to re-warm that row's caches regardless of TTL.
 *
 * Debounce: fires at most once per slug per 60s.
 *
 * CLI:
 *   node lib/queue-change-watcher.mjs --watch         # long-running watcher
 *   node lib/queue-change-watcher.mjs --diff-once     # one-shot diff + exit
 *
 * API:
 *   import { watchQueueChanges } from './lib/queue-change-watcher.mjs';
 *   const stop = watchQueueChanges((row, changeType) => {
 *     console.log(`Row ${row.num} changed: ${changeType}`);
 *   }, { debounceMs: 60_000 });
 *   // ...later:
 *   stop();
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const QUEUE_PATH = join(ROOT, 'data', 'apply-now-queue.json');
const STATE_PATH = join(ROOT, 'data', 'queue-change-state.json');
const INVALIDATE_DIR = join(ROOT, 'data');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJsonSafe(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}

function writeJsonSafe(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) {}
}

/**
 * Build a stable key for a row from its num field.
 */
function rowKey(row) {
  return String(row.num);
}

/**
 * Extract the fields we diff from a raw row.
 */
function extractDiffFields(row) {
  return {
    composite: row.composite ?? null,
    status: row.status ?? null,
  };
}

/**
 * Build a snapshot map from the queue's ranked array.
 * Returns { [num]: { composite, status, company, role, ... } }
 */
function buildSnapshot(queueData) {
  const snap = {};
  for (const row of (queueData?.ranked || [])) {
    snap[rowKey(row)] = {
      ...extractDiffFields(row),
      company: row.company || '',
      role: row.role || '',
      _dropped: !!row._dropped,
      too_late_flag: !!row.too_late_flag,
    };
  }
  return snap;
}

/**
 * Compare two snapshots. Returns array of { row, changeType, prev, next }.
 */
function diffSnapshots(prev, next) {
  const changes = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of allKeys) {
    const p = prev[key];
    const n = next[key];
    if (!p || !n) continue; // row added/removed — not a diff event

    const compositeChanged = p.composite !== n.composite;
    const statusChanged = p.status !== n.status;

    if (!compositeChanged && !statusChanged) continue;

    let changeType;
    if (compositeChanged && statusChanged) changeType = 'both';
    else if (compositeChanged) changeType = 'composite';
    else changeType = 'status';

    changes.push({
      row: { num: key, company: n.company, role: n.role, composite: n.composite, status: n.status },
      changeType,
      prev: { composite: p.composite, status: p.status },
      next: { composite: n.composite, status: n.status },
    });
  }

  return changes;
}

/**
 * Default callback: touch a cache-invalidate flag file for the changed row.
 * The next prewarm cycle reads these flags and forces re-warm for flagged slugs.
 */
function defaultCallback(row, changeType) {
  const slug = String(row.num);
  const flagPath = join(INVALIDATE_DIR, `cache-invalidate-${slug}.flag`);
  try {
    writeFileSync(flagPath, JSON.stringify({
      row_num: slug,
      change_type: changeType,
      flagged_at: new Date().toISOString(),
    }), 'utf-8');
    console.log(`[queue-watcher] flagged cache invalidation for row ${slug} (${changeType})`);
  } catch (err) {
    console.error(`[queue-watcher] failed to write flag for row ${slug}: ${err.message}`);
  }
}

// ─── Core watcher ─────────────────────────────────────────────────────────────

/**
 * Watch apply-now-queue.json for changes.
 *
 * @param {Function} [callback] — (row, changeType) => void
 *   Called for each changed row. Defaults to touching cache-invalidate-<slug>.flag.
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=60000] — min ms between callbacks for same slug
 * @param {number} [opts.pollMs=5000] — fallback poll interval when fs.watch unavailable
 * @returns {Function} stop — call to stop watching
 */
export function watchQueueChanges(callback, opts = {}) {
  const cb = typeof callback === 'function' ? callback : defaultCallback;
  const debounceMs = opts.debounceMs ?? 60_000;

  // Debounce tracking: { [slug]: lastFiredMs }
  const debounceMap = {};

  // Load or initialize state
  let lastState = readJsonSafe(STATE_PATH);
  if (!lastState || !lastState.snapshot) {
    const queue = readJsonSafe(QUEUE_PATH);
    lastState = { snapshot: buildSnapshot(queue), updated_at: new Date().toISOString() };
    writeJsonSafe(STATE_PATH, lastState);
  }

  function processChange() {
    const queue = readJsonSafe(QUEUE_PATH);
    if (!queue) return;
    const nextSnap = buildSnapshot(queue);
    const changes = diffSnapshots(lastState.snapshot, nextSnap);

    if (changes.length === 0) return;

    const now = Date.now();
    for (const { row, changeType, prev, next } of changes) {
      const key = rowKey(row);
      const lastFired = debounceMap[key] || 0;
      if (now - lastFired < debounceMs) {
        console.log(`[queue-watcher] row ${key} change (${changeType}) debounced — last fired ${Math.round((now - lastFired) / 1000)}s ago`);
        continue;
      }
      debounceMap[key] = now;
      console.log(`[queue-watcher] row ${key} changed: ${changeType} | prev=${JSON.stringify(prev)} → next=${JSON.stringify(next)}`);
      try { cb(row, changeType); } catch (err) {
        console.error(`[queue-watcher] callback error for row ${key}: ${err.message}`);
      }
    }

    // Persist new snapshot
    lastState = { snapshot: nextSnap, updated_at: new Date().toISOString() };
    writeJsonSafe(STATE_PATH, lastState);
  }

  // Try native fs.watch first; fall back to polling
  let watcher = null;
  let pollInterval = null;

  if (existsSync(QUEUE_PATH)) {
    try {
      watcher = watch(QUEUE_PATH, { persistent: false }, (eventType) => {
        if (eventType === 'change') processChange();
      });
    } catch (_) {
      // fs.watch unavailable in this environment — use polling
    }
  }

  if (!watcher) {
    const interval = opts.pollMs ?? 5_000;
    pollInterval = setInterval(processChange, interval);
    console.log(`[queue-watcher] using poll mode (every ${interval}ms) — fs.watch unavailable`);
  }

  // Return stop function
  return function stop() {
    if (watcher) { try { watcher.close(); } catch (_) {} }
    if (pollInterval) clearInterval(pollInterval);
  };
}

// ─── One-shot diff ─────────────────────────────────────────────────────────────

/**
 * Print one-shot diff of current queue vs stored state and exit.
 */
export function diffOnce() {
  const queue = readJsonSafe(QUEUE_PATH);
  if (!queue) {
    console.error('[queue-watcher] apply-now-queue.json not found');
    process.exit(1);
  }

  const state = readJsonSafe(STATE_PATH);
  if (!state || !state.snapshot) {
    const snap = buildSnapshot(queue);
    writeJsonSafe(STATE_PATH, { snapshot: snap, updated_at: new Date().toISOString() });
    console.log('[queue-watcher] no prior state — seeded from current queue, 0 changes');
    return;
  }

  const nextSnap = buildSnapshot(queue);
  const changes = diffSnapshots(state.snapshot, nextSnap);

  if (changes.length === 0) {
    console.log('[queue-watcher] no changes detected since last state');
  } else {
    console.log(`[queue-watcher] ${changes.length} change(s) detected:`);
    for (const { row, changeType, prev, next } of changes) {
      console.log(`  row ${row.num} (${row.company} / ${row.role.slice(0, 40)}): ${changeType}`);
      console.log(`    prev: ${JSON.stringify(prev)}`);
      console.log(`    next: ${JSON.stringify(next)}`);
    }
  }

  // Update state
  writeJsonSafe(STATE_PATH, { snapshot: nextSnap, updated_at: new Date().toISOString() });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch');
  const isDiffOnce = args.includes('--diff-once');

  if (isDiffOnce) {
    diffOnce();
  } else if (isWatch) {
    console.log('[queue-watcher] starting — watching', QUEUE_PATH);
    watchQueueChanges(defaultCallback, { debounceMs: 60_000 });
    process.on('SIGINT', () => { console.log('\n[queue-watcher] stopping'); process.exit(0); });
    process.on('SIGTERM', () => process.exit(0));
  } else {
    console.log('Usage:');
    console.log('  node lib/queue-change-watcher.mjs --watch       # long-running watcher');
    console.log('  node lib/queue-change-watcher.mjs --diff-once   # one-shot diff + exit');
    process.exit(0);
  }
}
