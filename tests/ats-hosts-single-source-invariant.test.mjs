#!/usr/bin/env node
/**
 * tests/ats-hosts-single-source-invariant.test.mjs
 *
 * Invariant: KNOWN_ATS_HOSTS has exactly ONE source of truth —
 * lib/jd-url-canonicalizer.mjs. The drawer's inline client script in
 * scripts/build-dashboard.mjs must receive the list via build-time
 * injection (${JSON.stringify(KNOWN_ATS_HOSTS)}), never a hand-copied
 * literal array.
 *
 * Bug class: contract-drift-across-layers (AGENTS.md catalog).
 * Canonical incident: 2026-06-10 — the inline favicon-anchor copy in
 * build-dashboard.mjs (~line 16650) had drifted from the canonical list
 * (missing jobs.gem.com, databricks.com, amazon.jobs, careers.circle.com).
 *
 * $0 deterministic. No personal data. Safe in CI.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_ATS_HOSTS } from '../lib/jd-url-canonicalizer.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SRC = readFileSync(join(REPO_ROOT, 'scripts/build-dashboard.mjs'), 'utf8');

let pass = 0;
function ok(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('ats-hosts-single-source invariant');

ok('lib exports KNOWN_ATS_HOSTS as a non-trivial array', () => {
  assert.ok(Array.isArray(KNOWN_ATS_HOSTS), 'KNOWN_ATS_HOSTS is not an array');
  assert.ok(KNOWN_ATS_HOSTS.length >= 20, `expected >= 20 hosts, got ${KNOWN_ATS_HOSTS.length}`);
});

ok('canonical list contains the hosts the 2026-06-10 inline copy was missing', () => {
  for (const host of ['jobs.gem.com', 'databricks.com', 'amazon.jobs', 'careers.circle.com', 'greenhouse.io']) {
    assert.ok(KNOWN_ATS_HOSTS.includes(host), `canonical list missing ${host}`);
  }
});

ok('build-dashboard.mjs imports KNOWN_ATS_HOSTS from lib/jd-url-canonicalizer.mjs', () => {
  assert.ok(
    /import\s*\{[^}]*\bKNOWN_ATS_HOSTS\b[^}]*\}\s*from\s*'\.\.\/lib\/jd-url-canonicalizer\.mjs'/.test(BUILD_SRC),
    'import { KNOWN_ATS_HOSTS } from ../lib/jd-url-canonicalizer.mjs not found'
  );
});

ok('inline drawer script receives the list via build-time JSON injection', () => {
  assert.ok(
    BUILD_SRC.includes('const KNOWN_ATS_HOSTS = ${JSON.stringify(KNOWN_ATS_HOSTS)};'),
    'injection expression `const KNOWN_ATS_HOSTS = ${JSON.stringify(KNOWN_ATS_HOSTS)};` not found'
  );
});

ok('no hand-copied inline ATS host array remains in build-dashboard.mjs', () => {
  assert.ok(
    !/const KNOWN_ATS_HOSTS = \[\s*['"]/.test(BUILD_SRC),
    'found a literal `const KNOWN_ATS_HOSTS = [...]` array — the inline copy is back (contract-drift-across-layers)'
  );
});

ok('injected payload is outer-template-safe (no backticks / ${ / </script> in any host)', () => {
  const json = JSON.stringify(KNOWN_ATS_HOSTS);
  assert.ok(!json.includes('`'), 'backtick in host list breaks the outer template literal');
  assert.ok(!json.includes('${'), '${ in host list breaks the outer template literal');
  assert.ok(!json.includes('\\'), 'backslash in host list risks outer-template-unescape');
  assert.ok(!/<\/script/i.test(json), '</script in host list would terminate the inline script block');
});

if (process.exitCode) {
  console.error(`\nFAIL — ${pass} passed, with failures above`);
  process.exit(1);
}
console.log(`\nPASS — ${pass}/${pass} assertions green`);
