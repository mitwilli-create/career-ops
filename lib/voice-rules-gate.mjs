/**
 * lib/voice-rules-gate.mjs — Layer 2 12-rule programmatic voice gate
 * (Phase 4.5-DET-5, 2026-05-22)
 *
 * Codifies the 12 voice rules from
 *   ~/.claude/knowledge/brain/personality-communication-style.md
 * as programmatic checks. Complements lib/ai-detection-gate.mjs (Layer 1
 * three-detector ensemble) so the polish-loop can refuse to ship an artifact
 * that either (a) reads as AI-generated to the detectors OR (b) drifts from
 * Mitchell's canonical voice patterns. Designed so that when Layer 1 returns
 * UNCALIBRATED signal_quality (the Closure 3.09 finding), Layer 2 is still
 * load-bearing and produces structured evidence — not just a fall-through to
 * manual review.
 *
 * Rule coverage (numbered to match the brain file):
 *   1. Lead architecture     — first sentence asserts a verdict (heuristic)
 *   2. Em-dash density       — ≥30% of sentences carry at least one em dash
 *                              (brain file target 40-50%; floor at 30% for
 *                              short artifacts where target is statistical)
 *   3. Root-word discipline  — no root repeats within ~50-word window
 *   4. Metric anchoring      — heuristic flag for vague quantifiers
 *                              ("many", "lots", "high", "low") without numbers
 *   5. Earned closer         — final paragraph closes structural, not feeling
 *   6. Colloquial emotional vocabulary — concrete verbs over abstract nouns
 *   7. Shared Vision framing — "data suggests" / "could / might / opens" over
 *                              "the data shows" / "definitively"
 *   8. Smart Brevity bullets — max 1 nest level; "**bold lead** —" pattern
 *   9. Sentence length       — avg 18-22, hard cap 35
 *   10. Banned vocabulary    — HARD FAIL on leverage/synergy/best-in-class/etc.
 *   11. Hedge-word refuse    — HARD FAIL on perhaps/arguably/potentially/etc.
 *   12. Banned therapy-speak — HARD FAIL on hold space/feel into/lean in/etc.
 *
 * Roll-up (Phase 4.5, 2026-05-23):
 *   FAIL  if any critical rule (10, 11, 12) returns `critical_hit: true`.
 *         - rule 10 banned-vocab: ≥2 matches OR (1 match in <500 words)
 *         - rule 11 hedge-words: density ≥ 4 per 1000 words
 *         - rule 12 therapy-speak: any occurrence (unchanged)
 *   WARN  if overall weighted score 0.60–0.79 OR if a critical rule flagged
 *         but didn't hit the critical-failure threshold
 *   PASS  if overall weighted score ≥ 0.80 with no critical failures
 *
 * signal_quality mirrors Layer 1 vocabulary so polish-loop can OR/AND the two:
 *   GOOD  — checks ran cleanly on sufficient text length
 *   WEAK  — text < 200 chars (statistical signal unreliable)
 *
 * Exports:
 *   runVoiceRulesGate(text)        → full structured verdict
 *   checkBannedVocab(text)         → individual-rule check (also exposed)
 *   checkHedgeWords(text)
 *   checkTherapySpeak(text)
 *   checkEmDashDensity(text)
 *   checkSentenceLength(text)
 *   checkRootDiscipline(text)
 *   checkMetricAnchoring(text)
 *   checkSharedVision(text)
 *   checkEarnedCloser(text)
 *   checkColloquialEmotion(text)
 *   checkLeadArchitecture(text)
 *   checkSmartBrevity(text)
 *   VOICE_RULES                    → rule registry (id → { name, critical })
 *   verdictForScore(score, criticalFailures) → 'PASS' | 'WARN' | 'FAIL'
 */

// ── Rule registry ────────────────────────────────────────────────────────────

