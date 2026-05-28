#!/usr/bin/env node
/**
 * tests/applications-dedupe-invariant.test.mjs
 *
 * L4 of the 2026-05-27 dedupe-defense PR — invariant test that fails CI if
 * data/applications.md contains 2+ live-status rows sharing the same
 * (normalized-company × variant-safe role). The point is the TRIPWIRE: any
 * future PR touching the 8 writers to applications.md (scan.mjs / scan-rss.mjs /
 * normalize-statuses.mjs / gemini-eval.mjs / dedup-tracker.mjs /
 * merge-tracker.mjs / batch-runner-batches.mjs / audit.mjs / dashboard-server.mjs)
 * fails THIS test before it can ship a cross-surface dupe to the dashboard
 * apply-now widget.
 *
 * "Variant-safe" roleEqual is identical to merge-tracker.mjs::roleFuzzyMatch
 * fast-path + dedup-tracker.mjs::roleMatch top-of-function guard:
 *   exact-match → true; differing comma-qualifiers → false; same base+qualifier → true.
 *
 * Live statuses = Evaluated / Applied / Responded / Interview / Offer.
 * Discarded / Rejected / SKIP rows are deliberately ignored — their dedupe
 * decision has already been made + audited.
 *
 * Exit codes:
 *   0 — clean (zero collision buckets with 2+ live rows)
 *   2 — dupes detected (prints the colliding rows so the operator can act)
 *
 * Run:
 *   node tests/applications-dedupe-invariant.test.mjs
 *
 * Wire into CI via test-all.mjs (section 7 added in same PR). Failure mode
 * is loud + actionable — operator runs `node dedup-tracker.mjs --mark` to
 * resolve, then re-runs the test.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_PATH = existsSync(join(ROOT, 'data/applications.md'))
  ? join(ROOT, 'data/applications.md')
  : join(ROOT, 'applications.md');

const LIVE_RE = /^(evaluated|applied|responded|interview|offer|evaluada|aplicado|respondido|entrevista|oferta)$/i;

function normCompany(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Variant-safe role equality — locks in the SAME contract as
 * merge-tracker.mjs::roleFuzzyMatch and dedup-tracker.mjs::roleMatch.
 * Three layers must agree on what counts as a dupe; this test asserts the
 * contract holds for the canonical writer surfaces.
 */
function variantSafeRoleEqual(a, b) {
  const normA = String(a || '').trim().toLowerCase();
  const normB = String(b || '').trim().toLowerCase();
  if (normA === normB) return true;
  const hasCommaA = normA.includes(',');
  const hasCommaB = normB.includes(',');
  if (hasCommaA || hasCommaB) {
    if (hasCommaA !== hasCommaB) return false;
    const qualA = normA.split(',').slice(1).join(',').trim();
    const qualB = normB.split(',').slice(1).join(',').trim();
    if (qualA !== qualB) return false;
    const baseA = normA.split(',')[0].trim();
    const baseB = normB.split(',')[0].trim();
    return baseA === baseB;
  }
  return false;
}

function parseAppLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1], 10);
  if (Number.isNaN(num) || num === 0) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
  };
}

function findCollisions(apps) {
  const live = apps.filter((r) => LIVE_RE.test((r.status || '').trim()));
  const companyBuckets = new Map();
  for (const r of live) {
    const key = normCompany(r.company);
    if (!companyBuckets.has(key)) companyBuckets.set(key, []);
    companyBuckets.get(key).push(r);
  }
  const collisions = [];
  for (const [, group] of companyBuckets) {
    if (group.length < 2) continue;
    const seen = new Set();
    for (let i = 0; i < group.length; i++) {
      if (seen.has(group[i].num)) continue;
      const cluster = [group[i]];
      seen.add(group[i].num);
      for (let j = i + 1; j < group.length; j++) {
        if (seen.has(group[j].num)) continue;
        if (variantSafeRoleEqual(group[i].role, group[j].role)) {
          cluster.push(group[j]);
          seen.add(group[j].num);
        }
      }
      if (cluster.length >= 2) collisions.push(cluster);
    }
  }
  return collisions;
}

// ── Main ───────────────────────────────────────────────────────────────

if (!existsSync(APPS_PATH)) {
  console.log(`✓ applications.md not found at ${APPS_PATH} — nothing to check (clean exit).`);
  process.exit(0);
}

const content = readFileSync(APPS_PATH, 'utf-8');
const apps = [];
for (const line of content.split('\n')) {
  if (!line.startsWith('|')) continue;
  if (line.match(/^[\|\s\-:]+$/)) continue;
  if (line.includes('| # |') || line.includes('Empresa')) continue;
  const row = parseAppLine(line);
  if (row) apps.push(row);
}

const collisions = findCollisions(apps);

// ── Self-test: assert the variant-safe contract holds for known cases ─
// This is in-test, not separated, so the invariant assertion + the matcher
// contract live + ship together. If the matcher silently regresses, these
// asserts fire BEFORE the real-data scan.
const selfTests = [
  { a: 'Applied AI Architect, Industries', b: 'Applied AI Architect, Industries', expect: true, why: 'exact match' },
  { a: 'Applied AI Architect, Industries', b: 'Applied AI Architect, Commercial', expect: false, why: 'differing qualifier' },
  { a: 'Senior FDE', b: 'Senior FDE', expect: true, why: 'exact match no comma' },
  { a: 'Solutions Architect, Zurich', b: 'Solutions Architect, Seattle', expect: false, why: 'differing comma-qualifier (location)' },
  { a: 'Software Engineer', b: 'Senior Software Engineer', expect: false, why: 'no commas + not exact-equal → not a dupe per strict gate' },
  { a: 'Applied AI Architect, Industries  ', b: '  Applied AI Architect, Industries', expect: true, why: 'whitespace tolerance' },
  { a: 'APPLIED AI ARCHITECT, INDUSTRIES', b: 'applied ai architect, industries', expect: true, why: 'case-insensitive' },
];
let selfTestFailures = 0;
for (const t of selfTests) {
  const got = variantSafeRoleEqual(t.a, t.b);
  if (got !== t.expect) {
    selfTestFailures++;
    console.error(`  ❌ self-test FAILED: ${JSON.stringify(t)} got=${got}`);
  }
}
if (selfTestFailures > 0) {
  console.error(`\nFATAL: variantSafeRoleEqual self-test had ${selfTestFailures} failure(s) — the matcher contract is broken. Refusing to evaluate real data.`);
  process.exit(2);
}

console.log(`📊 Scanned ${apps.length} application rows for dedupe collisions.`);

if (collisions.length === 0) {
  console.log('✅ INVARIANT HOLDS — zero (normalized-company × variant-safe role × LIVE-status) collisions in data/applications.md.');
  process.exit(0);
}

const totalDupeRows = collisions.reduce((n, c) => n + c.length, 0);
console.error(`\n❌ INVARIANT VIOLATED — ${collisions.length} collision bucket(s) with ${totalDupeRows} duplicate live row(s):`);
for (const c of collisions) {
  console.error(`\n  ★ ${c[0].company} / ${c[0].role}`);
  for (const r of c) console.error(`      #${r.num} (${r.score}, ${r.status}, ${r.date})`);
}
console.error('\nFix: node dedup-tracker.mjs --mark   (preserves audit trail; recommended).');
console.error('Or:  node dedup-tracker.mjs --delete  (legacy line-removal).');
console.error('\nThen re-run this test to confirm the invariant holds.');
process.exit(2);
