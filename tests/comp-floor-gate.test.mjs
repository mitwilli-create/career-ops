// tests/comp-floor-gate.test.mjs
//
// Spec: data/spec-triage-eval-quality-gate-2026-05-29.md § 6
// Verifies that lib/comp-floor-gate.mjs:
//   - extracts comp from eval report text (multi-format regex)
//   - compares to floor (location-aware)
//   - returns BELOW_FLOOR / ABOVE_FLOOR / unknown
//   - reads floors via layered resolver: config/profile.yml → example.yml → hardcoded
//   - respects override mechanism (data/triage-overrides.json)
//   - respects DISABLE_COMP_FLOOR_GATE env kill switch
//   - does NOT demote on ambiguous/missing comp (gate=unknown is correct behavior)

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERRIDES_PATH = join(ROOT, 'data', 'triage-overrides.json');
const OVERRIDES_BACKUP = join(ROOT, 'data', 'triage-overrides.json.compfloor-backup');

let mod;

function restoreEnv() {
  delete process.env.DISABLE_COMP_FLOOR_GATE;
}

before(async () => {
  if (existsSync(OVERRIDES_PATH)) {
    writeFileSync(OVERRIDES_BACKUP, readFileSync(OVERRIDES_PATH));
  }
  mkdirSync(dirname(OVERRIDES_PATH), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ overrides: [] }, null, 2));
  mod = await import('../lib/comp-floor-gate.mjs');
});

after(() => {
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

describe('gateCompFloor — extraction + comparison', () => {
  test('Base salary range $145K-$165K + location remote → BELOW_FLOOR', () => {
    const report = `# Eval

## D) Comp and Demand
Base salary: $145K-$165K per Glassdoor. Equity 0.05%-0.1%.`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'BELOW_FLOOR');
    assert.equal(result.decision, 'SKIP');
    assert.equal(result.floor, 160000);
    assert.equal(result.baseLow, 145000);
  });

  test('Base salary $110K-$210K + location remote → ABOVE_FLOOR', () => {
    const report = `# Eval

## D) Comp and Demand
Base salary: $110K-$210K range. Strong total comp.`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'ABOVE_FLOOR');
    assert.equal(result.baseLow, 175000);
  });

  test('Seattle location with $110K base → BELOW_FLOOR (Seattle floor is $120K)', () => {
    const report = `## Comp
Base: $110K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'seattle' });
    assert.equal(result.gate, 'BELOW_FLOOR');
    assert.equal(result.floor, 120000);
  });

  test('SF location with $130K base → BELOW_FLOOR (SF floor is $140K)', () => {
    const report = `Comp listed at $130K base salary.`;
    const result = mod.gateCompFloor({ reportText: report, location: 'sf' });
    assert.equal(result.gate, 'BELOW_FLOOR');
    assert.equal(result.floor, 140000);
  });

  test('NYC location with $230K base → ABOVE_FLOOR (NYC floor is $150K)', () => {
    const report = `Salary: $230K.`;
    const result = mod.gateCompFloor({ reportText: report, location: 'nyc' });
    assert.equal(result.gate, 'ABOVE_FLOOR');
    assert.equal(result.floor, 150000);
  });

  test('Unknown location defaults to remote floor', () => {
    const report = `Base salary: $150K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'mars' });
    assert.equal(result.gate, 'BELOW_FLOOR');
    assert.equal(result.floor, 160000);
  });

  test('No comp section → gate=unknown (does NOT demote)', () => {
    const report = `# Eval\n\n## A) Role Summary\nDescribed role.\n\n## B) CV Match\nMatched.`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'unknown');
    assert.notEqual(result.decision, 'SKIP', 'unknown gate must not auto-SKIP — surfaces for human review');
  });

  test('Empty report → gate=unknown', () => {
    const result = mod.gateCompFloor({ reportText: '', location: 'remote' });
    assert.equal(result.gate, 'unknown');
  });
});

describe('gateCompFloor — multi-format extraction', () => {
  test('"base salary" prefix', () => {
    const report = `base salary $150K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'BELOW_FLOOR');
  });

  test('"Salary:" prefix', () => {
    const report = `Salary: $110K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'ABOVE_FLOOR');
  });

  test('Range with hyphen', () => {
    const report = `Base salary $140K-$100K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.equal(result.gate, 'BELOW_FLOOR');
    assert.equal(result.baseLow, 140000);
  });
});

describe('gateCompFloor — override mechanism', () => {
  test('rowNum in overrides for comp-floor → no demotion despite BELOW_FLOOR', () => {
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 8888, gate: 'comp-floor', reason: 'pre-IPO equity heavy', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const report = `Base salary: $145K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote', rowNum: 8888 });
    assert.notEqual(result.decision, 'SKIP', 'override should suppress SKIP decision');
    assert.ok(result.overridden);
  });

  test('rowNum NOT in overrides → demotion fires normally', () => {
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 8888, gate: 'comp-floor', reason: 'X', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const report = `Base salary: $145K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote', rowNum: 8887 });
    assert.equal(result.decision, 'SKIP');
  });

  test('override for different gate (hard-disqualifier) does NOT bypass comp gate', () => {
    writeFileSync(OVERRIDES_PATH, JSON.stringify({
      overrides: [
        { rowNum: 8888, gate: 'hard-disqualifier', reason: 'X', addedAt: '2026-05-29' }
      ]
    }, null, 2));
    const report = `Base salary: $145K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote', rowNum: 8888 });
    assert.equal(result.decision, 'SKIP');
  });
});

describe('gateCompFloor — env kill switch', () => {
  test('DISABLE_COMP_FLOOR_GATE=true → no demotion', () => {
    process.env.DISABLE_COMP_FLOOR_GATE = 'true';
    const report = `Base salary: $145K`;
    const result = mod.gateCompFloor({ reportText: report, location: 'remote' });
    assert.notEqual(result.decision, 'SKIP');
    assert.equal(result.disabled, true);
  });
});

describe('gateCompFloor — layered resolver', () => {
  test('resolveCompFloor returns location-keyed object with all 4 keys', () => {
    const floors = mod.resolveCompFloor();
    assert.ok(typeof floors.remote === 'number', 'remote floor must be number');
    assert.ok(typeof floors.seattle === 'number', 'seattle floor must be number');
    assert.ok(typeof floors.sf === 'number', 'sf floor must be number');
    assert.ok(typeof floors.nyc === 'number', 'nyc floor must be number');
  });

  test('hardcoded fallbacks match triage-prompt values', () => {
    const floors = mod.resolveCompFloor();
    // These are the spec-mandated defaults from batch/triage-prompt.md line 25
    assert.ok(floors.remote >= 160000, 'remote floor should be ≥$100K');
    assert.ok(floors.seattle >= 120000, 'seattle floor should be ≥$120K');
    assert.ok(floors.sf >= 140000, 'sf floor should be ≥$140K');
    assert.ok(floors.nyc >= 150000, 'nyc floor should be ≥$150K');
  });
});
