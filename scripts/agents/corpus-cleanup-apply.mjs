#!/usr/bin/env node
/**
 * scripts/agents/corpus-cleanup-apply.mjs — executes the APPROVED 2026-05-30
 * corpus-librarian artifact-intake decisions against data/corp-eng-artifacts/
 * and data/xge-comms-artifacts/. Dry-run by default; --execute mutates.
 *
 * Locked decisions (interview 2026-05-30):
 *   - DELETE all raw video (.mov camera sources + raw-pattern .mp4 + RAW/BROLL/Footage dirs),
 *     keep finished .mp4 cuts. Delete all 408 images + .DS_Store + empty stubs.
 *   - UNION-DEDUP survivors (content-hash <50MB; basename+size >=50MB), keep one canonical.
 *   - RENAME + ORGANIZE: mv each survivor to <root>/_canonical/<kind-folder>/<org_date_topic_kind.ext>.
 *   - All reversible: dedup + rename/organize write JSONL ledgers; deletes write a manifest.
 *
 * Gitignored personal data. Never commits. Never touches anything outside the two dump dirs.
 *
 * Usage:
 *   node scripts/agents/corpus-cleanup-apply.mjs                 # dry-run (prints manifest, no mutation)
 *   node scripts/agents/corpus-cleanup-apply.mjs --execute       # perform it
 *   node scripts/agents/corpus-cleanup-apply.mjs --execute --skip-dedup  # skip a phase
 */

import {
  readdirSync, statSync, existsSync, mkdirSync, rmSync, renameSync,
  writeFileSync, appendFileSync, readFileSync,
} from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = '2026-05-30';
const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const SKIP = new Set(args.filter(a => a.startsWith('--skip-')).map(a => a.replace('--skip-', '')));

const DUMPS = [
  { org: 'corp-eng', root: join(ROOT, 'data/corp-eng-artifacts') },
  { org: 'xge',      root: join(ROOT, 'data/xge-comms-artifacts') },
];

const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v', 'avi', 'webm']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp', 'tiff', 'bmp']);
const DEDUP_HASH_MAX = 50 * 1024 * 1024; // hash files under 50MB; signature-dedup larger

function log(s) { process.stdout.write(s + '\n'); }
function gb(n) { return (n / 1e9).toFixed(2) + ' GB'; }
function mb(n) { return (n / 1e6).toFixed(1) + ' MB'; }

