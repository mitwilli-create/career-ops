/**
 * lib/discard-gate.mjs — Discard-aware pre-triage filter.
 *
 * Three-tier gate that runs BEFORE any LLM call in triage.mjs::quickScoreRouted.
 * Closes the loop on Mitchell's recurring "auto-re-ingest of a discarded role"
 * problem (canonical incident: Anthropic Developer Education Lead, discarded
 * 3 times across rows 2068/47/2530 between 2026-05-19 and 2026-05-26).
 *
 *   Tier 1 — exact-match on canonical (company, role) key                  $0
 *   Tier 2 — Sorensen-Dice bigram fuzzy match (same company, role tokens)  $0
 *   Tier 3 — GPT-5 adjudication via lib/council.mjs::callCouncil          ~$0.02
 *
 * Four verdicts:
 *   skip-exact        — Tier 1 hit. Hard skip, no LLM call, $0.
 *   skip-gpt5         — Tier 3 hit with confidence >= threshold. Hard skip.
 *   advance-flagged   — Tier 2 hit (no Tier 3) OR Tier 3 advance OR Tier 3
 *                       low-confidence skip. Triage proceeds normally but the
 *                       prior-match context is attached for downstream awareness.
 *   advance           — No prior signal at any tier. Triage proceeds normally.
 *
 * Spec: .claude/audit/discard-gate-spec-2026-05-26/notes.md
 * Integration target: triage.mjs::quickScoreRouted (around line 498)
 *
 * Concurrency contract: read-mostly. The only write is the append-only audit
 * log line (`data/discard-gate-log.jsonl`) via atomic appendFileSync — safe
 * under parallel triage workers without locks.
 *
 * Cross-fork-leak guard: prior_discard_reason (Mitchell's verbatim sentence)
 * is NEVER logged to the audit JSONL — only the auto-classified tag.
 *
 * Fail-open: every error path in the gate downgrades to `advance` so triage
 * is never blocked by gate failures.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCompanyKey } from './ats-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

// ─── Env-var defaults ─────────────────────────────────────────────────────
// All read at call-time so tests can mutate process.env without re-imports.

const DEFAULT_COOLDOWN_DAYS = 90;
const DEFAULT_GPT5_BUDGET_USD = 5;
const DEFAULT_FUZZY_DICE_THRESHOLD = 0.80;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.80;
const DEFAULT_TIER3_TIMEOUT_MS = 30_000;

// ─── Gate API ─────────────────────────────────────────────────────────────

/**
 * Three-tier discard gate.
 *
 * @param {object} input
 * @param {string} input.url            Canonical ATS URL from scanner
 * @param {string} input.company        Display name OR slug — normalized internally
 * @param {string} input.role           Role title from JD / scrape
 * @param {string} [input.jdText]       Optional JD body for Tier 3; truncated to 6000 chars
 * @param {string[]} [input.archetypes] Optional Mitchell-relevant archetype list
 * @param {Date} [input.now]            Injectable clock for cooldown math
 * @param {string} [input.rootDir]      Alternate repo root for test fixtures
 * @param {boolean} [input.skipTier3]   Fuzzy hits return advance-flagged without GPT-5
 * @returns {Promise<DiscardGateResult>}
 *
 * @typedef {object} DiscardGateResult
 * @property {'skip-exact'|'skip-gpt5'|'advance'|'advance-flagged'} verdict
 * @property {string} reason
 * @property {number} cost_usd
 * @property {object} [prior_match]
 * @property {object} [tier3]
 * @property {'disabled'|'budget-exhausted'|'tier3-skipped'} [bypassed]
 */
