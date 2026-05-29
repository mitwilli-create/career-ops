// tests/batch-state-repair-sweep.test.mjs
//
// Tests for lib/batch-state-repair-sweep.mjs — idempotent sweep that marks
// URLs from terminal-errored / terminal-expired Anthropic batches as `[x]`
// in pipeline.md so they don't get re-batched on every Process All run.
//
// Spec: data/spec-process-all-drain-and-visibility-2026-05-29.md § 2 + § 8

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBatchStateRepairSweep } from '../lib/batch-state-repair-sweep.mjs';

function setupFixture() {
  const TMP = join(tmpdir(), 'batch-repair-sweep-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(TMP, { recursive: true });
  return TMP;
}

test('T1 — terminal-errored batch marks unmarked URLs', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, [
    '# pipeline.md',
    '',
    '- [ ] https://job-boards.greenhouse.io/x/jobs/1',
    '- [ ] https://job-boards.greenhouse.io/x/jobs/2',
    '- [x] https://job-boards.greenhouse.io/x/jobs/3',
    '- [ ] https://job-boards.greenhouse.io/x/jobs/4',
    '',
  ].join('\n'));
  writeFileSync(statePath, JSON.stringify({
    batches: [
      {
        id: 'msgbatch_test_1',
        request_counts: { processing: 0, succeeded: 0, errored: 3, expired: 0 },
        requests: [
          { custom_id: 'r1', url: 'https://job-boards.greenhouse.io/x/jobs/1' },
          { custom_id: 'r2', url: 'https://job-boards.greenhouse.io/x/jobs/2' },
          { custom_id: 'r3', url: 'https://job-boards.greenhouse.io/x/jobs/3' },
        ],
      },
    ],
  }));

  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.ok(result.ok, `sweep failed: ${result.error}`);
  assert.equal(result.marked, 2, 'only 2 marked (jobs/1 + jobs/2; jobs/3 already [x])');
  assert.equal(result.batchesScanned, 1);

  const after = readFileSync(pipelinePath, 'utf-8');
  assert.ok(after.includes('- [x] https://job-boards.greenhouse.io/x/jobs/1'), 'jobs/1 marked');
  assert.ok(after.includes('- [x] https://job-boards.greenhouse.io/x/jobs/2'), 'jobs/2 marked');
  assert.ok(after.includes('- [ ] https://job-boards.greenhouse.io/x/jobs/4'), 'jobs/4 still pending (not in batch)');
  assert.ok(after.includes('DEAD-BATCH msgbatch_test_1'), 'audit comment present');

  rmSync(TMP, { recursive: true, force: true });
});

test('T2 — idempotent: second call no-ops (already marked)', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, [
    '- [ ] https://x.com/jobs/A',
    '- [ ] https://x.com/jobs/B',
  ].join('\n'));
  writeFileSync(statePath, JSON.stringify({
    batches: [{
      id: 'msgbatch_idem',
      request_counts: { errored: 2, succeeded: 0, expired: 0 },
      requests: [
        { custom_id: 'rA', url: 'https://x.com/jobs/A' },
        { custom_id: 'rB', url: 'https://x.com/jobs/B' },
      ],
    }],
  }));

  const first = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.equal(first.marked, 2);
  const second = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.equal(second.marked, 0, 'second call must be a no-op');

  // The DEAD-BATCH audit comment must appear exactly once per URL (no double-write)
  const after = readFileSync(pipelinePath, 'utf-8');
  const aCount = (after.match(/jobs\/A.*DEAD-BATCH/g) || []).length;
  assert.ok(aCount <= 1, 'no duplicate DEAD-BATCH comments per URL');

  rmSync(TMP, { recursive: true, force: true });
});

test('T3 — batch with 0 errored is skipped', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, '- [ ] https://x.com/jobs/X\n');
  writeFileSync(statePath, JSON.stringify({
    batches: [{
      id: 'msgbatch_clean',
      request_counts: { errored: 0, succeeded: 1, expired: 0 },
      requests: [{ custom_id: 'rX', url: 'https://x.com/jobs/X' }],
    }],
  }));

  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.equal(result.marked, 0);
  assert.equal(result.batchesScanned, 1);
  const after = readFileSync(pipelinePath, 'utf-8');
  assert.ok(after.includes('- [ ] https://x.com/jobs/X'), 'unchanged');

  rmSync(TMP, { recursive: true, force: true });
});

