/**
 * lib/employer-claims.mjs — deterministic employer-claim extraction + validation.
 *
 * Born 2026-06-10 from the row-2729 (Lovable) incident: the apply-pack generator
 * shipped a cover letter claiming Mitchell worked "At Replit" — with the TARGET
 * company's own growth metrics ("8M users, 50M+ projects, $400M ARR") recast as
 * personal history — plus anonymized variants ("a company on a similar growth
 * trajectory", "the fastest-growing software company on record") in
 * form-fields.md / one-pager.md. The numeric claim-consistency layer (which only
 * extracts %/$ /x/duration/count claims) had no employer concept, and the build's
 * verification subprocesses were being swallowed as warnings.
 *
 * This lib is the deterministic backstop (bug-class: llm-judge-soft-enforcement-
 * of-hard-rules): pure functions, no fs, no LLM. Consumers:
 *   - scripts/build-apply-packs.mjs  — in-process blocking tollbooth (PARTIAL halt)
 *   - scripts/claim-consistency.mjs  — 'employer' claim kind in the report + JSON
 *   - tests/apply-pack-fabricated-employer-invariant.test.mjs — regression suite
 *
 * Design notes (calibrated against the hand-corrected 2729-lovable pack, which
 * must pass clean):
 *   - An employer CLAIM is first-person + employment-verb phrasing tied to a
 *     named org ("At X, I led…", "I worked at X", "I've run … at X") or to a
 *     generic company descriptor ("I've run comms at a company on a similar
 *     growth trajectory" — anonymized fabrication; always a violation because
 *     it is unverifiable by construction; name the employer instead).
 *   - Company-context phrasing about the target company is NOT a claim:
 *     "At Lovable, you've built…", "At Lovable, I'd bring…" (prospective),
 *     "At Lovable, I was struck by…" (observational) all pass.
 *   - POSSESSIVE claims need no "at" (2026-06-11, row-2726 OpenAI incident:
 *     "I currently own OpenAI's end-to-end education strategy…" sailed past
 *     every at-anchored pattern). "I/we [currently] own/run/lead/manage
 *     <Company>'s <thing>" is an employment claim; so is "I currently <verb>
 *     <Company>'s <thing>" for any non-prospective, non-consumption verb.
 *     Consumption/deployment phrasing stays legal: "I run OpenAI's models
 *     locally", "I currently use OpenAI's APIs", "I led Hooli's rollout
 *     across our org". Prospective stays legal: "I want to own that full
 *     surface", "I'd own…", "I will own…".
 *   - The allowlist derives from cv.md's `## Experience` section at runtime
 *     (`**<Employer>** | <dates>` headers), so it tracks the canonical CV with
 *     zero hardcoded personal data in committed code. Fail-closed: a claim whose
 *     employer is not in the set is a violation; an unparseable cv.md yields an
 *     empty set, which callers must treat as a configuration failure.
 */

// First-person verbs that assert DOING WORK somewhere (past + present forms).
// Deliberately broad across fabrication phrasing space; unknown verbs after
// "At X, I …" default to PASS (observational fail-open) so legitimate cover
// letter phrasing ("At Lovable, I see / noticed / resonated…") never blocks.
const EMPLOYMENT_VERBS = new Set([
  'led', 'lead', 'ran', 'run', 'running', 'built', 'build', 'managed', 'manage',
  'oversaw', 'oversee', 'grew', 'grow', 'scaled', 'scale', 'shipped', 'ship',
  'launched', 'launch', 'drove', 'drive', 'driven', 'owned', 'own', 'created',
  'create', 'developed', 'develop', 'designed', 'design', 'architected',
  'wrote', 'write', 'written', 'produced', 'produce', 'delivered', 'deliver',
  'founded', 'headed', 'head', 'directed', 'direct', 'coordinated',
  'coordinate', 'spent', 'served', 'serve', 'joined', 'join', 'worked', 'work',
  'spearheaded', 'championed', 'drafted', 'draft', 'edited', 'edit', 'coached',
  'coach', 'mentored', 'mentor', 'hired', 'hire', 'recruited', 'briefed',
  'brief', 'ghostwrote', 'partnered', 'partner', 'reported', 'report',
  'earned', 'won', 'helped', 'help', 'supported', 'support', 'handled',
  'handle', 'established', 'maintained', 'maintain', 'operated', 'operate',
  'taught', 'teach', 'trained', 'train', 'organized', 'organize', 'presented',
  'present', 'contributed', 'contribute', 'turned', 'reduced', 'increased',
  'cut', 'doubled', 'tripled', 'embedded', 'pioneered', 'translated',
  'was', 'were',
]);

