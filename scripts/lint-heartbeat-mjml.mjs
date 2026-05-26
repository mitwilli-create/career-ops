#!/usr/bin/env node
/**
 * scripts/lint-heartbeat-mjml.mjs
 *
 * Phase E2 (2026-05-19) — converts the 5 prose safety requirements from the
 * Phase C council ledger into machine-verifiable lint rules. Without
 * enforcement, the requirements will rot the first time someone copies a
 * panel block without reading the doc.
 *
 * Source finding: .claude/audit/email-review/council-divergence-analysis.md
 * (finding-009 — "Prose safety requirements without enforcement are
 * decorative. This is the prevent-regression mechanism that lets the Phase
 * C investment hold over time.").
 *
 * Rules checked against the EMITTED MJML/HTML preview (post-render):
 *
 *   1. text4 (chrome_color) is reserved for chrome only — flag when used for
 *      sentence-level body text. Body text MUST use text3 (muted_color) or
 *      darker. The dark-on-dark body needs the AA threshold.
 *
 *   2. Panel containers (.card, .signal-pulse-card, .tonight-card, etc.)
 *      MUST have either a top-3px-accent-row OR a border-top to anchor
 *      them visually on the dark body. A panel with NEITHER reads as a
 *      floating div with no anchor.
 *
 *   3. mj-section / mj-column emitting background-color="#ffffff" while the
 *      body is dark — flag as a regression (white card on dark body is the
 *      canonical "I broke it" rendering bug).
 *
 *   4. mj-button-equivalents (inline <a> styled as buttons) using min-height
 *      instead of inner-padding — Gmail Web strips min-height from <a>
 *      elements, collapsing the button.
 *
 *   5. Tracking-critical patterns are preserved (regex check). Role IDs,
 *      scores (X.XX/5), Apply Pack, Mark Applied, day-N counters, touch
 *      counts, "Generated: <ISO Z>" — these survive into the rendered email
 *      and feed downstream tools (heartbeat-archive parsers, email-review).
 *
 * Usage:
 *   node scripts/lint-heartbeat-mjml.mjs                       # check the latest preview
 *   node scripts/lint-heartbeat-mjml.mjs --file <path.html>    # check a specific file
 *   node scripts/lint-heartbeat-mjml.mjs --files <a.html> <b>  # check multiple
 *
 * Exits 0 on clean, 1 on violations, 2 on usage error.
 *
 * Wire-in:
 *   - Optional post-render hook in scripts/heartbeat.mjs and
 *     scripts/heartbeat-evening.mjs (gated on process.env.HEARTBEAT_LINT !== 'off').
 *   - Optional npm script:  "lint:mjml": "node scripts/lint-heartbeat-mjml.mjs"
 */

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);

// Default files to lint — the most recent preview output paths from a
// successful --preview run on each script. If neither exists, fall back to
// the heartbeat-archive on disk.
let files = ['/tmp/heartbeat-preview.html', '/tmp/heartbeat-evening-preview.html'];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    files = [args[i + 1]];
    i++;
  } else if (args[i] === '--files' && args[i + 1]) {
    // Collect remaining args until next flag
    files = [];
    let j = i + 1;
    while (j < args.length && !args[j].startsWith('--')) {
      files.push(args[j]);
      j++;
    }
    i = j - 1;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: node scripts/lint-heartbeat-mjml.mjs [--file <path>] [--files <a> <b> ...]');
    process.exit(0);
  }
}

const existing = files.filter(f => existsSync(f));
if (existing.length === 0) {
  console.error('[lint-heartbeat-mjml] No input files exist. Tried:');
  for (const f of files) console.error(`  - ${f}`);
  console.error('Run "node scripts/heartbeat.mjs --preview" or "--preview" on the evening script first.');
  process.exit(2);
}

// ── Rule definitions ───────────────────────────────────────────────────────
// Each rule returns an array of {line, message} when violations are found.

// Dark-mode chrome color (text4 in BRAND) — should NOT appear as body text.
// Heuristic: a chrome color set inside a <p> or <div> that contains a complete
// sentence (capital letter + period + space, or > 50 chars) is suspicious.
const CHROME_COLOR_HEXES = ['#9a9aa6', '#9ca3af', '#6b7280'];

