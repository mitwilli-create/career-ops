/**
 * tests/regression-canaries/closure-08-outer-template-fixture.mjs
 *
 * Canary fixture for closure-08.1 — outer-template-unescape (Pattern A).
 * Single-backslash regex inside a backtick template literal at
 * scripts/build-dashboard.mjs becomes a literal control character on emit.
 *
 * Spec source: AGENTS.md § Bug class: outer-template-unescape
 * Spec source: ~/.claude/knowledge/brain/bug-class-catalog.md § Pattern A
 *
 * Extracted from the v1.0 inline CANARY_FIXTURES array during the Q5
 * lib-split (2026-05-23). Shape preserved exactly.
 */

export const closure08OuterTemplateFixture = {
  id: 'closure-08-1-outer-template',
  type: 6,
  description: 'Pattern A outer-template-unescape — single-backslash regex in template literal',
  fixture: {
    file: 'scripts/build-dashboard.mjs',
    // Synthetic regression: single-backslash \d inside outer template — broken on emit
    code: "const html = `<script>const re = /\\d+/;</script>`;",
    hasBareRegexInTemplate: true,
  },
  expectedFinding: 'outer-template-unescape',
};
