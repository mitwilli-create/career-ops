#!/usr/bin/env node
/**
 * scripts/agents/backfill-tracker-notes.mjs — replace useless
 * "Batches API eval" placeholder notes in data/applications.md with the
 * real TL;DR extracted from each row's linked report file.
 *
 * Background: batch-runner-batches.mjs:890 wrote the note column as
 * `"Batches API eval | <archetype> | <legitimacy> | triage <N>/5"` —
 * the prefix says HOW the eval ran, not WHY the score is what it is.
 * The dashboard drawer renders this string as the "Why this score" card
 * (build-dashboard.mjs:3179). Every batch-eval'd row looks the same +
 * uninformative.
 *
 * This script:
 *   1. Parses data/applications.md row-by-row
 *   2. For each row whose note matches either of these placeholder shapes:
 *        a. "Batches API eval | <archetype> | <legitimacy> | triage <N>/5"
 *        b. "Re-eval YYYY-MM-DD (<prev>→<new>). Batches API eval"
 *      reads the linked report file (column 8 has the markdown link)
 *   3. Extracts the **TL;DR** cell from the report's A) Role Summary table
 *   4. Replaces the placeholder portion with the TL;DR (capped at 200 chars)
 *      while preserving any prefix like "Re-eval YYYY-MM-DD (3.6→4.1). "
 *
 * Idempotent. Safe to re-run.
 *
 * CLI flags:
 *   --dry-run     Print changes without writing
 *   --limit=N     Only process the first N matched rows (for smoke test)
 *   --verbose     Per-row log
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS = join(ROOT, 'data/applications.md');
const REPORTS_DIR = join(ROOT, 'reports');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const VERBOSE = args.has('--verbose');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// Match row note. Captures the optional Re-eval prefix and the placeholder.
//   group 1: optional "Re-eval YYYY-MM-DD (X→Y). " prefix (may be empty)
//   group 2: optional triage score (kept appended after TL;DR)
const PLACEHOLDER_RE = /^(Re-eval\s+\d{4}-\d{2}-\d{2}\s*\([^)]+\)\.\s+)?Batches API eval(?:\s*\|\s*[^|]*\s*\|\s*[^|]*\s*\|\s*triage\s+([\d.]+)\/5)?\s*$/;
const TLDR_RE = /^\|\s*\*\*TL;DR\*\*\s*\|\s*(.+?)\s*\|\s*$/m;
// Row line. Pipe-delimited markdown table row. We use a verbose regex that
// captures: leading pipe + num + " | " ... " | <notes> | " ... trailing pipe.
const ROW_RE = /^(\|\s*(\d+)\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\[([^\]]+)\]\(([^)]+\.md)\)\s*\|\s*)([^|]+?)(\s*\|.*?)$/;

function extractTLDR(reportPath) {
  if (!existsSync(reportPath)) return null;
  const md = readFileSync(reportPath, 'utf-8');
  const m = TLDR_RE.exec(md);
  if (!m) return null;
  let tldr = m[1].trim();
  // Collapse internal whitespace from line continuations
  tldr = tldr.replace(/\s+/g, ' ');
  if (tldr.length > 200) tldr = tldr.slice(0, 197).trimEnd() + '…';
  return tldr;
}

function processFile() {
  const md = readFileSync(APPS, 'utf-8');
  const lines = md.split('\n');
  let updated = 0;
  let skippedNoReport = 0;
  let skippedNoTldr = 0;
  let unchanged = 0;
  let matched = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.startsWith('|---') || line.startsWith('| #')) continue;
    const rowMatch = ROW_RE.exec(line);
    if (!rowMatch) continue;
    const num = rowMatch[2];
    const reportRelPath = rowMatch[4];
    const oldNote = rowMatch[5];

    const phMatch = PLACEHOLDER_RE.exec(oldNote);
    if (!phMatch) continue;
    matched++;
    if (matched > LIMIT) break;

    const reportPath = join(REPORTS_DIR, reportRelPath.replace(/^reports\//, ''));
    const tldr = extractTLDR(reportPath);
    if (!tldr) { skippedNoTldr++; if (VERBOSE) console.log(`  ${num}: no TL;DR in ${reportRelPath}`); continue; }

    const reEvalPrefix = phMatch[1] || '';
    const triageScore = phMatch[2] || null;
    const newNoteCore = triageScore ? `${tldr} | triage ${triageScore}/5` : tldr;
    const newNote = reEvalPrefix + newNoteCore;

    if (newNote === oldNote) { unchanged++; continue; }

    // Targeted replacement: rebuild the line by stitching head + new note + tail.
    // ROW_RE groups: 1 = head (includes trailing " | "), 5 = oldNote, 6 = tail (includes leading " | ")
    lines[i] = rowMatch[1] + newNote + rowMatch[6];
    updated++;
    if (VERBOSE) console.log(`  ${num}: ${newNote.slice(0, 100)}${newNote.length > 100 ? '…' : ''}`);
  }

  console.log('');
  console.log(`Matched (placeholder):      ${matched}`);
  console.log(`Updated:                    ${updated}`);
  console.log(`Skipped (no report file):   ${skippedNoReport}`);
  console.log(`Skipped (no TL;DR):         ${skippedNoTldr}`);
  console.log(`Unchanged (idempotent):     ${unchanged}`);

  if (!DRY && updated > 0) {
    writeFileSync(APPS, lines.join('\n'));
    console.log(`\nWrote ${APPS}`);
  } else if (DRY) {
    console.log(`\n[--dry-run] no write`);
  } else {
    console.log(`\nNo changes to write`);
  }
}

processFile();
