#!/usr/bin/env node
/**
 * scripts/agents/corpus-drive-link-inject.mjs — resolve FILE-LEVEL Google Drive
 * links into the corpus sidecars' `drive_link:` frontmatter.
 *
 * Companion to corpus-sidecar-gen.mjs. That generator SKIPS existing sidecars, so
 * re-running it never updates drive_link. This script does an in-place injection
 * pass over the already-generated sidecars.
 *
 * ── Why a deterministic script (not the MCP agent) ─────────────────────────────
 * The Google Drive MCP connector (search_files / get_file_metadata) is callable
 * only from the main Claude agent, not from a node process. So the workflow is:
 *   1. The agent walks Drive and writes a {title,id,viewUrl,mimeType} map
 *      (default /tmp/corpus-drive-file-map.json).
 *   2. THIS script consumes that map + the rename ledger + the sidecars, matches
 *      each sidecar's ORIGINAL Drive filename, and rewrites `drive_link: TBD`.
 *
 * ── Match chain ────────────────────────────────────────────────────────────────
 *   sidecar `artifact:` (renamed local path)
 *     └─ rename ledger `to` → `from`  (recovers the ORIGINAL local path)
 *          └─ basename = the ORIGINAL filename = the Drive file `title` (verbatim)
 *               └─ Drive map: exact-title match → viewUrl   (normalized fallback)
 *
 * The cleanup renamed files (e.g. "Google.com Mail - Playbook for Flyway….pdf"
 * → "xge_0000_google-com-mail-playbook-for-flyway_playbook.pdf"); the Drive
 * originals keep the ORIGINAL names, so the ledger is required to recover them.
 *
 * Conservative by design: only EXACT (then tight-normalized) single matches inject
 * a link. Ambiguous (multiple Drive files share the name) and no-match sidecars
 * are LEFT as `drive_link: TBD` and listed in the report for Mitchell to spot-check.
 * Many originals exist on Drive only inside .zip bundles (no per-file viewUrl) —
 * those correctly stay TBD.
 *
 * Confidentiality: reads only LOCAL gitignored personal data + a local Drive map.
 * Sends nothing to any external API. Never commits the sidecars/map/ledgers.
 *
 * Idempotent: only rewrites lines that currently read exactly `drive_link: TBD`.
 *
 * Usage:
 *   node scripts/agents/corpus-drive-link-inject.mjs                 # DRY-RUN (default)
 *   node scripts/agents/corpus-drive-link-inject.mjs --apply         # write links
 *   node scripts/agents/corpus-drive-link-inject.mjs --org xge --apply
 *   node scripts/agents/corpus-drive-link-inject.mjs --map /tmp/corpus-drive-file-map.json
 *   node scripts/agents/corpus-drive-link-inject.mjs --no-links-backfill
 */

import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NO_BACKFILL = args.includes('--no-links-backfill');
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const arg = (flag, def) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : def);

const MAP_PATH = arg('--map', '/tmp/corpus-drive-file-map.json');
const LEDGER_PATH = arg('--ledger', join(ROOT, 'data/corpus-rename-ledger-2026-05-30.jsonl'));
const LINKS_JSON = arg('--links-json', join(ROOT, 'data/corpus-drive-links.json'));
const TODAY = arg('--date', '2026-05-30'); // explicit; Date.* avoided for determinism
const REPORT_PATH = join(ROOT, `data/corpus-drive-link-inject-report-${TODAY}.md`);

const DUMPS = [
  { org: 'xge', root: join(ROOT, 'data/xge-comms-artifacts/_canonical') },
  { org: 'corp-eng', root: join(ROOT, 'data/corp-eng-artifacts/_canonical') },
].filter(d => !ORG || d.org === ORG);

function log(s) { process.stderr.write(s + '\n'); }

// ── tight normalization (em-dash vs hyphen, smart quotes, double-space, case) ──
function norm(s) {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'") // smart quotes → '
    .replace(/[^a-z0-9]+/g, ' ')                 // any non-alphanumeric run → single space
    .trim();
}

function walk(dir, acc = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && e.name.endsWith('.sidecar.md')) acc.push(full);
  }
  return acc;
}