export const VOICE_RULES = {
  1:  { name: 'lead_architecture',          critical: false, weight: 1.0 },
  2:  { name: 'em_dash_density',            critical: false, weight: 1.0 },
  3:  { name: 'root_word_discipline',       critical: false, weight: 0.8 },
  4:  { name: 'metric_anchoring',           critical: false, weight: 1.0 },
  5:  { name: 'earned_closer',              critical: false, weight: 0.8 },
  6:  { name: 'colloquial_emotion',         critical: false, weight: 0.8 },
  7:  { name: 'shared_vision',              critical: false, weight: 0.8 },
  8:  { name: 'smart_brevity_bullets',      critical: false, weight: 0.6 },
  9:  { name: 'sentence_length',            critical: false, weight: 1.0 },
  10: { name: 'banned_vocabulary',          critical: true,  weight: 2.0 },
  11: { name: 'hedge_words',                critical: true,  weight: 1.5 },
  12: { name: 'banned_therapy_speak',       critical: true,  weight: 1.5 },
};

// ── Banned vocab (rule 10) ───────────────────────────────────────────────────

const BANNED_VOCAB = [
  { token: /\bleverage\b/gi,                  replace: 'use, apply, draw on' },
  { token: /\bsynergy\b/gi,                   replace: 'overlap, mutual fit' },
  { token: /\bbest[- ]in[- ]class\b/gi,       replace: 'top-tier, leading' },
  { token: /\bdeliverable[s]?\b/gi,           replace: 'output, result' },
  { token: /\bactionable insights?\b/gi,      replace: 'clear next steps' },
  { token: /\blow[- ]hanging fruit\b/gi,      replace: 'the easy wins' },
  { token: /\bmoving forward\b/gi,            replace: 'next, from here' },
  { token: /\bcircle back\b/gi,               replace: 'come back to' },
  { token: /\bdouble[- ]click(?:ing)?\b/gi,   replace: 'dig in, drill into' },
  { token: /\bdeep[- ]dive(?:ing|ed)?\b/gi,   replace: 'examine closely' },
  { token: /\btouch base\b/gi,                replace: 'check in' },
  { token: /\baction item[s]?\b/gi,           replace: 'next action' },
  { token: /\bideate\b/gi,                    replace: 'brainstorm, draft' },
  { token: /\bhold space\b/gi,                replace: 'sit with' },
  { token: /\bfeel into\b/gi,                 replace: 'sense, gauge' },
  { token: /\blean in\b/gi,                   replace: 'commit, engage' },
  { token: /\bself[- ]care narrative\b/gi,    replace: '(delete)' },
];

// ── Hedge words (rule 11) ────────────────────────────────────────────────────

const HEDGE_WORDS = [
  /\bperhaps\b/gi,
  /\bmight want to consider\b/gi,
  /\bit could be worth\b/gi,
  /\bpotentially\b/gi,
  /\barguably\b/gi,
  /\bseemingly\b/gi,
  /\bsomewhat\b/gi,
  /\bbasically\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
];

// ── Therapy-speak (rule 12) ──────────────────────────────────────────────────

const THERAPY_SPEAK = [
  /\bhold space\b/gi,
  /\bfeel into\b/gi,
  /\blean in\b/gi,
  /\bself[- ]care narrative\b/gi,
  /\bhonor your truth\b/gi,
  /\blean into discomfort\b/gi,
];

// ── Vague-metric patterns (rule 4) ───────────────────────────────────────────

const VAGUE_QUANTIFIERS = [
  /\b(many|lots of|a lot of|tons of|several)\b/gi,
  /\b(high|low|good|great|significant)\s+(accuracy|throughput|performance|results?|signal|engagement|reach)\b/gi,
  /\bvery\s+(many|few|high|low)\b/gi,
];

// ── Shared-Vision negative patterns (rule 7) — facts-only assertions ──────────

const FACTS_ONLY = [
  /\bthe data shows\b/gi,
  /\bdefinitively\b/gi,
  /\bproves that\b/gi,
];

// ── Earned-closer negative patterns (rule 5) ─────────────────────────────────

const DECLARED_FEELING = [
  /\bI feel\b/gi,
  /\bI'?m excited\b/gi,
  /\bit's wonderful\b/gi,
  /\bmakes me feel\b/gi,
  /\bI'?m optimistic\b/gi,
];

// ── Therapy-style abstract emotion (rule 6) ──────────────────────────────────

const ABSTRACT_EMOTION = [
  /\bI felt frustrated\b/gi,
  /\bI observed disengagement\b/gi,
  /\bsense of unease\b/gi,
];

// ── Lead-architecture violation: throat-clearing openers (rule 1) ────────────

