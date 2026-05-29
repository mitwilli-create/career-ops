// tests/position-ranker.test.mjs
// Theme 7 PR 2 — tests for pure functions in scripts/agents/position-ranker.mjs
// (loadRoles, composePrompt, parseRanking, parseArgs). LLM call is not tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRoles, composePrompt, parseRanking, parseArgs,
} from '../scripts/agents/position-ranker.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pos-rank-'));
}

// loadRoles ─────────────────────────────────────────────────────────────────

test('loadRoles returns roles from apply-now-queue.json', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-now-queue.json'), JSON.stringify({
      ranked: [
        { num: 1, role: 'PgM', company: 'Anthropic', score: 4.5 },
        { num: 2, role: 'FDE', company: 'OpenAI',    score: 4.2 },
      ],
    }));
    const roles = loadRoles({ root });
    assert.equal(roles.length, 2);
    assert.equal(roles[0].company, 'Anthropic');
    assert.equal(roles[0].role, 'PgM');
    assert.equal(roles[0].score, 4.5);
    assert.ok(roles[0].slug);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadRoles respects top N limit', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-now-queue.json'), JSON.stringify({
      ranked: Array(20).fill(0).map((_, i) => ({
        num: i + 1, role: `R${i}`, company: `C${i}`, score: 5 - i * 0.1,
      })),
    }));
    const roles = loadRoles({ root, top: 5 });
    assert.equal(roles.length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadRoles returns empty when source file missing', () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(loadRoles({ root }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadRoles returns empty on malformed JSON', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-now-queue.json'), 'not json');
    assert.deepEqual(loadRoles({ root }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadRoles falls back to "roles" key when "ranked" missing', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-now-queue.json'), JSON.stringify({
      roles: [{ num: 1, role: 'X', company: 'Y', score: 4 }],
    }));
    const roles = loadRoles({ root });
    assert.equal(roles.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadRoles generates slug when not provided', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-now-queue.json'), JSON.stringify({
      ranked: [{ num: 99, role: 'X', company: 'Cool Company Inc', score: 4 }],
    }));
    const roles = loadRoles({ root });
    assert.equal(roles[0].slug, '99-cool-company-inc');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// composePrompt ──────────────────────────────────────────────────────────────

const STUB_CORPUS = {
  entries: [
    { source_path: 'cv.md', source_type: 'canonical', content: 'CV content here' },
    { source_path: 'article-digest.md', source_type: 'canonical', content: 'Proof points' },
  ],
  summary: {
    total_entries: 2, total_chars: 30,
    by_type: { canonical: 2 },
    missing_sources: [], truncated_files: [],
    scan_ms: 5, scanned_at: '2026-05-29T00:00:00Z', root: '/x',
  },
};

test('composePrompt produces prompt with all role + corpus info', () => {
  const roles = [
    { company: 'Anthropic', role: 'PgM', score: 4.5 },
    { company: 'OpenAI',    role: 'FDE', score: 4.2 },
  ];
  const prompt = composePrompt({ corpus: STUB_CORPUS, roles });
  assert.ok(prompt.includes('Anthropic'));
  assert.ok(prompt.includes('OpenAI'));
  assert.ok(prompt.includes('PgM'));
  assert.ok(prompt.includes('FDE'));
  assert.ok(prompt.includes('CV content here'));
  assert.ok(prompt.includes('Rank these roles'));
  assert.ok(prompt.includes('JSON array'));
});

test('composePrompt handles roles with missing score', () => {
  const prompt = composePrompt({
    corpus: STUB_CORPUS,
    roles: [{ company: 'X', role: 'Y' }],  // no score
  });
  assert.ok(prompt.includes('n/a'));  // score fallback
});