// ── load Drive map ─────────────────────────────────────────────────────────────
function loadDriveMap(path) {
  if (!existsSync(path)) {
    log(`FATAL: Drive map not found at ${path}`);
    log(`  The map is produced by the main Claude agent walking Drive via the MCP`);
    log(`  connector (search_files). Generate it first, then re-run this script.`);
    process.exit(2);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { log(`FATAL: Drive map is not valid JSON (${e.message})`); process.exit(2); }
  const files = Array.isArray(raw) ? raw : (raw.files || raw.entries || []);
  const FOLDER = 'application/vnd.google-apps.folder';
  const exact = new Map();   // basename (verbatim) → [{viewUrl, ext, title, id}]
  const normd = new Map();   // norm(basename) → [{viewUrl, ext, title, id}]
  let usable = 0;
  for (const f of files) {
    const title = f.title || f.name;
    const viewUrl = f.viewUrl || f.webViewLink || f.url;
    if (!title || !viewUrl) continue;
    if (f.mimeType === FOLDER) continue;
    usable++;
    const ext = extname(title).slice(1).toLowerCase();
    const rec = { viewUrl, ext, title, id: f.id || null };
    (exact.get(title) || exact.set(title, []).get(title)).push(rec);
    const nk = norm(title);
    (normd.get(nk) || normd.set(nk, []).get(nk)).push(rec);
  }
  return { exact, normd, usable, total: files.length };
}

// ── load rename ledger (renamed `to` → original `from`) ─────────────────────────
function loadLedger(path) {
  const map = new Map();
  if (!existsSync(path)) { log(`WARN: rename ledger not found at ${path} — falling back to renamed basenames (low match rate expected)`); return map; }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try { const { from, to } = JSON.parse(line); if (from && to) map.set(to, from); } catch { /* skip malformed */ }
  }
  return map;
}

// ── disambiguate multiple Drive candidates by extension ─────────────────────────
function pick(candidates, wantExt) {
  if (candidates.length === 1) return { rec: candidates[0], ambiguous: false };
  const byExt = candidates.filter(c => c.ext === wantExt);
  if (byExt.length === 1) return { rec: byExt[0], ambiguous: false };
  // all candidates share one identical viewUrl? then it's not really ambiguous
  const urls = new Set(candidates.map(c => c.viewUrl));
  if (urls.size === 1) return { rec: candidates[0], ambiguous: false };
  return { rec: null, ambiguous: true };
}

function parseFrontmatter(content) {
  // frontmatter = between first '---' and next '---'
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : '';
  const field = (name) => {
    const r = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim() : null;
  };
  let artifact = field('artifact');
  if (artifact && artifact.startsWith('"')) { try { artifact = JSON.parse(artifact); } catch { /* leave raw */ } }
  return {
    artifact,
    citation_slug: field('citation_slug'),
    drive_link: field('drive_link'),
  };
}

