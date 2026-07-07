// tests/drawer-content-sanitizer.test.mjs
//
// Spec: lib/drawer-content-sanitizer.mjs
// Rule classes: Spanish residues, overclaims, first-person voice,
// third-person candidate leaks (blind-review #13, 2026-07-07), xGE
// expansion. Idempotent: running twice = same output.
//
// 2026-07-07 voice-direction change (blind-review #13): the voice passes now
// rewrite BOTH first-person slips AND third-person candidate references to
// SECOND person ("your background"), matching the drawer chrome ("How well
// your background fits this role"). Pre-2026-07-07 this file asserted
// third-person ("Mitchell's background") output — those expectations were
// updated, not grandfathered.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDrawerText,
  sanitizeObjectStrings,
  stripSpanishResidues,
  neutralizeOverclaims,
  thirdPersonVoice,
  secondPersonVoice,
  findDrawerContentIssues,
} from '../lib/drawer-content-sanitizer.mjs';

describe('stripSpanishResidues', () => {
  test('Nivel detectado → Detected level', () => {
    const out = stripSpanishResidues('**Nivel detectado:** Mid-to-senior IC.');
    assert.match(out, /Detected level:/);
    assert.doesNotMatch(out, /Nivel detectado/);
  });

  test('Nivel detectado (no colon, lowercase)', () => {
    const out = stripSpanishResidues('nivel detectado mid-to-senior');
    assert.match(out, /Detected level/);
  });

  test('Recomendación Final → Final Recommendation', () => {
    const out = stripSpanishResidues('**Recomendación Final:** Aplicar.');
    assert.match(out, /Final Recommendation:/);
  });

  test('handles accented + unaccented Spanish o', () => {
    const out1 = stripSpanishResidues('Recomendación');
    const out2 = stripSpanishResidues('Recomendacion');
    assert.match(out1, /Recommendation/);
    assert.match(out2, /Recommendation/);
  });

  test('no Spanish content → pass-through', () => {
    const out = stripSpanishResidues('Pure English text with no residues.');
    assert.equal(out, 'Pure English text with no residues.');
  });

  test('null/undefined → empty string', () => {
    assert.equal(stripSpanishResidues(null), '');
    assert.equal(stripSpanishResidues(undefined), '');
  });
});

describe('neutralizeOverclaims', () => {
  test('Pure FDE/Applied AI archetype hit → archetype-adjacent', () => {
    const out = neutralizeOverclaims('WHY THIS SCORE: Pure FDE/Applied AI archetype hit');
    assert.match(out, /Archetype-adjacent/i);
    assert.doesNotMatch(out, /Pure FDE\/Applied AI archetype hit/);
  });

  test('Pure A2b archetype hit', () => {
    const out = neutralizeOverclaims('Pure A2b archetype hit');
    assert.match(out, /Archetype-adjacent/i);
  });

  test('Pure Solutions Architect archetype hit', () => {
    const out = neutralizeOverclaims('Pure Solutions Architect archetype hit');
    assert.match(out, /Archetype-adjacent/i);
  });

  test('Apply HIGH PRIORITY → Apply — review evidence', () => {
    const out = neutralizeOverclaims('Apply HIGH PRIORITY');
    assert.match(out, /Apply — review evidence/);
  });

  test('All must-haves clear → Must-haves: reviewed', () => {
    const out = neutralizeOverclaims('All must-haves clear');
    assert.match(out, /Must-haves: reviewed/);
  });

  test('honest neutral text → pass-through', () => {
    const out = neutralizeOverclaims('Tier B archetype with direct title match');
    assert.equal(out, 'Tier B archetype with direct title match');
  });
});

describe('voice passes — second person (blind-review #13)', () => {
  test('WHY THIS ALIGNS WITH MY GOALS → YOUR GOALS', () => {
    const out = thirdPersonVoice('WHY THIS ALIGNS WITH MY GOALS');
    assert.match(out, /WHY THIS ALIGNS WITH YOUR GOALS/);
  });

  test('lowercase phrase variant', () => {
    const out = thirdPersonVoice('Why this aligns with my goals');
    assert.match(out, /Why this aligns with your goals/);
  });

  test('my background → your background', () => {
    const out = thirdPersonVoice('Looking at this role I see my background fits');
    assert.match(out, /your background/);
    assert.doesNotMatch(out, /\bmy background\b/);
  });

  test("Mitchell's possessive → your", () => {
    const out = thirdPersonVoice("Mitchell's career arc and strategic positioning");
    assert.equal(out, 'Your career arc and strategic positioning');
  });

  test('Mitchell + verb agreement (has → have, brings → bring)', () => {
    const out = thirdPersonVoice('Mitchell has shipped two agents. Mitchell brings newsroom speed.');
    assert.match(out, /You have shipped two agents/);
    assert.match(out, /You bring newsroom speed/);
    assert.doesNotMatch(out, /\bMitchell\b/);
  });

  test('-es and -ies verb inflection (matches → match, carries → carry) — Qodo PR #402', () => {
    const out = thirdPersonVoice('Mitchell matches the spec. Mitchell carries the narrative.');
    assert.match(out, /You match the spec/);
    assert.match(out, /You carry the narrative/);
    assert.doesNotMatch(out, /matche\b/);
    assert.doesNotMatch(out, /carrie\b/);
  });

  test('his Google xGE role → your Google xGE role (finding #13 verbatim case)', () => {
    const out = thirdPersonVoice('almost a verbatim description of his Google xGE role');
    assert.match(out, /your Google xGE role/);
    assert.doesNotMatch(out, /\bhis\b/);
  });

  test('HM-content pronoun pass-through — bare he/his about the hiring manager is untouched', () => {
    const input = 'The HM: he leads the team; his background is in sales at Oracle.';
    assert.equal(thirdPersonVoice(input), input);
  });

  test('secondPersonVoice adds xGE expansion', () => {
    const out = secondPersonVoice('Mitchell built two agents at xGE.');
    assert.match(out, /You built two agents at xGE \(Cross-Google Engineering\)\./);
  });
});

