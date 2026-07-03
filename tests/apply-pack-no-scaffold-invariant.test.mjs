#!/usr/bin/env node
/**
 * tests/apply-pack-no-scaffold-invariant.test.mjs
 *
 * INVARIANT: every user-facing apply-now artifact contains FINISHED, paste-ready
 * content — never a worksheet. No scaffold markers, no bracket placeholders, no
 * instructions-to-Mitchell, no leaked operational/CLI text.
 *
 * Born 2026-06-03: the dashboard repeatedly handed Mitchell a to-do list instead
 * of answers — scripts/build-apply-packs.mjs::buildFormFields / buildOnePager were
 * STATIC scaffold templates ("[OPEN WITH A SPECIFIC TRIGGER…]", "⚠️ HUMAN REWRITE
 * REQUIRED"), and operational footers ("Re-run node scripts/…", "hand-trim before
 * submitting") leaked into the rendered content. 57 packs were worksheets.
 *
 * This test is the objective definition of "fixed everywhere": it passes ONLY when
 * zero user-facing artifacts carry any banned pattern. A green run IS the proof —
 * not a claim. Wire into test-all.mjs.
 *
 * Exit 0 = clean. Exit 1 = at least one artifact carries banned content (prints
 * every offender as file:line so the gap list is explicit, never buried).
 *
 * Scope env override: APPLY_PACK_INVARIANT_APPLY_NOW_ONLY=1 limits the scan to the
 * apply-now queue's packs (the surface Mitchell actually opens) for staged rollout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_METRIC_PATTERNS, RETIRED_METRIC_PROBES } from '../lib/grounding-guard.mjs';

const ROOT = process.env.CAREER_OPS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Banned patterns — each is "instructions for me to action vs actual useful info".
const BANNED = [
  { re: /HUMAN REWRITE REQUIRED/i,                 label: 'scaffold: HUMAN REWRITE REQUIRED' },
  { re: /\*\*Scaffold\b/i,                          label: 'scaffold: **Scaffold** block' },
  { re: /\bLIGHT EDIT NEEDED\b/i,                   label: 'scaffold: LIGHT EDIT NEEDED' },
  { re: /Human-rewrite risk tracker/i,             label: 'scaffold: risk tracker table' },
  { re: /do NOT paste verbatim/i,                   label: 'scaffold: do-not-paste note' },
  { re: /rewrite (in your own voice|before pasting)/i, label: 'instruction: rewrite-before-pasting' },
  { re: /see eval report Block/i,                   label: 'placeholder: see-eval-report pointer' },
  { re: /\[(OPEN WITH|YOUR |STRONGEST MATCH|SECOND MATCH|SPECIFIC|DOMAIN|WHAT YOU|HONEST|BE SPECIFIC|PAST PROJECT|YOUR SPECIFIC|SPECIFIC DELIVERABLE|SPECIFIC THING|SPECIFIC CONVERSATION|SPECIFIC ARTIFACT|SPECIFIC METRIC|SPECIFIC PROCESS|SPECIFIC CHALLENGE|HONEST FRICTION|PRODUCT NAME|NAME)/i, label: 'placeholder: [BRACKET PROMPT]' },
  { re: /\[insert|\binsert your\b|<insert/i,        label: 'placeholder: [insert …]' },
  { re: /\bfill in\b/i,                             label: 'placeholder: fill in' },
  { re: /\[X\]\s*years|\[X\]\b/,                    label: 'placeholder: [X]' },
  { re: /\bbefore submitting\b/i,                   label: 'instruction: before submitting' },
  { re: /\bhand-trim\b/i,                           label: 'instruction: hand-trim' },
  { re: /\bEdit (any|each) field\b/i,               label: 'instruction: edit-any-field note' },
  { re: /the rubric flags?\b/i,                     label: 'operational: rubric mention' },
  { re: /\bre-?run\b.*\.mjs|node scripts\/|rubric-check|regen-pack-content/i, label: 'operational: leaked CLI command' },
];

// Artifacts that Mitchell actually reads/pastes. (interview-prep-full etc. are
// intentionally reference docs and excluded.)
const PACK_ARTIFACTS = ['form-fields.md', 'cover-letter.md', 'one-pager.md', 'impact-doc.md'];

// --- Grounding invariants (added 2026-06-04) --------------------------------
// External apply materials must: (c) carry no Google-internal "L8" level jargon
// in a non-Google pack (it is meaningless + weaker externally — lead with rank
// names instead), (b) leak no fabricated/forbidden metric, (d) carry no
// unresolved FABRICATION-FLAG comment, and (a) have a tailored-cv.pdf that
// resolves to a CV (not a cover letter, not dangling, not a wrong-artifact).
// Born from the 2026-06-04 "kill L8 at the source" + comms-pack scrub, where
// every tailored pack had inherited "1,000+ L8+ Senior Technical ICs" from
// cv.md and four cover-letters carried "high stylistic fidelity / substantial
// drafting-latency reduction" soft-fabrications with no corpus receipt.
const GROUNDING_ARTIFACTS = [
  'cv-tailored.md', 'tailored-cv.md', 'cover-letter.md', 'impact-doc.md',
  'references.md', 'referrals.md', 'one-pager.md', 'form-fields.md',
  'interview-prep-full.md', 'interview-prep-teaser.md',
  'linkedin/hiring-manager.md', 'linkedin/recruiter.md',
];
// Single source of truth: lib/grounding-guard.mjs (2026-06-11). The generation
// tollbooth in scripts/build-apply-packs.mjs and this invariant must agree on
// what "retired metric" means, or fresh builds pass a gate the census fails.
const FORBIDDEN_METRIC = RETIRED_METRIC_PATTERNS;
// Canary: a lib edit that weakens coverage fails HERE, not silently downstream.
for (const probe of RETIRED_METRIC_PROBES) {
  if (!FORBIDDEN_METRIC.some(p => p.re.test(probe))) {
    console.error(`✗ FAIL — lib/grounding-guard.mjs no longer covers retired-metric probe: "${probe}"`);
    process.exit(1);
  }
}
const FABRICATION_FLAG_RE = /<!--\s*FABRICATION FLAG/i;

// (b)/(c)/(d) — scan one user-facing content file.
function scanGrounding(abs, rel, isGooglePack) {
  let txt;
  try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
  filesScanned++;
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!isGooglePack && /L8/.test(ln))
      violations.push({ file: rel, line: i + 1, label: 'L8-jargon (non-Google pack)', snippet: ln.trim().slice(0, 90) });
    for (const { re, label } of FORBIDDEN_METRIC)
      if (re.test(ln)) { violations.push({ file: rel, line: i + 1, label, snippet: ln.trim().slice(0, 90) }); break; }
    if (FABRICATION_FLAG_RE.test(ln))
      violations.push({ file: rel, line: i + 1, label: 'unresolved: FABRICATION-FLAG comment', snippet: ln.trim().slice(0, 90) });
  }
}

// (a) — tailored-cv.pdf must exist (not dangling) and resolve to a CV, not a cover letter.
function checkTailoredCvLink(packDir, slug) {
  const link = path.join(packDir, 'tailored-cv.pdf');
  let lst; try { lst = fs.lstatSync(link); } catch { return; } // no link present → nothing to assert
  const rel = `apply-pack/${slug}/tailored-cv.pdf`;
  if (!fs.existsSync(link)) { // lstat ok but stat fails → dangling symlink
    const tgt = lst.isSymbolicLink() ? (() => { try { return fs.readlinkSync(link); } catch { return '(unreadable)'; } })() : '(broken)';
    violations.push({ file: rel, line: 0, label: 'symlink: DANGLING (target missing)', snippet: String(tgt).slice(0, 90) });
    return;
  }
  if (!lst.isSymbolicLink()) {
    // Typst-render path (additive CV wiring, 2026-06-03+): tailored-cv.pdf is a
    // REGULAR file rendered from tailored-cv.md, so its basename legitimately
    // doesn't match /^cv-/ — asserting the symlink naming convention here was a
    // false positive (fixed 2026-06-11). For a regular file the meaningful
    // invariant is "it is actually a PDF": check the %PDF- magic bytes.
    let head = '';
    try {
      const fd = fs.openSync(link, 'r');
      const buf = Buffer.alloc(5);
      fs.readSync(fd, buf, 0, 5, 0);
      fs.closeSync(fd);
      head = buf.toString('latin1');
    } catch { /* unreadable → flagged below */ }
    if (head !== '%PDF-')
      violations.push({ file: rel, line: 0, label: 'regular file: not a valid PDF (Typst render expected)', snippet: `magic="${head}"` });
    return;
  }
  const base = path.basename(fs.readlinkSync(link)).toLowerCase();
  if (/cover-?letter/.test(base) || !/^cv-|cv-mitchell/.test(base))
    violations.push({ file: rel, line: 0, label: 'symlink: resolves to non-CV (cover-letter or wrong artifact)', snippet: base.slice(0, 90) });
}