export async function applyDiscardGate(input = {}) {
  const t0 = Date.now();
  const {
    url = '',
    company = '',
    role = '',
    jdText = '',
    archetypes = [],
    now = new Date(),
    rootDir = DEFAULT_ROOT,
    skipTier3 = false,
  } = input;

  // ── Kill switch ───────────────────────────────────────────────────────
  // Note: when disabled we still write an audit-log entry so the gate's
  // would-have-skipped rate can be measured pre-rollout.
  const enabled = (process.env.DISCARD_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    const result = {
      verdict: 'advance',
      reason: 'Gate disabled via DISCARD_GATE_ENABLED=false.',
      cost_usd: 0,
      bypassed: 'disabled',
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: -1, elapsedMs: Date.now() - t0,
    }));
    return result;
  }

  // ── Inputs ────────────────────────────────────────────────────────────
  const companyKey = canonicalCompanyKey(company);
  const roleSlug = normalizeRoleSlug(role);
  if (!companyKey || !roleSlug) {
    // Missing company OR role → can't run Tier 1 OR Tier 2 meaningfully.
    // Fail-open: advance and log so we can tune extraction upstream.
    const result = {
      verdict: 'advance',
      reason: companyKey
        ? 'No role extracted — gate cannot match.'
        : 'No company extracted — gate cannot match.',
      cost_usd: 0,
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 0, elapsedMs: Date.now() - t0,
    }));
    return result;
  }

  // ── Load prior discards ───────────────────────────────────────────────
  const cooldownDays = _intEnv('DISCARD_COOLDOWN_DAYS', DEFAULT_COOLDOWN_DAYS);
  const priorDiscards = loadPriorDiscards({ rootDir, cooldownDays, now });

  // ── Tier 1: exact-match ───────────────────────────────────────────────
  // Match key = companyKey + '\x1F' + roleSlug (normalized form; seniority
  // modifiers stripped so "Senior Lead" matches "Lead" when prior tag is
  // non-seniority).
  const exactKey = companyKey + '\x1F' + roleSlug;
  const exactHit = priorDiscards.find((d) => d._exactKey === exactKey);
  if (exactHit) {
    const result = {
      verdict: 'skip-exact',
      reason: `Exact match: ${exactHit.company} / ${exactHit.role} discarded ${exactHit._ageDays} day(s) ago${exactHit.row_num ? ` (row ${exactHit.row_num}` : ''}${exactHit.tag ? `, tag: ${exactHit.tag}` : ''}${exactHit.row_num ? ')' : ''}.`,
      cost_usd: 0,
      prior_match: _toPriorMatch(exactHit),
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 1, elapsedMs: Date.now() - t0,
    }));
    return result;
  }

  // ── Tier 2: fuzzy similarity (same company, fuzzy role) ───────────────
  const fuzzyThreshold = _floatEnv('DISCARD_GATE_TIER3_FUZZY_DICE_THRESHOLD', DEFAULT_FUZZY_DICE_THRESHOLD);
  const sameCompanyDiscards = priorDiscards.filter((d) => d._companyKey === companyKey);
  let fuzzyHit = null;
  let fuzzyScore = 0;
  for (const d of sameCompanyDiscards) {
    const score = diceCoefficient(role, d.role);
    if (score >= fuzzyThreshold && score > fuzzyScore) {
      fuzzyHit = d;
      fuzzyScore = score;
    }
  }

  if (!fuzzyHit) {
    const result = {
      verdict: 'advance',
      reason: 'No prior discard signal.',
      cost_usd: 0,
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 0, elapsedMs: Date.now() - t0,
    }));
    return result;
  }

  // ── Tier 3 short-circuit: skipTier3 flag ──────────────────────────────
  if (skipTier3) {
    const result = {
      verdict: 'advance-flagged',
      reason: `Fuzzy match (Dice ${fuzzyScore.toFixed(2)}) to ${fuzzyHit.company} / ${fuzzyHit.role} discarded ${fuzzyHit._ageDays}d ago — Tier 3 skipped per caller request.`,
      cost_usd: 0,
      prior_match: _toPriorMatch(fuzzyHit),
      bypassed: 'tier3-skipped',
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 2, elapsedMs: Date.now() - t0, fuzzyScore,
    }));
    return result;
  }

  // ── Tier 3 budget check ───────────────────────────────────────────────
  const budgetUsd = _floatEnv('DISCARD_GATE_GPT5_BUDGET_USD', DEFAULT_GPT5_BUDGET_USD);
  const todaySpend = readGateSpendToday({ rootDir, now });
  if (todaySpend >= budgetUsd) {
    const result = {
      verdict: 'advance-flagged',
      reason: `Fuzzy match (Dice ${fuzzyScore.toFixed(2)}) to ${fuzzyHit.company} / ${fuzzyHit.role} ${fuzzyHit._ageDays}d ago — Tier 3 budget exhausted ($${todaySpend.toFixed(2)} of $${budgetUsd}).`,
      cost_usd: 0,
      prior_match: _toPriorMatch(fuzzyHit),
      bypassed: 'budget-exhausted',
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 2, elapsedMs: Date.now() - t0, fuzzyScore,
    }));
    return result;
  }

  // ── Tier 3: GPT-5 adjudication ────────────────────────────────────────
  let tier3Result = null;
  let tier3Error = null;
  let tier3Cost = 0;
  try {
    tier3Result = await callTier3Adjudicator({
      url, company, role, jdText, archetypes,
      priorMatch: fuzzyHit, rootDir, now,
    });
    tier3Cost = tier3Result.cost_usd || 0;
    recordGateSpend({ rootDir, now, cost_usd: tier3Cost });
  } catch (err) {
    tier3Error = err && err.message ? String(err.message) : 'unknown error';
  }

  if (tier3Error || !tier3Result || !tier3Result.parsed) {
    const errStr = tier3Error ? `${tier3Error}`.slice(0, 80) : (tier3Result?.parse_error || 'no parsed response');
    const result = {
      verdict: 'advance-flagged',
      reason: `Fuzzy match to ${fuzzyHit.company} / ${fuzzyHit.role}; Tier 3 degraded (${errStr}).`,
      cost_usd: tier3Cost,
      prior_match: _toPriorMatch(fuzzyHit),
      tier3: {
        model: 'openai:gpt-5',
        confidence: null,
        raw_response: tier3Result?.raw || '',
        error: errStr,
      },
    };
    _appendAuditLog(rootDir, _buildAuditEntry({
      input, result, tierFired: 3, elapsedMs: Date.now() - t0, fuzzyScore,
      tier3Error: errStr,
    }));
    return result;
  }

  // Parsed result ── decide based on verdict + confidence
  const conf = Number(tier3Result.parsed.confidence) || 0;
  const verdictRaw = String(tier3Result.parsed.verdict || '').toLowerCase();
  const confidenceThreshold = _floatEnv('DISCARD_GATE_TIER3_CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD);
  const isSkip = verdictRaw === 'skip' && conf >= confidenceThreshold;

  const result = {
    verdict: isSkip ? 'skip-gpt5' : 'advance-flagged',
    reason: tier3Result.parsed.reason || (isSkip ? 'GPT-5 high-confidence skip.' : 'GPT-5 advance / low-confidence.'),
    cost_usd: tier3Cost,
    prior_match: _toPriorMatch(fuzzyHit),
    tier3: {
      model: 'openai:gpt-5',
      confidence: conf,
      raw_response: tier3Result.raw || '',
      rubric_path: tier3Result.parsed.rubric_path,
      title_delta: tier3Result.parsed.title_delta,
      freshness_signal: tier3Result.parsed.freshness_signal,
    },
  };
  _appendAuditLog(rootDir, _buildAuditEntry({
    input, result, tierFired: 3, elapsedMs: Date.now() - t0, fuzzyScore,
  }));
  return result;
}

