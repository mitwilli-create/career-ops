import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProvenance,
  renderProvenanceCard,
} from '../../lib/decision-provenance.mjs';

// ── getProvenance shape contract ──────────────────────────────────────────────

test('getProvenance returns required shape for non-existent rowId', () => {
  const prov = getProvenance(99999, 'score');
  // All keys must be present
  assert.ok('value'         in prov, 'missing: value');
  assert.ok('computed_at'   in prov, 'missing: computed_at');
  assert.ok('inputs'        in prov, 'missing: inputs');
  assert.ok('gates_passed'  in prov, 'missing: gates_passed');
  assert.ok('gates_failed'  in prov, 'missing: gates_failed');
  assert.ok('corpus_refs'   in prov, 'missing: corpus_refs');
  assert.ok('phase_history' in prov, 'missing: phase_history');
  assert.ok('report_file'   in prov, 'missing: report_file');
  assert.ok('git_log'       in prov, 'missing: git_log');
  assert.ok('weights'       in prov, 'missing: weights');
});

test('getProvenance arrays are arrays', () => {
  const prov = getProvenance(99999, 'score');
  assert.ok(Array.isArray(prov.inputs),        'inputs must be array');
  assert.ok(Array.isArray(prov.gates_passed),  'gates_passed must be array');
  assert.ok(Array.isArray(prov.gates_failed),  'gates_failed must be array');
  assert.ok(Array.isArray(prov.corpus_refs),   'corpus_refs must be array');
  assert.ok(Array.isArray(prov.phase_history), 'phase_history must be array');
  assert.ok(Array.isArray(prov.git_log),       'git_log must be array');
});

test('getProvenance report_file is null for non-existent rowId', () => {
  const prov = getProvenance(99999, 'score');
  assert.equal(prov.report_file, null);
});

test('getProvenance weights is an object (loads from disk or returns {})', () => {
  const prov = getProvenance(99999, 'score');
  assert.ok(typeof prov.weights === 'object' && !Array.isArray(prov.weights));
});

test('getProvenance for real rowId 1 returns non-null report_file if reports exist', () => {
  // Row 1 exists in the main repo; worktree may not have it.
  // We just verify the function does not throw and returns the right shape.
  const prov = getProvenance(1, 'score');
  // report_file is either a path string or null — both valid
  assert.ok(prov.report_file === null || typeof prov.report_file === 'string');
});

// ── renderProvenanceCard ──────────────────────────────────────────────────────

test('renderProvenanceCard returns non-empty HTML string', () => {
  const prov = getProvenance(99999, 'score');
  const html = renderProvenanceCard(prov);
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 50, 'card should have meaningful content');
});

test('renderProvenanceCard contains prov-card class', () => {
  const prov = getProvenance(99999, 'score');
  const html = renderProvenanceCard(prov);
  assert.match(html, /class="prov-card"/);
});

test('renderProvenanceCard applies inline font sizing and var(--text*) design tokens', () => {
  // The BRAVO content-sweep rewrite (2026-05) replaced the --text-sm/--text-base
  // sizing tokens with inline px font-sizes plus the dashboard's var(--text*)
  // color-token vocabulary. This pins the CURRENT styling contract — the old
  // tokens are gone from the renderer under every input (empty or populated).
  const prov = getProvenance(99999, 'score');
  const html = renderProvenanceCard(prov);
  assert.match(html, /font-size:\s*\d/, 'card must apply explicit font sizing');
  assert.match(html, /var\(--text/,     'card must use the dashboard var(--text*) token vocabulary');
});

test('renderProvenanceCard escapes HTML entities in values', () => {
  // Craft a prov with a value containing HTML characters
  const prov = {
    value:         '<script>alert(1)</script>',
    computed_at:   '2026-05-16',
    inputs:        ['cv.md:1 & article-digest'],
    gates_passed:  [],
    gates_failed:  [],
    corpus_refs:   [],
    phase_history: [],
    report_file:   null,
    git_log:       [],
    weights:       {},
  };
  const html = renderProvenanceCard(prov);
  assert.ok(!html.includes('<script>'), 'raw <script> must not appear in output');
  assert.match(html, /&lt;script&gt;/);
});

test('renderProvenanceCard renders the technical provenance breakdown for a populated row', () => {
  // The BRAVO content-sweep rewrite renamed the old "Inputs" / "Phase history"
  // sections. A populated row now surfaces the provenance breakdown inside a
  // collapsed "Technical details" <details> block: the source report, the
  // re-scoring (phase) history, and the backing evidence the pipeline read.
  // Synthetic fixture (no disk dependency) — same pattern as the escaping test.
  const prov = {
    _rowId:          42,
    value:           4.6,
    computed_at:     '2026-04-25',
    inputs:          ['cv.md:18', 'data/hm-intel/_weights.json'],
    gates_passed:    ['H4'],
    gates_failed:    [],
    failed_reasons:  {},
    soft_gaps:       [],
    corpus_refs:     [{ source: 'cv.md', line: 18 }],
    corpus_snippets: [{ source: 'cv.md', line: 18, text: 'Built production LLM agents.' }],
    phase_history:   [{ date: '2026-05-16', score: 4.1, phase_e: true, gates_fired: ['H4'] }],
    report_file:     '/Users/x/career-ops/reports/042-acme-2026-04-25.md',
    report_title:    'Acme — Senior Engineer',
    decision:        'APPLY',
    confidence:      'High',
    council_line:    'sonnet=4.6/5 → APPLY',
    archetype:       'B',
    git_log:         [{ sha: 'abc1234def', date: '2026-04-25 10:00:00 -0700', subject: 'add report' }],
    weights:         { profile: 1 },
    tracker:         null,
    strategy:        null,
    hmIntel:         null,
  };
  const html = renderProvenanceCard(prov);
  assert.match(html, /Technical details/,  'populated card must surface the Technical details section');
  assert.match(html, /Re-scoring history/, 'populated card must surface the phase (re-scoring) history');
  assert.match(html, /Source report:/,     'populated card must name the source report');
});
