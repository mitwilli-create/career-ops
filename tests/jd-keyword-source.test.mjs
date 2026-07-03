#!/usr/bin/env node
/**
 * tests/jd-keyword-source.test.mjs
 *
 * INVARIANT: scripts/jd-keyword-score.mjs extracts "JD top terms" from the
 * pack's verbatim posting (apply-pack/<slug>/jd.md) when one exists — ALONE,
 * never diluted by grok-intel.md / README.md / the eval report. The
 * intel-concat corpus is a FALLBACK for packs without jd.md.
 *
 * Born 2026-06-10: pack 049-perplexity-* carried a clean 2.8KB jd.md, but
 * loadJdText unconditionally concatenated the intel files + eval report, so
 * the "JD top terms" became meta-vocabulary (`inferred`, `https`, `bullet`,
 * `recruiter`, `comp`, `www`, `linkedin`) and tailored-cv.md scored 30%
 * against noise — the ≥50% threshold gate was meaningless.
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
import { loadJdText, processPack } from '../scripts/jd-keyword-score.mjs';

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

console.log('jd-keyword-source — jd.md-primary JD-term extraction (fixture root)');

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
check('no jd.md → jd_source=intel-concat', rB.jd_source === 'intel-concat', JSON.stringify(rB.jd_source));
check('fallback corpus includes slug-resolved eval report', (rB.jd_terms || []).includes('telemetry'), JSON.stringify(rB.jd_terms));
check('fallback corpus includes intel files (noise present, pre-fix behavior preserved)',
  (rB.jd_terms || []).includes('inferred'));
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

fs.rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ FAIL — ${failures} JD-source check(s) failed.`);
  process.exit(1);
}
console.log('\n✓ PASS — jd.md is the sole JD-term source when present; intel-concat only as fallback.');
process.exit(0);
