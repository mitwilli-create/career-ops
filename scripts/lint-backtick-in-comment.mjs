#!/usr/bin/env node
// scripts/lint-backtick-in-comment.mjs
//
// Catches the "outer-template-unescape § Backtick-in-comment variant" bug class.
//
// The mechanism: scripts/build-dashboard.mjs wraps the entire HTML output in a
// single backtick-delimited template literal. The literal includes `${...}`
// interpolations (JS code, where backticks are legal) and quasi portions (pure
// string, where ANY unescaped backtick would close the template prematurely).
//
// If a developer writes an unescaped backtick INSIDE A QUASI PORTION — including
// inside an HTML or CSS comment that's emitted as part of the output string —
// the outer template closes at that backtick + the rest of the line gets parsed
// as JavaScript expressions, producing cryptic SyntaxError or ReferenceError at
// BUILD TIME.
//
// Detection: parse the source with Acorn. If it parses, the file is structurally
// sound — any backticks present are legal (in expressions, escaped, or as
// nested template delimiters). If it FAILS to parse with a template-related
// error, this is almost certainly the backtick-in-comment bug class. Report
// the failure location with surrounding context.
//
// Single responsibility — this script does NOT scan for non-syntax issues. Use
// scripts/lint-built-html-js.mjs to validate the BUILT HTML's inline <script>
// blocks (different surface, different failure mode).
//
// AGENTS.md § Bug class: outer-template-unescape § Backtick-in-comment variant.
//
// Usage:
//   node scripts/lint-backtick-in-comment.mjs [path-to-build-dashboard.mjs]

import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const FILE = process.argv[2] || 'scripts/build-dashboard.mjs';

let src;
try {
  src = readFileSync(FILE, 'utf-8');
} catch (e) {
  console.error(`✗ lint-backtick-in-comment: cannot read ${FILE}: ${e.message}`);
  process.exit(2);
}

try {
  parse(src, {
    ecmaVersion: 2022,
    sourceType: 'module',
    allowHashBang: true,
    locations: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: false,
  });
} catch (e) {
  console.error(`✗ lint-backtick-in-comment: ${FILE} failed to parse`);
  console.error('');
  console.error(`  Acorn error: ${e.message}`);

  if (e.loc) {
    const lines = src.split('\n');
    const errLine = e.loc.line;
    const ctxStart = Math.max(1, errLine - 3);
    const ctxEnd = Math.min(lines.length, errLine + 1);
    console.error('');
    console.error('  Surrounding context:');
    for (let i = ctxStart; i <= ctxEnd; i++) {
      const marker = i === errLine ? '→ ' : '  ';
      const line = (lines[i - 1] || '').slice(0, 160);
      console.error(`  ${marker}${String(i).padStart(5)}: ${line}`);
    }
    console.error('');

    // Heuristic: scan the error-line + neighbors for unescaped backticks in comments.
    const candidateLines = [];
    for (let i = Math.max(1, errLine - 5); i <= errLine; i++) {
      const line = lines[i - 1] || '';
      // Find // line comments OR /* ... */ block comments that contain a raw backtick.
      const commentMatch = scanLineForCommentBacktick(line);
      if (commentMatch) candidateLines.push({ line: i, text: line, where: commentMatch });
    }

    if (candidateLines.length > 0) {
      console.error('  Likely culprits (backticks inside JS comments near the error):');
      for (const c of candidateLines.slice(0, 5)) {
        console.error(`    ${FILE}:${c.line}: ${c.text.trim().slice(0, 120)}`);
      }
      console.error('');
    } else {
      console.error('  (No obvious backtick-in-comment near the error line; could be a different');
      console.error('   shape of outer-template-unescape — e.g. raw backtick in a string literal,');
      console.error('   or a missing closing backtick somewhere earlier in the template.)');
      console.error('');
    }
  }

  console.error('  Bug class: outer-template-unescape § Backtick-in-comment variant');
  console.error('  See AGENTS.md § Bug class: outer-template-unescape');
  console.error('  Fix: find the unescaped backtick (`) in the line(s) above and either:');
  console.error('       - replace with single-quote prose (e.g. "pipe-delimited" instead of `|...|`)');
  console.error('       - escape it with backslash: \\`');
  console.error('       - rephrase the comment to avoid backticks entirely');
  process.exit(1);
}

console.log(`✓ lint-backtick-in-comment: ${FILE} parses cleanly. No template-literal closure bugs.`);

// --- helpers ---

// Scan a single line for the pattern "unescaped backtick inside a JS comment".
// Returns { kind: 'line'|'block', col } on first hit, or null.
// Heuristic-only — does not track multi-line block comment state. The caller
// is expected to use this on lines near a known parse error, where the noisy
// false-positive rate is acceptable.
function scanLineForCommentBacktick(line) {
  // Line comment detection
  let inStr = null;
  let i = 0;
  let commentStart = -1;
  while (i < line.length - 1) {
    const c = line[i];
    const n = line[i + 1];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) { inStr = null; i++; continue; }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      commentStart = i;
      break;
    }
    if (c === '/' && n === '*') {
      // Block comment — check for backtick before closing.
      const close = line.indexOf('*/', i + 2);
      const body = line.slice(i, close < 0 ? line.length : close + 2);
      if (hasRawBacktick(body)) return { kind: 'block', col: i + 1 };
      i = close < 0 ? line.length : close + 2;
      continue;
    }
    i++;
  }
  if (commentStart >= 0) {
    const body = line.slice(commentStart);
    if (hasRawBacktick(body)) return { kind: 'line', col: commentStart + 1 };
  }
  return null;
}

function hasRawBacktick(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) return true;
    }
  }
  return false;
}
