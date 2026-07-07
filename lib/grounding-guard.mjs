#!/usr/bin/env node
/**
 * lib/grounding-guard.mjs — single source of truth for apply-pack GROUNDING rules.
 *
 * Owns four rule families that previously lived as drifting copies across the
 * generator, the scrubber, and the invariant test:
 *
 *   1. RETIRED_METRIC_PATTERNS — metrics retired by data/HARDENED-CV-SPEC-2026-05-30.md
 *      that keep re-entering fresh artifacts ("stylistic fidelity", "90% latency",
 *      "1,000+ L8+ …", "348", …). Detection only — rewriting is the scrubber's job.
 *   2. Level jargon — Google-internal "L8/L9/L10" tokens in packs aimed at
 *      non-Google employers (meaningless externally; weaker than rank names).
 *   3. Banned branding + banned words — "Kill List" → "banned-phrase checklist"
 *      (auto-replace), any surviving kill-rooted token → violation.
 *   4. Target-company product-claim guard — first-person past-tense authorship of
 *      a product name that exists only in the target's JD/eval report (canonical
 *      incident: row 2582 claimed Mitchell built "Ramp Glass, Inspect, Dojo,
 *      Sensei" — names lifted verbatim from reports/1048-ramp-2026-05-28.md).
 *
 * Plus stripEditorialChatter() — removes LLM critic-pass debris ("**Changes
 * made:** …", trailing "[312 words]", "Here is the corrected letter:") that
 * leaked below cover-letter bodies (rows 2527 + 2373, 2026-06-11).
 *
 * Consumers:
 *   - scripts/build-apply-packs.mjs   (generation-time grounding tollbooth)
 *   - tests/apply-pack-no-scaffold-invariant.test.mjs (acceptance invariant)
 *   - tests/grounding-guard.test.mjs  (unit fixtures)
 *   - scripts/scrub-apply-pack-grounding-debt.mjs (legacy-tree sweep)
 *
 * Zero personal data: every pattern here is a banned/retired PHRASE, not a
 * personal fact. Canonical replacements come from cv.md at the call sites.
 * Bug class: fabricated-employer-in-generated-prose (sibling guard:
 * lib/employer-claims.mjs); this lib covers the non-employer fabrication
 * families the employer gate cannot see.
 */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 1. Retired / forbidden metrics ───────────────────────────────────────────
// The first nine entries are the original acceptance contract from
// tests/apply-pack-no-scaffold-invariant.test.mjs (2026-06-04) — keep their
// regexes byte-identical so the invariant's history stays comparable. The
// EXTENDED block widens coverage to the rest of the HARDENED-CV-SPEC retired
// list observed re-entering fresh artifacts on 2026-06-11.
export const RETIRED_METRIC_PATTERNS = [
  { re: /\b99% fidelity\b/i,                  label: 'forbidden-metric: 99% fidelity' },
  { re: /99 percent[^.]*fidelity/i,           label: 'forbidden-metric: 99 percent fidelity' },
  { re: /stylistic fidelity/i,                label: 'forbidden-metric: stylistic fidelity' },
  { re: /\b90% latency\b/i,                   label: 'forbidden-metric: 90% latency' },
  { re: /\b300% scal/i,                       label: 'forbidden-metric: 300% scaling' },
  { re: />\s?90% accur/i,                     label: 'forbidden-metric: >90% accuracy' },
  { re: /\b90% admin/i,                       label: 'forbidden-metric: ~90% admin-time' },
  { re: /substantial reduction in drafting/i, label: 'forbidden-metric: substantial drafting-latency reduction' },
  { re: /substantial drafting-latency/i,      label: 'forbidden-metric: substantial drafting-latency' },
  // ── EXTENDED (2026-06-11) ──
  { re: /\b90%\s+(?:reduction\s+in\s+)?drafting[- ]latency/i, label: 'forbidden-metric: 90% drafting-latency' },
  { re: /\b90% latency cut/i,                 label: 'forbidden-metric: 90% latency cut' },
  { re: />\s?90% classification/i,            label: 'forbidden-metric: >90% classification' },
  { re: /\b300%\+?\s+(?:active|capacity|scaling|deployment)/i, label: 'forbidden-metric: 300%+ capacity scaling' },
  { re: /\b348[ -](?:attendees|senior|engineers?|of them)/i, label: 'forbidden-metric: 348 attendees' },
  { re: /\b93%\s+(?:participant\s+)?CSAT\b/i, label: 'forbidden-metric: 93% CSAT' },
  { re: /\b180(?:,000|K)[ -]person/i,         label: 'forbidden-metric: 180K-person' },
  { re: /\b600\+\s*L8/i,                      label: 'forbidden-metric: 600+ L8+' },
  { re: /\btop\s+0\.5%/i,                     label: 'forbidden-metric: top 0.5%' },
  { re: /\b(?:three|3)\s+(?:shipped\s+|deployed\s+|distinct\s+|production-grade\s+)?production\s+(?:AI\s+|LLM\s+|voice\s+)?(?:agents|systems)\b/i, label: 'forbidden-metric: three production agents (verified count is two)' },
];

