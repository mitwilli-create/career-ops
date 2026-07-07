// tests/hooks-worktree-safety.test.mjs
//
// Regression tests for the worktree-unsafe hook bug observed 2026-07-07:
// scripts/hooks/commit-ui-verify-gate.sh hard-coded the main-tree path and
// always inspected the MAIN tree's index, so a docs-only commit in a
// worktree was blocked when a sibling instance had UI files staged in the
// main tree (false positive), and a worktree commit staging UI files
// passed while the main-tree index was clean (false negative).
//
// The fix derives the repo from the hook payload's `cwd` via
// `git -C <cwd> rev-parse --show-toplevel` — the same worktree-safe
// derivation the PR #385 B7 batch gave scripts/hooks/commit-msg.
//
// Also covers scripts/hooks/branch-invariant-gate.sh (same hard-coded-REPO
// class: it captured the main tree's branch regardless of worktree) and a
// static canary asserting no hook reintroduces the hard-coded path literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks');
const COMMIT_GATE = join(HOOKS_DIR, 'commit-ui-verify-gate.sh');
const BRANCH_GATE = join(HOOKS_DIR, 'branch-invariant-gate.sh');

// Neutralize the runner's global/system git config (commit.gpgSign,
// core.hooksPath, etc.) so temp-repo commits are deterministic on any
// machine — the identity then MUST come from the -c flags below.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 30000 });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function git(cwd, ...args) {
  return sh(cwd, 'git', [
    '-c', 'user.email=test@test',
    '-c', 'user.name=test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ]);
}

/** Build a main repo with one commit + a linked worktree on its own branch. */
function setupRepoWithWorktree() {
  const base = join(tmpdir(), 'hook-worktree-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-b', 'main');
  mkdirSync(join(main, 'dashboard'), { recursive: true });
  writeFileSync(join(main, 'dashboard', 'index.html'), '<html>v1</html>\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents v1\n');
  // Explicit paths only — never wildcard staging (rule 1779966 + the
  // empty-tree-add-A leak class in docs/BUG-CLASSES.md).
  git(main, 'add', '--', 'AGENTS.md', 'dashboard/index.html');
  git(main, 'commit', '-m', 'init');
  git(main, 'worktree', 'add', '-b', 'feature-branch', wt, 'main');
  return { base, main, wt };
}

/** Run a PreToolUse-style hook with a synthetic harness payload on stdin. */
function runHook(hookPath, { command, cwd, extraArgs = [], env = {} } = {}) {
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });
  return spawnSync('bash', [hookPath, ...extraArgs], {
    input: payload,
    encoding: 'utf8',
    // Run the hook process itself from a neutral dir so only the payload
    // cwd (not the process cwd) can drive repo resolution.
    cwd: tmpdir(),
    env: { ...GIT_ENV, ...env },
    timeout: 30000,   // hang-watchdog: bounded child processes (compliance 1671678)
  });
}

test('T1 — docs-only worktree commit ALLOWED while sibling has UI files staged in the main tree (the 2026-07-07 false positive)', () => {
  const { base, main, wt } = setupRepoWithWorktree();
  try {
    // Sibling instance: UI file staged in the MAIN tree.
    writeFileSync(join(main, 'dashboard', 'index.html'), '<html>v2-main</html>\n');
    git(main, 'add', 'dashboard/index.html');
    // This session: docs-only change staged in the WORKTREE.
    writeFileSync(join(wt, 'AGENTS.md'), '# agents v2\n');
    git(wt, 'add', 'AGENTS.md');

    const r = runHook(COMMIT_GATE, { command: 'git commit -m "docs: update AGENTS.md"', cwd: wt });
    assert.equal(r.status, 0, `docs-only worktree commit was blocked:\n${r.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('T2 — worktree commit staging a UI file without audit ref BLOCKED even when the main-tree index is clean (the false negative)', () => {
  const { base, wt } = setupRepoWithWorktree();
  try {
    writeFileSync(join(wt, 'dashboard', 'index.html'), '<html>v2-wt</html>\n');
    git(wt, 'add', 'dashboard/index.html');

    const r = runHook(COMMIT_GATE, { command: 'git commit -m "fix: tweak dashboard"', cwd: wt });
    assert.equal(r.status, 2, `UI commit in worktree was NOT blocked (exit ${r.status})`);
    assert.match(r.stderr, /COMMIT BLOCKED/, 'block banner missing');
    assert.match(r.stderr, /dashboard\/index\.html/, 'blocked file not named');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('T3 — audit reference in the commit message still allows a UI commit in a worktree', () => {
  const { base, wt } = setupRepoWithWorktree();
  try {
    writeFileSync(join(wt, 'dashboard', 'index.html'), '<html>v3-wt</html>\n');
    git(wt, 'add', 'dashboard/index.html');

    const r = runHook(COMMIT_GATE, {
      command: 'git commit -m "fix: tweak dashboard\n\nScreenshots: .claude/audit/tweak-2026-07-07/notes.md"',
      cwd: wt,
    });
    assert.equal(r.status, 0, `audit-referenced commit blocked:\n${r.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('T4 — payload cwd outside any git repo → allow (never block on unresolvable context)', () => {
  const outside = join(tmpdir(), 'hook-nonrepo-' + Date.now());
  mkdirSync(outside, { recursive: true });
  try {
    const r = runHook(COMMIT_GATE, { command: 'git commit -m "x"', cwd: outside });
    assert.equal(r.status, 0, `non-repo cwd blocked: ${r.stderr}`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('T5 — branch-invariant-gate records the WORKTREE branch, not the main-tree branch', () => {
  const { base, wt } = setupRepoWithWorktree();
  const sessionId = 'hook-wt-test-' + Date.now();
  const stateFile = `/tmp/claude-branch-state-${sessionId}.json`;
  try {
    const r = runHook(BRANCH_GATE, {
      command: 'ls',
      cwd: wt,
      extraArgs: ['pre'],
      env: { CLAUDE_SESSION_ID: sessionId },
    });
    assert.equal(r.status, 0, `branch gate errored: ${r.stderr}`);
    assert.ok(existsSync(stateFile), 'state file not written');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const entries = Object.values(state);
    assert.equal(entries.length, 1, 'expected exactly one worktree entry');
    assert.equal(entries[0].branch, 'feature-branch', 'recorded main-tree branch instead of worktree branch');
    // macOS /tmp is a symlink to /private/tmp — compare on realpath suffix.
    assert.ok(entries[0].worktree.endsWith('/wt'), `recorded wrong worktree: ${entries[0].worktree}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
});

test('T6 — static canary: no hook script hard-codes the main-tree repo path', () => {
  const literal = ['/Users/mitchellwilliams', 'Documents/career-ops'].join('/');
  const offenders = [];
  for (const name of readdirSync(HOOKS_DIR)) {
    const body = readFileSync(join(HOOKS_DIR, name), 'utf8');
    // Strip comment lines — prose may cite the path; code must not.
    const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    if (code.includes(literal)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `hooks hard-code the main-tree path: ${offenders.join(', ')}`);
});
