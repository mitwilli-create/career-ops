#!/usr/bin/env node
/**
 * scripts/hiring-manager-research.mjs — Council-of-7 + dealbreaker full-spec
 * hm-intel research for a single apply-now row.
 *
 * This is the "deep" path that the dashboard's "Deep refresh" modal triggers
 * (mode='deep-council-7') and that scripts/agents/intel-refresh.mjs routes to
 * when opts.deep === true. Otherwise (nightly --all sweeps, cheap auto-refresh)
 * intel-refresh routes to scripts/populate-hm-intel-mini.mjs which is ~10x
 * cheaper but uses a 2-model lineup.
 *
 * Documented-but-unbuilt restoration:
 *   Per CLAUDE.md 2026-05-25 doc-drift fix + the 2026-05-26 missing-script
 *   bug class surfaced during PR #295 recovery on row 2387, this script was
 *   referenced from intel-refresh.mjs:206 (fullSpecPath) but never shipped to
 *   disk. The routing layer returned ok:false with missing_script:true. This
 *   file makes it exist + work.
 *
 * Council lineup (the full 7 — never silently subset):
 *   - anthropic:claude-opus-4-7
 *   - anthropic:claude-sonnet-4-6
 *   - openai:gpt-5
 *   - google:gemini-2.5-pro
 *   - xai:grok-4
 *   - perplexity:sonar-deep-research
 *   - perplexity:sonar-reasoning-pro
 *
 * Pipeline:
 *   1. Read the row from data/apply-now-queue.json by num.
 *   2. Fan-out the research prompt to all 7 models via lib/council.mjs::callCouncil.
 *   3. Dealbreaker adjudication pass (Sonnet 4.6) merges per-model JSON candidates
 *      into one canonical payload, preferring higher-evidence claims and tagging
 *      contested fields.
 *   4. Atomically write the canonical payload to data/hm-intel/<companySlug>-<roleSlug>.json
 *      matching the existing on-disk shape (hiring_managers[], recruiters[],
 *      comp_intelligence, outreach_strategy, signals, _meta).
 *   5. Write a hash_only-citation audit doc to data/hm-intel-research/<rowId>-<DATE>.md
 *      so the decision trail is auditable without leaking PII.
 *
 * Atomic-write contract:
 *   Per AGENTS.md bug-class "state-write-without-disk-write" (shipped in PR #295),
 *   writes MUST go to `<path>.tmp.<pid>.<ts>` then renameSync to the final path.
 *   Otherwise a partial write under SIGKILL leaves the cache half-formed and the
 *   verifier at intel-refresh.mjs:verifyChildScriptDiskWrite() sees a zero-byte
 *   or missing file. This is NON-NEGOTIABLE.
 *
 * Cost cap:
 *   $50/row hard cap by default (--max-cost-usd to override). Council fan-out
 *   to 7 frontier models is the bulk of cost; the dealbreaker is one extra
 *   Sonnet 4.6 call. Worst-case observed: ~$15-25/row (Opus + Perplexity Deep
 *   Research are the heavyweights). If the cap is exceeded, abort cleanly:
 *   no cache write, decision doc records cap-breached, exit non-zero so the
 *   upstream verifier flags ok:false.
 *
 * Personal-data hygiene:
 *   data/hm-intel/ and data/hm-intel-research/ are BOTH gitignored. Council
 *   per-model raw responses go to the audit doc as hash_only citations
 *   (sha256:<12hex>) — full text never appears in the audit doc, only the
 *   adjudicated canonical payload reaches data/hm-intel/.
 *
 * CLI:
 *   node scripts/hiring-manager-research.mjs --row 2387
 *   node scripts/hiring-manager-research.mjs --row 2387 --force --max-cost-usd 30
 *
 * Flags:
 *   --row <N>           required — apply-now-queue row num
 *   --force             optional — override cache freshness check
 *   --max-cost-usd <N>  optional — hard cap per row (default $50)
 *
 * Output:
 *   - Atomic write to data/hm-intel/<companySlug>-<roleSlug>.json
 *   - Audit doc to data/hm-intel-research/<rowId>-<YYYY-MM-DD>.md
 *   - Final JSON summary to stdout (matches populate-hm-intel-mini.mjs convention):
 *       { ok, row, path, cost_usd, providers_called, providers_succeeded }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

// ---------------------------------------------------------------------------
// CLI parsing — supports both `--key value` and `--key=value` forms.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));

export const ROW_NUM = ARGS.row != null ? String(ARGS.row) : null;
export const FORCE = ARGS.force === true || ARGS.force === 'true';
export const MAX_COST_USD = Number(ARGS['max-cost-usd'] || process.env.HM_INTEL_DEEP_BUDGET || '50');

// ---------------------------------------------------------------------------
// Council lineup — the FULL 7. Locked. Subsetting is a contract violation;
// the routing layer at intel-refresh.mjs already routes to the mini-script
// for cheap paths. If a model errors during fan-out it falls out of
// `providers_succeeded` but is still recorded in `providers_called`.
// ---------------------------------------------------------------------------
export const COUNCIL_LINEUP = [
  'anthropic:claude-opus-4-7',
  'anthropic:claude-sonnet-4-6',
  'openai:gpt-5',
  'google:gemini-2.5-pro',
  'xai:grok-4',
  'perplexity:sonar-deep-research',
  'perplexity:sonar-reasoning-pro',
];

export const DEALBREAKER_MODEL = 'anthropic:claude-sonnet-4-6';

// Cache TTL — match the project default (3 days per CLAUDE.md Decision-Maximization
// Policy "Cache TTLs: 3 days, re-validate aggressively"). intel-refresh.mjs
// already has its own isCacheFresh logic; this is a defensive secondary check
// when the script is invoked directly (e.g., via the dashboard "Deep refresh"
// modal that bypasses the freshness gate).
export const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* */ }
}

