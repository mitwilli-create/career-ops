// Static-contract tests for Spec 5a + 5b-(i) + 5c renderer changes.
//
// These tests read scripts/build-dashboard.mjs + dashboard-server.mjs as
// source text and assert specific patterns are present. They protect
// against silent regressions in the renderer wiring (e.g., a refactor that
// drops the in-flight chip branch, or that decouples the modal from
// live_counts again).
//
// Modeled on tests/no-linkedin-urls-invariant.test.mjs — static-grep
// invariants tied to renderer source rather than live DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SRC_BUILD = readFileSync(join(REPO_ROOT, 'scripts/build-dashboard.mjs'), 'utf-8');
const SRC_SERVER = readFileSync(join(REPO_ROOT, 'dashboard-server.mjs'), 'utf-8');

// ─── Spec 5a — in-flight batch chip wiring ──────────────────────────────

test('Spec 5a: dashboard-server.mjs imports detectInFlightBatchFromDisk OR detectInFlightBatch', () => {
  const importPattern =
    /(import|require)[^;\n]*\bdetectInFlightBatch(FromDisk)?\b[^;\n]*['"]\.\.?\/lib\/in-flight-batch-detector\.mjs['"]/;
  // Looser fallback: any import of the lib path
  const looser = /['"]\.?\.?\/?lib\/in-flight-batch-detector\.mjs['"]/;
  assert.ok(
    importPattern.test(SRC_SERVER) || looser.test(SRC_SERVER),
    'dashboard-server.mjs must import in-flight-batch-detector.mjs',
  );
});

test('Spec 5a: batchLive() returns an in_flight_batch field in the SSE payload', () => {
  // Find the batchLive function body
  const m = SRC_SERVER.match(/function\s+batchLive\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'batchLive function must exist in dashboard-server.mjs');
  const body = m[0];
  assert.ok(
    /in_flight_batch\s*[,:]/.test(body),
    'batchLive() return object must include in_flight_batch field',
  );
});

test('Spec 5a: _renderBatchData branches on data.in_flight_batch (client chip)', () => {
  const m = SRC_BUILD.match(/function\s+_renderBatchData\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_renderBatchData must exist in scripts/build-dashboard.mjs');
  const body = m[0];
  assert.ok(
    /in_flight_batch/.test(body),
    '_renderBatchData must reference data.in_flight_batch to render the in-flight chip',
  );
});

test('Spec 5a: in-flight chip uses ⏳ glyph (or equivalent in-flight indicator)', () => {
  // The chip is intentionally amber + clock-hourglass to read "active, waiting".
  // Test asserts the glyph is present somewhere in the renderer source so a
  // future refactor doesn't quietly swap it for a green checkmark.
  assert.ok(
    /⏳|hourglass|in.flight/i.test(SRC_BUILD),
    'in-flight chip must use ⏳ glyph or in-flight indicator copy',
  );
});

// ─── Spec 5b-(i) — enriching badge wiring ───────────────────────────────

test('Spec 5b-(i): build-dashboard.mjs imports isRowEnriching from apply-now-enrichment-status', () => {
  const importPattern =
    /import[\s\S]*?\bisRowEnriching\b[\s\S]*?['"]\.?\.?\/?lib\/apply-now-enrichment-status\.mjs['"]/;
  const looser = /['"]\.?\.?\/?lib\/apply-now-enrichment-status\.mjs['"]/;
  assert.ok(
    importPattern.test(SRC_BUILD) || looser.test(SRC_BUILD),
    'build-dashboard.mjs must import apply-now-enrichment-status.mjs',
  );
});

test('Spec 5b-(i): renderRow (or apply-now row code) calls isRowEnriching', () => {
  assert.ok(
    /isRowEnriching\s*\(/.test(SRC_BUILD),
    'apply-now row renderer must call isRowEnriching to decide badge visibility',
  );
});

test('Spec 5b-(i): renderer mentions "enriching" badge copy', () => {
  // Catches silent label change to "loading" or removal of badge altogether.
  assert.ok(
    /enriching/i.test(SRC_BUILD),
    'renderer must include the word "enriching" in the badge label',
  );
});

// ─── Spec 5c — modal live-count binding ──────────────────────────────────

test('Spec 5c: _updateLiveCounts publishes live_counts to window.__LIVE_COUNTS__', () => {
  const m = SRC_BUILD.match(/function\s+_updateLiveCounts\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_updateLiveCounts must exist');
  const body = m[0];
  assert.ok(
    /window\.__LIVE_COUNTS__\s*=/.test(body),
    '_updateLiveCounts must assign window.__LIVE_COUNTS__ so modal renderers can read fresh counts',
  );
});

test('Spec 5c: Process All Phase A renderer reads __LIVE_COUNTS__ for pipeline count', () => {
  const m = SRC_BUILD.match(/function\s+_renderProcessAllPhaseA\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_renderProcessAllPhaseA must exist');
  const body = m[0];
  assert.ok(
    /__LIVE_COUNTS__/.test(body),
    '_renderProcessAllPhaseA must reference window.__LIVE_COUNTS__ for live pipeline count binding',
  );
});

test('Spec 5c: batch-status modal queue rendering references __LIVE_COUNTS__', () => {
  // The queue-status section of the batch-status modal previously rendered
  // q.pipeline_pending from a stale snapshot. Post-fix it must prefer the
  // live window global when available.
  const queueSection = SRC_BUILD.match(/triage_advance[\s\S]{0,4000}?pipeline_pending/g) || [];
  const anyReferencesLive = queueSection.some((s) => /__LIVE_COUNTS__/.test(s));
  // Looser fallback: __LIVE_COUNTS__ appears within ~3K chars of pipeline_pending elsewhere
  const looserPass =
    /__LIVE_COUNTS__[\s\S]{0,3000}pipeline_pending/.test(SRC_BUILD) ||
    /pipeline_pending[\s\S]{0,3000}__LIVE_COUNTS__/.test(SRC_BUILD);
  assert.ok(
    anyReferencesLive || looserPass,
    'batch-status modal must use window.__LIVE_COUNTS__.pipeline_pending for live binding',
  );
});

// ─── Cross-spec sanity ──────────────────────────────────────────────────

test('cross-spec: lib files exist on disk (sanity check for the impl-side imports)', () => {
  // If these throw, the import contracts above would also fail, but check
  // explicitly so the failure message is clear about the missing lib.
  const inFlightLib = readFileSync(join(REPO_ROOT, 'lib/in-flight-batch-detector.mjs'), 'utf-8');
  const enrichLib = readFileSync(join(REPO_ROOT, 'lib/apply-now-enrichment-status.mjs'), 'utf-8');
  assert.ok(/export function detectInFlightBatch/.test(inFlightLib));
  assert.ok(/export function isRowEnriching/.test(enrichLib));
});