const THROAT_CLEAR_OPENERS = [
  /^(I'?d like to|I would like to|I want to|I'?m going to|Let me|Here'?s the thing|First,)\b/i,
  /^(In this (post|document|essay|memo|piece),)\b/i,
  /^(I am writing to|I'?ll start by|I'?ll begin by)\b/i,
];

// ── Root-discipline stop-words (rule 3) — exempt from repeat detection ──────
// Added Phase 4.5 (2026-05-23): the original heuristic flagged "google", "until",
// "wasn't", domain-specific terms ("prompt"), and proper nouns as repeated roots
// even when their reuse was structural. 52 flags on a 5394-char Mitchell essay.
// This exemption set captures English stop-words + the proper-noun patterns
// most likely to recur in professional prose (companies, products, project names).
const STOP_ROOTS = new Set([
  'about', 'above', 'after', 'again', 'against', 'almost', 'along', 'already',
  'although', 'always', 'among', 'around', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'cannot', 'could', 'couldn', 'didn', 'does', 'doesn',
  'doing', 'down', 'during', 'each', 'either', 'enough', 'even', 'every', 'first',
  'from', 'further', 'going', 'gone', 'good', 'have', 'haven', 'having', 'here',
  'herself', 'himself', 'into', 'isn', 'itself', 'just', 'know', 'like', 'made',
  'many', 'more', 'most', 'much', 'must', 'never', 'next', 'nothing', 'often',
  'only', 'other', 'others', 'ought', 'over', 'really', 'said', 'same', 'shall',
  'should', 'shouldn', 'since', 'some', 'something', 'sometimes', 'still', 'such',
  'than', 'that', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'thing', 'things', 'this', 'those', 'through', 'thus', 'time', 'today',
  'together', 'under', 'until', 'upon', 'used', 'very', 'want', 'wasn', 'were',
  'weren', 'what', 'when', 'where', 'whether', 'which', 'while', 'with', 'within',
  'without', 'would', 'wouldn', 'your', 'yours',
  // Common career-ops / technical domain terms that appear frequently and
  // structurally in Mitchell's prose; flagging them as "root-repeat" is noise.
  'google', 'engine', 'system', 'team', 'work', 'people', 'thinking', 'right',
  'first', 'second', 'role', 'company', 'years', 'project', 'product', 'data',
  'model', 'model', 'agent', 'apply', 'story', 'voice',
]);

// ── Sentence + em-dash + word helpers ────────────────────────────────────────

function sentencesOf(text) {
  // Roughly split on .!?  while respecting that em-dash is mid-sentence.
  // Trim and drop empties.
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z'-]+/i)
    .filter((w) => w && w.length > 2);
}

function emDashCount(s) {
  return (s.match(/—/g) || []).length;
}

// ── Individual rule checks ───────────────────────────────────────────────────

export function checkBannedVocab(text) {
  const matches = [];
  for (const { token, replace } of BANNED_VOCAB) {
    token.lastIndex = 0;
    let m;
    while ((m = token.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index, replace });
      if (token.lastIndex === m.index) token.lastIndex++; // avoid infinite loop
    }
  }
  // Density-aware critical FAIL (Phase 4.5 — 2026-05-23):
  //   0 matches              → PASS, score 1.0
  //   1 match in ≥500 words  → WARN (not critical-fail), score 0.7
  //   1 match in <500 words  → FAIL, score 0
  //   ≥2 matches             → FAIL, score 0
  // Rationale: AI decoy fires 5 banned tokens in ~60 words (8.3% density);
  // Mitchell's verified narrative-essay prose may carry isolated 1-in-5000-chars
  // slips that should warn but not hard-block. See investigation 2026-05-23.
  const wordCount = wordsOf(text).length;
  let pass = true;
  let score = 1;
  let critical_hit = false;
  let evidence;
  if (matches.length === 0) {
    evidence = 'no banned-vocab matches';
  } else if (matches.length === 1 && wordCount >= 500) {
    pass = false;
    score = 0.7;
    critical_hit = false; // single match in long-form text → WARN, not critical
    evidence = `1 banned token in ${wordCount} words (${matches[0].match}) — density acceptable for long-form; downgraded to WARN`;
  } else {
    pass = false;
    score = 0;
    critical_hit = true;
    evidence = `${matches.length} banned tokens in ${wordCount} words: ${matches.slice(0, 3).map((m) => m.match).join(', ')}`;
  }
  return {
    rule: 10,
    name: VOICE_RULES[10].name,
    critical: true,
    critical_hit, // only true when this rule contributes to gate FAIL
    pass,
    score,
    matches,
    word_count: wordCount,
    evidence,
  };
}

