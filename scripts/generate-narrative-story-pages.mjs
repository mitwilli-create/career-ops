#!/usr/bin/env node
/**
 * generate-narrative-story-pages.mjs — bridge (2026-05-31)
 *
 * WHY: the dashboard "Full story" drill-in resolves dashboard/stories/{slug}.html
 * and the canonical generator (generate-story-pages.mjs) sources per-requirement
 * stories from each report's Block F. Rows whose report lacks a Block F (e.g. row #1
 * Anthropic Communications Manager, Research) get story CHIPS but no pages → the popout
 * shows "Full story page not yet generated". Meanwhile the per-role full narratives the
 * story agent wrote live in interview-prep/stories/*.md and no render path reads them.
 *
 * This script bridges that gap DETERMINISTICALLY (no LLM, no fabrication): it renders each
 * interview-prep/stories/<num>-<slug>.md narrative into dashboard/stories/<num>-<slug>.html
 * and emits data/narrative-story-map.json ({ "<num>": "<slug>" }, both padded + unpadded
 * keys). build-dashboard bakes that map into _waveCB.narrativeStoryPages so the drill-in
 * 'story' handler can fall back to the row's full-role narrative page when a per-requirement
 * chip page is absent.
 *
 * Usage: node scripts/generate-narrative-story-pages.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { scrubArtifactsOrThrow } from './lib/scrub-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'interview-prep', 'stories');
const OUT = join(ROOT, 'dashboard', 'stories');
const MAP = join(ROOT, 'data', 'narrative-story-map.json');
const DRY = process.argv.includes('--dry-run');

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
if (!existsSync(SRC)) { console.error('no interview-prep/stories dir'); process.exit(2); }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SHELL = (title, body) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} — Mitchell Williams</title>
<style>
  :root { --bg:#0d0f17; --surface:#11131c; --border:#232737; --fg:#e6e9f0; --muted:#9aa3b2; --accent:#7aa2f7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 96px; }
  .kicker { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:8px; }
  h1 { font-size: 26px; line-height:1.25; margin: 0 0 24px; }
  h2 { font-size: 19px; margin: 32px 0 10px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  h3 { font-size: 16px; margin: 22px 0 8px; color: var(--accent); }
  p, li { color: #d4d9e4; }
  a { color: var(--accent); }
  blockquote { border-left:3px solid var(--accent); margin:16px 0; padding:4px 0 4px 16px; color:var(--muted); }
  code { background:var(--surface); padding:1px 5px; border-radius:4px; font-size:14px; }
  hr { border:0; border-top:1px solid var(--border); margin:28px 0; }
  .meta { color:var(--muted); font-size:13px; margin-top:40px; border-top:1px solid var(--border); padding-top:14px; }
</style></head>
<body><div class="wrap">
<div class="kicker">Full role story · voice-calibrated narrative</div>
${body}
<div class="meta">Generated from interview-prep/stories · Mitchell Williams · career-ops</div>
</div></body></html>`;

const files = readdirSync(SRC).filter(f => f.endsWith('.md') && !f.endsWith('.ai-detection.json'));
const map = {};
let written = 0;
const partials = [];

for (const f of files) {
  const slug = f.replace(/\.md$/, '');
  const srcPath = join(SRC, f);

  // ── Fabrication tollbooth (2026-05-31 v9) — scrub the narrative BEFORE it
  //    renders to dashboard HTML. Auto-fixes known retired metrics in place
  //    (idempotent); on a surviving leak (exit 1) the story page is SKIPPED so
  //    a contaminated narrative never reaches the dashboard, and the row is
  //    marked PARTIAL. Skipped in --dry-run (no file mutation). Kill switch:
  //    SCRUB_GATE_DISABLED=1.
  if (!DRY) {
    try {
      scrubArtifactsOrThrow([srcPath], { surface: 'story-page', row: (slug.match(/^(\d+)/)?.[1]) || slug });
    } catch (err) {
      if (err && err.code === 'FABRICATION_LEAK') {
        console.error(`  🔴 PARTIAL story ${slug}: a fabrication leak survived scrub — page NOT rendered to the dashboard.`);
        partials.push(slug);
        continue;
      }
      throw err; // exit-2 / infra error → genuine crash, do not mask
    }
  }

  const md = readFileSync(srcPath, 'utf-8');
  // first H1/heading or filename → title
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = (titleMatch ? titleMatch[1] : slug.replace(/-/g, ' ')).slice(0, 120);
  const body = marked.parse(md);
  if (!DRY) writeFileSync(join(OUT, `${slug}.html`), SHELL(title, body));
  written++;
  // num prefix → both padded + unpadded keys point to this slug
  const numMatch = slug.match(/^(\d+)/);
  if (numMatch) {
    const padded = numMatch[1];
    const unpadded = String(parseInt(padded, 10));
    map[padded] = slug;
    map[unpadded] = slug;
  }
}

if (!DRY) writeFileSync(MAP, JSON.stringify(map, null, 2));
console.log(`${DRY ? 'DRY-RUN' : 'WROTE'} ${written} narrative page(s) → dashboard/stories/`);
console.log(`${DRY ? 'would map' : 'mapped'} ${Object.keys(map).length} num key(s) → data/narrative-story-map.json`);
console.log('sample map:', JSON.stringify(Object.fromEntries(Object.entries(map).slice(0, 6))));
// Fail-loud: any story whose narrative still leaked a fabrication post-scrub
// was skipped (not published) — exit non-zero so the build surfaces it.
if (partials.length) {
  console.error(`\n🔴 ${partials.length} story page(s) SKIPPED on a surviving fabrication leak — HAND-FIX then re-run: ${partials.join(', ')}`);
  process.exit(1);
}
