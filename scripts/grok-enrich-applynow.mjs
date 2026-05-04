#!/usr/bin/env node

/**
 * Run Grok social-intelligence retroactively on every Apply-Now role
 * (score ≥ 4.0, status in {Evaluated, Responded}) that doesn't already
 * have a Grok block in its report. Appends the output as a new
 * `## Social Intelligence (Grok Job #1)` section near the end of each
 * report, right before the Score Global / Final Recommendation.
 *
 * Idempotent — skips reports that already contain a Grok block.
 *
 * Usage:
 *   node scripts/grok-enrich-applynow.mjs           # process all
 *   node scripts/grok-enrich-applynow.mjs --dry-run # show what would run
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

const ROOT = process.cwd();
const APPLICATIONS_PATH = join(ROOT, 'data/applications.md');
const NODE_BIN = process.execPath;
const SCRIPT_PATH = join(ROOT, 'scripts/grok-social-intel.mjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const APPLY_FLOOR = 4.0;

// Load the same secrets file the existing scripts use
const SECRETS_PATH = join(homedir(), '.career-ops-secrets');
const secretsEnv = {};
if (existsSync(SECRETS_PATH)) {
  for (const line of readFileSync(SECRETS_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) secretsEnv[m[1]] = m[2].trim();
  }
}

if (!secretsEnv.XAI_API_KEY) {
  console.error('ERROR: XAI_API_KEY not in ~/.career-ops-secrets');
  process.exit(1);
}

// Parse Apply-Now rows from applications.md
function loadApplyNow() {
  if (!existsSync(APPLICATIONS_PATH)) return [];
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    const num = parseInt(cells[1], 10);
    const company = cells[3];
    const role = cells[4];
    const scoreStr = cells[5] || '';
    const status = cells[6] || '';
    const reportCell = cells[8] || '';
    const score = parseFloat((scoreStr.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const reportPathMatch = reportCell.match(/\(([^)]+)\)/);
    const reportPath = reportPathMatch ? reportPathMatch[1] : '';
    if (!reportPath) continue;
    if (score < APPLY_FLOOR) continue;
    if (!/^(Evaluated|Responded)$/i.test(status)) continue;
    rows.push({ num, company, role, score, status, reportPath });
  }
  return rows;
}

function reportHasGrokBlock(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return false;
  const text = readFileSync(fullPath, 'utf-8');
  return text.includes('## Social Intelligence (Grok Job #1)') ||
         text.includes('## Social Intelligence');
}

function getJdUrlFromReport(reportPath) {
  const fullPath = join(ROOT, reportPath);
  if (!existsSync(fullPath)) return '';
  const text = readFileSync(fullPath, 'utf-8').slice(0, 3000);
  const m = text.match(/\*\*URL:\*\*\s*(\S+)/);
  return m ? m[1] : '';
}

function appendGrokBlock(reportPath, grokMarkdown) {
  const fullPath = join(ROOT, reportPath);
  let text = readFileSync(fullPath, 'utf-8');
  // Insert before "## Score Global" if present, otherwise append at end
  const insertMarker = '\n## Score Global';
  const idx = text.indexOf(insertMarker);
  if (idx === -1) {
    text = text.trimEnd() + '\n\n' + grokMarkdown.trim() + '\n';
  } else {
    text = text.slice(0, idx) + '\n' + grokMarkdown.trim() + '\n' + text.slice(idx);
  }
  writeFileSync(fullPath, text);
}

async function main() {
  const rows = loadApplyNow();
  console.log(`Found ${rows.length} Apply-Now role(s) (score ≥ ${APPLY_FLOOR}, status in {Evaluated, Responded})`);

  const todo = rows.filter(r => !reportHasGrokBlock(r.reportPath));
  const skipped = rows.length - todo.length;
  console.log(`  ${todo.length} need Grok enrichment, ${skipped} already have a Grok block`);
  console.log('');

  if (todo.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    for (const r of todo) {
      console.log(`  [DRY] ${r.company} — ${r.role.slice(0, 60)}  → ${r.reportPath}`);
    }
    console.log(`\nEstimated cost: $${(todo.length * 0.10).toFixed(2)} (capped at $5/day)`);
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (const [i, r] of todo.entries()) {
    const url = getJdUrlFromReport(r.reportPath);
    process.stdout.write(`[${i + 1}/${todo.length}] ${r.company} — ${r.role.slice(0, 50)}…  `);
    const childEnv = { ...process.env, ...secretsEnv };
    const result = spawnSync(NODE_BIN, [
      SCRIPT_PATH,
      `--company=${r.company}`,
      `--role=${r.role}`,
      `--url=${url}`,
    ], { env: childEnv, encoding: 'utf-8', cwd: ROOT, timeout: 120_000 });

    if (result.status !== 0 || !result.stdout) {
      console.log(`✗ FAILED${result.stderr ? ': ' + result.stderr.slice(0, 100) : ''}`);
      failed++;
      continue;
    }
    const output = result.stdout;
    if (output.includes('Status:** Unavailable') || output.length < 200) {
      console.log('✗ unavailable');
      failed++;
      continue;
    }
    appendGrokBlock(r.reportPath, output);
    console.log('✓ enriched');
    succeeded++;
  }

  console.log('');
  console.log(`Summary: ${succeeded} enriched · ${failed} failed`);
  console.log(`Estimated cost: ~$${(succeeded * 0.10).toFixed(2)}`);
  console.log('');
  console.log('Rebuild dashboard to surface the Grok blocks: node scripts/build-dashboard.mjs');
}

main().catch(err => {
  console.error('grok-enrich error:', err.message);
  process.exit(1);
});
