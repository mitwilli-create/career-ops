// Apply-now row enrichment-status reader.
//
// Decides whether a freshly-evaluated apply-now row should display an
// "enriching…" badge while supplementary intel (hm-intel / role-enrichment
// / team-health) is still catching up via scripts/agents/intel-refresh.mjs.
//
// The badge is a calibration signal, NOT a gate — the row always renders
// and Mitchell can still click through. Pattern aligned with
// AGENTS.md § Bug class: confidence-label-annotation-not-gating (worked
// example: surface evidence, don't gate).
//
// Why this exists (Spec 5b-(i), 2026-05-29): apply-now rows that just
// landed via Process All have core eval fields but lack the supplementary
// intel that takes 1-24h to catch up via the intel-refresh scheduler.
// Without a badge, Mitchell perceives "the row has no info" — leading to
// premature "this row is broken" reactions on what's actually a normal
// enrichment lag.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Slots that gate the badge. If any of these are missing or failed, the
// row is "still enriching" regardless of how many other slots succeeded.
// hm-intel = recruiter/HM contact data. role-enrichment = team/projects.
// team-health = health badge intel. The other slots (toxicity, positioning,
// strategy-ceiling, liveness, ats-detection) are useful but not load-bearing
// for the row's headline display.
export const LOAD_BEARING_SLOTS = Object.freeze([
  'hm-intel',
  'role-enrichment',
  'team-health',
]);

/**
 * Decide whether the row should display an "enriching…" badge.
 * Pure function — pass row + parsed intel state, no I/O.
 *
 * Returns:
 *   { enriching: true, reason: 'never-refreshed', missing_slots: [...] }
 *   { enriching: true, reason: 'eval-newer-than-refresh', missing_slots: [...] }
 *   { enriching: true, reason: 'missing-load-bearing-slots', missing_slots: [...] }
 *   { enriching: false, reason: 'all-fresh', missing_slots: [] }
 *   { enriching: false, reason: 'no-row', missing_slots: [] }
 *
 * @param {Object} row — apply-now row with at least {num, eval_date}
 * @param {Object} intelState — parsed data/intel-refresh-state.json
 * @returns {{enriching: boolean, reason: string, missing_slots: string[]}}
 */
export function isRowEnriching(row, intelState) {
  if (!row || row.num == null) {
    return { enriching: false, reason: 'no-row', missing_slots: [] };
  }
  const rowKey = String(row.num);
  const intelRow = intelState && intelState.rows ? intelState.rows[rowKey] : null;

  if (!intelRow) {
    return {
      enriching: true,
      reason: 'never-refreshed',
      missing_slots: [...LOAD_BEARING_SLOTS],
    };
  }

  const slotsDone = new Set(Array.isArray(intelRow.slots_done) ? intelRow.slots_done : []);
  const missingLoadBearing = LOAD_BEARING_SLOTS.filter((s) => !slotsDone.has(s));

  const refreshTs = Date.parse(intelRow.last_refresh || '') || 0;
  const evalTs = parseEvalDate(row.eval_date);

  // If the row was evaluated AFTER the most recent enrichment cycle, the
  // intel surface is necessarily stale relative to the eval — flag it.
  if (refreshTs > 0 && evalTs > 0 && evalTs > refreshTs) {
    return {
      enriching: true,
      reason: 'eval-newer-than-refresh',
      missing_slots: missingLoadBearing,
    };
  }

  if (missingLoadBearing.length > 0) {
    return {
      enriching: true,
      reason: 'missing-load-bearing-slots',
      missing_slots: missingLoadBearing,
    };
  }

  return { enriching: false, reason: 'all-fresh', missing_slots: [] };
}

/**
 * Normalise the row's eval_date (which may be date-only `YYYY-MM-DD` or
 * a full ISO timestamp) to a UTC start-of-day milliseconds value.
 *
 * Date-only values are treated as 00:00 UTC on that date — slightly
 * conservative (an eval written at the END of 2026-05-29 is treated as
 * landing at 00:00 of 2026-05-29 UTC), which favours showing the badge
 * (false positive) over hiding it (false negative). The badge is benign
 * so the bias is intentional.
 */
function parseEvalDate(evalDate) {
  const s = String(evalDate || '').trim();
  if (!s) return 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00Z') || 0;
  return Date.parse(s) || 0;
}

/**
 * Convenience wrapper that loads data/intel-refresh-state.json from disk.
 * Returns an empty-rows scaffold on missing file or parse error.
 */
export function loadIntelRefreshState(repoRoot) {
  try {
    const fp = join(repoRoot, 'data/intel-refresh-state.json');
    if (!existsSync(fp)) return { rows: {}, last_run: null };
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch (_) {
    return { rows: {}, last_run: null };
  }
}
