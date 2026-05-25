#!/usr/bin/env node
/**
 * scripts/ledger-enforcer.mjs
 *
 * CLI wrapper around lib/ledger-enforcer.mjs. Three primary modes:
 *
 *   --check-modified           Compare git's staged paths (pre-commit context)
 *                              or PR-vs-base paths (CI context, via --base) to
 *                              the ledger and report violations.
 *                              Exit 0 = no violations. Exit 2 = violations found.
 *
 *   --check-modified-vs-base   CI variant: compares HEAD vs an explicit base
 *                              ref. Reads $GITHUB_BASE_REF or --base=<ref>;
 *                              falls back to origin/main.
 *
 *   --audit                    Full audit: list every stale closure_artifact
 *                              + every stale code_path across all entries.
 *                              For weekly cron + manual checks.
 *
 *   --explain                  For every OPEN/NEEDS_CLOSURE entry, print the
 *                              id + code_paths + closure_artifacts.
 *                              Useful when a contributor wants to know
 *                              "what's this entry tracking, exactly?"
 *
 *   --help                     Print usage.
 *
 * Optional flags:
 *   --ledger=<path>            Override ledger location (default:
 *                              data/persistent-task-ledger.md).
 *   --repo-root=<path>         Override repo-root detection.
 *   --json                     Emit JSON instead of human-readable text
 *                              (useful for CI plumbing).
 *   --base=<ref>               Override CI base ref (default: origin/main).
 *
 * Exit codes:
 *   0   - all clear / no violations
 *   1   - usage error / unexpected failure
 *   2   - violations found (only in --check-modified* modes; soft signal
 *         used by the pre-commit hook so it can WARN but proceed)
 *
 * Per dealbreaker-final-pre-apply-2026-05-24.md § Step 6:
 *   - Local pre-commit hook = WARN mode (exit 2 → print warning, commit anyway)
 *   - GHA CI = BLOCK mode (exit 2 → fail the check + post one-line fix command)
 *   - Same library, two consumers — eliminates the bypass reflex.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseLedger,
  findStaleArtifacts,
  findStaleCodePaths,
  checkModifiedPaths,
  auditLedger,
  loadLedgerFile,
  defaultLedgerPath,
  OPEN_STATUSES,
} from '../lib/ledger-enforcer.mjs';

// ──────────────────────────────────────────────────────────────────────────
// Arg parsing — zero-dep, tolerates =value and --flag value
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      args._positional.push(tok);
      continue;
    }
    const stripped = tok.slice(2);
    if (stripped.includes('=')) {
      const [k, ...rest] = stripped.split('=');
      args[k] = rest.join('=');
    } else {
      // Boolean flag — unless the next arg is also non-flag, treat as bool.
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[stripped] = next;
        i++;
      } else {
        args[stripped] = true;
      }
    }
  }
  return args;
}

// ──────────────────────────────────────────────────────────────────────────
// Repo-root detection
// ──────────────────────────────────────────────────────────────────────────

function detectRepoRoot(override) {
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  // Walk up from THIS script's location looking for .git/ or package.json
  // belonging to the career-ops repo.
  const here = dirname(fileURLToPath(import.meta.url));
  // scripts/ → repo root is parent
  const candidate = resolve(here, '..');
  if (fs.existsSync(join(candidate, '.git')) ||
      fs.existsSync(join(candidate, 'package.json'))) {
    return candidate;
  }
  // Last resort: use git
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: here,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return process.cwd();
}

// ──────────────────────────────────────────────────────────────────────────
// Modified-path collectors
// ──────────────────────────────────────────────────────────────────────────

/**
 * For local pre-commit: list staged files via `git diff --cached --name-only`.
 * If nothing is staged, falls back to `git diff --name-only` (unstaged) so
 * a developer running the enforcer locally with no stage still sees results.
 */
