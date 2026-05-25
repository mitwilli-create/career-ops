/**
 * ATS keyword-alignment sub-check for the pre-apply orchestrator.
 *
 * Contract:
 *   export async function atsCheck({ slug, jdText, artifacts, opts }) => Promise<{
 *     status: 'pass' | 'caveats' | 'fail' | 'unavailable',
 *     score: number | null,
 *     matched_keywords: string[],
 *     missing_keywords: string[],
 *     synonyms_detected: { keyword: string, synonym: string }[],
 *     format_issues: string[],
 *     error?: string,
 *   }>
 *
 * This module is pure and deterministic: it performs no file I/O, network calls,
 * or LLM calls. It extracts load-bearing JD keywords, scores exact overlap
 * against provided apply-pack artifacts, reports informational synonym coverage,
 * and applies lightweight ATS format heuristics to the CV artifact.
 */

const STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
  'we', 'our', 'us', 'they', 'them', 'their', 'be', 'been', 'being', 'do', 'does', 'did', 'doing',
  'can', 'could', 'should', 'would', 'may', 'might', 'must', 'shall', 'so', 'if', 'then', 'than',
  'but', 'not', 'no', 'nor', 'because', 'about', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'under', 'over', 'again', 'further', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'one', 'two', 'three', 'i',
  'me', 'my', 'who', 'whom', 'which', 'what', 'these', 'those', 'am', 'doesn', 'don', 'didn',
  'haven', 'isn', 'wasn', 'weren', 'won', 'wouldn', 'couldn', 'shouldn', 'aren', 'shan',
  'role', 'work', 'team', 'company', 'job', 'position', 'opportunity', 'candidate', 'experience',
]));

const SYNONYM_MAP = Object.freeze({
  aws: Object.freeze(['amazon web services']),
  gcp: Object.freeze(['google cloud platform']),
  ml: Object.freeze(['machine learning']),
  pm: Object.freeze(['program manager', 'product manager']),
  cv: Object.freeze(['resume']),
  llm: Object.freeze(['large language model']),
  api: Object.freeze(['application programming interface']),
  ai: Object.freeze(['artificial intelligence']),
});

const DEFAULTS = Object.freeze({
  top: 20,
  threshold_pass: 0.85,
  threshold_caveats: 0.60,
  cv_min_chars: 800,
  cv_max_chars: 3500,
});

function unavailable(error) {
  return {
    status: 'unavailable',
    score: null,
    matched_keywords: [],
    missing_keywords: [],
    synonyms_detected: [],
    format_issues: [],
    error,
  };
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInteger(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeOpts(opts = {}) {
  const source = opts && typeof opts === 'object' ? opts : {};
  return {
    top: toPositiveInteger(source.top, DEFAULTS.top),
    threshold_pass: toFiniteNumber(source.threshold_pass, DEFAULTS.threshold_pass),
    threshold_caveats: toFiniteNumber(source.threshold_caveats, DEFAULTS.threshold_caveats),
    cv_min_chars: Math.max(0, Math.floor(toFiniteNumber(source.cv_min_chars, DEFAULTS.cv_min_chars))),
    cv_max_chars: Math.max(0, Math.floor(toFiniteNumber(source.cv_max_chars, DEFAULTS.cv_max_chars))),
  };
}

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^[-/]+|[-/]+$/g, ''))
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !STOPWORDS.has(t));
}

function nGrams(tokens, maxN = 3) {
  const cleanTokens = Array.isArray(tokens) ? tokens.map((t) => String(t ?? '')).filter(Boolean) : [];
  const grams = [];

  for (const n of [1, 2, 3].filter((value) => value <= maxN)) {
    if (cleanTokens.length < n) continue;

    for (let i = 0; i <= cleanTokens.length - n; i += 1) {
      grams.push(cleanTokens.slice(i, i + n).join(' '));
    }
  }

  return grams;
}

