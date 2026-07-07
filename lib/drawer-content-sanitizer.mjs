// lib/drawer-content-sanitizer.mjs
//
// Render-time sanitizer for cached drawer content (strategy-ceiling,
// hm-intel, comp-intel). Runs cheaply on every render — no LLM.
//
// Targets the 2026-05-29 drawer-quality findings:
//
//   1) Spanish-language residues from the legacy modes/oferta.md eval mode
//      ("Nivel detectado:", "Recomendación Final:", etc.) appearing in
//      English drawers — replaced with English equivalents.
//
//   2) Stretch-framed overclaims ("Pure FDE/Applied AI archetype hit",
//      "All must-haves clear", "Apply HIGH PRIORITY" without evidence)
//      — toned down to neutral observational language.
//
//   3) First-person voice slips ("I would bring...", "my background",
//      "looking at this role I...") — rewritten to SECOND person ("your
//      background"), matching the drawer's own frame ("How well your
//      background fits this role").
//
//   4) Blind-review #13 (2026-07-07): third-person leaks about the candidate
//      ("his Google xGE role", "Mitchell's background") — rewritten to second
//      person. The dashboard surface addresses the user as "you"; cached
//      eval-report extracts are written in analyst third-person, and the mix
//      reads as an identity leak to anyone else viewing the page. Pronoun
//      rules are deliberately NARROW (name-anchored or anchored to candidate-
//      specific nouns like "his Google xGE role") because bare "he/his" in
//      hm-intel content legitimately refers to the hiring manager.
//
//   5) Blind-review #13 (2026-07-07): unexpanded internal team name "xGE" —
//      expanded to "xGE (Cross-Google Engineering)" on first use per field.
//
// This is a RENDERER fix only. Underlying cache stays as-is so a re-eval
// pass can regenerate cleanly with the new grounded prompt + Block C
// requirement (spec: data/spec-drawer-content-retroactive-sweep-2026-05-29.md).
//
// Cost: 0 (pure-text regex). Latency: <1ms per field. Idempotent: running
// the sanitizer on already-sanitized text is a no-op.

// ─────────────────────────────────────────────────────────────────────────────
// Rule sets
// ─────────────────────────────────────────────────────────────────────────────

const SPANISH_RESIDUES = [
  // Section labels (most visible)
  [/\bNivel detectado\b\s*:?/gi,                    'Detected level:'],
  [/\bNivel natural\b\s*:?/gi,                      'Natural level:'],
  [/\bRecomendaci(?:o|ó)n Final\b\s*:?/gi,          'Final Recommendation:'],
  [/\bRecomendaci(?:o|ó)n\b\s*:?/gi,                'Recommendation:'],
  // Status / verb fragments
  [/\bno aplicar\b/gi,                              'do not apply'],
  [/\bdescartado\b/gi,                              'discarded'],
  [/\bdescartar\b/gi,                               'discard'],
  [/\baceptar\b/gi,                                 'accept'],
  // Block header variants from modes/oferta.md
  [/\bBloque\s+A\s*—\s*Resumen del Rol\b/gi,         'Block A — Role Summary'],
  [/\bBloque\s+B\s*—\s*Match CV\b/gi,                'Block B — CV Match'],
  [/\bBloque\s+C\s*—\s*Nivel y Estrategia\b/gi,      'Block C — Level and Strategy'],
  [/\bBloque\s+D\s*—\s*Comp y Demanda\b/gi,          'Block D — Comp and Demand'],
];

// Overclaim phrases — these appear when the LLM-as-judge inflates a stretch.
// Each rule rewrites to neutral observational language.
const OVERCLAIM_REWRITES = [
  // "Pure FDE archetype hit", "Pure A2b archetype hit"
  [/\bPure\s+(?:FDE\/Applied AI|FDE|Applied AI|A2[abc]|A2|B|Solutions Architect|Forward Deployed)\s+archetype\s+hit\b/gi,
   'Archetype-adjacent (verify in fit evidence)'],
  // Bare "archetype hit" without quantifier
  [/\b([A-Z][A-Za-z0-9 +\/]{2,30})\s+archetype\s+hit\b(?!\s+with\s+\d)/g,
   '$1 archetype proximity'],
  // "Apply HIGH PRIORITY" / "Apply HIGH" without evidence link
  [/\bApply\s+HIGH(?:\s+PRIORITY)?\b/g,
   'Apply — review evidence'],
  // "All must-haves clear" — this overstates when fit evidence is partial.
  // Rule: when this phrase appears AND the surrounding context references a
  // sub-100% interview likelihood / HM chance, downgrade to neutral. We do a
  // simple unconditional rewrite here — the renderer can reapply the original
  // when it has strong evidence.
  [/\bAll must-haves clear\b/gi,
   'Must-haves: reviewed'],
];

