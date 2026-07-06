// lib/leak-guard.mjs
//
// Cross-fork-leak defense. Citations from sensitive paths MUST be hash_only
// OR summary_only. Inline-quote attempts throw at render time + before any
// external API call.
//
// Extracted from scripts/agents/regression-guard.mjs (2026-05-23) for reuse
// by bug-resolver and any future agent that emits decision docs or sends
// payloads to external vendors.
//
// Spec source: dealbreaker-final § Audit Item 5 (regression-guard delta).
// See: AGENTS.md § Bug class: regression-guard-cross-fork-leak.

import { createHash } from 'node:crypto';

// Path patterns that contain personal data — never inline-quote.
// Add new patterns here when introducing new sensitive surfaces.
export const SENSITIVE_PATH_PATTERNS = [
  // Second Brain personal-truth corpus
  /\/Users\/[^/]+\/Documents\/career-ops\/data\/second-brain-extracted\//,
  // Claude session transcripts + memory
  /\/\.claude\/projects\/[^/]+\/.*\.jsonl$/,
  /\/\.claude\/projects\/[^/]+\/memory\//,
  // Personal pipeline data
  /\/cv\.md$/,
  /\/data\/applications\.md$/,
  /\/data\/hm-intel\//,
  /\/data\/apply-pack[s]?\//,
  // relocation-career-strategy subject profile (identity, comp, relocation plan, political filters)
  /\/data\/relocation-profile\.json$/,
  // relocation strategy briefs (relocation targets, political filters, comp, identity)
  /\/data\/relocation-[^/]*brief[^/]*\.md$/,
  // Bug-resolver outputs (may reference sensitive paths internally)
  /\/data\/bug-ledger\.jsonl$/,
  /\/data\/bug-resolver-reports\//,
];

export function isSensitivePath(p) {
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(p));
}

export function hashCite(content) {
  const h = createHash('sha256').update(String(content)).digest('hex').slice(0, 12);
  return `sha256:${h}`;
}

// Replace PII patterns + truncate. NEVER returns content verbatim.
export function summarizeCite(content, maxChars = 80) {
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
 * quote_inline mode. Call at decision-doc render time + before every
 * external API call.
 *
 * @param {Array<{path: string, mode: string, ...}>} citations
 * @throws Error if any sensitive-path citation has mode 'quote_inline'
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
