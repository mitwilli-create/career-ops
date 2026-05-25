#!/usr/bin/env node
/**
 * tests/pre-apply-popout-drawers.test.mjs
 *
 * Tests for the pre-apply modal sub-check popout drawers — Worker A
 * deferred-UI ship 2026-05-25. The renderers (`_paBuildSubCheckDrawersHtml`,
 * `_paHmSignalsHtml`, `_paAtsSynonymsHtml`, `_paVoiceRuleFailuresHtml`,
 * `subCheckDrawer`, `_paesc`) live inside scripts/build-dashboard.mjs's
 * outer template literal. We:
 *   1) Read the BUILT dashboard/index.html
 *   2) Extract each function via tight regex
 *   3) Eval them in a sandboxed VM with stubs
 *   4) Assert HTML output for empty + populated + edge-case inputs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BUILT_HTML = join(ROOT, 'dashboard/index.html');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('OK  ' + name); pass++; }
  else {
    console.error('FAIL ' + name);
    if (detail !== undefined) {
      try { console.error('  detail:', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

if (!existsSync(BUILT_HTML)) {
  console.error('ERROR: dashboard/index.html does not exist; run `node scripts/build-dashboard.mjs` first.');
  process.exit(2);
}
const html = readFileSync(BUILT_HTML, 'utf-8');

// ──────────────────────────────────────────────────────────────────────
// Section 1: HTML output — built dashboard contains drawer infrastructure
// ──────────────────────────────────────────────────────────────────────

check('T1-1 _paBuildSubCheckDrawersHtml exposed on window',
  /window\._paBuildSubCheckDrawersHtml\s*=/.test(html), null);

check('T1-2 modal embeds drawers between dimRows and buttons',
  /dimRows\s*\+\s*\n\s*_paBuildSubCheckDrawersHtml\(data\.checks\)/.test(html), null);

check('T1-3 sub-check drawer CSS rule present',
  /\.pre-apply-sub-drawer\b/.test(html), null);

check('T1-4 sub-check drawer [open] chevron rotation CSS present',
  /\.pre-apply-sub-drawer\[open\]\s+\.pre-apply-sub-drawer-chev/.test(html), null);

check('T1-5 sub-check drawer uses native <details>',
  /<details class="pre-apply-sub-drawer"/.test(html), null);

check('T1-6 webkit details marker hidden via CSS',
  /\.pre-apply-sub-drawer summary::-webkit-details-marker\s*\{\s*display:\s*none/.test(html), null);

// ──────────────────────────────────────────────────────────────────────
// Section 2: Extract + eval helpers in a sandboxed VM
// ──────────────────────────────────────────────────────────────────────

// Each helper is one of: `function _paesc(s) { ... }` or
// `function _paemptyState(label) { ... }` etc. Native brace-balanced extractor.
// Must handle JS string literals, template literals, regex literals, line + block
// comments — because `_paesc` body contains /&/g etc. that look like `//` to a
// naive walker. Heuristic for regex-start: previous non-space token is an
// operator / punctuator OR start of statement.
function extractFn(name) {
  const startIdx = html.indexOf('function ' + name);
  if (startIdx < 0) return null;
  const openIdx = html.indexOf('{', startIdx);
  if (openIdx < 0) return null;

  let depth = 0;
  let i = openIdx;
  let inStr = null;       // '"' | "'" | '`' or null
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  let inRegexClass = false;

  function prevNonSpace(idx) {
    let j = idx - 1;
    while (j >= 0 && /\s/.test(html[j])) j--;
    return j >= 0 ? html[j] : '';
  }

  while (i < html.length) {
    const ch = html[i];
    const next = html[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
    } else if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
    } else if (inRegex) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inRegexClass = true;
      else if (ch === ']') inRegexClass = false;
      else if (ch === '/' && !inRegexClass) inRegex = false;
    } else {
      if (ch === '/' && next === '*') { inBlockComment = true; i++; }
      else if (ch === '/' && next === '/') {
        // Heuristic: this is a line comment ONLY if the prev token isn't an
        // operator/punctuator that would imply this is a regex literal.
        // Operators that typically precede regex: ( , = ! & | ? : ; { } + - * ~ < >
        const p = prevNonSpace(i);
        if (/[(,=!&|?:;{}+\-*~<>]/.test(p) || p === '' || p === 'n' /* return */) {
          // Treat as regex literal start
          inRegex = true;
        } else {
          inLineComment = true;
          i++;
        }
      } else if (ch === '/') {
        // Possible regex literal — same heuristic as above
        const p = prevNonSpace(i);
        if (/[(,=!&|?:;{}+\-*~<>]/.test(p) || p === '') {
          inRegex = true;
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
      } else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return html.slice(startIdx, i + 1);
      }
    }
    i++;
  }
  return null;
}

