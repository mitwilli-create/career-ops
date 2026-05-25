// lib/bug-resolver/unified-queue.mjs
//
// v2 (2026-05-25) — single entry point for bug-resolver's queue I/O across
// both source files (data/bug-ledger.jsonl + data/regression-bug-queue.jsonl).
//
// Pre-v2, bug-resolver.mjs called ledger.mjs::loadLedger + ::updateEntry
// directly. v2 introduces a second queue file (regression-bug-queue.jsonl)
// fed by regression-guard. This module makes both queues look like one
// unified priority queue to the orchestrator:
//
//   - loadUnifiedQueue()   → ledger entries + regression-queue entries
//                            mapped to LedgerEntry shape
//   - updateUnifiedEntry() → routes by id prefix
//                            ("bug-..." → ledger.mjs, "rg-..." → regression-queue.mjs)
//
// The orchestrator's prioritize() / sort-by-severity logic is unchanged —
// it operates on a flat array of LedgerEntry-shaped objects regardless of
// which file they came from.
//
// Spec: data/decisions-pending-regression-auto-action-2026-05-25.md (gitignored)
// Change #1 of 10 in the v2 autonomous-remediation pipeline.

import { loadLedger, updateEntry as updateLedgerEntry } from './ledger.mjs';
import {
  loadPendingRegressionEntries,
  updateRegressionEntry,
  isRegressionQueueId,
} from './regression-queue.mjs';

// Return every OPEN bug from both queues, as a single flat array of
// LedgerEntry-shaped objects ready for prioritize() / sort.
//
// Regression-queue entries are unwrapped: we return their .ledger_shape
// (which IS a LedgerEntry) so the orchestrator can't tell them apart from
// bug-ledger entries. The id prefix (rg- vs bug-) is the only signal —
// and that's what updateUnifiedEntry uses to route writes back correctly.
export function loadUnifiedQueue() {
  const ledgerEntries = loadLedger();
  const regressionEntries = loadPendingRegressionEntries();
  // Unwrap regression entries to their ledger_shape
  const unwrapped = regressionEntries
    .map(r => r.ledger_shape)
    .filter(Boolean);
  return [...ledgerEntries, ...unwrapped];
}

// Atomically update an entry by id. Routes by prefix:
//   - "rg-..."  → data/regression-bug-queue.jsonl
//   - "bug-..." or anything else → data/bug-ledger.jsonl
//
// For regression-queue entries, updates flow through TWO state surfaces:
//   1. The wrapper-level v2_pipeline_state (PENDING / IN_PROGRESS / DRAFT_PR / ...)
//   2. The ledger_shape patch (status / vendor_log / total_cost_usd / ...)
//
// updates supported:
//   - Standard ledger fields (status, vendor_log, total_cost_usd, ...) →
//     applied to ledger_shape via ledger_shape_patch sentinel
//   - v2_pipeline_state → applied to wrapper directly
//
// We translate the orchestrator's bug-resolver-shape updates into the
// wrapper's expected sentinel keys so callers don't have to know the
// internal storage layout.
export function updateUnifiedEntry(id, updates) {
  if (!isRegressionQueueId(id)) {
    // Route to existing ledger.mjs — no shape translation needed
    updateLedgerEntry(id, updates);
    return;
  }

  // Split updates into wrapper-level vs ledger_shape-level
  const wrapperKeys = new Set(['v2_pipeline_state']);
  const wrapperUpdates = {};
  const shapePatch = {};
  for (const [k, v] of Object.entries(updates)) {
    if (wrapperKeys.has(k)) wrapperUpdates[k] = v;
    else shapePatch[k] = v;
  }

  // Auto-derive v2_pipeline_state from the ledger.status field for backward
  // compat — when the orchestrator sets status="DRAFT_PR" on a regression
  // entry, we ALSO advance the wrapper FSM. Caller can still override
  // wrapperUpdates.v2_pipeline_state explicitly.
  if (shapePatch.status === 'DRAFT_PR' && !wrapperUpdates.v2_pipeline_state) {
    wrapperUpdates.v2_pipeline_state = 'DRAFT_PR';
  } else if (shapePatch.status === 'IN_PROGRESS' && !wrapperUpdates.v2_pipeline_state) {
    wrapperUpdates.v2_pipeline_state = 'IN_PROGRESS';
  } else if (shapePatch.status === 'NEEDS_HUMAN' && !wrapperUpdates.v2_pipeline_state) {
    // NEEDS_HUMAN doesn't fit the FSM cleanly — keep wrapper at PENDING so
    // future regression-guard runs can pick it up again, OR a human can
    // manually flip the wrapper to REVERTED. For now, leave wrapper alone.
  }

  const finalUpdates = { ...wrapperUpdates };
  if (Object.keys(shapePatch).length > 0) {
    finalUpdates.ledger_shape_patch = shapePatch;
  }

  updateRegressionEntry(id, finalUpdates);
}

// Convenience: tell the caller which file an id lives in. Useful for
// log lines + dashboard panels.
export function entrySource(id) {
  return isRegressionQueueId(id) ? 'regression-queue' : 'bug-ledger';
}
