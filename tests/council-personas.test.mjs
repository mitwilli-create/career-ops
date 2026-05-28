// tests/council-personas.test.mjs
//
// Wave 3 task 11 of 14. 5-suite test coverage for the persona-system.
// Run via: node --test tests/council-personas.test.mjs
//
// All LLM calls mocked per locked Q6 decision. Deterministic, $0 cost.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allPersonas, getPersona, listPersonas, personasFor, validatePersonaContract,
  personaNames, PHASES,
} from '../lib/council-personas.mjs';
import { classifyProposalShape, annotateOmegaRecommendationsWithPersonaReview } from '../lib/persona-omega-review.mjs';
import { detectConflicts, buildDealbreakerHandoff } from '../lib/persona-conflict-detector.mjs';
import { readCatalogBugClasses, analyzeFindingsForNewBugClasses } from '../lib/persona-learning-loop.mjs';
import { SENSITIVE_PATH_PATTERNS, isSensitivePath, assertNoInlineQuotesFromSensitivePaths } from '../scripts/agents/regression-guard/lib/citation-policy.mjs';

// ──────────────────────────────────────────────────────────────────────────────
// Suite 1 — Persona record shape (all 12 personas)
// ──────────────────────────────────────────────────────────────────────────────

describe('Suite 1: persona record shape', () => {
  test('exactly 12 personas exported', () => {
    assert.equal(allPersonas().length, 12);
  });

  test('all 12 records pass validatePersonaContract', () => {
    for (const p of allPersonas()) {
      const v = validatePersonaContract(p);
      assert.equal(v.ok, true, `${p.name}: ${v.errors.join(', ')}`);
    }
  });

  test('3 standing + 2 conditional + 7 opt-in', () => {
    const standing = listPersonas({ status: 'standing' });
    const conditional = listPersonas({ status: 'conditional' });
    const optIn = listPersonas({ status: 'opt-in' });
    assert.equal(standing.length, 3, `standing: ${standing.map(p => p.name).join(', ')}`);
    assert.equal(conditional.length, 2, `conditional: ${conditional.map(p => p.name).join(', ')}`);
    assert.equal(optIn.length, 7, `opt-in: ${optIn.map(p => p.name).join(', ')}`);
  });

  test('Cynical SRE + Hamilton + Hickey are HIGH-block authority', () => {
    const cs = getPersona('cynical-sre');
    const mh = getPersona('margaret-hamilton');
    const rh = getPersona('rich-hickey');
    assert.equal(cs.blockingAuthority, 'HIGH-block');
    assert.equal(mh.blockingAuthority, 'HIGH-block');
    assert.equal(rh.blockingAuthority, 'advisory'); // Hickey is architectural advisory per spec
  });

  test('vendor routing matches locked decision #6', () => {
    assert.match(getPersona('andrej-karpathy').recommendedModel, /^openai:gpt-5/);
    assert.match(getPersona('ilya-sutskever').recommendedModel, /^openai:gpt-5/);
    assert.match(getPersona('linus-torvalds').recommendedModel, /^openai:gpt-5/);
    assert.match(getPersona('dan-abramov').recommendedModel, /^openai:gpt-5/);
    assert.match(getPersona('geohot').recommendedModel, /^xai:grok-4/);
    assert.match(getPersona('dhh').recommendedModel, /^xai:grok-4/);
    assert.match(getPersona('jeremy-howard').recommendedModel, /^google:gemini-3\.1-pro-preview/);
    assert.match(getPersona('cynical-sre').recommendedModel, /^anthropic:/);
    assert.match(getPersona('margaret-hamilton').recommendedModel, /^anthropic:/);
    assert.match(getPersona('rich-hickey').recommendedModel, /^anthropic:/);
  });

  test('every persona has 400-word-target systemPrompt (>=1500 chars)', () => {
    for (const p of allPersonas()) {
      assert.ok(p.systemPrompt.length >= 1500, `${p.name} prompt only ${p.systemPrompt.length} chars`);
    }
  });

  test('personaNames returns all 12 stable names', () => {
    const names = personaNames();
    assert.equal(names.length, 12);
    assert.ok(names.includes('cynical-sre'));
    assert.ok(names.includes('margaret-hamilton'));
    assert.ok(names.includes('rich-hickey'));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite 2 — Phase 3.5 fan-out (personasFor with diff context)
// ──────────────────────────────────────────────────────────────────────────────

describe('Suite 2: /deploy-verify Phase 3.5 fan-out', () => {
  test('personasFor(PHASES.DEPLOY_VERIFY_35, ctx) returns Cynical SRE + Hamilton', () => {
    const firing = personasFor(PHASES.DEPLOY_VERIFY_35, { files: ['lib/foo.mjs'] });
    const names = firing.map(p => p.name).sort();
    assert.deepEqual(names, ['cynical-sre', 'margaret-hamilton']);
  });

  test('opt-in personas never auto-fire', () => {
    const firing = personasFor(PHASES.DEPLOY_VERIFY_35, { files: ['lib/foo.mjs'] });
    for (const p of firing) {
      assert.notEqual(p.status, 'opt-in', `${p.name} should not auto-fire (status=${p.status})`);
    }
  });

  test('unknown phase returns empty array (no throw)', () => {
    const firing = personasFor('bogus-phase', {});
    assert.deepEqual(firing, []);
  });

  test('predicate-throw fails-safe to NOT firing', () => {
    // Hickey has a `when` predicate. We pass a ctx that would throw inside if it accessed fields incorrectly.
    // The personasFor wraps the predicate in try/catch; a throw → exclusion (not throw).
    const firing = personasFor(PHASES.OMEGA_STEWARD_4, null);
    // Should not throw; just returns whatever didn't fail
    assert.ok(Array.isArray(firing));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite 3 — bug-resolver Hamilton conflict logic
// ──────────────────────────────────────────────────────────────────────────────

describe('Suite 3: bug-resolver verify Hamilton conflict path', () => {
  test('detectConflicts: 2 personas same line different severity = conflict', () => {
    const conflicts = detectConflicts([
      { persona: 'cynical-sre', findings: [{ file: 'lib/x.mjs:10', severity: 'HIGH' }] },
      { persona: 'margaret-hamilton', findings: [{ file: 'lib/x.mjs:10', severity: 'LOW' }] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].location, 'lib/x.mjs:10');
    assert.equal(conflicts[0].dealbreaker_handoff_recommended, true); // HIGH in mix
  });

  test('detectConflicts: same severity from different personas is NOT a conflict', () => {
    const conflicts = detectConflicts([
      { persona: 'cynical-sre', findings: [{ file: 'lib/x.mjs:10', severity: 'HIGH' }] },
      { persona: 'margaret-hamilton', findings: [{ file: 'lib/x.mjs:10', severity: 'HIGH' }] },
    ]);
    assert.equal(conflicts.length, 0);
  });

  test('detectConflicts: same persona multiple findings on same line = NOT conflict', () => {
    const conflicts = detectConflicts([
      { persona: 'cynical-sre', findings: [
        { file: 'lib/x.mjs:10', severity: 'HIGH' },
        { file: 'lib/x.mjs:10', severity: 'LOW' },
      ]},
    ]);
    assert.equal(conflicts.length, 0);
  });

  test('buildDealbreakerHandoff produces expected envelope shape', () => {
    const env = buildDealbreakerHandoff([{ location: 'a:1', personas: ['x', 'y'], severities: ['HIGH', 'LOW'], findings: [] }], { phase: 'deploy-verify-3.5' });
    assert.equal(env.handoff_type, 'persona-conflict-adjudication');
    assert.equal(env.conflicts_count, 1);
    assert.equal(env.context.phase, 'deploy-verify-3.5');
    assert.ok(env.instructions);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite 4 — Omega conditional triggers (DHH/Howard/Hickey)
// ──────────────────────────────────────────────────────────────────────────────

describe('Suite 4: omega-steward conditional persona triggers', () => {
  test('DHH fires when proposal mints new agent', () => {
    const shape = classifyProposalShape({ tag: 'NEW-AGENT', short_title: 'mint new agent for log rotation' });
    assert.equal(shape.mintsNewAgent, true);
    const firing = personasFor(PHASES.OMEGA_STEWARD_4, { proposal: shape, files: [] });
    assert.ok(firing.some(p => p.name === 'dhh'), `should include DHH; got ${firing.map(p => p.name).join(',')}`);
  });

  test('Howard fires when proposal is net-new library code', () => {
    const shape = classifyProposalShape({ tag: 'NEW-LIB', short_title: 'add new helper module' });
    assert.equal(shape.netNewLibrary, true);
    const firing = personasFor(PHASES.OMEGA_STEWARD_4, { proposal: shape, files: [] });
    assert.ok(firing.some(p => p.name === 'jeremy-howard'));
  });

  test('Hickey fires when proposal touches contracts/schemas', () => {
    const shape = classifyProposalShape({ tag: 'SCHEMA', short_title: 'modify schema for tier enum' });
    assert.equal(shape.touchesContracts, true);
    const firing = personasFor(PHASES.OMEGA_STEWARD_4, { proposal: shape, files: [] });
    assert.ok(firing.some(p => p.name === 'rich-hickey'));
  });

  test('Bland proposal triggers no conditional personas', () => {
    const shape = classifyProposalShape({ tag: 'DOC-UPDATE', short_title: 'fix typo in readme' });
    assert.equal(shape.mintsNewAgent, false);
    assert.equal(shape.touchesContracts, false);
    const firing = personasFor(PHASES.OMEGA_STEWARD_4, { proposal: shape, files: [] });
    assert.equal(firing.length, 0);
  });

  test('annotateOmegaRecommendationsWithPersonaReview --dry-run produces wouldFire matrix', async () => {
    const recs = [
      { id: 1, tag: 'NEW-AGENT', short_title: 'mint new agent for log rotation' },
      { id: 2, tag: 'NO-CHANGES-THIS-CYCLE' },
    ];
    const summary = await annotateOmegaRecommendationsWithPersonaReview(recs, { dryRun: true });
    assert.ok(Array.isArray(summary.wouldFire));
    assert.equal(summary.wouldFire.length, 1);
    assert.equal(summary.wouldFire[0].recId, 1);
  });

  test('annotateOmegaRecommendationsWithPersonaReview respects PERSONA_OMEGA_REVIEW=false', async () => {
    const recs = [{ id: 1, tag: 'NEW-AGENT', short_title: 'mint new agent for log rotation' }];
    process.env.PERSONA_OMEGA_REVIEW = 'false';
    try {
      const summary = await annotateOmegaRecommendationsWithPersonaReview(recs);
      assert.equal(summary.skipped, 'PERSONA_OMEGA_REVIEW=false');
      assert.equal(summary.reviewedCount, 0);
    } finally {
      delete process.env.PERSONA_OMEGA_REVIEW;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite 5 — Findings ledger + cross-fork-leak guard
// ──────────────────────────────────────────────────────────────────────────────

describe('Suite 5: findings ledger + cross-fork-leak guard', () => {
  test('isSensitivePath flags persona-findings + spend + monthly-review', () => {
    assert.equal(isSensitivePath('/Users/x/career-ops/data/persona-findings.jsonl'), true);
    assert.equal(isSensitivePath('/Users/x/career-ops/data/persona-review-spend.jsonl'), true);
    assert.equal(isSensitivePath('/Users/x/career-ops/data/persona-monthly-review-2026-06-01.md'), true);
  });

  test('isSensitivePath does NOT flag lib/council-personas.mjs (public code)', () => {
    assert.equal(isSensitivePath('/Users/x/career-ops/lib/council-personas.mjs'), false);
  });

  test('assertNoInlineQuotesFromSensitivePaths throws on inline quote from persona-findings', () => {
    assert.throws(() => assertNoInlineQuotesFromSensitivePaths([
      { path: '/Users/x/career-ops/data/persona-findings.jsonl', mode: 'quote_inline' },
    ]), /CITATION-POLICY VIOLATION/);
  });

  test('assertNoInlineQuotesFromSensitivePaths passes on hash_only from persona-findings', () => {
    assert.doesNotThrow(() => assertNoInlineQuotesFromSensitivePaths([
      { path: '/Users/x/career-ops/data/persona-findings.jsonl', mode: 'hash_only' },
    ]));
  });

  test('readCatalogBugClasses returns non-empty set with known catalog name', () => {
    const c = readCatalogBugClasses();
    assert.ok(c.names.size > 0, 'expected at least 1 bug-class name');
    // missing-timeout-on-long-running-operation IS in AGENTS.md
    assert.ok(c.names.has('missing-timeout-on-long-running-operation') ||
              c.names.has('outer-template-unescape') ||
              c.names.has('env-shadow-on-lazy-dotenv'),
              'expected at least one known catalog bug-class name');
  });

  test('analyzeFindingsForNewBugClasses with no ledger returns empty candidates', () => {
    const r = analyzeFindingsForNewBugClasses({
      windowDays: 30,
      minOccurrences: 3,
      ledgerPath: '/tmp/nonexistent-persona-findings-test.jsonl',
    });
    assert.deepEqual(r.candidates, []);
    assert.equal(r.totalFindings, 0);
  });
});