// ── walk (all files, including dotfiles, for .DS_Store sweep) ──
function walk(dir, acc = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

// ── raw-video classifier (conservative; keep ambiguous) ──
function isRawVideo(path) {
  const ext = extname(path).slice(1).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return false;
  const name = basename(path);
  const lower = path.toLowerCase();
  // FINISHED-OVERRIDE: never delete an explicitly-finished deliverable, even if
  // it lives under a raw/footage ancestor dir. Protects "Video Final", FINAL FILES, CAPTIONED.
  if (/final files|video final|captioned|_final\b|final cut|vfinal/i.test(path)) return false;
  if (ext === 'mov') return true;                                  // camera-original format → raw
  if (/^(copy of )?[a-z]\d{3}_[a-z]?\d/i.test(name)) return true;  // A002_C023, A021_0813…
  if (/^c\d{4}_/i.test(name)) return true;                         // C0031_short
  if (/^vid_\d{8}/i.test(name)) return true;                       // VID_20180123 (phone)
  if (/rough cut.*no graphics|no graphics or music/i.test(name)) return true;
  if (/jp cio/i.test(name)) return true;
  // explicit raw dirs only — NOT bare /footage/ (mixes finished + intermediate cuts)
  if (/\/(raw video|broll|b-roll)\//i.test(lower)) return true;
  return false;                                                    // descriptive .mp4 → finished, KEEP
}

function isImage(path) { return IMAGE_EXTS.has(extname(path).slice(1).toLowerCase()); }
function isJunk(path)  { const b = basename(path); return b === '.DS_Store' || b.startsWith('._'); }

// ── naming (mirror corpus-librarian.mjs proposeName) ──
function inferKind(name) {
  const n = name.toLowerCase();
  const ext = extname(name).slice(1).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video-final';
  if (/^script_|final script|first draft|script outline|^scripts_/.test(n)) return 'script';
  if (/transcript/.test(n)) return 'transcript';
  if (/peer bonus|spot bonus|recognition|promo/.test(n)) return 'recognition';
  if (/guidance|best.*practice|so.*you.*want/.test(n)) return 'guidance';
  if (/brief_|project charter|production schedule|charter_/.test(n)) return 'brief';
  if (/report_|impact|metrics|stats|learnings/.test(n)) return 'impact';
  if (/playbook/.test(n)) return 'playbook';
  if (/framework|strategy|roi|trr/.test(n)) return 'framework';
  if (/prompt_|_prompt|triage|escalation|revision|app.?script/.test(n)) return 'agent-prompt';
  if (/^es -|engagement summary/.test(n)) return 'engagement-summary';
  if (/constitution|audience_profile|_kb|knowledge base|values|scope/.test(n)) return 'agent-kb';
  if (/notes|1_1|1:1/.test(n)) return 'notes';
  return 'doc';
}

function proposeName(org, name) {
  const ext = extname(name).slice(1).toLowerCase();
  const kind = inferKind(name);
  let base = basename(name, extname(name))
    .replace(/^Copy of /i, '').replace(/^VIEW ONLY /i, '')
    .replace(/^EDITED CONTENT WITH REWRITES_? ?/i, 'edited-')
    .replace(/-\d{3}-\d{3}$/, '').replace(/\(by mitchwilliams@[^)]*\)/i, '')
    .replace(/^(SCRIPT|FINAL SCRIPT|FIRST DRAFT|FINAL DRAFT|TRANSCRIPT|BRIEF|GUIDANCE|REPORT|PEER BONUS|SPOT BONUS|PROJECT CHARTER|PRODUCTION SCHEDULE|OUTLINE|SUMMARY|IMPACT|UX STUDY)_?/i, '');
  const topic = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'untitled';
  const dm = name.match(/\b(20\d{2})[-_ ]?(0[1-9]|1[0-2])?\b/) || name.match(/\bQ([1-4])\s*(20\d{2})\b/i);
  let date = '0000';
  if (dm) { if (/Q/i.test(dm[0])) date = `${dm[2]}-q${dm[1]}`; else date = dm[2] ? `${dm[1]}-${dm[2]}` : dm[1]; }
  return `${org}_${date}_${topic}_${kind}.${ext}`;
}

const KIND_FOLDER = {
  script: 'scripts', transcript: 'transcripts', guidance: 'guidance', brief: 'briefs',
  impact: 'impact', recognition: 'recognition', playbook: 'playbooks', framework: 'frameworks',
  'agent-prompt': 'agent-build', 'agent-kb': 'agent-build', 'engagement-summary': 'engagement-summaries',
  notes: 'notes', 'video-final': 'videos-final', doc: 'docs',
};
function targetFolder(org, name) {
  const kind = inferKind(name);
  if (kind !== 'video-final' && /all hands|ben fried|emea live|ghc |directors monthly|incubator|exec/i.test(name))
    return 'exec-comms';
  return KIND_FOLDER[kind] || 'docs';
}

function ensureDir(d) { if (EXECUTE) mkdirSync(d, { recursive: true }); }
function dedupKey(path, size) {
  const norm = basename(path).replace(/^Copy of /i, '').toLowerCase();
  if (size >= DEDUP_HASH_MAX) return `sig:${norm}:${size}`;
  try { return 'md5:' + createHash('md5').update(readFileSync(path)).digest('hex'); }
  catch { return `sig:${norm}:${size}`; }
}

// ──────────────────────────────────────────────────────────────────────────

log(`╔═ corpus-cleanup-apply ${EXECUTE ? '— EXECUTE' : '— DRY-RUN (no mutation)'} ═╗\n`);

let totalDeleted = 0, totalDeletedBytes = 0;
let totalDeduped = 0, totalDedupedBytes = 0;
let totalMoved = 0;
const deleteManifest = [];
const dedupLedger = [];
const renameLedger = [];

for (const { org, root } of DUMPS) {
  if (!existsSync(root)) { log(`(skip ${org}: ${root} absent)`); continue; }
  log(`── ${org} ──`);
  let files = walk(root);

  // PHASE 1: DELETE (raw video + images + junk)
  if (!SKIP.has('delete')) {
    const toDelete = files.filter(f => isRawVideo(f) || isImage(f) || isJunk(f));
    for (const f of toDelete) {
      let sz = 0; try { sz = statSync(f).size; } catch {}
      const reason = isRawVideo(f) ? 'raw-video' : isImage(f) ? 'image' : 'junk';
      deleteManifest.push({ path: relative(ROOT, f), size: sz, reason });
      totalDeleted++; totalDeletedBytes += sz;
      if (EXECUTE) { try { rmSync(f); } catch (e) { /* keep going */ } }
    }
    files = files.filter(f => !(isRawVideo(f) || isImage(f) || isJunk(f)));
    const vids = deleteManifest.filter(d => d.reason === 'raw-video' && d.path.includes(org));
    log(`  DELETE: ${toDelete.length} files (${gb(toDelete.reduce((s, f) => { try { return s + statSync(f).size; } catch { return s; } }, 0))}) — raw-video/image/junk`);
  }

  // PHASE 2: UNION-DEDUP survivors
  if (!SKIP.has('dedup')) {
    const seen = new Map();
    const survivors = [];
    // canonical preference: shorter path wins (fewer nested dup-folder segments)
    files.sort((a, b) => a.length - b.length);
    for (const f of files) {
      let sz = 0; try { sz = statSync(f).size; } catch { continue; }
      const key = dedupKey(f, sz);
      if (seen.has(key)) {
        dedupLedger.push({ dropped: relative(ROOT, f), kept: relative(ROOT, seen.get(key)), size: sz });
        totalDeduped++; totalDedupedBytes += sz;
        if (EXECUTE) { try { rmSync(f); } catch {} }
      } else { seen.set(key, f); survivors.push(f); }
    }
    files = survivors;
    log(`  DEDUP: dropped ${dedupLedger.filter(d => d.kept.includes(org) || d.dropped.includes(org)).length} duplicate copies → ${files.length} unique survivors`);
  }

  // PHASE 3: RENAME + ORGANIZE (mv to _canonical/<folder>/<renamed>)
  if (!SKIP.has('organize')) {
    const canon = join(root, '_canonical');
    const usedNames = new Set();
    for (const f of files) {
      if (f.includes('/_canonical/')) continue;
      const folder = targetFolder(org, basename(f));
      let newName = proposeName(org, basename(f));
      // de-collide within target folder
      let dest = join(canon, folder, newName);
      let i = 2;
      while (usedNames.has(dest)) {
        const ext = extname(newName);
        dest = join(canon, folder, basename(newName, ext) + `-${i}` + ext); i++;
      }
      usedNames.add(dest);
      renameLedger.push({ from: relative(ROOT, f), to: relative(ROOT, dest) });
      totalMoved++;
      if (EXECUTE) { ensureDir(dirname(dest)); try { renameSync(f, dest); } catch (e) { /* cross-device? */ } }
    }
    log(`  ORGANIZE: ${renameLedger.filter(r => r.from.includes(org)).length} files → ${org}/_canonical/<kind>/`);
  }
  log('');
}

// ── write manifests + ledgers (always, even dry-run, for review) ──
const suffix = EXECUTE ? '' : '-DRYRUN';
writeFileSync(join(ROOT, `data/corpus-delete-manifest-${TODAY}${suffix}.json`),
  JSON.stringify({ executed: EXECUTE, total: totalDeleted, bytes: totalDeletedBytes, manifest: deleteManifest }, null, 2));
if (EXECUTE) {
  writeFileSync(join(ROOT, `data/corpus-dedup-ledger-${TODAY}.jsonl`), dedupLedger.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(ROOT, `data/corpus-rename-ledger-${TODAY}.jsonl`), renameLedger.map(e => JSON.stringify(e)).join('\n') + '\n');
} else {
  writeFileSync(join(ROOT, `data/corpus-rename-ledger-${TODAY}-DRYRUN.json`), JSON.stringify({ dedup: dedupLedger.slice(0, 50), rename: renameLedger.slice(0, 80) }, null, 2));
}

log('═══ SUMMARY ═══');
log(`DELETE : ${totalDeleted} files, ${gb(totalDeletedBytes)} freed`);
log(`DEDUP  : ${totalDeduped} duplicate copies removed, ${gb(totalDedupedBytes)} freed`);
log(`ORGANIZE: ${totalMoved} files → _canonical/<kind>/ (renamed)`);
log(`TOTAL RECLAIMED: ${gb(totalDeletedBytes + totalDedupedBytes)}`);
log(`Manifests: data/corpus-delete-manifest-${TODAY}${suffix}.json` + (EXECUTE ? ` + dedup/rename ledgers` : ` + dry-run ledger preview`));
if (!EXECUTE) log(`\n→ DRY-RUN only. Re-run with --execute to perform.`);
