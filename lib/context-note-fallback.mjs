/**
 * lib/context-note-fallback.mjs — Degraded-useful context-note fallback chain
 *
 * PR-08 of the apply-now UX overhaul (2026-05-25). Spec:
 *   .claude/audit/apply-now-ux-audit-2026-05-25/strategy.md §3 (R8-R12)
 *   PR-08 brief — Site #8 (context-note degraded path)
 *
 * Replaces the legacy raw-error context-note responses
 *   "(ANTHROPIC_API_KEY missing — context note generation unavailable)"
 *   "(corpus index unavailable: ENOENT)"
 *   "(corpus index returned 0 chunks for this role)"
 *   "(Sonnet synthesis timed out: ...)"
 * with a tiered fallback chain that returns useful skeleton content
 * Mitchell can act on. No raw error stubs, no CLI hints in the output.
 *
 * Tier ordering (caller invokes in order, takes first hit):
 *   Primary  — lib/corpus-index via sqlite-vec (caller's existing path, NOT here)
 *   Tier 1   — cv.md summary/skills/experience sections (top 500 tokens)
 *   Tier 2   — article-digest.md first 300 tokens (skeleton context)
 *   Tier 3   — "Context not available — open Apply pack for details" (final UX-safe fallback)
 *
 * Cross-fork-leak safety: cv.md + article-digest.md ARE personal-data
 * sources (gitignored). The note text returned from this module is rendered
 * INTO the dashboard for Mitchell only (never shipped over a public surface),
 * so verbatim inclusion is acceptable. This module does NOT log or persist
 * the loaded content to disk — only returns it for one-shot render.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const CV_PATH = join(REPO_ROOT, 'cv.md');
const ARTICLE_DIGEST_PATH = join(REPO_ROOT, 'article-digest.md');

// Approximate token budget. ~4 chars/token average for English prose.
const TIER1_CHAR_BUDGET = 500 * 4;
const TIER2_CHAR_BUDGET = 300 * 4;

const FINAL_FALLBACK_NOTE = 'Context not available — open Apply pack for details.';

/**
 * Compose a fallback context-note when the primary corpus-index path fails.
 *
 * @param {object} opts
 * @param {string|number} [opts.rowNum]    — row number (for citation labels)
 * @param {string}        [opts.role]      — target role (informational only)
 * @param {string}        [opts.company]   — target company (informational only)
 * @param {string}        [opts.fallbackTier] — 'tier1' | 'tier2' | 'tier3' (force tier)
 * @returns {{note:string, citations:string[], tier:string, stub:boolean}}
 */
export function composeFallbackContextNote(opts = {}) {
  const forced = opts.fallbackTier || null;

  // Tier 1 — cv.md skeleton (skills + first experience block).
  if (!forced || forced === 'tier1') {
    const t1 = _composeTier1FromCv();
    if (t1.note) return { ...t1, tier: 'tier1' };
  }

  // Tier 2 — article-digest.md first paragraph.
  if (!forced || forced === 'tier1' || forced === 'tier2') {
    const t2 = _composeTier2FromDigest();
    if (t2.note) return { ...t2, tier: 'tier2' };
  }

  // Tier 3 — UX-safe final fallback.
  return {
    note: FINAL_FALLBACK_NOTE,
    citations: [],
    tier: 'tier3',
    stub: true,
  };
}

function _composeTier1FromCv() {
  if (!existsSync(CV_PATH)) return { note: '', citations: [], stub: true };
  let raw;
  try { raw = readFileSync(CV_PATH, 'utf-8'); }
  catch { return { note: '', citations: [], stub: true }; }

  if (!raw || raw.length === 0) return { note: '', citations: [], stub: true };

  // Pull the Summary section + first Skills/Experience block.
  const summary = _extractSection(raw, ['Summary', 'Profile', 'About']);
  const skills = _extractSection(raw, ['Skills', 'Core Skills', 'Technical Skills']);
  const experience = _extractSection(raw, ['Experience', 'Professional Experience', 'Work Experience']);

  // Construct a two-line note in the "Screen for / Lead with" shape.
  // Tier 1 is INFORMATIONAL — does not pretend to be Sonnet synthesis.
  const summaryFirst = (summary || '').split(/\n+/).find(l => l.trim().length > 0) || '';
  const experienceFirst = (experience || '').split(/\n+/).find(l => l.trim().length > 0) || '';

  let note = '';
  const screenFor = (skills || summary || '').slice(0, 90).replace(/\s+/g, ' ').trim();
  const leadWith = (experienceFirst || summaryFirst).slice(0, 120).replace(/\s+/g, ' ').trim();

  if (screenFor) note += `Screen for: ${screenFor}. `;
  if (leadWith) note += `Lead with: ${leadWith}.`;
  note = note.trim();

  if (!note) {
    // Cv.md had no useful sections — fall to the first 240 chars verbatim.
    const text = raw.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
    note = text.slice(0, 240);
  }

  // Hard cap at ~TIER1_CHAR_BUDGET (well under modal width).
  if (note.length > TIER1_CHAR_BUDGET) note = note.slice(0, TIER1_CHAR_BUDGET);

  return note
    ? { note, citations: ['cv.md'], stub: false }
    : { note: '', citations: [], stub: true };
}

function _composeTier2FromDigest() {
  if (!existsSync(ARTICLE_DIGEST_PATH)) return { note: '', citations: [], stub: true };
  let raw;
  try { raw = readFileSync(ARTICLE_DIGEST_PATH, 'utf-8'); }
  catch { return { note: '', citations: [], stub: true }; }

  if (!raw || raw.length === 0) return { note: '', citations: [], stub: true };

  // First non-header paragraph.
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map(p => p.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 30);

  const first = paragraphs[0] || '';
  if (!first) return { note: '', citations: [], stub: true };

  let note = first.slice(0, TIER2_CHAR_BUDGET);
  // Add a "Screen for / Lead with" shape if possible (heuristic — find first sentence).
  const firstSentence = (note.match(/[^.!?]{15,180}[.!?]/) || [note.slice(0, 180)])[0].trim();
  note = `Lead with: ${firstSentence}`;

  return { note, citations: ['article-digest.md'], stub: false };
}

function _extractSection(rawMd, headingCandidates) {
  // Look for `## Heading` or `# Heading` (case-insensitive).
  const lines = rawMd.split(/\n/);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,3}\s+(.+?)\s*$/);
    if (!m) continue;
    const h = m[1].toLowerCase();
    for (const cand of headingCandidates) {
      if (h.indexOf(cand.toLowerCase()) !== -1) { startIdx = i + 1; break; }
    }
    if (startIdx >= 0) break;
  }
  if (startIdx < 0) return '';

  // Read until the next # heading.
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