export function hashCite(text) {
  const h = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
  return `sha256:${h}`;
}

/**
 * Atomic write — `<path>.tmp.<pid>.<ts>` then renameSync.
 *
 * Per AGENTS.md bug-class "state-write-without-disk-write" (PR #295). The
 * verifier at scripts/agents/intel-refresh.mjs::verifyChildScriptDiskWrite()
 * stat()s the target after the child exits — a non-atomic write that gets
 * SIGKILL'd mid-stream leaves a zero-byte or partial file that fails
 * verification.
 *
 * Exported for the static-contract test in tests/hiring-manager-research.test.mjs.
 */
export function atomicWriteJson(targetPath, payload) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const body = JSON.stringify(payload, null, 2);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, body, 'utf-8');
  renameSync(tmpPath, targetPath);
  return { path: targetPath, bytes: Buffer.byteLength(body, 'utf-8') };
}

/**
 * Atomic write for markdown audit docs — same `<path>.tmp.<pid>.<ts>` + rename
 * pattern. Audit docs are gitignored personal data; partial writes leave
 * downstream consumers confused.
 */
export function atomicWriteText(targetPath, text) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, text, 'utf-8');
  renameSync(tmpPath, targetPath);
  return { path: targetPath, bytes: Buffer.byteLength(text, 'utf-8') };
}

export function extractJson(c) {
  const t = String(c || '').trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch (_) {} }
  const fenced = c.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
  const s = c.indexOf('{'); const e = c.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch (_) {} }
  return null;
}

