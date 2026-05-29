// tests/apply-pack-interview.test.mjs
// Theme 7 PR 3 — tests for pure functions in scripts/agents/apply-pack-interview.mjs
// (state I/O, prompt composition, parsing, q/a grouping, CLI parsing).
// LLM calls (planRevision, reviseArtifact) are not tested live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadInterviewState, saveInterviewState, loadApplyPack,
  composePlanPrompt, parseQuestionPlan,
  composeReviseArtifactPrompt, groupAnswersByArtifact,
  parseArgs,
} from '../scripts/agents/apply-pack-interview.mjs';

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'ap-iview-')); }

// ─── state I/O ───────────────────────────────────────────────────────────────

test('saveInterviewState + loadInterviewState round-trip', () => {
  const root = tmpRoot();
  try {
    const state = { role_slug: 'test', questions: [{ id: 'a' }], answers: { a: 'A' } };
    const path = saveInterviewState('test', state, root);
    assert.ok(path.endsWith('apply-pack-interview-test.json'));
    const reloaded = loadInterviewState('test', root);
    assert.deepEqual(reloaded, state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadInterviewState returns null when missing', () => {
  const root = tmpRoot();
  try {
    assert.equal(loadInterviewState('nonexistent', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadInterviewState returns null on malformed JSON', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/apply-pack-interview-bad.json'), 'not json');
    assert.equal(loadInterviewState('bad', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─── loadApplyPack ───────────────────────────────────────────────────────────

test('loadApplyPack reads md + json artifacts', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'apply-pack/test'), { recursive: true });
    writeFileSync(join(root, 'apply-pack/test/cv-tailored.md'), '# CV\n');
    writeFileSync(join(root, 'apply-pack/test/cover-letter.md'), '# Letter\n');
    writeFileSync(join(root, 'apply-pack/test/form-fields.json'), '{"a":1}');
    writeFileSync(join(root, 'apply-pack/test/binary.png'), 'binary');
    const pack = loadApplyPack('test', root);
    assert.ok(pack);
    assert.ok(pack['cv-tailored']);
    assert.ok(pack['cover-letter']);
    assert.ok(pack['form-fields']);
    assert.ok(!pack['binary']);  // png not included
    assert.equal(pack['cv-tailored'].ext, 'md');
    assert.equal(pack['form-fields'].ext, 'json');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadApplyPack returns null when dir missing', () => {
  const root = tmpRoot();
  try {
    assert.equal(loadApplyPack('nonexistent', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─── composePlanPrompt ───────────────────────────────────────────────────────

const STUB_ROLE = {
  company: 'Anthropic',
  role: 'AI PgM',
  slug: 'anthropic-ai-pgm',
  fit_rationale: 'strong corpus match',
  top_gap: 'no AI safety publication',
  key_corpus_evidence: ['cv.md: 6yr field eng'],
};

const STUB_CORPUS = {
  entries: [
    { source_path: 'cv.md', source_type: 'canonical', content: 'CV content' },
    { source_path: 'modes/_profile.md', source_type: 'profile', content: 'Profile content' },
    { source_path: 'data/hm-intel/anthropic-ai-pgm.json', source_type: 'intel', content: '{"x":1}' },
  ],
};

test('composePlanPrompt includes role, gap, corpus, artifacts', () => {
  const prompt = composePlanPrompt({
    role: STUB_ROLE,
    corpus: STUB_CORPUS,
    applyPack: { 'cv-tailored': {}, 'cover-letter': {} },
  });
  assert.ok(prompt.includes('Anthropic'));
  assert.ok(prompt.includes('AI PgM'));
  assert.ok(prompt.includes('anthropic-ai-pgm'));
  assert.ok(prompt.includes('no AI safety publication'));
  assert.ok(prompt.includes('cv-tailored'));
  assert.ok(prompt.includes('cover-letter'));
  assert.ok(prompt.includes('CV content'));
  assert.ok(prompt.includes('JSON array'));
});

test('composePlanPrompt handles missing role fields gracefully', () => {
  const prompt = composePlanPrompt({
    role: { slug: 'x' },
    corpus: STUB_CORPUS,
    applyPack: {},
  });
  assert.ok(prompt.includes('(unknown)'));
  assert.ok(prompt.includes('(none)'));  // empty artifacts list
});

// ─── parseQuestionPlan ───────────────────────────────────────────────────────

test('parseQuestionPlan parses valid JSON array', () => {
  const text = '[{"id":"lead","artifact":"cover-letter","question":"What metric?","why":"open is weak","example_answer":"9K machines"}]';
  const q = parseQuestionPlan(text);
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'lead');
  assert.equal(q[0].artifact, 'cover-letter');
});

test('parseQuestionPlan strips code fences', () => {
  const text = '```json\n[{"id":"x","artifact":"cv-tailored","question":"q","why":"w","example_answer":"e"}]\n```';
  const q = parseQuestionPlan(text);
  assert.equal(q.length, 1);
});

test('parseQuestionPlan filters questions without question text', () => {
  const text = '[{"id":"a","question":"keep"},{"id":"b","question":""},{"id":"c"}]';
  const q = parseQuestionPlan(text);
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'a');
});

test('parseQuestionPlan defaults missing fields', () => {
  const text = '[{"question":"only have q"}]';
  const q = parseQuestionPlan(text);
  assert.equal(q[0].id, 'q-1');
  assert.equal(q[0].artifact, 'cv-tailored');
});

test('parseQuestionPlan returns empty on malformed input', () => {
  assert.deepEqual(parseQuestionPlan(''), []);
  assert.deepEqual(parseQuestionPlan(null), []);
  assert.deepEqual(parseQuestionPlan('not json'), []);
  assert.deepEqual(parseQuestionPlan('[{broken'), []);
});

// ─── composeReviseArtifactPrompt ─────────────────────────────────────────────

test('composeReviseArtifactPrompt includes role, artifact, current content, qa', () => {
  const qa = [
    { question: 'What metric?', answer: '9K machines' },
    { question: 'Top win?',    answer: 'remote-work shift' },
  ];
  const p = composeReviseArtifactPrompt({
    role: STUB_ROLE,
    artifactName: 'cover-letter',
    currentContent: 'Dear hiring manager,\n\n...',
    qa,
  });
  assert.ok(p.includes('cover-letter'));
  assert.ok(p.includes('Anthropic'));
  assert.ok(p.includes('Dear hiring manager'));
  assert.ok(p.includes('9K machines'));
  assert.ok(p.includes('remote-work shift'));
});

test('composeReviseArtifactPrompt truncates currentContent to 12K chars', () => {
  const p = composeReviseArtifactPrompt({
    role: STUB_ROLE,
    artifactName: 'cv-tailored',
    currentContent: 'z'.repeat(50_000),
    qa: [{ question: 'q', answer: 'a' }],
  });
  const zMatch = p.match(/z+/);
  assert.ok(zMatch);
  assert.equal(zMatch[0].length, 12_000);
});

// ─── groupAnswersByArtifact ──────────────────────────────────────────────────

test('groupAnswersByArtifact groups by artifact + skips empty answers', () => {
  const state = {
    questions: [
      { id: 'a', artifact: 'cv-tailored',  question: 'q1' },
      { id: 'b', artifact: 'cv-tailored',  question: 'q2' },
      { id: 'c', artifact: 'cover-letter', question: 'q3' },
      { id: 'd', artifact: 'cover-letter', question: 'q4' },
    ],
    answers: { a: 'A1', b: '', c: 'A3', d: null },
  };
  const groups = groupAnswersByArtifact(state);
  assert.equal(groups['cv-tailored'].length, 1);
  assert.equal(groups['cv-tailored'][0].id, 'a');
  assert.equal(groups['cover-letter'].length, 1);
  assert.equal(groups['cover-letter'][0].id, 'c');
});

test('groupAnswersByArtifact returns empty when state is malformed', () => {
  assert.deepEqual(groupAnswersByArtifact(null), {});
  assert.deepEqual(groupAnswersByArtifact({}), {});
  assert.deepEqual(groupAnswersByArtifact({ questions: [] }), {});
});

// ─── parseArgs ───────────────────────────────────────────────────────────────

test('parseArgs --plan', () => {
  const a = parseArgs(['--plan', 'test-slug']);
  assert.equal(a.cmd, 'plan');
  assert.equal(a.roleSlug, 'test-slug');
});

test('parseArgs --apply + --dry-run', () => {
  const a = parseArgs(['--apply', 'x', '--dry-run']);
  assert.equal(a.cmd, 'apply');
  assert.equal(a.roleSlug, 'x');
  assert.equal(a.dryRun, true);
});

test('parseArgs --status', () => {
  const a = parseArgs(['--status', 'x']);
  assert.equal(a.cmd, 'status');
});

test('parseArgs no args = no cmd', () => {
  const a = parseArgs([]);
  assert.equal(a.cmd, null);
});
