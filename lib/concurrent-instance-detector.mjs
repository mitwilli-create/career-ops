// lib/concurrent-instance-detector.mjs
//
// Stable import path for the concurrent-cd-prefix runtime guard. Re-exports
// from the canonical implementation at scripts/lib/concurrent-instance-detector.mjs.
//
// Why this shim exists:
//   The dealbreaker-adjudicated strategy at
//   `.claude/audit/apply-now-ux-audit-2026-05-25/strategy-adjudicated.md` (net-new
//   finding #1, MED) cited `lib/concurrent-instance-detector.mjs` as the
//   mitigation primitive for `concurrent-cd-prefix-orphan` (CLAUDE.md bug class
//   added 2026-05-25). The canonical implementation already exists at
//   `scripts/lib/concurrent-instance-detector.mjs` (per AGENTS.md), so this file
//   is a thin re-export that lets callers import from either path without
//   maintaining two copies.
//
// API: same shape as the canonical implementation. See its header for
// arguments, return shape, environment variable overrides, and the full
// anti-pattern reference doc.

export {
  detectCdPrefixCollision,
  assertNoCdPrefixToMainRepo,
} from '../scripts/lib/concurrent-instance-detector.mjs';
