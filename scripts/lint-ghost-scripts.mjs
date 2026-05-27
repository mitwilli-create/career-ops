#!/usr/bin/env node
// lint-ghost-scripts.mjs — CI lint that fails on references to documented-but-unbuilt scripts.
//
// PR-07 (apply-now UX audit 2026-05-25) — closes the documented-but-unbuilt gap class
// per AGENTS.md § Bug class: documented-but-unbuilt. Aspirational docs (and stale code
// comments / route descriptions / CLI examples) reference scripts that were never built;
// the runtime gracefully skips, the operator never sees the gap, and the doc drift
// compounds over time.
//
// Strategy: grep each KNOWN_GHOST pattern across the four highest-impact files
// (dashboard-server.mjs, scripts/build-dashboard.mjs, scripts/, lib/). Ignore lines
// that begin with a comment marker (`// ` or `* `) so this rule can document the
// ghost script's history without fighting itself. Exit code 1 on any non-comment
// hit; 0 on a clean tree.
//
// Add new entries by appending to KNOWN_GHOSTS below and providing the canonical
// replacement so the operator hint stays actionable.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(__filename, '..', '..');

// Each entry: { id, pattern (regex string, escaped), replacement (canonical real path) }.
// Add a new ghost when a script gets documented-but-unbuilt. Replacement is the
// canonical real path that supplants the ghost; surfaced in the lint failure
// message so the operator knows what to edit it to.
const KNOWN_GHOSTS = [
  // 2026-05-27 — hiring-manager-research removed: PR #296 (commit 473364b)
  // built scripts/hiring-manager-research.mjs from scratch. Self-references
  // in the file's own JSDoc + console.error messages were tripping this lint
  // as if the file were missing. Re-add if a future refactor removes it.
];

// Scope: every file under these roots is scanned (recursively). Files outside
// this scope (e.g. data/, .claude/, archive/) are intentionally excluded —
// documentation history about the ghost can live there without tripping the lint.
const SCAN_ROOTS = [
  'scripts',
  'lib',
];

// Single-file additions (not directories).
const SCAN_FILES = [
  'dashboard-server.mjs',
  'scripts/build-dashboard.mjs',
];

// Skip these directories during recursive walks.
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'test']);

// Skip files matching these patterns (lint script itself + obvious archive paths).
const SKIP_FILES = new Set([
  'scripts/lint-ghost-scripts.mjs',
]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

function collectScanTargets() {
  const targets = [];
  for (const root of SCAN_ROOTS) {
    walk(join(ROOT, root), targets);
  }
  for (const f of SCAN_FILES) {
    targets.push(join(ROOT, f));
  }
  return targets.filter((p) => {
    const rel = relative(ROOT, p);
    return !SKIP_FILES.has(rel);
  });
}

// A line is "in a comment" if its leading non-whitespace is `//`, `*`, or `#`.
// This is intentionally simple — we treat full-line comments as documentation
// of the ghost (allowed). We do NOT try to detect end-of-line trailing comments
// because a line of code that calls the ghost AND has a trailing comment about
// it is still a bug.
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('* ') ||
    trimmed === '*' ||
    trimmed.startsWith('*/') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

function scanFile(filePath, ghosts) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  const findings = [];
  for (const ghost of ghosts) {
    const re = new RegExp(ghost.pattern, 'g');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      re.lastIndex = 0; // reset stateful flag
      if (isCommentLine(line)) continue;
      findings.push({
        file: relative(ROOT, filePath),
        line: i + 1,
        ghost: ghost.id,
        replacement: ghost.replacement,
        text: line.trimEnd().slice(0, 200),
      });
    }
  }
  return findings;
}

function main() {
  const targets = collectScanTargets();
  const allFindings = [];
  for (const t of targets) {
    allFindings.push(...scanFile(t, KNOWN_GHOSTS));
  }

  if (allFindings.length === 0) {
    console.log(`lint-ghost-scripts: OK — scanned ${targets.length} files, 0 ghost-script references found.`);
    process.exit(0);
  }

  console.error(`lint-ghost-scripts: FAIL — ${allFindings.length} ghost-script reference(s) found.`);
  console.error('');
  console.error('Each reference points to a script that does NOT exist in the codebase.');
  console.error('Replace with the canonical real path shown below.');
  console.error('');
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ghost      : ${f.ghost}`);
    console.error(`    replace w/ : ${f.replacement}`);
    console.error(`    line text  : ${f.text}`);
    console.error('');
  }
  console.error('To allow a reference (for historical doc purposes), prefix the line with `// `.');
  console.error('See AGENTS.md § Bug class: documented-but-unbuilt for the broader pattern.');
  process.exit(1);
}

main();