function extractKeywordCandidates(jdText, top = DEFAULTS.top) {
  const tokens = tokenize(jdText);
  const grams = nGrams(tokens, 3);
  const counts = new Map();

  for (const gram of grams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .slice(0, top)
    .map(([keyword]) => keyword);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordAppears(haystackLower, keyword) {
  const needle = String(keyword ?? '').toLowerCase().trim();
  if (!needle) return false;

  const escaped = escapeRegExp(needle);

  try {
    if (/^[a-z0-9]+(?:[ -/][a-z0-9]+)*$/i.test(needle)) {
      const boundaryPattern = new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i');
      if (boundaryPattern.test(haystackLower)) return true;
    }
  } catch {
    return haystackLower.includes(needle);
  }

  return haystackLower.includes(needle);
}

function scoreOverlap(jdText, artifactText, top = DEFAULTS.top) {
  const keywords = extractKeywordCandidates(jdText, top);
  const artifactLower = String(artifactText ?? '').toLowerCase();
  const matched_keywords = [];
  const missing_keywords = [];

  for (const keyword of keywords) {
    if (keywordAppears(artifactLower, keyword)) {
      matched_keywords.push(keyword);
    } else {
      missing_keywords.push(keyword);
    }
  }

  const score = keywords.length === 0 ? 0 : matched_keywords.length / keywords.length;

  return {
    score,
    matched_keywords,
    missing_keywords,
  };
}

function detectSynonyms(missingKeywords, artifactText) {
  const artifactLower = String(artifactText ?? '').toLowerCase();
  const missing = Array.isArray(missingKeywords) ? missingKeywords : [];
  const detections = [];
  const seen = new Set();

  for (const rawKeyword of missing) {
    const keyword = String(rawKeyword ?? '').toLowerCase().trim();
    if (!keyword) continue;

    const directSynonyms = SYNONYM_MAP[keyword] ?? [];
    for (const synonym of directSynonyms) {
      if (keywordAppears(artifactLower, synonym)) {
        const key = `${keyword}\u0000${synonym}`;
        if (!seen.has(key)) {
          seen.add(key);
          detections.push({ keyword, synonym });
        }
      }
    }

    for (const [abbr, expandedList] of Object.entries(SYNONYM_MAP)) {
      if (!expandedList.some((expanded) => expanded.toLowerCase() === keyword)) continue;

      if (keywordAppears(artifactLower, abbr)) {
        const key = `${keyword}\u0000${abbr}`;
        if (!seen.has(key)) {
          seen.add(key);
          detections.push({ keyword, synonym: abbr });
        }
      }
    }
  }

  return detections;
}

function hasContactLine(cvText) {
  const lines = String(cvText ?? '').split(/\r?\n/);
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  return lines.some((line) => {
    if (emailRegex.test(line)) return true;

    const trimmed = line.trim();
    const hasPhoneishPrefix = /\+[\d\s().-]{7,}/.test(trimmed);
    const digitsOnly = trimmed.replace(/[^\d]/g, '');

    return (hasPhoneishPrefix || /[\d][\d\s().-]{6,}/.test(trimmed)) && digitsOnly.length >= 7;
  });
}

function hasMarkdownTableSeparator(cvText) {
  return String(cvText ?? '')
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
    });
}

function chooseCvArtifact(artifacts) {
  const source = artifacts && typeof artifacts === 'object' ? artifacts : {};

  if (typeof source.cv === 'string') {
    return { name: 'cv', text: source.cv, present: true };
  }

  if (typeof source.cv_tailored === 'string') {
    return { name: 'cv_tailored', text: source.cv_tailored, present: true };
  }

  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      return { name, text: value, present: false };
    }
  }

  return { name: null, text: '', present: false };
}

function scanFormatIssues(artifacts, opts = {}) {
  const options = normalizeOpts(opts);
  const issues = [];
  const chosen = chooseCvArtifact(artifacts);

  if (!chosen.present) {
    issues.push('No CV artifact provided');
  }

  if (!chosen.text) {
    return issues;
  }

  const cvText = String(chosen.text);
  const length = cvText.length;

  if (length < options.cv_min_chars) {
    issues.push(`CV too short (<${options.cv_min_chars} chars)`);
  }

  if (length > options.cv_max_chars) {
    issues.push(`CV too long (>${options.cv_max_chars} chars)`);
  }

  if (!hasContactLine(cvText)) {
    issues.push('No contact line (email or phone) detected');
  }

  if (/!\[[^\]]*]\([^)]*\)/.test(cvText)) {
    issues.push('Contains markdown images (ATS may reject)');
  }

  if (hasMarkdownTableSeparator(cvText)) {
    issues.push('Contains markdown tables (ATS may misparse)');
  }

  return issues;
}

function collectArtifactStrings(artifacts) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return [];
  }

  return Object.values(artifacts)
    .filter((value) => typeof value === 'string')
    .map((value) => String(value));
}

export async function atsCheck({ slug, jdText, artifacts, opts } = {}) {
  try {
    const options = normalizeOpts(opts);
    const diagnosticSlug = typeof slug === 'string' && slug.trim() ? slug.trim() : 'unknown-slug';
    const jd = String(jdText ?? '');

    if (!jd.trim()) {
      return unavailable(`ATS check unavailable for ${diagnosticSlug}: empty job description text`);
    }

    const artifactStrings = collectArtifactStrings(artifacts);
    const nonEmptyArtifactStrings = artifactStrings.filter((value) => value.trim());

    if (nonEmptyArtifactStrings.length === 0) {
      return unavailable(`ATS check unavailable for ${diagnosticSlug}: no string artifact text provided`);
    }

    const artifactText = artifactStrings.join('\n');
    const { score, matched_keywords, missing_keywords } = scoreOverlap(jd, artifactText, options.top);
    const synonyms_detected = detectSynonyms(missing_keywords, artifactText);
    const format_issues = scanFormatIssues(artifacts, options);

    const status = score >= options.threshold_pass
      ? 'pass'
      : score >= options.threshold_caveats
        ? 'caveats'
        : 'fail';

    return {
      status,
      score,
      matched_keywords,
      missing_keywords,
      synonyms_detected,
      format_issues,
    };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    return unavailable(`atsCheck failed: ${message}`);
  }
}

export const _internal = Object.freeze({
  tokenize,
  nGrams,
  scoreOverlap,
  detectSynonyms,
  scanFormatIssues,
});