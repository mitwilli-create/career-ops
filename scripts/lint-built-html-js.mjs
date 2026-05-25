#!/usr/bin/env node
/**
 * scripts/lint-built-html-js.mjs
 *
 * Extracts every <script>...</script> block from `dashboard/index.html` and
 * validates each as parseable JavaScript via `new Function(content)`.
 *
 * Catches the "outer-template-unescape" bug class: when an inner JS string
 * literal in scripts/build-dashboard.mjs contains a single-backslash escape
 * (`\n`, `\r`, `\t`, etc.), the outer backtick template literal unescapes it
 * BEFORE writing to dashboard/index.html — corrupting the JS string with a
 * literal control character, which the browser then parses as a SyntaxError.
 *
 * The safe pattern is either:
 *   - Double the escape in the source: `'\\n\\n'`  (preserves \n in the output)
 *   - Use String.fromCharCode(N): `String.fromCharCode(10)` (real newline at runtime)
 *
 * Usage:
 *   node scripts/lint-built-html-js.mjs                    # exit 0 if clean
 *   node scripts/lint-built-html-js.mjs --file <path.html> # check a specific HTML file
 *
 * Exits 0 on clean, 1 on parse errors, 2 on usage error.
 *
 * History:
 *   2026-05-19 — Mitchell sweep, created after fixing 2 instances of this bug
 *                class (NL in confirmTier5Run, CR in _updatePipelineToast).
 */

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
let targetFiles = ['dashboard/index.html'];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    targetFiles = [args[i + 1]];
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: node scripts/lint-built-html-js.mjs [--file <path.html>]');
    process.exit(0);
  }
}

let totalBlocks = 0;
let totalFailed = 0;
const failures = [];

for (const file of targetFiles) {
  if (!existsSync(file)) {
    console.error(`✗ ${file}: file not found`);
    process.exit(2);
  }
  const html = readFileSync(file, 'utf-8');
  let pos = 0;
  let blockIdx = 0;
  while (true) {
    const openIdx = html.indexOf('<script', pos);
    if (openIdx < 0) break;
    const openEnd = html.indexOf('>', openIdx);
    if (openEnd < 0) break;
    const openTag = html.slice(openIdx, openEnd + 1);
    // Skip external scripts (no inline content to validate)
    if (/\bsrc\s*=/.test(openTag)) {
      pos = openEnd + 1;
      continue;
    }
    const closeIdx = html.indexOf('</script>', openEnd);
    if (closeIdx < 0) break;
    const content = html.slice(openEnd + 1, closeIdx);
    const startLine = html.slice(0, openIdx).split('\n').length;
    blockIdx++;
    totalBlocks++;
    try {
      // V8 parser via Function constructor — throws on SyntaxError, doesn't execute
      new Function(content);
    } catch (err) {
      totalFailed++;
      const lineMatch = /<anonymous>:(\d+):(\d+)/.exec(err.stack || '');
      const errLine = lineMatch ? parseInt(lineMatch[1], 10) : null;
      const absLine = errLine ? (startLine + errLine - 1) : startLine;
      const blockLines = content.split('\n');
      let snippet = '';
      if (errLine && errLine > 0 && errLine <= blockLines.length) {
        const from = Math.max(0, errLine - 2);
        const to = Math.min(blockLines.length, errLine + 1);
        snippet = blockLines.slice(from, to).map((l, i) => {
          const ln = from + i + 1;
          const marker = ln === errLine ? '> ' : '  ';
          return '    ' + marker + ln + ': ' + l.slice(0, 240);
        }).join('\n');
      }
      failures.push({ file, block: blockIdx, startLine, absLine, message: err.message, snippet });
    }
    pos = closeIdx + '</script>'.length;
  }
}

if (totalFailed > 0) {
  console.error(`✗ ${totalFailed} of ${totalBlocks} inline <script> blocks failed to parse:\n`);
  for (const f of failures) {
    console.error(`  ${f.file} block #${f.block} (~HTML line ${f.absLine})`);
    console.error(`    ${f.message}`);
    if (f.snippet) console.error(f.snippet);
    console.error('');
  }
  console.error('Hint: the outer-template-unescape bug class strikes when an inner JS string literal');
  console.error('      contains \\n / \\r / \\t (single backslash). Replace with String.fromCharCode(N)');
  console.error('      or use double-backslash (\\\\n) so the escape survives the outer template.');
  process.exit(1);
}

