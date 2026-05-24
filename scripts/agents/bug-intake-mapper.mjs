#!/usr/bin/env node
// scripts/agents/bug-intake-mapper.mjs
//
// Bug intake mapper — walks every bug-filing surface, dedups against the
// ledger by source_hash, appends new entries with stable IDs. Deterministic
// (no LLM calls). Runs Sunday 23:00 PT via launchd (LOADED-but-DISABLED day-1)
// + on demand via this CLI.
//
// Phase 1 of bug-resolver (data/bug-resolver-plan.md).
// Phase 2 (orchestrator that processes the ledger via vendor calls) is a
// separate ship.
//
// CLI:
//   node scripts/agents/bug-intake-mapper.mjs                 # full run, writes
//   node scripts/agents/bug-intake-mapper.mjs --dry-run       # preview, no writes
//   node scripts/agents/bug-intake-mapper.mjs --surface NAME  # single reader
//   node scripts/agents/bug-intake-mapper.mjs --help
//
// Exit codes:
//   0 — clean run
//   1 — fatal error
//   2 — unknown --surface name
//   3 — sanity check fired (sensitive-source had non-placeholder summary)

import { DEFAULT_READERS, ALL_READERS_INCLUDING_OPT_IN } from '../../lib/bug-resolver/intake-surfaces.mjs';
import {
  loadLedger, appendEntry, nextId, makeNewEntry, ledgerPath,
} from '../../lib/bug-resolver/ledger.mjs';

// ─── PT helpers (UTC-7) ─────────────────────────────────────────────────────
function ptDateStamp() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function ptIsoNow() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}

// ─── CLI parse ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { dryRun: false, surface: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--surface') opts.surface = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
bug-intake-mapper — walks bug-filing surfaces, dedups, appends new entries

Usage:
  node scripts/agents/bug-intake-mapper.mjs [options]

Options:
  --dry-run            Preview new entries without writing to ledger
  --surface <name>     Run only one reader (default OR opt-in); one of:
                       ${ALL_READERS_INCLUDING_OPT_IN.map(r => r.name).join(', ')}
  --help, -h           Show this message

Default readers (high-signal, run on every invocation):
  ${DEFAULT_READERS.map(r => r.name).join(', ')}

Opt-in readers (heuristic, invoke explicitly via --surface):
  ${(ALL_READERS_INCLUDING_OPT_IN.length - DEFAULT_READERS.length === 0
      ? '(none)'
      : ALL_READERS_INCLUDING_OPT_IN.filter(r => !DEFAULT_READERS.includes(r)).map(r => r.name).join(', '))}

Output: per-surface table + total + ledger path. Ledger is gitignored.
  `.trim());
}

// Defensive guard — sensitive sources MUST have placeholder summaries.
// If this fires, it indicates a reader bug that needs fixing before ship.
function sanityCheckSensitiveEntries(entries) {
  for (const e of entries) {
    if (e.is_sensitive_source && e.summary && !e.summary.startsWith('<')) {
      throw new Error(
        `Sensitive source "${e.source_surface}" has non-placeholder summary: ` +
        `"${e.summary.slice(0, 60)}..." — readers must emit "<...>" placeholder ` +
        `for is_sensitive_source=true entries (cross-fork-leak protection).`
      );
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  const startedAt = ptIsoNow();
  const today = ptDateStamp();

  console.log(`[bug-intake-mapper] start ${startedAt}`);
  console.log(`[bug-intake-mapper] mode: ${opts.dryRun ? 'DRY-RUN (no writes)' : 'WRITE'}`);

  const readers = opts.surface
    ? ALL_READERS_INCLUDING_OPT_IN.filter(r => r.name === opts.surface)
    : DEFAULT_READERS;
  if (opts.surface && readers.length === 0) {
    console.error(`Unknown surface: ${opts.surface}`);
    console.error(`Available: ${ALL_READERS_INCLUDING_OPT_IN.map(r => r.name).join(', ')}`);
    process.exit(2);
  }

  // Load existing ledger hashes ONCE so per-surface dedup math is consistent.
  const existing = new Set(loadLedger().map(e => e.source_hash));
  const perSurface = [];

  for (const reader of readers) {
    let entries = [];
    let err = null;
    try { entries = await reader.fn(); }
    catch (e) { err = e.message; }

    if (err) {
      perSurface.push({ name: reader.name, scanned: 0, new: 0, dup: 0, error: err, newEntries: [] });
      continue;
    }

    const newE = [];
    let dup = 0;
    for (const e of entries) {
      if (existing.has(e.source_hash)) {
        dup++;
      } else {
        newE.push(e);
        existing.add(e.source_hash); // avoid same-hash across surfaces in one run
      }
    }
    perSurface.push({
      name: reader.name,
      scanned: entries.length,
      new: newE.length,
      dup,
      error: null,
      newEntries: newE,
    });
  }

  // Sanity check BEFORE writes
  const allNew = perSurface.flatMap(s => s.newEntries);
  try {
    sanityCheckSensitiveEntries(allNew);
  } catch (e) {
    console.error(`\nSANITY CHECK FIRED: ${e.message}`);
    console.error(`Aborting run. No writes performed.`);
    process.exit(3);
  }

  // Write
  if (!opts.dryRun) {
    for (const s of perSurface) {
      for (const raw of s.newEntries) {
        const id = nextId(today);
        const entry = makeNewEntry({ raw, id, ptNow: ptIsoNow() });
        appendEntry(entry);
      }
    }
  }

  // Report
  console.log(`\nPer-surface summary:`);
  console.log(`  Surface                Scanned   New   Dup   Error`);
  console.log(`  -------                -------   ---   ---   -----`);
  let totalNew = 0;
  for (const row of perSurface) {
    console.log(
      `  ${row.name.padEnd(22)} ` +
      `${String(row.scanned).padStart(7)}   ` +
      `${String(row.new).padStart(3)}   ` +
      `${String(row.dup).padStart(3)}   ` +
      `${row.error ? row.error.slice(0, 50) : ''}`
    );
    totalNew += row.new;
  }
  console.log(`\nTotal new entries: ${totalNew}`);
  console.log(`Ledger: ${ledgerPath()}`);
  if (opts.dryRun) console.log(`(dry-run — nothing written)`);
  console.log(`\n[bug-intake-mapper] done ${ptIsoNow()}`);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack || '');
  process.exit(1);
});
