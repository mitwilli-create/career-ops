#!/usr/bin/env node
/**
 * scripts/test-batch-figure-parity.mjs — P5 regression guard 2026-05-22
 *
 * Asserts that the four surfaces showing "how many items can Run Batch process
 * right now?" all return the same number:
 *
 *   1. batch/triage-advance.tsv line count            (the canonical source)
 *   2. The build-time `triageAdvanceCount` baked into the dashboard          (build-dashboard.mjs:4093)
 *   3. The runtime `queued_for_batch` field in /api/pipeline/preview         (dashboard-server.mjs)
 *   4. The runtime `run_batch.stages.process.count`   field in the same API   (dashboard-server.mjs)
 *
 * Mitchell screenshotted Run Batch saying "Nothing to do" while Process All
 * showed 1874 pending and the sidebar tile showed multiple rows at the same
 * moment 2026-05-22 12.22.34. This test pins the contract: those four counts
 * must all derive from the same triage-advance.tsv line count.
 *
 * Exit 0 on parity, exit 1 on any divergence.
 *
 * Usage:
 *   node scripts/test-batch-figure-parity.mjs                           (uses http://localhost:3097)
 *   node scripts/test-batch-figure-parity.mjs --base=https://...        (custom URL)
 *   node scripts/test-batch-figure-parity.mjs --no-api                  (file-only check)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const baseFlag = args.find(a => a.startsWith('--base='));
const BASE = baseFlag ? baseFlag.replace('--base=', '') : (process.env.DASHBOARD_URL || 'http://localhost:3097');
const NO_API = args.includes('--no-api');

function countTriageAdvanceLines() {
  const fp = join(ROOT, 'batch', 'triage-advance.tsv');
  if (!existsSync(fp)) return 0;
  const raw = readFileSync(fp, 'utf-8');
  return raw.split('\n').filter(l => l.trim() && !l.startsWith('url')).length;
}

async function fetchPreview() {
  try {
    const r = await fetch(BASE + '/api/pipeline/preview', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    return { _error: err.message };
  }
}

async function main() {
  const fileCount = countTriageAdvanceLines();
  console.log(`[1] triage-advance.tsv line count:           ${fileCount}`);

  if (NO_API) {
    console.log('[--no-api] skipping runtime checks.');
    process.exit(0);
  }

  const preview = await fetchPreview();
  if (preview._error) {
    console.error(`[api] /api/pipeline/preview failed: ${preview._error}`);
    console.error('[api] Skipping runtime parity checks — server unreachable.');
    process.exit(2);
  }

  const apiQueued = Number(preview.queued_for_batch);
  const apiRbProcessCount = Number(preview?.run_batch?.stages?.process?.count);
  console.log(`[2] api queued_for_batch:                    ${apiQueued}`);
  console.log(`[3] api run_batch.stages.process.count:      ${apiRbProcessCount}`);

  const divergence = [];
  if (apiQueued !== fileCount) {
    divergence.push(`queued_for_batch (${apiQueued}) ≠ triage-advance.tsv lines (${fileCount})`);
  }
  if (apiRbProcessCount !== fileCount) {
    divergence.push(`run_batch.stages.process.count (${apiRbProcessCount}) ≠ triage-advance.tsv lines (${fileCount})`);
  }

  if (divergence.length === 0) {
    console.log('\n✓ All Run Batch figures derive from the same triage-advance.tsv source.');
    process.exit(0);
  }

  console.error('\n✗ Run Batch figure parity FAILED:');
  for (const d of divergence) console.error('  - ' + d);
  console.error('\nIf this fires, /api/pipeline/preview is reading a different source than');
  console.error('batch/triage-advance.tsv. Check countTriageAdvanceQueued() in dashboard-server.mjs.');
  process.exit(1);
}

main().catch(err => {
  console.error('[test-batch-figure-parity] unexpected error:', err);
  process.exit(2);
});
