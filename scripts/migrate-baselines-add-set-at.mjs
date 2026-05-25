#!/usr/bin/env node
/**
 * scripts/migrate-baselines-add-set-at.mjs
 *
 * One-time migration: backfill `set_at`, `set_via`, and `expires_at` fields on
 * regression-baseline JSON files that predate the stale-baseline-poisoning
 * hardening shipped 2026-05-23 via scripts/lib/regression-baselines.mjs.
 *
 * For pre-hardening files that lack these fields, this script derives:
 *   set_at    ← file mtime (best available approximation of when the baseline was written)
 *   set_via   ← 'migration-2026-05-25' (tagged so audit trail is clear)
 *   expires_at← set_at + EXPIRY_DAYS (30d default, per regression-baselines.mjs)
 *
 * Usage:
 *   node scripts/migrate-baselines-add-set-at.mjs           # dry-run (safe, no writes)
 *   node scripts/migrate-baselines-add-set-at.mjs --apply   # write backfilled fields
 *   node scripts/migrate-baselines-add-set-at.mjs --dir <path>  # target a custom dir
 *
 * Exit 0 always (migration errors are warnings, not failures).
 *
 * PR-09 (apply-now UX overhaul, 2026-05-25) — D3.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');

const EXPIRY_DAYS = 30;

// ── Parse CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const apply   = args.includes('--apply');
const dirIdx  = args.indexOf('--dir');
const customDir = dirIdx >= 0 ? args[dirIdx + 1] : null;

const DEFAULT_DIRS = [
  join(ROOT, 'data', 'regression-baselines'),
  join(ROOT, 'data', 'regression-baselines-archive'),
];

const targetDirs = customDir ? [resolve(customDir)] : DEFAULT_DIRS;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * 3600 * 1000);
}

// ── Core migration ────────────────────────────────────────────────────────────

let totalScanned = 0;
let totalAlreadyComplete = 0;
let totalPatched = 0;
let totalSkipped = 0;
let totalErrors  = 0;

const patchLog = [];

for (const dir of targetDirs) {
  if (!existsSync(dir)) {
    console.log(`[skip] ${dir} — does not exist`);
    continue;
  }

  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  } catch (err) {
    console.warn(`[warn] Cannot read ${dir}: ${err.message}`);
    totalErrors++;
    continue;
  }

  for (const f of files) {
    const fp = join(dir, f);
    totalScanned++;

    let raw;
    let obj;
    try {
      raw = readFileSync(fp, 'utf-8');
      obj = JSON.parse(raw);
    } catch (err) {
      console.warn(`[warn] Cannot parse ${fp}: ${err.message}`);
      totalErrors++;
      continue;
    }

    // Check which fields are missing.
    const missingSetAt    = !obj.set_at;
    const missingSetVia   = !obj.set_via;
    const missingExpiresAt = !obj.expires_at;

    if (!missingSetAt && !missingSetVia && !missingExpiresAt) {
      totalAlreadyComplete++;
      console.log(`[ok]   ${f} — already has set_at/set_via/expires_at`);
      continue;
    }

    // Derive set_at from file mtime when missing.
    let setAt;
    if (obj.set_at) {
      setAt = parseDate(obj.set_at) || new Date();
    } else {
      try {
        setAt = new Date(statSync(fp).mtimeMs);
      } catch {
        setAt = new Date(); // absolute fallback: now
      }
    }

    const setVia   = obj.set_via   || 'migration-2026-05-25';
    const expiresAt = obj.expires_at
      ? obj.expires_at  // keep existing if present
      : addDays(setAt, EXPIRY_DAYS).toISOString();

    const patched = {
      ...obj,
      set_at:     obj.set_at     || setAt.toISOString(),
      set_via:    setVia,
      expires_at: expiresAt,
    };

    const changes = [];
    if (missingSetAt)     changes.push('set_at='     + patched.set_at);
    if (missingSetVia)    changes.push('set_via='    + patched.set_via);
    if (missingExpiresAt) changes.push('expires_at=' + patched.expires_at);

    const summary = `[patch] ${f} — would add: ${changes.join(' | ')}`;
    patchLog.push({ fp, patched, summary });

    if (apply) {
      try {
        writeFileSync(fp, JSON.stringify(patched, null, 2));
        console.log(`[write] ${f} — backfilled: ${changes.join(' | ')}`);
        totalPatched++;
      } catch (err) {
        console.warn(`[warn]  ${f} — write failed: ${err.message}`);
        totalErrors++;
      }
    } else {
      console.log(summary);
      totalPatched++; // counts as "would patch" in dry-run
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('── Migration summary ──────────────────────────────────────────');
console.log(`  Mode         : ${apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)'}`);
console.log(`  Dirs checked : ${targetDirs.length}`);
console.log(`  Files scanned: ${totalScanned}`);
console.log(`  Already complete: ${totalAlreadyComplete}`);
console.log(`  ${apply ? 'Patched' : 'Would patch'}: ${totalPatched}`);
console.log(`  Skipped (errors): ${totalErrors}`);
if (!apply && totalPatched > 0) {
  console.log('');
  console.log('  Re-run with --apply to write the backfilled fields.');
}
console.log('──────────────────────────────────────────────────────────────');

process.exit(0);
