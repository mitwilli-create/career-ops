/**
 * lib/surface-alias-detector.mjs — L5 detector for cross-surface duplicate
 * evaluations.
 *
 * Called from triage.mjs after quickScoreRouted returns ADVANCE, BEFORE the
 * URL gets written to batch/triage-advance.tsv. If the detector confirms
 * the URL is a different surface of an already-evaluated canonical row in
 * applications.md, the URL is recorded as a surface-alias + the eval $ is
 * never spent.
 *
 * Detection layers (in order, short-circuit on first hit):
 *   1. EXACT match — normalized-company + variant-safe role-equal against
 *      every LIVE row in applications.md. Same matcher contract as L4
 *      invariant test + merge-tracker.mjs::roleFuzzyMatch + dedup-tracker.mjs.
 *      Cost: $0. Confidence: 1.0.
 *   2. FUZZY candidates — same company, fuzzy role match (token-overlap with
 *      stopword filter). If candidates exist, dispatch one Sonnet 4.6 call
 *      asking "which (if any) is the same role". Cost: ~$0.005/candidate-set.
 *      Confidence: returned by Sonnet (must clear L5_CONFIDENCE_THRESHOLD).
 *   3. NO MATCH — proceed to eval normally.
 *
 * Cost guard:
 *   L5_DAILY_USD_CAP (default $5) — Sonnet spend tracked at
 *   data/l5-spend-<YYYY-MM-DD>.json. On exhaustion, fall back to layer 1
 *   only (strict-equal). Layer 2 short-circuits to NO MATCH.
 *
 * Kill switch:
 *   L5_ENABLED=false → detector returns {match: null, method: 'disabled'}
 *   immediately. No reads, no writes, no cost.
 *
 * L5 of the 2026-05-27 dedupe-defense PR sequence (#308 → #310).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseApplicationsFile } from './parse-applications.mjs';
import { callCouncil } from './council.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_PATH = join(ROOT, 'data', 'applications.md');

const ENABLED = String(process.env.L5_ENABLED ?? 'true').toLowerCase() !== 'false';
const DAILY_USD_CAP = Number(process.env.L5_DAILY_USD_CAP ?? '5');
const SONNET_TIMEOUT_MS = Number(process.env.L5_SONNET_TIMEOUT_MS ?? '30000');
const CONFIDENCE_THRESHOLD = Number(process.env.L5_CONFIDENCE_THRESHOLD ?? '0.85');
const SONNET_MODEL = 'anthropic:claude-sonnet-4-6';

const LIVE_RE = /^(evaluated|applied|responded|interview|offer|evaluada|aplicado|respondido|entrevista|oferta)$/i;

function normCompany(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Variant-safe role equality — same contract as merge-tracker.mjs +
 * dedup-tracker.mjs + tests/applications-dedupe-invariant.test.mjs.
 * Comma-qualifier guard prevents Industries↔Commercial collapse.
 */
export function variantSafeRoleEqual(a, b) {
  const normA = String(a || '').trim().toLowerCase();
  const normB = String(b || '').trim().toLowerCase();
  if (normA === normB) return true;
  const hasCommaA = normA.includes(',');
  const hasCommaB = normB.includes(',');
  if (hasCommaA || hasCommaB) {
    if (hasCommaA !== hasCommaB) return false;
    const qualA = normA.split(',').slice(1).join(',').trim();
    const qualB = normB.split(',').slice(1).join(',').trim();
    if (qualA !== qualB) return false;
    const baseA = normA.split(',')[0].trim();
    const baseB = normB.split(',')[0].trim();
    return baseA === baseB;
  }
  return false;
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite', 'engineer', 'engineering',
]);
const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 /]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));
}

/** Fuzzy role match — token-overlap ratio ≥ 0.6 AND ≥ 2 shared tokens. */
export function fuzzyRoleMatch(a, b) {
  const wA = tokenize(a);
  const wB = tokenize(b);
  if (!wA.length || !wB.length) return false;
  const setB = new Set(wB);
  const overlap = wA.filter((w) => setB.has(w));
  if (overlap.length < 2) return false;
  const minLen = Math.min(wA.length, wB.length);
  return overlap.length / minLen >= 0.6;
}

// ─────────────── Spend tracking ─────────────────────────────────

function _spendPath() {
  const date = new Date().toISOString().slice(0, 10);
  return join(ROOT, 'data', `l5-spend-${date}.json`);
}

function loadSpend() {
  const path = _spendPath();
  if (!existsSync(path)) return { date: new Date().toISOString().slice(0, 10), usd: 0, calls: 0 };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { date: new Date().toISOString().slice(0, 10), usd: 0, calls: 0 };
  }
}

function recordSpend(usd) {
  const path = _spendPath();
  const cur = loadSpend();
  cur.usd = Number(((cur.usd || 0) + (usd || 0)).toFixed(6));
  cur.calls = (cur.calls || 0) + 1;
  cur.date = new Date().toISOString().slice(0, 10);
  const tmp = path + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(cur, null, 2));
  renameSync(tmp, path);
  return cur;
}

function spendCapExceeded() {
  const cur = loadSpend();
  return cur.usd >= DAILY_USD_CAP;
}

// ─────────────── Sonnet confirmation ─────────────────────────────

function _candidateLines(candidates) {
  return candidates
    .map((c, i) => `[${i + 1}] num=${c.num}  role="${c.role}"  status=${c.status}  score=${c.score}`)
    .join('\n');
}

/**
 * Ask Sonnet whether the new (title, company) refers to the same role as
 * any of the existing candidates. Returns:
 *   { match_num: '2594'|null, confidence: 0-1, reasoning: '...' }
 *
 * Best-effort: on parse failure, returns {match_num: null, confidence: 0}.
 */
