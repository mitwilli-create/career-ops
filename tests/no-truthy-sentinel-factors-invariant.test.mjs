#!/usr/bin/env node
/**
 * tests/no-truthy-sentinel-factors-invariant.test.mjs
 *
 * 2026-05-29 — Invariant test that fails CI when any apply-now-queue.json
 * ranked row carries a JS-truthy sentinel STRING in `factors.equity_stage`
 * (or other gated fields) that would fool downstream `if (row.factors.X)`
 * predicates into treating uncurated data as populated.
 *
 * Closes Margaret Hamilton Phase 3.5 finding (deploy-verify 2026-05-29):
 *   bug_class: sentinel-string-treated-as-truthy-by-gating-predicate
 *   verification_point: "replace sentinel with null and gate on value != null"
 *
 * Same family as the F297 People-cell `name='unknown'` bug already in
 * AGENTS.md catalog (`### Bug class: sentinel-string-treated-as-truthy-by-gating-predicate`).
 *
 * Checks for each ranked row's `factors.equity_stage`:
 *   - null / undefined: OK (canonical "absent")
 *   - real value matching `/^(Pre-IPO|Public|Private|Series \w+|Late|Post-IPO|Early|Seed)/i`: OK
 *   - empty string: OK (treated as absent)
 *   - any other STRING containing "unknown" / "pending" / "n/a" / "tbd" / "set after"
 *     / "manual review" / "set later": FAIL (sentinel pattern)
 *   - any other STRING not matching the canonical patterns: WARN (unrecognized but
 *     not a known sentinel — log for inspection)
 *
 * Exit codes:
 *   0 — clean
 *   2 — sentinel violation (prints offending rows + resolution command)
 *
 * Resolution when this fails:
 *   1. Find the writer that emitted the sentinel
 *   2. Replace with null (preferred) or a real stage string
 *   3. node scripts/rebuild-apply-now-queue.mjs   (to refresh queue.json)
 *   4. Re-run this test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUEUE_PATH = join(ROOT, 'data/apply-now-queue.json');

// Sentinel-pattern regex — strings matching this are JS-truthy but mean "absent"
// to a human reader. Any such value passing through a gating predicate is a bug.
const SENTINEL_RE = /unknown|pending|n\/a|tbd|set after|manual review|set later|to be determined|not yet/i;

// Canonical pattern — these are real equity stages
const CANONICAL_RE = /^(Pre-IPO|Public|Private|Series\s+[A-K]\b|Late|Post-IPO|Early|Seed)/i;

let violations = 0;
const printed = [];

if (!existsSync(QUEUE_PATH)) {
  console.log('✓ apply-now-queue.json absent — invariant vacuously holds');
  process.exit(0);
}

let q;
try { q = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')); }
catch (e) {
  console.error(`✗ apply-now-queue.json is not valid JSON: ${e.message}`);
  process.exit(2);
}
const ranked = Array.isArray(q.ranked) ? q.ranked : [];

const sentinelRows = [];
const unknownRows = [];

for (const r of ranked) {
  if (r._dropped) continue;
  const v = r?.factors?.equity_stage;
  if (v === null || v === undefined) continue;
  if (typeof v !== 'string') continue;
  if (v.trim() === '') continue;
  if (SENTINEL_RE.test(v)) {
    sentinelRows.push({ num: r.num, company: r.company, value: v });
  } else if (!CANONICAL_RE.test(v)) {
    unknownRows.push({ num: r.num, company: r.company, value: v });
  }
}

if (sentinelRows.length > 0) {
  violations += sentinelRows.length;
  printed.push(`✗ apply-now-queue.json has ${sentinelRows.length} ranked row(s) with truthy SENTINEL in factors.equity_stage:`);
  for (const r of sentinelRows.slice(0, 10)) {
    printed.push(`    #${r.num} ${r.company} — equity_stage="${(r.value || '').slice(0, 70)}"`);
  }
  if (sentinelRows.length > 10) printed.push(`    … and ${sentinelRows.length - 10} more`);
}

if (unknownRows.length > 0) {
  console.log(`⚠ ${unknownRows.length} ranked row(s) have unrecognized factors.equity_stage values (not sentinel, not canonical):`);
  for (const r of unknownRows.slice(0, 5)) {
    console.log(`    #${r.num} ${r.company} — equity_stage="${(r.value || '').slice(0, 70)}"`);
  }
  if (unknownRows.length > 5) console.log(`    … and ${unknownRows.length - 5} more`);
}

if (violations === 0) {
  console.log('✓ no truthy sentinel strings in factors.equity_stage');
  console.log(`  ${ranked.filter(r => !r._dropped).length} live rows scanned · ${unknownRows.length} unrecognized (warn-only)`);
  process.exit(0);
} else {
  console.error(`\nFAIL: ${violations} truthy-sentinel violation(s):`);
  for (const line of printed) console.error(line);
  console.error(`\nResolve:`);
  console.error(`  1. Replace sentinel with null at the writer site (grep for the sentinel string in scripts/ + lib/)`);
  console.error(`  2. node scripts/rebuild-apply-now-queue.mjs`);
  console.error(`  3. node tests/no-truthy-sentinel-factors-invariant.test.mjs`);
  process.exit(2);
}
