#!/usr/bin/env node
/**
 * Custom git merge driver for append-only JSONL files (e.g. data/bug-ledger.jsonl).
 *
 * Registered via:
 *   .gitattributes:  data/bug-ledger.jsonl merge=jsonl-union
 *   .git/config:     [merge "jsonl-union"]
 *                      driver = node scripts/jsonl-merge-driver.mjs %O %A %B %L %P
 *
 * Called by git as:
 *   node scripts/jsonl-merge-driver.mjs BASE CURRENT OTHER MARKER PATH
 *
 * The driver union-merges all entries from CURRENT and OTHER (both branches),
 * deduplicating by `id` field (latest `last_updated` wins on collision),
 * and writes the sorted result back to CURRENT. Exits 0 on success.
 *
 * This resolves the competing-bug-entry class of conflict described in
 * AGENTS.md § Bug class: jsonl-concurrent-write-collision.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [,, base, current, other] = process.argv;

if (!base || !current || !other) {
  process.stderr.write('Usage: jsonl-merge-driver.mjs BASE CURRENT OTHER [MARKER] [PATH]\n');
  process.exit(1);
}

function readEntries(filepath) {
  const entries = new Map();
  try {
    const text = readFileSync(filepath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.id) entries.set(obj.id, obj);
      } catch {
        // Skip malformed lines — surface a warning but don't abort
        process.stderr.write(`[jsonl-merge] WARNING: skipping malformed line in ${filepath}\n`);
      }
    }
  } catch {
    // File missing (e.g. BASE when file is new on both sides) — treat as empty
  }
  return entries;
}

const currentEntries = readEntries(current);
const otherEntries = readEntries(other);

const allIds = new Set([...currentEntries.keys(), ...otherEntries.keys()]);
const merged = new Map();

for (const id of allIds) {
  const cur = currentEntries.get(id);
  const oth = otherEntries.get(id);

  if (cur && !oth) {
    merged.set(id, cur);
  } else if (!cur && oth) {
    merged.set(id, oth);
  } else {
    // Both sides have this ID — keep the one with later last_updated (fall back to first_seen)
    const tCur = new Date(cur.last_updated || cur.first_seen || 0).getTime();
    const tOth = new Date(oth.last_updated || oth.first_seen || 0).getTime();
    merged.set(id, tOth > tCur ? oth : cur);
    if (tCur === tOth && JSON.stringify(cur) !== JSON.stringify(oth)) {
      process.stderr.write(
        `[jsonl-merge] WARNING: id="${id}" has identical timestamps but differing content — keeping CURRENT side\n`,
      );
    }
  }
}

// Stable sort: first_seen ascending, then id lexicographic
const sorted = [...merged.values()].sort((a, b) => {
  const ta = new Date(a.first_seen || 0).getTime();
  const tb = new Date(b.first_seen || 0).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
});

writeFileSync(current, sorted.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
process.stderr.write(
  `[jsonl-merge] Merged ${currentEntries.size} + ${otherEntries.size} entries → ${sorted.length} unique\n`,
);
process.exit(0);
