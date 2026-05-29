// tests/corpus-scanner.test.mjs
// Theme 7 PR 1 — structural tests for lib/corpus-scanner.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanCorpus, summarizeCorpus, categorizeCorpusEntry, SOURCE_TYPES,
} from '../lib/corpus-scanner.mjs';

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'corpus-scan-test-'));
  writeFileSync(join(root, 'cv.md'), '# Mitchell Williams\n\nTest CV content.\n');
  writeFileSync(join(root, 'article-digest.md'), '# Proof Points\n\nAchievement A.\n');
  mkdirSync(join(root, 'data/hm-intel'), { recursive: true });
  writeFileSync(join(root, 'data/hm-intel/anthropic-pgm.json'), '{"company":"anthropic","role":"pgm"}');
  writeFileSync(join(root, 'data/hm-intel/openai-fde.json'), '{"company":"openai","role":"fde"}');
  mkdirSync(join(root, 'apply-pack/test-slug'), { recursive: true });
  writeFileSync(join(root, 'apply-pack/test-slug/cv-tailored.md'), '# Tailored CV\n');
  writeFileSync(join(root, 'apply-pack/test-slug/cover-letter.md'), '# Cover Letter\n');
  return root;
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

test('scanCorpus discovers fixture sources across types', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root });
    assert.ok(result.entries.length >= 6, `expected >=6 entries, got ${result.entries.length}`);
    assert.ok(result.summary.scan_ms >= 0);
    assert.ok(result.summary.total_chars > 0);
    assert.ok(result.summary.scanned_at);
    assert.equal(result.summary.root, root);
  } finally { cleanup(root); }
});

test('scanCorpus filter types=canonical returns only canonical entries', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: 'canonical' });
    assert.ok(result.entries.length > 0);
    for (const e of result.entries) {
      assert.equal(e.source_type, 'canonical');
    }
  } finally { cleanup(root); }
});

test('scanCorpus types=[intel,apply-pack] returns both, excludes others', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: ['intel', 'apply-pack'] });
    const types = new Set(result.entries.map(e => e.source_type));
    assert.ok(types.has('intel'));
    assert.ok(types.has('apply-pack'));
    assert.ok(!types.has('canonical'));
  } finally { cleanup(root); }
});

test('apply-pack entries extract role_slug + artifact from path', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: 'apply-pack' });
    assert.ok(result.entries.length >= 2);
    for (const e of result.entries) {
      assert.equal(e.metadata.role_slug, 'test-slug');
      assert.ok(e.metadata.artifact);
    }
  } finally { cleanup(root); }
});

test('hm-intel entries extract role_slug from filename', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: 'intel' });
    const slugs = result.entries.map(e => e.metadata.role_slug).sort();
    assert.deepEqual(slugs, ['anthropic-pgm', 'openai-fde']);
  } finally { cleanup(root); }
});

test('maxFileChars truncates large files + records the truncation', () => {
  const root = buildFixture();
  try {
    writeFileSync(join(root, 'cv.md'), 'x'.repeat(500_000));
    const result = scanCorpus({ root, maxFileChars: 100_000, types: 'canonical' });
    const cv = result.entries.find(e => e.source_path === 'cv.md');
    assert.ok(cv);
    assert.equal(cv.content.length, 100_000);
    assert.equal(cv._was_truncated, true);
    assert.ok(result.summary.truncated_files.includes('cv.md'));
  } finally { cleanup(root); }
});

test('includeContent=false returns metadata-only entries', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, includeContent: false });
    assert.ok(result.entries.length > 0);
    for (const e of result.entries) {
      assert.equal(e.content, '');
      assert.ok(typeof e.file_size === 'number');
      assert.ok(e.modified_at);
    }
  } finally { cleanup(root); }
});

test('missing sources surface in summary without throwing', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root });
    const missing = result.summary.missing_sources.map(s => s.path);
    assert.ok(missing.includes('modes/_profile.md'));
    assert.ok(missing.includes('config/profile.yml'));
    assert.ok(missing.includes('data/applications.md'));
  } finally { cleanup(root); }
});

