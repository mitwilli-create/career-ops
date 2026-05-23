/**
 * tests/regression-canaries/pattern-b-parallel-agent-fixture.mjs
 *
 * Canary fixture for Pattern B (parallel-agent-collisions). The Finder
 * ` 2.md` filename signature appears when two concurrent agents both
 * write to the same path inside iCloud Drive / a macOS-tracked dir.
 *
 * Spec source: ~/.claude/knowledge/brain/bug-class-catalog.md § Pattern B
 *
 * Extracted from the v1.0 inline CANARY_FIXTURES array during the Q5
 * lib-split (2026-05-23). Shape preserved exactly.
 */

export const patternBParallelAgentFixture = {
  id: 'pattern-b-parallel-agent',
  type: 6,
  description: 'Pattern B parallel-agent-collisions — Finder ` 2.md` filesystem signature',
  fixture: {
    filenames: [
      '.claude/audit/some-dir/notes.md',
      '.claude/audit/some-dir/notes 2.md',  // collision signature
      'data/audit-foo/report.json',
    ],
  },
  expectedFinding: 'parallel-agent-collision',
};
