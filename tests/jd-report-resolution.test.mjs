#!/usr/bin/env node
/**
 * tests/jd-report-resolution.test.mjs
 *
 * INVARIANT: scripts/jd-keyword-score.mjs resolves a pack's eval report by
 * ROLE SLUG (or the applications.md report-link column) — NEVER by bare
 * numeric prefix. Report numbers and tracker row numbers are INDEPENDENT num
 * spaces (AGENTS.md § "Two num spaces").
 *
 * Born 2026-06-10: pack 2729-lovable-* matched reports/ by its leading "2729"
 * and read report #2729 (Perplexity, a different role) instead of the Lovable
 * row's actual report #2730 — keyword-alignment.md then scored every artifact
 * against the WRONG JD ("perplexity" ranked JD top term #2 ×22).
 *
 * Pure-fixture tests (mkdtemp root) — no personal data, CI-safe, $0.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEvalReport } from '../scripts/jd-keyword-score.mjs';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-resolve-'));
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });

const REPORTS = [
  '2729-perplexity-product-manager-builder-2026-06-04.md',          // num-collision decoy
  '2730-lovable-product-and-technical-communications-2026-06-10.md', // the real report
  '2650-lovable-product-and-technical-communications-2026-05-20.md', // older re-eval, same role
  '2741-anthropic-applied-ai-architect-industries-2026-06-08.md',
  '2742-anthropic-applied-ai-architect-commercial-2026-06-08.md',
  '2500-other-co-writer-2026-01-01.md',
];
for (const f of REPORTS) fs.writeFileSync(path.join(root, 'reports', f), `# ${f}\n`);

fs.writeFileSync(path.join(root, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 2729 | 2026-06-10 | Lovable | Product and Technical Communications | 4.2/5 | Evaluated | ❌ | [2730](reports/2730-lovable-product-and-technical-communications-2026-06-10.md) | note |
| 100 | 2026-06-08 | Anthropic | Applied AI Architect, Industries | 4.5/5 | Evaluated | ❌ | [2741](reports/2741-anthropic-applied-ai-architect-industries-2026-06-08.md) | note |
| 500 | 2026-01-01 | Acme | Writer | 4.0/5 | Evaluated | ❌ | [2500](reports/2500-other-co-writer-2026-01-01.md) | wrong-company link |
`);

console.log('jd-report-resolution — resolveEvalReport unit tests (fixture root)');

// 1. THE regression: pack num 2729 must resolve to the Lovable report (#2730),
//    not the Perplexity report that shares the bare numeric prefix.
const r1 = resolveEvalReport('2729-lovable-product-and-technical-communications', { root });
check('canonical: resolves by slug, not num prefix',
  r1?.path === path.join('reports', '2730-lovable-product-and-technical-communications-2026-06-10.md'),
  JSON.stringify(r1));
check('canonical: never the same-num different-role report',
  r1 && !r1.path.includes('perplexity'), JSON.stringify(r1));
check('canonical: via slug-match', r1?.via === 'slug-match');

// 2. Same role re-evaluated → newest report wins.
check('same-slug re-eval picks newest date',
  r1?.path.endsWith('2026-06-10.md'), JSON.stringify(r1));

// 3. Truncated pack slug spanning two sibling roles must NOT guess between
//    them — it falls through to the applications.md report-link column.
const r3 = resolveEvalReport('100-anthropic-applied-ai-architect', { root });
check('ambiguous prefix falls to applications.md report link',
  r3?.via === 'applications-md-report-link' && r3.path.includes('industries'),
  JSON.stringify(r3));

// 4. applications.md link guarded by company-token sanity: row 500 links a
//    report whose filename has no "acme" → reject (num-space collision guard).
const r4 = resolveEvalReport('500-acme-writer', { root });
check('report-link rejected when company token mismatches (num-space guard)', r4 === null, JSON.stringify(r4));

// 5. Unknown role → null (caller falls back to grok-intel/README or errors).
check('no match → null', resolveEvalReport('999-nonexistent-role-slug-here', { root }) === null);

// 6. Unique truncated prefix (single role) still resolves.
const r6 = resolveEvalReport('42-lovable-product-and-technical', { root });
check('unique prefix tolerance resolves', r6?.path.includes('lovable'), JSON.stringify(r6));

fs.rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ FAIL — ${failures} resolution check(s) failed.`);
  process.exit(1);
}
console.log('\n✓ PASS — eval-report resolution never crosses num spaces.');
process.exit(0);