export function checkHedgeWords(text) {
  const matches = [];
  for (const re of HEDGE_WORDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  // Density-aware critical FAIL (Phase 4.5 — 2026-05-23):
  //   density < 1 per 1000 words (Mitchell norm)  → PASS, score 1.0
  //   density 1-3 per 1000 words                  → WARN, score 0.6
  //   density ≥ 4 per 1000 words                  → FAIL, score 0
  // Rationale: 3 of 5 verified Mitchell stories were FAILing on single
  // "kind of" / "perhaps" occurrences in 5000-char essays. The brain file's
  // intent ("delete entirely") targets AI hedging-on-everything sludge, not
  // 1-in-5394-chars human prose. See investigation 2026-05-23.
  const wordCount = wordsOf(text).length;
  const densityPer1k = wordCount > 0 ? (matches.length / wordCount) * 1000 : 0;
  let pass = true;
  let score = 1;
  let critical_hit = false;
  let evidence;
  if (matches.length === 0) {
    evidence = 'no hedge-words matches';
  } else if (densityPer1k < 1) {
    pass = true; // below Mitchell norm threshold → still pass
    score = 1;
    evidence = `${matches.length} hedge(s) in ${wordCount} words (${densityPer1k.toFixed(2)}/1k) — within Mitchell narrative norm`;
  } else if (densityPer1k < 4) {
    pass = false;
    score = 0.6;
    critical_hit = false; // WARN, not critical-fail
    evidence = `${matches.length} hedge(s) in ${wordCount} words (${densityPer1k.toFixed(2)}/1k) — elevated; downgrade to WARN`;
  } else {
    pass = false;
    score = 0;
    critical_hit = true;
    evidence = `${matches.length} hedge(s) in ${wordCount} words (${densityPer1k.toFixed(2)}/1k) — AI-pattern density: ${matches.slice(0, 3).map((m) => m.match).join(', ')}`;
  }
  return {
    rule: 11,
    name: VOICE_RULES[11].name,
    critical: true,
    critical_hit,
    pass,
    score,
    matches,
    word_count: wordCount,
    density_per_1k: Math.round(densityPer1k * 100) / 100,
    evidence,
  };
}

export function checkTherapySpeak(text) {
  const matches = [];
  for (const re of THERAPY_SPEAK) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  // Therapy-speak stays any-occurrence critical FAIL (Phase 4.5 — 2026-05-23):
  // These phrases ("hold space", "feel into", "lean into discomfort", "self-care
  // narrative") are NEVER in Mitchell's verified voice corpus regardless of
  // register. Any occurrence is a real signal of LLM-drift.
  const pass = matches.length === 0;
  return {
    rule: 12,
    name: VOICE_RULES[12].name,
    critical: true,
    critical_hit: !pass, // therapy-speak ALWAYS contributes to gate FAIL when present
    pass,
    score: pass ? 1 : 0,
    matches,
    evidence: pass ? 'no therapy-speak matches' : `${matches.length} matches: ${matches.slice(0, 3).map((m) => m.match).join(', ')}`,
  };
}

export function checkEmDashDensity(text) {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) {
    return { rule: 2, name: VOICE_RULES[2].name, critical: false, pass: true, score: 1, density_pct: 0, evidence: 'no sentences (empty input)' };
  }
  const withDash = sentences.filter((s) => emDashCount(s) > 0).length;
  const density = withDash / sentences.length;
  // Floor at 0.30 because short artifacts may not statistically reach 40-50%.
  const pass = density >= 0.30;
  // Score scales: 0.30 → 0.6, 0.40 → 0.8, 0.50 → 1.0
  const score = Math.min(1, Math.max(0, (density - 0.10) / 0.40));
  return {
    rule: 2,
    name: VOICE_RULES[2].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    density_pct: Math.round(density * 100),
    sentence_count: sentences.length,
    sentences_with_dash: withDash,
    evidence: `${withDash}/${sentences.length} sentences carry an em-dash (${Math.round(density * 100)}%; target ≥30%, ideal 40-50%)`,
  };
}

