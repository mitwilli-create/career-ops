// lib/run-metrics.mjs — sqlite-backed run metrics for the reliability sensor mesh
// (Cluster J, 2026-05-21).
//
// Extends the existing data/job-runs.sqlite (used by scan jobs since 2026-05-04)
// with two new tables:
//
//   run_metrics    — every LLM-spending stage records duration, cost, status,
//                    error class, model, tokens; queried for stage success-rate
//                    over rolling windows + repeat-error detection
//   token_window   — per-provider token counter with minute-window TTL, used
//                    by quota-tracker.mjs to back off before hitting provider
//                    rate limits
//
// Why one DB: every reader is already paying the better-sqlite3 startup cost
// for job_runs queries (cron-health, dashboard hygiene panel, heartbeat). Two
// tables in one file beats two files. Vacuum + backup are atomic.
//
// Migration: tables are created on first import via CREATE TABLE IF NOT
// EXISTS. No version field — adds are append-only. If a schema column needs
// a type change, write a migration script with explicit version tracking.
//
// Anti-bloat: the integrity-check-nightly job prunes run_metrics > 90 days
// old. token_window prunes > 24h old on every insert (sub-millisecond).
//
// Concurrency: better-sqlite3 is synchronous + uses WAL mode. Multiple
// callers from different processes are fine; readers won't block writers.

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_PATH = join(ROOT, 'data/job-runs.sqlite');

let _db = null;

function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS run_metrics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT,
      agent        TEXT NOT NULL,
      stage        TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      duration_ms  INTEGER,
      cost_usd     REAL,
      tokens_in    INTEGER,
      tokens_out   INTEGER,
      status       TEXT NOT NULL,
      error_class  TEXT,
      error_msg    TEXT,
      model        TEXT,
      params_hash  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_metrics_stage_started
      ON run_metrics(stage, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_metrics_agent_started
      ON run_metrics(agent, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_metrics_run_id
      ON run_metrics(run_id);

    CREATE TABLE IF NOT EXISTS token_window (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT NOT NULL,
      tokens      INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_window_provider_recorded
      ON token_window(provider, recorded_at DESC);
  `);
  return _db;
}

// ─────────────────────────────────────────────────────────────────────────
// run_metrics

export function recordRun({
  runId = null,
  agent,
  stage,
  startedAt = new Date().toISOString(),
  durationMs = null,
  costUSD = null,
  tokensIn = null,
  tokensOut = null,
  status,
  errorClass = null,
  errorMsg = null,
  model = null,
  paramsHash = null,
} = {}) {
  if (!agent || !stage || !status) {
    throw new Error('recordRun: agent, stage, status are required');
  }
  return db().prepare(`
    INSERT INTO run_metrics
      (run_id, agent, stage, started_at, duration_ms, cost_usd, tokens_in, tokens_out, status, error_class, error_msg, model, params_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, agent, stage, startedAt, durationMs, costUSD, tokensIn, tokensOut, status, errorClass, errorMsg, model, paramsHash).lastInsertRowid;
}

/**
 * Get rolling-window stats for a stage. Returns { count, successRate, avgDurationMs, avgCostUSD, errorClasses }.
 * successRate is a 0..1 fraction (NULL if count=0).
 */
export function getStageStats(stage, lookbackHours = 24) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const rows = db().prepare(`
    SELECT status, duration_ms, cost_usd, error_class
    FROM run_metrics
    WHERE stage = ? AND started_at >= ?
  `).all(stage, since);
  const count = rows.length;
  if (count === 0) {
    return { count: 0, successRate: null, avgDurationMs: null, avgCostUSD: null, errorClasses: {} };
  }
  const successes = rows.filter(r => r.status === 'success').length;
  const durationsMs = rows.filter(r => r.duration_ms != null).map(r => r.duration_ms);
  const costs = rows.filter(r => r.cost_usd != null).map(r => r.cost_usd);
  const errorClasses = {};
  for (const r of rows) {
    if (r.error_class) errorClasses[r.error_class] = (errorClasses[r.error_class] || 0) + 1;
  }
  return {
    count,
    successRate: successes / count,
    avgDurationMs: durationsMs.length ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length : null,
    avgCostUSD: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
    errorClasses,
  };
}

/**
 * Find error_class values that repeated `threshold` or more times in the last
 * `lookbackHours`. Returns [{ errorClass, count, stage, lastSeen }, ...].
 * Used by integrity-check-nightly to auto-spawn /engineering:debug on chronic
 * failures.
 */
export function getRepeatErrors({ stage = null, threshold = 3, lookbackHours = 24 } = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const where = stage ? 'WHERE stage = ? AND started_at >= ? AND error_class IS NOT NULL' : 'WHERE started_at >= ? AND error_class IS NOT NULL';
  const params = stage ? [stage, since] : [since];
  return db().prepare(`
    SELECT error_class, stage, COUNT(*) as count, MAX(started_at) as last_seen
    FROM run_metrics
    ${where}
    GROUP BY error_class, stage
    HAVING count >= ?
    ORDER BY count DESC, last_seen DESC
  `).all(...params, threshold);
}

/**
 * Stages with success rate < threshold over the window. Used by pre-flight
 * to warn agents that they're calling a stage that's been flaky lately.
 */
export function getFlakyStages({ minSuccessRate = 0.9, minCount = 5, lookbackHours = 24 } = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const rows = db().prepare(`
    SELECT stage,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes
    FROM run_metrics
    WHERE started_at >= ?
    GROUP BY stage
    HAVING total >= ?
  `).all(since, minCount);
  return rows
    .map(r => ({ stage: r.stage, total: r.total, successes: r.successes, successRate: r.successes / r.total }))
    .filter(r => r.successRate < minSuccessRate)
    .sort((a, b) => a.successRate - b.successRate);
}

export function pruneOldRunMetrics(keepDays = 90) {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const result = db().prepare('DELETE FROM run_metrics WHERE started_at < ?').run(cutoff);
  return result.changes;
}

// ─────────────────────────────────────────────────────────────────────────
// token_window — used by quota-tracker.mjs

export function recordTokens(provider, tokens) {
  if (!provider || !Number.isFinite(tokens)) return;
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  // Insert + prune in one transaction so the window stays bounded.
  const insert = db().prepare('INSERT INTO token_window (provider, tokens, recorded_at) VALUES (?, ?, ?)');
  const prune = db().prepare('DELETE FROM token_window WHERE recorded_at < ?');
  const tx = db().transaction(() => {
    insert.run(provider, tokens, now);
    prune.run(cutoff);
  });
  tx();
}

export function getTokensInWindow(provider, windowMs = 60_000) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db().prepare(`
    SELECT COALESCE(SUM(tokens), 0) as total
    FROM token_window
    WHERE provider = ? AND recorded_at >= ?
  `).get(provider, since);
  return row.total;
}

export function getAllProvidersInWindow(windowMs = 60_000) {
  const since = new Date(Date.now() - windowMs).toISOString();
  return db().prepare(`
    SELECT provider, COALESCE(SUM(tokens), 0) as total
    FROM token_window
    WHERE recorded_at >= ?
    GROUP BY provider
  `).all(since);
}