// ─── Tier 3 adjudicator ──────────────────────────────────────────────────

/**
 * Call GPT-5 via lib/council.mjs::callCouncil to adjudicate a fuzzy match.
 *
 * Honors DISCARD_GATE_TIER3_MOCK when set to a JSON-fixture path — used in
 * tests so we never spend money on the gate's own unit tests.
 *
 * @returns {Promise<{raw: string, parsed: object|null, parse_error?: string, cost_usd: number}>}
 */
async function callTier3Adjudicator({ url, company, role, jdText, archetypes, priorMatch, rootDir, now }) {
  const userPrompt = _buildUserPrompt({ url, company, role, jdText, archetypes, priorMatch });

  // Mock seam — only honored when DISCARD_GATE_TIER3_MOCK is set.
  // Returns the fixture as the raw response so tests can exercise the
  // parse + verdict-decision branches without touching GPT-5.
  const mockPath = process.env.DISCARD_GATE_TIER3_MOCK;
  if (mockPath) {
    let raw, parsed, parse_error;
    try {
      const txt = readFileSync(mockPath, 'utf-8');
      raw = txt;
      try { parsed = JSON.parse(extractJsonBlock(txt)); }
      catch (err) { parse_error = `mock parse: ${err.message}`; parsed = null; }
    } catch (err) {
      // simulated timeout / network error
      throw new Error(`mock fixture: ${err.message}`);
    }
    return { raw, parsed: parsed || null, parse_error, cost_usd: 0 };
  }

  // Real GPT-5 call — dynamic import keeps lib/council.mjs as a soft dep.
  const { callCouncil } = await import('./council.mjs');
  const t3Timeout = _intEnv('DISCARD_GATE_TIER3_TIMEOUT_MS', DEFAULT_TIER3_TIMEOUT_MS);
  // Cap per caller-side constraint (60s ceiling).
  const safeTimeout = Math.min(Math.max(t3Timeout, 1_000), 60_000);

  const onCostRecord = (() => {
    try {
      // initCostTrace returns an onCostRecord callback — wired so spend lands
      // in data/polish-cost-trace-<DATE>.json alongside other agents.
      return null; // populated below if dynamic-import works
    } catch { return null; }
  })();

  // Try to wire cost-trace if available — best-effort.
  let costRecordCb = null;
  try {
    const { initCostTrace } = await import('./council.mjs');
    if (typeof initCostTrace === 'function') {
      costRecordCb = initCostTrace('discard-gate', rootDir);
    }
  } catch { /* best-effort */ }

  const result = await callCouncil({
    prompt: userPrompt,
    models: ['openai:gpt-5'],
    opts: {
      timeoutMs: safeTimeout,
      maxTokens: 800,
      temperature: 0,
      systemPrompt: TIER3_SYSTEM_PROMPT,
      onCostRecord: costRecordCb,
    },
  });

  const totalCost = Number(result?.report?.totalCost) || 0;
  const first = result?.results?.[0];
  const raw = first?.content || '';
  if (first?.error) {
    throw new Error(`gpt-5 error: ${String(first.error).slice(0, 120)}`);
  }
  let parsed = null;
  let parse_error;
  try { parsed = JSON.parse(extractJsonBlock(raw)); }
  catch (err) { parse_error = `parse: ${err.message}`; }

  // Lightweight schema sanity — verdict + confidence + reason required.
  if (parsed && (!parsed.verdict || typeof parsed.confidence !== 'number' || !parsed.reason)) {
    parse_error = 'schema: missing required field (verdict/confidence/reason)';
    parsed = null;
  }
  return { raw, parsed, parse_error, cost_usd: totalCost };
}