// Modal/stative openers after "At X, I…" that signal PROSPECTIVE or stative
// framing — never an employment claim. Contractions ('d, 'll, 'm, 're) are
// handled in the pattern itself.
const PROSPECTIVE_AUX = new Set([
  'would', 'will', 'can', 'could', 'may', 'might', 'should', 'hope', 'want',
  'plan', 'aim', 'intend', 'expect', 'look', 'bring', 'see', 'believe',
  'imagine', 'envision', 'propose', 'think', 'know', 'understand',
  'appreciate', 'admire', 'love', 'value', 'recognize',
]);

// Auxiliaries/adverbs to skip when hunting for the content verb.
const AUX_SKIP = new Set([
  'have', 'has', 'had', 'am', 'been', 'also', 'recently', 'previously',
  'formerly', 'proudly', 'personally', 'most', 'then', 'since', 'once',
]);

// After "I was …": observational/stative participles that do NOT claim
// employment ("I was struck/impressed/drawn…"). Anything else after was/were
// ("I was responsible/the/leading…") stays a claim — fail-closed on the
// ambiguous copula, fail-open only on known observational forms.
const OBSERVATIONAL_AFTER_WAS = new Set([
  'struck', 'impressed', 'drawn', 'excited', 'reminded', 'fascinated',
  'surprised', 'moved', 'energized', 'intrigued', 'inspired', 'hooked',
  'amazed', 'encouraged', 'heartened', 'captivated', 'curious', 'eager',
  'glad', 'happy', 'thrilled', 'delighted', 'lucky', 'fortunate', 'able',
  'watching', 'following', 'reading',
]);

// Capitalized-name phrase: "Replit", "Al Jazeera Media Network", "AJ+",
// "Cross-Google Engineering", "HuffPost Live". Connectors of/the/&/+ allowed
// inside; stops at lowercase words, punctuation, or sentence end.
const NAME_TOKEN = String.raw`[A-Z][\w&+.'’-]*`;
const NAME_PHRASE = `(${NAME_TOKEN}(?:\\s+(?:${NAME_TOKEN}|of|the|&)){0,4})`;

// Generic company descriptors — anonymized-employer claims. Deliberately
// excludes newsroom nouns (network/newsroom/show/program) so true anonymized
// news-career references stay legal; the fabrication surface skews to
// tech-company descriptors.
const GENERIC_COMPANY_NOUN = String.raw`(?:compan(?:y|ies)|startup|scale-?up|unicorn|firm|employer)`;

// Single generic words that must never become allowlist entries on their own
// (they'd make containment match unrelated orgs, e.g. bare "corporate" from
// "Corporate Engineering" would legitimize "at Corporate Widgets Inc").
const GENERIC_FRAGMENTS = new Set([
  'corporate', 'engineering', 'media', 'network', 'news', 'live', 'english',
  'america', 'american', 'communications', 'content', 'group', 'global',
]);

