#!/usr/bin/env node
/**
 * scripts/audit-field-binding.mjs — Pattern X2 enforcement
 *
 * Detects "pipeline-scan-to-drawer-rendering-gap" (Pattern X2 in
 * ~/.claude/knowledge/brain/bug-class-catalog.md). For each apply-now row,
 * compares fields present in raw data sources (hm-intel, role-enrichment,
 * company-pulse) against fields read by build-dashboard.mjs. Flags fields
 * that exist in source but aren't bound to a drawer surface.
 *
 * Output:
 *   data/field-binding-audit-{date}.json — full report
 *   data/field-alias-map.json — empty/template if absent; updated otherwise
 *
 * Exit codes:
 *   0 — no rendering gaps found (or all are in the alias map exclusion list)
 *   1 — rendering gaps detected
 *
 * Usage:
 *   node scripts/audit-field-binding.mjs
 *   node scripts/audit-field-binding.mjs --threshold=5  (warn if N+ gaps)
 *   node scripts/audit-field-binding.mjs --update-map   (regenerate alias map)
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);

const args = process.argv.slice(2);
const THRESHOLD = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] || '0');
const UPDATE_MAP = args.includes('--update-map');

// ── Collect all fields read by build-dashboard.mjs ──────────────────────
function fieldsReadByBuildDashboard() {
  const src = readFileSync(join(ROOT, 'scripts/build-dashboard.mjs'), 'utf8');
  const fields = new Set();

  // Match patterns: `r.field`, `enrich.field`, `intel.field`, `cp.field`, etc.
  // Conservative: only capture single-token field reads after a known prefix.
  const prefixes = ['r', 'enrich', 'intel', 'cp', 'hi', 'th', 'role', 'company', 'data', 'd'];
  for (const p of prefixes) {
    const re = new RegExp(`\\b${p}\\.([a-z_][a-zA-Z0-9_]*)\\b`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      fields.add(m[1]);
    }
  }

  // Also capture optional-chain reads: r?.foo
  const optRe = /\b\w+\?\.([a-z_][a-zA-Z0-9_]*)\b/g;
  let m;
  while ((m = optRe.exec(src)) !== null) {
    fields.add(m[1]);
  }

  return fields;
}

// ── Collect all field names in a directory of JSON files ────────────────
function fieldsInDir(dir, sampleSize = 10) {
  if (!existsSync(dir)) return new Map();
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).slice(0, sampleSize);
  const fieldCounts = new Map();
  for (const f of files) {
    try {
      const obj = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (typeof obj === 'object' && obj !== null) {
        for (const k of Object.keys(obj)) {
          fieldCounts.set(k, (fieldCounts.get(k) || 0) + 1);
        }
      }
    } catch { /* skip malformed */ }
  }
  return fieldCounts;
}

// ── Load or create alias map ─────────────────────────────────────────────
const aliasMapPath = join(ROOT, 'data/field-alias-map.json');
let aliasMap = {};
if (existsSync(aliasMapPath)) {
  try {
    aliasMap = JSON.parse(readFileSync(aliasMapPath, 'utf8'));
  } catch { aliasMap = {}; }
}

// ── Run audit ────────────────────────────────────────────────────────────
const dashboardFields = fieldsReadByBuildDashboard();
console.log(`build-dashboard.mjs reads ${dashboardFields.size} distinct fields`);

const sources = {
  'data/hm-intel': fieldsInDir(join(ROOT, 'data/hm-intel')),
  'data/role-enrichment': fieldsInDir(join(ROOT, 'data/role-enrichment')),
  'data/company-pulse': fieldsInDir(join(ROOT, 'data/company-pulse')),
  'data/team-health': fieldsInDir(join(ROOT, 'data/team-health')),
  'data/interview-likelihood': fieldsInDir(join(ROOT, 'data/interview-likelihood')),
  'data/hm-chance': fieldsInDir(join(ROOT, 'data/hm-chance')),
};

const gaps = [];
const findings = {};

for (const [srcName, fieldCounts] of Object.entries(sources)) {
  findings[srcName] = {
    field_count: fieldCounts.size,
    fields: [...fieldCounts.entries()].map(([k, v]) => ({ name: k, coverage: v })),
    unbound: [],
  };
  for (const [field, count] of fieldCounts.entries()) {
    // Skip if field is in alias map (means we know it's intentionally not rendered or aliased)
    if (aliasMap[field]) continue;
    if (!dashboardFields.has(field)) {
      // Field present in source but not read by dashboard
      const gap = { source: srcName, field, coverage: count };
      findings[srcName].unbound.push(gap);
      gaps.push(gap);
    }
  }
}

// ── Write report ─────────────────────────────────────────────────────────
const report = {
  generated_at: NOW,
  pattern: 'X2: pipeline-scan-to-drawer-rendering-gap',
  dashboard_field_count: dashboardFields.size,
  alias_map_entries: Object.keys(aliasMap).length,
  total_gaps: gaps.length,
  threshold: THRESHOLD,
  exit_code: gaps.length > THRESHOLD ? 1 : 0,
  findings,
};

const reportPath = join(ROOT, `data/field-binding-audit-${TODAY}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Wrote ${reportPath}`);

// ── Optionally update alias map with newly-seen fields ──────────────────
if (UPDATE_MAP) {
  const newAliasMap = { ...aliasMap };
  for (const gap of gaps) {
    if (!newAliasMap[gap.field]) {
      newAliasMap[gap.field] = {
        intent: 'unmapped',
        note: 'auto-added by audit-field-binding.mjs — categorize as RENDER (bind to drawer), EXCLUDE (skip render), or RENAME (rename in source/template)',
        first_seen: TODAY,
        seen_in: [gap.source],
      };
    } else if (!newAliasMap[gap.field].seen_in?.includes(gap.source)) {
      newAliasMap[gap.field].seen_in = [...(newAliasMap[gap.field].seen_in || []), gap.source];
    }
  }
  writeFileSync(aliasMapPath, JSON.stringify(newAliasMap, null, 2));
  console.log(`Updated ${aliasMapPath} (${Object.keys(newAliasMap).length} entries)`);
}

// ── Print summary ────────────────────────────────────────────────────────
console.log('\n=== SUMMARY ===');
console.log(`Total field-binding gaps: ${gaps.length}`);
console.log(`Threshold (warn above): ${THRESHOLD}`);
console.log(`Alias map entries: ${Object.keys(aliasMap).length}`);
console.log('');
console.log('Per-source breakdown:');
for (const [srcName, finding] of Object.entries(findings)) {
  console.log(`  ${srcName}: ${finding.field_count} fields, ${finding.unbound.length} unbound`);
}

if (gaps.length > 0) {
  console.log('\nTop unbound fields (potential rendering gaps):');
  const byCount = [...gaps].sort((a, b) => b.coverage - a.coverage).slice(0, 15);
  for (const g of byCount) {
    console.log(`  [${g.source.split('/')[1]}] ${g.field} (coverage: ${g.coverage})`);
  }
}

if (gaps.length > THRESHOLD) {
  console.log(`\n⚠️  ${gaps.length} gaps exceed threshold ${THRESHOLD} — exit 1`);
  process.exit(1);
}
console.log(`\n✓ Within threshold — exit 0`);
process.exit(0);
