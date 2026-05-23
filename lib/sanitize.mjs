// lib/sanitize.mjs — shared sanitization helpers that defeat CodeQL
// `js/incomplete-multi-character-sanitization` / `js/incomplete-sanitization`
// / `js/bad-tag-filter` / `js/double-escaping` patterns.
//
// Canonical home for sanitizers that started life inline in scripts/build-
// dashboard.mjs (stripHtmlTags @ line 2544, exported here in 2026-05-22 fix
// follow-up so other modules can reuse the pattern).
//
// Two helper families:
//
//   1. stripHtmlTags(s) — iterative tag strip until stable. Single-pass
//      `.replace(/<[^>]+>/g, '')` is bypassable by crafted nested input
//      like `<scr<script>ipt>` → after one pass `<script>` survives.
//      stripHtmlTags applies the strip repeatedly + defensively removes
//      lone `<` / `>` survivors. Lossy on legitimate angle-bracketed
//      content; fine for text-derivable use cases (preview snippets,
//      heartbeat archive text extraction, JD plain-text reduction).
//
//   2. stripHtmlForText(s) — like stripHtmlTags but ALSO strips <script>
//      / <style> / <!-- --> blocks INCLUDING their content before the
//      iterative bare-tag pass, then decodes the 5 common HTML entities
//      (&amp; &lt; &gt; &quot; &#39; &nbsp;). Use this when the goal is
//      "give me the readable text content of an HTML document," e.g. JD
//      plain-text reduction in eval-intel-gather + heartbeat-corpus text
//      extraction in voice-drift-monitor.
//
//   3. escapeBackslashAndChar(s, char) — escape-meta-character helper that
//      escapes the BACKSLASH first, then the target meta-character. The
//      common bug is `.replace(/X/g, '\\X')` which leaves a leading
//      backslash in the input unescaped — making the sanitization
//      bypassable. Order matters: backslash MUST be escaped first.
//
// Why centralize: every duplicate inline implementation is a future
// CodeQL alert waiting to happen. Pin one well-tested helper and import.
//
// Established 2026-05-22 (Item #34) to clear 6 open alerts at:
//   - lib/eval-intel-gather.mjs:108        (#93 #94 multi-char)
//   - scripts/agents/voice-drift-monitor.mjs:170-172 (#89 double-escape, #90 bad-tag-filter)
//   - lib/drive-sync.mjs:98                (#96 incomplete-sanitization)
//   - scripts/agents/system-maintainer.mjs:586 (#95 incomplete-sanitization)
//
// Pattern matches PR #74 which fixed alert #97 at build-dashboard.mjs:3300.

/**
 * Iteratively strip HTML tags until the string is stable. Defends against
 * single-pass-bypass injections like `<scr<script>ipt>`.
 *
 * @param {*} s — coerced to string; null/undefined → ''
 * @returns {string} — input with `<...>` removed + lone `<` / `>` stripped
 */
export function stripHtmlTags(s) {
  if (s == null) return '';
  let prev;
  let cur = String(s);
  do {
    prev = cur;
    cur = cur.replace(/<[^>]*>/g, '');
  } while (cur !== prev);
  return cur.replace(/[<>]/g, '');
}

/**
 * Reduce an HTML document to its readable text content:
 *   1. Drop <script> / <style> / <!-- --> blocks INCLUDING their content
 *      (iteratively, so nested or malformed instances can't survive a
 *      single pass — this is the `js/bad-tag-filter` defense).
 *   2. Iteratively strip remaining bare tags via stripHtmlTags.
 *   3. Decode the 5 common HTML entities (in order: &amp; LAST, so we
 *      don't double-decode things like &amp;lt; → < accidentally).
 *      The bug `&` decode is done first in CodeQL's `js/double-escaping`
 *      pattern; we invert the order so &amp; is decoded LAST.
 *
 * @param {*} s — coerced to string; null/undefined → ''
 * @param {object} [opts]
 * @param {boolean} [opts.collapseWhitespace=false] — collapse runs of
 *   whitespace to single space + trim. Useful for downstream char-budgeted
 *   embeddings + caption-style text.
 * @returns {string}
 */
export function stripHtmlForText(s, opts = {}) {
  if (s == null) return '';
  let cur = String(s);

  // Phase 1: drop tag-with-content blocks iteratively. `bad-tag-filter`
  // recognizes that `<style ... ><style>...</style>` requires multiple
  // passes to clean if you do single-tag matches.
  let prev;
  do {
    prev = cur;
    cur = cur
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
  } while (cur !== prev);

  // Phase 2: strip remaining bare tags iteratively.
  cur = stripHtmlTags(cur);

  // Phase 3: decode entities. Order matters — &amp; LAST so we don't
  // double-decode `&amp;lt;` → `<` (which would defeat the strip above).
  cur = cur
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

  if (opts.collapseWhitespace) {
    cur = cur.replace(/\s+/g, ' ').trim();
  }
  return cur;
}

/**
 * Escape a single meta-character + the backslash itself. Defends against
 * the `js/incomplete-sanitization` pattern where `.replace(/X/g, '\\X')`
 * leaves a leading literal backslash in the input un-escaped, allowing
 * `\X` in the input to bypass the sanitizer.
 *
 * Always escape `\` FIRST, then the meta-character, to avoid double-
 * escaping the freshly inserted backslashes.
 *
 * @param {*} s — coerced to string; null/undefined → ''
 * @param {string} char — single meta-character to escape (e.g. "'", "|")
 * @returns {string}
 */
export function escapeBackslashAndChar(s, char) {
  if (s == null) return '';
  if (typeof char !== 'string' || char.length !== 1) {
    throw new TypeError('escapeBackslashAndChar: char must be a single character');
  }
  // Escape the meta-character itself in the regex (in case it's regex-
  // special like `|`, `.`, `*`, etc).
  const escapedForRegex = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(s)
    .replace(/\\/g, '\\\\')                          // \ FIRST
    .replace(new RegExp(escapedForRegex, 'g'), '\\' + char);
}
