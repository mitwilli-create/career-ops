#!/usr/bin/env node
/**
 * scripts/rescore-row.mjs — single-row re-evaluation shim for the
 * ↻ Re-score button on the dashboard.
 *
 * Looks up row N in data/applications.md, finds its canonical JD URL
 * (Block A "URL:" line in the linked report), and delegates to
 * phase3b-evaluator.mjs with --url + --company + --role + --id.
 * Output (report + tracker TSV + log) is identical to a fresh
 * evaluation — the difference is the trigger (dashboard, not batch).
 *
 * Invocation (matches the rescore endpoint in dashboard-server.mjs:
 *   POST /api/eval/rescore { row: "1509" }
 *   ⇒ spawn: node scripts/rescore-row.mjs --row 1509
 *
 * Manual invoke:
 *   node scripts/rescore-row.mjs --row 1509
 *   node scripts/rescore-row.mjs --row 1509 --dry-run
 *   node scripts/rescore-row.mjs --row 1509 --skip-grok
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ARGS = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const idx = a.indexOf('=');
    if (idx >= 0) return [a.slice(2, idx), a.slice(idx + 1)];
    const next = process.argv[process.argv.indexOf(a) + 1];
    return [a.slice(2), next && !next.startsWith('--') ? next : true];
  }),
);

const row = String(ARGS.row || '').trim();
if (!/^\d+$/.test(row)) {
  console.error('rescore-row: --row must be a positive integer');
  process.exit(2);
}

const applicationsPath = join(ROOT, 'data/applications.md');
if (!existsSync(applicationsPath)) {
  console.error('rescore-row: data/applications.md missing');
  process.exit(2);
}

const tracker = readFileSync(applicationsPath, 'utf-8');
const lineRe = new RegExp('^\\|\\s*' + row + '\\s*\\|\\s*[^|]+\\|\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|.*?\\[(\\d+)\\]\\(reports/([^)]+)\\)', 'm');
const m = tracker.match(lineRe);
if (!m) {
  console.error(`rescore-row: row ${row} not found in data/applications.md`);
  process.exit(2);
}
const [, company, role, reportNum, reportRel] = m;

const reportPath = join(ROOT, 'reports', reportRel);
if (!existsSync(reportPath)) {
  console.error(`rescore-row: report ${reportPath} missing`);
  process.exit(2);
}
const report = readFileSync(reportPath, 'utf-8');
const urlMatch = report.match(/^\*\*URL:\*\*\s*(\S+)/m);
if (!urlMatch) {
  console.error(`rescore-row: no Block A URL in ${reportRel}`);
  process.exit(2);
}
const url = urlMatch[1];

console.log(`[rescore-row] row=${row} company=${company.trim()} role=${role.trim()}`);
console.log(`[rescore-row] url=${url}`);
console.log(`[rescore-row] delegating to phase3b-evaluator.mjs (this re-runs intel + council + citation)...`);

const passthrough = [];
for (const [k, v] of Object.entries(ARGS)) {
  if (k === 'row') continue;
  if (v === true) passthrough.push('--' + k);
  else passthrough.push('--' + k, String(v));
}

const child = spawn(
  process.execPath,
  [
    join(ROOT, 'scripts/phase3b-evaluator.mjs'),
    '--url', url,
    '--company', company.trim(),
    '--role', role.trim(),
    '--id', reportNum,
    ...passthrough,
  ],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RESCORE_TRIGGER: process.env.RESCORE_TRIGGER || 'cli' } },
);

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (err) => {
  console.error(`[rescore-row] spawn error: ${err.message}`);
  process.exit(1);
});
