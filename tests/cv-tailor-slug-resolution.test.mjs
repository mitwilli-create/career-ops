#!/usr/bin/env node
/**
 * tests/cv-tailor-slug-resolution.test.mjs
 *
 * Fixture tests for lib/build-pack-stage-input.mjs — the slug-resolution
 * helper used by /api/build-pack-stage to translate rowId → SubAgentInput.
 *
 * Bug 1 of pre-apply-followup sprint (Worker C, 2026-05-25): /api/build-pack-stage
 * previously wrote to data/apply-packs/000-unknown-unknown/ because the
 * handler passed { pack: { rowId, num: rowId } } to cv-tailor without
 * populating pack.jd.company / pack.jd.role / pack.meta.row_id. The fix
 * resolves rowId → row → SubAgentInput via the helper tested here.
 *
 * No filesystem dependency — every test passes ranked/apps overrides.
 */

import {
  resolveRowToPackInput,
  findRowInQueue,
  findRowInApplications,
  slugify,
} from '../lib/build-pack-stage-input.mjs';
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

// Fixture data — matches the shape of apply-now-queue.json:ranked
const FIXTURE_RANKED = [
  { rank: 1, num: '44', company: 'Anthropic', role: 'Communications Lead, Claude Code', eval_score: 4.7, url: 'https://example.com/44' },
  { rank: 2, num: '1509', company: 'OpenAI', role: 'AI Deployment Engineer — Media Partnerships', eval_score: 4.7 },
  { rank: 3, num: '48', company: 'Anthropic', role: 'Engineering Editorial Lead', eval_score: 4.6 },
  { rank: 4, num: 50, company: 'ElevenLabs', role: 'Communications Manager', eval_score: 4.5 }, // numeric num (rare but possible)
];

// Fixture data — matches the shape of parseApplicationsFile output
const FIXTURE_APPS = [
  { num: 44, company: 'Anthropic', role: 'Communications Lead, Claude Code', score: 4.7, status: 'Evaluated' },
  { num: 200, company: 'Discarded Co', role: 'Some Role', score: 3.0, status: 'Discarded' },
  { num: 999, company: '', role: 'Empty Company Role', score: 4.0, status: 'Evaluated' },
];

// ── T1: slugify matches the known convention ─────────────────────────────
{
  check('T1.1 slugify lowercases', slugify('Anthropic') === 'anthropic');
  check('T1.2 slugify replaces commas', slugify('Communications Lead, Claude Code') === 'communications-lead-claude-code');
  check('T1.3 slugify strips trailing dashes', slugify('Foo, ') === 'foo');
  check('T1.4 slugify handles em-dash', slugify('AI Deployment Engineer — Media Partnerships') === 'ai-deployment-engineer-media-partnerships');
  check('T1.5 slugify handles empty string', slugify('') === '');
  check('T1.6 slugify handles null/undefined', slugify(null) === '' && slugify(undefined) === '');
}

// ── T2: findRowInQueue — basic lookups ─────────────────────────────────────
{
  const r1 = findRowInQueue(FIXTURE_RANKED, 44);
  check('T2.1 findRowInQueue numeric → match', r1 && r1.company === 'Anthropic', r1);

  const r2 = findRowInQueue(FIXTURE_RANKED, '44');
  check('T2.2 findRowInQueue string → match', r2 && r2.company === 'Anthropic', r2);

  const r3 = findRowInQueue(FIXTURE_RANKED, '044');
  check('T2.3 findRowInQueue zero-padded string → match', r3 && r3.company === 'Anthropic', r3);

  const r4 = findRowInQueue(FIXTURE_RANKED, 999);
  check('T2.4 findRowInQueue unknown rowId → null', r4 === null, r4);

  const r5 = findRowInQueue(FIXTURE_RANKED, 50); // numeric num in fixture
  check('T2.5 findRowInQueue when row.num is numeric → match', r5 && r5.company === 'ElevenLabs', r5);

  const r6 = findRowInQueue([], 44);
  check('T2.6 findRowInQueue empty ranked → null', r6 === null);

  const r7 = findRowInQueue(null, 44);
  check('T2.7 findRowInQueue null ranked → null', r7 === null);

  const r8 = findRowInQueue(FIXTURE_RANKED, null);
  check('T2.8 findRowInQueue null rowId → null', r8 === null);
}

// ── T3: findRowInApplications — basic lookups ─────────────────────────────
{
  const r1 = findRowInApplications(FIXTURE_APPS, 44);
  check('T3.1 findRowInApplications numeric → match', r1 && r1.company === 'Anthropic', r1);

  const r2 = findRowInApplications(FIXTURE_APPS, '44');
  check('T3.2 findRowInApplications string → match', r2 && r2.company === 'Anthropic', r2);

  const r3 = findRowInApplications(FIXTURE_APPS, 200);
  check('T3.3 findRowInApplications discarded row → still matched', r3 && r3.status === 'Discarded', r3);

  const r4 = findRowInApplications(FIXTURE_APPS, 50000);
  check('T3.4 findRowInApplications unknown rowId → null', r4 === null);

  const r5 = findRowInApplications([], 44);
  check('T3.5 findRowInApplications empty array → null', r5 === null);

  const r6 = findRowInApplications(null, 44);
  check('T3.6 findRowInApplications null → null', r6 === null);
}

