// Unit tests for lib/apply-now-enrichment-status.mjs (Spec 5b-(i)).
//
// Pure function tests — no disk, no Date.now() leakage. Date math uses
// explicit ISO strings so the comparisons are deterministic across DST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRowEnriching,
  LOAD_BEARING_SLOTS,
} from '../lib/apply-now-enrichment-status.mjs';

test('LOAD_BEARING_SLOTS is the canonical 3-slot contract', () => {
  assert.deepEqual([...LOAD_BEARING_SLOTS], ['hm-intel', 'role-enrichment', 'team-health']);
});

test('row never refreshed → enriching:true + all load-bearing slots missing', () => {
  const row = { num: 2587, eval_date: '2026-05-29' };
  const state = { rows: {}, last_run: null };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.equal(r.reason, 'never-refreshed');
  assert.deepEqual(r.missing_slots, ['hm-intel', 'role-enrichment', 'team-health']);
});

test('all load-bearing slots done + refresh recent → enriching:false', () => {
  const row = { num: 2587, eval_date: '2026-05-28' };
  const state = {
    rows: {
      2587: {
        last_refresh: '2026-05-29T09:00:00.000Z',
        slots_done: [
          'hm-intel',
          'role-enrichment',
          'team-health',
          'ats-detection',
          'liveness',
        ],
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, false);
  assert.equal(r.reason, 'all-fresh');
  assert.deepEqual(r.missing_slots, []);
});

test('missing one load-bearing slot (hm-intel) → enriching:true with that slot', () => {
  const row = { num: 2587, eval_date: '2026-05-28' };
  const state = {
    rows: {
      2587: {
        last_refresh: '2026-05-29T09:00:00.000Z',
        slots_done: ['role-enrichment', 'team-health', 'ats-detection'],
        slots_failed: [
          { slot: 'hm-intel', error: 'exit_code=2', attempted_at: '2026-05-29T09:00:00.000Z' },
        ],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.equal(r.reason, 'missing-load-bearing-slots');
  assert.deepEqual(r.missing_slots, ['hm-intel']);
});

test('eval newer than refresh → enriching:true regardless of slot completeness', () => {
  const row = { num: 2587, eval_date: '2026-05-30' };
  const state = {
    rows: {
      2587: {
        last_refresh: '2026-05-29T09:00:00.000Z',
        slots_done: ['hm-intel', 'role-enrichment', 'team-health'],
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.equal(r.reason, 'eval-newer-than-refresh');
});

test('eval date-only treated as 00:00 UTC of that day (conservative bias toward badge)', () => {
  // Row was evaluated on 2026-05-29 (date-only). Refresh ran 2026-05-30 00:00.
  // Refresh is newer → not enriching.
  const row = { num: 100, eval_date: '2026-05-29' };
  const state = {
    rows: {
      100: {
        last_refresh: '2026-05-30T00:00:00.000Z',
        slots_done: ['hm-intel', 'role-enrichment', 'team-health'],
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, false);
});

test('eval date-only AFTER refresh date → enriching (catches the today-eval-overnight-refresh case)', () => {
  // Row evaluated 2026-05-30 (date-only = 00:00 UTC). Refresh ran 2026-05-29.
  // Eval is at start of 30th; refresh was 29th → eval > refresh → enriching.
  const row = { num: 100, eval_date: '2026-05-30' };
  const state = {
    rows: {
      100: {
        last_refresh: '2026-05-29T08:00:00.000Z',
        slots_done: ['hm-intel', 'role-enrichment', 'team-health'],
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.equal(r.reason, 'eval-newer-than-refresh');
});

test('row.num null → enriching:false, reason: no-row', () => {
  const r = isRowEnriching({ num: null, eval_date: '2026-05-29' }, { rows: {} });
  assert.equal(r.enriching, false);
  assert.equal(r.reason, 'no-row');
});

test('row missing entirely → enriching:false', () => {
  const r = isRowEnriching(null, { rows: {} });
  assert.equal(r.enriching, false);
});

test('row not in intel state but state has other rows → enriching (never-refreshed)', () => {
  const row = { num: 999, eval_date: '2026-05-29' };
  const state = {
    rows: { 100: { last_refresh: '2026-05-29T00:00:00.000Z', slots_done: ['hm-intel'] } },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.equal(r.reason, 'never-refreshed');
});

test('row.num supports string OR number (intel state keys are strings)', () => {
  const stateRow = {
    last_refresh: '2026-05-29T09:00:00.000Z',
    slots_done: ['hm-intel', 'role-enrichment', 'team-health'],
    slots_failed: [],
  };
  const state = { rows: { 2587: stateRow } };
  // Number row.num
  assert.equal(isRowEnriching({ num: 2587, eval_date: '2026-05-28' }, state).enriching, false);
  // String row.num
  assert.equal(isRowEnriching({ num: '2587', eval_date: '2026-05-28' }, state).enriching, false);
});

test('intel state with malformed slots_done (not an array) → treated as empty', () => {
  const row = { num: 2587, eval_date: '2026-05-29' };
  const state = {
    rows: {
      2587: {
        last_refresh: '2026-05-29T00:00:00.000Z',
        slots_done: 'not-an-array',
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, true);
  assert.deepEqual(r.missing_slots, ['hm-intel', 'role-enrichment', 'team-health']);
});

test('missing last_refresh + slots all present → not enriching (slots ARE the source of truth)', () => {
  // Edge case: state has the row but no last_refresh timestamp. If all load-bearing
  // slots are done, treat the row as fresh — slot completeness is the load-bearing
  // signal; last_refresh is the optional staleness check.
  const row = { num: 2587, eval_date: '2026-05-29' };
  const state = {
    rows: {
      2587: {
        slots_done: ['hm-intel', 'role-enrichment', 'team-health'],
        slots_failed: [],
      },
    },
  };
  const r = isRowEnriching(row, state);
  assert.equal(r.enriching, false);
});

test('intelState null/undefined → row treated as never-refreshed', () => {
  const row = { num: 2587, eval_date: '2026-05-29' };
  assert.equal(isRowEnriching(row, null).reason, 'never-refreshed');
  assert.equal(isRowEnriching(row, undefined).reason, 'never-refreshed');
  assert.equal(isRowEnriching(row, {}).reason, 'never-refreshed');
});
