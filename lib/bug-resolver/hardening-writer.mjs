// lib/bug-resolver/hardening-writer.mjs
//
// Phase 2 V1 — non-destructive hardening guidance handling. The harden phase
// of pipeline.mjs produces a structured suggestion (Mode A = new bug-class
// catalog pattern; Mode B = case study added to an existing pattern). For V1
// safety, we do NOT auto-edit ~/.claude/knowledge/brain/bug-class-catalog.md.
// Instead, we APPEND the suggestion to a pending-review file Mitchell scans
// periodically + manually applies to the catalog if approved.
//
// Phase 3 V2 could add the catalog auto-edit with a separate explicit gate.
//
// Design rationale: the bug-class catalog is the canonical knowledge surface
// for hardening guidance across the system. Auto-edits from an LLM-generated
// suggestion risk pollution that's hard to reverse without human review. The
// per-bug decision doc already preserves the hardening_md verbatim, so no
// information is lost — the pending-review file is just a convenient index.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const PENDING_FILE = join(REPO_ROOT, 'data/bug-resolver-pending-hardening.md');

// Append a hardening suggestion to the pending-review file.
//
// suggestion: {
//   bugId: string,
//   mode: 'A' | 'B',                  // A = new pattern, B = case study
//   target_pattern_slug: string,      // existing slug for B; proposed slug for A
//   markdown_block: string,           // verbatim markdown from the harden phase
// }
//
// Returns: { pendingFilePath, appended: bool }
export function appendHardeningSuggestion(suggestion) {
  if (!suggestion || !suggestion.markdown_block) {
    return { pendingFilePath: PENDING_FILE, appended: false };
  }

  // Ensure parent dir exists (data/ should always exist; defensive)
  try { mkdirSync(dirname(PENDING_FILE), { recursive: true }); } catch {}

  const isNew = !existsSync(PENDING_FILE);
  const header = isNew
    ? `# Bug-resolver — Pending Hardening Guidance\n\n` +
      `Suggestions emitted by the bug-resolver harden phase. Each entry is\n` +
      `non-destructive — Mitchell reviews + manually applies to\n` +
      `\`~/.claude/knowledge/brain/bug-class-catalog.md\` if approved.\n\n` +
      `Format per entry:\n` +
      `- Source bug ID + timestamp + mode (A=new pattern, B=case study)\n` +
      `- Target pattern slug (proposed for A, existing for B)\n` +
      `- The suggested markdown block (verbatim from harden phase)\n\n` +
      `---\n\n`
    : '';

  const ptNow = new Date(Date.now() - 7 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
  const entry = [
    `## ${suggestion.bugId} — ${ptNow}`,
    ``,
    `**Mode:** ${suggestion.mode === 'A' ? 'A (new pattern)' : suggestion.mode === 'B' ? 'B (case study)' : '?'}`,
    `**Target pattern slug:** \`${suggestion.target_pattern_slug || '(unspecified)'}\``,
    ``,
    `### Suggested markdown`,
    ``,
    '```markdown',
    suggestion.markdown_block,
    '```',
    ``,
    `---`,
    ``,
  ].join('\n');

  appendFileSync(PENDING_FILE, header + entry);
  return { pendingFilePath: PENDING_FILE, appended: true };
}

// Convenience format helper for inclusion in decision docs.
// Returns a single markdown string (no file I/O).
export function formatHardeningSection(suggestion) {
  if (!suggestion || !suggestion.markdown_block) {
    return '_No hardening guidance generated for this bug._';
  }
  return [
    `**Mode:** ${suggestion.mode === 'A' ? 'A (new pattern)' : suggestion.mode === 'B' ? 'B (case study)' : '?'}`,
    `**Target pattern slug:** \`${suggestion.target_pattern_slug || '(unspecified)'}\``,
    ``,
    '```markdown',
    suggestion.markdown_block,
    '```',
    ``,
    `_Auto-edit to brain catalog is disabled in Phase 2 V1. Review this suggestion + manually apply to \`~/.claude/knowledge/brain/bug-class-catalog.md\` if approved._`,
  ].join('\n');
}