// ── T4: resolveRowToPackInput — happy path via queue ──────────────────────
{
  const r = resolveRowToPackInput(44, { rankedOverride: FIXTURE_RANKED, appsOverride: [] });
  check('T4.1 valid rowId in queue → ok=true', r.ok === true, r);
  check('T4.2 valid rowId → source=apply-now-queue', r.source === 'apply-now-queue', r);
  check('T4.3 valid rowId → slug formatted padded-company-role',
    r.slug === '044-anthropic-communications-lead-claude-code', r);
  check('T4.4 packInput has pack.jd.company', r.packInput?.pack?.jd?.company === 'Anthropic', r);
  check('T4.5 packInput has pack.jd.role', r.packInput?.pack?.jd?.role === 'Communications Lead, Claude Code', r);
  check('T4.6 packInput has pack.meta.row_id (numeric)', r.packInput?.pack?.meta?.row_id === 44, r);
  check('T4.7 packInput has pack.meta.company', r.packInput?.pack?.meta?.company === 'Anthropic', r);
  check('T4.8 packInput has pack.meta.role', r.packInput?.pack?.meta?.role === 'Communications Lead, Claude Code', r);
  check('T4.9 packInput has pack.rowId', r.packInput?.pack?.rowId === 44, r);
  check('T4.10 packInput has pack.num', r.packInput?.pack?.num === 44, r);
  check('T4.11 packInput.jd.url from row.url', r.packInput?.pack?.jd?.url === 'https://example.com/44', r);
}

// ── T5: resolveRowToPackInput — fallback to applications.md ───────────────
{
  // rowId 200 is in apps (Discarded) but NOT in ranked
  const r = resolveRowToPackInput(200, { rankedOverride: FIXTURE_RANKED, appsOverride: FIXTURE_APPS });
  check('T5.1 row in apps only → ok=true', r.ok === true, r);
  check('T5.2 row in apps only → source=applications.md', r.source === 'applications.md', r);
  check('T5.3 row in apps only → slug uses apps data',
    r.slug === '200-discarded-co-some-role', r);
  check('T5.4 packInput from apps has company', r.packInput?.pack?.jd?.company === 'Discarded Co', r);
}

// ── T6: resolveRowToPackInput — not found surface ─────────────────────────
{
  const r = resolveRowToPackInput(99999, { rankedOverride: FIXTURE_RANKED, appsOverride: FIXTURE_APPS });
  check('T6.1 unknown rowId → ok=false', r.ok === false, r);
  check('T6.2 unknown rowId → error mentions not found', /not found/i.test(r.error || ''), r);
  check('T6.3 unknown rowId → no packInput', !r.packInput, r);
  check('T6.4 unknown rowId → no slug', !r.slug, r);
}

// ── T7: resolveRowToPackInput — invalid rowId types ──────────────────────
{
  const r1 = resolveRowToPackInput(null);
  check('T7.1 null rowId → ok=false', r1.ok === false, r1);
  check('T7.2 null rowId → error mentions required', /required/i.test(r1.error || ''), r1);

  const r2 = resolveRowToPackInput(undefined);
  check('T7.3 undefined rowId → ok=false', r2.ok === false, r2);

  const r3 = resolveRowToPackInput('');
  check('T7.4 empty string rowId → ok=false', r3.ok === false, r3);

  const r4 = resolveRowToPackInput('abc');
  check('T7.5 non-numeric rowId → ok=false', r4.ok === false, r4);
  check('T7.6 non-numeric rowId → error mentions numeric', /numeric/i.test(r4.error || ''), r4);

  const r5 = resolveRowToPackInput('44abc');
  check('T7.7 mixed-content rowId → ok=false', r5.ok === false, r5);
}

// ── T8: resolveRowToPackInput — row with missing company/role ────────────
{
  // Fixture row #999 has empty company
  const r = resolveRowToPackInput(999, { rankedOverride: [], appsOverride: FIXTURE_APPS });
  check('T8.1 row with empty company → ok=false', r.ok === false, r);
  check('T8.2 row with empty company → error mentions missing', /missing/i.test(r.error || ''), r);
}

// ── T9: zero-padded rowId handling ────────────────────────────────────────
{
  const r1 = resolveRowToPackInput('044', { rankedOverride: FIXTURE_RANKED, appsOverride: [] });
  check('T9.1 string "044" resolves same as 44', r1.ok === true && r1.slug === '044-anthropic-communications-lead-claude-code', r1);

  const r2 = resolveRowToPackInput('0050', { rankedOverride: FIXTURE_RANKED, appsOverride: [] });
  check('T9.2 string "0050" still finds row.num=50', r2.ok === true && r2.packInput?.pack?.jd?.company === 'ElevenLabs', r2);
}

