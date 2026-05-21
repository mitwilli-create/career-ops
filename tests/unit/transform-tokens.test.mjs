// Unit tests for scripts/transform-tokens.mjs — ARCH.41 + ARCH.42.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify, hashMaster, transform,
  emitHeartbeatJson, emitDashboardMjs, emitTokensCss, emitTypographyRolesMjs,
  validateMaster, diffStrings, main,
} from '../../scripts/transform-tokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

function loadMaster() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'tokens/master.json'), 'utf8'));
}

test('1. transform produces all 5 outputs (non-empty + hash present)', () => {
  const t = transform(loadMaster());
  assert.ok(t.heartbeat.length > 100, 'heartbeat output should be non-trivial');
  assert.ok(t.dashboardMjs.length > 100, 'dashboard-mjs output should be non-trivial');
  assert.ok(t.tokensCss.length > 100, 'tokens-css output should be non-trivial');
  assert.ok(t.typographyRoles.length > 100, 'typography-roles output should be non-trivial');
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
  assert.equal(a.typographyRoles, b.typographyRoles);
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

test('ARCH.42 — typography.role has 10 named roles + invariants hold', () => {
  const m = loadMaster();
  const role = m.typography.role;
  const names = Object.keys(role).filter(k => !k.startsWith('$') && !k.startsWith('_'));
  // 10 roles per dealbreaker fix #3 (body-large added to base 9)
  assert.equal(names.length, 10, `expected 10 roles, got ${names.length}: ${names.join(',')}`);
  // Required role names
  for (const n of ['h1', 'h2', 'h3', 'section-label', 'body-large', 'body', 'body-small', 'meta', 'code', 'button-label']) {
    assert.ok(role[n], `missing required role: ${n}`);
  }
  // H2 email size identity lock — Council Decision C / ADR-0007
  assert.equal(role.h2.fontSize.email, '16px', 'H2 email fontSize is identity-locked to 16px');
  assert.equal(role.h2.fontSize.web, '18px', 'H2 web fontSize is 18px (dashboard desktop)');
  // body dual-encoding — dealbreaker fix #2
  assert.equal(role.body.fontSize.email, '13px', 'body email fontSize locked to 13px');
  assert.equal(role.body.fontSize.web, '14px', 'body web fontSize locked to 14px');
  // body-large is the dealbreaker-added role #10
  assert.equal(role['body-large'].fontWeight, '600');
  assert.equal(role['body-large'].textTransform, 'none');
});

test('ARCH.42 — validateMaster throws when role count exceeds 10', () => {
  const m = loadMaster();
  m.typography.role.eleventh = {
    fontSize: '10px', fontWeight: '400', lineHeight: '1', letterSpacing: 'normal',
    textTransform: 'none', fontFamily: '$typography.fontFamily.sans',
  };
  assert.throws(() => validateMaster(m), /typography\.role/);
});

test('ARCH.42 — validateMaster throws on broken H2 identity lock', () => {
  const m = loadMaster();
  m.typography.role.h2.fontSize.email = '15px';
  assert.throws(() => validateMaster(m), /identity-locked/);
});

test('ARCH.42 — emitTokensCss appends .t-{role} classes after color tokens', () => {
  const css = emitTokensCss(loadMaster(), 'abc123');
  // Color tokens come first
  const bgPos = css.indexOf('--bg: #06070d');
  // Typography roles come after
  const h1Pos = css.indexOf('.t-h1 {');
  assert.ok(bgPos > -1 && h1Pos > -1, 'both color tokens and .t-h1 must be present');
  assert.ok(h1Pos > bgPos, '.t-h1 must come after --bg');
  // All 10 roles present
  for (const n of ['t-h1', 't-h2', 't-h3', 't-section-label', 't-body-large', 't-body', 't-body-small', 't-meta', 't-code', 't-button-label']) {
    assert.ok(css.includes(`.${n} {`), `tokens.css missing class .${n}`);
  }
  // .t-h2 web fontSize is 18px (NOT 16px — that's email lock)
  assert.match(css, /\.t-h2 \{\s*font-size: 18px/);
  // .t-body web fontSize is 14px
  assert.match(css, /\.t-body \{\s*font-size: 14px/);
});

test('ARCH.42 — emitTypographyRolesMjs has TYPE_ROLES with email fontSize + styleString helper', () => {
  const mjs = emitTypographyRolesMjs(loadMaster(), 'xyz789');
  assert.ok(mjs.includes('export const TYPE_ROLES'), 'TYPE_ROLES export missing');
  assert.ok(mjs.includes('export function styleString'), 'styleString helper missing');
  // h2 email is 16px in this artifact (NOT 18px web)
  assert.match(mjs, /h2:[\s\S]*fontSize: "16px"/);
  // body email is 13px (NOT 14px web)
  assert.match(mjs, /body:[\s\S]*fontSize: "13px"/);
  // kebab→camel name conversion
  assert.ok(mjs.includes('sectionLabel:'), 'section-label → sectionLabel');
  assert.ok(mjs.includes('bodyLarge:'), 'body-large → bodyLarge');
  assert.ok(mjs.includes('buttonLabel:'), 'button-label → buttonLabel');
  // code uses mono fontFamily
  assert.match(mjs, /code:[\s\S]*JetBrains Mono/);
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