async function sonnetConfirm({ title, company, candidates }) {
  const prompt = `You are deduplicating job postings across surfaces (LinkedIn / Greenhouse / Ashby / company site). Two postings are the SAME ROLE when the company is identical AND the role description maps to the same position (different surfaces of the same opening).

NEW posting:
  company: "${company}"
  role: "${title}"

EXISTING evaluated postings at the same company:
${_candidateLines(candidates)}

Task: identify which (if any) existing posting is the SAME role as the new posting.

Rules:
- "Senior X" vs "Sr X" vs "Sr. X" with otherwise identical role → SAME.
- "X, Industries" vs "X, Commercial" → DIFFERENT (qualifier semantic).
- "X" vs "X (San Francisco)" → SAME (location parenthetical is surface noise).
- "X" vs "Senior Staff X" → DIFFERENT (seniority is a real distinction at this tier).
- When uncertain, return null. False positives cost a real role; false negatives only cost a re-evaluation.

Output STRICT JSON, no prose:
{"match_num": "<num>" | null, "confidence": 0.0-1.0, "reasoning": "<one short sentence>"}`;

  let usdCost = 0;
  try {
    const result = await callCouncil({
      prompt,
      models: [SONNET_MODEL],
      opts: {
        timeoutMs: SONNET_TIMEOUT_MS,
        maxTokens: 200,
        caller: 'surface-alias-detector',
      },
    });
    const r = result?.responses?.[0];
    if (r?.content && typeof r.content === 'string') {
      const m = r.content.match(/\{[\s\S]*?\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        usdCost = Number(r.cost_usd || 0);
        recordSpend(usdCost);
        return {
          match_num: parsed.match_num ?? null,
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
          reasoning: String(parsed.reasoning || '').slice(0, 200),
          cost_usd: usdCost,
        };
      }
    }
  } catch (err) {
    // Best-effort: never fail the calling triage flow.
    return { match_num: null, confidence: 0, reasoning: `sonnet-error: ${err.message}`, cost_usd: 0 };
  }
  return { match_num: null, confidence: 0, reasoning: 'sonnet-parse-failure', cost_usd: 0 };
}

// ─────────────── Public detector ─────────────────────────────────

/**
 * Detect whether the new (title, company, url) is a surface-alias of an
 * existing canonical row in applications.md.
 *
 * Returns:
 *   { match: '<num>'|null, method, confidence, reasoning?, cost_usd? }
 *
 * Method values:
 *   'disabled'              — L5_ENABLED=false (kill switch)
 *   'no-candidates'         — no LIVE rows at this company
 *   'exact-equal'           — variant-safe role-equal hit (confidence 1.0)
 *   'sonnet-confirmed-fuzzy'— Sonnet confirmed at ≥ threshold confidence
 *   'sonnet-rejected'       — Sonnet ran but confidence < threshold
 *   'sonnet-no-match'       — Sonnet returned null match
 *   'fuzzy-no-candidates'   — strict failed + no fuzzy candidates either
 *   'cap-exceeded-fallback' — daily Sonnet cap hit; ran strict only
 *   'no-match'              — nothing matched
 */
export async function detectSurfaceAlias({ title, company, url }, opts = {}) {
  if (!ENABLED) {
    return { match: null, method: 'disabled', confidence: 0 };
  }
  if (!title || !company) {
    return { match: null, method: 'no-input', confidence: 0 };
  }

  const appsPath = opts.appsPath || APPS_PATH;
  if (!existsSync(appsPath)) {
    return { match: null, method: 'no-apps-md', confidence: 0 };
  }
  const apps = parseApplicationsFile(appsPath);
  const liveAtCompany = apps.filter(
    (a) => normCompany(a.company) === normCompany(company) && LIVE_RE.test((a.status || '').trim()),
  );
  if (!liveAtCompany.length) {
    return { match: null, method: 'no-candidates', confidence: 0 };
  }

  // Layer 1: strict variant-safe role-equal
  for (const c of liveAtCompany) {
    if (variantSafeRoleEqual(title, c.role)) {
      return { match: String(c.num), method: 'exact-equal', confidence: 1.0 };
    }
  }

  // Layer 2: fuzzy candidates → Sonnet confirmation (gated by daily cap)
  const fuzzy = liveAtCompany.filter((c) => fuzzyRoleMatch(title, c.role));
  if (!fuzzy.length) {
    return { match: null, method: 'fuzzy-no-candidates', confidence: 0 };
  }

  if (spendCapExceeded()) {
    return {
      match: null,
      method: 'cap-exceeded-fallback',
      confidence: 0,
      reasoning: `L5_DAILY_USD_CAP=${DAILY_USD_CAP} exceeded — strict-only fallback`,
    };
  }

  const sonnetFn = opts.sonnetConfirm || sonnetConfirm;
  const result = await sonnetFn({ title, company, candidates: fuzzy });
  if (result.match_num && result.confidence >= CONFIDENCE_THRESHOLD) {
    return {
      match: String(result.match_num),
      method: 'sonnet-confirmed-fuzzy',
      confidence: result.confidence,
      reasoning: result.reasoning,
      cost_usd: result.cost_usd,
    };
  }
  return {
    match: null,
    method: result.match_num ? 'sonnet-rejected' : 'sonnet-no-match',
    confidence: result.confidence,
    reasoning: result.reasoning,
    cost_usd: result.cost_usd,
  };
}

// Export internals for tests
export const _internals = {
  loadSpend,
  recordSpend,
  spendCapExceeded,
  normCompany,
  tokenize,
  ENABLED,
  DAILY_USD_CAP,
  CONFIDENCE_THRESHOLD,
};