export function checkSentenceLength(text) {
  // Register-aware caps (Phase 4.5 — 2026-05-23):
  //   avg ≤ 24 AND max ≤ 35                                       → PASS, score 1.0
  //   avg 24-28 OR max 35-50 (and < 20% of sentences > 50)        → WARN, score 0.7
  //   avg > 28 OR (max > 50 AND > 20% of sentences > 50)          → FAIL, score 0.4
  // Rationale: Mitchell's canonical exemplar (narrative-essay register) carries
  // 50-60 word sentences for rhythm; cv.md bullets are tight at 12-18 words.
  // The original hard cap of 35 over-penalized narrative-register prose.
  const sentences = sentencesOf(text);
  if (sentences.length === 0) {
    return { rule: 9, name: VOICE_RULES[9].name, critical: false, pass: true, score: 1, evidence: 'no sentences (empty input)' };
  }
  const lengths = sentences.map((s) => wordsOf(s).length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const max = Math.max(...lengths);
  const overCount = lengths.filter((n) => n > 35).length;
  const over50Count = lengths.filter((n) => n > 50).length;
  const over50Pct = over50Count / lengths.length;
  let pass;
  let score;
  if (avg <= 24 && max <= 35) {
    pass = true;
    score = 1;
  } else if (avg > 28 || (max > 50 && over50Pct > 0.20)) {
    pass = false;
    score = 0.4;
  } else {
    pass = false;
    score = 0.7;
  }
  return {
    rule: 9,
    name: VOICE_RULES[9].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    avg_words: Math.round(avg * 10) / 10,
    max_words: max,
    over_35_count: overCount,
    over_50_count: over50Count,
    sentence_count: sentences.length,
    evidence: `avg ${Math.round(avg * 10) / 10} words/sentence, longest ${max} words; ${overCount} sentence(s) > 35-word cap, ${over50Count} > 50-word cap (${Math.round(over50Pct * 100)}%)`,
  };
}

export function checkRootDiscipline(text) {
  // Look for repeated 6+ char roots within a sliding 50-word window.
  // Phase 4.5 (2026-05-23): exempt STOP_ROOTS + raised min-word-length from 5
  // to 6 chars + floor score at 0.5 (not 0). The original heuristic flagged
  // common words + proper nouns as "root repeats," producing 52 flags on a
  // 5394-char Mitchell essay. The intent is to catch genuine root-density
  // patterns ("transformation, transformative, transform"), not structural
  // reuse of stop-words or proper nouns.
  const words = wordsOf(text);
  if (words.length < 20) {
    return { rule: 3, name: VOICE_RULES[3].name, critical: false, pass: true, score: 1, evidence: 'too short to meaningfully evaluate (< 20 words)' };
  }
  const repeats = [];
  const seen = new Map(); // root → last-position
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length < 6) continue; // skip short common words (raised from 5)
    const root = w.slice(0, Math.min(w.length, 6));
    if (STOP_ROOTS.has(root)) continue; // skip exempted roots
    if (STOP_ROOTS.has(w)) continue;
    if (seen.has(root)) {
      const prev = seen.get(root);
      if (i - prev <= 50) {
        repeats.push({ root, at: i, prev_at: prev, distance: i - prev });
      }
    }
    seen.set(root, i);
  }
  const pass = repeats.length === 0;
  // Soft penalty: 1 repeat → 0.85, 2 → 0.7, 3 → 0.6, ≥4 → 0.5 floor.
  // Soft rule — never zero-scores even with many repeats, because root
  // discipline is a polish target not a hard quality boundary.
  const score = pass ? 1 : Math.max(0.5, 1 - repeats.length * 0.1);
  return {
    rule: 3,
    name: VOICE_RULES[3].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    repeats,
    evidence: pass ? 'no root-repeats within 50-word windows' : `${repeats.length} repeat(s): ${repeats.slice(0, 3).map((r) => `${r.root}@${r.prev_at}+${r.distance}`).join(', ')}`,
  };
}

