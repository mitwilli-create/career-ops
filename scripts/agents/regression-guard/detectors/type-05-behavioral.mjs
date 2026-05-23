/**
 * scripts/agents/regression-guard/detectors/type-05-behavioral.mjs
 *
 * Type 5: Behavioral regression (transcript drift) — gated by feature flag.
 *
 * Per dealbreaker § Audit Item 3 — feature flag default OFF for first 30
 * days. Agent still COLLECTS transcript stats during baseline-build phase
 * but does NOT fire findings until REGRESSION_GUARD_TRANSCRIPT_BASELINE_ENABLED=true.
 *
 * Returns aggregate-only stats; never reads transcript content (privacy).
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROJECT_TRANSCRIPTS_DIR, TRANSCRIPT_BASELINE_ON,
} from '../lib/config.mjs';
import { loadBaseline, baselineExpired } from '../lib/baseline-store.mjs';

export function detectType5Behavioral(state) {
  const findings = [];
  if (!TRANSCRIPT_BASELINE_ON) {
    // Per dealbreaker § Audit Item 3 — feature flag default OFF for first 30 days.
    // Agent still COLLECTS transcript stats during baseline-build phase but does NOT fire findings.
    return findings;
  }
  const baseline = loadBaseline('transcript');
  if (baseline && !baselineExpired(baseline)) {
    const prev = baseline.data || {};
    const curr = scanTranscriptStats();
    // Tokens/session shift > 50% is signal
    if (prev.avg_tokens_per_session > 0) {
      const driftPct = ((curr.avg_tokens_per_session - prev.avg_tokens_per_session) / prev.avg_tokens_per_session) * 100;
      if (Math.abs(driftPct) > 50) {
        findings.push({
          type: 5, severity: 'MED', confidence: 'LOW',
          subtype: 'transcript-volume-drift',
          file: '~/.claude/projects/<encoded>/<session>.jsonl',
          summary: `transcript avg tokens/session drifted ${driftPct.toFixed(1)}% (${prev.avg_tokens_per_session} → ${curr.avg_tokens_per_session})`,
          citation: { path: PROJECT_TRANSCRIPTS_DIR, mode: 'summary_only', summary: 'aggregate stats only — no inline content' },
        });
      }
    }
  }
  return findings;
}

export function scanTranscriptStats() {
  // Aggregate-only — never returns content
  const stats = { sessions: 0, total_lines: 0, avg_tokens_per_session: 0 };
  if (!existsSync(PROJECT_TRANSCRIPTS_DIR)) return stats;
  try {
    const entries = readdirSync(PROJECT_TRANSCRIPTS_DIR);
    for (const e of entries) {
      const ep = join(PROJECT_TRANSCRIPTS_DIR, e);
      try {
        const st = statSync(ep);
        if (!st.isFile() || !e.endsWith('.jsonl')) continue;
        // Approximate tokens: bytes / 4. Don't read full content for privacy.
        const approxTokens = Math.floor(st.size / 4);
        stats.sessions += 1;
        stats.total_lines += approxTokens;
      } catch { /* skip */ }
    }
    stats.avg_tokens_per_session = stats.sessions > 0 ? Math.floor(stats.total_lines / stats.sessions) : 0;
  } catch { /* ignore */ }
  return stats;
}