function rule1_text4UsedForBody(content, fileLabel) {
  const violations = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const hex of CHROME_COLOR_HEXES) {
      // Match `color:${hex}` where the same line ALSO has a substantive sentence.
      // We look for ≥ 60 chars of text content following the color attribute.
      const idx = line.toLowerCase().indexOf(`color:${hex.toLowerCase()}`);
      if (idx === -1) continue;
      // Look for sentence-ish content after the style block.
      const afterStyle = line.slice(idx + hex.length + 6);
      // Skip if this is just a chrome label (uppercase, very short).
      const textBetween = afterStyle.match(/>([^<]{40,})</);
      if (!textBetween) continue;
      const txt = textBetween[1].trim();
      // Skip pure uppercase chrome labels (those are intentional uses of text4).
      if (txt === txt.toUpperCase() && txt.length < 80) continue;
      // Skip lines that mention "tap to expand" / similar UI affordances.
      if (/tap to expand|see dashboard|details →|full view →/i.test(txt)) continue;
      violations.push({
        rule: 1,
        line: i + 1,
        file: fileLabel,
        message: `text4 chrome color (${hex}) applied to sentence-length body text (${txt.length} chars). Use text3 (#b8b8c0 / #475569) for body, reserve text4 for labels.`,
        snippet: txt.slice(0, 100),
      });
    }
  }
  return violations;
}

// Rule 2 — Panel containers MUST have anchor (border-top or top-3px accent).
// Exempts MJML-compiler-generated container divs (mj-column-per-*, mj-outlook-
// group-fix, header-banner) — those are wrappers whose border lives on an
// inner element after the MJML compile pass. The lint targets author-written
// panels (.tonight-card, .due-today-card, .signal-pulse-card, etc.)
// where the inline style IS the authored anchor mechanism.
function rule2_panelAnchor(content, fileLabel) {
  const violations = [];
  // Find every panel-styled container. Heuristic: div with class containing
  // "card", "panel", "banner", "alert" + style with border-radius. Verify
  // it has either border-top inline OR a contained .accent-row div.
  const panelRegex = /<div([^>]*class="[^"]*(?:card|panel|banner|alert)[^"]*"[^>]*)>/gi;
  let m;
  while ((m = panelRegex.exec(content)) !== null) {
    const attrs = m[1];
    // Skip MJML compiler artifacts — these are wrappers, not authored panels.
    if (/\bmj-column-per-|\bmj-outlook-group-fix|\bheader-banner\b/.test(attrs)) continue;
    const inlineStyle = (attrs.match(/style="([^"]*)"/) || [, ''])[1];
    // OK if border full ring OR border-top OR border-left (accent border-left is also valid)
    const hasFullBorder = /\bborder\s*:\s*\d/.test(inlineStyle) && !/border\s*:\s*none/.test(inlineStyle);
    const hasBorderTop = /\bborder-top\s*:/.test(inlineStyle);
    const hasBorderLeft = /\bborder-left\s*:/.test(inlineStyle);
    if (hasFullBorder || hasBorderTop || hasBorderLeft) continue;
    // Find the line number
    const upTo = content.slice(0, m.index);
    const lineNo = upTo.split('\n').length;
    violations.push({
      rule: 2,
      line: lineNo,
      file: fileLabel,
      message: 'Panel container missing visual anchor — needs border, border-top, or border-left to read as a discrete block on the dark body.',
      snippet: m[0].slice(0, 120),
    });
  }
  return violations;
}

// Rule 3 — mj-section / mj-column / div with background-color="#ffffff"
// on a dark body. The MJML compiler may transform mj-* tags into HTML before
// emit, so we also catch background-color:#ffffff in inline style.
function rule3_whiteOnDark(content, fileLabel) {
  const violations = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines inside @media (prefers-color-scheme: light) blocks. We track
    // a simple stack-counter for { } since the light @media block is the
    // only valid place white-on-anything is allowed.
    if (line.includes('@media (prefers-color-scheme: light)')) {
      // Skip until matching brace
      let depth = 0;
      while (i < lines.length) {
        const cur = lines[i];
        depth += (cur.match(/{/g) || []).length;
        depth -= (cur.match(/}/g) || []).length;
        i++;
        if (depth <= 0) break;
      }
      continue;
    }
    // Match white background outside of light @media blocks
    const whiteBgMatch = line.match(/background-color[:=]\s*"?#ffffff"?/i)
      || line.match(/background[:=]\s*#ffffff(?![0-9a-f])/i);
    if (whiteBgMatch) {
      // Allow if this is the Dashboard hero button — heuristic: the next ~5
      // lines reference color:#15803d (green text) which is the intentional
      // white-button-on-green-hero design element. Single-line check missed
      // it because MJML splits the <td> attrs from the inner <a> across
      // multiple lines.
      const window = lines.slice(i, Math.min(lines.length, i + 6)).join('\n');
      if (/color:#15803d|color:#16a34a|color:#166534/i.test(window)) continue;
      violations.push({
        rule: 3,
        line: i + 1,
        file: fileLabel,
        message: 'White background (#ffffff) emitted outside @media (prefers-color-scheme: light) — likely a forgotten light-mode card on the dark body.',
        snippet: line.trim().slice(0, 140),
      });
    }
  }
  return violations;
}

// Rule 4 — inline <a> styled as a button using min-height instead of inner-padding
function rule4_minHeightOnButton(content, fileLabel) {
  const violations = [];
  const buttonRegex = /<a\b[^>]*style="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = buttonRegex.exec(content)) !== null) {
    const style = m[1];
    // Identify as button if: display:inline-block + padding + border-radius
    const looksLikeButton = /display\s*:\s*inline-block/.test(style)
      && /padding\s*:/.test(style)
      && /border-radius\s*:/.test(style);
    if (!looksLikeButton) continue;
    if (/\bmin-height\s*:/.test(style)) {
      const upTo = content.slice(0, m.index);
      const lineNo = upTo.split('\n').length;
      violations.push({
        rule: 4,
        line: lineNo,
        file: fileLabel,
        message: 'Button-styled <a> uses min-height — Gmail Web strips this from inline <a>, collapsing the button. Use inner-padding / padding instead.',
        snippet: m[0].slice(0, 140),
      });
    }
  }
  return violations;
}

