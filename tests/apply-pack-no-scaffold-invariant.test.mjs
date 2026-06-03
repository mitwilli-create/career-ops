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
}

console.log(`apply-pack-no-scaffold-invariant: scanned ${filesScanned} artifact(s)${applyNowOnly ? ' (apply-now scope)' : ''}`);

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