// ─── Prompts (cross-fork-leak conscious — no PII verbatim) ───────────────

const TIER3_SYSTEM_PROMPT = `You are a discard-gate adjudicator for Mitchell Williams's career-ops job pipeline.

ROLE: You receive a NEW job posting that fuzzy-matched a role Mitchell previously discarded. Your single job is to decide whether the NEW posting represents the same opportunity (skip) or a legitimately distinct role (advance).

DECISION RUBRIC (apply in order — first match wins):

1. SAME-ROLE markers — return verdict="skip" with confidence >= 0.80:
   - Identical title at identical company within 90 days of prior discard, no material JD changes
   - Prior discard reason is role-AGNOSTIC ("auto-rejected by ATS in 24h"; "company-wide hiring freeze surfaced post-discard")
   - New JD copy is >70% lexically identical to discarded JD (when prior JD text was preserved)
   - Title differs only in seniority modifier ("Lead" vs "Senior Lead") AND prior discard reason was non-seniority-related

2. DISTINCT-ROLE markers — return verdict="advance" with confidence >= 0.70:
   - Different team / vertical at same company ("Developer Education Lead, Claude API" vs "Developer Education Lead, Claude Code")
   - Different geography materially changes fit (NYC vs SF, when prior discard tagged "geography")
   - Materially elevated scope/seniority ("Lead" -> "Director", "Senior" -> "Principal")
   - Prior discard tagged "skill-gap" + new JD lists complementary not-overlapping skills
   - Prior discard tagged "comp" + this listing materially changes comp signal (range published; "competitive" -> "$X-$Y")

3. AMBIGUOUS — return verdict="advance" with confidence 0.30-0.69:
   - Cannot determine same-vs-different from available context
   - Prior discard reason is unclear or generic ("not a fit")
   - Title is a near-variant (Manager vs Lead) and JD scope is ambiguous

ALWAYS return strict JSON matching the schema. NEVER add prose outside the JSON object.

REASON FIELD: max 200 chars, plain English, names the rubric criterion that fired (e.g. "Same title at same company within 14 days, no JD changes — clearly the same posting"). DO NOT include personal data, salaries, or contact names.`;

