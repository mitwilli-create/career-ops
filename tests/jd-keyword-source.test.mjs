#!/usr/bin/env node
/**
 * tests/jd-keyword-source.test.mjs
 *
 * INVARIANT: scripts/jd-keyword-score.mjs extracts "JD top terms" from the
 * pack's verbatim posting (apply-pack/<slug>/jd-verbatim.md, legacy jd.md)
 * when one exists — ALONE, never diluted by grok-intel.md / README.md / the
 * eval report. Without a verbatim file, the eval report's JD-BEARING
 * SECTIONS ONLY (Role Summary + CV Match JD-requirement cells) are used;
 * the intel-concat corpus is the LAST-RESORT fallback, meta-filtered.
 *
 * Born 2026-06-10: pack 049-perplexity-* carried a clean 2.8KB jd.md, but
 * loadJdText unconditionally concatenated the intel files + eval report, so
 * the "JD top terms" became meta-vocabulary (`inferred`, `https`, `bullet`,
 * `recruiter`, `comp`, `www`, `linkedin`) and tailored-cv.md scored 30%
 * against noise — the ≥50% threshold gate was meaningless.
 *
 * Extended 2026-07-08 (packs 2507/2757/2758): whole-report tokenization of
 * HAND-AUTHORED eval reports ranked report meta-vocabulary (`block`,
 * `recruiter`, `comp`, `apply`, `report`, `formatting-guide`, dates,
 * pronouns) as "JD top terms", producing false 40-50% scores and garbage
 * "recommended additions". Pinned here: jd-verbatim.md preferred; report
 * fallback extracts Role Summary + JD-requirement cells only; non-verbatim
 * sources drop REPORT_META_STOPWORDS; date-shaped tokens never rank.
 *
 * Also pins: cv-tailored.md (the L6 schema-typed artifact that renders to
 * the shipped PDF) is scored as the primary CV row, alongside legacy
 * tailored-cv.md; master cv.md is the fallback only when neither exists.
 *
 * Pure-fixture tests (mkdtemp root) — no personal data, CI-safe, $0.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJdText, processPack, extractJdBearingText } from '../scripts/jd-keyword-score.mjs';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-source-'));
const packsDir = path.join(root, 'apply-pack');
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });

function makePack(slug, files) {
  const dir = path.join(packsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

// Intel noise — the meta-vocabulary from the 2026-06-10 incident, repeated
// ~3x louder than the JD's real terms so that IF the concat leaked into a
// jd.md-present pack, noise would outrank the real JD terms and the
// assertions below would fail.
const NOISE = ('inferred recruiter bullet comp linkedin sourcing outreach hiring funnel\n' +
  'https://www.linkedin.com/jobs/view/123456 https://www.example.com/apply\n').repeat(30);

// Verbatim-posting fixture — mirrors pack 049's shape. "executive" and
// "communications" are the most frequent content words.
const JD_TEXT = `Executive Communications Manager

Perplexity is seeking a Senior Manager, Executive Communications to architect
executive communications strategy. You will create executive communications,
including stage speeches, leadership emails, and board decks. Develop a unique
executive voice. Synthesize complex topics into clear communications narratives.
Partner with leadership on change communications and executive messaging.

Qualifications: 8+ years in communications, executive communications, or
related fields. Exceptional writing. Experience supporting executive leadership
through communications programs. Strategic communications planning. Executive
presence and discretion. Communications portfolio required. Executive
storytelling across executive channels and communications surfaces.`;

// ── Pack A: jd.md present + heavy intel noise + both CV variants ──
const packA = '300-perplexity-executive-communications-manager';
const packADir = makePack(packA, {
  'jd.md': JD_TEXT,
  'grok-intel.md': `# Grok intel\n${NOISE}`,
  'README.md': `# Pack readme\n${NOISE}`,
  'one-pager.md': 'One pager: executive communications strategy narrative for leadership.',
  'cv-tailored.md': 'Executive communications leader. Strategic leadership messaging, speeches, narratives.',
  'tailored-cv.md': 'Legacy tailored CV. Executive communications strategy and leadership writing.',
  'cover-letter.md': 'Cover letter about executive communications strategy and leadership narratives.',
  'form-fields.md': 'Form fields: executive communications writing samples and leadership references.',
});
// Same-slug eval report full of noise — must NOT leak into jd.md mode.
fs.writeFileSync(
  path.join(root, 'reports', '2900-perplexity-executive-communications-manager-2026-06-01.md'),
  `# Eval report\n**URL:** https://www.example.com\n${NOISE}`
);

console.log('jd-keyword-source — verbatim-JD-primary term extraction + report JD-sections fallback (fixture root)');

// 1. loadJdText: jd.md wins, verbatim, alone.
const l1 = loadJdText(packADir, packA, null, { root });
check('jd.md present → source is jd.md', l1.source === 'jd.md', JSON.stringify(l1.source));
check('jd.md used verbatim (no intel concat)', l1.text === JD_TEXT);
check('jd.md wins even over an explicit --report override',
  loadJdText(packADir, packA, 'reports/2900-perplexity-executive-communications-manager-2026-06-01.md', { root }).source === 'jd.md');

// 2. THE regression: top terms come from the posting, not the intel noise.
const opts = { top: 20, threshold: 0.5, dryRun: false, report: null };
const rA = processPack(packA, opts, { root });
check('processPack reports jd_source=jd.md', rA.jd_source === 'jd.md', JSON.stringify(rA.jd_source));
const top5 = (rA.jd_terms || []).slice(0, 5);
check('"executive" ranks in the top 5 JD terms', top5.includes('executive'), JSON.stringify(rA.jd_terms));
check('"communications" ranks in the top 5 JD terms', top5.includes('communications'), JSON.stringify(rA.jd_terms));
for (const noise of ['https', 'www', 'linkedin', 'inferred', 'recruiter', 'bullet', 'comp']) {
  check(`noise term "${noise}" absent from JD top terms`, !(rA.jd_terms || []).includes(noise));
}

// 3. CV coverage: L6 cv-tailored.md scored FIRST (gate callers find() it),
//    legacy tailored-cv.md also scored, no cv.md fallback row.
const paths = (rA.artifacts || []).map(a => a.path);
check('cv-tailored.md (L6 → PDF) is scored', paths.includes('cv-tailored.md'), JSON.stringify(paths));
check('cv-tailored.md is the first CV row', paths.indexOf('cv-tailored.md') < paths.indexOf('tailored-cv.md'));
check('legacy tailored-cv.md still scored', paths.includes('tailored-cv.md'));
check('no cv.md fallback when pack CVs exist', !paths.some(p => p.includes('cv.md (fallback)')));

// 4. Written report names its JD source (auditability).
const alignmentMd = fs.readFileSync(path.join(packADir, 'keyword-alignment.md'), 'utf-8');
check('keyword-alignment.md names JD source jd.md', alignmentMd.includes('JD source: `jd.md`'));

// ── Pack B: NO jd.md → intel-concat fallback (incl. slug-resolved report);
//    L6-only CV pack (the 10-pack census case) scores cv-tailored.md, not cv.md. ──
const packB = '301-acme-widget-engineer';
makePack(packB, {
  'grok-intel.md': `Widget telemetry pipeline notes.\n${NOISE}`,
  'README.md': 'Acme widget engineer pack readme with telemetry context.',
  'cv-tailored.md': 'Widget engineer CV: telemetry, pipelines, inferred metrics.',
});
fs.writeFileSync(
  path.join(root, 'reports', '2901-acme-widget-engineer-2026-06-02.md'),
  '# Eval\n' + 'telemetry widget pipeline observability dashboards alerting\n'.repeat(12)
);
const rB = processPack(packB, opts, { root });
check('no jd file + no extractable report sections → jd_source=intel-concat', rB.jd_source === 'intel-concat', JSON.stringify(rB.jd_source));
check('fallback corpus includes slug-resolved eval report', (rB.jd_terms || []).includes('telemetry'), JSON.stringify(rB.jd_terms));
check('fallback corpus still includes intel files (non-meta terms rank)',
  (rB.jd_terms || []).includes('funnel'), JSON.stringify(rB.jd_terms));
for (const meta of ['inferred', 'recruiter', 'comp', 'linkedin', 'https', 'www', 'bullet']) {
  check(`intel-concat mode drops meta term "${meta}" (2026-07-08 fix)`, !(rB.jd_terms || []).includes(meta));
}
const pathsB = (rB.artifacts || []).map(a => a.path);
check('L6-only pack scores cv-tailored.md (not master cv.md)',
  pathsB.includes('cv-tailored.md') && !pathsB.some(p => p.includes('cv.md (fallback)')), JSON.stringify(pathsB));

// ── Pack C: stub jd.md under the 200-char floor → treated as absent. ──
const packC = '302-stubco-some-role';
makePack(packC, {
  'jd.md': 'TBD',
  'grok-intel.md': `Stubco role context.\n${NOISE}`,
});
const rC = processPack(packC, opts, { root });
check('stub jd.md (<200 chars) falls back to intel-concat', rC.jd_source === 'intel-concat', JSON.stringify(rC.jd_source));

// ── Pack D: no pack-local CV at all → master cv.md fallback row, exactly once. ──
fs.writeFileSync(path.join(root, 'cv.md'), 'Master CV: executive communications leadership strategy narratives.');
const packD = '303-nocvco-some-role';
makePack(packD, { 'jd.md': JD_TEXT });
const rD = processPack(packD, opts, { root });
const fallbackRows = (rD.artifacts || []).filter(a => a.path === 'cv.md (fallback)');
check('no pack CV → master cv.md fallback row exactly once', fallbackRows.length === 1, JSON.stringify(rD.artifacts));

// ── Pack E: jd-verbatim.md (canonical name, 2026-07-08) preferred over legacy
//    jd.md; verbatim mode is NEVER meta-filtered — a JD's own words rank even
//    when they collide with report meta-vocabulary. ──
const packE = '304-verbco-recruiting-communications-lead';
const JD_WITH_META_WORD = JD_TEXT + '\nPartner with recruiter teams.\n'.repeat(6);
const packEDir = makePack(packE, {
  'jd-verbatim.md': JD_WITH_META_WORD,
  'jd.md': 'Legacy stale jd.md copy that must lose to jd-verbatim.md. '.repeat(10),
});
const lE = loadJdText(packEDir, packE, null, { root });
check('jd-verbatim.md preferred over legacy jd.md', lE.source === 'jd-verbatim.md', JSON.stringify(lE.source));
check('jd-verbatim.md used verbatim', lE.text === JD_WITH_META_WORD);
const rE = processPack(packE, opts, { root });
check('verbatim source is never meta-filtered ("recruiter" ranks when the JD says it)',
  (rE.jd_terms || []).includes('recruiter'), JSON.stringify(rE.jd_terms));

// ── Pack F: THE 2026-07-08 regression — hand-authored eval report, no
//    verbatim JD file. Terms must come from Role Summary + CV Match
//    JD-requirement cells ONLY; report meta-vocabulary, dates, pronouns,
//    CV-evidence prose, and Block C prose must never rank. ──
const packF = '2960-acme-head-of-social-communications';
makePack(packF, {
  'grok-intel.md': `# Grok intel\n${NOISE}`,
  'README.md': `# Pack readme\n${NOISE}`,
  'cover-letter.md': 'Cover letter on social communications strategy, voice stewardship, and breaking-news response.',
  'cv-tailored.md': 'Social communications leader: platforms, community engagement, voice, response strategy.',
});
fs.writeFileSync(
  path.join(root, 'reports', '2961-acme-head-of-social-communications-2026-07-08.md'),
  `# Evaluation: Acme — Head of Social Communications

**Date:** 2026-07-08
**Archetype:** Communications (Tier B)
**Score:** 4.6/5
**Legitimacy:** High Confidence
**URL:** https://job-boards.greenhouse.io/acme/jobs/123
**PDF:** ❌ (apply-pack pending — see formatting-guide)
**Model:** hand-evaluated (corpus-grounded)
**Verification:** confirmed live 2026-07-08 via Greenhouse board API
**Comp / logistics:** $345,000 to $460,000 · San Francisco

---

## A) Role Summary

| Field | Value |
|---|---|
| Detected archetype | Communications (Tier B) |
| Function | Own proactive and reactive social communications strategy: announcement moments, breaking-news response, community engagement, voice stewardship for social channels and platforms |
| Seniority | Head of (8+ yrs leading social communications) |
| Posted | 2026-07-08 |
| Comp | $345,000 to $460,000 |

## B) CV Match

| JD requirement | CV evidence |
|---|---|
| 8+ yrs leading social communications and response strategy under public scrutiny | Founding-team newsroom producer; his social-first live shows |
| Exceptional writing and mastery of nuanced brand voice on social platforms | Codified voice systems he built |
| Built and managed online communities at scale with community engagement | Community programs for engineers |

## C) Block C — Why This Fits The Candidate

The recruiter will read his comp expectations in this report. Apply via the formatting-guide workflow. Block C prose must never rank as JD keywords.

## G) Posting Legitimacy

**High Confidence.** Official Greenhouse posting confirmed by the recruiter on the board. Apply directly.
`
);
const rF = processPack(packF, opts, { root });
check('hand-authored report → jd_source=report-jd-sections', rF.jd_source === 'report-jd-sections', JSON.stringify(rF.jd_source));
check('"social" ranks in JD top terms', (rF.jd_terms || []).includes('social'), JSON.stringify(rF.jd_terms));
check('"communications" ranks in JD top terms', (rF.jd_terms || []).includes('communications'));
for (const meta of ['block', 'recruiter', 'comp', 'apply', 'report', 'formatting-guide',
  'his', 'greenhouse', 'legitimacy', 'archetype', 'confirmed', 'linkedin']) {
  check(`report meta term "${meta}" never ranks as a JD keyword`, !(rF.jd_terms || []).includes(meta), JSON.stringify(rF.jd_terms));
}
check('date-shaped tokens never rank (2026-07-08)', !(rF.jd_terms || []).some(t => /^[\d/-]+$/.test(t)), JSON.stringify(rF.jd_terms));
check('CV-evidence cells excluded ("newsroom" is evidence-only)', !(rF.jd_terms || []).includes('newsroom'));
check('Block C prose excluded ("workflow" is Block-C-only)', !(rF.jd_terms || []).includes('workflow'));

// ── Pack G: stale applications.md report link (file missing on disk) must
//    degrade to intel-concat, never throw ENOENT (CodeRabbit 2026-07-08). ──
const packG = '305-ghostco-writer';
makePack(packG, { 'grok-intel.md': `Ghostco writer context corpus.\n${NOISE}` });
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 305 | 2026-07-08 | Ghostco | Writer | 4.0/5 | Evaluated | ❌ | [9999](reports/9999-ghostco-writer-2026-01-01.md) | stale link — report file absent |
`);
let rG = null, threwG = false;
try { rG = processPack(packG, opts, { root }); } catch { threwG = true; }
check('stale report link never throws ENOENT', !threwG);
check('stale report link degrades to intel-concat', rG?.jd_source === 'intel-concat', JSON.stringify(rG?.jd_source));

// ── extractJdBearingText unit pins ──
const reportF = fs.readFileSync(path.join(root, 'reports', '2961-acme-head-of-social-communications-2026-07-08.md'), 'utf-8');
const ex = extractJdBearingText(reportF);
check('extract includes Role Summary body', ex.includes('voice stewardship for social channels'));
check('extract includes JD-requirement cells', ex.includes('response strategy under public scrutiny'));
check('extract drops CV-evidence cells', !ex.includes('newsroom producer'));
check('extract drops Block C + header + legitimacy sections',
  !ex.includes('Block C prose') && !ex.includes('hand-evaluated') && !ex.includes('Official Greenhouse'));
check('extract returns empty string when no sections found', extractJdBearingText('# Eval\nno structured sections here') === '');

fs.rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ FAIL — ${failures} JD-source check(s) failed.`);
  process.exit(1);
}
console.log('\n✓ PASS — verbatim JD is the sole term source when present; report fallback uses JD-bearing sections; meta terms never rank.');
process.exit(0);
