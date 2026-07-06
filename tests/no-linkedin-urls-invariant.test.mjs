#!/usr/bin/env node
/**
 * tests/no-linkedin-urls-invariant.test.mjs
 *
 * 2026-05-29 — Invariant test that fails CI if a LinkedIn job-wrapper URL
 * (`linkedin.com/jobs/view|search/...`) ever lands in:
 *   1. `data/applications.md` — any raw line
 *   2. `data/apply-now-queue.json` — any ranked[] entry's url or canonical_url
 *   3. queue rows whose canonical_url is set but fails the canonical-ATS guard
 *
 * The TRIPWIRE. Any future PR that touches an ingest writer (triage.mjs /
 * merge-tracker.mjs / batch-runner-batches.mjs / rebuild-apply-now-queue.mjs /
 * batch-only-pipeline.mjs / council-048-runner.mjs / phase3b-evaluator.mjs)
 * must keep this test green or surface the regression before merge.
 *
 * Models the cross-surface-dedupe-invariant pattern (AGENTS.md §
 * cross-surface-dedupe-regression).
 *
 * Exit codes:
 *   0 — clean
 *   2 — LinkedIn URL found (prints the offending rows so operator can act)
 *
 * Resolution when this fails:
 *   node scripts/canonicalize-queue-rows.mjs --rows=<N,M,...>
 *   then re-run this test.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isLinkedInJobUrl, classifyUrl } from '../lib/jd-url-canonicalizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_PATH = join(ROOT, 'data/applications.md');
const QUEUE_PATH = join(ROOT, 'data/apply-now-queue.json');

const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/jobs\/(?:view|search)/i;

let violations = 0;
const printed = [];

// ── 1. applications.md — raw grep for linkedin.com/jobs ────────────────
if (existsSync(APPS_PATH)) {
  const apps = readFileSync(APPS_PATH, 'utf8');
  const matches = apps.split('\n').filter(line => LINKEDIN_RE.test(line));
  if (matches.length > 0) {
    violations += matches.length;
    printed.push(`✗ data/applications.md has ${matches.length} line(s) with linkedin.com/jobs/view|search URLs:`);
    for (const m of matches.slice(0, 5)) printed.push('    ' + m.slice(0, 180));
    if (matches.length > 5) printed.push(`    … and ${matches.length - 5} more`);
  }
}

// ── 2. apply-now-queue.json — ranked[] url or canonical_url ────────────
if (existsSync(QUEUE_PATH)) {
  let q;
  try { q = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')); }
  catch (e) {
    console.error(`✗ apply-now-queue.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const ranked = Array.isArray(q.ranked) ? q.ranked : [];

  const linkedinRows = ranked.filter(r => {
    const candidate = r.url || r.canonical_url || '';
    return LINKEDIN_RE.test(candidate);
  });
  if (linkedinRows.length > 0) {
    violations += linkedinRows.length;
    printed.push(`✗ apply-now-queue.json has ${linkedinRows.length} ranked row(s) with a LinkedIn URL:`);
    for (const r of linkedinRows.slice(0, 5)) {
      printed.push(`    #${r.num} ${r.company} / ${(r.role || '').slice(0, 50)} — ${(r.url || r.canonical_url).slice(0, 110)}`);
    }
    if (linkedinRows.length > 5) printed.push(`    … and ${linkedinRows.length - 5} more`);
  }

  // ── 3. canonical_url present but NOT a known-ATS host ────────────────
  const bogusCanonical = ranked.filter(r => {
    if (!r.canonical_url) return false;
    const cls = classifyUrl(r.canonical_url);
    return cls.type !== 'already-canonical';
  });
  if (bogusCanonical.length > 0) {
    violations += bogusCanonical.length;
    printed.push(`✗ apply-now-queue.json has ${bogusCanonical.length} ranked row(s) whose canonical_url is NOT a known-ATS host:`);
    for (const r of bogusCanonical.slice(0, 5)) {
      printed.push(`    #${r.num} ${r.company} — canonical_url=${(r.canonical_url || '').slice(0, 110)}`);
    }
    if (bogusCanonical.length > 5) printed.push(`    … and ${bogusCanonical.length - 5} more`);
  }

  // ── Sanity assertion: isLinkedInJobUrl recognises the canonical pattern ──
  // (Tripwire — if a future refactor breaks the regex, this test catches it.)
  if (!isLinkedInJobUrl('https://www.linkedin.com/jobs/view/4255886677/')) {
    violations += 1;
    printed.push(`✗ isLinkedInJobUrl() regression — failed to recognise canonical LinkedIn job URL`);
  }
  if (isLinkedInJobUrl('https://job-boards.greenhouse.io/anthropic/jobs/5138099008')) {
    violations += 1;
    printed.push(`✗ isLinkedInJobUrl() regression — false-positive on a Greenhouse URL`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────
if (violations === 0) {
  console.log('✓ no LinkedIn URLs in applications.md or apply-now-queue.json');
  console.log('✓ all canonical_url values pass isCanonicalAtsUrl');
  console.log('✓ isLinkedInJobUrl() recognises canonical pattern + rejects Greenhouse');
  process.exit(0);
} else {
  console.error(`\nFAIL: ${violations} LinkedIn-URL invariant violation(s):`);
  for (const line of printed) console.error(line);
  console.error(`\nResolve: node scripts/canonicalize-queue-rows.mjs --rows=<N,M,...>`);
  console.error(`Then re-run: node tests/no-linkedin-urls-invariant.test.mjs`);
  process.exit(2);
}
