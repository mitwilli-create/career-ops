#!/usr/bin/env node
/**
 * tests/polish-cv-tailored-source-detection.test.mjs
 *
 * Fixture tests for lib/polish-source-detection.mjs — the helper used by
 * scripts/agents/apply-pack-polish.mjs to classify the on-disk state of
 * one artifact in one pack.
 *
 * Bug 2 of pre-apply-followup sprint (Worker C, 2026-05-25): polish loop's
 * cv-tailored phase failed with `no-source-and-no-generator` when
 * `tailored-cv.pdf` existed but `tailored-cv.md` did not, even though
 * other artifacts in the same pack could polish. The fix replaces the
 * binary "has md / nothing" check with a 4-state classifier:
 *   has-md → polish normally
 *   pdf-only → skip phase, log warning, continue with rest of pack
 *   has-generator → use generateIfMissing (existing path for impact-doc etc)
 *   missing-actionable → surface actionable suggestion + skip
 *
 * Tests use tmpdir-injected apply-pack/ shapes so they don't touch the
 * real worktree data.
 */

import {
  detectPolishSource,
  buildSkippedArtifactRecord,
  _internal,
} from '../lib/polish-source-detection.mjs';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('✓ ' + name); pass++; }
  else {
    console.error('✗ ' + name);
    if (detail !== undefined) {
      try { console.error('  detail:', JSON.stringify(detail, null, 2).slice(0, 600)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// Helper — build a fresh tmp ROOT with optional artifacts inside an apply-pack
function makeTmpRoot(opts = {}) {
  const root = join(tmpdir(), 'polish-source-detection-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const slug = opts.slug || 'test-slug';
  const dir = join(root, 'apply-pack', slug);
  mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(opts.files || {})) {
    writeFileSync(join(dir, filename), content, 'utf-8');
  }
  return { root, slug, dir, cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch {} } };
}

// ── T1: has-md state — both .md and companion present ────────────────────
{
  const t = makeTmpRoot({
    files: {
      'tailored-cv.md': '# Tailored CV\n\nContent',
      'tailored-cv.pdf': 'binary-pdf-stub',
    },
  });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T1.1 has-md state when .md present + .pdf present', r.state === 'has-md', r);
  check('T1.2 has-md state → files_present.md=true', r.files_present?.md === true, r);
  check('T1.3 has-md state → companion populated', r.files_present?.companion?.includes('tailored-cv.pdf'), r);
  check('T1.4 has-md state → no actionable_suggestion needed',
    !r.actionable_suggestion, r);
  t.cleanup();
}

// ── T2: has-md state — only .md (no companion) ───────────────────────────
{
  const t = makeTmpRoot({
    files: { 'tailored-cv.md': '# Tailored CV\n\nContent' },
  });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T2.1 has-md state when .md present + no .pdf', r.state === 'has-md', r);
  check('T2.2 has-md → companion empty', r.files_present?.companion?.length === 0, r);
  t.cleanup();
}

// ── T3: pdf-only state — .pdf present, .md missing ───────────────────────
{
  const t = makeTmpRoot({
    files: { 'tailored-cv.pdf': 'binary-pdf-stub' },
  });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T3.1 pdf-only state when only .pdf present', r.state === 'pdf-only', r);
  check('T3.2 pdf-only → files_present.md=false', r.files_present?.md === false, r);
  check('T3.3 pdf-only → companion includes tailored-cv.pdf',
    r.files_present?.companion?.includes('tailored-cv.pdf'), r);
  check('T3.4 pdf-only → actionable_suggestion mentions cv-tailor agent',
    /cv-tailor/i.test(r.actionable_suggestion || ''), r);
  check('T3.5 pdf-only → actionable_suggestion mentions .md',
    /tailored-cv\.md/i.test(r.actionable_suggestion || ''), r);
  t.cleanup();
}

// ── T4: has-generator state — impact-doc with no .md ─────────────────────
{
  const t = makeTmpRoot({ files: {} });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'impact-doc', srcFile: 'impact-doc.md' });
  check('T4.1 has-generator state for impact-doc without source', r.state === 'has-generator', r);
  check('T4.2 has-generator → files_present.md=false', r.files_present?.md === false, r);
  t.cleanup();
}

// ── T5: has-generator state for references and referrals too ─────────────
{
  const t = makeTmpRoot({ files: {} });
  const r1 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'references', srcFile: 'references.md' });
  check('T5.1 has-generator for references', r1.state === 'has-generator', r1);
  const r2 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'referrals', srcFile: 'referrals.md' });
  check('T5.2 has-generator for referrals', r2.state === 'has-generator', r2);
  t.cleanup();
}

