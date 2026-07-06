#!/usr/bin/env node
/**
 * verify-dashboard-real-2026-05-31.mjs — REAL-SOURCE acceptance test for the
 * overnight Apply-Now closer chain.
 *
 * WHY THIS EXISTS: verify-overnight-2026-05-31.mjs is MIS-TARGETED. It checks
 * data/apply-now-queue.json (ranked[]) + apply-pack/<slug>/*.json — files the
 * live dashboard does NOT render from. It reported ALL-GREEN while the dashboard
 * still showed off-positioning roles on top + empty popouts. This script checks
 * the ACTUAL render sources, replicating the server's row->slug binding exactly.
 *
 * THE REAL RENDER SOURCES (verified 2026-05-31):
 *   - Apply-Now list  = data/applications.md, filter score>=4.0 AND
 *     status in {Evaluated,Responded}, sorted by score desc
 *     (build-dashboard.mjs:4389 + :5293). apply-now-queue.json only hydrates
 *     canonical_url.
 *   - Popouts (interview-likelihood / hm-chance / team-health / strategy-ceiling)
 *     are served at click time by dashboard-server.mjs:/api/intel-chips?row=N.
 *     The server resolves: row N -> first apply-pack/<padNum(N)>-* dir -> that
 *     dir name IS the slug -> reads data/<popout>/<slug>.json. The client only
 *     ever sends ?row=N (build-dashboard.mjs:22472). So a WORKING popout needs
 *     BOTH the apply-pack dir (for resolution) AND data/<popout>/<slug>.json.
 *
 * Run:  node scripts/verify-dashboard-real-2026-05-31.mjs              (all live apply-now)
 *       node scripts/verify-dashboard-real-2026-05-31.mjs --top 10
 *       node scripts/verify-dashboard-real-2026-05-31.mjs --section fabrication
 *       node scripts/verify-dashboard-real-2026-05-31.mjs --gaps        (print remaining-row work list)
 *
 * No LLM, no network. Exit 0 only if every checked section PASSES.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApplicationsFile } from '../lib/parse-applications.mjs';
import { PAT, EXCL } from '../lib/retired-metric-pattern.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv;
const only = argv.includes('--section') ? argv[argv.indexOf('--section') + 1] : null;
const topN = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : null;
const showGaps = argv.includes('--gaps');
const run = (s) => !only || only === s;
const results = [];
const rec = (section, ok, detail) => { results.push({ ok }); console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  [${section}]  ${detail}`); };

// ── REAL Apply-Now list (exact dashboard logic) ──
const apps = parseApplicationsFile(join(ROOT, 'data', 'applications.md'));
const applyNow = apps
  .filter(r => r.score >= 4.0 && /^(evaluated|responded)$/i.test(r.status))
  .sort((a, b) => b.score - a.score);
const scoped = (topN && topN < applyNow.length) ? applyNow.slice(0, topN) : applyNow;
const label = topN ? `top-${scoped.length}` : `all ${scoped.length} live`;

// ── server-identical row -> slug resolution ──
const packDirs = existsSync(join(ROOT, 'apply-pack'))
  ? readdirSync(join(ROOT, 'apply-pack')).filter(d => !/^zzz|quarantine/.test(d))
  : [];
function slugForRow(num) {
  const padded = (String(num).length < 3 ? String(num).padStart(3, '0') : String(num)) + '-';
  const matches = packDirs.filter(d => d.startsWith(padded));
  return { slug: matches[0] || null, ambiguous: matches.length > 1 ? matches : null };
}
const nonEmpty = (p, min = 120) => { try { return statSync(p).size >= min; } catch { return false; } };
const companyTokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(t => t.length >= 3);

// ── Section: AAA — no Applied AI Architect Industries/Commercial in Apply-Now ──
if (run('aaa')) {
  const aaa = applyNow.filter(r => /applied ai architect.*(industr|commercial)/i.test(r.role));
  rec('aaa', aaa.length === 0, aaa.length === 0
    ? `0 Applied AI Architect (Industries/Commercial) in Apply-Now`
    : `${aaa.length} AAA rows still Evaluated>=4.0: ${aaa.map(r => `#${r.num}`).join(' ')} — discard in applications.md`);
}

// ── Section: POPOUTS — every Apply-Now row has working IL + HC (real binding) ──
if (run('popouts')) {
  const gaps = [];
  for (const r of scoped) {
    const { slug, ambiguous } = slugForRow(r.num);
    if (!slug) { gaps.push({ num: r.num, why: 'no-pack', company: r.company, role: r.role }); continue; }
    const il = nonEmpty(join(ROOT, 'data', 'interview-likelihood', slug + '.json'));
    const hc = nonEmpty(join(ROOT, 'data', 'hm-chance', slug + '.json'));
    const rs = slug.replace(/^[0-9]+-/, '');
    const coMatch = companyTokens(r.company).some(t => rs.includes(t));
    const miss = [];
    if (!il) miss.push('il');
    if (!hc) miss.push('hc');
    if (!coMatch) miss.push('stale-slug');
    if (ambiguous) miss.push(`ambig:${ambiguous.length}`);
    if (miss.length) gaps.push({ num: r.num, why: miss.join('+'), company: r.company, role: r.role, slug });
  }
  rec('popouts', gaps.length === 0, gaps.length === 0
    ? `${label} rows have working interview-likelihood + hm-chance popouts (real server binding)`
    : `${gaps.length}/${scoped.length} rows incomplete: ${gaps.slice(0, 14).map(g => `#${g.num}(${g.why})`).join(' ')}${gaps.length > 14 ? ' …' : ''}`);
  if (showGaps) {
    console.log('\n── REMAINING-ROW WORK LIST (popout gaps) ──');
    for (const g of gaps) console.log(`  #${String(g.num).padEnd(5)} ${g.why.padEnd(16)} ${g.company} / ${g.role}`);
  }
}

// ── Section: CONTENT — cover letter + story present for each Apply-Now row ──
if (run('content')) {
  const bad = [];
  for (const r of scoped) {
    const { slug } = slugForRow(r.num);
    let cover = false, story = false;
    if (slug) {
      const dir = join(ROOT, 'apply-pack', slug);
      cover = nonEmpty(join(dir, 'cover-letter.md'), 400);
      story = nonEmpty(join(dir, 'full-story.md'), 400) || nonEmpty(join(dir, 'story.md'), 400);
    }
    if (!story) {
      try { story = readdirSync(join(ROOT, 'interview-prep', 'stories')).some(f => f.startsWith((String(r.num).length < 3 ? String(r.num).padStart(3, '0') : String(r.num)) + '-')); } catch {}
    }
    if (!cover || !story) bad.push(`#${r.num}(${!cover ? 'cover' : ''}${!story ? 'story' : ''})`);
  }
  rec('content', bad.length === 0, bad.length === 0
    ? `${label} rows have cover letter + story`
    : `${bad.length}/${scoped.length} rows missing content: ${bad.slice(0, 14).join(' ')}${bad.length > 14 ? ' …' : ''}`);
}

// ── Section: FABRICATION — zero forbidden-metric lines across REAL render dirs ──
if (run('fabrication')) {
  // EXCL = disclosure/record notes that NAME a retired metric in a "removed"
  // context (not a live claim). "No retired metrics: <list>" is the
  // ai-detection sidecar's record that the metric was scrubbed — same class as
  // "corrected or dropped" / "Metric-hardened". A real leak never carries it.
  // Superset of the old verifier's surfaces PLUS the REAL popout render dirs the old one omitted.
  const surfaces = [
    'cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md',
    'corpus', 'reports', 'interview-prep', 'apply-pack', 'dashboard/index.html',
    'data/applications.md', 'data/apply-now-queue.json',
    'data/interview-likelihood', 'data/hm-chance', 'data/team-health',
    'data/strategy-ceiling', 'data/role-enrichment', 'data/context-notes', 'data/hm-intel',
  ];
  let total = 0; const examples = [];
  for (const s of surfaces) {
    const p = join(ROOT, s);
    if (!existsSync(p)) continue;
    try {
      const out = execSync(`grep -rnE "${PAT}" "${p}" 2>/dev/null | grep -vE "${EXCL}" || true`, { encoding: 'utf8' }).trim();
      const lines = out ? out.split('\n').filter(Boolean) : [];
      total += lines.length;
      if (lines.length && examples.length < 6) examples.push(...lines.slice(0, 2).map(l => l.replace(ROOT + '/', '').slice(0, 100)));
    } catch {}
  }
  rec('fabrication', total === 0, total === 0
    ? 'zero live fabricated-metric lines across REAL render dirs (disclosure notes excluded)'
    : `${total} fabrication lines, e.g.: ${examples.join(' || ')}`);
}

const checked = results.length, passed = results.filter(r => r.ok).length;
console.log(`\n${'='.repeat(64)}\n${passed === checked ? '🟢 ALL GREEN' : '🔴 NOT DONE'} — ${passed}/${checked} sections passed${topN ? ` (scope: top ${topN})` : ''} | apply-now=${applyNow.length}\n${'='.repeat(64)}`);
process.exit(passed === checked ? 0 : 1);
