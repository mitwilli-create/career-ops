/**
 * lib/jd-coverage-check.mjs — JD scrape coverage gate.
 *
 * Problem: when scrape returns the SPA shell (~5,500 chars of CSS/JS
 * boilerplate + Cloudflare challenge script), the LLM evaluator obediently
 * tries to score the role anyway, then admits low confidence in a footnote.
 * That's the wrong failure mode — we want the pipeline to FAIL FAST and
 * auto-requeue rather than emit confidently-low-quality evals.
 *
 * This module inspects scraped JD text and decides:
 *   - GOOD:  the scrape captured a real JD (sufficient prose + canonical sections)
 *   - WEAK:  some real content, but missing critical sections — proceed with caveat
 *   - FAIL:  the scrape captured shell HTML, a Cloudflare challenge, or login wall
 *
 * The verdict is the gate: phase3b-evaluator.mjs treats FAIL as JD_SCRAPE_FAILED
 * (no LLM call, auto-queue for re-scrape via Playwright).
 *
 * No I/O. No LLM calls. Pure heuristics over the scraped text.
 */

// Canonical JD sections we look for. Matching is case-insensitive + tolerates
// HTML/markdown formatting around the label. Most ATSes use at least 3 of these.
const CANONICAL_SECTIONS = [
  { key: 'responsibilities', pats: [/\bresponsibilities\b/i, /\bwhat you'?ll do\b/i, /\bday[- ]to[- ]day\b/i, /\bthe role\b/i, /\babout the role\b/i] },
  { key: 'requirements',     pats: [/\brequirements\b/i, /\bmust[- ]haves?\b/i, /\bwhat we'?re looking for\b/i, /\bwhat you bring\b/i, /\bideal candidate\b/i] },
  { key: 'qualifications',   pats: [/\bqualifications\b/i, /\bexperience\b.{0,40}\brequired\b/i, /\byears? of experience\b/i, /\bpreferred\b.{0,40}\b(?:skills|qualifications)\b/i] },
  { key: 'about',            pats: [/\babout (?:us|the company|\w+)\b/i, /\bour mission\b/i, /\bcompany description\b/i, /\bwho we are\b/i] },
  { key: 'comp',             pats: [/\bcompensation\b/i, /\bsalary\b/i, /\bpay (?:range|band|transparency)\b/i, /\$\d{2,3}[,.]?\d{3}\b/, /\bbase (?:pay|salary)\b/i, /\btotal (?:comp|compensation)\b/i] },
  { key: 'location',         pats: [/\blocation\b/i, /\bremote\b/i, /\bhybrid\b/i, /\bon[- ]site\b/i, /\bin[- ]office\b/i, /\b(?:san francisco|new york|seattle|london|nyc|sf)\b/i] },
];

// Patterns that strongly signal the scrape captured shell HTML / a Cloudflare
// challenge / a login wall rather than a real JD. ANY match → FAIL verdict.
const SHELL_PATTERNS = [
  /just a moment\.{3}/i,
  /cf[- ]chl[- ]opt/i,
  /cloudflare/i,
  /challenge-platform/i,
  /__NEXT_DATA__/, // Next.js shell without hydrated content
  /<noscript>\s*you need to enable javascript/i,
  /please enable javascript/i,
  /sign in to view this job/i,
  /<title>\s*loading\.\.\.?\s*<\/title>/i,
];

// Boilerplate phrases common in ATS chrome (footer, equal-opportunity text,
// share buttons, etc.) — strip from word count so we measure JD-specific
// prose, not generic site furniture.
const BOILERPLATE_PHRASES = [
  /equal opportunity employer/gi,
  /background check/gi,
  /e-verify/gi,
  /click apply/gi,
  /apply now/gi,
  /share this (?:job|opening|role)/gi,
  /powered by (?:greenhouse|lever|workable|ashby|workday|smartrecruiters|jobvite|icims)/gi,
  /privacy policy/gi,
  /terms (?:of service|and conditions)/gi,
  /accept (?:cookies|all)/gi,
  /cookie (?:policy|preferences)/gi,
];

// Thresholds (tunable). Defaults targeted at ATSes we know:
//   - A real Greenhouse JD: 2,500-8,000 chars of prose, 4-6 canonical sections
//   - A real Workable JD:   3,000-9,000 chars, 4-6 sections
//   - A shell-only scrape:  500-2,500 chars (mostly nav/footer/JS), 0-1 sections
const DEFAULT_THRESHOLDS = {
  minProseWords:        300,  // below this = almost certainly shell
  warnProseWords:       500,  // below this = WEAK (missing requirements section likely)
  minSectionsRequired:  2,    // below this = FAIL even if prose is long (probably boilerplate)
  warnSectionsRequired: 4,    // below this = WEAK (missing one of comp/qualifications)
};

/**
 * Score a scraped JD text and return a verdict + diagnostic detail.
 *
 * @param {string} text — scraped JD text (innerText preferred; raw HTML OK if no innerText available)
 * @param {object} [opts]
 * @param {object} [opts.thresholds] — override DEFAULT_THRESHOLDS
 * @returns {{
 *   verdict: 'GOOD' | 'WEAK' | 'FAIL',
 *   coverage_score: number,         // 0.0 - 1.0
 *   raw_char_count: number,
 *   prose_word_count: number,       // after stripping boilerplate
 *   sections_found: string[],
 *   shell_signals: string[],        // any SHELL_PATTERNS that matched
 *   reason: string,                 // short human-readable reason for the verdict
 * }}
 */
export function scoreJDCoverage(text, opts = {}) {
  const t = String(text || '');
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };

  const raw_char_count = t.length;

  // Hard-FAIL on shell signals — these mean we got bot-blocked or got the
  // SPA shell without the hydrated JD content. No coverage score helps here;
  // the scrape failed.
  const shell_signals = SHELL_PATTERNS
    .map((re) => re.exec(t)?.[0])
    .filter(Boolean)
    .map((m) => m.slice(0, 60));

  // Strip boilerplate before counting prose words.
  let prose = t;
  for (const re of BOILERPLATE_PHRASES) prose = prose.replace(re, ' ');
  // Collapse whitespace, count words ≥2 chars (drops single-char noise).
  const words = (prose.match(/\b[a-zA-Z][a-zA-Z'-]{1,}\b/g) || []);
  const prose_word_count = words.length;

  // Detect canonical sections.
  const sections_found = [];
  for (const sect of CANONICAL_SECTIONS) {
    if (sect.pats.some((re) => re.test(t))) sections_found.push(sect.key);
  }

  // Coverage score: 50% weight on prose volume (capped at 2x warn), 50% on
  // sections found out of 6. Range 0.0-1.0.
  const proseRatio = Math.min(1, prose_word_count / (thresholds.warnProseWords * 2));
  const sectionRatio = sections_found.length / CANONICAL_SECTIONS.length;
  const coverage_score = +((proseRatio * 0.5) + (sectionRatio * 0.5)).toFixed(3);

  // Verdict logic.
  let verdict, reason;
  if (shell_signals.length > 0) {
    verdict = 'FAIL';
    reason = `Shell signals detected: ${shell_signals.slice(0, 2).join(' | ')}`;
  } else if (prose_word_count < thresholds.minProseWords) {
    verdict = 'FAIL';
    reason = `Only ${prose_word_count} prose words after boilerplate strip (threshold: ${thresholds.minProseWords}); likely SPA shell or login wall.`;
  } else if (sections_found.length < thresholds.minSectionsRequired) {
    verdict = 'FAIL';
    reason = `Only ${sections_found.length} of 6 canonical JD sections detected (threshold: ${thresholds.minSectionsRequired}); content is likely boilerplate, not a JD.`;
  } else if (
    prose_word_count < thresholds.warnProseWords ||
    sections_found.length < thresholds.warnSectionsRequired
  ) {
    verdict = 'WEAK';
    reason = `${prose_word_count} prose words, ${sections_found.length}/6 sections — usable but missing common JD parts. Eval will run with low-confidence caveat.`;
  } else {
    verdict = 'GOOD';
    reason = `${prose_word_count} prose words, ${sections_found.length}/6 sections — looks like a real JD.`;
  }

  return {
    verdict,
    coverage_score,
    raw_char_count,
    prose_word_count,
    sections_found,
    shell_signals,
    reason,
  };
}

/**
 * Decide whether the verdict warrants a re-scrape via Playwright (if the
 * current scrape was via plain fetch). Used by gatherIntel to gate the
 * Playwright fallback.
 *
 * @param {ReturnType<typeof scoreJDCoverage>} coverage
 * @returns {boolean}
 */
export function shouldRetryWithPlaywright(coverage) {
  if (!coverage) return false;
  return coverage.verdict !== 'GOOD';
}