// ── T6: missing-actionable state — cv-tailored with neither .md nor .pdf ─
{
  const t = makeTmpRoot({ files: {} });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T6.1 missing-actionable state when neither file present', r.state === 'missing-actionable', r);
  check('T6.2 missing-actionable → has actionable_suggestion',
    typeof r.actionable_suggestion === 'string' && r.actionable_suggestion.length > 0, r);
  check('T6.3 missing-actionable → suggestion mentions running an agent',
    /run.*agent|cv-tailor|build-apply-packs/i.test(r.actionable_suggestion || ''), r);
  t.cleanup();
}

// ── T7: missing-actionable for cover-letter and form-fields ──────────────
{
  const t = makeTmpRoot({ files: {} });
  const r1 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cover-letter', srcFile: 'cover-letter.md' });
  check('T7.1 cover-letter without source → missing-actionable', r1.state === 'missing-actionable', r1);
  check('T7.2 cover-letter actionable_suggestion present',
    typeof r1.actionable_suggestion === 'string' && r1.actionable_suggestion.length > 0, r1);

  const r2 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'form-fields', srcFile: 'form-fields.md' });
  check('T7.3 form-fields without source → missing-actionable', r2.state === 'missing-actionable', r2);
  t.cleanup();
}

// ── T8: defensive — bad input ─────────────────────────────────────────────
{
  const r1 = detectPolishSource({});
  check('T8.1 empty opts → missing-actionable', r1.state === 'missing-actionable', r1);

  const r2 = detectPolishSource({ packSlug: 'x', kind: 'cv-tailored' }); // missing srcFile
  check('T8.2 missing srcFile → missing-actionable', r2.state === 'missing-actionable', r2);

  const r3 = detectPolishSource({ packSlug: 'x', srcFile: 'foo.md' }); // missing kind
  check('T8.3 missing kind → missing-actionable', r3.state === 'missing-actionable', r3);

  const r4 = detectPolishSource(null);
  check('T8.4 null opts → missing-actionable', r4.state === 'missing-actionable', r4);
}

// ── T9: bookkeeping helper buildSkippedArtifactRecord ─────────────────────
{
  const r = buildSkippedArtifactRecord('cv-tailored', 'pdf-only-no-md-source', 'Run cv-tailor first.');
  check('T9.1 buildSkippedArtifactRecord → skipped=true', r.skipped === true, r);
  check('T9.2 buildSkippedArtifactRecord → skip_reason matches', r.skip_reason === 'pdf-only-no-md-source', r);
  check('T9.3 buildSkippedArtifactRecord → actionable_suggestion forwarded',
    r.actionable_suggestion === 'Run cv-tailor first.', r);
  check('T9.4 buildSkippedArtifactRecord → confidence=0', r.confidence === 0, r);
  check('T9.5 buildSkippedArtifactRecord → rounds_used=0', r.rounds_used === 0, r);
  check('T9.6 buildSkippedArtifactRecord → cost_usd=0', r.cost_usd === 0, r);
  check('T9.7 buildSkippedArtifactRecord → not abandoned (just skipped)',
    r.abandoned === false, r);
  check('T9.8 buildSkippedArtifactRecord → adversarial_findings=[]',
    Array.isArray(r.adversarial_findings) && r.adversarial_findings.length === 0, r);
  check('T9.9 buildSkippedArtifactRecord → error=null', r.error === null, r);

  // Without suggestion arg
  const r2 = buildSkippedArtifactRecord('cv-tailored', 'pdf-only');
  check('T9.10 buildSkippedArtifactRecord with no suggestion → null',
    r2.actionable_suggestion === null, r2);
}