// Stewardship verbs that, when followed directly by "<Company>'s <thing>",
// assert control of that company's internal function — the row-2726 shape
// ("I currently own OpenAI's end-to-end education strategy") that the
// at-anchored patterns (P1-P3) all miss because no "at <Company>" appears.
// Present + past + gerund + 3rd-person forms, listed explicitly.
const POSSESSIVE_STEWARDSHIP_VERBS = new Set([
  'own', 'owns', 'owned', 'owning',
  'run', 'runs', 'ran', 'running',
  'lead', 'leads', 'led', 'leading',
  'manage', 'manages', 'managed', 'managing',
  'oversee', 'oversees', 'oversaw', 'overseeing',
  'head', 'heads', 'headed', 'heading',
  'direct', 'directs', 'directed', 'directing',
  'drive', 'drives', 'drove', 'driven', 'driving',
  'steer', 'steers', 'steered', 'steering',
  'shape', 'shapes', 'shaped', 'shaping',
  'define', 'defines', 'defined', 'defining',
  'set', 'sets', 'setting',
  'grow', 'grows', 'grew', 'growing',
  'scale', 'scales', 'scaled', 'scaling',
  'ship', 'ships', 'shipped', 'shipping',
  'launch', 'launches', 'launched', 'launching',
  'create', 'creates', 'created', 'creating',
  'design', 'designs', 'designed', 'designing',
  'architect', 'architects', 'architected', 'architecting',
  'write', 'writes', 'wrote', 'written', 'writing',
  'produce', 'produces', 'produced', 'producing',
  'deliver', 'delivers', 'delivered', 'delivering',
  'craft', 'crafts', 'crafted', 'crafting',
  'establish', 'establishes', 'established', 'establishing',
  'maintain', 'maintains', 'maintained', 'maintaining',
  'operate', 'operates', 'operated', 'operating',
  'build', 'builds', 'built', 'building',
  'rebuild', 'rebuilt', 'rebuilding',
  'transform', 'transforms', 'transformed', 'transforming',
  'revamp', 'revamps', 'revamped', 'revamping',
  'overhaul', 'overhauls', 'overhauled', 'overhauling',
  'spearhead', 'spearheads', 'spearheaded', 'spearheading',
  'champion', 'champions', 'championed', 'championing',
  'founded', 'founding', // bare "found" excluded: "I found OpenAI's docs helpful"
  'join', 'joins', 'joined', 'joining',
]);

// Verbs that CONSUME a company's public output rather than steward it —
// exempt on the broad currently-<verb> branch ("I currently use OpenAI's
// APIs", "I currently follow OpenAI's research"). Never an employment claim.
const POSSESSIVE_CONSUMPTION_VERBS = new Set([
  'use', 'uses', 'used', 'using',
  'follow', 'follows', 'followed', 'following',
  'track', 'tracks', 'tracked', 'tracking',
  'study', 'studies', 'studied', 'studying',
  'read', 'reads', 'reading',
  'watch', 'watches', 'watched', 'watching',
  'test', 'tests', 'tested', 'testing',
  'try', 'tries', 'tried', 'trying',
  'explore', 'explores', 'explored', 'exploring',
  'evaluate', 'evaluates', 'evaluated', 'evaluating',
  'review', 'reviews', 'reviewed', 'reviewing',
  'integrate', 'integrates', 'integrated', 'integrating',
  'adopt', 'adopts', 'adopted', 'adopting',
  'deploy', 'deploys', 'deployed', 'deploying',
  'recommend', 'recommends', 'recommended', 'recommending',
  'prefer', 'prefers', 'preferred',
  'cite', 'cites', 'cited', 'citing',
  'quote', 'quotes', 'quoted', 'quoting',
  'reference', 'references', 'referenced', 'referencing',
  'leverage', 'leverages', 'leveraged', 'leveraging',
]);

// Possessed-phrase heads that signal consuming/deploying the company's PUBLIC
// product, not running an internal function: "I run OpenAI's models locally",
// "I led Hooli's rollout across our 400-person org" are customer sentences.
// The lookahead keeps function phrases claimable: "API strategy", "docs team",
// "platform org" all still flag.
const PRODUCT_CONSUMPTION_HEAD =
  String.raw`(?:apis?|sdks?|models?|tools?|products?|platform|playground|features?|tech(?:nology)?|betas?|waitlists?|adoption|usage|uptake|rollouts?|integrations?|deployments?)`;
const FUNCTION_FOLLOWER =
  String.raw`(?:teams?|strateg(?:y|ies)|programs?|roadmaps?|orgs?|organizations?|functions?|curriculum|charter|education|enablement|operations|ops|comms|communications|brand|voice|messaging|narrative|content|story|positioning|divisions?|departments?|groups?)`;

