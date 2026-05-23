/**
 * tests/regression-canaries/pattern-c-inline-payload-bloat-fixture.mjs
 *
 * Canary fixture for Pattern C (inline-payload-bloat). Dashboard/index.html
 * grew above the 15 MB hard ceiling → page-load regressions, OOM in mobile.
 *
 * Spec source: ~/.claude/knowledge/brain/bug-class-catalog.md § Pattern C
 *
 * Extracted from the v1.0 inline CANARY_FIXTURES array during the Q5
 * lib-split (2026-05-23). Shape preserved exactly.
 */

export const patternCInlinePayloadBloatFixture = {
  id: 'pattern-c-inline-payload-bloat',
  type: 2,
  description: 'Pattern C inline-payload-bloat — dashboard/index.html oversized',
  fixture: {
    file: 'dashboard/index.html',
    sizeBytes: 16_000_000,  // > 15 MB hard fail
  },
  expectedFinding: 'inline-payload-bloat',
};
