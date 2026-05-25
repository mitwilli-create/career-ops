// lib/v2-fix-log.mjs
//
// v2 (2026-05-25) — append-only writer for the v2 auto-fix activity log.
// PR #7 of 10. Spec § data/decisions-pending-regression-auto-action-2026-05-25.md
//
// File: data/v2-fix-log.jsonl
// Schema (one JSON per line):
//   {
//     "at": "...iso...",
//     "fix_sha": "abc1234567",
//     "detector": "regression-guard" | "bug-resolver" | "...",
//     "detector_severity": "CRIT" | "HIGH" | "MED" | "LOW",
//     "finding_hash": "sha256:abc...",
//     "pr_url": "https://github.com/mitwilli-create/career-ops/pull/N",
//     "pr_state": "DRAFT" | "MERGED" | "VERIFIED" | "REVERTED",
//     "verification": { "overall": "PASS" | "FAIL", "fail_reason"?: "..." },
//     "cost_usd": 0.50,
//     "files_changed": ["scripts/agents/foo.mjs"],
//     "time_to_resolution_ms": 320000
//   }
//
// Callers:
//   - bug-resolver.mjs: writes on DRAFT_PR_READY success (PR #8)
//   - v2-verify-subset.mjs: writes on verify PASS or FAIL (PR #8)
//   - heartbeat-evening.mjs: reads via readLast24hEntries() (PR #6)
//
// Cross-fork-leak guard: files_changed stores PATHS only — never inline
// content from cv.md, applications.md, hm-intel/, apply-pack[s]/,
// second-brain-extracted/, .claude/projects/.

import {
  readFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const LOG_PATH = join(REPO_ROOT, 'data', 'v2-fix-log.jsonl');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Allowed values for schema validation.
const ALLOWED_DETECTORS = new Set(['regression-guard', 'bug-resolver', 'manual']);
const ALLOWED_SEVERITIES = new Set(['CRIT', 'HIGH', 'MED', 'LOW']);
const ALLOWED_PR_STATES = new Set(['DRAFT', 'MERGED', 'VERIFIED', 'REVERTED']);

function isoNow() {
  return new Date().toISOString();
}

/**
 * Validate and normalise an entry before writing.
 * Throws on missing required fields; fills defaults for optional ones.
 * @param {object} entry
 * @returns {object} normalised entry
 */
function normaliseEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('appendV2FixLogEntry: entry must be an object');

  // Required fields.
  if (!entry.fix_sha || typeof entry.fix_sha !== 'string') throw new Error('appendV2FixLogEntry: fix_sha required (string)');
  if (!entry.detector) throw new Error('appendV2FixLogEntry: detector required');
  if (!entry.detector_severity) throw new Error('appendV2FixLogEntry: detector_severity required');
  if (!entry.finding_hash || typeof entry.finding_hash !== 'string') throw new Error('appendV2FixLogEntry: finding_hash required (string)');
  if (!entry.pr_state) throw new Error('appendV2FixLogEntry: pr_state required');

  if (!ALLOWED_DETECTORS.has(entry.detector)) {
    console.warn(`[v2-fix-log] unknown detector "${entry.detector}" — storing as-is`);
  }
  if (!ALLOWED_SEVERITIES.has(entry.detector_severity)) {
    throw new Error(`appendV2FixLogEntry: detector_severity must be one of ${[...ALLOWED_SEVERITIES].join(' | ')} (got "${entry.detector_severity}")`);
  }
  if (!ALLOWED_PR_STATES.has(entry.pr_state)) {
    throw new Error(`appendV2FixLogEntry: pr_state must be one of ${[...ALLOWED_PR_STATES].join(' | ')} (got "${entry.pr_state}")`);
  }

  // Normalise + fill optional fields.
  const out = {
    at: entry.at || isoNow(),
    fix_sha: entry.fix_sha,
    detector: entry.detector,
    detector_severity: entry.detector_severity,
    finding_hash: entry.finding_hash,
    pr_url: entry.pr_url || null,
    pr_state: entry.pr_state,
    verification: entry.verification || null,
    cost_usd: typeof entry.cost_usd === 'number' ? entry.cost_usd : null,
    files_changed: Array.isArray(entry.files_changed) ? entry.files_changed : [],
    time_to_resolution_ms: typeof entry.time_to_resolution_ms === 'number' ? entry.time_to_resolution_ms : null,
  };

  // Cross-fork-leak guard: files_changed must contain only paths, never file content.
  // Heuristic: any element longer than 300 chars is suspicious.
  for (const f of out.files_changed) {
    if (typeof f !== 'string') throw new Error('appendV2FixLogEntry: files_changed must be an array of strings (paths)');
    if (f.length > 300) throw new Error(`appendV2FixLogEntry: files_changed entry suspiciously long (${f.length} chars) — store path only, not content`);
  }

  return out;
}

/**
 * Append one entry to data/v2-fix-log.jsonl.
 * Creates the file (and data/ dir) if absent.
 * Logs to stderr on success.
 * @param {object} entry — see schema at top of file
 * @returns {object} the normalised entry that was written
 */
export function appendV2FixLogEntry(entry) {
  const normalised = normaliseEntry(entry);

  // Ensure data/ directory exists (safe to call when dir already exists).
  const dataDir = join(REPO_ROOT, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  appendFileSync(LOG_PATH, JSON.stringify(normalised) + '\n');
  process.stderr.write(`[v2-fix-log] appended entry: fix_sha=${normalised.fix_sha} pr_state=${normalised.pr_state} detector=${normalised.detector}\n`);
  return normalised;
}

/**
 * Load all entries from data/v2-fix-log.jsonl.
 * Returns [] if file is absent. Skips malformed lines silently.
 * @returns {object[]}
 */
export function loadV2FixLog() {
  if (!existsSync(LOG_PATH)) return [];
  const raw = readFileSync(LOG_PATH, 'utf-8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines defensively.
    }
  }
  return entries;
}

/**
 * Return entries from the last 24 hours (relative to asOfMs or now).
 * Used by heartbeat-evening.mjs Section 8.
 * @param {{ asOfMs?: number }} opts
 * @returns {object[]}
 */
export function readLast24hEntries({ asOfMs = Date.now() } = {}) {
  const cutoff = asOfMs - ONE_DAY_MS;
  return loadV2FixLog().filter(e => {
    const t = new Date(e.at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Convenience: return the log path (useful for tests).
 */
export function fixLogPath() {
  return LOG_PATH;
}