// Self-check probes: strings every consumer may assume the list catches. The
// invariant test asserts these so a future edit cannot silently weaken the lib.
export const RETIRED_METRIC_PROBES = [
  'high stylistic fidelity',
  '99% fidelity',
  '90% latency reduction',
  'a substantial reduction in drafting latency',
  '>90% accuracy',
  '90% admin-time reduction',
  '348 attendees',
  '93% CSAT',
  '300%+ capacity scaling',
  'three production AI agents',
];

// ── 1b. Comms-triage continuity + achieved-result claims ─────────────────────
// data/resume-mirror-spec-2026-07-06.md § Exclusions + memory
// project_xge_comms_triage_agent_provenance: the comms-triage agent never ran
// during Mitchell's 2026 extended leave (he launched it himself on return;
// throughput ~zero), and the ~60% auto-handled / ~160 hours-per-year figures
// are DESIGN TARGETS, never measured outcomes. Canonical honest framing
// (cv.md 2026-07-06 fix): "documented end-to-end and handed off with a full
// operator runbook; designed to auto-handle ~60% of inbound (est.) and
// projected to recapture ~160 operational hours/year (est.)".
//
// Deliberately NOT in RETIRED_METRIC_PATTERNS: the no-scaffold invariant
// iterates that list tree-wide, and at the time this family landed the legacy
// tree still carried these shapes (~435 files at the 2026-07-07 census).
// This family is enforced at the generation tollbooth
// (findGroundingViolations({ checkContinuity: true })) so FRESH artifacts
// fail closed. The legacy tree was swept to census-zero on 2026-07-07 via
// scripts/scrub-continuity-legacy-debt.mjs (re-runnable; dry-run = census).
export const CONTINUITY_CLAIM_PATTERNS = [
  { re: /\b100%\s+operational\s+continuity\b/i,
    label: 'continuity-claim: 100% operational continuity' },
  { re: /\bzero\s+degradation\b[^.!?\n]{0,50}\b(?:classification|accuracy|leave)/i,
    label: 'continuity-claim: zero degradation (classification/leave)' },
  { re: /\brelied\s+on\s+(?:it|the\s+agent|this\s+agent)\b[^.!?\n]{0,30}\babsence\b/i,
    label: 'continuity-claim: team relied on it in absence' },
  { re: /\b(?:ran|kept\s+running|kept\s+working|operated|running|worked)\b[^.!?\n]{0,60}\b(?:through|during)\b[^.!?\n]{0,40}\bleave\b/i,
    label: 'continuity-claim: agent ran through extended leave' },
  { re: /\b(?:medical\s+)?leave\b[^.!?\n]{0,80}\b(?:operational\s+continuity|zero\s+degradation|ran\s+independently|without\s+(?:interruption|degradation)|uninterrupted)/i,
    label: 'continuity-claim: continuity during extended leave' },
  { re: /~?\s*55%\s+Low[- ]Touch/i,
    label: 'retired-share: ~55% Low-Touch (dropped by the 2026-07-06 cv.md honesty fix)' },
];

