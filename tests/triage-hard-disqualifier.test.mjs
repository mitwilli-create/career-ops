// tests/triage-hard-disqualifier.test.mjs
//
// Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 5
// Verifies that lib/triage-hard-disqualifier-filter.mjs deterministically catches:
//   - mandatory-leetcode-or-systems-design
//   - mandatory-python-production-engineering (archetype-exempt: A2a)
//   - mandatory-former-pm-experience
//   - mandatory-former-em
//   - leadership-experience-required-heavy
//   - pure-cloud-devops-mlops-primary
// PLUS: override mechanism (data/triage-overrides.json) + env kill switch + no-false-positives.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERRIDES_PATH = join(ROOT, 'data', 'triage-overrides.json');
const OVERRIDES_BACKUP = join(ROOT, 'data', 'triage-overrides.json.test-backup');

let mod;

function restoreEnv() {
  delete process.env.DISABLE_HARD_DISQUALIFIER_FILTER;
}

function backupOverrides() {
  if (existsSync(OVERRIDES_PATH)) {
    const fs = require('node:fs');
  }
}

before(async () => {
  // Backup any existing overrides file
  if (existsSync(OVERRIDES_PATH)) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(OVERRIDES_BACKUP, readFileSync(OVERRIDES_PATH));
  }
  // Ensure data dir exists
  mkdirSync(dirname(OVERRIDES_PATH), { recursive: true });
  // Start with empty overrides
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ overrides: [] }, null, 2));
  mod = await import('../lib/triage-hard-disqualifier-filter.mjs');
});

after(async () => {
  // Restore backup or remove test file
  const { readFileSync, writeFileSync, unlinkSync } = await import('node:fs');
  if (existsSync(OVERRIDES_BACKUP)) {
    writeFileSync(OVERRIDES_PATH, readFileSync(OVERRIDES_BACKUP));
    unlinkSync(OVERRIDES_BACKUP);
  } else {
    if (existsSync(OVERRIDES_PATH)) unlinkSync(OVERRIDES_PATH);
  }
  restoreEnv();
});

beforeEach(() => {
  restoreEnv();
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ overrides: [] }, null, 2));
});

describe('applyHardDisqualifiers — rule coverage', () => {
  test('JD with mandatory Python production engineering → SKIP', () => {
    const jd = 'We need an engineer with 5+ years of Python production experience. Deep expertise required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('mandatory-python-production-engineering'),
      'expected mandatory-python-production-engineering in violations, got ' + JSON.stringify(result.violations));
  });

  test('Same Python JD but archetype A2a → ADVANCE (exempt)', () => {
    const jd = 'We need an engineer with 5+ years of Python production experience. Deep expertise required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2a' });
    assert.equal(result.decision, 'ADVANCE');
    assert.deepEqual(result.violations, []);
  });

  test('JD with 10+ years leadership track record → SKIP', () => {
    const jd = 'This role requires 10+ years leadership track record at senior leadership level.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('leadership-experience-required-heavy'));
  });

  test('JD with mandatory leetcode → SKIP', () => {
    const jd = 'Strong candidate has solved leetcode mediums and is comfortable with live coding.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('mandatory-leetcode-or-systems-design'));
  });

  test('JD with mandatory systems design interview round → SKIP', () => {
    const jd = 'Our interview process includes a systems design round and a coding interview.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('mandatory-leetcode-or-systems-design'));
  });

  test('JD with former PM (5+ years) → SKIP', () => {
    const jd = 'Looking for a candidate with 5+ years as a product manager. Former PM experience required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('mandatory-former-pm-experience'));
  });

  test('JD with 7+ years engineering management → SKIP', () => {
    const jd = 'Must have 7+ years engineering management experience leading large teams.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('mandatory-former-em'));
  });

  test('JD with mlops engineer / kubernetes admin → SKIP', () => {
    const jd = 'We are hiring a Kubernetes admin and MLOps engineer to manage our pipelines.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.includes('pure-cloud-devops-mlops-primary'));
  });

  test('Normal A2b JD with no disqualifiers → ADVANCE', () => {
    const jd = `We are looking for an AI Enablement Lead to support our editorial team.
The ideal candidate has experience with content workflows, prompt engineering, and
documentation systems. Strong writing and communication skills required.`;
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'ADVANCE');
    assert.deepEqual(result.violations, []);
  });

  test('JD with multiple violations → SKIP with all listed', () => {
    const jd = `We need 5+ years Python production experience PLUS 10+ years leadership track record.
Live coding interview required.`;
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'SKIP');
    assert.ok(result.violations.length >= 2,
      'expected ≥2 violations, got ' + result.violations.length + ': ' + JSON.stringify(result.violations));
  });
});

describe('applyHardDisqualifiers — override mechanism', () => {
  test('rowNum in overrides → ADVANCE despite violation', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 9999, gate: 'hard-disqualifier', reason: 'manual review approved', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const jd = '5+ years Python production experience required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b', rowNum: 9999 });
    assert.equal(result.decision, 'ADVANCE');
    assert.ok(result.overridden, 'expected overridden: true');
  });

  test('rowNum NOT in overrides → SKIP fires normally', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 9999, gate: 'hard-disqualifier', reason: 'manual', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const jd = '5+ years Python production experience required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b', rowNum: 9998 });
    assert.equal(result.decision, 'SKIP');
  });

  test('override for different gate (comp-floor) does NOT bypass hard-disqualifier', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 9999, gate: 'comp-floor', reason: 'low comp ok', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const jd = '5+ years Python production experience required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b', rowNum: 9999 });
    assert.equal(result.decision, 'SKIP', 'gate-specific override should not bleed across gates');
  });
});

describe('applyHardDisqualifiers — env kill switch', () => {
  test('DISABLE_HARD_DISQUALIFIER_FILTER=true → ADVANCE despite violation', () => {
    process.env.DISABLE_HARD_DISQUALIFIER_FILTER = 'true';
    const jd = '5+ years Python production experience required. Live coding interview.';
    const result = mod.applyHardDisqualifiers({ jdText: jd, archetype: 'A2b' });
    assert.equal(result.decision, 'ADVANCE');
    assert.equal(result.disabled, true);
  });
});

describe('applyHardDisqualifiers — edge cases', () => {
  test('empty JD → ADVANCE no violations', () => {
    const result = mod.applyHardDisqualifiers({ jdText: '', archetype: 'A2b' });
    assert.equal(result.decision, 'ADVANCE');
    assert.deepEqual(result.violations, []);
  });

  test('null JD → ADVANCE no violations (graceful)', () => {
    const result = mod.applyHardDisqualifiers({ jdText: null, archetype: 'A2b' });
    assert.equal(result.decision, 'ADVANCE');
  });

  test('archetype undefined → applies all rules (no exempts)', () => {
    const jd = '5+ years Python production experience required.';
    const result = mod.applyHardDisqualifiers({ jdText: jd });
    assert.equal(result.decision, 'SKIP');
  });
});