describe('xGE expansion', () => {
  test('first use expanded, later uses left bare', () => {
    const out = sanitizeDrawerText('xGE Connects drew record attendance. xGE approvals overhauled.');
    assert.match(out, /^xGE \(Cross-Google Engineering\) Connects/);
    assert.match(out, /xGE approvals overhauled/);
    assert.equal((out.match(/Cross-Google Engineering/g) || []).length, 1);
  });

  test('already-expanded text untouched (idempotent)', () => {
    const input = 'xGE (Cross-Google Engineering) Connects. xGE approvals.';
    assert.equal(sanitizeDrawerText(input), input);
  });
});

describe('sanitizeDrawerText — combined passes', () => {
  test('Spanish + overclaim + voice in same string', () => {
    const out = sanitizeDrawerText(
      '**Nivel detectado:** Pure A2b archetype hit. WHY THIS ALIGNS WITH MY GOALS: solid.'
    );
    assert.match(out, /Detected level:/);
    assert.match(out, /Archetype-adjacent/i);
    assert.match(out, /WHY THIS ALIGNS WITH YOUR GOALS/);
  });

  test('idempotent — running twice = same as once', () => {
    const input = '**Nivel detectado:** Mid-senior. Pure FDE archetype hit. WHY THIS ALIGNS WITH MY GOALS:';
    const once = sanitizeDrawerText(input);
    const twice = sanitizeDrawerText(once);
    assert.equal(once, twice);
  });

  test('idempotent across third-person + xGE rules', () => {
    const input = "Mitchell's background maps cleanly. Mitchell has shipped two agents at xGE. His Google xGE experience is the anchor.";
    const once = sanitizeDrawerText(input);
    const twice = sanitizeDrawerText(once);
    assert.equal(once, twice);
    assert.doesNotMatch(once, /\bMitchell\b/);
  });

  test('sentence-start capitalization after rewrites', () => {
    const out = sanitizeDrawerText('Strong signal. Mitchell has range.');
    assert.match(out, /Strong signal\. You have range\./);
  });
});

describe('sanitizeObjectStrings', () => {
  test('recurses into nested object string fields', () => {
    const input = {
      tldr: '**Nivel detectado:** L4',
      angles: [{ quote: 'Pure A2b archetype hit', why: 'WHY THIS ALIGNS WITH MY GOALS' }],
      meta: { score: 4.5, label: 'my background' },
    };
    const out = sanitizeObjectStrings(input);
    assert.match(out.tldr, /Detected level:/);
    assert.match(out.angles[0].quote, /Archetype-adjacent/i);
    assert.match(out.angles[0].why, /YOUR GOALS/);
    assert.match(out.meta.label, /your background/i);
    assert.equal(out.meta.score, 4.5); // numeric pass-through
  });

  test('null/undefined pass-through', () => {
    assert.equal(sanitizeObjectStrings(null), null);
    assert.equal(sanitizeObjectStrings(undefined), undefined);
  });

  test('arrays of strings', () => {
    const out = sanitizeObjectStrings(['**Nivel detectado:**', 'Pure FDE archetype hit', 'honest']);
    assert.match(out[0], /Detected level:/);
    assert.match(out[1], /Archetype-adjacent/i);
    assert.equal(out[2], 'honest');
  });
});

describe('findDrawerContentIssues — telemetry', () => {
  test('returns categorized matches', () => {
    const out = findDrawerContentIssues(
      '**Nivel detectado:** Pure A2b archetype hit. WHY THIS ALIGNS WITH MY GOALS:'
    );
    assert.ok(out.spanish.length > 0, 'spanish residues detected');
    assert.ok(out.overclaims.length > 0, 'overclaims detected');
    assert.ok(out.firstPerson.length > 0, 'first-person detected');
  });

  test('third-person + unexpanded-xGE buckets', () => {
    const out = findDrawerContentIssues('his Google xGE role and Mitchell has range at xGE');
    assert.ok(out.thirdPerson.length > 0, 'third-person leaks detected');
    assert.ok(out.xge.length > 0, 'unexpanded xGE detected');
  });

  test('clean text → empty issue lists', () => {
    const out = findDrawerContentIssues('Your career arc with honest framing');
    assert.equal(out.spanish.length, 0);
    assert.equal(out.overclaims.length, 0);
    assert.equal(out.firstPerson.length, 0);
    assert.equal(out.thirdPerson.length, 0);
    assert.equal(out.xge.length, 0);
  });
});
