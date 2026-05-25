#!/usr/bin/env node
// scripts/quarantine/role-enrichment-hallucinations.mjs
//
// PR-01 — Apply-Now UX overhaul, theme F (data-layer drift)
//
// Quarantine `data/role-enrichment/*.json` rows flagged with the "Sarah Chen"
// recruiter hallucination. The same name appears on 4-5 distinct companies
// across the corpus — LLM-generated placeholder that committed to disk.
//
// Action: MOVE (not rm) matching files to `data/_quarantine/role-enrichment/`
// with a sibling `.quarantine-meta.json` recording reason + timestamp + author.
// Reversible by `mv data/_quarantine/role-enrichment/<slug>.json data/role-enrichment/`.
//
// Flags:
//   --dry-run            List matches without moving
//   --whitelist findings Only quarantine slugs known from findings.md §9.1
//                        (safe mode; aborts if live matches drift from the
//                        whitelist by adding unexpected files)
//
// Smoke test from worker brief:
//   node scripts/quarantine/role-enrichment-hallucinations.mjs --dry-run --whitelist findings
//   → must list at most 5 known + zero deltas
//
// Per `.claude/audit/apply-now-ux-audit-2026-05-25/strategy-adjudicated.md`
// (net-new finding from dealbreaker — abort on whitelist DELTA).

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(ROOT, 'data', 'role-enrichment');
const DEST_DIR = join(ROOT, 'data', '_quarantine', 'role-enrichment');

// Known hallucinated slugs from findings.md §9.1 — OpenAI×2, Anthropic×2, Sierra.
// Live at audit time only 4 matched (Sierra row 04 has recruiter Alex Rivera, not
// Sarah Chen — apparent finding miscount). Whitelist permits the actual 4 or
// up-to-the-cited 5; aborts on extras outside this set.
const WHITELIST_FINDINGS = new Set([
  '01-openai-ai-deployment-engineer-media-partnerships.json',
  '02-openai-onboarding-enablement-program-manager-fde.json',
  '03-anthropic-strategic-operations-manager-claude-marketplace.json',
  '04-sierra-developer-relations-engineer-sf.json',
  '05-anthropic-engineering-editorial-lead.json',
]);

const HALLUCINATION_PATTERN = /sarah\s+chen/i;
const QUARANTINE_REASON = 'sarah-chen-hallucination';
const QUARANTINED_BY = 'PR-01';

function parseArgs(argv) {
  const out = { dryRun: false, whitelist: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--whitelist=findings' || (a === '--whitelist' && argv[argv.indexOf(a) + 1] === 'findings')) {
      out.whitelist = 'findings';
    }
  }
  // Also support `--whitelist findings` (space-separated)
  const idx = argv.indexOf('--whitelist');
  if (idx >= 0 && argv[idx + 1] === 'findings') out.whitelist = 'findings';
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const mode = args.dryRun ? 'DRY-RUN' : 'LIVE';
  const wl = args.whitelist === 'findings' ? 'WHITELIST=findings' : 'WHITELIST=none';

  console.log(`[role-enrichment-hallucinations] ${mode} ${wl}`);

  if (!existsSync(SRC_DIR)) {
    console.error(`[role-enrichment-hallucinations] ERROR: source dir not found: ${SRC_DIR}`);
    process.exit(2);
  }

  const files = readdirSync(SRC_DIR).filter(f => f.endsWith('.json'));
  const matches = [];

  for (const f of files) {
    const path = join(SRC_DIR, f);
    let content;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (e) {
      console.warn(`[role-enrichment-hallucinations] skip unreadable: ${f}: ${e.message}`);
      continue;
    }
    if (HALLUCINATION_PATTERN.test(content)) {
      matches.push(f);
    }
  }

  console.log(`[role-enrichment-hallucinations] inspected ${files.length} files, matched ${matches.length}:`);
  for (const m of matches) console.log(`  - ${m}`);

  // Whitelist gate — per dealbreaker safety guidance, abort if live matches
  // drift OUTSIDE the known set (extras would suggest unexpected hallucination
  // pattern spread that warrants manual triage). Subset is acceptable.
  if (args.whitelist === 'findings') {
    const extras = matches.filter(m => !WHITELIST_FINDINGS.has(m));
    if (extras.length > 0) {
      console.error('');
      console.error('[role-enrichment-hallucinations] ABORT: live matches contain UNEXPECTED files not in the findings.md §9.1 whitelist:');
      for (const e of extras) console.error(`  - ${e}`);
      console.error('');
      console.error('Per dealbreaker safety guidance, this requires manual triage. Either:');
      console.error('  (a) re-run findings inventory to update whitelist, OR');
      console.error('  (b) drop --whitelist flag to quarantine all matches (HIGH RISK).');
      process.exit(3);
    }
    const subset = matches.filter(m => WHITELIST_FINDINGS.has(m));
    console.log(`[role-enrichment-hallucinations] whitelist OK: ${subset.length}/${WHITELIST_FINDINGS.size} known hallucinated rows present in live state.`);
  }

  if (args.dryRun) {
    console.log('[role-enrichment-hallucinations] DRY-RUN: no files moved.');
    return;
  }

  if (matches.length === 0) {
    console.log('[role-enrichment-hallucinations] nothing to quarantine.');
    return;
  }

  mkdirSync(DEST_DIR, { recursive: true });
  const stamp = new Date().toISOString();

  for (const f of matches) {
    const src = join(SRC_DIR, f);
    const dest = join(DEST_DIR, f);
    const meta = {
      original_path: `data/role-enrichment/${f}`,
      quarantine_reason: QUARANTINE_REASON,
      quarantined_at: stamp,
      quarantined_by: QUARANTINED_BY,
      detection_pattern: HALLUCINATION_PATTERN.toString(),
      reversal_command: `mv data/_quarantine/role-enrichment/${f} data/role-enrichment/${f}`,
    };
    try {
      renameSync(src, dest);
      writeFileSync(`${dest}.quarantine-meta.json`, JSON.stringify(meta, null, 2) + '\n');
      console.log(`[role-enrichment-hallucinations] MOVED ${f} → ${dest}`);
    } catch (e) {
      console.error(`[role-enrichment-hallucinations] ERROR moving ${f}: ${e.message}`);
      process.exit(4);
    }
  }

  console.log(`[role-enrichment-hallucinations] done. ${matches.length} files quarantined to ${DEST_DIR}`);
}

main();
