#!/usr/bin/env node
/**
 * scripts/transform-tokens.mjs — ARCH.41 finding-007 token unification.
 *
 * Reads tokens/master.json and emits 3 derived consumer files (+ 1 lockfile):
 *   lib/heartbeat-tokens.json   — heartbeat email tokens
 *   lib/dashboard-tokens.mjs    — dashboard build tokens (JS module)
 *   lib/dashboard-tokens.mjs.sha256  — lockfile (master hash)
 *   dashboard/css/tokens.css    — standalone-page CSS tokens
 *
 * CLI:
 *   node scripts/transform-tokens.mjs               # write all 4 files
 *   node scripts/transform-tokens.mjs --check       # diff against on-disk; exit 1 if drift
 *   node scripts/transform-tokens.mjs --output=heartbeat|dashboard-mjs|dashboard-css|all
 *   node scripts/transform-tokens.mjs --verbose
 *
 * Spec: data/architecture/finding-007-implementation-spec-2026-05-20.md
 * Dealbreaker audit: data/architecture/dealbreaker-final-arch41-token-unification-20260520.md
 *
 * Bypass for the CI gate (EMERGENCY ONLY): set TOKENS_SKIP_CI_GATE=1 in workflow env.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const MASTER_PATH = resolve(REPO_ROOT, 'tokens/master.json');
const OUT_HEARTBEAT = resolve(REPO_ROOT, 'lib/heartbeat-tokens.json');
const OUT_DASHBOARD_MJS = resolve(REPO_ROOT, 'lib/dashboard-tokens.mjs');
const OUT_DASHBOARD_LOCK = resolve(REPO_ROOT, 'lib/dashboard-tokens.mjs.sha256');
const OUT_TOKENS_CSS = resolve(REPO_ROOT, 'dashboard/css/tokens.css');

const GENERATOR_NAME = 'scripts/transform-tokens.mjs';
const SCHEMA_VERSION = '1.0.0';

// CSS variable name → master.json nested path. ORDER IS FIXED.
const CSS_VAR_MAP = [
  ['--bg',              'color.{mode}.bg.app'],
  ['--surface',         'color.{mode}.bg.panel'],
  ['--surface-2',       'color.{mode}.bg.panel_strong'],
  ['--border',          'color.{mode}.border.default'],
  ['--border-strong',   'color.{mode}.border.strong'],
  ['--text',            'color.{mode}.text.t1'],
  ['--text-2',          'color.{mode}.text.t2'],
  ['--text-3',          'color.{mode}.text.t3'],
  ['--text-4',          'color.{mode}.text.t4'],
  ['--green',           'color.{mode}.accent.green'],
  ['--green-fg',        'color.{mode}.accent.green_fg'],
  ['--green-fg-dark',   'color.{mode}.accent.green_fg_dark'],
  ['--green-bg',        'color.{mode}.accent.green_bg'],
  ['--green-border',    'color.{mode}.accent.green_border'],
  ['--green-glow',      'color.{mode}.accent.green_glow'],
  ['--blue-fg',         'color.{mode}.chip.blue_fg'],
  ['--blue-bg',         'color.{mode}.chip.blue_bg'],
  ['--amber-fg',        'color.{mode}.chip.amber_fg'],
  ['--amber-bg',        'color.{mode}.chip.amber_bg'],
  ['--red-fg',          'color.{mode}.chip.red_fg'],
  ['--red-bg',          'color.{mode}.chip.red_bg'],
  ['--purple-fg',       'color.{mode}.chip.purple_fg'],
  ['--purple-bg',       'color.{mode}.chip.purple_bg'],
  ['--success',         'color.{mode}.semantic.success'],
  ['--success-fg',      'color.{mode}.semantic.success_fg'],
  ['--warning',         'color.{mode}.semantic.warning'],
  ['--warning-fg',      'color.{mode}.semantic.warning_fg'],
  ['--danger',          'color.{mode}.semantic.danger'],
  ['--danger-fg',       'color.{mode}.semantic.danger_fg'],
  ['--info',            'color.{mode}.semantic.info'],
  ['--info-fg',         'color.{mode}.semantic.info_fg'],
  ['--link',            'color.{mode}.link.default'],
  ['--link-hover',      'color.{mode}.link.hover'],
  ['--brand',           'color.{mode}.brand.primary'],
  ['--brand-soft',      'color.{mode}.brand.primary_soft'],
  // Mode-invariant — same value for dark+light
  ['--radius-sm',       'radius.sm'],
  ['--radius-md',       'radius.md'],
  ['--radius-lg',       'radius.lg'],
  ['--radius-xl',       'radius.xl'],
  ['--radius-pill',     'radius.pill'],
  ['--space-xs',        'spacing.alias.xs'],
  ['--space-sm',        'spacing.alias.sm'],
  ['--space-md',        'spacing.alias.md'],
  ['--space-lg',        'spacing.alias.lg'],
  ['--space-xl',        'spacing.alias.xl'],
  ['--space-2xl',       'spacing.alias.2xl'],
  ['--space-3xl',       'spacing.alias.3xl'],
  ['--space-4xl',       'spacing.alias.4xl'],
  ['--shadow-sm',       'shadow.sm'],
  ['--shadow-md',       'shadow.md'],
  ['--shadow-lg',       'shadow.lg'],
  // Mode-specific (computed differently per mode)
  ['--focus-ring',      'focus.ring.{mode}'],
];

const KNOWN_TOP_LEVEL_CATEGORIES = new Set([
  '$schema', '$description', '$schemaVersion', '$generatedBy',
  '_provenance', '_reconciliation',
  'color', 'spacing', 'radius', 'focus', 'shadow', 'backdrop', 'email', 'typography'
]);

// ─── pure helpers ────────────────────────────────────────────────────────────

export function canonicalStringify(obj, indent = 2) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(obj), null, indent) + '\n';
}

export function hashMaster(master) {
  return createHash('sha256').update(canonicalStringify(master, 2)).digest('hex');
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function readMaster() {
  const raw = readFileSync(MASTER_PATH, 'utf8');
  const master = JSON.parse(raw);
  validateMaster(master);
  return master;
}

export function validateMaster(master) {
  assert.equal(master.$schema, 'career-ops-tokens-master-v1', 'master.json has unexpected $schema');
  assert.equal(master.$schemaVersion, SCHEMA_VERSION,
    `master.json schemaVersion ${master.$schemaVersion} does not match transform expected ${SCHEMA_VERSION}. Migrate or update transform.`);
  for (const key of Object.keys(master)) {
    if (!KNOWN_TOP_LEVEL_CATEGORIES.has(key)) {
      throw new Error(`Unknown top-level category in master.json: ${key}. Update KNOWN_TOP_LEVEL_CATEGORIES + emit logic.`);
    }
  }
  assert.ok(master.typography?.role?.$reserved,
    'master.json typography.role must reserve $reserved sentinel for ARCH.42');
  assert.equal(Object.keys(master.typography.role).length, 1,
    'master.json typography.role must contain ONLY $reserved (ARCH.42 owns this slot).');
  const REQUIRED = [
    'color.dark.bg.app', 'color.dark.bg.panel', 'color.dark.bg.panel_strong',
    'color.dark.accent.green_glow', 'color.dark.chip.blue_fg',
    'color.light.bg.app', 'color.light.bg.panel', 'color.light.chip.blue_fg',
    'spacing.alias.xs', 'spacing.scale.0', 'spacing.scale.10',
    'radius.sm', 'focus.ring.dark', 'focus.ring.light',
    'shadow.sm', 'backdrop.dark',
    'email.dark.body_bg', 'email.morning_dispatch', 'email.evening_dispatch',
  ];
  for (const path of REQUIRED) {
    const v = getPath(master, path);
    assert.ok(v !== undefined, `master.json missing required path: ${path}`);
  }
}

// ─── emit: lib/heartbeat-tokens.json ─────────────────────────────────────────

function buildFlatCssMap(master, mode) {
  const result = {};
  for (const [cssVar, pathTemplate] of CSS_VAR_MAP) {
    const path = pathTemplate.replace('{mode}', mode);
    const value = getPath(master, path);
    if (value === undefined) {
      throw new Error(`CSS_VAR_MAP path ${path} not found in master.json — update master or CSS_VAR_MAP.`);
    }
    result[cssVar] = value;
  }
  return result;
}

export function emitHeartbeatJson(master, hash) {
  const dashboardTokensDark = buildFlatCssMap(master, 'dark');
  const dashboardTokensLight = buildFlatCssMap(master, 'light');
  const out = {
    _generated: {
      by: GENERATOR_NAME,
      from: 'tokens/master.json',
      hash,
      schemaVersion: SCHEMA_VERSION,
      do_not_edit: true
    },
    $schema: 'career-ops-heartbeat-tokens-v1',
    $description: 'DERIVED FILE — auto-generated from tokens/master.json by scripts/transform-tokens.mjs. CI rejects hand-edits. Edit master.json + re-run transform instead.',
    color: master.color,
    email: master.email,
    dashboard: {
      tokens_dark: dashboardTokensDark,
      tokens_light: dashboardTokensLight
    },
    typography: master.typography,
    spacing: master.spacing.alias,
    radius: master.radius,
    shadow: master.shadow
  };
  return canonicalStringify(out);
}

// ─── emit: lib/dashboard-tokens.mjs ──────────────────────────────────────────

export function emitDashboardMjs(master, hash) {
  const TOKENS = {
    dark: {
      backdrop: master.backdrop.dark,
      bg: master.color.dark.bg.app,
      border: master.color.dark.border.default,
      borderStrong: master.color.dark.border.strong,
      green: master.color.dark.accent.green,
      greenFg: master.color.dark.accent.green_fg,
      greenFgDark: master.color.dark.accent.green_fg_dark,
      greenBg: master.color.dark.accent.green_bg,
      greenBorder: master.color.dark.accent.green_border,
      greenGlow: master.color.dark.accent.green_glow,
      surface: master.color.dark.bg.panel,
      surface2: master.color.dark.bg.panel_strong,
      text: master.color.dark.text.t1,
      text2: master.color.dark.text.t2,
      text3: master.color.dark.text.t3,
      text4: master.color.dark.text.t4,
      blue: master.color.dark.chip.blue_fg,
      blueFg: master.color.dark.chip.blue_fg,
      blueBg: master.color.dark.chip.blue_bg,
      amber: master.color.dark.chip.amber_fg,
      amberFg: master.color.dark.chip.amber_fg,
      amberBg: master.color.dark.chip.amber_bg,
      red: master.color.dark.chip.red_fg,
      redFg: master.color.dark.chip.red_fg,
      redBg: master.color.dark.chip.red_bg
    },
    email: {
      bg: master.color.light.bg.app,
      surface: master.color.light.bg.app,
      surface2: master.color.light.bg.panel_strong,
      border: master.color.light.border.default,
      borderStrong: master.color.light.border.strong,
      text: master.color.light.text.t1,
      text2: master.color.light.text.t2,
      text3: master.color.light.text.t3,
      text4: master.color.light.text.t4,
      green: master.color.light.accent.green,
      greenFg: master.color.light.accent.green_fg,
      greenBg: master.color.light.accent.green_bg,
      greenBorder: master.color.light.accent.green_border,
      blue: master.color.light.chip.blue_fg,
      blueFg: master.color.light.chip.blue_fg,
      blueBg: master.color.light.chip.blue_bg,
      amberBg: master.color.light.chip.amber_bg,
      amberFg: master.color.light.chip.amber_fg,
      redBg: master.color.light.chip.red_bg,
      redFg: master.color.light.chip.red_fg
    }
  };
  const body = canonicalStringify(TOKENS).trimEnd();
  return (
    `// AUTO-GENERATED by ${GENERATOR_NAME} — DO NOT EDIT.\n` +
    `// Source: tokens/master.json\n` +
    `// Master hash (sha256): ${hash}\n` +
    `// Schema version: ${SCHEMA_VERSION}\n` +
    `// Re-run: node scripts/transform-tokens.mjs\n` +
    `// Helpers (scoreBadgeColors, statusBadgeColors, missionControlHeader, emailDarkCss)\n` +
    `// live in lib/dashboard-token-helpers.mjs.\n` +
    `\n` +
    `export const TOKENS = ${body};\n`
  );
}

// ─── emit: dashboard/css/tokens.css ──────────────────────────────────────────

function renderModeVars(master, mode) {
  const flat = buildFlatCssMap(master, mode);
  const ordered = CSS_VAR_MAP.map(([cssVar]) => cssVar);
  return ordered.map(cssVar => `  ${cssVar}: ${flat[cssVar]};`);
}

export function emitTokensCss(master, hash) {
  const lines = [];
  lines.push(`/* AUTO-GENERATED by ${GENERATOR_NAME} — DO NOT EDIT. */`);
  lines.push(`/* Source: tokens/master.json */`);
  lines.push(`/* Master hash (sha256): ${hash} */`);
  lines.push(`/* Schema version: ${SCHEMA_VERSION} */`);
  lines.push(`/* Re-run: node scripts/transform-tokens.mjs */`);
  lines.push('');
  lines.push(':root {');
  lines.push('  color-scheme: dark;');
  lines.push(...renderModeVars(master, 'dark'));
  lines.push('}');
  lines.push('');
  lines.push(':root[data-theme="light"] {');
  lines.push('  color-scheme: light;');
  lines.push(...renderModeVars(master, 'light'));
  lines.push('}');
  lines.push('');
  lines.push('@media (prefers-color-scheme: light) {');
  lines.push('  :root:not([data-theme="dark"]) {');
  lines.push('    color-scheme: light;');
  for (const line of renderModeVars(master, 'light')) {
    lines.push('  ' + line);
  }
  lines.push('  }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// ─── transform (pure) ────────────────────────────────────────────────────────

export function transform(master) {
  const hash = hashMaster(master);
  return {
    heartbeat: emitHeartbeatJson(master, hash),
    dashboardMjs: emitDashboardMjs(master, hash),
    tokensCss: emitTokensCss(master, hash),
    dashboardLock: hash + '\n',
    hash
  };
}

// ─── diff ────────────────────────────────────────────────────────────────────

export function diffStrings(a, b, label) {
  if (a === b) return null;
  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  const out = [`--- on-disk: ${label}`, `+++ generated`];
  let printed = 0;
  for (let i = 0; i < max && printed < 20; i++) {
    if (al[i] !== bl[i]) {
      if (al[i] !== undefined) { out.push(`-${i + 1}: ${al[i]}`); printed++; }
      if (bl[i] !== undefined && printed < 20) { out.push(`+${i + 1}: ${bl[i]}`); printed++; }
    }
  }
  return out.join('\n');
}

// ─── runners ─────────────────────────────────────────────────────────────────

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function runWrite(opts) {
  const master = readMaster();
  const { heartbeat, dashboardMjs, tokensCss, dashboardLock, hash } = transform(master);
  const targets = [];
  if (opts.output === 'all' || opts.output === 'heartbeat') {
    targets.push([OUT_HEARTBEAT, heartbeat]);
  }
  if (opts.output === 'all' || opts.output === 'dashboard-mjs') {
    targets.push([OUT_DASHBOARD_MJS, dashboardMjs]);
    targets.push([OUT_DASHBOARD_LOCK, dashboardLock]);
  }
  if (opts.output === 'all' || opts.output === 'dashboard-css') {
    targets.push([OUT_TOKENS_CSS, tokensCss]);
  }
  for (const [path, content] of targets) {
    ensureDir(path);
    writeFileSync(path, content, 'utf8');
    if (opts.verbose) {
      console.log(`WROTE ${relative(REPO_ROOT, path)} (${Buffer.byteLength(content, 'utf8')} bytes, hash ${hash.slice(0, 8)})`);
    }
  }
  return 0;
}

function runCheck(opts) {
  const master = readMaster();
  const { heartbeat, dashboardMjs, tokensCss, dashboardLock } = transform(master);
  const checks = [];
  if (opts.output === 'all' || opts.output === 'heartbeat') {
    checks.push([OUT_HEARTBEAT, heartbeat]);
  }
  if (opts.output === 'all' || opts.output === 'dashboard-mjs') {
    checks.push([OUT_DASHBOARD_MJS, dashboardMjs]);
    checks.push([OUT_DASHBOARD_LOCK, dashboardLock]);
  }
  if (opts.output === 'all' || opts.output === 'dashboard-css') {
    checks.push([OUT_TOKENS_CSS, tokensCss]);
  }
  let drift = false;
  for (const [path, expected] of checks) {
    if (!existsSync(path)) {
      console.error(`MISSING: ${relative(REPO_ROOT, path)} — run \`node scripts/transform-tokens.mjs\` to generate.`);
      drift = true;
      continue;
    }
    const actual = readFileSync(path, 'utf8');
    const d = diffStrings(actual, expected, relative(REPO_ROOT, path));
    if (d) {
      console.error(`DRIFT: ${relative(REPO_ROOT, path)}`);
      console.error(d);
      console.error('');
      drift = true;
    }
  }
  if (drift) {
    console.error('---');
    console.error('Derived token files are out of sync with tokens/master.json.');
    console.error('Fix: run `node scripts/transform-tokens.mjs` locally, then commit the regenerated files.');
    console.error('If you intended to change a token value, edit tokens/master.json (NOT the derived files).');
    return 1;
  }
  return 0;
}

export function main(argv) {
  const args = argv.slice(2);
  const opts = { check: false, output: 'all', verbose: false };
  for (const a of args) {
    if (a === '--check') opts.check = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a.startsWith('--output=')) {
      const v = a.slice('--output='.length);
      if (!['heartbeat', 'dashboard-mjs', 'dashboard-css', 'all'].includes(v)) {
        console.error(`Unknown --output value: ${v}`);
        return 2;
      }
      opts.output = v;
    } else {
      console.error(`Unknown flag: ${a}`);
      printUsage();
      return 2;
    }
  }
  return opts.check ? runCheck(opts) : runWrite(opts);
}

function printUsage() {
  console.log('Usage: node scripts/transform-tokens.mjs [--check] [--output=heartbeat|dashboard-mjs|dashboard-css|all] [--verbose]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
