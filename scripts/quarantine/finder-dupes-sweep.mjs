#!/usr/bin/env node
// scripts/quarantine/finder-dupes-sweep.mjs
//
// PR-01 — Apply-Now UX overhaul, theme F (data-layer drift)
//
// Sweep `data/` for macOS Finder duplicate artifacts of the form `<name> 2.<ext>`
// — produced when concurrent agents (or iCloud sync) race a write and macOS
// renames one side. Pattern documented in
// `~/.claude/knowledge/brain/bug-class-catalog.md` § parallel-agent-collisions.
//
// Action: MOVE (not rm) non-whitelisted dupes to `data/_quarantine/finder-dupes/`
// preserving mtime. A `.quarantine-meta.json` sibling records the original path
// + size + mtime so reversal is trivial.
//
// Whitelist: any path present in `git log --all --name-only` (i.e., legitimately
// committed at some point with " 2." in its name) is SKIPPED. This protects
// against false-positive sweeps of intentionally-named files.
//
// Flags:
//   --dry-run            List matches without moving
//   --root <path>        Scan root (default: ./data relative to repo). Allows
//                        cross-worktree scanning when gitignored data lives at
//                        a different absolute path. NEVER uses cd-prefix.
//
// Smoke test:
//   node scripts/quarantine/finder-dupes-sweep.mjs --dry-run
//   → expected to list `data/context-notes/48 2.json` (the canonical dupe from
//     findings.md §9.4) when scanned against the main-repo data tree; may list
//     zero in a fresh worktree.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, existsSync, utimesSync } from 'fs';
import { join, dirname, basename, relative, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const FINDER_DUPE_PATTERN = /^(.+) 2(\.(?:json|md|tsv|csv|jsonl|yml|yaml|txt|html|js|mjs|ts|tsx|css|toml))$/i;

const QUARANTINE_REASON = 'finder-dupe-parallel-agent-collision';
const QUARANTINED_BY = 'PR-01';

function parseArgs(argv) {
  const out = { dryRun: false, root: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--root') { out.root = argv[i + 1]; i++; }
  }
  return out;
}

function walkSync(dir, results = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip the quarantine dir (don't sweep your own quarantine sink)
      if (ent.name === '_quarantine') continue;
      // Skip .git
      if (ent.name === '.git') continue;
      walkSync(full, results);
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function gitWhitelistedDupes() {
  // Files that have ever been committed with " 2." in the name — legitimate.
  // Conservative: if `git log` fails, return empty set (treat nothing as
  // whitelisted, defer to the dry-run review).
  try {
    const out = execSync('git log --all --name-only --pretty=format: 2>/dev/null | sort -u', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    return new Set(lines.filter(l => FINDER_DUPE_PATTERN.test(basename(l))));
  } catch (e) {
    console.warn(`[finder-dupes-sweep] WARN: git log failed (${e.message}); whitelist is empty.`);
    return new Set();
  }
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`[finder-dupes-sweep] ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`);

  const scanRoot = args.root ? resolve(args.root) : join(REPO_ROOT, 'data');
  if (!existsSync(scanRoot)) {
    console.error(`[finder-dupes-sweep] ERROR: scan root not found: ${scanRoot}`);
    process.exit(2);
  }
  console.log(`[finder-dupes-sweep] scan root: ${scanRoot}`);

  const whitelist = gitWhitelistedDupes();
  if (whitelist.size > 0) {
    console.log(`[finder-dupes-sweep] whitelist (${whitelist.size} git-tracked dupes):`);
    for (const p of whitelist) console.log(`  · ${p}`);
  }

  const allFiles = walkSync(scanRoot);
  const matches = [];

  for (const f of allFiles) {
    const m = FINDER_DUPE_PATTERN.exec(basename(f));
    if (!m) continue;
    const relPath = relative(REPO_ROOT, f);
    // Skip if git-whitelisted (file may be at scanRoot but git stores path
    // relative to repo root; compare by relative path)
    if (whitelist.has(relPath)) {
      console.log(`[finder-dupes-sweep] SKIP whitelisted: ${relPath}`);
      continue;
    }
    matches.push(f);
  }

  console.log(`[finder-dupes-sweep] inspected ${allFiles.length} files, matched ${matches.length}:`);
  for (const m of matches) console.log(`  - ${relative(REPO_ROOT, m)}`);

  if (args.dryRun) {
    console.log('[finder-dupes-sweep] DRY-RUN: no files moved.');
    return;
  }

  if (matches.length === 0) {
    console.log('[finder-dupes-sweep] nothing to quarantine.');
    return;
  }

  const DEST_DIR = join(REPO_ROOT, 'data', '_quarantine', 'finder-dupes');
  mkdirSync(DEST_DIR, { recursive: true });
  const stamp = new Date().toISOString();

  for (const src of matches) {
    // Preserve directory structure under the dest dir to disambiguate same-named
    // dupes from different parents.
    const relPath = relative(scanRoot, src);
    const dest = join(DEST_DIR, relPath);
    mkdirSync(dirname(dest), { recursive: true });

    let srcStat;
    try { srcStat = statSync(src); } catch (e) {
      console.error(`[finder-dupes-sweep] ERROR stat ${src}: ${e.message}`);
      continue;
    }

    const meta = {
      original_path: relative(REPO_ROOT, src),
      original_mtime_iso: srcStat.mtime.toISOString(),
      original_size_bytes: srcStat.size,
      quarantine_reason: QUARANTINE_REASON,
      quarantined_at: stamp,
      quarantined_by: QUARANTINED_BY,
      reversal_command: `mv ${relative(REPO_ROOT, dest)} ${relative(REPO_ROOT, src)}`,
    };
    try {
      renameSync(src, dest);
      utimesSync(dest, srcStat.atime, srcStat.mtime);
      writeFileSync(`${dest}.quarantine-meta.json`, JSON.stringify(meta, null, 2) + '\n');
      console.log(`[finder-dupes-sweep] MOVED ${relative(REPO_ROOT, src)} → ${relative(REPO_ROOT, dest)}`);
    } catch (e) {
      console.error(`[finder-dupes-sweep] ERROR moving ${src}: ${e.message}`);
      process.exit(4);
    }
  }

  console.log(`[finder-dupes-sweep] done. ${matches.length} files quarantined to ${DEST_DIR}`);
}

main();