export function checkMetricAnchoring(text) {
  const matches = [];
  for (const re of VAGUE_QUANTIFIERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  const pass = matches.length === 0;
  // Soft: every vague quantifier = -0.1 score
  const score = Math.max(0, 1 - matches.length * 0.1);
  return {
    rule: 4,
    name: VOICE_RULES[4].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    matches,
    evidence: pass ? 'no vague quantifiers detected' : `${matches.length} vague quantifier(s): ${matches.slice(0, 3).map((m) => m.match).join(', ')}`,
  };
}

export function checkSharedVision(text) {
  const matches = [];
  for (const re of FACTS_ONLY) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  const pass = matches.length === 0;
  const score = Math.max(0, 1 - matches.length * 0.2);
  return {
    rule: 7,
    name: VOICE_RULES[7].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    matches,
    evidence: pass ? 'no facts-only / declarative-certainty patterns' : `${matches.length} facts-only pattern(s): ${matches.slice(0, 3).map((m) => m.match).join(', ')}`,
  };
}

export function checkEarnedCloser(text) {
  const sentences = sentencesOf(text);
  if (sentences.length < 3) {
    return { rule: 5, name: VOICE_RULES[5].name, critical: false, pass: true, score: 1, evidence: 'too short to evaluate closer' };
  }
  // Inspect the last 2 sentences (the "closer") for declared-feeling patterns
  const closer = sentences.slice(-2).join(' ');
  const matches = [];
  for (const re of DECLARED_FEELING) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(closer)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  const pass = matches.length === 0;
  return {
    rule: 5,
    name: VOICE_RULES[5].name,
    critical: false,
    pass,
    score: pass ? 1 : 0.4,
    matches,
    closer_preview: closer.slice(0, 200),
    evidence: pass ? 'closer is structural, not declared-feeling' : `${matches.length} declared-feeling pattern(s) in last 2 sentences`,
  };
}

export function checkColloquialEmotion(text) {
  const matches = [];
  for (const re of ABSTRACT_EMOTION) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ match: m[0], offset: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  const pass = matches.length === 0;
  return {
    rule: 6,
    name: VOICE_RULES[6].name,
    critical: false,
    pass,
    score: pass ? 1 : Math.max(0.4, 1 - matches.length * 0.2),
    matches,
    evidence: pass ? 'no abstract-emotion patterns' : `${matches.length} abstract-emotion pattern(s): ${matches.slice(0, 3).map((m) => m.match).join(', ')}`,
  };
}

export function checkLeadArchitecture(text) {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) {
    return { rule: 1, name: VOICE_RULES[1].name, critical: false, pass: true, score: 1, evidence: 'no sentences (empty input)' };
  }
  const first = sentences[0];
  let throat = null;
  for (const re of THROAT_CLEAR_OPENERS) {
    if (re.test(first)) { throat = first.slice(0, 80); break; }
  }
  // Pass if first sentence doesn't open with throat-clearing AND is < 35 words.
  const wordCount = wordsOf(first).length;
  const pass = !throat && wordCount <= 35;
  let score = 1;
  if (throat) score -= 0.5;
  if (wordCount > 35) score -= 0.3;
  score = Math.max(0, score);
  return {
    rule: 1,
    name: VOICE_RULES[1].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    first_sentence_preview: first.slice(0, 200),
    first_sentence_words: wordCount,
    throat_clearing: throat,
    evidence: pass
      ? 'first sentence opens directly + ≤35 words'
      : `lead architecture issue: ${throat ? 'throat-clearing opener' : ''}${throat && wordCount > 35 ? ' + ' : ''}${wordCount > 35 ? `first sentence ${wordCount} words` : ''}`,
  };
}

export function checkSmartBrevity(text) {
  // Look at list-shaped paragraphs (lines starting with -, *, or 1.).
  // Smart Brevity expects: **bold lead** — one-line continuation, max 1 nest level.
  const lines = String(text || '').split(/\r?\n/);
  const bulletLines = lines.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l));
  if (bulletLines.length === 0) {
    return { rule: 8, name: VOICE_RULES[8].name, critical: false, pass: true, score: 1, evidence: 'no bullets present' };
  }
  let withBoldLead = 0;
  let withDashContinuation = 0;
  let overNested = 0;
  for (const line of bulletLines) {
    if (/^\s*([-*]|\d+\.)\s+\*\*.+\*\*/.test(line)) withBoldLead++;
    if (/\*\*.+\*\*\s+—/.test(line)) withDashContinuation++;
    // Check indent level — 2-space or deeper indent before bullet = nested
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (indent >= 4) overNested++;  // 4+ spaces = 2nd-level+
  }
  const total = bulletLines.length;
  const boldRatio = withBoldLead / total;
  const dashRatio = withDashContinuation / total;
  const pass = boldRatio >= 0.6 && overNested === 0;
  let score = (boldRatio * 0.6) + (dashRatio * 0.4);
  if (overNested > 0) score *= 0.5;
  return {
    rule: 8,
    name: VOICE_RULES[8].name,
    critical: false,
    pass,
    score: Math.round(score * 100) / 100,
    bullet_total: total,
    with_bold_lead: withBoldLead,
    with_dash_continuation: withDashContinuation,
    over_nested: overNested,
    evidence: `${withBoldLead}/${total} bullets have **bold lead**, ${withDashContinuation}/${total} use — continuation, ${overNested} over-nested`,
  };
}