// Self-check probes (asserted by tests/grounding-guard.test.mjs consumers).
export const CONTINUITY_PROBES = [
  'maintained 100% operational continuity during a multi-month extended leave',
  'the team relied on it in my absence',
  'ran independently with zero degradation in classification accuracy',
  'kept running on intake through a multi-month extended leave',
  '~60% of inbound auto-handled (~55% Low-Touch)',
];

// Achieved-result framing of the triage design targets. Sentence-level: any
// sentence carrying the ~60%-of-inbound / auto-handle / ~160-hour numbers must
// also carry design-target language (designed / projected / target / est.).
//
// KNOWN SOFTNESS (accepted heuristic, 2026-07-07 review finding #7): the check
// passes any sentence containing a target-framing word ANYWHERE, so
// "auto-handled ~60%, beating its target" slips through. This layer is a
// deterministic backstop behind the LLM prompts (which ban achieved framing
// outright) and the human read; tightening it to positional matching bought
// false positives on legitimate framings in calibration. Do not treat this
// regex as the sole gate for triage-metric honesty.
//
// Both regexes are exported so sweep tooling (scripts/
// scrub-continuity-legacy-debt.mjs) consumes the EXACT detector shapes instead
// of hand-mirroring them (drift risk, review finding #6).
export const TRIAGE_METRIC_RE = /(?:~?\s*60%\s*(?:of\s+)?(?:inbound|traffic|requests)|auto-handl|~?\s*160\s+(?:operational\s+)?(?:hours|hrs))/i;
export const TARGET_FRAMING_RE = /\b(?:designed?|design\s+target|projected|projection|targets?|targeted|goal|estimated?|est\.)/i;

export function findTriageFramingViolations(text) {
  const violations = [];
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (!TRIAGE_METRIC_RE.test(sentence)) continue;
    if (TARGET_FRAMING_RE.test(sentence)) continue;
    violations.push({
      kind: 'triage-achieved-framing',
      label: 'comms-triage metric stated as achieved result (canonical framing: "designed to auto-handle ~60% of inbound (est.)" / "projected ~160 hours/year (est.)")',
      excerpt: sentence.trim().slice(0, 140),
    });
  }
  return violations;
}

// ── 2. Google-internal level jargon ──────────────────────────────────────────
// Bare /L8/ matches the invariant test's historical check exactly (it also
// catches "L8+", "L8–L10", "1,000+ L8+ …"). L9/L10 word-bounded.
export const LEVEL_JARGON_RE = /L8|\bL9\b|\bL10\b/;