// Person-subject story nouns: "I produced Jenna Miscavige Hill's on-record
// break with Scientology" is a producer credit over a STORY SUBJECT, not an
// employment claim — no employer-claim sentence possesses these heads ("I
// produced CNN's on-record break" is not a sentence anyone writes).
// Deliberately narrow: coverage / segment / interview / story stay flaggable
// because orgs DO possess those in true employment claims ("I produced
// MSNBC's coverage"). Surfaced 2026-06-12 by the row-49-era OpenAI pack.
const PERSON_STORY_HEAD =
  /^(?:on-record\s+|on-camera\s+|on-air\s+|first\s+|public\s+)?(?:break|sit-downs?|testimony|defection|coming[- ]out)\b/i;

// Adverbs/auxiliaries legal between the first-person subject and the content
// verb in possessive claims. Deliberately EXCLUDES prospective chains — "I
// want to own…" / "I will own…" never match because "want"/"will" land in the
// verb slot instead and fail the stewardship test.
const POSSESSIVE_ADVERB_SKIP =
  String.raw`(?:(?:currently|presently|now|still|also|recently|previously|formerly|proudly|personally|again|been|just)\s+)*`;

function freshRe(source, flags) {
  return new RegExp(source, flags);
}

/** Normalize an org name for set membership: lowercase, collapse whitespace,
 *  strip trailing possessive + surrounding punctuation. */
