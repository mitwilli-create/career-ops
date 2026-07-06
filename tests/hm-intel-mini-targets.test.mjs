#!/usr/bin/env node
/**
 * tests/hm-intel-mini-targets.test.mjs
 *
 * Regression test for the 2026-06-04 ENOENT crash in
 * scripts/populate-hm-intel-mini.mjs::resolveRowTargets (was targetsFromRows).
 *
 * Bug: targeted hm-intel (`--rows`, the path scripts/agents/intel-refresh.mjs
 * shells out to via `--row <N> --slots hm-intel`) hard-read the dated
 * data/queue-gate-audit-<DATE>-pre-enrich.json file to look up company/role/url
 * for the requested nums. That file is ONLY produced by the nightly gate, so
 * every manual / intel-refresh-driven hm-intel run crashed ENOENT (exit 2)
 * while role-enrichment in the same run succeeded — a silent targeted failure.
 *
 * Fix: resolveRowTargets resolves num → {company, role, url} from canonical
 * sources (apply-now-queue.json / applications.md), using the audit file ONLY
 * when present (graceful degradation). These cases pin the regression: with NO
 * audit file present, an explicit --rows list still resolves to write targets
 * instead of throwing — and unresolvable nums are skipped, not fatal.
 *
 * $0 — pure fixtures, no LLM, no network. Exits 1 on any failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRowTargets, parseArgs } from '../scripts/populate-hm-intel-mini.mjs';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); }
}

// --- fixture root (no real data touched) ---
const root = mkdtempSync(join(tmpdir(), 'hm-intel-mini-targets-'));
mkdirSync(join(root, 'data'), { recursive: true });

const queue = {
  ranked: [
    { num: 2722, company: 'Anthropic', role: 'Internal Communications Manager, Policy',
      canonical_url: 'https://job-boards.greenhouse.io/anthropic/jobs/5147350008' },
    { num: 2726, company: 'OpenAI', role: 'Developer Education Lead',
      url: 'https://openai.com/careers/developer-education-lead-san-francisco/' },
    { num: 999, company: 'Unknown', role: 'Mystery Role' }, // must be filtered (company === 'Unknown')
    { num: 7777, company: 'Anthropic', role: 'Senior Staff Forward Deployed Solutions Architect Enablement Engineering Lead' }, // >60-char role slug
  ],
};
writeFileSync(join(root, 'data', 'apply-now-queue.json'), JSON.stringify(queue), 'utf-8');

// applications.md row NOT in the queue (aged out) — exercises source-3 fallback.
const appsMd = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1500 | 2026-05-01 | Cohere | Solutions Architect | 4.2 | Evaluated | ✅ | [1500](reports/1500-cohere.md) | aged out |',
].join('\n');
writeFileSync(join(root, 'data', 'applications.md'), appsMd, 'utf-8');

// Point auditPath at a non-existent file — THE regression scenario.
const missingAudit = join(root, 'data', 'queue-gate-audit-9999-99-99-pre-enrich.json');
ok(!existsSync(missingAudit), 'precondition: audit file is absent');

try {
  // === C1 — the exact bug: audit absent, --rows resolves from queue (no throw) ===
  const t1 = resolveRowTargets('2722,2726', { root, auditPath: missingAudit });
  ok(Array.isArray(t1) && t1.length === 2, 'C1: 2 targets resolved from queue with audit absent (was ENOENT crash)');
  const t2722 = t1.find(t => String(t.num) === '2722');
  ok(!!t2722, 'C1: row 2722 present');
  ok(t2722 && t2722.company === 'Anthropic', 'C1: 2722 company resolved');
  ok(t2722 && t2722.slug === 'anthropic-internal-communications-manager-policy', 'C1: 2722 slug correct');
  ok(t2722 && t2722.hmPath === join(root, 'data', 'hm-intel', 'anthropic-internal-communications-manager-policy.json'),
     'C1: 2722 hmPath → data/hm-intel/<company-slug>-<role-slug>.json');
  ok(t2722 && t2722.url === 'https://job-boards.greenhouse.io/anthropic/jobs/5147350008', 'C1: 2722 url from canonical_url');
  const t2726 = t1.find(t => String(t.num) === '2726');
  ok(t2726 && t2726.url === 'https://openai.com/careers/developer-education-lead-san-francisco/', 'C1: 2726 url from url field');

  // === C2 — unresolved num is skipped, not thrown ===
  const t2 = resolveRowTargets('2722,8888', { root, auditPath: missingAudit });
  ok(t2.length === 1 && String(t2[0].num) === '2722', 'C2: unknown num 8888 skipped, 2722 still resolved (no throw)');

  // === C3 — 'Unknown' company filtered out ===
  const t3 = resolveRowTargets('999', { root, auditPath: missingAudit });
  ok(t3.length === 0, "C3: company 'Unknown' is filtered (not a valid target)");

  // === C4 — applications.md fallback for a row not in the queue ===
  const t4 = resolveRowTargets('1500', { root, auditPath: missingAudit });
  ok(t4.length === 1 && t4[0].company === 'Cohere' && t4[0].role === 'Solutions Architect',
     'C4: row aged out of queue resolved from applications.md (source 3)');

  // === C5 — audit file present takes precedence + still works ===
  const audit = { auto_enrich: [{ num: 2722, company: 'Anthropic', role: 'Internal Communications Manager, Policy', url: 'https://audit.example/2722' }], pass: [] };
  const auditPresent = join(root, 'data', 'queue-gate-audit-present-pre-enrich.json');
  writeFileSync(auditPresent, JSON.stringify(audit), 'utf-8');
  const t5 = resolveRowTargets('2722', { root, auditPath: auditPresent });
  ok(t5.length === 1 && t5[0].url === 'https://audit.example/2722', 'C5: audit file (when present) is the precedence source');

  // === C6 — empty / whitespace rows arg → [] (no throw) ===
  ok(resolveRowTargets('', { root, auditPath: missingAudit }).length === 0, 'C6: empty rows arg → [] (no throw)');
  ok(resolveRowTargets('  ,  ', { root, auditPath: missingAudit }).length === 0, 'C6: whitespace-only rows arg → [] (no throw)');

  // === C7 — arg parser handles the SPACE form intel-refresh actually uses ===
  // (`--rows <num>`), the equals form, and bare boolean flags. Was the second,
  // stacked bug: --rows 2722 (space) parsed to boolean `true`, dropping the num.
  ok(parseArgs(['--rows', '2722']).rows === '2722', 'C7: --rows 2722 (space form = intel-refresh:227 invocation) captures the value');
  ok(parseArgs(['--rows=2722']).rows === '2722', 'C7: --rows=2722 (equals form) captures the value');
  ok(parseArgs(['--rows', '2722,2723', '--dry-run']).rows === '2722,2723', 'C7: space value followed by a trailing boolean flag');
  ok(parseArgs(['--dry-run']).rows === undefined && parseArgs(['--dry-run'])['dry-run'] === true, 'C7: bare --dry-run is boolean true');
  ok(parseArgs(['--from-audit=data/x.json'])['from-audit'] === 'data/x.json', 'C7: --from-audit=path (equals) preserved');
  ok(parseArgs(['--max-cost-usd', '50'])['max-cost-usd'] === '50', 'C7: --max-cost-usd 50 (space) captured (was Number(true)=1)');

  // === C8 — long role slug truncated to 60/field (matches canonical reader lib/intel-refresh-state.mjs) ===
  // Closes the slug-truncation-contract-drift for hm-intel: the writer must land on the
  // same data/hm-intel/<slug60>.json path the dashboard + parent verifier read.
  const t8 = resolveRowTargets('7777', { root, auditPath: missingAudit });
  ok(t8.length === 1, 'C8: long-role row (7777) resolves');
  const roleSlug8 = t8[0] ? t8[0].slug.slice('anthropic-'.length) : '';
  ok(roleSlug8.length === 60, `C8: role slug truncated to 60 (got ${roleSlug8.length}) — writer agrees with canonical reader`);
  ok(t8[0] && t8[0].hmPath.endsWith(`${t8[0].slug}.json`), 'C8: hmPath uses the truncated slug');
} catch (e) {
  fail++;
  console.error(`  ✗ UNEXPECTED THROW: ${e.stack || e.message}`);
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\nhm-intel-mini-targets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
