/**
 * scripts/agents/regression-guard/lib/citation-policy.mjs
 *
 * Cross-fork-leak defense. All citations from sensitive paths MUST be
 * hash_only OR summary_only. quote_inline from any sensitive path throws
 * at render time + fails the run.
 *
 * Spec source: dealbreaker-final § Audit Item 5 — build-time guard.
 * See AGENTS.md § Bug class: regression-guard-cross-fork-leak.
 *
 * Extracted from the v1.0 monolith during the Q5 lib-split (2026-05-23).
 * Behavior preserved exactly — same SENSITIVE_PATH_PATTERNS list,
 * same hashCite/summarizeCite output, same assertion error message.
 */

import { createHash } from 'node:crypto';

// ─── Cross-fork-leak: sensitive-path citation policy ────────────────────────
//
// ANY citation from a sensitive path MUST be hash_only OR summary_only.
// quote_inline from any of these paths throws at render time + fails the run.
export const SENSITIVE_PATH_PATTERNS = [
  // Second Brain personal-truth corpus
  /\/Users\/[^/]+\/Documents\/career-ops\/data\/second-brain-extracted\//,
  // Claude session transcripts
  /\/\.claude\/projects\/[^/]+\/.*\.jsonl$/,
  /\/\.claude\/projects\/[^/]+\/memory\//,
  // Anything cv.md, applications.md, hm-intel, apply-pack — personal pipeline data
  /\/cv\.md$/,
  /\/data\/applications\.md$/,
  /\/data\/hm-intel\//,
  /\/data\/apply-pack[s]?\//,
  // Persona-system ledgers (added 2026-05-28 with persona-system Wave 1).
  // The findings ledger contains bug-class severity + file paths the personas
  // cite — potentially quoting sensitive-path code. The spend ledger contains
  // persona names + phases that infer codebase architecture. Both gitignored;
  // both must be hash_only OR summary_only when referenced in PR descriptions
  // / reports / commit messages.
  /\/data\/persona-findings\.jsonl$/,
  /\/data\/persona-review-spend\.jsonl$/,
  // Monthly review reports — aggregate persona finding samples
  /\/data\/persona-monthly-review-[\d-]+\.md$/,
];

export function isSensitivePath(p) {
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(p));
}

export function hashCite(content) {
  const h = createHash('sha256').update(String(content)).digest('hex').slice(0, 12);
  return `sha256:${h}`;
}

export function summarizeCite(content, maxChars = 80) {
  // Replace specific PII patterns + truncate. NEVER returns content verbatim.
  let s = String(content)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '<phone>')
    .replace(/sk-[A-Za-z0-9_-]+/g, '<api-key>')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars - 1) + '…';
  return s;
}

/**
 * Build-time guard. Throws if any citation from a sensitive path is in
 * quote_inline mode. Called at decision-doc render time.
 */
export function assertNoInlineQuotesFromSensitivePaths(citations) {
  const violations = [];
  for (const cite of citations) {
    if (!cite || !cite.path) continue;
    if (isSensitivePath(cite.path) && cite.mode === 'quote_inline') {
      violations.push(cite.path);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `CITATION-POLICY VIOLATION: ${violations.length} inline quote(s) from sensitive paths:\n` +
      violations.map(p => '  - ' + p).join('\n') +
      `\nUse hashCite() or summarizeCite() instead. ` +
      `See AGENTS.md § Bug class: regression-guard-cross-fork-leak.`
    );
  }
}
