// tests/drawer-content-sanitizer.test.mjs
//
// Spec: lib/drawer-content-sanitizer.mjs
// 6 rule classes: Spanish residues, overclaims, first-person voice.
// Idempotent: running twice = same output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDrawerText,
  sanitizeObjectStrings,
  stripSpanishResidues,
  neutralizeOverclaims,
  thirdPersonVoice,
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

describe('thirdPersonVoice', () => {
  test('WHY THIS ALIGNS WITH MY GOALS → MITCHELL\'S GOALS', () => {
    const out = thirdPersonVoice('WHY THIS ALIGNS WITH MY GOALS');
    assert.match(out, /WHY THIS ALIGNS WITH MITCHELL'S GOALS/);
  });

  test('lowercase phrase variant', () => {
    const out = thirdPersonVoice('Why this aligns with my goals');
    assert.match(out, /Why this aligns with Mitchell's goals/);
  });

  test('my background → Mitchell\'s background', () => {
    const out = thirdPersonVoice('Looking at this role I see my background fits');
    assert.match(out, /Mitchell's background/);
    assert.doesNotMatch(out, /\bmy background\b/);
  });

  test('honest third-person text → pass-through', () => {
    const out = thirdPersonVoice("Mitchell's career arc and strategic positioning");
    assert.equal(out, "Mitchell's career arc and strategic positioning");
  });
});

describe('sanitizeDrawerText — combined passes', () => {
  test('Spanish + overclaim + voice in same string', () => {
    const out = sanitizeDrawerText(
      '**Nivel detectado:** Pure A2b archetype hit. WHY THIS ALIGNS WITH MY GOALS: solid.'
    );
    assert.match(out, /Detected level:/);
    assert.match(out, /Archetype-adjacent/i);
    assert.match(out, /WHY THIS ALIGNS WITH MITCHELL'S GOALS/);
  });

  test('idempotent — running twice = same as once', () => {
    const input = '**Nivel detectado:** Mid-senior. Pure FDE archetype hit. WHY THIS ALIGNS WITH MY GOALS:';
    const once = sanitizeDrawerText(input);
    const twice = sanitizeDrawerText(once);
    assert.equal(once, twice);
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
    assert.match(out.angles[0].why, /MITCHELL'S GOALS/);
    assert.match(out.meta.label, /Mitchell's background/);
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

  test('clean text → empty issue lists', () => {
    const out = findDrawerContentIssues("Mitchell's career arc with honest framing");
    assert.equal(out.spanish.length, 0);
    assert.equal(out.overclaims.length, 0);
    assert.equal(out.firstPerson.length, 0);
  });
});