function main() {
  const { exact, normd, usable, total } = loadDriveMap(MAP_PATH);
  const ledger = loadLedger(LEDGER_PATH);
  log(`Drive map: ${total} entries (${usable} usable files w/ viewUrl) · ledger: ${ledger.size} renames\n`);

  const buckets = { 'matched-exact': [], 'matched-norm': [], 'ambiguous': [], 'no-match': [], 'already-linked': [], 'no-ledger': [] };
  const backfill = {}; // citation_slug → viewUrl

  let sidecarTotal = 0;
  for (const { org, root } of DUMPS) {
    if (!existsSync(root)) { log(`(skip ${org}: ${root} absent)`); continue; }
    for (const sc of walk(root)) {
      sidecarTotal++;
      const content = readFileSync(sc, 'utf8');
      const { artifact, citation_slug, drive_link } = parseFrontmatter(content);
      const rel = sc.replace(ROOT + '/', '');

      if (drive_link && /^https?:\/\//.test(drive_link)) { buckets['already-linked'].push({ rel }); continue; }
      if (!artifact) { buckets['no-match'].push({ rel, why: 'no artifact field' }); continue; }

      // recover original Drive filename via ledger
      const original = ledger.get(artifact);
      const origBase = original ? basename(original) : basename(artifact);
      if (!original) buckets['no-ledger'].push({ rel, origBase });
      const wantExt = extname(origBase).slice(1).toLowerCase();

      // exact, then normalized
      let result = null, how = null;
      if (exact.has(origBase)) { result = pick(exact.get(origBase), wantExt); how = 'matched-exact'; }
      else if (normd.has(norm(origBase))) { result = pick(normd.get(norm(origBase)), wantExt); how = 'matched-norm'; }

      if (!result) { buckets['no-match'].push({ rel, origBase }); continue; }
      if (result.ambiguous) { buckets['ambiguous'].push({ rel, origBase, n: (exact.get(origBase) || normd.get(norm(origBase))).length }); continue; }

      const url = result.rec.viewUrl;
      buckets[how].push({ rel, origBase, title: result.rec.title, url });
      if (citation_slug) backfill[citation_slug] = url;

      if (APPLY) {
        // idempotent: only the literal `drive_link: TBD` line is rewritten
        const next = content.replace(/^drive_link: TBD$/m, `drive_link: ${url}`);
        if (next !== content) writeFileSync(sc, next);
      }
    }
  }

  // ── backfill corpus-drive-links.json (citation_slug → viewUrl) for future sidecar-gen seeds ──
  let backfilled = 0;
  if (!NO_BACKFILL && APPLY && Object.keys(backfill).length) {
    let doc = { _owner: 'scripts/agents/corpus-librarian.mjs', _note: 'file-level Drive viewUrls resolved via MCP connector + corpus-drive-link-inject.mjs', links: {} };
    try { doc = JSON.parse(readFileSync(LINKS_JSON, 'utf8')); doc.links = doc.links || {}; } catch { /* fresh */ }
    for (const [slug, url] of Object.entries(backfill)) { if (doc.links[slug] !== url) { doc.links[slug] = url; backfilled++; } }
    writeFileSync(LINKS_JSON, JSON.stringify(doc, null, 2) + '\n');
  }

  // ── report ──
  const matched = buckets['matched-exact'].length + buckets['matched-norm'].length;
  const pct = sidecarTotal ? ((matched / sidecarTotal) * 100).toFixed(1) : '0.0';
  const lines = [];
  lines.push(`# Corpus Drive-link injection report — ${TODAY}`, '');
  lines.push(`Mode: ${APPLY ? 'APPLY (links written)' : 'DRY-RUN (no files modified)'}`, '');
  lines.push(`- sidecars scanned: **${sidecarTotal}**`);
  lines.push(`- matched (exact): **${buckets['matched-exact'].length}**`);
  lines.push(`- matched (normalized): **${buckets['matched-norm'].length}**`);
  lines.push(`- **total matched: ${matched} (${pct}%)**`);
  lines.push(`- already linked (skipped): ${buckets['already-linked'].length}`);
  lines.push(`- ambiguous (multiple Drive files, left TBD): ${buckets['ambiguous'].length}`);
  lines.push(`- no Drive match (likely zip-only or locally-generated, left TBD): ${buckets['no-match'].length}`);
  lines.push(`- no ledger entry (used renamed basename): ${buckets['no-ledger'].length}`);
  if (APPLY) lines.push(`- corpus-drive-links.json slugs backfilled: ${backfilled}`);
  lines.push('');
  const section = (title, arr, fmt) => { lines.push(`## ${title} (${arr.length})`, ''); for (const x of arr) lines.push(fmt(x)); lines.push(''); };
  section('Ambiguous — needs human pick', buckets['ambiguous'], x => `- \`${x.rel}\` ← ${x.origBase} (${x.n} Drive matches)`);
  section('No Drive match — spot-check', buckets['no-match'], x => `- \`${x.rel}\`${x.origBase ? ' ← ' + x.origBase : ''}${x.why ? ' (' + x.why + ')' : ''}`);
  section('Matched (normalized, lower confidence — verify)', buckets['matched-norm'], x => `- \`${x.rel}\` ← ${x.origBase} → ${x.title}`);
  writeFileSync(REPORT_PATH, lines.join('\n'));

  // ── console summary ──
  log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} · sidecars=${sidecarTotal}`);
  log(`  matched-exact=${buckets['matched-exact'].length} matched-norm=${buckets['matched-norm'].length} → ${matched} (${pct}%)`);
  log(`  already-linked=${buckets['already-linked'].length} ambiguous=${buckets['ambiguous'].length} no-match=${buckets['no-match'].length} no-ledger=${buckets['no-ledger'].length}`);
  if (APPLY) log(`  corpus-drive-links.json backfilled: ${backfilled} slugs`);
  log(`  report: ${REPORT_PATH.replace(ROOT + '/', '')}`);
  if (!APPLY) log(`\n  (dry-run — re-run with --apply to write links)`);
}

main();
