#!/usr/bin/env node
/**
 * tests/slug-contract-il-hc.test.mjs
 *
 * Locks the interview-likelihood (il) + hm-chance (hc) artifact slug contract:
 *
 *     writer-slug  ===  verifier-slug  ===  reader-slug
 *
 * for a LONG-TITLED role whose role-slug exceeds 60 chars. This is the exact
 * fixture that surfaced the 2026-06-01 incident:
 *
 *   Amazon (AWS) — "Senior Applied AI Solutions Architect, Amazon Connect,
 *                   AWS Applied AI Solutions"  (apply-now row #2708)
 *
 * Three surfaces compute the slug that addresses
 * data/interview-likelihood/<slug>.json and data/hm-chance/<slug>.json:
 *
 *   1. WRITER   — scripts/agents/interview-likelihood.mjs + hm-chance.mjs
 *                 resolve the row via scripts/lib/row-resolver.mjs::resolveRow,
 *                 which returns `match.slug || buildSlug(num, company, role)`.
 *                 buildSlug per-field slugify uses .slice(0, 80).
 *   2. VERIFIER — scripts/agents/intel-refresh.mjs refreshInterviewLikelihood /
 *                 refreshHmChance compute `target` to confirm the child script
 *                 actually wrote disk. PRE-FIX used a local slugify() ending in
 *                 .slice(0, 60) → truncated long role slugs → false
 *                 "no-disk-artifact-after-exit-0" negatives. POST-FIX uses
 *                 `row.slug || buildSlug(...)` — the same row-resolver function.
 *   3. READER   — dashboard-server.mjs /api/intel-chips, /api/interview-
 *                 likelihood, /api/hm-chance resolve ?row=N. PRE-FIX only via an
 *                 apply-pack dir lookup (404 for rows like #2708 with no pack).
 *                 POST-FIX falls back to resolveRow(N).slug — buildSlug again.
 *
 * If any surface re-introduces a per-field truncation < the role-slug length,
 * this test fails on the >60-char fixture.
 *
 * Bug class: slug-truncation-contract-drift-writer-verifier-reader.
 *
 * Pure / deterministic — no LLM, no network, no live-queue dependency for the
 * formula assertions. Usage: node tests/slug-contract-il-hc.test.mjs
 * Exit: 0 on pass, 1 on any failure.
 */

import { buildSlug, slugify } from '../scripts/lib/row-resolver.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

// ── The canonical long-titled fixture (apply-now row #2708) ──────────────────
const FIX = {
  num: 2708,
  company: 'Amazon (AWS)',
  role: 'Senior Applied AI Solutions Architect, Amazon Connect, AWS Applied AI Solutions',
};
// The literal on-disk filename the il writer produced for this row (the ground
// truth this whole contract must address).
const ON_DISK = '2708-amazon-aws-senior-applied-ai-solutions-architect-amazon-connect-aws-applied-ai-solutions';

console.log('slug-contract-il-hc — long-titled fixture (#2708 Amazon AWS)');

// 0) Sanity: this fixture's role slug really is > 60 chars (else it would not
//    exercise the truncation bug at all).
const roleSlug = slugify(FIX.role);
ok(roleSlug.length > 60, `role-slug is > 60 chars (got ${roleSlug.length}) — exercises the bug`);

// 1) WRITER slug — what resolveRow → buildSlug produces (no stored slug → buildSlug).
const writerSlug = FIX.slug || buildSlug(FIX.num, FIX.company, FIX.role);
ok(writerSlug === ON_DISK, `writer slug === on-disk filename (${writerSlug})`);

// 2) VERIFIER slug — the POST-FIX expression in intel-refresh.mjs
//    refreshInterviewLikelihood / refreshHmChance: `row.slug || buildSlug(...)`.
const verifierSlug = FIX.slug || buildSlug(FIX.num, FIX.company, FIX.role);
ok(verifierSlug === writerSlug, 'verifier slug === writer slug');

// 3) READER slug — the POST-FIX dashboard-server fallback: resolveRow(N).slug,
//    which is `match.slug || buildSlug(...)`. Replicated here against the same
//    (num, company, role) so the contract is asserted independent of live queue.
const readerSlug = FIX.slug || buildSlug(FIX.num, FIX.company, FIX.role);
ok(readerSlug === writerSlug, 'reader slug === writer slug');

// 4) The decisive three-way identity.
ok(
  writerSlug === verifierSlug && verifierSlug === readerSlug,
  'writer === verifier === reader (three-way slug contract holds)',
);

// 5) Regression guard — the PRE-FIX slice-60 formula MUST diverge on this
//    fixture. If a future edit re-introduces .slice(0, 60) per field, the
//    verifier/reader would look for a truncated path the writer never wrote.
const slug60 = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const truncatedSlug = `${String(FIX.num).padStart(3, '0')}-${slug60(FIX.company)}-${slug60(FIX.role)}`;
ok(truncatedSlug !== writerSlug, `slice-60 formula diverges from canonical (would 404): ${truncatedSlug}`);

// 6) Source-wiring asserts — the three surfaces must route through row-resolver,
//    not re-derive a private slug. Cheap grep over committed source.
function src(p) { try { return readFileSync(join(ROOT, p), 'utf-8'); } catch { return ''; } }

const intelRefresh = src('scripts/agents/intel-refresh.mjs');
ok(/import\s*\{[^}]*\bbuildSlug\b[^}]*\}\s*from\s*['"]\.\.\/lib\/row-resolver\.mjs['"]/.test(intelRefresh),
  'intel-refresh.mjs imports buildSlug from row-resolver');
ok(intelRefresh.includes('row.slug || buildSlug(row.num, row.company, row.role)'),
  'intel-refresh.mjs il/hc slots use canonical buildSlug (not slice-60 slugify)');

const server = src('dashboard-server.mjs');
ok(/import\s*\{[^}]*\bresolveRow\b[^}]*\}\s*from\s*['"]\.\/scripts\/lib\/row-resolver\.mjs['"]/.test(server),
  'dashboard-server.mjs imports resolveRow from row-resolver');
// One fallback per reader endpoint (intel-chips, interview-likelihood, hm-chance).
const fallbackCount = (server.match(/resolveRow\(rowParam\)/g) || []).length;
ok(fallbackCount >= 3, `dashboard-server.mjs has resolveRow(rowParam) fallback in all 3 reader endpoints (found ${fallbackCount})`);

console.log(`\nslug-contract-il-hc: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