// ── T10: slug with special chars (em-dash, comma, parens) ─────────────────
{
  // rowId 1509 has "AI Deployment Engineer — Media Partnerships"
  const r = resolveRowToPackInput(1509, { rankedOverride: FIXTURE_RANKED, appsOverride: [] });
  check('T10.1 em-dash slug → not in result',
    r.slug && !r.slug.includes('—'), r);
  check('T10.2 em-dash slug → expected format',
    r.slug === '1509-openai-ai-deployment-engineer-media-partnerships', r);
}

// ── T11: applications.md fallback when queue is empty array ──────────────
{
  const r = resolveRowToPackInput(44, { rankedOverride: [], appsOverride: FIXTURE_APPS });
  check('T11.1 empty queue + apps hit → source=applications.md', r.source === 'applications.md', r);
  check('T11.2 empty queue + apps hit → ok=true', r.ok === true, r);
}

// ── T12: filesystem fallback (no overrides; real disk read) ──────────────
// Uses a tmp ROOT so we don't touch the real repo data.
{
  const TMP_ROOT = join(tmpdir(), 'cv-tailor-slug-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(join(TMP_ROOT, 'data'), { recursive: true });

  // Write a minimal apply-now-queue.json
  writeFileSync(
    join(TMP_ROOT, 'data/apply-now-queue.json'),
    JSON.stringify({
      ranked: [
        { num: '777', company: 'TestCorp', role: 'Test Role', eval_score: 4.5 },
      ],
    }),
    'utf-8',
  );

  const r = resolveRowToPackInput(777, { root: TMP_ROOT });
  check('T12.1 fs-fallback resolves via real read → ok', r.ok === true, r);
  check('T12.2 fs-fallback → correct slug', r.slug === '777-testcorp-test-role', r);

  // Missing rowId in real file
  const r2 = resolveRowToPackInput(2000, { root: TMP_ROOT });
  check('T12.3 fs-fallback unknown rowId → ok=false', r2.ok === false, r2);

  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
}

// ── T13: graceful handling of missing queue file ─────────────────────────
{
  const TMP_ROOT = join(tmpdir(), 'cv-tailor-slug-test-nofile-' + Date.now());
  mkdirSync(join(TMP_ROOT, 'data'), { recursive: true });
  // Do NOT write the queue file
  const r = resolveRowToPackInput(44, { root: TMP_ROOT });
  check('T13.1 missing queue file → falls back gracefully, ok=false', r.ok === false, r);
  check('T13.2 missing queue file → error is actionable', /not found/i.test(r.error || ''), r);
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
}

// ── T14: malformed queue file → fallback to apps gracefully ──────────────
{
  const TMP_ROOT = join(tmpdir(), 'cv-tailor-slug-test-malformed-' + Date.now());
  mkdirSync(join(TMP_ROOT, 'data'), { recursive: true });
  writeFileSync(join(TMP_ROOT, 'data/apply-now-queue.json'), 'not valid json {{{', 'utf-8');
  // Write a minimal applications.md
  writeFileSync(
    join(TMP_ROOT, 'data/applications.md'),
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    '| 44 | 2026-05-25 | Anthropic | Communications Lead | 4.7/5 | Evaluated | ✅ | [44](reports/44.md) | test |\n',
    'utf-8',
  );
  const r = resolveRowToPackInput(44, { root: TMP_ROOT });
  check('T14.1 malformed queue + valid apps → ok=true', r.ok === true, r);
  check('T14.2 malformed queue → source=applications.md', r.source === 'applications.md', r);
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
}

// ── T15: packInput shape stability for cv-tailor consumption ─────────────
// These match scripts/cv-tailor-batch.mjs buildSubAgentInput exactly so
// regression tests catch divergence between the two paths.
{
  const r = resolveRowToPackInput(44, { rankedOverride: FIXTURE_RANKED, appsOverride: [] });
  check('T15.1 packInput.pack.jd is object', typeof r.packInput?.pack?.jd === 'object', r);
  check('T15.2 packInput.pack.meta is object', typeof r.packInput?.pack?.meta === 'object', r);
  check('T15.3 packInput.pack.corpus.cv_path = cv.md',
    r.packInput?.pack?.corpus?.cv_path === 'cv.md', r);
  check('T15.4 packInput.pack.corpus.article_digest_path',
    r.packInput?.pack?.corpus?.article_digest_path === 'article-digest.md', r);
}

// ── Final ────────────────────────────────────────────────────────────────
console.log('');
console.log('cv-tailor-slug-resolution: ' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  ✗ ' + f.name);
  process.exit(1);
}
process.exit(0);
