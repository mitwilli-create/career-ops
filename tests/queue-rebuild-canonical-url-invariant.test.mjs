#!/usr/bin/env node
/**
 * tests/queue-rebuild-canonical-url-invariant.test.mjs
 *
 * 2026-05-29 — Invariant test that fails CI when an apply-now-eligible queue
 * row references an already-canonical ATS report URL but the queue row itself
 * does NOT have `canonical_url` populated. Tripwire for the F4 regression
 * documented in `.claude/audit/2026-05-30/task-audit-2026-05-30.md`.
 *
 * Companion to:
 *   - tests/no-linkedin-urls-invariant.test.mjs (Section 12 of test-all.mjs)
 *   - scripts/rebuild-apply-now-queue.mjs (the writer)
 *   - lib/jd-url-canonicalizer.mjs::classifyUrl + KNOWN_ATS_HOSTS
 *
 * Checks:
 *   1. databricks.com classifies as 'already-canonical' — sanity for the
 *      KNOWN_ATS_HOSTS expansion that closed the F4 ask.
 *   2. For every ranked queue row that is NOT _dropped, whose linked report
 *      file's **URL:** frontmatter is an already-canonical ATS host, the
 *      queue row must have a non-empty `canonical_url`.
 *
 * Exit codes:
 *   0 — clean
 *   2 — invariant violation (prints offending rows + resolution command)
 *
 * Resolution when this fails:
 *   node scripts/rebuild-apply-now-queue.mjs
 *   then re-run this test.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyUrl } from '../lib/jd-url-canonicalizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_PATH = join(ROOT, 'data/applications.md');
const QUEUE_PATH = join(ROOT, 'data/apply-now-queue.json');

let violations = 0;
const printed = [];

// ── 0. Sanity: databricks.com classifies as already-canonical ──────────
const sample = 'https://www.databricks.com/company/careers/open-positions/job?gh_jid=8138138002';
const sampleCls = classifyUrl(sample);
if (sampleCls.type !== 'already-canonical') {
  violations += 1;
  printed.push(`✗ classifyUrl regression — databricks.com URL not recognised as already-canonical (got type=${sampleCls.type})`);
  printed.push(`    Add 'databricks.com' to KNOWN_ATS_HOSTS in lib/jd-url-canonicalizer.mjs`);
}

// ── 1. Queue row canonical_url population invariant ────────────────────
function extractUrlFromReport(reportPath) {
  if (!reportPath) return null;
  const filePath = join(ROOT, reportPath);
  if (!existsSync(filePath)) return null;
  try {
    const head = readFileSync(filePath, 'utf-8').split('\n').slice(0, 60).join('\n');
    const urlMatch = /^\*\*URL:\*\*\s*(\S+)/m.exec(head);
    return urlMatch ? urlMatch[1] : null;
  } catch { return null; }
}

if (existsSync(QUEUE_PATH) && existsSync(APPS_PATH)) {
  let q;
  try { q = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')); }
  catch (e) {
    console.error(`✗ apply-now-queue.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const ranked = Array.isArray(q.ranked) ? q.ranked : [];

  // Load applications.md to get report paths for each queue row's num
  const { parseApplicationsFile } = await import('../lib/parse-applications.mjs');
  const apps = parseApplicationsFile(APPS_PATH);
  const appsByNum = new Map(apps.map(a => [String(a.num), a]));

  const missingCanonical = [];
  for (const qrow of ranked) {
    if (qrow._dropped) continue;
    const app = appsByNum.get(String(qrow.num));
    if (!app) continue;
    const reportUrl = extractUrlFromReport(app.reportPath);
    if (!reportUrl) continue;
    const cls = classifyUrl(reportUrl);
    if (cls.type !== 'already-canonical') continue;
    if (!qrow.canonical_url) {
      missingCanonical.push({ num: qrow.num, company: qrow.company, role: qrow.role, reportUrl, host: cls.host });
    }
  }

  if (missingCanonical.length > 0) {
    violations += missingCanonical.length;
    printed.push(`✗ apply-now-queue.json has ${missingCanonical.length} ranked row(s) with already-canonical report URL but missing canonical_url:`);
    for (const r of missingCanonical.slice(0, 10)) {
      printed.push(`    #${r.num} ${r.company} / ${(r.role || '').slice(0, 50)} — host=${r.host}`);
    }
    if (missingCanonical.length > 10) printed.push(`    … and ${missingCanonical.length - 10} more`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────
if (violations === 0) {
  console.log('✓ databricks.com classifies as already-canonical');
  console.log('✓ all apply-now-eligible ranked rows with already-canonical report URLs have canonical_url populated');
  process.exit(0);
} else {
  console.error(`\nFAIL: ${violations} queue-rebuild canonical_url invariant violation(s):`);
  for (const line of printed) console.error(line);
  console.error(`\nResolve: node scripts/rebuild-apply-now-queue.mjs`);
  console.error(`Then re-run: node tests/queue-rebuild-canonical-url-invariant.test.mjs`);
  process.exit(2);
}
