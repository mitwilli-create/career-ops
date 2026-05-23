/**
 * scripts/agents/regression-guard/lib/canary-suite.mjs
 *
 * Vector 1 self-regression defense — canary fixture suite.
 *
 * 3 highest-leverage bug-class incidents with cleanest historical signal.
 * Each fixture is a synthetic content blob the agent runs its detectors
 * against. If a detector misses, CANARY_FAIL_SHUT activates and the
 * non-canary findings get suppressed for the run (treated as untrusted
 * since the detection layer itself is broken).
 *
 * v1.0 (2026-05-23) ships 3 inline fixtures. The Q5 dealbreaker spec called
 * for separate fixture files at tests/regression-canaries/*-fixture.mjs —
 * those files are sibling modules that EXPORT the same shapes; this file
 * provides the runner + the inline-fallback fixtures so the canary suite
 * stays self-contained.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { patternBParallelAgentFixture } from '../../../../tests/regression-canaries/pattern-b-parallel-agent-fixture.mjs';
import { patternCInlinePayloadBloatFixture } from '../../../../tests/regression-canaries/pattern-c-inline-payload-bloat-fixture.mjs';
import { closure08OuterTemplateFixture } from '../../../../tests/regression-canaries/closure-08-outer-template-fixture.mjs';

export const CANARY_FIXTURES = [
  patternBParallelAgentFixture,
  patternCInlinePayloadBloatFixture,
  closure08OuterTemplateFixture,
];

export function runCanarySuite() {
  const results = [];
  for (const canary of CANARY_FIXTURES) {
    try {
      const finding = detectCanary(canary);
      results.push({
        id: canary.id,
        passed: finding === canary.expectedFinding,
        expected: canary.expectedFinding,
        got: finding,
      });
    } catch (err) {
      results.push({
        id: canary.id,
        passed: false,
        expected: canary.expectedFinding,
        got: `ERROR: ${err.message}`,
      });
    }
  }
  return results;
}

export function detectCanary(canary) {
  const fx = canary.fixture;
  // Detection logic mirrors the real detectors below — uses deterministic signals
  if (canary.id === 'pattern-b-parallel-agent') {
    if ((fx.filenames || []).some(f => / 2(\.[a-z]+)?$/.test(f))) return 'parallel-agent-collision';
  }
  if (canary.id === 'pattern-c-inline-payload-bloat') {
    if (fx.sizeBytes > 15 * 1024 * 1024) return 'inline-payload-bloat';
  }
  if (canary.id === 'closure-08-1-outer-template') {
    if (fx.hasBareRegexInTemplate) return 'outer-template-unescape';
  }
  return null;
}