// ── Roll-up ──────────────────────────────────────────────────────────────────

export function verdictForScore(score, criticalFailures) {
  if (criticalFailures && criticalFailures.length > 0) return 'FAIL';
  if (score >= 0.80) return 'PASS';
  if (score >= 0.60) return 'WARN';
  return 'FAIL';
}

/**
 * Full 12-rule programmatic voice-rules gate.
 *
 * @param {string} text  Artifact text to evaluate.
 * @returns {{
 *   text_length: number,
 *   rules: Record<string, object>,
 *   rollup: {
 *     verdict: 'PASS'|'WARN'|'FAIL',
 *     score: number,
 *     critical_failures: string[],
 *     soft_violations: string[],
 *     signal_quality: 'GOOD'|'WEAK'
 *   },
 *   checked_at: string
 * }}
 */
export function runVoiceRulesGate(text) {
  const t = String(text || '');
  const len = t.length;

  // Run all 12 rule checks
  const results = {
    1:  checkLeadArchitecture(t),
    2:  checkEmDashDensity(t),
    3:  checkRootDiscipline(t),
    4:  checkMetricAnchoring(t),
    5:  checkEarnedCloser(t),
    6:  checkColloquialEmotion(t),
    7:  checkSharedVision(t),
    8:  checkSmartBrevity(t),
    9:  checkSentenceLength(t),
    10: checkBannedVocab(t),
    11: checkHedgeWords(t),
    12: checkTherapySpeak(t),
  };

  // Weighted score + verdict rollup
  // Phase 4.5 (2026-05-23): a critical rule contributes to gate FAIL only when
  // it returns `critical_hit: true`. This lets density-aware critical rules
  // (rule_10 banned-vocab, rule_11 hedge-words) downgrade isolated occurrences
  // to WARN without hard-blocking the artifact. The therapy-speak rule still
  // contributes to FAIL on any-occurrence (set in checkTherapySpeak directly).
  // Soft rules continue to contribute via the weighted score only.
  let weightedSum = 0;
  let weightTotal = 0;
  const criticalFailures = [];
  const softViolations = [];
  for (const [id, result] of Object.entries(results)) {
    const w = VOICE_RULES[id].weight;
    weightedSum += result.score * w;
    weightTotal += w;
    if (VOICE_RULES[id].critical) {
      // Only count as critical-fail when the rule explicitly says critical_hit.
      // Fall back to !pass when the rule didn't set critical_hit (back-compat
      // for any rule that hasn't been upgraded to the density-aware shape).
      const isCriticalFail = result.critical_hit === true || (result.critical_hit === undefined && !result.pass);
      if (isCriticalFail) {
        criticalFailures.push(`rule_${id}_${result.name}`);
      } else if (!result.pass) {
        // Critical rule that flagged but didn't hit the critical threshold
        softViolations.push(`rule_${id}_${result.name}_warn`);
      }
    } else if (!result.pass) {
      softViolations.push(`rule_${id}_${result.name}`);
    }
  }
  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const verdict = verdictForScore(score, criticalFailures);
  const signalQuality = len < 200 ? 'WEAK' : 'GOOD';

  return {
    text_length: len,
    rules: results,
    rollup: {
      verdict,
      score: Math.round(score * 1000) / 1000,
      critical_failures: criticalFailures,
      soft_violations: softViolations,
      signal_quality: signalQuality,
    },
    checked_at: new Date().toISOString(),
  };
}