const helpers = ['_paesc', '_paemptyState', 'subCheckDrawer', '_paHmSignalsHtml', '_paAtsSynonymsHtml', '_paVoiceRuleFailuresHtml', '_paBuildSubCheckDrawersHtml'];
const helperSrc = helpers.map(n => extractFn(n));
helpers.forEach((n, i) => {
  check('T2-' + (i + 1) + ' helper ' + n + ' extractable', !!helperSrc[i], { name: n, found: !!helperSrc[i] });
});

if (helperSrc.every(Boolean)) {
  const sandbox = { console, window: {} };
  const ctx = vm.createContext(sandbox);
  const code = helperSrc.join('\n\n') + '\nmodule = { exports: { _paesc, _paemptyState, subCheckDrawer, _paHmSignalsHtml, _paAtsSynonymsHtml, _paVoiceRuleFailuresHtml, _paBuildSubCheckDrawersHtml } };';
  vm.runInContext(code, ctx);
  const fns = sandbox.module.exports;

  // ────────────────────────────────────────────────────────────────────
  // Section 3: _paesc — HTML escape correctness
  // ────────────────────────────────────────────────────────────────────

  check('T3-1 _paesc escapes <', fns._paesc('<script>') === '&lt;script&gt;', fns._paesc('<script>'));
  check('T3-2 _paesc escapes &', fns._paesc('foo&bar') === 'foo&amp;bar', fns._paesc('foo&bar'));
  check('T3-3 _paesc escapes "', fns._paesc('a"b') === 'a&quot;b', fns._paesc('a"b'));
  check('T3-4 _paesc handles null', fns._paesc(null) === '', fns._paesc(null));
  check('T3-5 _paesc handles undefined', fns._paesc(undefined) === '', fns._paesc(undefined));
  check('T3-6 _paesc handles numbers', fns._paesc(42) === '42', fns._paesc(42));
  check('T3-7 _paesc preserves safe ASCII', fns._paesc('hello world!') === 'hello world!', fns._paesc('hello world!'));

  // ────────────────────────────────────────────────────────────────────
  // Section 4: subCheckDrawer — output structure
  // ────────────────────────────────────────────────────────────────────

  {
    const out = fns.subCheckDrawer({ title: 'Test', count: 5, bodyHtml: '<p>body</p>' });
    check('T4-1 subCheckDrawer wraps content in <details>',
      /<details class="pre-apply-sub-drawer"/.test(out) && /<\/details>$/.test(out), out.slice(0, 200));
    check('T4-2 subCheckDrawer includes title (escaped)', /Test/.test(out), null);
    check('T4-3 subCheckDrawer includes count badge', />5</.test(out), null);
    check('T4-4 subCheckDrawer includes body html unescaped', /<p>body<\/p>/.test(out), null);
    check('T4-5 subCheckDrawer includes chevron',
      /pre-apply-sub-drawer-chev/.test(out), null);
  }
  {
    const out = fns.subCheckDrawer({ title: '<bad>', count: 0, bodyHtml: '<p></p>' });
    check('T4-6 subCheckDrawer escapes title for XSS safety',
      /&lt;bad&gt;/.test(out) && !/<bad>/.test(out.replace(/<bad>/, '')), out);
  }
  {
    const out = fns.subCheckDrawer({ title: 'Test', count: 0, bodyHtml: '' });
    check('T4-7 subCheckDrawer renders zero count badge', />0</.test(out), out.slice(0, 200));
  }

  // ────────────────────────────────────────────────────────────────────
  // Section 5: _paHmSignalsHtml — HM signals + gaps
  // ────────────────────────────────────────────────────────────────────

  // Empty checks
  check('T5-1 empty checks → empty state',
    /No HM signals reported/.test(fns._paHmSignalsHtml({})), null);
  check('T5-2 hm.signals=[] + hm.gaps=[] → empty state',
    /No HM signals reported/.test(fns._paHmSignalsHtml({ hm: { signals: [], gaps: [] } })), null);

  // Signals only
  {
    const checks = { hm: { signals: ['Builds fast', 'Ships quality', 'Hates politics'], gaps: [] } };
    const out = fns._paHmSignalsHtml(checks);
    check('T5-3 signals-only → Matched header', /Matched \(3\)/.test(out), out);
    check('T5-3 signals-only → all 3 items', /Builds fast/.test(out) && /Ships quality/.test(out) && /Hates politics/.test(out), null);
    check('T5-3 signals-only → green checkmarks', /color:var\(--green-fg/.test(out), null);
    check('T5-3 signals-only → no Gaps section', !/Gaps \(/.test(out), null);
  }

  // Gaps only
  {
    const checks = { hm: { signals: [], gaps: ['Lacks PhD', 'No FAANG'] } };
    const out = fns._paHmSignalsHtml(checks);
    check('T5-4 gaps-only → Gaps header', /Gaps \(2\)/.test(out), out);
    check('T5-4 gaps-only → no Matched section', !/Matched \(/.test(out), null);
    check('T5-4 gaps-only → muted dot indicators', /color:var\(--text-3/.test(out), null);
  }

  // Mixed
  {
    const checks = { hm: { signals: ['Built ML'], gaps: ['No PhD', 'No FAANG'] } };
    const out = fns._paHmSignalsHtml(checks);
    check('T5-5 mixed → both sections', /Matched \(1\)/.test(out) && /Gaps \(2\)/.test(out), out);
  }

  // XSS guard
  {
    const checks = { hm: { signals: ['<img src=x onerror=alert(1)>'], gaps: [] } };
    const out = fns._paHmSignalsHtml(checks);
    check('T5-6 signal text is escaped',
      /&lt;img src=x onerror=alert\(1\)&gt;/.test(out) && !/<img src=x/.test(out), out);
  }

  // ────────────────────────────────────────────────────────────────────
  // Section 6: _paAtsSynonymsHtml — ATS synonyms
  // ────────────────────────────────────────────────────────────────────

  // Empty
  check('T6-1 empty checks → empty state',
    /No synonym matches detected/.test(fns._paAtsSynonymsHtml({})), null);
  check('T6-2 ats.synonyms_detected=[] → empty state',
    /No synonym matches detected/.test(fns._paAtsSynonymsHtml({ ats: { synonyms_detected: [] } })), null);

  // Populated
  {
    const checks = {
      ats: {
        synonyms_detected: [
          { keyword: 'aws', synonym: 'amazon web services' },
          { keyword: 'ml', synonym: 'machine learning' },
          { keyword: 'llm', synonym: 'large language model' },
        ],
      },
    };
    const out = fns._paAtsSynonymsHtml(checks);
    check('T6-3 3 synonyms → 3 badges',
      (out.match(/<span style="display:inline-flex/g) || []).length === 3, out);
    check('T6-3 includes keyword "aws"', /<strong[^>]*>aws<\/strong>/.test(out), null);
    check('T6-3 includes synonym "amazon web services"', /amazon web services/.test(out), null);
    check('T6-3 includes ↔ arrow', /↔/.test(out), null);
  }

  // XSS guard
  {
    const checks = { ats: { synonyms_detected: [{ keyword: '<x>', synonym: '<y>' }] } };
    const out = fns._paAtsSynonymsHtml(checks);
    check('T6-4 synonym text is escaped',
      /&lt;x&gt;/.test(out) && /&lt;y&gt;/.test(out), out);
  }

  // Defensive: missing fields
  {
    const checks = { ats: { synonyms_detected: [{}, { keyword: 'only-key' }] } };
    const out = fns._paAtsSynonymsHtml(checks);
    check('T6-5 missing synonym fields → still renders without crash',
      (out.match(/<span style="display:inline-flex/g) || []).length === 2, out);
  }

  // ────────────────────────────────────────────────────────────────────
  // Section 7: _paVoiceRuleFailuresHtml — voice rule failures
  // ────────────────────────────────────────────────────────────────────

  // Empty
  check('T7-1 empty checks → empty state',
    /No voice rule failures detected/.test(fns._paVoiceRuleFailuresHtml({})), null);
  check('T7-2 voice.rule_failures=[] → empty state',
    /No voice rule failures detected/.test(fns._paVoiceRuleFailuresHtml({ voice: { rule_failures: [] } })), null);

  // Populated with rich shape
  {
    const checks = {
      voice: {
        rule_failures: [
          { rule: 'banned_vocabulary: "leverage" used 3x', severity: 'critical', artifact: 'cv' },
          { rule: 'em_dash_density: 12 em-dashes in 8 sentences', severity: 'soft', artifact: 'cover_letter' },
        ],
      },
    };
    const out = fns._paVoiceRuleFailuresHtml(checks);
    check('T7-3 2 failures → 2 list items',
      (out.match(/<li /g) || []).length === 2, out);
    check('T7-3 critical severity pill present',
      />critical</.test(out) && /color:var\(--red-fg/.test(out), null);
    check('T7-3 soft severity pill present',
      />soft</.test(out) && /color:var\(--amber-fg/.test(out), null);
    check('T7-3 artifact pill present', /\[cv\]/.test(out) && /\[cover_letter\]/.test(out), null);
    check('T7-3 rule text present', /banned_vocabulary/.test(out) && /em_dash_density/.test(out), null);
  }

  // String-shape rule failure (legacy)
  {
    const checks = { voice: { rule_failures: ['raw rule text', 'another one'] } };
    const out = fns._paVoiceRuleFailuresHtml(checks);
    check('T7-4 string rule_failures render as plain rows',
      /raw rule text/.test(out) && /another one/.test(out), out);
    check('T7-4 string-shape → no severity pill', !/>critical</.test(out) && !/>soft</.test(out), null);
  }

  // XSS guard on rule text
  {
    const checks = { voice: { rule_failures: [{ rule: '<script>alert(1)</script>', severity: 'critical' }] } };
    const out = fns._paVoiceRuleFailuresHtml(checks);
    check('T7-5 rule text is escaped',
      /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(out) && !/<script>alert/.test(out.replace(/<script>alert\(1\)<\/script>/, '')), out);
  }

  // Defensive: missing all fields
  {
    const checks = { voice: { rule_failures: [{}] } };
    const out = fns._paVoiceRuleFailuresHtml(checks);
    check('T7-6 empty failure object → still renders 1 row',
      (out.match(/<li /g) || []).length === 1, out);
  }

  // ────────────────────────────────────────────────────────────────────
  // Section 8: _paBuildSubCheckDrawersHtml — composite
  // ────────────────────────────────────────────────────────────────────

  // null/undefined input
  check('T8-1 null input → empty string',
    fns._paBuildSubCheckDrawersHtml(null) === '', null);
  check('T8-2 undefined input → empty string',
    fns._paBuildSubCheckDrawersHtml(undefined) === '', null);
  check('T8-3 non-object input → empty string',
    fns._paBuildSubCheckDrawersHtml('not-an-object') === '', null);

  // Empty checks object
  {
    const out = fns._paBuildSubCheckDrawersHtml({});
    check('T8-4 empty checks → 3 drawers rendered',
      (out.match(/<details class="pre-apply-sub-drawer"/g) || []).length === 3, out.slice(0, 300));
    check('T8-4 empty checks → "Sub-check details" header present',
      /Sub-check details/.test(out), null);
    check('T8-4 empty checks → all 3 drawer titles present',
      /HM-match signals/.test(out) && /ATS synonyms detected/.test(out) && /Voice rule failures/.test(out), null);
  }

  // Realistic populated checks (simulating row 001 with hm signals)
  {
    const checks = {
      hm: {
        status: 'pass',
        signals: ['Communications excellence', 'Builds for AI safety'],
        gaps: ['No FAANG'],
      },
      ats: {
        status: 'caveats',
        synonyms_detected: [{ keyword: 'ml', synonym: 'machine learning' }],
      },
      voice: {
        status: 'pass',
        rule_failures: [{ rule: 'em_dash_density: 8 in 5 sentences', severity: 'soft', artifact: 'cv' }],
      },
    };
    const out = fns._paBuildSubCheckDrawersHtml(checks);
    check('T8-5 realistic checks → 3 drawers rendered',
      (out.match(/<details class="pre-apply-sub-drawer"/g) || []).length === 3, null);
    check('T8-5 HM drawer count = signals + gaps = 3', />3</.test(out), null);
    check('T8-5 ATS drawer count = 1', />1</.test(out), null);
    check('T8-5 HM content present (Communications excellence)',
      /Communications excellence/.test(out), null);
    check('T8-5 ATS content present (ml ↔ machine learning)',
      /<strong[^>]*>ml<\/strong>/.test(out) && /machine learning/.test(out), null);
    check('T8-5 voice content present (em_dash_density)',
      /em_dash_density/.test(out), null);
  }

  // Count math edge: zero signals + zero gaps
  {
    const checks = { hm: { signals: [], gaps: [] }, ats: { synonyms_detected: [] }, voice: { rule_failures: [] } };
    const out = fns._paBuildSubCheckDrawersHtml(checks);
    // Each drawer summary should show count of 0
    const zeroCount = (out.match(/>0</g) || []).length;
    check('T8-6 all zero → 3 zero count badges', zeroCount >= 3, { zeroCount });
  }

  // Closed by default (no open attribute)
  {
    const checks = { hm: { signals: ['x'], gaps: [] } };
    const out = fns._paBuildSubCheckDrawersHtml(checks);
    check('T8-7 drawers closed by default (no `open` attribute)',
      !/<details[^>]+open[^>]*pre-apply-sub-drawer/.test(out), out);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────

console.log('');
console.log('Summary: ' + pass + ' pass, ' + fail + ' fail (' + (pass + fail) + ' total)');
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  -', f.name);
  process.exit(1);
}
process.exit(0);
