#!/usr/bin/env node
/**
 * scripts/canonicalize-queue-rows.mjs
 *
 * Canonicalize LinkedIn URLs for specific apply-now-queue.json rows. Reads the
 * URL from the row (or from the row's report file if queue url is null), runs
 * lib/jd-url-canonicalizer.mjs::canonicalize(), and writes the resolved
 * canonical_url + source + confidence back into the queue file. Idempotent.
 *
 * Usage:
 *   node scripts/canonicalize-queue-rows.mjs --rows=2198,2188,2194
 *   node scripts/canonicalize-queue-rows.mjs --rows=2198 --dry-run
 *
 * Emits NDJSON heartbeat to stderr per row so a watcher can detect hangs.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, isLinkedInJobUrl } from '../lib/jd-url-canonicalizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUEUE_PATH = join(ROOT, 'data', 'apply-now-queue.json');

const ARGS = process.argv.slice(2);
const ROWS_ARG = (ARGS.find(a => a.startsWith('--rows=')) || '').replace('--rows=', '');
const DRY_RUN = ARGS.includes('--dry-run');
const TIMEOUT_MS = Number((ARGS.find(a => a.startsWith('--timeout=')) || '--timeout=30000').replace('--timeout=', ''));

if (!ROWS_ARG) {
  console.error('Usage: node scripts/canonicalize-queue-rows.mjs --rows=NN,NN [--dry-run] [--timeout=30000]');
  process.exit(1);
}

const rowNums = ROWS_ARG.split(',').map(s => s.trim()).filter(Boolean);
if (rowNums.length === 0) {
  console.error('No row numbers parsed from --rows=' + ROWS_ARG);
  process.exit(1);
}

const URL_HEADER_RE = /^\*\*URL:\*\*\s*(\S+)/m;
function urlFromReport(reportRef) {
  if (!reportRef) return '';
  const m = String(reportRef).match(/\((reports\/[^\)]+)\)/);
  if (!m) return '';
  const abs = join(ROOT, m[1]);
  if (!existsSync(abs)) return '';
  try {
    const content = readFileSync(abs, 'utf-8').slice(0, 2000);
    const m2 = content.match(URL_HEADER_RE);
    return (m2 && m2[1] && m2[1] !== '—' && m2[1] !== 'TBD') ? m2[1] : '';
  } catch { return ''; }
}

function logNd(payload) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...payload }) + '\n'); } catch { /* ignore */ }
}

const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf-8'));
// Explicitly-named rows are reachable even when _dropped — the rebuild's
// LinkedIn gate drops rows with reason 'linkedin-url-only-no-canonical' and
// points the operator HERE to recover them, so excluding _dropped rows made
// that recovery path a dead end (2026-07-07 row #2058 incident).
const targets = rowNums.map(num => {
  const row = (queue.ranked || []).find(r => String(r.num) === String(num));
  if (!row) return { num, error: 'row not in apply-now-queue.json' };
  const url = row.url || urlFromReport(row.report);
  if (!url) return { num, error: 'no URL in row or report' };
  return { num, url, row };
});

logNd({ phase: 'plan', total: targets.length, valid: targets.filter(t => !t.error).length });
console.log('Canonicalize plan: ' + targets.length + ' rows');
for (const t of targets) {
  console.log('  #' + t.num + ': ' + (t.error || t.url));
}

if (DRY_RUN) {
  console.log('\n(dry-run — no canonicalize calls, no writes)');
  process.exit(0);
}

console.log('\nRunning canonicalize (timeout ' + TIMEOUT_MS + 'ms per row)...');
let writes = 0;
let resolved = 0;
let expired = 0;
let unresolved = 0;
const report = [];

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  if (t.error) {
    logNd({ phase: 'skip', i, num: t.num, error: t.error });
    report.push({ num: t.num, status: 'skip', error: t.error });
    continue;
  }
  logNd({ phase: 'canonicalize-start', i, num: t.num, url: t.url });
  const r = await canonicalize(t.url, { timeoutMs: TIMEOUT_MS });
  logNd({ phase: 'canonicalize-done', i, num: t.num, source: r.source, conf: r.confidence, canonical: r.canonical, error: r.error });
  console.log('  #' + t.num + ' → ' + r.source + ' (conf=' + r.confidence + ') ' + (r.canonical || r.error || '?'));

  if (r.error && /no longer accepting/i.test(r.error)) {
    expired++;
    report.push({ num: t.num, status: 'expired-at-linkedin', error: r.error, original: t.url });
    continue;
  }
  if (r.canonical && r.confidence >= 0.7) {
    t.row.canonical_url = r.canonical;
    t.row.canonical_source = r.source;
    t.row.canonical_confidence = r.confidence;
    t.row.canonical_resolved_at = new Date().toISOString();
    // Recovery: a LinkedIn wrapper URL must never persist on the row (§12
    // invariant scans url before canonical_url), and a LinkedIn-reason drop
    // is reversed by a successful resolve. Other drop reasons (e.g.
    // status=Discarded) are NOT cleared — canonicalizing must not resurface
    // discarded rows.
    // Shared helper, not an inline regex (2026-07-07 review finding #5): the
    // rebuild's drop gate uses isLinkedInJobUrl(), so recovery must scrub by
    // the SAME predicate or the two drift apart when the helper widens.
    if (t.row.url && isLinkedInJobUrl(t.row.url)) t.row.url = r.canonical;
    if (t.row._dropped && t.row._dropped_reason === 'linkedin-url-only-no-canonical') {
      delete t.row._dropped;
      delete t.row._dropped_at;
      delete t.row._dropped_reason;
      console.log('  #' + t.num + ' recovered from _dropped (linkedin-url-only-no-canonical)');
    }
    writes++;
    resolved++;
    report.push({ num: t.num, status: 'resolved', canonical: r.canonical, source: r.source, confidence: r.confidence });
  } else {
    unresolved++;
    report.push({ num: t.num, status: 'unresolved', error: r.error || 'low-confidence', source: r.source, confidence: r.confidence });
  }
}

if (writes > 0) {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  console.log('\n✓ wrote ' + writes + ' canonical_url updates to ' + QUEUE_PATH);
} else {
  console.log('\n(no canonical URLs resolved at >=0.7 confidence; queue unchanged)');
}

console.log('\nSummary: ' + resolved + ' resolved, ' + expired + ' expired-at-linkedin, ' + unresolved + ' unresolved');

// Write a sidecar report so the orchestrator can pick up + surface to Mitchell.
const reportPath = join(ROOT, 'data', 'canonicalize-queue-rows-' + new Date().toISOString().slice(0, 10) + '.json');
writeFileSync(reportPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  rows: rowNums,
  summary: { total: targets.length, resolved, expired, unresolved, skipped: targets.filter(t => t.error).length },
  results: report,
}, null, 2));
console.log('Sidecar report: ' + reportPath);
