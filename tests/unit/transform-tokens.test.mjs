// Unit tests for scripts/transform-tokens.mjs — ARCH.41 finding-007.
// Critical subset of the full 27-test matrix in spec §2.6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify, hashMaster, transform,
  emitHeartbeatJson, emitDashboardMjs, emitTokensCss,
  validateMaster, diffStrings, main,
} from '../../scripts/transform-tokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

function loadMaster() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'tokens/master.json'), 'utf8'));
}

test('1. transform produces all 4 outputs (non-empty + hash present)', () => {
  const t = transform(loadMaster());
  assert.ok(t.heartbeat.length > 100, 'heartbeat output should be non-trivial');
  assert.ok(t.dashboardMjs.length > 100, 'dashboard-mjs output should be non-trivial');
  assert.ok(t.tokensCss.length > 100, 'tokens-css output should be non-trivial');
  assert.match(t.dashboardLock, /^[0-9a-f]{64}\n$/, 'lock = sha256 + newline');
  assert.match(t.hash, /^[0-9a-f]{64}$/, 'hash is 64-char hex');
});

test('2. transform is pure — same input, same output', () => {
  const m = loadMaster();
  const a = transform(m);
  const b = transform(m);
  assert.equal(a.heartbeat, b.heartbeat);
  assert.equal(a.dashboardMjs, b.dashboardMjs);
  assert.equal(a.tokensCss, b.tokensCss);
  assert.equal(a.hash, b.hash);
});

test('4. --check passes against repo HEAD', () => {
  const result = execSync('node scripts/transform-tokens.mjs --check', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // Should exit 0 — no output expected on success
  assert.equal(result.trim(), '');
});

test('17. CSS output is dark-default (first :root contains dark values)', () => {
  const css = emitTokensCss(loadMaster(), 'abc123');
  // First :root block (NOT inside @media or [data-theme]) should set dark vars
  const firstRoot = css.match(/:root \{[\s\S]*?\}/)[0];
  assert.ok(firstRoot.includes('--bg: #06070d'), 'first :root should have dark --bg');
  assert.ok(firstRoot.includes('color-scheme: dark'), 'first :root should declare dark color-scheme');
});

test('typography role sentinel preserved + sole key', () => {
  const m = loadMaster();
  assert.ok(m.typography.role.$reserved, 'typography.role.$reserved must exist');
  assert.equal(Object.keys(m.typography.role).length, 1, 'typography.role has only $reserved');
});

test('validateMaster throws on extra typography.role keys', () => {
  const m = loadMaster();
  m.typography.role.heading = '#fff';
  assert.throws(() => validateMaster(m), /typography\.role/);
});

test('validateMaster throws on unknown top-level category', () => {
  const m = loadMaster();
  m.motion = { speed: 'fast' };
  assert.throws(() => validateMaster(m), /Unknown top-level category/);
});

test('CSS_VAR_MAP --bg path resolves correctly for both modes', () => {
  const m = loadMaster();
  const css = emitTokensCss(m, 'xyz');
  // Dark first
  assert.match(css, /:root \{[\s\S]*--bg: #06070d/);
  // Light explicit-opt-in second
  assert.match(css, /:root\[data-theme="light"\] \{[\s\S]*--bg: #ffffff/);
});

test('email subtree passes through to derived heartbeat-tokens.json unchanged', () => {
  const m = loadMaster();
  const out = JSON.parse(emitHeartbeatJson(m, 'h'));
  assert.deepEqual(out.email, m.email, 'email subtree must round-trip');
});

test('canonicalStringify sorts keys alphabetically', () => {
  const out = canonicalStringify({ z: 1, a: 2, m: 3 });
  const lines = out.split('\n');
  assert.match(lines[1], /"a":/);
  assert.match(lines[2], /"m":/);
  assert.match(lines[3], /"z":/);
});
