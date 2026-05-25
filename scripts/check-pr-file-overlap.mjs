#!/usr/bin/env node
/**
 * scripts/check-pr-file-overlap.mjs
 *
 * Queries GitHub for all open PRs in mitwilli-create/career-ops and warns
 * when the current PR shares critical files with another open PR.
 *
 * Usage (in CI):
 *   node scripts/check-pr-file-overlap.mjs <current-pr-number>
 *
 * Usage (locally, before pushing):
 *   GH_TOKEN=$(gh auth token) node scripts/check-pr-file-overlap.mjs <pr-number>
 *
 * Exit codes:
 *   0 — no overlap detected on critical files
 *   2 — overlap detected on critical files (warning, not a hard block)
 *
 * The JSONL files are excluded from overlap warnings because the jsonl-union
 * merge driver handles them automatically (see scripts/jsonl-merge-driver.mjs).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REPO = 'mitwilli-create/career-ops';
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const currentPrNum = parseInt(process.argv[2], 10);
if (!currentPrNum || isNaN(currentPrNum)) {
  process.stderr.write('Usage: node scripts/check-pr-file-overlap.mjs <pr-number>\n');
  process.exit(1);
}

async function ghFetch(path) {
  const url = `https://api.github.com${path}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': GH_TOKEN ? `Bearer ${GH_TOKEN}` : undefined,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status} for ${url}`);
  }
  return resp.json();
}

async function getPrFiles(prNum) {
  const files = [];
  let page = 1;
  while (true) {
    const batch = await ghFetch(`/repos/${REPO}/pulls/${prNum}/files?per_page=100&page=${page}`);
    files.push(...batch.map(f => f.filename));
    if (batch.length < 100) break;
    page++;
  }
  return files;
}

async function getOpenPrs() {
  const prs = [];
  let page = 1;
  while (true) {
    const batch = await ghFetch(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return prs.filter(pr => pr.number !== currentPrNum);
}

// Load critical files list
let criticalFiles = [];
try {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'data/conflict-prevention-critical-files.json'), 'utf8'));
  criticalFiles = cfg.files || [];
} catch {
  process.stderr.write('[check-pr-overlap] Could not read conflict-prevention-critical-files.json — using empty list\n');
}
const criticalSet = new Set(criticalFiles);

async function main() {
  process.stderr.write(`[check-pr-overlap] Checking PR #${currentPrNum} against open PRs in ${REPO}\n`);

  const [currentFiles, openPrs] = await Promise.all([
    getPrFiles(currentPrNum),
    getOpenPrs(),
  ]);

  const currentCritical = currentFiles.filter(f => criticalSet.has(f));
  if (currentCritical.length === 0) {
    process.stdout.write(`✅ PR #${currentPrNum} touches no critical files — no overlap risk\n`);
    process.exit(0);
  }

  process.stderr.write(`[check-pr-overlap] PR #${currentPrNum} touches ${currentCritical.length} critical file(s): ${currentCritical.join(', ')}\n`);
  process.stderr.write(`[check-pr-overlap] Checking ${openPrs.length} open PRs for overlap...\n`);

  const warnings = [];
  for (const pr of openPrs) {
    let theirFiles;
    try {
      theirFiles = await getPrFiles(pr.number);
    } catch (e) {
      process.stderr.write(`[check-pr-overlap] Could not fetch files for PR #${pr.number}: ${e.message}\n`);
      continue;
    }
    const overlap = theirFiles.filter(f => currentCritical.includes(f));
    if (overlap.length > 0) {
      warnings.push({ pr, overlap });
    }
  }

  if (warnings.length === 0) {
    process.stdout.write(`✅ PR #${currentPrNum} touches critical files but no other open PR overlaps them\n`);
    process.exit(0);
  }

  // Emit structured warning
  process.stdout.write('\n⚠️  CRITICAL FILE OVERLAP DETECTED\n');
  process.stdout.write('='.repeat(60) + '\n\n');
  process.stdout.write(
    `PR #${currentPrNum} shares critical files with ${warnings.length} other open PR(s).\n` +
    `These files need to be merged in sequence to avoid structural conflicts.\n\n`,
  );
  for (const { pr, overlap } of warnings) {
    process.stdout.write(`  PR #${pr.number} "${pr.title}"\n`);
    process.stdout.write(`    Branch: ${pr.head.ref}\n`);
    process.stdout.write(`    Overlap: ${overlap.join(', ')}\n\n`);
  }
  process.stdout.write('Options:\n');
  process.stdout.write('  1. Merge the other PR first, then rebase this branch onto main\n');
  process.stdout.write('  2. Coordinate with the other PR author to split responsibility\n');
  process.stdout.write('  3. If your changes are independent sections, proceed — but rebase after the other PR merges\n\n');
  process.stdout.write('See AGENTS.md § Bug class: pr-conflict-mirage-from-parallel-shipping\n');

  // Exit 2 = warning, not hard failure (let CI annotate, not block)
  process.exit(2);
}

main().catch(e => {
  process.stderr.write(`[check-pr-overlap] Fatal: ${e.message}\n`);
  process.exit(1);
});
