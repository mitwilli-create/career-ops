#!/usr/bin/env node
// tests/safe-dashboard-deploy.test.mjs
//
// Test suite for the safe-dashboard-deploy infrastructure:
//   - scripts/lint-browser-context-refs.mjs
//   - scripts/lint-backtick-in-comment.mjs
//   - scripts/safe-dashboard-deploy.sh (gate-by-gate exit codes via subprocess)
//
// The headless-canary script is NOT exercised here (it would require a real
// browser + a running server). Its contract is verified via type/syntax check
// only; the real exercise happens in scripts/safe-dashboard-deploy.sh
// integration runs.
//
// Run with: node --test tests/safe-dashboard-deploy.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const LINT_BROWSER = join(ROOT, 'scripts/lint-browser-context-refs.mjs');
const LINT_BACKTICK = join(ROOT, 'scripts/lint-backtick-in-comment.mjs');
const WRAPPER = join(ROOT, 'scripts/safe-dashboard-deploy.sh');
const CANARY = join(ROOT, 'scripts/dashboard-headless-canary.mjs');

// --- helpers ---

function writeTmpHtml(content) {
  const dir = mkdtempSync(join(tmpdir(), 'safe-deploy-test-'));
  const path = join(dir, 'index.html');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function writeTmpJs(content) {
  const dir = mkdtempSync(join(tmpdir(), 'safe-deploy-test-'));
  const path = join(dir, 'source.mjs');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function runLint(script, file) {
  const r = spawnSync('node', [script, file], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// --- lint-browser-context-refs ---

test('lint-browser-context-refs: clean inline scripts → exit 0', () => {
  const html = `<!DOCTYPE html>
<html><head><script>
  function showToast(msg) { console.log(msg); }
  window.foo = function() { return 42; };
</script></head><body>
<script>
  showToast('hi');
  foo();
  console.log(Math.PI);
</script></body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-browser-context-refs: unresolved bare call → exit 1', () => {
  const html = `<!DOCTYPE html>
<html><body><script>
  function _renderThing(d) { return JSON.stringify(d); }
  // someUndefinedFunc is never defined and never typeof-guarded
  _renderThing(someUndefinedFunc({a:1}));
</script></body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}.\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /someUndefinedFunc/);
  assert.match(r.stderr, /client-side-reference-to-server-side-import/);
});

test('lint-browser-context-refs: typeof-guarded bare call → exit 0', () => {
  const html = `<!DOCTYPE html>
<html><body><script>
  if (typeof maybeAvailable === 'function') {
    maybeAvailable('hello');
  }
</script></body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-browser-context-refs: cross-block window.X reference resolves', () => {
  const html = `<!DOCTYPE html>
<html><body>
<script>
  window.sharedHelper = function() { return 'ok'; };
</script>
<script>
  // sharedHelper is set on window in another block; lint should treat it as a
  // shared global because it's referenced as window.sharedHelper somewhere.
  sharedHelper();
</script>
</body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-browser-context-refs: underscore-prefixed identifier skipped (project convention)', () => {
  const html = `<!DOCTYPE html>
<html><body><script>
  // _renderHM is defined in some other block — underscore prefix marks shared helper
  var result = _renderHM({a:1});
</script></body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-browser-context-refs: browser global (parseInt) → exit 0', () => {
  const html = `<!DOCTYPE html>
<html><body><script>
  var n = parseInt('42', 10);
  console.log(n);
</script></body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-browser-context-refs: missing file argument → exit 2', () => {
  const r = spawnSync('node', [LINT_BROWSER], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
});

test('lint-browser-context-refs: external <script src=...> blocks skipped', () => {
  const html = `<!DOCTYPE html>
<html><body>
<script src="external.js"></script>
<script>
  console.log('ok');
</script>
</body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0);
});

test('lint-browser-context-refs: JSON-LD <script type="application/ld+json"> skipped', () => {
  const html = `<!DOCTYPE html>
<html><body>
<script type="application/ld+json">{"@context":"http://schema.org"}</script>
<script>
  console.log('ok');
</script>
</body></html>`;
  const path = writeTmpHtml(html);
  const r = runLint(LINT_BROWSER, path);
  assert.equal(r.code, 0);
});

// --- lint-backtick-in-comment ---

test('lint-backtick-in-comment: clean source → exit 0', () => {
  const src = `// a comment without backticks
const x = \`hello \${world}\`;
const y = 1;
`;
  const path = writeTmpJs(src);
  const r = runLint(LINT_BACKTICK, path);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}.\nstderr:\n${r.stderr}`);
});

test('lint-backtick-in-comment: backtick in comment inside outer template → exit 1', () => {
  // This construction simulates a build-dashboard.mjs-style outer template
  // literal with a comment containing an unescaped backtick. The Acorn parser
  // sees the inner backtick as closing the template, then tries to parse
  // garbage after — SyntaxError.
  const src = `function build() {
  const html = \`<!DOCTYPE html>
  <style>
  /* this comment has \`a backtick\` that breaks the outer template */
  </style>
  \`;
  return html;
}
`;
  const path = writeTmpJs(src);
  const r = runLint(LINT_BACKTICK, path);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}.\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /outer-template-unescape/);
});

test('lint-backtick-in-comment: missing file → exit 2', () => {
  const r = spawnSync('node', [LINT_BACKTICK, '/nonexistent/file.mjs'], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
});

// --- safe-dashboard-deploy.sh (wrapper) ---

test('safe-dashboard-deploy.sh: missing source worktree → exit 1', () => {
  const r = spawnSync('bash', [WRAPPER, '/nonexistent/worktree'], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /does not exist|not found/);
});

test('safe-dashboard-deploy.sh: source without build-dashboard.mjs → exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-deploy-test-'));
  const r = spawnSync('bash', [WRAPPER, dir], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /build-dashboard\.mjs not found/);
});

// --- canary script: syntax + import check only ---

test('dashboard-headless-canary: syntax check passes', () => {
  const r = spawnSync('node', ['--check', CANARY], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `expected syntax-clean canary, got code ${r.status}.\nstderr:\n${r.stderr}`);
});

// --- presence of all expected files ---

test('infrastructure: all expected files exist', () => {
  const expected = [
    'scripts/lint-browser-context-refs.mjs',
    'scripts/lint-backtick-in-comment.mjs',
    'scripts/dashboard-headless-canary.mjs',
    'scripts/safe-dashboard-deploy.sh',
    'scripts/hooks/commit-msg', // safe-deploy guard integrated here
  ];
  for (const p of expected) {
    const full = join(ROOT, p);
    assert.ok(existsSync(full), `missing: ${p}`);
  }
});

test('infrastructure: commit-msg hook contains safe-deploy guard', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'scripts/hooks/commit-msg'), 'utf-8');
  assert.match(src, /safe-dashboard-deploy/);
  assert.match(src, /SKIP_SAFE_DEPLOY/);
  assert.match(src, /dashboard\/index\\?\.html/);
});