function _buildUserPrompt({ url, company, role, jdText, archetypes, priorMatch }) {
  const jdExcerpt = (jdText || '').slice(0, 6000) || '(JD body unavailable)';
  const archetypesStr = (archetypes && archetypes.length) ? archetypes.join(', ') : 'unknown';
  return [
    'PRIOR DISCARD:',
    `  Date: ${priorMatch.ts || 'unknown'}  (${priorMatch._ageDays} days ago)`,
    `  Company: ${priorMatch.company}`,
    `  Role: ${priorMatch.role}`,
    `  Reason (Mitchell's own words): ${priorMatch.reason || '(unrecorded)'}`,
    `  Auto-tag: ${priorMatch.tag || '(unrecorded)'}`,
    '',
    'NEW POSTING:',
    `  URL: ${url || '(unknown)'}`,
    `  Company: ${company || '(unknown)'}`,
    `  Role: ${role || '(unknown)'}`,
    '  JD excerpt (first 6000 chars):',
    '  ---',
    `  ${jdExcerpt}`,
    '  ---',
    '',
    "MITCHELL'S CURRENT TARGET ARCHETYPES (for \"does this role fit at all\" sanity):",
    `  ${archetypesStr}`,
    '',
    'Decide: is the NEW posting the SAME opportunity as the prior discard (verdict="skip"), or legitimately distinct (verdict="advance")? Return strict JSON.',
  ].join('\n');
}

// ─── Prior-discard loading (Tier 1 + Tier 2 source data) ─────────────────

/**
 * Load prior discards from BOTH data/discard-reasons.jsonl and
 * data/applications.md (Status=Discarded). Filters to age <= cooldownDays.
 *
 * Returns entries augmented with normalized keys (_companyKey, _roleSlug,
 * _exactKey, _ageDays, _source).
 *
 * @returns {Array<object>}
 */
export function loadPriorDiscards({ rootDir = DEFAULT_ROOT, cooldownDays = DEFAULT_COOLDOWN_DAYS, now = new Date() } = {}) {
  const all = [
    ...readDiscardReasonsJsonl(rootDir),
    ...readApplicationsMdDiscards(rootDir),
  ];

  const cutoffMs = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  const withinWindow = [];
  for (const entry of all) {
    if (!entry.company || !entry.role) continue;
    const tsMs = entry.ts ? Date.parse(entry.ts) : NaN;
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) continue;
    const companyKey = canonicalCompanyKey(entry.company);
    const roleSlug = normalizeRoleSlug(entry.role);
    if (!companyKey || !roleSlug) continue;
    withinWindow.push({
      ...entry,
      _companyKey: companyKey,
      _roleSlug: roleSlug,
      _exactKey: companyKey + '\x1F' + roleSlug,
      _ageDays: Math.max(0, Math.floor((now.getTime() - tsMs) / (24 * 60 * 60 * 1000))),
    });
  }

  // De-dup: when the same (company,role) appears in both sources, keep the
  // newest entry. JSONL is preferred when ages tie (richer reason+tag).
  const byKey = new Map();
  for (const e of withinWindow) {
    const existing = byKey.get(e._exactKey);
    if (!existing) { byKey.set(e._exactKey, e); continue; }
    // Pick newer (smaller age) — tie → JSONL wins (richer source).
    if (e._ageDays < existing._ageDays) { byKey.set(e._exactKey, e); continue; }
    if (e._ageDays === existing._ageDays && e._source === 'discard-reasons.jsonl' && existing._source !== 'discard-reasons.jsonl') {
      byKey.set(e._exactKey, e);
    }
  }
  // Sort newest first (small _ageDays first) so caller's .find() picks the
  // most-recent prior discard for any given key.
  return [...byKey.values()].sort((a, b) => a._ageDays - b._ageDays);
}