// ── T10: COMPANION_FILES internal mapping ────────────────────────────────
{
  check('T10.1 cv-tailored has tailored-cv.pdf as companion',
    _internal.COMPANION_FILES['cv-tailored']?.includes('tailored-cv.pdf'), _internal.COMPANION_FILES);
  check('T10.2 cover-letter has no companion mapping',
    !_internal.COMPANION_FILES['cover-letter'], _internal.COMPANION_FILES);
  check('T10.3 impact-doc has no companion mapping',
    !_internal.COMPANION_FILES['impact-doc'], _internal.COMPANION_FILES);
}

// ── T11: ARTIFACTS_WITH_GENERATOR internal mapping ───────────────────────
{
  check('T11.1 impact-doc in generator set', _internal.ARTIFACTS_WITH_GENERATOR.has('impact-doc'));
  check('T11.2 references in generator set', _internal.ARTIFACTS_WITH_GENERATOR.has('references'));
  check('T11.3 referrals in generator set', _internal.ARTIFACTS_WITH_GENERATOR.has('referrals'));
  check('T11.4 cv-tailored NOT in generator set', !_internal.ARTIFACTS_WITH_GENERATOR.has('cv-tailored'));
  check('T11.5 cover-letter NOT in generator set', !_internal.ARTIFACTS_WITH_GENERATOR.has('cover-letter'));
  check('T11.6 form-fields NOT in generator set', !_internal.ARTIFACTS_WITH_GENERATOR.has('form-fields'));
}

// ── T12: empty .md file is still counted as present ──────────────────────
{
  const t = makeTmpRoot({
    files: { 'tailored-cv.md': '' }, // empty but exists
  });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T12.1 empty .md file still → has-md (existence, not size)', r.state === 'has-md', r);
  t.cleanup();
}

// ── T13: non-existent pack directory → still classified ──────────────────
{
  const t = makeTmpRoot({ files: {} });
  // Use a slug that doesn't exist in the tmp tree
  const r = detectPolishSource({ root: t.root, packSlug: 'does-not-exist', kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T13.1 non-existent pack → missing-actionable for cv-tailored',
    r.state === 'missing-actionable', r);
  t.cleanup();
}

// ── T14: simulate full polish-loop bug 2 scenario (pdf-only) ─────────────
// Reproduce the exact apply-pack/048-anthropic-engineering-editorial-lead
// state where tailored-cv.pdf exists but tailored-cv.md does not.
{
  const t = makeTmpRoot({
    slug: '048-anthropic-engineering-editorial-lead',
    files: {
      'tailored-cv.pdf': '%PDF-1.4\n...',
      'cover-letter.md': '# Cover Letter',
      'form-fields.md': '# Form Fields',
      'impact-doc.md': '# Impact Doc',
      'references.md': '# References',
      'referrals.md': '# Referrals',
    },
  });
  // cv-tailored: pdf-only (this is the bug)
  const r1 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  check('T14.1 row 048 repro → cv-tailored state=pdf-only', r1.state === 'pdf-only', r1);
  // cover-letter: has-md (this should not block)
  const r2 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cover-letter', srcFile: 'cover-letter.md' });
  check('T14.2 row 048 repro → cover-letter state=has-md', r2.state === 'has-md', r2);
  // impact-doc: has-md (this should not block)
  const r3 = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'impact-doc', srcFile: 'impact-doc.md' });
  check('T14.3 row 048 repro → impact-doc state=has-md', r3.state === 'has-md', r3);
  t.cleanup();
}

// ── T15: actionable suggestion content (regression: don't drift) ─────────
{
  const t = makeTmpRoot({ files: { 'tailored-cv.pdf': 'pdf' } });
  const r = detectPolishSource({ root: t.root, packSlug: t.slug, kind: 'cv-tailored', srcFile: 'tailored-cv.md' });
  // The suggestion text guides the operator. Catch regressions if the
  // copy ever drifts away from naming both the cv-tailor agent + the
  // assemble script.
  check('T15.1 pdf-only suggestion names cv-tailor agent',
    /cv-tailor/.test(r.actionable_suggestion), r);
  check('T15.2 pdf-only suggestion mentions re-running',
    /re-?run|re-?generate/i.test(r.actionable_suggestion), r);
  t.cleanup();
}

// ── Final ────────────────────────────────────────────────────────────────
console.log('');
console.log('polish-cv-tailored-source-detection: ' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  ✗ ' + f.name);
  process.exit(1);
}
process.exit(0);
