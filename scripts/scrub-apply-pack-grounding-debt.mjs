#!/usr/bin/env node
/**
 * scrub-apply-pack-grounding-debt.mjs — tree-wide deterministic sweep of the
 * legacy apply-pack grounding debt (2026-06-11, task_72ce7b66).
 *
 * The pre-2026-06-04 apply-pack tree inherited retired metrics + Google-internal
 * "L8" level jargon from the old cv.md, plus unresolved FABRICATION-FLAGS
 * comment blocks and "Kill List" branding. The grounding invariant
 * (APPLY_PACK_GROUNDING_INVARIANT=1 tests/apply-pack-no-scaffold-invariant.test.mjs)
 * counts every offender; this sweep drives that census to zero so the invariant
 * can gate permanently in test-all.mjs.
 *
 * What it does, per pack dir under apply-pack/:
 *   1. Strips <!-- FABRICATION FLAGS … --> comment blocks (the flagged content
 *      itself is fixed by step 2, so the flags would be stale).
 *   2. Pipes every content .md (top level + linkedin/) and content .json twin
 *      through scripts/scrub-fabrications.mjs — the single source of rewrite
 *      rules (recalibrated 2026-06-11 to the post-HARDENED-CV-SPEC canon).
 *   3. Reports survivors (novel shapes the rules cannot safely rewrite) for
 *      hand-fixing — it never silently mangles.
 *
 * Exclusions (never touched):
 *   - record packs: 049-perplexity-* (submitted), 2723-anthropic-* (rejected
 *     record) — immutable application history
 *   - .archive/ + dot-dirs
 *   - *ai-detection* sidecars (QA telemetry quotes flagged phrases by design)
 *
 * Usage:
 *   node scripts/scrub-apply-pack-grounding-debt.mjs            # dry-run census
 *   node scripts/scrub-apply-pack-grounding-debt.mjs --apply    # rewrite in place
 *
 * Everything under apply-pack/ is gitignored personal data — this script edits
 * artifacts on disk and never touches git. Backups: scrub-fabrications.mjs
 * backs up every file it changes to data/scrub-backups-* (gitignored); the
 * flag-strip pass backs up to apply-pack/.sweep-backups-<date>/ (gitignored
 * via apply-pack/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const PACK_BASE = join(ROOT, 'apply-pack');
const SCRUBBER = join(ROOT, 'scripts', 'scrub-fabrications.mjs');
const BACKUP = join(PACK_BASE, '.sweep-backups-2026-06-11');
const FLAG_BLOCK_RE = /\n?<!--\s*FABRICATION FLAGS[\s\S]*?-->/gi;

const EXCLUDE_DIR = (d) =>
  d.startsWith('.') ||
  d.startsWith('049-perplexity') ||
  d.startsWith('2723-anthropic') ||
  // Google-target packs mirror the invariant test's /google/i exemption — for an
  // internal Google application, "L8+" is the CORRECT audience language and the
  // generic L8-strip rules mangle it (verified 2026-06-11 on
  // google-internal-comms-genai-chief-ai-architect; restored from backup).
  /google/i.test(d);

const EXCLUDE_FILE = (f) => f.includes('ai-detection');

if (!existsSync(PACK_BASE)) {
  console.error('no apply-pack/ tree on this machine — nothing to sweep');
  process.exit(0);
}

const mdFiles = [];
const jsonFiles = [];
for (const d of readdirSync(PACK_BASE)) {
  if (EXCLUDE_DIR(d)) continue;
  const dir = join(PACK_BASE, d);
  let st; try { st = statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (EXCLUDE_FILE(f)) continue;
    if (f.endsWith('.md')) mdFiles.push(join(dir, f));
    else if (f.endsWith('.json')) jsonFiles.push(join(dir, f));
  }
  const li = join(dir, 'linkedin');
  if (existsSync(li)) {
    for (const f of readdirSync(li)) {
      if (!EXCLUDE_FILE(f) && f.endsWith('.md')) mdFiles.push(join(li, f));
    }
  }
}

console.log(`sweep scope: ${mdFiles.length} md + ${jsonFiles.length} json (record packs + ai-detection sidecars excluded)${APPLY ? '' : '  [DRY-RUN]'}`);

// ── 1. FABRICATION-FLAGS comment-block strip ─────────────────────────────────
let flagFiles = 0;
for (const p of mdFiles) {
  let body; try { body = readFileSync(p, 'utf8'); } catch { continue; }
  if (!FLAG_BLOCK_RE.test(body)) { FLAG_BLOCK_RE.lastIndex = 0; continue; }
  FLAG_BLOCK_RE.lastIndex = 0;
  flagFiles++;
  if (APPLY) {
    if (!existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });
    copyFileSync(p, join(BACKUP, p.replace(ROOT + '/', '').replace(/[\/ ]/g, '__') + '.bak'));
    writeFileSync(p, body.replace(FLAG_BLOCK_RE, '').replace(/\n{3,}$/, '\n'));
  }
}
console.log(`${APPLY ? 'stripped' : 'would strip'} FABRICATION-FLAGS blocks in ${flagFiles} file(s)`);

// ── 2. Retired-metric / L8 / branding rewrite via the canonical scrubber ─────
const all = [...mdFiles, ...jsonFiles];
const CHUNK = 150;
let survivors = [];
let scrubbedTotal = 0;
for (let i = 0; i < all.length; i += CHUNK) {
  const chunk = all.slice(i, i + CHUNK);
  const args = APPLY ? [SCRUBBER, ...chunk] : [SCRUBBER, '--dry-run', ...chunk];
  let out = '';
  try {
    out = execFileSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // exit 1 = survivors reported on stdout (expected for novel shapes); rethrow real spawn faults
    if (typeof err.status !== 'number') throw err;
    out = String(err.stdout || '') + String(err.stderr || '');
  }
  for (const line of out.split('\n')) {
    const m = line.match(/(?:scrubbed|would scrub) (\d+)×/);
    if (m) scrubbedTotal += parseInt(m[1], 10);
    if (line.includes('SURVIVING LEAK in ')) survivors.push(line.replace(/.*SURVIVING LEAK in /, '').replace(/:$/, ''));
  }
}
console.log(`${APPLY ? 'applied' : 'would apply'} ${scrubbedTotal} rewrite(s) across the tree`);

// In dry-run the verifier greps the UNMODIFIED disk, so "survivors" there are
// just the pre-fix state — only meaningful after --apply.
if (APPLY) {
  if (survivors.length) {
    console.log(`\n🔴 ${survivors.length} file(s) carry novel shapes the rules cannot safely rewrite — HAND-FIX:`);
    for (const s of [...new Set(survivors)]) console.log(`   ${s}`);
    process.exit(1);
  }
  console.log('✅ verifier-clean across the swept tree');
}
process.exit(0);
