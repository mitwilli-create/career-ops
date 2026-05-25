/**
 * scripts/agents/regression-guard/detectors/type-01-code.mjs
 *
 * Type 1: Code regression (lexical scan for known bug-class patterns).
 *
 * Tuning history (Q1, 2026-05-23): Day-0 trial fired 8 HIGH on the broad
 * heuristic match against safe code in scripts/build-dashboard.mjs. The
 * tuned detector now emits TWO finding subtypes:
 *
 *   - outer-template-unescape-suspect (HIGH, confidence HIGH)
 *     Requires BOTH: backtick delimiter as opener AND an inline-JS context
 *     marker within ~200 chars (<script, function, const, var, let, =>,
 *     addEventListener, dangerouslySetInnerHTML). This is the strong signal
 *     of the Pattern A bug — bare backslash regex inside the OUTER template
 *     literal's inline <script> block. Counts toward top-15 ranking.
 *
 *   - outer-template-unescape-loose (LOW, confidence LOW)
 *     Old broad heuristic — any quote (backtick OR single OR double)
 *     opening followed by /\\[dsw]\\+ inside. Kept for v2 calibration data.
 *     LOW severity sorts to the bottom of top-15 but doesn't block ranking.
 *
 * The canary fixture closure-08-1-outer-template still detects the canonical
 * Pattern A bug via detectCanary() — it sets fx.hasBareRegexInTemplate=true
 * directly; this real-source detector mirrors the shape but checks live code.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly post-Q1-tune.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lib/config.mjs';
import { hashCite } from '../lib/citation-policy.mjs';

export function detectType1Code(state) {
  const findings = [];
  // Pattern A — single-backslash regex inside outer template at build-dashboard.mjs
  const bdPath = join(REPO_ROOT, 'scripts/build-dashboard.mjs');
  if (existsSync(bdPath)) {
    const src = readFileSync(bdPath, 'utf-8');
    const lines = src.split('\n');

    // ── STRICT detector — backtick + inline-JS context marker ────────────
    // Backtick-only delimiter; the OUTER-template-unescape bug class is
    // backtick-specific (single/double quotes don't have the unescape
    // pathology in the same way).
    //
    // 2026-05-25 tune (this session's PR-A): added negative lookbehind
    // `(?<!\\)\\` so the detector REJECTS source where the backslash is
    // already doubled (the safe pattern, e.g. `/\\s+/g` in source which
    // becomes `/\s+/g` at runtime). Previously the detector flagged
    // `r.company.replace(/\\s+/g,'-')` at scripts/build-dashboard.mjs:3772
    // as HIGH suspect — a false positive observed twice in two prior
    // sessions. The lookbehind anchors detection to TRULY single-
    // backslash occurrences (the bug pattern) and skips already-safe code.
    const STRICT_LINE_RE = /`[^`]*\/(?<!\\)\\[dsw]\+/;
    // Inline-JS markers signal we're inside a <script> block or JS function
    // context inside the outer template. Use a generous ~200-char window
    // (handover spec) but expand if needed.
    const INLINE_JS_MARKER_RE = /<script|function\s|const\s|var\s|let\s|=>|addEventListener|dangerouslySetInnerHTML/;
    const STRICT_WINDOW_CHARS = 200;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (STRICT_LINE_RE.test(l)) {
        // Build a ~200-char context window AROUND the match in the FILE
        // (not just the matched line) so we catch markers on adjacent lines.
        const before = lines.slice(0, i).join('\n');
        const offset = before.length + (i > 0 ? 1 : 0);
        const winStart = Math.max(0, offset - STRICT_WINDOW_CHARS);
        const winEnd = Math.min(src.length, offset + l.length + STRICT_WINDOW_CHARS);
        const context = src.slice(winStart, winEnd);
        if (INLINE_JS_MARKER_RE.test(context)) {
          findings.push({
            type: 1,
            severity: 'HIGH',
            confidence: 'HIGH',
            subtype: 'outer-template-unescape-suspect',
            file: 'scripts/build-dashboard.mjs',
            line: i + 1,
            summary: 'Single-backslash regex inside outer template w/ inline-JS context — Pattern A suspect',
            citation: { path: bdPath, mode: 'hash_only', hash: hashCite(l) },
          });
        }
      }
    }

    // ── LOOSE detector — old broad heuristic, LOW severity (v2 calibration data) ──
    // Kept for the calibration window so we can compare strict-vs-loose
    // counts across the 4-Monday window. LOW severity sorts to the bottom
    // of top-15 but doesn't block ranking.
    //
    // 2026-05-25 tune (this session's PR-A): same lookbehind fix as STRICT
    // applied here so the LOOSE detector also skips already-safe doubled-
    // backslash patterns. Without the fix the LOOSE detector fired on every
    // safe `/\\s+/g` etc. site (saturated the LOW bucket). With the fix it
    // only fires on truly single-backslash patterns — useful calibration
    // signal vs. noise.
    const LOOSE_LINE_RE = /[`'"][^`'"]*\/(?<!\\)\\[dsw]\+/;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (LOOSE_LINE_RE.test(l)) {
        // Don't double-emit: skip if STRICT detector already emitted on this line
        if (findings.some(f => f.line === i + 1 && f.subtype === 'outer-template-unescape-suspect')) continue;
        findings.push({
          type: 1,
          severity: 'LOW',
          confidence: 'LOW',
          subtype: 'outer-template-unescape-loose',
          file: 'scripts/build-dashboard.mjs',
          line: i + 1,
          summary: 'Quote-delimited single-backslash regex — broad heuristic, v2 calibration data only',
          citation: { path: bdPath, mode: 'hash_only', hash: hashCite(l) },
        });
      }
    }
  }
  // Pattern: missing AbortSignal in fetch calls under scripts/agents/
  // (this is signal-quality LOW — heuristic; surface as MED only)
  return findings;
}
