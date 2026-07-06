#!/usr/bin/env node
/**
 * tests/retired-metric-pattern-single-source.test.mjs
 *
 * Invariant: the retired-metric "fabrication leak" detector (PAT + EXCL) has
 * exactly ONE source of truth — lib/retired-metric-pattern.mjs. The scrubber
 * (scripts/scrub-fabrications.mjs) and both verifiers
 * (scripts/verify-dashboard-real-2026-05-31.mjs, verify-overnight-2026-05-31.mjs)
 * must IMPORT it, never re-declare a hand-copied `const PAT` / `const EXCL`.
 *
 * Bug class: contract-drift-across-layers / stale-coupling (docs/BUG-CLASSES.md).
 * Canonical incident: 2026-06-14 — scrub-fabrications.mjs was hardened (HTML-entity
 * &gt;90%, "better than 90%", bare "90% accuracy", drafting-latency word-order,
 * "99% voice fidelity", 3.5h prose, top 0.5%, L8+/kill-list) while the two
 * verifiers kept stale copies, so three verifiers DISAGREED on what counts as a leak.
 *
 * Scope note: the grep is intentionally limited to scripts/ + lib/ (the surface
 * where the drift happened + where the canonical module lives). That naturally
 * excludes .claude/worktrees/ (ephemeral checkouts), node_modules/, .git/, and the
 * data/scrub-backups-* .bak files — none of which are part of the live tree's contract.
 *
 * $0 deterministic. No LLM, no network, no personal data. Safe in CI.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAT, EXCL } from '../lib/retired-metric-pattern.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = 'lib/retired-metric-pattern.mjs';
const CONSUMERS = [
  'scripts/scrub-fabrications.mjs',
  'scripts/verify-dashboard-real-2026-05-31.mjs',
  'scripts/verify-overnight-2026-05-31.mjs',
];

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

console.log('retired-metric-pattern single-source invariant');

// ── shape ──
ok('module exports PAT + EXCL as non-empty strings', () => {
  assert.equal(typeof PAT, 'string', 'PAT is not a string');
  assert.equal(typeof EXCL, 'string', 'EXCL is not a string');
  assert.ok(PAT.length > 400, `PAT suspiciously short (${PAT.length} chars) — truncated?`);
  assert.ok(EXCL.length > 20, `EXCL suspiciously short (${EXCL.length} chars)`);
});

ok('PAT + EXCL compile as JS RegExp (alternation is well-formed)', () => {
  assert.doesNotThrow(() => new RegExp(PAT), 'PAT does not compile as a RegExp');
  assert.doesNotThrow(() => new RegExp(EXCL), 'EXCL does not compile as a RegExp');
});

// ── the canonical copy carries the full hardened token set (proves the source of
//    truth is the HARDENED one, not a stale fork). Each string below is the RUNTIME
//    substring (so `\\.` in this file = a literal backslash-dot in PAT). ──
ok('PAT carries the 2026-06-14 + 2026-06-11 hardened tokens', () => {
  const required = [
    '99% stylistic fidelity',            // original
    'stylistic[- ]fidelity',             // bracket form
    '99% voice fidelity',                // 2026-06-14 voice variant
    '&gt;',                              // 2026-06-14 HTML-entity accuracy
    'better than',                       // 2026-06-14 "better than 90%"
    '(classification|accuracy)',         // 2026-06-14 bare "accuracy"
    '(cut|cutting|reduced) drafting latency', // 2026-06-14 latency word-order
    'substantial (reduction in drafting|drafting[- ]latency)',
    '3\\.5[ -]?(hours?|hrs?)',           // 2026-06-14 mentorship prose
    'top 0\\.5%',                        // top 0.5%
    'L8\\+',                             // L8+ google-internal level
    'L8[–-]L10',                         // en-dash level range
    '[Kk]ill[ -][Ll]ist',               // banned branding
    '180(,?000|K)',                      // 2026-06-11 headcount
    '93% CSAT',
    '348 (attendees|senior eng|senior tech|of them)',
  ];
  const missing = required.filter(t => !PAT.includes(t));
  assert.equal(missing.length, 0, `PAT missing hardened token(s): ${missing.join('  |  ')}`);
});

ok('EXCL carries the full disclosure-note allowlist (incl. "No retired metrics")', () => {
  for (const t of ['quarantine', 'dropped', 'Metric-hardened', 'corrected or dropped', 'No retired metrics']) {
    assert.ok(EXCL.includes(t), `EXCL missing disclosure term: ${t}`);
  }
});

// ── single source of truth: exactly ONE const PAT + ONE const EXCL under
//    scripts/ + lib/, and both live in the canonical module. ──
function defLines(name) {
  const out = execSync(
    `grep -rnE "(export[[:space:]]+)?const[[:space:]]+${name}[[:space:]]*=" scripts lib 2>/dev/null || true`,
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim();
  return out ? out.split('\n').filter(Boolean) : [];
}

ok('exactly ONE `const PAT` definition under scripts/+lib/, in the canonical module', () => {
  const defs = defLines('PAT');
  assert.equal(defs.length, 1, `expected 1 \`const PAT\`, found ${defs.length}:\n    ${defs.join('\n    ')}`);
  assert.ok(defs[0].startsWith(CANONICAL + ':'), `the lone \`const PAT\` is not in ${CANONICAL}: ${defs[0]}`);
});

ok('exactly ONE `const EXCL` definition under scripts/+lib/, in the canonical module', () => {
  const defs = defLines('EXCL');
  assert.equal(defs.length, 1, `expected 1 \`const EXCL\`, found ${defs.length}:\n    ${defs.join('\n    ')}`);
  assert.ok(defs[0].startsWith(CANONICAL + ':'), `the lone \`const EXCL\` is not in ${CANONICAL}: ${defs[0]}`);
});

// ── each consumer wires to the shared module (re-inlining would fail this) ──
for (const f of CONSUMERS) {
  ok(`${f} imports { PAT, EXCL } from the canonical module`, () => {
    const src = readFileSync(join(REPO_ROOT, f), 'utf8');
    assert.ok(
      /import\s*\{[^}]*\bPAT\b[^}]*\bEXCL\b[^}]*\}\s*from\s*'\.\.\/lib\/retired-metric-pattern\.mjs'/.test(src),
      `missing \`import { PAT, EXCL } from '../lib/retired-metric-pattern.mjs'\``
    );
    assert.ok(!/const\s+PAT\s*=\s*'/.test(src), 'a local `const PAT = ...` is back (re-inlined fork)');
    assert.ok(!/const\s+EXCL\s*=\s*'/.test(src), 'a local `const EXCL = ...` is back (re-inlined fork)');
  });
}

if (process.exitCode) {
  console.error(`\nFAIL — ${pass} passed, with failures above`);
  process.exit(1);
}
console.log(`\nPASS — ${pass}/${pass} assertions green`);
