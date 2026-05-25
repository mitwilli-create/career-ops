#!/usr/bin/env node
// scripts/quarantine/empty-enrichment-sweep.mjs
//
// PR-01 — Apply-Now UX overhaul, theme F (data-layer drift)
//
// Quarantine `data/role-enrichment/*.json` rows that landed on disk with empty
// or near-empty enrichment data (silent generator failure leaving header rows
// in INDEX.md but no real content in the JSON).
//
// Detection criteria (a row qualifies if EITHER holds):
//   1. parsed JSON has fewer than 3 top-level keys (`Object.keys.length < 3`)
//   2. all top-level enrichment fields are null / undefined / "" / "unknown"
//
// Action: MOVE matching files to `data/_quarantine/role-enrichment/` with
// `quarantine_reason: 'empty-backfill'`. Sibling `.quarantine-meta.json` records
// the empty-fields summary for forensic review.
//
// Per `.claude/audit/apply-now-ux-audit-2026-05-25/findings.md` §9.2 — at audit
// time INDEX.md cited 22 rows in lines 95-119 with header-only entries. Live
// state (as of script ship) shows 0 — empties may have been since regenerated.
// Script remains as defensive sweep for future regressions.
//
// Flags:
//   --dry-run            List matches without moving
//
// Smoke test:
//   node scripts/quarantine/empty-enrichment-sweep.mjs --dry-run

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(ROOT, 'data', 'role-enrichment');
const DEST_DIR = join(ROOT, 'data', '_quarantine', 'role-enrichment');

const QUARANTINE_REASON = 'empty-backfill';
const QUARANTINED_BY = 'PR-01';

const EMPTYISH = new Set([null, undefined, '', 'unknown', 'Unknown', 'UNKNOWN', 'n/a', 'N/A']);

function isEmptyish(v) {
  if (EMPTYISH.has(v)) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && v !== null && Object.keys(v).length === 0) return true;
  return false;
}

function classifyRow(parsed) {
  // Criterion 1: < 3 top-level keys
  if (!parsed || typeof parsed !== 'object') {
    return { isEmpty: true, reason: 'unparseable-or-non-object', keyCount: 0, emptyKeys: [] };
  }
  const keys = Object.keys(parsed);
  if (keys.length < 3) {
    return { isEmpty: true, reason: 'too-few-keys', keyCount: keys.length, emptyKeys: [] };
  }
  // Criterion 2: all top-level fields are emptyish
  const emptyKeys = keys.filter(k => isEmptyish(parsed[k]));
  if (emptyKeys.length === keys.length) {
    return { isEmpty: true, reason: 'all-fields-empty', keyCount: keys.length, emptyKeys };
  }
  return { isEmpty: false, reason: null, keyCount: keys.length, emptyKeys };
}

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`[empty-enrichment-sweep] ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`);

  if (!existsSync(SRC_DIR)) {
    console.error(`[empty-enrichment-sweep] ERROR: source dir not found: ${SRC_DIR}`);
    process.exit(2);
  }

  const files = readdirSync(SRC_DIR).filter(f => f.endsWith('.json'));
  const matches = [];

  for (const f of files) {
    const path = join(SRC_DIR, f);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      // Unparseable counts as empty (broken row)
      matches.push({ file: f, classification: { isEmpty: true, reason: 'parse-error', keyCount: 0, emptyKeys: [] } });
      continue;
    }
    const cls = classifyRow(parsed);
    if (cls.isEmpty) matches.push({ file: f, classification: cls });
  }

  console.log(`[empty-enrichment-sweep] inspected ${files.length} files, matched ${matches.length}:`);
  for (const m of matches) {
    console.log(`  - ${m.file} [${m.classification.reason}, keys=${m.classification.keyCount}]`);
  }

  if (args.dryRun) {
    console.log('[empty-enrichment-sweep] DRY-RUN: no files moved.');
    return;
  }

  if (matches.length === 0) {
    console.log('[empty-enrichment-sweep] nothing to quarantine.');
    return;
  }

  mkdirSync(DEST_DIR, { recursive: true });
  const stamp = new Date().toISOString();

  for (const m of matches) {
    const src = join(SRC_DIR, m.file);
    const dest = join(DEST_DIR, m.file);
    const meta = {
      original_path: `data/role-enrichment/${m.file}`,
      quarantine_reason: QUARANTINE_REASON,
      quarantined_at: stamp,
      quarantined_by: QUARANTINED_BY,
      detection: m.classification,
      reversal_command: `mv data/_quarantine/role-enrichment/${m.file} data/role-enrichment/${m.file}`,
    };
    try {
      renameSync(src, dest);
      writeFileSync(`${dest}.quarantine-meta.json`, JSON.stringify(meta, null, 2) + '\n');
      console.log(`[empty-enrichment-sweep] MOVED ${m.file} → ${dest}`);
    } catch (e) {
      console.error(`[empty-enrichment-sweep] ERROR moving ${m.file}: ${e.message}`);
      process.exit(4);
    }
  }

  console.log(`[empty-enrichment-sweep] done. ${matches.length} files quarantined to ${DEST_DIR}`);
}

main();