test('markdown H1 surfaces as metadata.title', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: 'canonical' });
    const cv = result.entries.find(e => e.source_path === 'cv.md');
    assert.equal(cv.metadata.title, 'Mitchell Williams');
  } finally { cleanup(root); }
});

test('word_count is computed for content entries', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, types: 'canonical' });
    for (const e of result.entries) {
      assert.ok(typeof e.metadata.word_count === 'number');
      assert.ok(e.metadata.word_count >= 0);
    }
  } finally { cleanup(root); }
});

test('summarizeCorpus produces human-readable output', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root });
    const text = summarizeCorpus(result);
    assert.ok(text.includes('Corpus scan:'));
    assert.ok(text.includes('entries'));
    assert.ok(text.includes('canonical'));
  } finally { cleanup(root); }
});

test('SOURCE_TYPES enum exported with expected values', () => {
  assert.ok(Array.isArray(SOURCE_TYPES));
  assert.ok(SOURCE_TYPES.includes('canonical'));
  assert.ok(SOURCE_TYPES.includes('profile'));
  assert.ok(SOURCE_TYPES.includes('apply-pack'));
  assert.ok(SOURCE_TYPES.includes('brain'));
  assert.ok(SOURCE_TYPES.includes('interview-prep'));
});

test('categorizeCorpusEntry returns source_type or unknown', () => {
  assert.equal(categorizeCorpusEntry({ source_type: 'canonical' }), 'canonical');
  assert.equal(categorizeCorpusEntry({}), 'unknown');
  assert.equal(categorizeCorpusEntry(null), 'unknown');
});

test('hit_entry_cap fires when maxEntries < natural entry count', () => {
  const root = buildFixture();
  try {
    const result = scanCorpus({ root, maxEntries: 2 });
    assert.equal(result.entries.length, 2);
    assert.equal(result.summary.hit_entry_cap, true);
  } finally { cleanup(root); }
});

test('default sources registry covers all SOURCE_TYPES', () => {
  const root = mkdtempSync(join(tmpdir(), 'corpus-empty-'));
  try {
    const result = scanCorpus({ root });
    const allMissingTypes = new Set(result.summary.missing_sources.map(m => m.type));
    for (const t of SOURCE_TYPES) {
      assert.ok(allMissingTypes.has(t), `SOURCE_TYPE '${t}' should appear in DEFAULT_SOURCES (missing-sources tally)`);
    }
  } finally { cleanup(root); }
});

test('glob filter only includes matching extensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'corpus-glob-'));
  try {
    mkdirSync(join(root, 'apply-pack/x'), { recursive: true });
    writeFileSync(join(root, 'apply-pack/x/keep.md'), 'keep');
    writeFileSync(join(root, 'apply-pack/x/skip.png'), 'binary');
    writeFileSync(join(root, 'apply-pack/x/keep.json'), '{}');
    const result = scanCorpus({ root, types: 'apply-pack' });
    const exts = new Set(result.entries.map(e => e.ext));
    assert.ok(exts.has('md'));
    assert.ok(exts.has('json'));
    assert.ok(!exts.has('png'));
  } finally { cleanup(root); }
});

test('dotfiles + hidden dirs are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'corpus-dot-'));
  try {
    mkdirSync(join(root, 'apply-pack/x'), { recursive: true });
    mkdirSync(join(root, 'apply-pack/.hidden'), { recursive: true });
    writeFileSync(join(root, 'apply-pack/x/keep.md'), 'keep');
    writeFileSync(join(root, 'apply-pack/x/.hidden.md'), 'skip');
    writeFileSync(join(root, 'apply-pack/.hidden/leak.md'), 'skip');
    const result = scanCorpus({ root, types: 'apply-pack' });
    const paths = result.entries.map(e => e.source_path);
    assert.ok(paths.some(p => p.endsWith('keep.md')));
    assert.ok(!paths.some(p => p.includes('.hidden')));
  } finally { cleanup(root); }
});