// ── 3. Banned branding / banned words ────────────────────────────────────────
// "Kill List" was the legacy name for the rejected-drafts negative-training
// layer. Canonical name (cv.md + Mitchell's standing rule): "banned-phrase
// checklist". Auto-replace; any kill-rooted token that survives is a violation
// ("kill" is banned in all outbound materials — feedback_banned_word_kill).
export const BRANDING_REPLACEMENTS = [
  [/["“”']?kill[ -]?list["“”']?/gi, 'banned-phrase checklist'],
];
export const KILL_WORD_RE = /\bkill\w*\b/i;

export function applyBrandingReplacements(text) {
  let t = String(text);
  for (const [re, to] of BRANDING_REPLACEMENTS) t = t.replace(re, to);
  return t;
}

// ── 3b. Em dashes ────────────────────────────────────────────────────────────
// Em dashes (U+2014) read as an AI tell and are banned in submitted/spoken
// materials, including rendered PDFs (feedback_no_em_dashes_in_materials,
// 2026-06-11). Replacements are comma / colon / period / semicolon /
// parentheses — a judgment call per sentence, so detection here is flag-only
// (the generation prompts forbid them; a slip-through marks the row PARTIAL
// and regeneration fixes it). En dashes (U+2013, date ranges) are ALLOWED.
// Opt-in via findGroundingViolations({ checkEmDashes: true }) so existing
// consumers (legacy-tree scrubber, fixtures) keep their behavior unchanged.
export const EM_DASH_RE = /—/;

// ── 3c. Time-boxed meeting ask ("N minutes") ─────────────────────────────────
// Mitchell's hard rule: no "N minutes" time box in any cover-letter / outreach
// close (feedback_outreach_drafting_bar). Offer the artifact, never a meeting
// slot. The leak shape is a quantity of minutes pitched as a meeting duration
// right next to a walk-through / chat / call offer ("I would value 15 minutes
// to walk through ..."). The SOURCE of the leak was the cover-letter gold
// reference + the two templates, which literally said "keep the 15 minutes" —
// so every regenerated letter reproduced it. Those are fixed at the source; this
// gate is the fail-closed backstop for any future slip.
//
// Detection requires BOTH a minutes quantity AND a nearby offer cue, in that
// order (minutes-first, within ~40 chars). That ordering is what makes it
// precise: a metric like "recaptures ~160 hours/year" (no minutes), or
// "I can walk through how it saves 20 minutes/request" (offer-FIRST, minutes as
// a metric), does NOT trip it. Spelled-out and digit quantities both match;
// "15-minute call" matches via the optional plural.
//
// Opt-in via findGroundingViolations({ checkTimeAsk: true }) so legacy consumers
// + the no-scaffold invariant keep their behavior; the generation tollbooth in
// build-apply-packs.mjs turns it on so fresh artifacts fail-closed.
const TIME_ASK_QUANTITY = '(?:ten|fifteen|twenty|thirty|forty[- ]?five|fifty|sixty|\\d{1,3})';
const TIME_ASK_OFFER = '(?:walk(?:s|ing)?\\b[\\w\'’\\s]{0,15}\\bthrough|walkthrough|chat|call|talk|speak|conversation|conversations|meet(?:ing)?|connect|sync|discuss|run through|hop on|grab (?:a )?(?:coffee|time))';
export const TIME_ASK_RE = new RegExp(
  '\\b' + TIME_ASK_QUANTITY + '[\\s-]*minutes?\\b[\\s\\S]{0,40}?\\b' + TIME_ASK_OFFER + '\\b',
  'i'
);

// ── Editorial-chatter stripper ───────────────────────────────────────────────
// The critic pass historically returned the letter plus debris: a leading
// "Here is the corrected cover letter:" line, a trailing "[312 words]" /
// "Word count: 312" line, or a whole "**Changes made:** …" block. All of it is
// model-to-operator talk that must never reach a recruiter.
export function stripEditorialChatter(text) {
  let t = String(text);
  // A "Changes made / Edits made / Revisions" block swallows everything after it.
  t = t.replace(/\n+[-*_]{0,3}\s*\n*\*{0,2}(?:changes|edits|revisions|corrections)\s+(?:made|applied)\*{0,2}\s*:?[\s\S]*$/i, '');
  // Trailing word-count lines, possibly stacked ("Final word count: 318" + "[318 words]").
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\n+\[?\(?\s*(?:final\s+)?word\s*count\s*:?\s*\d+\s*(?:words?)?\s*\)?\]?\s*$/i, '');
    t = t.replace(/\n+\[?\(?\s*\d+\s+words?\.?\s*\)?\]?\s*$/i, '');
  }
  // Leading meta-preamble before the actual body.
  t = t.replace(/^(?:here(?:'s| is) (?:the |your |a )?(?:full |final |corrected |revised |polished )*(?:cover letter|letter|one-pager|draft|version)[^\n]*\n+)/i, '');
  return t.trim();
}

// ── 4. Target-company product-claim guard ────────────────────────────────────
// Extract product/system names that belong to the TARGET company's world (they
// appear in the JD / eval report) and are absent from Mitchell's verified
// corpus. Any first-person past-tense authorship claim over one of them is a
// fabrication. Precision-first: candidates need a company-name attachment OR
// repeated TitleCase usage, and the claim check is case-sensitive on the name.
const GENERIC_TOKENS = new Set([
  // sentence furniture + business generics that survive TitleCase capture
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'they', 'it', 'he', 'she', 'who', 'what', 'when', 'where', 'why', 'how',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'senior', 'staff', 'principal', 'lead', 'leads', 'head', 'director', 'manager',
  'engineer', 'engineering', 'developer', 'advocate', 'architect', 'specialist',
  'operations', 'product', 'design', 'data', 'platform', 'cloud', 'enterprise',
  'customer', 'customers', 'success', 'solutions', 'sales', 'marketing', 'growth',
  'team', 'teams', 'company', 'companies', 'startup', 'series', 'remote', 'hybrid',
  'about', 'overview', 'requirements', 'responsibilities', 'benefits', 'qualifications',
  'block', 'score', 'overall', 'summary', 'report', 'evidence', 'requirement',
  'mitchell', 'williams', 'google', 'xge', 'gemini', 'claude', 'gpt',
  'ai', 'ml', 'llm', 'llms', 'api', 'apis', 'rag', 'saas', 'b2b', 'b2c', 'gtm',
  'ceo', 'cto', 'coo', 'cio', 'vp', 'hr', 'it', 'us', 'usa', 'uk', 'eu', 'emea', 'apac',
  'new', 'york', 'san', 'francisco', 'seattle', 'london', 'nyc', 'sf', 'la',
  'inc', 'llc', 'ltd', 'co', 'corp', 'group', 'labs', 'technologies', 'studio',
]);

export function extractTargetProductNames({ jdText = '', reportText = '', companyName = '', corpusText = '' } = {}) {
  const source = `${jdText}\n${reportText}`;
  const company = String(companyName || '').trim();
  if (!source.trim() || !company) return [];
  const corpusLc = String(corpusText || '').toLowerCase();
  const companyTokens = new Set(company.toLowerCase().split(/\s+/));

  const keep = (name) => {
    const lc = name.toLowerCase();
    if (name.length < 3 || name.length > 40) return false;
    if (companyTokens.has(lc) || lc === company.toLowerCase()) return false;
    if (name.split(/\s+/).every(w => GENERIC_TOKENS.has(w.toLowerCase()))) return false;
    if (corpusLc.includes(lc)) return false; // verified-world term, not target-exclusive
    return true;
  };

  const candidates = new Set();

  // (a) Company-attached names: "Ramp Glass", "Ramp's Inspect and Dojo".
  const attachRe = new RegExp(escapeRe(company) + "(?:['’]s)?\\s+([A-Z][\\w.-]*(?:\\s+[A-Z][\\w.-]*){0,2})", 'g');
  let m;
  while ((m = attachRe.exec(source)) !== null) {
    const phrase = m[1].replace(/[.,;:]+$/, '');
    if (keep(phrase)) candidates.add(phrase);
    const first = phrase.split(/\s+/)[0];
    if (first !== phrase && keep(first)) candidates.add(first);
  }

  // (b) Repeated TitleCase tokens (≥3 mentions) — catches comma-list product
  // suites ("Glass, Inspect, Dojo, and Sensei") once any one form recurs.
  const counts = new Map();
  const tokRe = /\b([A-Z][a-z][\w.-]{1,24})\b/g;
  while ((m = tokRe.exec(source)) !== null) {
    const tok = m[1];
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }
  for (const [tok, n] of counts) {
    if (n >= 3 && keep(tok)) candidates.add(tok);
  }

  return [...candidates].slice(0, 40);
}

// First-person past-tense stewardship verbs (authorship claims).
const FP_PAST_RE = /\b(?:I|we)\b[^.!?\n]{0,90}?\b(?:built|created|developed|designed|architected|shipped|launched|engineered|implemented|deployed|led|drove|scaled|ran|managed|owned|maintained|operated|founded|wrote|produced|delivered|established|spearheaded|championed|grew|transformed|rebuilt|overhauled)\b/i;
// Prospective / second-party markers — when one appears BEFORE the product
// name in the sentence, the sentence is hypothetical or about THEIR work.
const PROSPECTIVE_RE = /\b(?:I['’]?d\b|I would|I['’]?ll\b|I will|I want to|I hope to|I plan to|excited to|eager to|love to|looking forward|if (?:hired|selected|brought|given)|day one|first 90 days|you['’]?ve|you['’]?re|your|you have|they['’]?ve|their)\b/i;

export function findProductClaimViolations(text, productNames = []) {
  if (!productNames || productNames.length === 0) return [];
  const violations = [];
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (!FP_PAST_RE.test(sentence)) continue;
    for (const name of productNames) {
      // Case-sensitive on the product name — "Glass" the product, not "glass".
      const idx = sentence.search(new RegExp('\\b' + escapeRe(name) + '\\b'));
      if (idx === -1) continue;
      if (PROSPECTIVE_RE.test(sentence.slice(0, idx))) continue;
      violations.push({
        kind: 'product-claim-first-person',
        label: `target-product authorship claim: "${name}"`,
        excerpt: sentence.trim().slice(0, 140),
      });
      break; // one violation per sentence is enough to halt
    }
  }
  return violations;
}

// ── Aggregate check used by the generation tollbooth ─────────────────────────
export function findGroundingViolations(text, { productNames = [], isGoogleTarget = false, checkEmDashes = false, checkTimeAsk = false, checkContinuity = false } = {}) {
  const violations = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const { re, label } of RETIRED_METRIC_PATTERNS) {
      if (re.test(ln)) { violations.push({ kind: 'retired-metric', label, line: i + 1, excerpt: ln.trim().slice(0, 140) }); break; }
    }
    if (checkContinuity) {
      for (const { re, label } of CONTINUITY_CLAIM_PATTERNS) {
        if (re.test(ln)) { violations.push({ kind: 'continuity-claim', label, line: i + 1, excerpt: ln.trim().slice(0, 140) }); break; }
      }
    }
    if (!isGoogleTarget && LEVEL_JARGON_RE.test(ln)) {
      violations.push({ kind: 'level-jargon', label: 'Google-internal L8/L9/L10 token in non-Google material', line: i + 1, excerpt: ln.trim().slice(0, 140) });
    }
    if (KILL_WORD_RE.test(ln)) {
      violations.push({ kind: 'banned-word', label: 'banned word "kill" (use "banned-phrase checklist" for the branding)', line: i + 1, excerpt: ln.trim().slice(0, 140) });
    }
    if (/<!--\s*FABRICATION FLAG/i.test(ln)) {
      violations.push({ kind: 'fabrication-flag', label: 'unresolved FABRICATION-FLAG comment', line: i + 1, excerpt: ln.trim().slice(0, 140) });
    }
    if (checkEmDashes && EM_DASH_RE.test(ln)) {
      violations.push({ kind: 'em-dash', label: 'em dash (banned in materials — use comma/colon/period/parens)', line: i + 1, excerpt: ln.trim().slice(0, 140) });
    }
    if (checkTimeAsk && TIME_ASK_RE.test(ln)) {
      violations.push({ kind: 'time-ask', label: 'time-boxed meeting ask (banned: offer the artifact, not "N minutes")', line: i + 1, excerpt: ln.trim().slice(0, 140) });
    }
  }
  violations.push(...findProductClaimViolations(text, productNames));
  if (checkContinuity) violations.push(...findTriageFramingViolations(text));
  return violations;
}
