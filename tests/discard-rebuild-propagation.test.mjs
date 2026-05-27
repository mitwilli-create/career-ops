#!/usr/bin/env node
/**
 * tests/discard-rebuild-propagation.test.mjs
 *
 * Regression guard for the 2026-05-26 write-without-rebuild-propagation-gap
 * bug class (AGENTS.md § bug-class: write-without-rebuild-propagation-gap).
 *
 * The discard / status-change flow has four required layers; this test
 * asserts each one stays wired:
 *
 *   1. Server — updateApplicationStatus() writes applications.md +
 *      apply-now-queue.json AND schedules a dashboard rebuild.
 *   2. Server — updateApplicationStatusBulk() also schedules a rebuild.
 *   3. Server — _scheduleDashboardRebuild() is debounced (500ms) so a bulk
 *      operation collapses to one rebuild, not N.
 *   4. Client — optimisticStatusChange() hides the row from the Apply-Now
 *      table immediately when the new status disqualifies it. Updates the
 *      Refresh-stale badge counter and hides the CTA when count reaches 0.
 *   5. Rollback — if the server status call fails, hidden Apply-Now rows
 *      are restored AND the status badge is reverted.
 *
 * Static analysis only — does not spawn the server or rebuild. Catches the
 * regression at test time before the propagation chain rots.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const dashboardSrc = readFileSync(join(ROOT, 'dashboard-server.mjs'), 'utf8');
const buildSrc     = readFileSync(join(ROOT, 'scripts/build-dashboard.mjs'), 'utf8');

// ─── Layer 1: updateApplicationStatus calls _scheduleDashboardRebuild ───
console.log('\nLayer 1: updateApplicationStatus triggers rebuild');
const updateStatusBlock = dashboardSrc.slice(
  dashboardSrc.indexOf('function updateApplicationStatus({'),
  dashboardSrc.indexOf('function updateApplicationStatusBulk')
);
assert(updateStatusBlock.length > 0,
       'updateApplicationStatus function present in dashboard-server.mjs');
assert(/_scheduleDashboardRebuild\s*\(\s*`status:/.test(updateStatusBlock),
       'updateApplicationStatus calls _scheduleDashboardRebuild on status change');
assert(/if\s*\(\s*oldStatus\s*!==\s*canonical\s*\)\s*\{[\s\S]{0,200}_scheduleDashboardRebuild/.test(updateStatusBlock),
       'rebuild trigger is gated on actual status change (no-op when status unchanged)');

// ─── Layer 2: updateApplicationStatusBulk also triggers rebuild ───
console.log('\nLayer 2: updateApplicationStatusBulk triggers rebuild');
const bulkStatusBlock = dashboardSrc.slice(
  dashboardSrc.indexOf('function updateApplicationStatusBulk'),
  dashboardSrc.indexOf('function updateApplicationStatusBulk') + 5000
);
assert(/_scheduleDashboardRebuild\s*\(\s*`bulk:/.test(bulkStatusBlock),
       'updateApplicationStatusBulk calls _scheduleDashboardRebuild');
assert(/if\s*\(\s*updated\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,200}_scheduleDashboardRebuild/.test(bulkStatusBlock),
       'bulk rebuild trigger is gated on at least one row actually updated');

// ─── Layer 3: _scheduleDashboardRebuild is debounced + best-effort ───
console.log('\nLayer 3: _scheduleDashboardRebuild contract');
assert(/function\s+_scheduleDashboardRebuild\s*\(/.test(dashboardSrc),
       '_scheduleDashboardRebuild function defined');
assert(/let\s+_rebuildDebounceTimer/.test(dashboardSrc),
       'debounce timer state variable exists');
assert(/setTimeout\([\s\S]{20,500}500/.test(dashboardSrc) &&
       /clearTimeout\(_rebuildDebounceTimer\)/.test(dashboardSrc),
       '500ms debounce: setTimeout 500ms + clearTimeout on re-fire');
assert(/_spawn\(['"]node['"]\s*,\s*\[[^\]]*['"]?[^'"]*scripts\/build-dashboard\.mjs['"]?/.test(dashboardSrc) ||
       /_spawn\(['"]node['"]\s*,\s*\[[^\]]*build-dashboard\.mjs/.test(dashboardSrc),
       'rebuild spawns node scripts/build-dashboard.mjs');
const rebuildBlock = dashboardSrc.slice(dashboardSrc.indexOf('function _scheduleDashboardRebuild'),
                                         dashboardSrc.indexOf('function _scheduleDashboardRebuild') + 1800);
assert(/detached:\s*true/.test(rebuildBlock),
       'spawn is detached (parent-server restart does not kill rebuild)');
assert(/proc\.unref\(\)/.test(rebuildBlock),
       'spawned child is unref-ed (parent can exit independently)');
assert(/catch\s*\(\s*err\s*\)\s*\{[\s\S]{0,400}console\.warn[\s\S]{0,400}fswatch/.test(rebuildBlock),
       'spawn failures log warning + fall back to fswatch (best-effort, never throw)');

// ─── Layer 4: client-side optimisticStatusChange hides apply-N rows ───
console.log('\nLayer 4: client-side optimistic Apply-Now hide');
const optStatusBlock = buildSrc.slice(
  buildSrc.indexOf('async function optimisticStatusChange'),
  buildSrc.indexOf('window.optimisticStatusChange = optimisticStatusChange')
);
assert(optStatusBlock.length > 0,
       'optimisticStatusChange function present in build-dashboard.mjs');
assert(/APPLY_NOW_REQUIRED\s*=\s*\[\s*['"]evaluated['"]\s*,\s*['"]responded['"]\s*\]/.test(optStatusBlock),
       'APPLY_NOW_REQUIRED set mirrors the build-time filter (evaluated, responded)');
assert(/willLeaveApplyNow\s*=\s*!APPLY_NOW_REQUIRED\.includes\(newStatusLower\)/.test(optStatusBlock),
       'willLeaveApplyNow is computed from the new status');
assert(/\/\^apply-\/\.test\(rowIdAttr\)/.test(optStatusBlock),
       'only data-row-id starting with apply- is hidden (does not touch All Evals)');
assert(/sh\.tr\.style\.display\s*=\s*['"]none['"]/.test(optStatusBlock),
       'hide via display:none (reversible, not removed from DOM)');

// ─── Layer 4b: client-side stale-row badge sync ───
console.log('\nLayer 4b: Refresh-stale badge auto-decrements on hide');
assert(/window\.__DEEP_REFRESH_STALE_ROWS__\s*=\s*window\.__DEEP_REFRESH_STALE_ROWS__\.filter\(/.test(optStatusBlock),
       'discarded row is filtered out of __DEEP_REFRESH_STALE_ROWS__');
assert(/document\.querySelector\(['"]\.refresh-stale-count['"]\)/.test(optStatusBlock),
       'refresh-stale-count badge selector present');
assert(/badge\.textContent\s*=\s*String\(window\.__DEEP_REFRESH_STALE_ROWS__\.length\)/.test(optStatusBlock),
       'badge text content is updated to new stale-rows length');
assert(/apply-now-refresh-stale[\s\S]{0,300}style\.display\s*=\s*['"]none['"]/.test(optStatusBlock),
       'Refresh-stale CTA button hides itself when count reaches 0');

// ─── Layer 5: rollback restores hidden row on server failure ───
console.log('\nLayer 5: rollback restores hidden row on /api/inline-update failure');
assert(/wasHidden:\s*false/.test(optStatusBlock),
       'snapshot tracks wasHidden flag per row');
assert(/sh\.wasHidden\s*=\s*true/.test(optStatusBlock),
       'wasHidden flag is set when row is hidden');
assert(/catch\s*\([\s\S]{0,800}s3\.wasHidden\s*&&\s*s3\.tr\s*\)\s*s3\.tr\.style\.display\s*=\s*['"]['"]/.test(optStatusBlock),
       'catch-block restores display when wasHidden=true (s3.wasHidden guard present)');

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
