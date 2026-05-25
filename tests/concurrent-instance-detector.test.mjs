// tests/concurrent-instance-detector.test.mjs
// Unit tests for scripts/lib/concurrent-instance-detector.mjs
//
// Tests use a synthetic mainRepoPath that doesn't exist on disk for most
// cases so we control all 3 detector conditions. The detector returns
// allowed=true when it can't validate (fail-open), so tests assert both
// the allowed-path AND the blocked-path explicitly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { detectCdPrefixCollision, assertNoCdPrefixToMainRepo } from '../scripts/lib/concurrent-instance-detector.mjs';

// Helper — build a fake git repo + worktree pair on disk so tests exercise
// the real git-branch-detection path.
function buildFakeGitPair() {
  const root = mkdtempSync(join(tmpdir(), 'cci-test-'));
  const mainRepo = join(root, 'main-repo');
  const worktree = join(root, 'worktree');
  mkdirSync(mainRepo);
  // Init main repo + commit
  execSync('git init -q', { cwd: mainRepo });
  execSync('git config user.email t@t.t', { cwd: mainRepo });
  execSync('git config user.name t', { cwd: mainRepo });
  writeFileSync(join(mainRepo, 'README'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: mainRepo });
  execSync('git branch -M main', { cwd: mainRepo });
  // Create worktree on a different branch
  execSync(`git worktree add -q ${worktree} -b feature-x`, { cwd: mainRepo });
  return { root, mainRepo, worktree, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('returns allowed=true when command is empty', () => {
  const r = detectCdPrefixCollision({ command: '', cwd: '/tmp' });
  assert.equal(r.allowed, true);
});

test('returns allowed=true when no cd to main repo', () => {
  const r = detectCdPrefixCollision({
    command: 'ls -la',
    cwd: '/tmp',
    mainRepoPath: '/nonexistent/path',
  });
  assert.equal(r.allowed, true);
});

test('returns allowed=true when main repo path does not exist', () => {
  const r = detectCdPrefixCollision({
    command: 'cd /no/such/path && ls',
    cwd: '/tmp',
    mainRepoPath: '/no/such/path',
  });
  assert.equal(r.allowed, true);
});

test('blocks cd-prefix to main-repo from worktree on different branch', () => {
  const { mainRepo, worktree, cleanup } = buildFakeGitPair();
  try {
    const r = detectCdPrefixCollision({
      command: `cd ${mainRepo} && node script.mjs`,
      cwd: worktree,
      mainRepoPath: mainRepo,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.mainRepoBranch, 'main');
    assert.equal(r.worktreeBranch, 'feature-x');
    assert.match(r.reason, /orphan commit/);
    assert.match(r.suggestion, /absolute paths/);
  } finally { cleanup(); }
});

// Same-branch case: structurally covered — the detector short-circuits via
// `if (mainRepoBranch === worktreeBranch) return result` before the block
// path. Can't directly construct a same-branch worktree pair (git refuses to
// check out a branch that's already checked out elsewhere). The inverse
// (different-branch blocks) test above + the cwd-inside-main-repo test below
// jointly exercise the early-return + the block path.

test('allows when cwd is inside main repo (not a worktree)', () => {
  const { mainRepo, cleanup } = buildFakeGitPair();
  try {
    const r = detectCdPrefixCollision({
      command: `cd ${mainRepo} && node script.mjs`,
      cwd: mainRepo,
      mainRepoPath: mainRepo,
    });
    assert.equal(r.allowed, true);
  } finally { cleanup(); }
});

test('matches quoted cd syntax (double quotes)', () => {
  const { mainRepo, worktree, cleanup } = buildFakeGitPair();
  try {
    const r = detectCdPrefixCollision({
      command: `cd "${mainRepo}" && ls`,
      cwd: worktree,
      mainRepoPath: mainRepo,
    });
    assert.equal(r.allowed, false);
  } finally { cleanup(); }
});

test('matches subshell cd syntax', () => {
  const { mainRepo, worktree, cleanup } = buildFakeGitPair();
  try {
    const r = detectCdPrefixCollision({
      command: `(cd ${mainRepo}; ls)`,
      cwd: worktree,
      mainRepoPath: mainRepo,
    });
    assert.equal(r.allowed, false);
  } finally { cleanup(); }
});

test('does not match cd to a different path that contains main-repo as prefix', () => {
  const { mainRepo, worktree, cleanup } = buildFakeGitPair();
  try {
    const r = detectCdPrefixCollision({
      command: `cd ${mainRepo}-other-suffix && ls`,
      cwd: worktree,
      mainRepoPath: mainRepo,
    });
    // Should NOT block — different path.
    assert.equal(r.allowed, true);
  } finally { cleanup(); }
});

test('assertNoCdPrefixToMainRepo throws with code CONCURRENT_INSTANCE_VIOLATION', () => {
  const { mainRepo, worktree, cleanup } = buildFakeGitPair();
  try {
    assert.throws(
      () => assertNoCdPrefixToMainRepo({
        command: `cd ${mainRepo} && rm -rf /tmp/foo`,
        cwd: worktree,
        mainRepoPath: mainRepo,
      }),
      (err) => err.code === 'CONCURRENT_INSTANCE_VIOLATION' && /BLOCKED/.test(err.message),
    );
  } finally { cleanup(); }
});

test('assertNoCdPrefixToMainRepo does not throw when allowed', () => {
  const r = assertNoCdPrefixToMainRepo({
    command: 'ls -la',
    cwd: '/tmp',
    mainRepoPath: '/no/such/path',
  });
  assert.equal(r.allowed, true);
});

test('regex escapes special chars in mainRepoPath', () => {
  // mainRepoPath with special regex chars (parens) should still match literally.
  const r = detectCdPrefixCollision({
    command: 'cd /tmp/(weird)/path && ls',
    cwd: '/tmp/some-other-dir',
    mainRepoPath: '/tmp/(weird)/path',
  });
  // Path doesn't exist on disk so allowed=true via early-return.
  // This test mainly verifies no regex-injection crash.
  assert.equal(r.allowed, true);
});
