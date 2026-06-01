#!/usr/bin/env node
/**
 * tests/pipeline-parse-invariant.test.mjs
 *
 * 2026-06-01 — The TRIPWIRE for the "Process All completed · drained 0" silent
 * failure. data/pipeline.md is read by TWO parsers that must agree:
 *
 *   1. Blind prefix count (orchestrator countPendingPipeline + dashboard preview):
 *        lines starting with "- [ ] "
 *   2. triage.mjs::parsePipeline (the engine that actually triages):
 *        lines matching /^- \[ \] (https?:\/\/\S+)/  (URL-first)
 *
 * When they diverge, the gap is pending items INVISIBLE to triage — they sit in
 * the queue forever, the count never drops, and every Process All run reports a
 * green "completed · drained 0". (Root cause 2026-06-01: 303 HN "Who-Is-Hiring"
 * entries written company-first by scan-hn-hiring.mjs.)
 *
 * INVARIANT: parsePipeline(pipeline.md).length === count('- [ ] ' lines).
 *
 * Any future PR touching a pipeline ingest writer (scan-hn-hiring.mjs /
 * community-scan.mjs / scan-rss.mjs / scan.mjs) must keep this green.
 *
 * Exit codes:
 *   0 — clean (parsers agree)
 *   2 — parse gap (prints the offending un-parseable lines + the fix command)
 *
 * Resolution when this fails:
 *   node scripts/backfill-hn-pipeline-format.mjs --apply
 *   then re-run this test.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parsePipeline } from '../triage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PIPELINE_PATH = join(ROOT, 'data/pipeline.md');

if (!existsSync(PIPELINE_PATH)) {
  console.log('⊘ data/pipeline.md not present — skipping (nothing to validate).');
  process.exit(0);
}

const content = readFileSync(PIPELINE_PATH, 'utf8');
const rawLines = content.split('\n').filter(l => l.startsWith('- [ ] '));
const rawCount = rawLines.length;
const parsed = parsePipeline(content);
const parsedCount = parsed.length;
const gap = rawCount - parsedCount;

console.log(`pipeline.md: ${rawCount} '- [ ] ' line(s) · parsePipeline matched ${parsedCount}`);

if (gap === 0) {
  console.log('✓ pipeline-parse invariant holds — both parsers agree.');
  process.exit(0);
}

// Gap → print the un-parseable lines so the operator can act.
const parsedUrls = new Set(parsed.map(p => p.url));
const offenders = rawLines.filter(l => {
  const m = l.match(/^- \[ \] (https?:\/\/\S+)/);
  return !(m && parsedUrls.has(m[1]));
});

console.error(`✗ PARSE GAP: ${gap} pending line(s) are un-parseable by triage.mjs::parsePipeline (non-URL-first).`);
console.error(`  These items will NEVER be triaged and cause "Process All · drained 0".`);
for (const l of offenders.slice(0, 8)) console.error('    ' + l.slice(0, 160));
if (offenders.length > 8) console.error(`    … and ${offenders.length - 8} more`);
console.error(`\n  → Fix: node scripts/backfill-hn-pipeline-format.mjs --apply`);
process.exit(2);
