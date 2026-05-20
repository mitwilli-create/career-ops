#!/usr/bin/env node
/**
 * scripts/a11y-audit.mjs — accessibility audit gate
 *
 * Runs axe-core (WCAG 2.1 AA) against the three top-level dashboard
 * surfaces × three viewport widths. Filters to AA-level serious +
 * critical violations (impact: 'serious' or 'critical' at WCAG-AA tags).
 *
 * Usage:
 *   node scripts/a11y-audit.mjs                          # against staging
 *   node scripts/a11y-audit.mjs --base http://localhost:3097   # local
 *   node scripts/a11y-audit.mjs --json data/path.json    # custom output
 *
 * Output:
 *   - data/bravo-followup-a11y-audit-2026-05-20.json     (full report)
 *   - stdout summary table
 *   - Exit code 0 if zero violations on all surface × width combos, 1 otherwise
 *
 * Wired into CI via .github/workflows/a11y-audit.yml (matches existing
 * test-all.mjs CI pattern: a separate job that gates merges).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');

// ─── CLI parsing ──────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
function arg(name, fallback) {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : fallback;
}
const BASE = arg('base', 'https://staging-dashboard.careers-ops.com');
const OUT_JSON = arg('json', join(REPO_ROOT, 'data/bravo-followup-a11y-audit-2026-05-20.json'));

// ─── Surface × width matrix ───────────────────────────────────────────────────
const SURFACES = [
  { name: 'home',         path: '/' },
  { name: 'contacts',     path: '/contacts.html' },
  { name: 'network-db',   path: '/network-database.html' },
];
const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet',  width: 720,  height: 1024 },
  { name: 'mobile',  width: 360,  height: 740 },
];

// Tags that map to WCAG 2.1 Level AA in axe-core
const AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
// Per axe-core docs, the `impact` field is one of: minor, moderate, serious, critical.
const SEVERITY_FAIL = new Set(['serious', 'critical']);

// ─── Audit one surface × width ────────────────────────────────────────────────
async function auditOne(browser, surface, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const url = `${BASE}${surface.path}`;

  try {
    // The home dashboard has long-lived SSE/fetch traffic so `networkidle`
    // never settles within 30s — use `domcontentloaded` and rely on the
    // explicit settle below instead.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    await context.close();
    return { surface: surface.name, viewport: viewport.name, width: viewport.width, error: `nav: ${e.message}`, violations: [], violationCount: 0 };
  }

  // Give dynamic content a moment to settle (contacts.html fetches the JSON
  // payload async; network-database.html hits /api/network/preview; home
  // dashboard has data-pill lazy-fetch). 4s is empirically the right amount.
  await page.waitForTimeout(4000);

  const results = await new AxeBuilder({ page })
    .withTags(AA_TAGS)
    .analyze()
    .catch(e => ({ violations: [], _err: e.message }));

  await context.close();

  // Filter to AA-level + serious/critical only (per audit spec).
  const violations = (results.violations || [])
    .filter(v => SEVERITY_FAIL.has(v.impact))
    .map(v => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: (v.nodes || []).slice(0, 5).map(n => ({
        target: n.target,
        html: (n.html || '').slice(0, 200),
        failureSummary: n.failureSummary || '',
      })),
      nodeCount: (v.nodes || []).length,
    }));

  return {
    surface: surface.name,
    url,
    viewport: viewport.name,
    width: viewport.width,
    violationCount: violations.length,
    violations,
    error: results._err || null,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[a11y-audit] target: ${BASE}`);
  console.log(`[a11y-audit] matrix: ${SURFACES.length} surface(s) × ${WIDTHS.length} width(s) = ${SURFACES.length * WIDTHS.length} runs`);

  const browser = await chromium.launch({ headless: true });
  const runs = [];
  for (const surface of SURFACES) {
    for (const viewport of WIDTHS) {
      const t0 = Date.now();
      const r = await auditOne(browser, surface, viewport);
      r.duration_ms = Date.now() - t0;
      runs.push(r);
      const tag = r.error ? `ERR ${r.error}` : `${r.violationCount} violation(s)`;
      console.log(`  [${r.surface} / ${r.viewport} (${r.width}px)] ${tag} (${r.duration_ms}ms)`);
    }
  }
  await browser.close();

  // ─── Aggregate ──────────────────────────────────────────────────────────────
  const totalViolations = runs.reduce((sum, r) => sum + (r.violationCount || 0), 0);
  const uniqueRules = new Set();
  for (const r of runs) for (const v of r.violations) uniqueRules.add(v.id);

  // Top-3 violation rules across the matrix (by hit count)
  const ruleCounts = new Map();
  for (const r of runs) {
    for (const v of r.violations) {
      ruleCounts.set(v.id, (ruleCounts.get(v.id) || 0) + 1);
    }
  }
  const topRules = Array.from(ruleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const report = {
    base_url: BASE,
    ran_at: new Date().toISOString(),
    matrix: { surfaces: SURFACES.length, widths: WIDTHS.length, runs: runs.length },
    total_violations: totalViolations,
    unique_rule_count: uniqueRules.size,
    top_rules: topRules.map(([id, count]) => ({ id, hit_count: count })),
    runs,
  };

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log(`\n[a11y-audit] wrote ${OUT_JSON}`);
  console.log(`[a11y-audit] total violations: ${totalViolations} across ${uniqueRules.size} unique rule(s)`);
  if (topRules.length) {
    console.log(`[a11y-audit] top rules:`);
    for (const [id, count] of topRules) console.log(`  - ${id} (${count}x)`);
  }

  const exitCode = totalViolations === 0 ? 0 : 1;
  console.log(`\n[a11y-audit] exit ${exitCode}: ${exitCode === 0 ? 'OK (zero AA violations)' : 'FAIL (AA violations present — see report)'}\n`);
  process.exit(exitCode);
}

main().catch(e => {
  console.error(`[a11y-audit] fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(2);
});
