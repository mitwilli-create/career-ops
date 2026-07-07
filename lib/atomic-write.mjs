// lib/atomic-write.mjs — shared atomic JSON state-file writer.
//
// Extracted (2026-07-06, Qodo B5 sweep) from the private helper in
// lib/process-all-state.mjs so every state writer shares one implementation:
// write to a pid+random-suffixed temp file in the SAME directory, then
// renameSync over the target. rename(2) is atomic on the same filesystem, so
// a crash mid-write can never leave a truncated/corrupt state file — readers
// see either the old file or the new one, never a partial.
//
// Precedent: PR #335 (temp-file-then-rename in lib/process-all-state.mjs);
// bug class `state-file-without-schema-enforcement` documents why direct
// writeFileSync to hot state paths is banned.

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write `payload` as pretty-printed JSON to `targetPath`.
 * Creates the parent directory if missing. Throws the original write error
 * (after best-effort tmp cleanup) so callers keep their existing catch logic.
 *
 * @param {string} targetPath — absolute path to the final state file
 * @param {*} payload — JSON-serializable value
 * @param {object} [opts]
 * @param {number|string} [opts.indent=2] — JSON.stringify third argument
 */
export function atomicWriteJson(targetPath, payload, opts = {}) {
  const indent = opts.indent === undefined ? 2 : opts.indent;
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, indent));
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the orphan tmp; never throw cleanup errors over
    // the real write error.
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Atomically write a raw string/Buffer to `targetPath` (same tmp+rename
 * semantics as atomicWriteJson, for non-JSON state like markdown trackers).
 */
export function atomicWriteFile(targetPath, contents) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