function readDiscardReasonsJsonl(rootDir) {
  const path = join(rootDir, 'data', 'discard-reasons.jsonl');
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (!obj.company || !obj.role) continue;
    // Restore-signal tombstone: if a future row has kind:'restore' for the
    // same (company, role), suppress prior discards for that pair.
    if (obj.kind === 'restore') {
      out.push({ ...obj, _isRestore: true, _source: 'discard-reasons.jsonl' });
      continue;
    }
    out.push({
      ts: obj.ts,
      row_num: obj.row_num,
      company: String(obj.company),
      role: String(obj.role),
      reason: String(obj.reason || ''),
      tag: String(obj.tag || ''),
      _source: 'discard-reasons.jsonl',
    });
  }
  // Apply restore tombstones: any (company,role) with a restore entry NEWER
  // than the most-recent normal entry → drop normal entries for that pair.
  const restoreLatest = new Map(); // exactKey -> latest restore ts
  for (const e of out) {
    if (!e._isRestore) continue;
    const k = canonicalCompanyKey(e.company) + '\x1F' + normalizeRoleSlug(e.role);
    const tsMs = Date.parse(e.ts || '') || 0;
    const prev = restoreLatest.get(k) || 0;
    if (tsMs > prev) restoreLatest.set(k, tsMs);
  }
  return out
    .filter((e) => !e._isRestore) // restores aren't returned as discards
    .filter((e) => {
      const k = canonicalCompanyKey(e.company) + '\x1F' + normalizeRoleSlug(e.role);
      const restoreTs = restoreLatest.get(k) || 0;
      if (restoreTs === 0) return true;
      const discardTs = Date.parse(e.ts || '') || 0;
      return discardTs > restoreTs;
    });
}

function readApplicationsMdDiscards(rootDir) {
  const path = join(rootDir, 'data', 'applications.md');
  if (!existsSync(path)) return [];
  let raw;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    // Match rows: "| 2530 | 2026-05-26 | Anthropic | Developer Education Lead | 4.1/5 | Discarded | …"
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    // parts[0] is leading empty; parts[1..] are columns.
    if (parts.length < 7) continue;
    const num = parts[1];
    const date = parts[2];
    const company = parts[3];
    const role = parts[4];
    const status = parts[6];
    if (!num || !/^\d+$/.test(num)) continue;
    if (!company || !role) continue;
    if (status !== 'Discarded') continue;
    // Synthesize an ISO timestamp from the date column (UTC midnight).
    const ts = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `${date}T00:00:00Z`
      : null;
    if (!ts) continue;
    out.push({
      ts,
      row_num: Number(num),
      company,
      role,
      reason: '', // not stored in tracker; lives in JSONL only
      tag: '',
      _source: 'applications.md',
    });
  }
  return out;
}

// ─── Normalization + fuzzy matching ──────────────────────────────────────

/**
 * Normalize a role title to a primary slug for exact-match keying.
 * Strips seniority modifiers as a SECONDARY normalization — keeps the
 * original for display + fuzzy matching upstream.
 */