function listApplyNowSlugs() {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/apply-now-queue.json'), 'utf8'));
    const dirs = fs.readdirSync(path.join(ROOT, 'apply-pack'));
    const slugs = new Set();
    for (const r of (q.ranked || [])) {
      const pre = String(r.num) + '-', prePad = String(r.num).padStart(3, '0') + '-';
      const hit = dirs.find(d => d.startsWith(pre) || d.startsWith(prePad));
      if (hit) slugs.add(hit);
    }
    return slugs;
  } catch { return null; }
}

const applyNowOnly = process.env.APPLY_PACK_INVARIANT_APPLY_NOW_ONLY === '1';
const applyNowSlugs = applyNowOnly ? listApplyNowSlugs() : null;

// Grounding invariants (L8 / forbidden-metric / fabrication-flag / tailored-cv
// symlink) ship OPT-IN (default off). The pre-2026-06-04 apply-pack tree still
// carries inherited "1,000+ L8+" + forbidden-metric debt across ~339 artifacts
// (every pack tailored off the old cv.md). Flip on via APPLY_PACK_GROUNDING_INVARIANT=1
// AFTER a tree-wide scrub, so test-all then gates on it without failing on legacy
// debt. Born 2026-06-04 (kill-L8-at-the-source + comms-pack hardening).
const groundingOn = process.env.APPLY_PACK_GROUNDING_INVARIANT === '1';

