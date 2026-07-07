// tests/git-icloud-junk-sweep.test.mjs
//
// Proves sweepGitIcloudJunk() deletes ONLY iCloud conflict copies ("<name> N")
// inside a .git directory and never touches a legitimate git file. This is a
// delete-not-archive primitive, so the safety guarantee is load-bearing.
//
// Run: node tests/git-icloud-junk-sweep.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepGitIcloudJunk } from '../lib/system-health-cleanup.mjs';

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.log(`✗ ${msg}`); failures++; } };

// ── Build a throwaway fake .git with real files + iCloud conflict copies ──
const g = join(mkdtempSync(join(tmpdir(), 'git-icloud-sweep-')), '.git');
mkdirSync(join(g, 'refs/heads'), { recursive: true });
mkdirSync(join(g, 'logs/refs/heads'), { recursive: true });
mkdirSync(join(g, 'worktrees/foo'), { recursive: true });
mkdirSync(join(g, 'objects/ab'), { recursive: true });
mkdirSync(join(g, 'hooks 2'), { recursive: true }); // directory conflict copy

const REAL = [
  'config', 'index', 'HEAD', 'packed-refs',
  'refs/heads/main', 'logs/refs/heads/main',
  'worktrees/foo/index', 'worktrees/foo/HEAD',
  'objects/ab/deadbeef',
  'objects/pack 2', // under objects/ (skipped at top) → must survive
];
for (const r of REAL) writeFileSync(join(g, r), 'x');

const JUNK = [
  'config 2', 'index 2', 'index 40', 'HEAD 3', 'packed-refs 2',
  'refs/heads/main 2', 'logs/refs/heads/main 2',
  'worktrees/foo/index 2', 'worktrees/foo/HEAD 3',
];
for (const j of JUNK) writeFileSync(join(g, j), 'x');
writeFileSync(join(g, 'hooks 2', 'pre-commit'), 'x');

// ── Sweep ──
const { removed } = sweepGitIcloudJunk(g);

// ── Assertions ──
for (const r of REAL) assert(existsSync(join(g, r)), `REAL FILE DELETED: ${r}`);
for (const j of JUNK) assert(!existsSync(join(g, j)), `JUNK SURVIVED: ${j}`);
assert(!existsSync(join(g, 'hooks 2')), 'JUNK DIR SURVIVED: hooks 2');
assert(existsSync(join(g, 'objects/pack 2')), 'objects/ conflict copy should be SKIPPED (not deleted)');
assert(removed.length === JUNK.length + 1, `expected ${JUNK.length + 1} removals, got ${removed.length}`);

// Idempotence: a second sweep removes nothing.
const second = sweepGitIcloudJunk(g);
assert(second.removed.length === 0, `second sweep should remove 0, got ${second.removed.length}`);

// Missing dir: no throw, empty result.
const none = sweepGitIcloudJunk(join(g, 'does-not-exist'));
assert(none.removed.length === 0, 'missing .git dir should return empty');

if (failures === 0) {
  console.log(`✓ git-icloud-junk-sweep: all assertions pass (${removed.length} junk entries swept, all real files intact)`);
  process.exit(0);
} else {
  console.log(`✗ git-icloud-junk-sweep: ${failures} failure(s)`);
  process.exit(1);
}
