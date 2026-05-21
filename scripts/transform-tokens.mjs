#!/usr/bin/env node
/**
 * scripts/transform-tokens.mjs — ARCH.41 (finding-007) + ARCH.42 (finding-008) token unification.
 *
 * Reads tokens/master.json and emits 4 derived consumer files (+ 1 lockfile):
 *   lib/heartbeat-tokens.json        — heartbeat email tokens
 *   lib/dashboard-tokens.mjs         — dashboard build tokens (JS module)
 *   lib/dashboard-tokens.mjs.sha256  — lockfile (master hash)
 *   dashboard/css/tokens.css         — standalone-page CSS tokens + .t-{role} typography classes
 *   lib/typography-roles.mjs         — TYPE_ROLES + styleString() helper (email fontSize path)
 *
 * CLI:
 *   node scripts/transform-tokens.mjs               # write all 5 files
 *   node scripts/transform-tokens.mjs --check       # diff against on-disk; exit 1 if drift
 *   node scripts/transform-tokens.mjs --output=heartbeat|dashboard-mjs|dashboard-css|typography-roles|all
 *   node scripts/transform-tokens.mjs --verbose
 *
 * Spec (ARCH.41): data/architecture/finding-007-implementation-spec-2026-05-20.md
 * Spec (ARCH.42): data/architecture/finding-008-implementation-spec-2026-05-20.md
 * Dealbreaker audits: data/architecture/dealbreaker-final-arch{41,42}-*.md
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
const OUT_TYPOGRAPHY_ROLES = resolve(REPO_ROOT, 'lib/typography-roles.mjs');

const GENERATOR_NAME = 'scripts/transform-tokens.mjs';
const SCHEMA_VERSION = '1.1.0';

// ARCH.42 invariants
const ROLE_COUNT_CAP = 10;            // 9 pre-dealbreaker; body-large added per fix #3
const H2_EMAIL_LOCK = '16px';         // Council Decision C / ADR-0007
const BODY_EMAIL_LOCK = '13px';       // dealbreaker fix #2 — heartbeat MJML baseline
const BODY_WEB_LOCK = '14px';         // dealbreaker fix #2 — dashboard baseline
const REQUIRED_ROLE_PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'fontFamily'];

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

  // ARCH.42 invariants — typography.role.* layer
  const role = master.typography?.role;
  assert.ok(role && typeof role === 'object',
    'master.json typography.role must be an object (ARCH.42 populates this layer).');
  const roleNames = Object.keys(role).filter(k => !k.startsWith('$') && !k.startsWith('_'));
  assert.ok(roleNames.length > 0 && roleNames.length <= ROLE_COUNT_CAP,
    `typography.role has ${roleNames.length} roles — must be in [1, ${ROLE_COUNT_CAP}]. ARCH.42 spec § dealbreaker fix #3.`);
  for (const name of roleNames) {
    const r = role[name];
    for (const prop of REQUIRED_ROLE_PROPS) {
      assert.ok(r[prop] !== undefined,
        `typography.role.${name} missing required prop: ${prop}`);
    }
    // fontSize must be string OR {email, web}
    if (typeof r.fontSize === 'object') {
      assert.ok(r.fontSize.email && r.fontSize.web,
        `typography.role.${name}.fontSize is an object — must have {email, web} keys.`);
    }
  }
  // H2 email size identity lock (Council Decision C)
  if (role.h2) {
    const h2Email = typeof role.h2.fontSize === 'object' ? role.h2.fontSize.email : role.h2.fontSize;
    assert.equal(h2Email, H2_EMAIL_LOCK,
      `typography.role.h2.fontSize.email is identity-locked to ${H2_EMAIL_LOCK} (Council Decision C / ADR-0007). Got: ${h2Email}`);
  }
  // body dual-encoding lock (dealbreaker fix #2)
  if (role.body) {
    assert.ok(typeof role.body.fontSize === 'object',
      'typography.role.body.fontSize must be an object {email, web} (dealbreaker fix #2 dual-encoding).');
    assert.equal(role.body.fontSize.email, BODY_EMAIL_LOCK,
      `typography.role.body.fontSize.email is locked to ${BODY_EMAIL_LOCK}. Got: ${role.body.fontSize.email}`);
    assert.equal(role.body.fontSize.web, BODY_WEB_LOCK,
      `typography.role.body.fontSize.web is locked to ${BODY_WEB_LOCK}. Got: ${role.body.fontSize.web}`);
  }

  const REQUIRED = [
    'color.dark.bg.app', 'color.dark.bg.panel', 'color.dark.bg.panel_strong',
    'color.dark.accent.green_glow', 'color.dark.chip.blue_fg',
    'color.light.bg.app', 'color.light.bg.panel', 'color.light.chip.blue_fg',
    'spacing.alias.xs', 'spacing.scale.0', 'spacing.scale.10',
    'radius.sm', 'focus.ring.dark', 'focus.ring.light',
    'shadow.sm', 'backdrop.dark',
    'email.dark.body_bg', 'email.morning_dispatch', 'email.evening_dispatch',
    'typography.fontFamily.sans', 'typography.fontFamily.mono',
  ];
  for (const path of REQUIRED) {
    const v = getPath(master, path);
    assert.ok(v !== undefined, `master.json missing required path: ${path}`);
  }
}

// ─── typography helpers (ARCH.42) ────────────────────────────────────────────

function resolveFontRef(ref, master) {
  if (typeof ref !== 'string' || !ref.startsWith('$typography.fontFamily.')) return ref;
  const key = ref.replace('$typography.fontFamily.', '');
  const v = master.typography.fontFamily[key];
  if (v === undefined) {
    throw new Error(`Unknown fontFamily ref: ${ref} (no $typography.fontFamily.${key} in master).`);
  }
  return v;
}

function getRoleNames(master) {
  return Object.keys(master.typography.role)
    .filter(k => !k.startsWith('$') && !k.startsWith('_'));
}

function getRoleFontSize(role, surface) {
  return typeof role.fontSize === 'object' ? role.fontSize[surface] : role.fontSize;
}

function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
  // ARCH.42 — typography role classes. Web fontSize path. Color-agnostic.
  lines.push('/* ── ARCH.42 typography roles — .t-{role} classes ──────────────── */');
  lines.push('/* Color-agnostic: callers supply color via style="color:..." or  */');
  lines.push('/* a separate utility. Web fontSize path; email path lives in     */');
  lines.push('/* lib/typography-roles.mjs as TYPE_ROLES with email fontSize.    */');
  lines.push('');
  for (const name of getRoleNames(master)) {
    const r = master.typography.role[name];
    lines.push(`.t-${name} {`);
    lines.push(`  font-size: ${getRoleFontSize(r, 'web')};`);
    lines.push(`  font-weight: ${r.fontWeight};`);
    lines.push(`  line-height: ${r.lineHeight};`);
    if (r.letterSpacing && r.letterSpacing !== 'normal') {
      lines.push(`  letter-spacing: ${r.letterSpacing};`);
    }
    if (r.textTransform && r.textTransform !== 'none') {
      lines.push(`  text-transform: ${r.textTransform};`);
    }
    lines.push(`  font-family: ${resolveFontRef(r.fontFamily, master)};`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

// ─── emit: lib/typography-roles.mjs (ARCH.42) ───────────────────────────────

export function emitTypographyRolesMjs(master, hash) {
  const entries = [];
  for (const name of getRoleNames(master)) {
    const r = master.typography.role[name];
    const camel = kebabToCamel(name);
    const obj = {
      fontSize: getRoleFontSize(r, 'email'),
      fontWeight: r.fontWeight,
      lineHeight: r.lineHeight,
    };
    if (r.letterSpacing && r.letterSpacing !== 'normal') {
      obj.letterSpacing = r.letterSpacing;
    }
    if (r.textTransform && r.textTransform !== 'none') {
      obj.textTransform = r.textTransform;
    }
    obj.fontFamily = resolveFontRef(r.fontFamily, master);
    // Hand-format the inner object — canonicalStringify alone would alphabetize
    // keys and lose the role's natural property order (fontSize → fontWeight →
    // lineHeight → ...). Order matters for human readability of the generated
    // file; the BYTES still hash deterministically because we build the same
    // object the same way on every run.
    const props = Object.entries(obj).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join(',\n');
    entries.push(`  ${camel}: Object.freeze({\n${props}\n  })`);
  }
  return (
    `// AUTO-GENERATED by ${GENERATOR_NAME} — DO NOT EDIT.\n` +
    `// Source: tokens/master.json typography.role.* (email fontSize path)\n` +
    `// Master hash (sha256): ${hash}\n` +
    `// Schema version: ${SCHEMA_VERSION}\n` +
    `// Re-run: node scripts/transform-tokens.mjs\n` +
    `//\n` +
    `// Web fontSize path lives in dashboard/css/tokens.css as .t-{role} classes.\n` +
    `// styleString() converts a role + overrides into an email-safe inline-style\n` +
    `// string (no media queries, no CSS vars — Outlook strips both).\n` +
    `\n` +
    `export const TYPE_ROLES = Object.freeze({\n` +
    entries.join(',\n') +
    `\n});\n` +
    `\n` +
    `/**\n` +
    ` * Converts a TYPE_ROLES entry + overrides into an email-safe inline-style string.\n` +
    ` *\n` +
    ` * @param {Readonly<Record<string, string>>} roleProps  one TYPE_ROLES entry\n` +
    ` * @param {Record<string, string>} [overrides]  e.g. { color: '#86efac', margin: '10px 0 3px' }\n` +
    ` * @returns {string}  e.g. 'font-size:10px;font-weight:700;color:#86efac;margin:10px 0 3px'\n` +
    ` *\n` +
    ` * - Keys are emitted in role-then-overrides order (overrides win on collision).\n` +
    ` * - 'textTransform: none' and 'letterSpacing: normal' are suppressed (no-op in email).\n` +
    ` * - Never emits a 'color:' from the role itself — color is always an override.\n` +
    ` * - Output is a single line; no trailing semicolon; ready to drop into style="...".\n` +
    ` */\n` +
    `export function styleString(roleProps, overrides = {}) {\n` +
    `  const merged = { ...roleProps, ...overrides };\n` +
    `  return Object.entries(merged)\n` +
    `    .filter(([, v]) => v !== undefined && v !== null && v !== 'none' && v !== 'normal')\n` +
    `    .map(([k, v]) => camelToKebab(k) + ':' + v)\n` +
    `    .join(';');\n` +
    `}\n` +
    `\n` +
    `function camelToKebab(s) {\n` +
    `  return s.replace(/([A-Z])/g, m => '-' + m.toLowerCase());\n` +
    `}\n`
  );
}

// ─── transform (pure) ────────────────────────────────────────────────────────

export function transform(master) {
  const hash = hashMaster(master);
  return {
    heartbeat: emitHeartbeatJson(master, hash),
    dashboardMjs: emitDashboardMjs(master, hash),
    tokensCss: emitTokensCss(master, hash),
    typographyRoles: emitTypographyRolesMjs(master, hash),
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
  const { heartbeat, dashboardMjs, tokensCss, typographyRoles, dashboardLock, hash } = transform(master);
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
  if (opts.output === 'all' || opts.output === 'typography-roles') {
    targets.push([OUT_TYPOGRAPHY_ROLES, typographyRoles]);
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
  const { heartbeat, dashboardMjs, tokensCss, typographyRoles, dashboardLock } = transform(master);
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
  if (opts.output === 'all' || opts.output === 'typography-roles') {
    checks.push([OUT_TYPOGRAPHY_ROLES, typographyRoles]);
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
      if (!['heartbeat', 'dashboard-mjs', 'dashboard-css', 'typography-roles', 'all'].includes(v)) {
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
  console.log('Usage: node scripts/transform-tokens.mjs [--check] [--output=heartbeat|dashboard-mjs|dashboard-css|typography-roles|all] [--verbose]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