// ── Em-dash invariant (opt-in, added 2026-06-12) ─────────────────────────────
// Em dashes (U+2014) read as an AI tell and are banned in Mitchell's
// submitted/spoken materials, including rendered PDFs
// (feedback_no_em_dashes_in_materials, 2026-06-11). En dashes (U+2013, date
// ranges like "June 2024 – present") are standard typography and are ALLOWED.
// Same staged-rollout pattern as APPLY_PACK_GROUNDING_INVARIANT: flip on via
// APPLY_PACK_EMDASH_INVARIANT=1 after the 2026-06-12 tree sweep
// (scripts/scrub-em-dashes.mjs) drove the census to 0.
// Exemptions: immutable record packs (049-perplexity-*, 2723-anthropic-* —
// submitted history, never edited), /google/i packs (restored-from-backup
// precedent, 2026-06-11), and dot-dirs (.archive, .sweep-backups-*).
const emdashOn = process.env.APPLY_PACK_EMDASH_INVARIANT === '1';
const EMDASH_ARTIFACTS = [...GROUNDING_ARTIFACTS, 'linkedin/peer-referral.md'];
const EMDASH_EXEMPT_PACK_RE = /^049-perplexity|^2723-anthropic|google/i;
// The cross-fork-leak frontmatter marker is a structural internal annotation
// (never pasted/submitted) whose canonical spelling contains an em dash —
// exempt the exact token, flag any OTHER em dash on the same line.
const PERSONAL_MARKER = '[PERSONAL — DO NOT PUBLISH]';

function scanEmDashes(abs, rel) {
  let txt;
  try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].split(PERSONAL_MARKER).join('').includes('—'))
      violations.push({ file: rel, line: i + 1, label: 'em-dash (banned in materials — comma/colon/period/parens instead)', snippet: lines[i].trim().slice(0, 90) });
  }
}

const violations = [];
let filesScanned = 0;

function scanFile(abs, rel) {
  let txt;
  try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
  filesScanned++;
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { re, label } of BANNED) {
      if (re.test(lines[i])) {
        violations.push({ file: rel, line: i + 1, label, snippet: lines[i].trim().slice(0, 90) });
        break; // one violation per line is enough to flag it
      }
    }
  }
}

// 1. apply-pack artifacts
const packBase = path.join(ROOT, 'apply-pack');
let packDirs = [];
try { packDirs = fs.readdirSync(packBase).filter(d => { try { return fs.statSync(path.join(packBase, d)).isDirectory(); } catch { return false; } }); } catch {}
for (const d of packDirs) {
  if (applyNowSlugs && !applyNowSlugs.has(d)) continue;
  for (const a of PACK_ARTIFACTS) scanFile(path.join(packBase, d, a), `apply-pack/${d}/${a}`);
  // grounding (L8 / forbidden-metric / fabrication-flag) + symlink integrity invariants — opt-in
  if (groundingOn) {
    const isGoogle = /google/i.test(d);
    for (const a of GROUNDING_ARTIFACTS) scanGrounding(path.join(packBase, d, a), `apply-pack/${d}/${a}`, isGoogle);
    checkTailoredCvLink(path.join(packBase, d), d);
  }
  // em-dash invariant — opt-in, record/google/dot-dir packs exempt
  if (emdashOn && !d.startsWith('.') && !EMDASH_EXEMPT_PACK_RE.test(d)) {
    for (const a of EMDASH_ARTIFACTS) scanEmDashes(path.join(packBase, d, a), `apply-pack/${d}/${a}`);
  }
}

console.log(`apply-pack-no-scaffold-invariant: scanned ${filesScanned} artifact(s)${applyNowOnly ? ' (apply-now scope)' : ''}${groundingOn ? ' +grounding(L8/forbidden/symlink)' : ''}${emdashOn ? ' +emdash' : ''}`);

if (violations.length === 0) {
  console.log('✓ PASS — zero scaffold/placeholder/instruction/operational content in user-facing apply-pack artifacts.');
  process.exit(0);
}

// Group by file for a readable gap list.
const byFile = new Map();
for (const v of violations) { if (!byFile.has(v.file)) byFile.set(v.file, []); byFile.get(v.file).push(v); }
console.error(`\n✗ FAIL — ${violations.length} banned-content line(s) across ${byFile.size} artifact(s):\n`);
let shown = 0;
for (const [file, vs] of byFile) {
  console.error(`  ${file}  (${vs.length})`);
  for (const v of vs.slice(0, 3)) console.error(`     :${v.line} ${v.label} — "${v.snippet}"`);
  if (++shown >= 40) { console.error(`  … and ${byFile.size - shown} more file(s)`); break; }
}
console.error('\nThese are worksheets/instructions, not finished answers. Fix: regenerate via the LLM-backed');
console.error('generator (finished, grounded, fabrication-free) — see feedback_apply_pack_finished_not_worksheet.');
process.exit(1);