export function normalizeRoleSlug(role) {
  if (!role) return '';
  return String(role)
    .toLowerCase()
    .replace(/\b(sr|senior|jr|junior|lead|principal|staff|head\s+of)\b/g, '')
    .replace(/[,.;:()/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sorensen-Dice bigram coefficient on tokenized strings. Returns [0, 1].
 * Single-token roles fall back to unigram set so "Engineer" matches "Engineer".
 */
export function diceCoefficient(a, b) {
  const bigrams = (s) => {
    const tokens = String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const out = new Set();
    for (let i = 0; i < tokens.length - 1; i++) out.add(tokens[i] + ' ' + tokens[i + 1]);
    if (out.size === 0) tokens.forEach((t) => out.add(t));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let intersect = 0;
  for (const g of A) if (B.has(g)) intersect++;
  return (2 * intersect) / (A.size + B.size);
}

// ─── JSON extraction helper (handles fenced ```json blocks) ───────────────

function extractJsonBlock(text) {
  if (!text) return '{}';
  // Strip ```json … ``` fences and ``` … ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // First {...} block
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return m[0];
  return text.trim();
}

// ─── Spend tracking (Tier 3 daily-bucket cap) ────────────────────────────

/**
 * Return today's gate spend in USD by summing `data/discard-gate-spend.jsonl`
 * for lines whose ts is on the same UTC date as `now`. Robust to missing
 * file / malformed lines (returns 0).
 */
export function readGateSpendToday({ rootDir = DEFAULT_ROOT, now = new Date() } = {}) {
  const path = join(rootDir, 'data', 'discard-gate-spend.jsonl');
  if (!existsSync(path)) return 0;
  let raw;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { return 0; }
  const todayKey = now.toISOString().slice(0, 10);
  let sum = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { continue; }
    if (!obj || typeof obj.cost_usd !== 'number') continue;
    if (!obj.ts || obj.ts.slice(0, 10) !== todayKey) continue;
    sum += Number(obj.cost_usd) || 0;
  }
  return sum;
}

/**
 * Append a spend record. Best-effort — failures never block triage.
 */
export function recordGateSpend({ rootDir = DEFAULT_ROOT, now = new Date(), cost_usd = 0 } = {}) {
  if (!cost_usd || cost_usd <= 0) return;
  try {
    const dir = join(rootDir, 'data');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'discard-gate-spend.jsonl');
    appendFileSync(path, JSON.stringify({ ts: now.toISOString(), cost_usd }) + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

// ─── Audit log writer (data/discard-gate-log.jsonl) ──────────────────────

/**
 * Build the audit-log entry for one gate call. Per spec § 8 — 14 fields per
 * entry. Cross-fork-leak guard: `discard_reason` verbatim is NEVER included.
 */
function _buildAuditEntry({ input, result, tierFired, elapsedMs, fuzzyScore = null, tier3Error = null }) {
  const company = input.company || '';
  const role = input.role || '';
  const url = input.url || '';
  const prior = result.prior_match || null;
  const tier3 = result.tier3 || null;
  return {
    ts: new Date().toISOString(),
    url,
    company,
    company_key: canonicalCompanyKey(company),
    role,
    role_slug: normalizeRoleSlug(role),
    gate_decision: result.verdict,
    gate_reason: (result.reason || '').slice(0, 280),
    gate_tier_fired: tierFired,
    gate_cost_usd: Number(result.cost_usd) || 0,
    prior_discard_num: prior?.row_num ?? null,
    prior_discard_ts: prior?.discard_ts ?? null,
    prior_discard_source: prior?.source ?? null,
    prior_discard_tag: prior?.discard_tag ?? null,
    tier3_model: tier3?.model ?? null,
    tier3_confidence: tier3?.confidence ?? null,
    tier3_rubric_path: tier3?.rubric_path ?? null,
    tier3_error: tier3Error ?? null,
    fuzzy_score: fuzzyScore,
    bypassed: result.bypassed ?? null,
    elapsed_ms: Number(elapsedMs) || 0,
  };
}

function _appendAuditLog(rootDir, entry) {
  try {
    const dir = join(rootDir, 'data');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'discard-gate-log.jsonl');
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* best-effort — never block triage on audit log failure */ }
}

// ─── Prior-match builder (gate result field) ─────────────────────────────

function _toPriorMatch(d) {
  return {
    source: d._source,
    company: d.company,
    role: d.role,
    row_num: d.row_num,
    discard_ts: d.ts,
    discard_reason: d.reason || '',
    discard_tag: d.tag || '',
    age_days: d._ageDays,
  };
}

// ─── Env helpers ─────────────────────────────────────────────────────────

function _intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function _floatEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// ─── CLI smoke ───────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const r = await applyDiscardGate({
      url: process.argv[2] || 'https://job-boards.greenhouse.io/anthropic/jobs/4067919008',
      company: process.argv[3] || 'Anthropic',
      role: process.argv[4] || 'Developer Education Lead',
      jdText: '',
    });
    console.log(JSON.stringify(r, null, 2));
  })();
}
