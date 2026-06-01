#!/usr/bin/env node
/**
 * scrub-target-rows-2026-05-31.mjs — deterministic retired-metric scrub for the
 * three hand-finished apply-now rows (#48/#1/#49). Per memory
 * feedback_polish_does_not_strip_fabrications: removing a retired metric is a
 * deterministic find-replace job, NOT an LLM polish pass.
 *
 * Every replacement maps a metric the HARDENED-CV-SPEC-2026-05-30 retired (no
 * measurement receipt / wrong attribution) to its approved, defensible form.
 * Backs up each touched file to data/scrub-backups-2026-05-31/ first.
 *
 * Usage: node scripts/scrub-target-rows-2026-05-31.mjs            (apply)
 *        node scripts/scrub-target-rows-2026-05-31.mjs --dry-run  (report only)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const BACKUP = join(ROOT, 'data', 'scrub-backups-2026-05-31');

// [file, [ [literalFrom, to], ... ]]  — literal (not regex) replacements, replace-all.
const JOBS = [
  ['data/interview-likelihood/048-anthropic-engineering-editorial-lead.json', [
    ['90% drafting-latency reduction', 'substantial drafting-latency reduction'],
  ]],
  ['data/hm-chance/048-anthropic-engineering-editorial-lead.json', [
    ['90% drafting latency reduction', 'substantial drafting-latency reduction'],
    ['90% drafting-latency reduction', 'substantial drafting-latency reduction'],
  ]],
  ['data/interview-likelihood/049-perplexity-executive-communications-manager-sr-manager-exec-comms.json', [
    ['90% drafting-latency reduction', 'substantial drafting-latency reduction'],
  ]],
  ['data/hm-chance/049-perplexity-executive-communications-manager-sr-manager-exec-comms.json', [
    ['90% drafting latency reduction', 'substantial drafting-latency reduction'],
    ['90% drafting-latency reduction', 'substantial drafting-latency reduction'],
  ]],
  ['apply-pack/048-anthropic-engineering-editorial-lead/referrals.md', [
    ['1,000-person senior IC population', '600+ L8+ senior IC population'],
  ]],
  ['apply-pack/048-anthropic-engineering-editorial-lead/references.md', [
    ['9,000-machine COVID remote-work mobilization', 'company-wide COVID remote-work mobilization'],
  ]],
  ['apply-pack/048-anthropic-engineering-editorial-lead/impact-doc.md', [
    ['cut low-value executive requests by 50%', 'materially cut low-value executive requests'],
  ]],
  ['apply-pack/001-anthropic-communications-manager-research/cv-tailored.md', [
    ['9,000 machine and 9,500 hotspot provisions in one week', 'company-wide device and hotspot provisioning in one week'],
  ]],
  ['apply-pack/001-anthropic-communications-manager-research/form-fields.md', [
    ['1,000+ Principal/Distinguished/Fellow engineers', '600+ Principal/Distinguished/Fellow (L8+) engineers'],
  ]],
];

if (!DRY && !existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });
let totalReplacements = 0, filesChanged = 0;
for (const [rel, pairs] of JOBS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`SKIP (absent): ${rel}`); continue; }
  let body = readFileSync(p, 'utf8');
  let fileHits = 0;
  for (const [from, to] of pairs) {
    const before = body;
    body = body.split(from).join(to);
    const n = (before.length - body.length) === 0 && before !== body ? 1 : before.split(from).length - 1;
    if (n > 0) { fileHits += n; console.log(`  ${DRY ? 'would replace' : 'replaced'} ${n}× in ${rel}: "${from.slice(0, 50)}…" → "${to.slice(0, 50)}…"`); }
  }
  if (fileHits > 0) {
    if (!DRY) {
      copyFileSync(p, join(BACKUP, basename(rel) + '.bak'));
      writeFileSync(p, body);
    }
    totalReplacements += fileHits; filesChanged++;
  } else {
    console.log(`  (no target strings found in ${rel} — already clean or string drifted)`);
  }
}
console.log(`\n${DRY ? 'DRY-RUN' : 'APPLIED'}: ${totalReplacements} replacement(s) across ${filesChanged} file(s).${DRY ? '' : ' Backups in data/scrub-backups-2026-05-31/.'}`);
