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
//      "looking at this role I...") — rewritten to third-person about
//      Mitchell, matching the lib/ground-prompt.mjs system prompt rules.
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
  // Phrase-level rewrites (most-visible first)
  [/\bWHY THIS ALIGNS WITH MY GOALS\b/g,  "WHY THIS ALIGNS WITH MITCHELL'S GOALS"],
  [/\bWhy this aligns with my goals\b/g,  "Why this aligns with Mitchell's goals"],
  [/\bmy background\b/g,                  "Mitchell's background"],
  [/\bmy fit\b/g,                         "the fit"],
  [/\bmy career arc\b/g,                  "Mitchell's career arc"],
  [/\bmy strengths\b/g,                   "Mitchell's strengths"],
  [/\blooking at this role I\b/gi,        'this role'],
  [/\bfrom my perspective\b/gi,           'observationally'],
  [/\bin my view\b/gi,                    'in the analyst view'],
  // Whitelist common safe phrases - run AFTER to avoid double-rewrite.
  // (e.g., "Mitchell's career arc" passes through unchanged because no rule matches it.)
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply all sanitizer passes to a text field. Idempotent.
 * Order: Spanish residues → overclaim rewrites → first-person voice fixes.
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

export function thirdPersonVoice(text) {
  if (text == null) return '';
  let out = String(text);
  for (const [pat, rep] of VOICE_FIRST_PERSON) out = out.replace(pat, rep);
  return out;
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
  const out = { spanish: [], overclaims: [], firstPerson: [] };
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
  return out;
}