function getStagedFiles(repoRoot) {
  try {
    const staged = execSync('git diff --cached --name-only --diff-filter=ACMRTUXB', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    if (staged) return staged.split(/\r?\n/).filter(Boolean);
    // Fallback: unstaged
    const unstaged = execSync('git diff --name-only --diff-filter=ACMRTUXB', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    return unstaged ? unstaged.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    console.error(`ledger-enforcer: git diff failed: ${err.message}`);
    return [];
  }
}

/**
 * For CI: list paths changed vs base ref via `git diff <base>...HEAD --name-only`.
 * The triple-dot form picks the common ancestor, which is what GHA wants.
 */
function getChangedFilesVsBase(repoRoot, baseRef) {
  const ref = baseRef || process.env.GITHUB_BASE_REF || 'origin/main';
  const refSpec = ref.includes('/') ? ref : `origin/${ref}`;
  try {
    const out = execSync(
      `git diff ${refSpec}...HEAD --name-only --diff-filter=ACMRTUXB`,
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 15000,
      },
    ).trim();
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    console.error(`ledger-enforcer: git diff vs ${refSpec} failed: ${err.message}`);
    // In CI we'd rather fail open (don't block on diff infra error). The
    // workflow can decide what to do with empty.
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Output formatters
// ──────────────────────────────────────────────────────────────────────────

function formatViolations(violations, opts = {}) {
  if (opts.json) {
    return JSON.stringify({ violations }, null, 2);
  }
  const lines = [];
  lines.push(`ledger-enforcer: ${violations.length} violation(s) found`);
  lines.push('');
  for (const v of violations) {
    lines.push(`  • ${v.message}`);
  }
  lines.push('');
  lines.push('Fix command (one of):');
  lines.push('  - Update data/persistent-task-ledger.md (add a -DONE row + closure evidence)');
  lines.push('  - Add a closure_artifacts: [...] entry to the metadata block');
  lines.push('  - If this commit is intentionally outside the closure scope, note it in the commit message');
  return lines.join('\n');
}

function formatAudit(result, opts = {}) {
  if (opts.json) return JSON.stringify(result, null, 2);
  const lines = [];
  lines.push(`ledger-enforcer audit`);
  lines.push(`  entries: ${result.entry_count}`);
  lines.push(`  with metadata: ${result.with_metadata}`);
  lines.push(`  without metadata: ${result.without_metadata}`);
  lines.push(`  OPEN/NEEDS_CLOSURE: ${result.open_needs_closure.length}`);
  lines.push('');
  if (result.stale_artifacts.length > 0) {
    lines.push(`Stale closure_artifacts (cited but missing on disk):`);
    for (const s of result.stale_artifacts) lines.push(`  ✗ ${s}`);
    lines.push('');
  } else {
    lines.push(`No stale closure_artifacts.`);
  }
  if (result.stale_code_paths.length > 0) {
    lines.push(`Stale code_paths (cited but file does not exist):`);
    for (const s of result.stale_code_paths) lines.push(`  ✗ ${s}`);
    lines.push('');
  } else {
    lines.push(`No stale code_paths.`);
  }
  return lines.join('\n');
}

function formatExplain(entries, opts = {}) {
  const open = entries.filter(e => {
    const s = (e.status || '').toUpperCase();
    return OPEN_STATUSES.has(s);
  });
  if (opts.json) return JSON.stringify({ open_entries: open }, null, 2);
  const lines = [];
  lines.push(`ledger-enforcer: ${open.length} open entr${open.length === 1 ? 'y' : 'ies'}`);
  lines.push('');
  for (const e of open) {
    lines.push(`${e.id} [${e.status || 'NO-STATUS'}] tag=${e.feature_tag || '(none)'}`);
    if (e.code_paths.length === 0) {
      lines.push(`  code_paths: (none — no enforcement triggers)`);
    } else {
      lines.push(`  code_paths:`);
      for (const p of e.code_paths) lines.push(`    - ${p}`);
    }
    if (e.closure_artifacts.length === 0) {
      lines.push(`  closure_artifacts: (none)`);
    } else {
      lines.push(`  closure_artifacts:`);
      for (const p of e.closure_artifacts) lines.push(`    - ${p}`);
    }
    if (!e.metadata_present) {
      lines.push(`  (no YAML metadata — enforcement cannot fire on this entry)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Usage / help
// ──────────────────────────────────────────────────────────────────────────

const USAGE = `\
ledger-enforcer — anti-regression guard for data/persistent-task-ledger.md

Usage:
  node scripts/ledger-enforcer.mjs --check-modified         # local / pre-commit
  node scripts/ledger-enforcer.mjs --check-modified-vs-base # CI
  node scripts/ledger-enforcer.mjs --audit                  # weekly hygiene
  node scripts/ledger-enforcer.mjs --explain                # what's open?

Flags:
  --ledger=<path>      Override ledger path (default: data/persistent-task-ledger.md)
  --repo-root=<path>   Override repo root (default: auto-detect)
  --base=<ref>         Override CI base ref (default: origin/main or $GITHUB_BASE_REF)
  --json               Emit JSON output
  --help               Show this message

Exit codes:
  0   no violations / audit clean
  1   usage error
  2   violations found (pre-commit hook WARNs; CI BLOCKs)

See:
  lib/ledger-enforcer.mjs              core library
  .github/workflows/ledger-check.yml   CI consumer
  scripts/install-git-hooks.sh         local hook installer
  .claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md § Step 6
`;

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args['check-modified'] && !args['check-modified-vs-base']
                    && !args.audit && !args.explain)) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const repoRoot = detectRepoRoot(args['repo-root']);
  const ledgerPath = args.ledger
    ? (isAbsolute(args.ledger) ? args.ledger : resolve(repoRoot, args.ledger))
    : defaultLedgerPath(repoRoot);

  if (!fs.existsSync(ledgerPath)) {
    console.error(`ledger-enforcer: ledger file not found at ${ledgerPath}`);
    console.error(`  set --ledger=<path> if the ledger has moved`);
    process.exit(1);
  }

  let entries;
  try {
    entries = loadLedgerFile(ledgerPath);
  } catch (err) {
    console.error(`ledger-enforcer: failed to parse ledger: ${err.message}`);
    process.exit(1);
  }

  const opts = { json: !!args.json };

  if (args.audit) {
    const result = auditLedger({ entries, repoRoot });
    process.stdout.write(formatAudit(result, opts) + '\n');
    process.exit(0);
  }

  if (args.explain) {
    process.stdout.write(formatExplain(entries, opts) + '\n');
    process.exit(0);
  }

  // From here: --check-modified or --check-modified-vs-base
  let modifiedPaths;
  if (args['check-modified-vs-base']) {
    modifiedPaths = getChangedFilesVsBase(repoRoot, args.base);
  } else {
    modifiedPaths = getStagedFiles(repoRoot);
  }

  if (modifiedPaths.length === 0) {
    if (!opts.json) {
      console.log('ledger-enforcer: no modified paths to check');
    } else {
      process.stdout.write(JSON.stringify({ violations: [], modified: [] }, null, 2) + '\n');
    }
    process.exit(0);
  }

  const violations = checkModifiedPaths({ entries, modifiedPaths, repoRoot });

  if (violations.length === 0) {
    if (!opts.json) {
      console.log(`ledger-enforcer: ${modifiedPaths.length} modified path(s), no violations`);
    } else {
      process.stdout.write(JSON.stringify({ violations: [], modified: modifiedPaths }, null, 2) + '\n');
    }
    process.exit(0);
  }

  process.stdout.write(formatViolations(violations, opts) + '\n');
  process.exit(2);
}

main().catch(err => {
  console.error(`ledger-enforcer: unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