const VOICE_FIRST_PERSON = [
  // Phrase-level rewrites (most-visible first). 2026-07-07 (blind-review #13):
  // targets changed from third-person ("Mitchell's background") to second
  // person ("your background") — one consistent voice with the drawer chrome.
  [/\bWHY THIS ALIGNS WITH MY GOALS\b/g,  'WHY THIS ALIGNS WITH YOUR GOALS'],
  [/\bWhy this aligns with my goals\b/g,  'Why this aligns with your goals'],
  [/\bmy background\b/g,                  'your background'],
  [/\bmy fit\b/g,                         'the fit'],
  [/\bmy career arc\b/g,                  'your career arc'],
  [/\bmy strengths\b/g,                   'your strengths'],
  [/\blooking at this role I\b/gi,        'this role'],
  [/\bfrom my perspective\b/gi,           'observationally'],
  [/\bin my view\b/gi,                    'in the analyst view'],
];

// Blind-review #13 (2026-07-07) — third-person leaks about the CANDIDATE,
// rewritten to second person. Two anchor strategies keep this safe around
// hm-intel text where "he/his" legitimately means the hiring manager:
//   a) name-anchored — "Mitchell" can only mean the candidate;
//   b) noun-anchored — "his Google xGE role" / "his newsroom years" name
//      candidate-specific history no hiring manager shares.
// Bare "he/his/him" with generic nouns is deliberately left alone.
const THIRD_PERSON_LEAKS = [
  // Name-anchored, verb-agreement pairs first (before the bare-name rule).
  [/\bMITCHELL'S\b/g,   'YOUR'],
  [/\bMitchell's\b/g,   'your'],
  [/\bMitchell has\b/g, 'you have'],
  [/\bMitchell is\b/g,  'you are'],
  [/\bMitchell was\b/g, 'you were'],
  [/\bMitchell does\b/g, 'you do'],
  // Common present-tense 3rd-person verbs → base form ("Mitchell brings" →
  // "you bring"). Anything not in this list falls through to the bare rule,
  // which is grammatically safe for past-tense/modal verbs and object case.
  // Qodo 2026-07-07 (PR #402 review): bare strip-trailing-s broke -es verbs
  // ("matches" → "matche") — use a proper inflection helper instead.
  [/\bMitchell (brings|needs|wants|works|leads|builds|ships|owns|runs|writes|lacks|matches|fits|holds|carries|offers|reads|maps|lands|targets|operates|delivers|combines|bridges|pairs|speaks|translates|sits)\b/g,
   (m, v) => 'you ' + verbBaseForm(v)],
  [/\bMITCHELL\b/g,     'YOU'],
  [/\bMitchell\b/g,     'you'],
  // Noun-anchored pronoun leaks — candidate-specific possessions only.
  [/\b(h)is (Google xGE|xGE|Google) (role|time|work|tenure|experience|years?|agents?|program)\b/g,
   (m, h, org, noun) => (h === 'H' ? 'Your ' : 'your ') + org + ' ' + noun],
  [/\b(h)is (newsroom|journalism|exec-comms|executive-communications) (years?|background|era|experience|work)\b/g,
   (m, h, dom, noun) => (h === 'H' ? 'Your ' : 'your ') + dom + ' ' + noun],
];

// Blind-review #13 (2026-07-07) — expand the internal team name on first use
// per field. Implemented as a function (not a rule-table regex) so it stays
// idempotent: no expansion when the field already carries the expansion.
// Present-tense 3rd-person-singular → base form. Handles the standard English
// inflection classes so "matches" → "match" (not "matche"), "carries" → "carry".
function verbBaseForm(v) {
  if (/ies$/.test(v)) return v.replace(/ies$/, 'y');
  if (/(ches|shes|xes|zes|sses|oes)$/.test(v)) return v.replace(/es$/, '');
  return v.replace(/s$/, '');
}

// Capitalization repair after second-person rewrites: "speed. you have" →
// "speed. You have". Only touches sentence-initial lowercase you/your that
// the rewrites themselves produce, so it's a no-op on untouched text.
function capitalizeSentenceStarts(text) {
  return String(text).replace(/(^|[.!?:]\s+)(you)(\b)/g, (m, pre, word, b) => pre + 'You' + b)
    .replace(/(^|[.!?:]\s+)(your)(\b)/g, (m, pre, word, b) => pre + 'Your' + b);
}

const XGE_EXPANSION = 'xGE (Cross-Google Engineering)';
function expandXge(text) {
  const t = String(text);
  if (!/\bxGE\b/.test(t)) return t;
  if (t.includes('Cross-Google Engineering')) return t;
  return t.replace(/\bxGE\b/, XGE_EXPANSION);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply all sanitizer passes to a text field. Idempotent.
 * Order: Spanish residues → overclaim rewrites → first-person voice fixes →
 * third-person candidate leaks → xGE expansion. The third-person pass MUST
 * run before xGE expansion ("his Google xGE role" only matches while the
 * team name is still the bare token).
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function sanitizeDrawerText(text) {
  if (text == null) return '';
  let out = String(text);
  for (const [pat, rep] of SPANISH_RESIDUES)  out = out.replace(pat, rep);
  for (const [pat, rep] of OVERCLAIM_REWRITES) out = out.replace(pat, rep);
  for (const [pat, rep] of VOICE_FIRST_PERSON) out = out.replace(pat, rep);
  for (const [pat, rep] of THIRD_PERSON_LEAKS) out = out.replace(pat, rep);
  out = capitalizeSentenceStarts(out);
  out = expandXge(out);
  return out;
}

/**
 * Per-rule-class APIs for callers that need granular control.
 */
export function stripSpanishResidues(text) {
  if (text == null) return '';
  let out = String(text);
  for (const [pat, rep] of SPANISH_RESIDUES) out = out.replace(pat, rep);
  return out;
}

export function neutralizeOverclaims(text) {
  if (text == null) return '';
  let out = String(text);
  for (const [pat, rep] of OVERCLAIM_REWRITES) out = out.replace(pat, rep);
  return out;
}

// 2026-07-07 (blind-review #13): despite the historical name, this now
// rewrites BOTH first-person slips AND third-person candidate leaks to the
// drawer's second-person voice. Name kept for caller compatibility.
export function thirdPersonVoice(text) {
  if (text == null) return '';
  let out = String(text);
  for (const [pat, rep] of VOICE_FIRST_PERSON) out = out.replace(pat, rep);
  for (const [pat, rep] of THIRD_PERSON_LEAKS) out = out.replace(pat, rep);
  return capitalizeSentenceStarts(out);
}

/** Second-person voice + xGE expansion only (no Spanish/overclaim passes). */
export function secondPersonVoice(text) {
  if (text == null) return '';
  return expandXge(thirdPersonVoice(text));
}

/**
 * Sweep an object's string fields recursively. Safe for nested config objects.
 * Non-string values pass through unchanged.
 *
 * @param {any} obj
 * @returns {any}
 */
export function sanitizeObjectStrings(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return sanitizeDrawerText(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObjectStrings);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = sanitizeObjectStrings(obj[k]);
    return out;
  }
  return obj;
}

/**
 * Detect (but don't fix) — for telemetry / linter use.
 * Returns { spanish: string[], overclaims: string[], firstPerson: string[] }.
 */
export function findDrawerContentIssues(text) {
  const out = { spanish: [], overclaims: [], firstPerson: [], thirdPerson: [], xge: [] };
  if (text == null) return out;
  const t = String(text);
  for (const [pat] of SPANISH_RESIDUES) {
    const m = t.match(new RegExp(pat.source, pat.flags));
    if (m) out.spanish.push(...m.slice(0, 3));
  }
  for (const [pat] of OVERCLAIM_REWRITES) {
    const m = t.match(new RegExp(pat.source, pat.flags));
    if (m) out.overclaims.push(...m.slice(0, 3));
  }
  for (const [pat] of VOICE_FIRST_PERSON) {
    const m = t.match(new RegExp(pat.source, pat.flags));
    if (m) out.firstPerson.push(...m.slice(0, 3));
  }
  for (const [pat] of THIRD_PERSON_LEAKS) {
    const m = t.match(new RegExp(pat.source, pat.flags));
    if (m) out.thirdPerson.push(...m.slice(0, 3));
  }
  if (/\bxGE\b/.test(t) && !t.includes('Cross-Google Engineering')) {
    out.xge.push('xGE (unexpanded)');
  }
  return out;
}