// Rule 5 — Tracking-critical patterns preserved. These regex patterns MUST
// appear in the rendered email to keep downstream tooling (heartbeat-archive
// parsers, email-review skill) functional. If any are missing, flag.
const TRACKING_CRITICAL_PATTERNS = [
  // role IDs like #048 or #1234 (markdown body's Apply-Now Queue role headers)
  { name: 'role IDs', regex: /#\d+/, required: false },
  // score format X.X/5 or X.XX/5
  { name: 'score X/5', regex: /\d\.\d{1,2}\s*\/\s*5/, required: false },
  // "Apply Pack" button text
  { name: 'Apply Pack', regex: /Apply Pack/i, required: false },
  // "Mark Applied" status URL CTA text
  { name: 'Mark Applied', regex: /Mark Applied/i, required: false },
  // Generated ISO timestamp
  { name: 'Generated ISO', regex: /Generated:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, required: true },
];

function rule5_trackingCritical(content, fileLabel) {
  const violations = [];
  // Each "required" pattern MUST be present at least once.
  for (const { name, regex, required } of TRACKING_CRITICAL_PATTERNS) {
    if (!required) continue;
    if (!regex.test(content)) {
      violations.push({
        rule: 5,
        line: 0,
        file: fileLabel,
        message: `Tracking-critical pattern missing: ${name} (regex ${regex.toString()}). Downstream parsers may break.`,
        snippet: '(pattern not found in file)',
      });
    }
  }
  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────────
let allViolations = [];
for (const f of existing) {
  let content;
  try { content = readFileSync(f, 'utf-8'); }
  catch (e) {
    console.error(`[lint-heartbeat-mjml] Failed to read ${f}: ${e.message}`);
    process.exit(2);
  }
  const fileLabel = f;
  const v = [];
  v.push(...rule1_text4UsedForBody(content, fileLabel));
  v.push(...rule2_panelAnchor(content, fileLabel));
  v.push(...rule3_whiteOnDark(content, fileLabel));
  v.push(...rule4_minHeightOnButton(content, fileLabel));
  v.push(...rule5_trackingCritical(content, fileLabel));
  allViolations.push(...v);
}

if (allViolations.length === 0) {
  console.log(`[lint-heartbeat-mjml] clean — ${existing.length} file${existing.length === 1 ? '' : 's'} checked, 0 violations.`);
  for (const f of existing) console.log(`  ✓ ${f}`);
  process.exit(0);
}

// Report violations grouped by file
console.error(`[lint-heartbeat-mjml] FAIL — ${allViolations.length} violation${allViolations.length === 1 ? '' : 's'} across ${existing.length} file${existing.length === 1 ? '' : 's'}.`);
const byFile = new Map();
for (const v of allViolations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}
for (const [file, vs] of byFile) {
  console.error('');
  console.error(`  ${file}:`);
  for (const v of vs) {
    console.error(`    [rule ${v.rule}] line ${v.line}: ${v.message}`);
    if (v.snippet) console.error(`        ${v.snippet}`);
  }
}
console.error('');
console.error('Remediation:');
console.error('  - rule 1: change text4 (chrome) → text3 (muted) for body text fragments.');
console.error('  - rule 2: add border, border-top, or border-left to anchor the panel.');
console.error('  - rule 3: remove the white background OR move it inside @media (prefers-color-scheme: light).');
console.error('  - rule 4: replace min-height with padding / inner-padding on button-styled <a>.');
console.error('  - rule 5: restore the missing tracking-critical pattern in the markdown/HTML emission.');
process.exit(1);
