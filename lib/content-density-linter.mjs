// lib/content-density-linter.mjs
// Content density linter — scans rendered dashboard HTML for paragraphs
// that exceed policy thresholds (see data/content-density-policy-2026-05-22.md).
// Reports WARNINGS only; never fails the build.
//
// Establishd 2026-05-22 in Closure 09 Part 4 (Item G).

const POLICY = {
  MAX_PARAGRAPH_WORDS: 150,
  MAX_SENTENCES_PER_BLOCK: 3,
  MAX_EM_DASHES_PER_PARAGRAPH: 2,
};

const ROBOTIC_PREFIXES = [
  /\bIt is recommended that\b/i,
  /\bPlease be advised\b/i,
  /\bIt would be beneficial to\b/i,
  /\bIn order to\b/i,
  /\bFurthermore,\b/i,
  /\bMoreover,\b/i,
];

/**
 * Lint a chunk of rendered HTML for content density violations.
 *
 * @param {string} html — the rendered HTML to lint
 * @returns {{ paragraphsScanned, violations, byKind }}
 */
export function lintHtml(html) {
  if (!html || typeof html !== 'string') {
    return { paragraphsScanned: 0, violations: [], byKind: {} };
  }
  const violations = [];
  const byKind = {
    long_paragraph: 0,
    too_many_sentences: 0,
    too_many_em_dashes: 0,
    robotic_prefix: 0,
  };

  // Extract paragraph-like blocks. Match <p>, <div class="*prose*">, and
  // <span class="*-text*"> content. Conservative — better to under-report
  // than to false-positive.
  const blockRe = /<(p|div|span)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  let scanned = 0;
  while ((m = blockRe.exec(html)) !== null) {
    const raw = m[2];
    // Strip nested HTML tags to get plain text for word/sentence counting.
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 30) continue;  // skip short/labels
    scanned++;

    // 1. Long paragraph (> MAX_PARAGRAPH_WORDS words)
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > POLICY.MAX_PARAGRAPH_WORDS) {
      violations.push({
        kind: 'long_paragraph',
        word_count: wordCount,
        sample: text.slice(0, 80),
      });
      byKind.long_paragraph++;
    }

    // 2. Too many sentences without a break
    // Heuristic: count . ! ? followed by space + capital letter.
    const sentenceCount = (text.match(/[.!?]\s+[A-Z]/g) || []).length + 1;
    if (sentenceCount > POLICY.MAX_SENTENCES_PER_BLOCK + 2) {
      // +2 buffer since a long flowing paragraph can have 5+ sentences
      // and still be readable; only flag truly egregious cases.
      violations.push({
        kind: 'too_many_sentences',
        sentence_count: sentenceCount,
        sample: text.slice(0, 80),
      });
      byKind.too_many_sentences++;
    }

    // 3. Em-dash density
    const emDashes = (text.match(/—/g) || []).length;
    if (emDashes > POLICY.MAX_EM_DASHES_PER_PARAGRAPH) {
      violations.push({
        kind: 'too_many_em_dashes',
        em_dash_count: emDashes,
        sample: text.slice(0, 80),
      });
      byKind.too_many_em_dashes++;
    }

    // 4. Robotic prefix
    for (const re of ROBOTIC_PREFIXES) {
      if (re.test(text)) {
        violations.push({
          kind: 'robotic_prefix',
          pattern: re.toString(),
          sample: text.slice(0, 80),
        });
        byKind.robotic_prefix++;
        break;
      }
    }
  }

  return { paragraphsScanned: scanned, violations, byKind };
}

/**
 * Format a lint result into a single-line console summary.
 */
export function summarize(result) {
  const v = result.violations.length;
  const s = result.paragraphsScanned;
  if (v === 0) {
    return `✓ Content density: ${s} paragraphs scanned, 0 violations`;
  }
  const bits = [];
  if (result.byKind.long_paragraph)     bits.push(`${result.byKind.long_paragraph} long`);
  if (result.byKind.too_many_sentences) bits.push(`${result.byKind.too_many_sentences} dense`);
  if (result.byKind.too_many_em_dashes) bits.push(`${result.byKind.too_many_em_dashes} em-dash-heavy`);
  if (result.byKind.robotic_prefix)     bits.push(`${result.byKind.robotic_prefix} robotic-prefix`);
  return `⚠ Content density: ${s} paragraphs scanned, ${v} violation${v === 1 ? '' : 's'} (${bits.join(', ')})`;
}