test('T4 — terminal-expired batch ALSO marks URLs (not just errored)', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, '- [ ] https://x.com/jobs/E\n');
  writeFileSync(statePath, JSON.stringify({
    batches: [{
      id: 'msgbatch_exp',
      request_counts: { errored: 0, succeeded: 0, expired: 1 },
      requests: [{ custom_id: 'rE', url: 'https://x.com/jobs/E' }],
    }],
  }));

  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.equal(result.marked, 1);

  rmSync(TMP, { recursive: true, force: true });
});

test('T5 — malformed batches-api-state.json returns ok:false (does NOT throw)', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, '- [ ] https://x.com/jobs/Y\n');
  writeFileSync(statePath, '{not valid json');

  let threw = false;
  let result;
  try { result = runBatchStateRepairSweep({ pipelinePath, statePath }); }
  catch { threw = true; }
  assert.ok(!threw, 'must not throw');
  assert.ok(!result.ok, 'returns ok:false');
  assert.ok(result.error, 'error message present');

  rmSync(TMP, { recursive: true, force: true });
});

test('T6 — missing state file returns ok:true marked:0 (cold start)', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, '- [ ] https://x.com/jobs/Z\n');
  // Do NOT write statePath
  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.ok(result.ok, 'cold-start ok:true');
  assert.equal(result.marked, 0);
  rmSync(TMP, { recursive: true, force: true });
});

test('T7 — batches map shape (object keyed by id) also handled', () => {
  // batches-api-state.json sometimes has { batches: { id: {...}, id2: {...} } }
  // shape per dashboard-server.mjs's _computeLastBatchSummary handling
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  writeFileSync(pipelinePath, '- [ ] https://x.com/jobs/M\n');
  writeFileSync(statePath, JSON.stringify({
    batches: {
      'msgbatch_obj_shape': {
        id: 'msgbatch_obj_shape',
        request_counts: { errored: 1, succeeded: 0, expired: 0 },
        requests: [{ custom_id: 'rM', url: 'https://x.com/jobs/M' }],
      },
    },
  }));

  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.ok(result.ok);
  assert.equal(result.marked, 1);
  rmSync(TMP, { recursive: true, force: true });
});

test('T8 — preserves trailing newline / does not corrupt unrelated lines', () => {
  const TMP = setupFixture();
  const pipelinePath = join(TMP, 'pipeline.md');
  const statePath = join(TMP, 'batches-api-state.json');
  const original = [
    '# Pipeline header',
    '',
    'Some prose paragraph that should remain.',
    '',
    '- [ ] https://x.com/jobs/keep-prose',
    '- [ ] https://x.com/jobs/mark-me',
    '',
  ].join('\n');
  writeFileSync(pipelinePath, original);
  writeFileSync(statePath, JSON.stringify({
    batches: [{
      id: 'msgbatch_prose',
      request_counts: { errored: 1, succeeded: 0, expired: 0 },
      requests: [{ custom_id: 'r', url: 'https://x.com/jobs/mark-me' }],
    }],
  }));

  const result = runBatchStateRepairSweep({ pipelinePath, statePath });
  assert.ok(result.ok);
  const after = readFileSync(pipelinePath, 'utf-8');
  assert.ok(after.includes('# Pipeline header'), 'header preserved');
  assert.ok(after.includes('Some prose paragraph'), 'prose preserved');
  assert.ok(after.includes('- [ ] https://x.com/jobs/keep-prose'), 'untouched URL preserved');
  assert.ok(after.includes('- [x] https://x.com/jobs/mark-me'), 'targeted URL marked');
  assert.ok(after.endsWith('\n'), 'trailing newline preserved');

  rmSync(TMP, { recursive: true, force: true });
});