test('composePrompt truncates inline entries to 8000 chars each', () => {
  const huge = { entries: [
    { source_path: 'big.md', source_type: 'canonical', content: 'z'.repeat(50_000) },
  ], summary: { total_entries: 1, total_chars: 50_000, by_type: { canonical: 1 }, missing_sources: [], truncated_files: [], scan_ms: 1, scanned_at: 'x', root: '/x' } };
  const prompt = composePrompt({ corpus: huge, roles: [{ company: 'A', role: 'B', score: 3 }] });
  // The 'z' string in the prompt should be exactly 8000 chars (not 50K)
  const zMatch = prompt.match(/z+/);
  assert.ok(zMatch);
  assert.equal(zMatch[0].length, 8000);
});

// parseRanking ──────────────────────────────────────────────────────────────

test('parseRanking handles clean JSON array', () => {
  const text = '[{"rank":1,"role_idx":1,"company":"Anthropic","role":"PgM","fit_rationale":"good","key_corpus_evidence":["cv:x"],"top_gap":"none"}]';
  const r = parseRanking(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].company, 'Anthropic');
  assert.equal(r[0].rank, 1);
});

test('parseRanking handles code-fenced JSON', () => {
  const text = '```json\n[{"rank":1,"role_idx":1,"company":"A","role":"R","fit_rationale":"x","key_corpus_evidence":[],"top_gap":""}]\n```';
  const r = parseRanking(text);
  assert.equal(r.length, 1);
});

test('parseRanking handles preamble + JSON', () => {
  const text = 'Here is the ranking:\n\n[{"rank":1,"role_idx":1,"company":"A","role":"R","fit_rationale":"x","key_corpus_evidence":[],"top_gap":""}]\n\nDone.';
  const r = parseRanking(text);
  assert.equal(r.length, 1);
});

test('parseRanking returns empty on malformed JSON', () => {
  assert.deepEqual(parseRanking('not json'), []);
  assert.deepEqual(parseRanking('[{broken'), []);
  assert.deepEqual(parseRanking(''), []);
  assert.deepEqual(parseRanking(null), []);
  assert.deepEqual(parseRanking(undefined), []);
});

test('parseRanking sorts by rank ascending', () => {
  const text = JSON.stringify([
    { rank: 3, role_idx: 3, company: 'C', role: 'R', fit_rationale: '', key_corpus_evidence: [], top_gap: '' },
    { rank: 1, role_idx: 1, company: 'A', role: 'R', fit_rationale: '', key_corpus_evidence: [], top_gap: '' },
    { rank: 2, role_idx: 2, company: 'B', role: 'R', fit_rationale: '', key_corpus_evidence: [], top_gap: '' },
  ]);
  const r = parseRanking(text);
  assert.deepEqual(r.map(x => x.company), ['A', 'B', 'C']);
});

test('parseRanking coerces missing fields with safe defaults', () => {
  const text = '[{"rank":1,"company":"A"}]';
  const r = parseRanking(text);
  assert.equal(r[0].role, '');
  assert.equal(r[0].fit_rationale, '');
  assert.deepEqual(r[0].key_corpus_evidence, []);
  assert.equal(r[0].top_gap, '');
});

test('parseRanking handles non-array JSON', () => {
  assert.deepEqual(parseRanking('{"not": "array"}'), []);
});

// parseArgs ──────────────────────────────────────────────────────────────────

test('parseArgs defaults', () => {
  const a = parseArgs([]);
  assert.equal(a.top, 20);
  assert.equal(a.output, null);
  assert.equal(a.dryRun, false);
  assert.equal(a.rolesFrom, 'apply-now-queue');
  assert.equal(a.print, false);
});

test('parseArgs --top + --output + --dry-run + --print', () => {
  const a = parseArgs(['--top', '5', '--output', '/tmp/out.json', '--dry-run', '--print']);
  assert.equal(a.top, 5);
  assert.equal(a.output, '/tmp/out.json');
  assert.equal(a.dryRun, true);
  assert.equal(a.print, true);
});

test('parseArgs --no-call alias works', () => {
  const a = parseArgs(['--no-call']);
  assert.equal(a.dryRun, true);
});

test('parseArgs --roles-from override', () => {
  const a = parseArgs(['--roles-from', 'apply-now-queue']);
  assert.equal(a.rolesFrom, 'apply-now-queue');
});