export function normalizeEmployerName(name) {
  return String(name || '')
    .replace(/[’']s\b/g, '')
    .replace(/["“”()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

/**
 * Parse the employer allowlist from master cv.md text.
 * Scope: `## Experience` section only (so "BA, Journalism | Indiana University"
 * under Education and project-section org mentions never widen the set).
 * Header shape: `**Google — Cross-Google Engineering (xGE)**  |  June 2024 – present`
 * → fragments: google / cross-google engineering / xge (split on — – · | , and
 * parentheses/quotes), plus a small alias expansion for known org families.
 * Returns Set<string> of normalized names (empty Set when nothing parses —
 * callers MUST fail closed on an empty set).
 */
export function parseCvEmployers(cvText) {
  const out = new Set();
  const text = String(cvText || '');
  const expStart = text.search(/^##\s+Experience\b/m);
  if (expStart === -1) return out;
  const rest = text.slice(expStart);
  const nextSection = rest.slice(2).search(/^##\s+/m);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection + 2);

  const headerRe = /^\*\*(.+?)\*\*\s*\|/gm;
  let m;
  while ((m = headerRe.exec(section)) !== null) {
    const rawName = m[1];
    // Pull quoted show names ("The Stream") and parentheticals (xGE, Al
    // Jazeera Media Network) out as their own fragments first.
    const fragments = [];
    const quoted = rawName.match(/["“]([^"“”]+)["”]/g) || [];
    for (const q of quoted) fragments.push(q);
    const parens = rawName.match(/\(([^)]+)\)/g) || [];
    for (const p of parens) {
      for (const piece of p.slice(1, -1).split('/')) fragments.push(piece);
    }
    const outer = rawName.replace(/\([^)]*\)/g, ' ').replace(/["“][^"“”]*["”]/g, ' ');
    for (const piece of outer.split(/\s*(?:—|–|·|\||,)\s*/)) fragments.push(piece);

    for (const frag of fragments) {
      let norm = normalizeEmployerName(frag);
      // Drop org-form suffixes that aren't names on their own.
      norm = norm.replace(/\b(?:jv|inc|llc|ltd)\b\.?$/g, '').trim();
      if (norm.length >= 2 && !(GENERIC_FRAGMENTS.has(norm))) out.add(norm);
      // "ABC News / Univision JV" → keep the bare first word too when the
      // fragment is "<Name> <orgword>" (univision, huffpost).
      const first = norm.split(' ')[0];
      if (first && first.length >= 4 && first !== norm && !GENERIC_FRAGMENTS.has(first)) out.add(first);
    }
  }

  // Alias expansion for known families (only when the family is present).
  const all = [...out].join(' | ');
  if (/al jazeera/.test(all)) { out.add('al jazeera'); out.add('aje'); }
  if (/cctv/.test(all)) out.add('cctv');
  if (/huffpost/.test(all)) out.add('huffpost');
  if (/\bgoogle\b/.test(all)) out.add('google');
  return out;
}

/** Word-bounded substring test on normalized names. */
function containsWord(haystack, needle) {
  if (needle.length < 3) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return freshRe(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, 'i').test(` ${haystack} `);
}

/** Is the claimed employer covered by the allowlist (exact or word-bounded
 *  containment in either direction)? */
export function isAllowedEmployer(claimedName, allowedEmployers) {
  if (!allowedEmployers || allowedEmployers.size === 0) return false;
  const norm = normalizeEmployerName(claimedName).replace(/^the\s+/, '');
  if (!norm) return false;
  if (allowedEmployers.has(norm)) return true;
  for (const e of allowedEmployers) {
    if (e.length >= 3 && (containsWord(norm, e) || containsWord(e, norm))) return true;
  }
  return false;
}

/** Walk the tokens after "I/we", skipping auxiliaries, and classify the first
 *  content token. Returns 'prospective' | 'employment' | 'other'. */
function classifyVerbTokens(tokens) {
  let prevWasCopula = false;
  for (const t0 of tokens) {
    const t = t0.toLowerCase().replace(/[^a-z'’]/g, '');
    if (!t) continue;
    if (AUX_SKIP.has(t)) continue;
    if (prevWasCopula) {
      return OBSERVATIONAL_AFTER_WAS.has(t) ? 'prospective' : 'employment';
    }
    if (PROSPECTIVE_AUX.has(t)) return 'prospective';
    if (t === 'was' || t === 'were') { prevWasCopula = true; continue; }
    return EMPLOYMENT_VERBS.has(t) ? 'employment' : 'other';
  }
  // "I was." at a window edge — ambiguous copula with no complement: claim.
  return prevWasCopula ? 'employment' : 'other';
}

/**
 * Extract employer-like claims from prose. Returns
 *   [{ raw, employer, pattern: 'at-x-first-person'|'worked-at'|'verb-at'|
 *      'generic-descriptor'|'possessive-stewardship'|'currently-possessive' }]
 * Deduped on (employer, raw).
 */
export function extractEmployerClaims(text) {
  const claims = [];
  const src = String(text || '');

  // P1 — "At <X>, I/we <verb>…" (employment-context sentence opener).
  const p1 = freshRe(
    String.raw`\b[Aa]t\s+` + NAME_PHRASE +
    String.raw`\s*,?\s+(I|[Ww]e)(?:['’](d|ll|m|re|ve))?((?:\s+[\w'’-]+){1,5})`,
    'g'
  );
  let m;
  while ((m = p1.exec(src)) !== null) {
    const [, employer, , contraction, tail] = m;
    if (contraction && contraction !== 've') continue; // I'd / I'll / I'm / we're → prospective/stative
    const verdict = classifyVerbTokens(tail.trim().split(/\s+/));
    if (verdict === 'employment') {
      claims.push({ raw: m[0].trim(), employer, pattern: 'at-x-first-person' });
    }
  }

  // P2 — explicit employment phrasing: "I worked at X", "my time at X",
  // "while at X", "when I was at X", "I joined X". Unconditional claims.
  const p2 = freshRe(
    String.raw`\b(?:I\s+(?:previously\s+|formerly\s+|most\s+recently\s+|currently\s+)?work(?:ed)?\s+at|` +
    String.raw`I\s+was\s+(?:employed\s+(?:at|by)|at|with)|I\s+(?:serve|served)\s+at|I\s+interned\s+at|` +
    String.raw`[Mm]y\s+(?:time|years?|tenure|role|stint|work)\s+at|[Ww]hile\s+at|` +
    String.raw`[Ww]hen\s+I\s+(?:was|joined|worked)(?:\s+at)?|I\s+joined)\s+` + NAME_PHRASE,
    'g'
  );
  while ((m = p2.exec(src)) !== null) {
    claims.push({ raw: m[0].trim(), employer: m[1], pattern: 'worked-at' });
  }

  // P3 — "I('ve) <employment-verb> … at <X>" within one sentence.
  const p3 = freshRe(
    String.raw`\bI(?:['’]ve|\s+have|\s+had)?\s+(?:also\s+|recently\s+|previously\s+)?([\w'’-]+)` +
    String.raw`([^.\n!?]{0,80}?)\s[Aa]t\s+` + NAME_PHRASE,
    'g'
  );
  while ((m = p3.exec(src)) !== null) {
    const verb = m[1].toLowerCase().replace(/[^a-z]/g, '');
    if (!EMPLOYMENT_VERBS.has(verb) || verb === 'was' || verb === 'were') continue;
    claims.push({ raw: m[0].trim(), employer: m[3], pattern: 'verb-at' });
  }

  // P4 — anonymized employer: "I('ve) <employment-verb> … at a/the …
  // company/startup/…". Always a violation (unverifiable by construction).
  const p4 = freshRe(
    String.raw`\bI(?:['’]ve|\s+have|\s+had)?\s+(?:also\s+|recently\s+|previously\s+)?([\w'’-]+)` +
    String.raw`([^.\n!?]{0,80}?)\s[Aa]t\s+((?:a|an|the)\s+(?:[\w'’-]+[\s,]+){0,8}?` + GENERIC_COMPANY_NOUN + String.raw`\b[^.\n!?]{0,40})`,
    'gi'
  );
  while ((m = p4.exec(src)) !== null) {
    const verb = m[1].toLowerCase().replace(/[^a-z]/g, '');
    if (!EMPLOYMENT_VERBS.has(verb) || verb === 'was' || verb === 'were') continue;
    claims.push({ raw: m[0].trim(), employer: `(anonymized) ${m[3].trim()}`, pattern: 'generic-descriptor' });
  }

  // P5 — possessive stewardship: "I/We [currently|now|…] own/run/lead/manage
  // <Company>'s <thing>". First-person employment claim with no "at <X>"
  // anywhere — the row-2726 OpenAI shape. P6 (same regex, broad branch) — a
  // present-tense marker (currently/presently/now/still) upgrades ANY
  // non-prospective, non-consumption verb into a claim: "I currently
  // orchestrate <Company>'s launch communications".
  const pPossessive = freshRe(
    String.raw`\b(?:I|[Ww]e)(?:['’](?:m|ve)|\s+(?:am|have))?\s+` +
    `(${POSSESSIVE_ADVERB_SKIP})` +
    String.raw`([\w'’-]+)\s+` + NAME_PHRASE + String.raw`['’]s\s+([\w'’&-]+(?:\s+[\w'’&-]+){0,5})`,
    'g'
  );
  while ((m = pPossessive.exec(src)) !== null) {
    const [, adverbs, verbRaw, employer, possessed] = m;
    const verb = verbRaw.toLowerCase().replace(/[^a-z]/g, '');
    if (PROSPECTIVE_AUX.has(verb) || AUX_SKIP.has(verb) || verb === 'was' || verb === 'were') continue;
    const steward = POSSESSIVE_STEWARDSHIP_VERBS.has(verb);
    const presentMarker = /\b(?:currently|presently|now|still)\b/i.test(adverbs);
    if (!steward && !presentMarker) continue;
    if (!steward && POSSESSIVE_CONSUMPTION_VERBS.has(verb)) continue;
    // Product-consumption guard (both branches): possessed phrase headed by a
    // public-product/deployment noun — and NOT a function phrase like "API
    // strategy" / "docs team" — is customer phrasing, not employment.
    const head = possessed.trim();
    if (freshRe(`^${PRODUCT_CONSUMPTION_HEAD}\\b(?!\\s+${FUNCTION_FOLLOWER}\\b)`, 'i').test(head)) continue;
    // Person-subject story-noun guard: producer credit over a story subject
    // ("<Person>'s on-record break / sit-down / testimony"), never employment.
    if (PERSON_STORY_HEAD.test(head)) continue;
    claims.push({
      raw: m[0].trim(),
      employer,
      pattern: steward ? 'possessive-stewardship' : 'currently-possessive',
    });
  }

  // Dedupe on employer+raw.
  const seen = new Set();
  return claims.filter(c => {
    const k = `${normalizeEmployerName(c.employer)}|${c.raw}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Violations = extracted claims whose employer is not in the allowlist, plus
 * every generic-descriptor claim. Empty array = text is clean.
 */
export function findEmployerViolations(text, { allowedEmployers } = {}) {
  return extractEmployerClaims(text).filter(c =>
    c.pattern === 'generic-descriptor' || !isAllowedEmployer(c.employer, allowedEmployers)
  );
}