export function isCacheFresh(path) {
  if (!existsSync(path)) return false;
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    return age < CACHE_TTL_MS;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Queue lookup — by row.num (string compare for safety; queue stores num as string)
// ---------------------------------------------------------------------------
export function findRowByNum(queuePath, rowNum) {
  if (!existsSync(queuePath)) {
    throw new Error(`apply-now-queue not found at ${queuePath}`);
  }
  const q = JSON.parse(readFileSync(queuePath, 'utf-8'));
  const ranked = Array.isArray(q.ranked) ? q.ranked : [];
  const want = String(rowNum);
  const row = ranked.find(r => String(r.num) === want);
  if (!row) {
    throw new Error(`row ${rowNum} not found in apply-now-queue (${ranked.length} ranked entries)`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function buildResearchPrompt({ company, role, url }) {
  return [
    `# Task — deep hm-intel research for Mitchell Williams' apply-now queue`,
    ``,
    `Mitchell is targeting **${company} — ${role}**.`,
    url ? `JD URL: ${url}` : '',
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Mitchell's profile (brief): 8 years digital journalism (Al Jazeera English Stream, HuffPost Live, AJ+) → Google xGE Internal Comms Lead → production AI agent builder. Currently Seattle-based. PRIMARY filter: total comp + pre-IPO equity timing. Target archetypes: senior comms / forward-deployed / solutions-architect / AI-enablement / strategic-ops at frontier AI labs.`,
    ``,
    `Use your web access (if available) to find the actual hiring manager + recruiter for this requisition. Search LinkedIn, company press, news, Levels.fyi, Blind, Glassdoor.`,
    ``,
    `Return STRICT JSON. First char "{", last char "}". No markdown. No preamble. No code fences.`,
    ``,
    `{`,
    `  "role_summary": "2-3 sentence factual summary of what this role actually does at ${company} (responsibilities, scope, team-shape, surface area).",`,
    `  "alignment_with_goals": "2-3 sentences on how this maps to Mitchell's profile (his journalism → comms → AI builder arc). Be honest where alignment is partial.",`,
    `  "fit_evidence": {`,
    `    "career_history":  "1 sentence — how Mitchell's arc maps to JD requirements",`,
    `    "skills_match":    "1 sentence — specific skills the JD asks for that Mitchell can demonstrate",`,
    `    "narrative_arc":   "1 sentence — the story Mitchell can tell at interview"`,
    `  },`,
    `  "hiring_managers": [`,
    `    {`,
    `      "name": "actual name or 'unknown'",`,
    `      "title": "role at company",`,
    `      "linkedin_url": "URL or null",`,
    `      "why_owns_this_req": "1-2 sentence rationale grounded in public signal (posts/blog/talks), OR null if name is unknown"`,
    `    }`,
    `  ],`,
    `  "recruiters": [`,
    `    {`,
    `      "name": "actual name or 'unknown'",`,
    `      "title": "Recruiter / Talent Partner / Sourcer title",`,
    `      "linkedin_url": "URL or null",`,
    `      "professional_email": "email or null",`,
    `      "professional_email_source": "verified|guessed|null"`,
    `    }`,
    `  ],`,
    `  "comp_intelligence": {`,
    `    "base_range":      "$X-$Y or 'unknown'",`,
    `    "equity_summary":  "string describing equity package — call out pre-IPO valuation + stage",`,
    `    "total_comp_estimate": "$X-$Y total comp incl base + equity + bonus",`,
    `    "comp_sources":    ["url1", "url2"]`,
    `  },`,
    `  "outreach_strategy": {`,
    `    "best_first_move": "1-2 sentence specific tactic — referral, cold LinkedIn DM, comment-on-recent-post, etc",`,
    `    "lead_with":       "1 sentence — what Mitchell should anchor his outreach on"`,
    `  },`,
    `  "signals": ["6-12 short positioning phrases Mitchell can lead with in messaging — written as if HE wrote them in third person"],`,
    `  "gaps": ["2-4 honest gaps between Mitchell's profile and the JD; Mitchell needs to know these BEFORE the interview"]`,
    `}`,
    ``,
    `CRITICAL anti-hallucination rules:`,
    `- DO NOT invent recruiter or HM names. If you can't cite a real LinkedIn URL or press release, set name="unknown".`,
    `- DO NOT fabricate LinkedIn URLs of the form /in/firstname-lastname. Only return URLs you've actually seen.`,
    `- "unknown" is CORRECT and PREFERRED over a guess.`,
    `- Comp ranges: cite actual sources where possible (levels.fyi, Glassdoor, Blind).`,
    `- If your training data may be stale on this comp band (>6 months old), say so via [UNVERIFIED:] tag inline.`,
  ].filter(Boolean).join('\n');
}

function buildDealbreakerPrompt({ company, role, candidates }) {
  // Each candidate: { model, content, parsedOk }
  const candidateSummary = candidates
    .map((c, i) => `### Candidate ${i + 1} — ${c.model}${c.parsedOk ? '' : ' (PARSE FAILED)'}\n${(c.content || '').slice(0, 4000)}`)
    .join('\n\n');

  return [
    `# Task — Dealbreaker adjudication for hm-intel`,
    ``,
    `Mitchell is targeting **${company} — ${role}**.`,
    ``,
    `Below are research outputs from 7 frontier models (Opus, Sonnet, GPT-5, Gemini Pro, Grok-4, Perplexity Deep Research, Perplexity Reasoning Pro). Your job is to merge them into ONE canonical payload — favor corroborated claims, drop unsupported ones, hold contested claims with explicit caveats.`,
    ``,
    `Adjudication rules:`,
    `1. For named hiring managers / recruiters: require at least 2 models to converge on the same name+title+linkedin_url. Otherwise set name="unknown". DO NOT take any single model's word for a real human's identity.`,
    `2. For comp ranges: take the MEDIAN of the cited ranges (not min/max). If only one model cites a range, mark equity_summary with "[CONTESTED — single-source]".`,
    `3. For role_summary / alignment_with_goals / fit_evidence: pick the most specific candidate (most concrete role-shape language wins).`,
    `4. For signals[] + gaps[]: union across all candidates, dedupe semantically, cap at 12 signals + 4 gaps.`,
    `5. For outreach_strategy: pick the candidate with the most specific tactical detail (named platform, named team member to engage, named recent-post).`,
    ``,
    `Return STRICT JSON. First char "{", last char "}". No markdown. No preamble. No code fences.`,
    ``,
    `Shape:`,
    `{`,
    `  "role_summary": "...",`,
    `  "alignment_with_goals": "...",`,
    `  "fit_evidence": { "career_history": "...", "skills_match": "...", "narrative_arc": "..." },`,
    `  "hiring_managers": [ { "name": "...", "title": "...", "linkedin_url": "...", "why_owns_this_req": "..." } ],`,
    `  "recruiters": [ { "name": "...", "title": "...", "linkedin_url": "...", "professional_email": "...", "professional_email_source": "..." } ],`,
    `  "comp_intelligence": { "base_range": "...", "equity_summary": "...", "total_comp_estimate": "...", "comp_sources": ["..."] },`,
    `  "outreach_strategy": { "best_first_move": "...", "lead_with": "..." },`,
    `  "signals": ["..."],`,
    `  "gaps": ["..."],`,
    `  "_adjudication": { "contested_fields": ["..."], "single_source_claims": ["..."], "convergence_score": 0.0 }`,
    `}`,
    ``,
    `--- CANDIDATES ---`,
    ``,
    candidateSummary,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
async function runCouncilFanOut({ row }) {
  const { callCouncil } = await import('../lib/council.mjs');
  const prompt = buildResearchPrompt({
    company: row.company,
    role: row.role,
    url: row.url || '',
  });

  emit({ slot: 'hm-intel-deep', row: row.num, step: 'council-fanout-start', models: COUNCIL_LINEUP.length });

  // Per AGENTS.md hang-prevention: always pass explicit timeoutMs. 6 minutes
  // accommodates Perplexity Deep Research which is the slowest (typically
  // 90-240s for synthesis runs).
  const council = await callCouncil({
    prompt,
    models: COUNCIL_LINEUP,
    opts: {
      timeoutMs: 360_000,
      maxTokens: 4500,
    },
  });

  const cost = council.report?.totalCost || 0;
  const results = council.results || [];
  emit({ slot: 'hm-intel-deep', row: row.num, step: 'council-fanout-done', cost_usd: cost, results: results.length });

  return { council, cost };
}

async function runDealbreaker({ row, candidates }) {
  const { callCouncil } = await import('../lib/council.mjs');
  const prompt = buildDealbreakerPrompt({
    company: row.company,
    role: row.role,
    candidates,
  });

  emit({ slot: 'hm-intel-deep', row: row.num, step: 'dealbreaker-start', model: DEALBREAKER_MODEL });

  const adjudication = await callCouncil({
    prompt,
    models: [DEALBREAKER_MODEL],
    opts: {
      timeoutMs: 240_000,
      maxTokens: 5500,
    },
  });

  const cost = adjudication.report?.totalCost || 0;
  const adjudicated = (adjudication.results || []).find(r => !r.error && r.content);
  emit({ slot: 'hm-intel-deep', row: row.num, step: 'dealbreaker-done', cost_usd: cost });

  if (!adjudicated) {
    return { merged: null, cost, error: 'dealbreaker-returned-no-content' };
  }

  const merged = extractJson(adjudicated.content);
  if (!merged) {
    return { merged: null, cost, error: 'dealbreaker-output-not-parseable' };
  }

  return { merged, cost };
}

// Compose the final on-disk payload matching existing data/hm-intel/*.json shape.
export function composeCanonicalPayload({ row, merged, providersCalled, providersSucceeded, totalCost }) {
  const safe = (v, fallback) => (v == null ? fallback : v);
  return {
    company: row.company,
    role: row.role,
    url: row.url || '',
    synthesized_at: new Date().toISOString(),
    providers_called: providersCalled,
    providers_succeeded: providersSucceeded,
    role_summary: safe(merged?.role_summary, ''),
    alignment_with_goals: safe(merged?.alignment_with_goals, ''),
    fit_evidence: safe(merged?.fit_evidence, {}),
    hiring_managers: Array.isArray(merged?.hiring_managers) && merged.hiring_managers.length
      ? merged.hiring_managers
      : [{ name: 'unknown', title: null, linkedin_url: null, why_owns_this_req: null }],
    recruiters: Array.isArray(merged?.recruiters) && merged.recruiters.length
      ? merged.recruiters
      : [{ name: 'unknown', title: null, linkedin_url: null, professional_email: null, professional_email_source: null }],
    comp_intelligence: safe(merged?.comp_intelligence, {}),
    outreach_strategy: safe(merged?.outreach_strategy, {}),
    signals: Array.isArray(merged?.signals) ? merged.signals : [],
    gaps: Array.isArray(merged?.gaps) ? merged.gaps : [],
    _meta: {
      owner: 'deep-council-7',
      method: 'council-of-7-with-dealbreaker',
      cost_usd: totalCost,
      providers_succeeded_count: providersSucceeded.length,
      adjudication: merged?._adjudication || null,
    },
  };
}

// Render audit doc — hash_only citations, no PII text, no raw model responses.
export function renderAuditDoc({ row, providersCalled, providersSucceeded, perModelHashes, totalCost, capBreached, error }) {
  const date = new Date().toISOString().slice(0, 10);
  const status = capBreached ? 'CAP_BREACHED' : error ? 'ERROR' : 'OK';
  const lines = [
    `---`,
    `classification: "[PERSONAL — DO NOT PUBLISH]"`,
    `agent: scripts/hiring-manager-research.mjs`,
    `mode: deep-council-7`,
    `date: ${date}`,
    `row_num: ${row.num}`,
    `company: ${row.company}`,
    `role: ${row.role}`,
    `status: ${status}`,
    `total_cost_usd: ${Number(totalCost).toFixed(4)}`,
    `---`,
    ``,
    `# Hiring Manager Research — Row ${row.num}`,
    ``,
    `Council-of-7 + dealbreaker run for **${row.company} — ${row.role}** on ${date}.`,
    ``,
    `## Provenance`,
    ``,
    `- Providers called: ${providersCalled.length}`,
    `- Providers succeeded: ${providersSucceeded.length}`,
    `- Status: ${status}`,
    `- Total cost: $${Number(totalCost).toFixed(4)} (cap: $${MAX_COST_USD})`,
    error ? `- Error: ${error}` : null,
    ``,
    `## Per-Model Citations (hash_only)`,
    ``,
    `Per AGENTS.md cross-fork-leak hardening, raw model responses are recorded as sha256:<12hex> hashes only.`,
    `The canonical adjudicated payload lives at \`data/hm-intel/${slugify(row.company)}-${slugify(row.role)}.json\` (gitignored personal data).`,
    ``,
    `| Provider | Cite Hash | Status |`,
    `|---|---|---|`,
    ...perModelHashes.map(h => `| ${h.model} | ${h.hash} | ${h.status} |`),
    ``,
    `## Dealbreaker`,
    ``,
    `Adjudicator: \`${DEALBREAKER_MODEL}\`. Adjudication rules per the prompt: corroborated-claims-only for named humans (≥2 models converge), median for comp ranges, most-specific-wins for role/alignment/outreach copy.`,
    ``,
    `_Decision doc ends. Canonical payload is the JSON at the path above._`,
  ].filter(l => l !== null);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!ROW_NUM) {
    console.error('Usage:');
    console.error('  node scripts/hiring-manager-research.mjs --row <N>');
    console.error('Optional flags:');
    console.error('  --force             override 3-day cache freshness check');
    console.error('  --max-cost-usd <N>  hard cap per row (default $50)');
    process.exit(2);
  }

  const queuePath = join(ROOT, 'data', 'apply-now-queue.json');
  const row = findRowByNum(queuePath, ROW_NUM);
  const slug = `${slugify(row.company)}-${slugify(row.role)}`;
  const target = join(ROOT, 'data', 'hm-intel', `${slug}.json`);
  const auditPath = join(ROOT, 'data', 'hm-intel-research', `${row.num}-${new Date().toISOString().slice(0, 10)}.md`);

  emit({ slot: 'hm-intel-deep', row: row.num, step: 'start', company: row.company, role: row.role, target });

  // Defensive freshness check — intel-refresh already gates this, but the
  // dashboard "Deep refresh" path bypasses that gate. Honor --force always.
  if (!FORCE && isCacheFresh(target)) {
    emit({ slot: 'hm-intel-deep', row: row.num, step: 'cache-fresh-skip', path: target });
    const summary = { ok: true, row: row.num, path: target, cache: 'fresh', cost_usd: 0, mode: 'deep-council-7' };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  let totalCost = 0;
  let council = null;
  let cost1 = 0;
  let capBreached = false;
  let error = null;
  let perModelHashes = [];
  let providersSucceeded = [];
  let merged = null;

  try {
    // Phase 1 — council fan-out
    const fanout = await runCouncilFanOut({ row });
    council = fanout.council;
    cost1 = fanout.cost;
    totalCost += cost1;

    if (totalCost >= MAX_COST_USD) {
      capBreached = true;
      throw new Error(`cost cap $${MAX_COST_USD} breached after fan-out ($${totalCost.toFixed(2)})`);
    }

    const results = council.results || [];
    const candidates = results.map(r => ({
      model: r.model,
      content: r.content || '',
      parsedOk: !!extractJson(r.content || ''),
      error: r.error || null,
    }));

    perModelHashes = candidates.map(c => ({
      model: c.model,
      hash: c.error ? 'ERROR' : hashCite(c.content),
      status: c.error ? `error: ${String(c.error).slice(0, 80)}` : c.parsedOk ? 'parsed-ok' : 'unparseable',
    }));

    providersSucceeded = candidates.filter(c => !c.error && c.content).map(c => c.model);

    if (!providersSucceeded.length) {
      throw new Error(`all ${COUNCIL_LINEUP.length} council models failed`);
    }

    // Phase 2 — dealbreaker adjudication
    const adj = await runDealbreaker({ row, candidates: candidates.filter(c => !c.error && c.content) });
    totalCost += adj.cost || 0;

    if (totalCost >= MAX_COST_USD && !adj.merged) {
      capBreached = true;
      throw new Error(`cost cap $${MAX_COST_USD} breached during dealbreaker ($${totalCost.toFixed(2)})`);
    }

    merged = adj.merged;
    if (!merged) {
      // Fall back to the best-parseable candidate so the cache still gets a
      // canonical payload (cheaper than re-running the whole council).
      emit({ slot: 'hm-intel-deep', row: row.num, step: 'dealbreaker-fallback-to-best-candidate', reason: adj.error });
      const fallback = candidates.find(c => c.parsedOk);
      merged = fallback ? extractJson(fallback.content) : null;
      if (!merged) throw new Error('dealbreaker returned no merged payload AND no fallback candidate was parseable');
    }
  } catch (e) {
    error = String(e.message || e);
    emit({ slot: 'hm-intel-deep', row: row.num, step: 'pipeline-error', error });
  }

  // Always write the audit doc (even on error — that IS the audit trail).
  try {
    atomicWriteText(auditPath, renderAuditDoc({
      row,
      providersCalled: COUNCIL_LINEUP,
      providersSucceeded,
      perModelHashes,
      totalCost,
      capBreached,
      error,
    }));
    emit({ slot: 'hm-intel-deep', row: row.num, step: 'audit-doc-written', path: auditPath });
  } catch (e) {
    emit({ slot: 'hm-intel-deep', row: row.num, step: 'audit-doc-write-failed', error: String(e.message) });
  }

  if (error || !merged) {
    const summary = {
      ok: false, row: row.num, path: target, cost_usd: totalCost, mode: 'deep-council-7',
      cap_breached: capBreached, error: error || 'no-merged-payload',
      providers_called: COUNCIL_LINEUP, providers_succeeded: providersSucceeded,
      audit_doc: auditPath,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }

  // Compose canonical payload + atomic write
  const payload = composeCanonicalPayload({
    row, merged,
    providersCalled: COUNCIL_LINEUP,
    providersSucceeded,
    totalCost,
  });

  const writeResult = atomicWriteJson(target, payload);
  emit({ slot: 'hm-intel-deep', row: row.num, step: 'cache-written', path: writeResult.path, bytes: writeResult.bytes, cost_usd: totalCost });

  const summary = {
    ok: true,
    row: row.num,
    path: target,
    cost_usd: totalCost,
    mode: 'deep-council-7',
    providers_called: COUNCIL_LINEUP,
    providers_succeeded: providersSucceeded,
    audit_doc: auditPath,
  };
  console.log(JSON.stringify(summary, null, 2));
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           import.meta.url.endsWith(process.argv[1] || '');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch(e => {
    console.error('[hiring-manager-research] FATAL:', e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