console.log(`✓ ${totalBlocks} inline <script> block(s) parsed cleanly across ${targetFiles.length} file(s).`);

// ── 4.11 (2026-05-24) — Double-line-break + empty-p content lint ──────────────
// Catches the comp-section / outreach-section content rendering bug class where
// the prose generator emits `<br><br>`, `<br/><br/>`, or `<p></p>` separators.
// Both create unwanted "wall of text" gaps that the dashboard CSS doesn't
// neutralize. WARNING-only by default — flip to fail via LINT_HTML_CONTENT=fail.
// Spec: data/closure-prompt-06-gap-audit-2026-05-21.md § 4.11.
//
// Bypass: set LINT_HTML_CONTENT=off to skip entirely (emergency only).
const contentMode = String(process.env.LINT_HTML_CONTENT || 'warn').toLowerCase();
if (contentMode === 'off') {
  process.exit(0);
}

let contentIssues = 0;
const contentFindings = [];

for (const file of targetFiles) {
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf-8');
  // Pattern 1: double <br> (with or without self-close, with intervening whitespace)
  const brBrRe = /<br\s*\/?>\s*<br\s*\/?>/gi;
  let m;
  while ((m = brBrRe.exec(html)) !== null) {
    const ln = html.slice(0, m.index).split('\n').length;
    contentIssues++;
    contentFindings.push({ file, line: ln, pattern: 'double <br>', match: m[0].slice(0, 60) });
  }
  // Pattern 2: empty <p></p> (with optional whitespace inside).
  // Skip elements with `id=` — those are JS injection targets (e.g.,
  // `<p id="be-stat-modal-subhead"></p>` gets populated at runtime).
  const emptyPRe = /<p([^>]*)>\s*<\/p>/gi;
  while ((m = emptyPRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bid\s*=/.test(attrs)) continue;  // injection-target placeholder; intentional
    const ln = html.slice(0, m.index).split('\n').length;
    contentIssues++;
    contentFindings.push({ file, line: ln, pattern: 'empty <p></p>', match: m[0].slice(0, 60) });
  }
  // Pattern 3: <br> directly followed by empty <p></p> (combined separator abuse).
  // Same id-skip rule applies.
  const brEmptyPRe = /<br\s*\/?>\s*<p([^>]*)>\s*<\/p>/gi;
  while ((m = brEmptyPRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bid\s*=/.test(attrs)) continue;
    const ln = html.slice(0, m.index).split('\n').length;
    contentIssues++;
    contentFindings.push({ file, line: ln, pattern: '<br> + empty <p>', match: m[0].slice(0, 60) });
  }
}

if (contentIssues > 0) {
  const tag = contentMode === 'fail' ? '✗' : '⚠';
  console.error(`${tag} ${contentIssues} HTML content lint finding(s) (4.11 — double-br / empty-p):`);
  // Group by file
  const byFile = {};
  for (const f of contentFindings) {
    if (!byFile[f.file]) byFile[f.file] = [];
    byFile[f.file].push(f);
  }
  for (const [file, items] of Object.entries(byFile)) {
    console.error(`  ${file} — ${items.length} finding(s)`);
    const sample = items.slice(0, 6);
    for (const it of sample) {
      console.error(`    line ${it.line}: ${it.pattern} — ${JSON.stringify(it.match)}`);
    }
    if (items.length > sample.length) {
      console.error(`    ... and ${items.length - sample.length} more`);
    }
  }
  console.error('');
  console.error('Hint: prose generators (drawer outreach, comp intel) should emit semantic block');
  console.error('      elements, not <br><br> or <p></p>. Strip in render or in the generator.');
  console.error(`      Run with LINT_HTML_CONTENT=off to skip. Default mode: warn.`);
  if (contentMode === 'fail') {
    process.exit(1);
  }
}

process.exit(0);
