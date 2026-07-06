#!/usr/bin/env node
/**
 * verify-overnight-2026-05-31.mjs — deterministic acceptance test for the overnight closer.
 *
 * Run:  node scripts/verify-overnight-2026-05-31.mjs            (all 58 live roles)
 *       node scripts/verify-overnight-2026-05-31.mjs --top 10   (only the top-10 must-have set)
 *       node scripts/verify-overnight-2026-05-31.mjs --section fabrication
 *
 * No LLM, no network. Exits 0 only if every checked section PASSES.
 * Built 2026-05-31 so Mitchell never has to take "done" on faith again.
 * fabrication uses line-level grep so intentional "…dropped" disclosure notes don't false-flag.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAT, EXCL } from '../lib/retired-metric-pattern.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv;
const only = argv.includes('--section') ? argv[argv.indexOf('--section') + 1] : null;
const topN = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : null;
const run = (s) => !only || only === s;
const results = [];
const rec = (section, ok, detail) => { results.push({ ok }); console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  [${section}]  ${detail}`); };

// ⛔ DEPRECATED 2026-05-31 — THIS VERIFIER IS MIS-TARGETED. It checks
// data/apply-now-queue.json (ranked[]) + apply-pack/<slug>/*.json, which the
// LIVE DASHBOARD DOES NOT RENDER FROM. It went ALL-GREEN while the dashboard
// still showed off-positioning roles on top + empty popouts.
// USE INSTEAD: node scripts/verify-dashboard-real-2026-05-31.mjs
// (checks data/applications.md ordering/status + the real data/<popout>/<slug>.json
//  dirs via the server's row->slug binding). This script is kept only for history.
console.error('\n⛔ DEPRECATED: verify-overnight-2026-05-31.mjs is MIS-TARGETED (checks proxy files the dashboard does NOT render from).');
console.error('   → Run: node scripts/verify-dashboard-real-2026-05-31.mjs   (the real-source acceptance test)\n');

// ── Section 1: FABRICATION SWEEP (line-level so disclosure notes are excluded) ──
if (run('fabrication')) {
  const surfaces = ['cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md', 'corpus', 'reports', 'interview-prep', 'apply-pack', 'dashboard/index.html', 'data/applications.md', 'data/apply-now-queue.json'];
  let total = 0; const examples = [];
  for (const s of surfaces) {
    const p = join(ROOT, s);
    if (!existsSync(p)) continue;
    try {
      const out = execSync(`grep -rnE "${PAT}" "${p}" 2>/dev/null | grep -vE "${EXCL}" || true`, { encoding: 'utf8' }).trim();
      const lines = out ? out.split('\n').filter(Boolean) : [];
      total += lines.length;
      if (lines.length && examples.length < 4) examples.push(...lines.slice(0, 2).map(l => l.replace(ROOT + '/', '').slice(0, 90)));
    } catch {}
  }
  rec('fabrication', total === 0, total === 0 ? 'zero live fabricated-metric lines (intentional disclosure notes excluded)' : `${total} live fabrication lines, e.g.: ${examples.join(' || ')}`);
}

// ── load queue ──
let queue = null;
try { queue = JSON.parse(readFileSync(join(ROOT, 'data/apply-now-queue.json'), 'utf8')); } catch {}
const ranked = (queue && (queue.ranked || queue.queue)) || [];
const live = ranked.filter(r => r.status && !/discard/i.test(r.status) && Number(r.eval_score ?? r.score ?? 0) >= 4.0);
const scoped = (topN && topN < live.length) ? live.slice(0, topN) : live;     // per-role checks honor --top N
const label = topN ? `top-${scoped.length}` : `all ${scoped.length} live`;

const packDirs = existsSync(join(ROOT, 'apply-pack')) ? readdirSync(join(ROOT, 'apply-pack')).filter(d => !/^zzz|quarantine/.test(d)) : [];
const dirForRow = (r) => {
  const n = String(r.num);
  return packDirs.find(d => d.startsWith(n.padStart(3, '0') + '-')) || packDirs.find(d => d.startsWith(n + '-')) || null;
};
const nonEmpty = (p, min = 120) => { try { return statSync(p).size >= min; } catch { return false; } };

// ── Section 2: QUEUE re-scored TONIGHT (flag) + AAA not on top ──
if (run('queue')) {
  const flag = existsSync(join(ROOT, 'data/queue-rescored-2026-05-31.flag'));
  const top = live[0];
  const discarded = ranked.filter(r => /discard/i.test(r.status || '')).length;
  const topIsAAA = top && /applied ai architect.*(industr|commercial)/i.test(top.role || '');
  const ok = flag && !!top && !topIsAAA;
  rec('queue', ok, ok
    ? `re-scored tonight (flag ✓): ${ranked.length} rows, ${live.length} live, ${discarded} discarded; top = #${top.num} ${top.company} / ${top.role}`
    : `${!flag ? 'NO rescore flag → Phase A not run tonight; ' : ''}top = ${top ? `#${top.num} ${top.company}/${top.role}` : 'none'} | discarded=${discarded} | AAA-on-top=${topIsAAA}`);
}

// ── Section 3: CELLS (comp + connection signal) ──
if (run('cells')) {
  const missing = [];
  for (const r of scoped) {
    const blob = JSON.stringify(r).toLowerCase();
    const hasComp = /\$|usd|equity|comp|salary|€|£|\dk\b/.test(blob);
    const hasLink = /linkedin|connection|warm|contact|recruiter|hiring_manager/.test(blob) || (r.tactical_lead && String(r.tactical_lead).length > 3);
    if (!hasComp || !hasLink) missing.push(`#${r.num}(${!hasComp ? 'comp' : ''}${!hasLink ? 'link' : ''})`);
  }
  rec('cells', missing.length === 0, missing.length === 0 ? `${label} rows have comp + connection signal` : `${missing.length} rows missing cells: ${missing.slice(0, 12).join(' ')}${missing.length > 12 ? ' …' : ''}`);
}

// ── Section 4: POPOUTS regenerated (interview-likelihood + hm-chance non-empty) ──
if (run('popouts')) {
  const bad = [];
  for (const r of scoped) {
    const d = dirForRow(r);
    if (!d) { bad.push(`#${r.num}(no-pack)`); continue; }
    const dir = join(ROOT, 'apply-pack', d);
    const il = nonEmpty(join(dir, 'interview-likelihood.json'));
    const hc = nonEmpty(join(dir, 'hm-chance.json'));
    if (!il || !hc) bad.push(`#${r.num}(${!il ? 'il' : ''}${!hc ? 'hc' : ''})`);
  }
  rec('popouts', bad.length === 0, bad.length === 0 ? `${label} roles have populated interview-likelihood + hm-chance popouts` : `${bad.length} roles w/ empty/missing popouts: ${bad.slice(0, 12).join(' ')}${bad.length > 12 ? ' …' : ''}`);
}

// ── Section 5: COVER LETTER + FULL STORY present ──
if (run('content')) {
  const bad = [];
  for (const r of scoped) {
    const d = dirForRow(r);
    if (!d) { bad.push(`#${r.num}(no-pack)`); continue; }
    const dir = join(ROOT, 'apply-pack', d);
    const cover = nonEmpty(join(dir, 'cover-letter.md'), 400);
    const storyA = nonEmpty(join(dir, 'full-story.md'), 400) || nonEmpty(join(dir, 'story.md'), 400);
    let storyB = false;
    try { storyB = readdirSync(join(ROOT, 'interview-prep', 'stories')).some(f => f.startsWith(String(r.num).padStart(3, '0') + '-') || f.startsWith(r.num + '-')); } catch {}
    if (!cover || !(storyA || storyB)) bad.push(`#${r.num}(${!cover ? 'cover' : ''}${!(storyA || storyB) ? 'story' : ''})`);
  }
  rec('content', bad.length === 0, bad.length === 0 ? `${label} roles have a cover letter + full story` : `${bad.length} roles missing content: ${bad.slice(0, 12).join(' ')}${bad.length > 12 ? ' …' : ''}`);
}

const checked = results.length, passed = results.filter(r => r.ok).length;
console.log(`\n${'='.repeat(60)}\n${passed === checked ? '🟢 ALL GREEN' : '🔴 NOT DONE'} — ${passed}/${checked} sections passed${topN ? ` (scope: top ${topN})` : ''}\n${'='.repeat(60)}`);
process.exit(passed === checked ? 0 : 1);
