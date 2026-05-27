#!/usr/bin/env node
/**
 * scripts/agents/intel-refresh.mjs — Intel-refresh agent.
 *
 * Mitchell · ALPHA overnight haul · 2026-05-19. Phase 4.2 nuclear sweep ·
 * 2026-05-23: extended from 4 → 7 slots so the drawer's "Deep refresh"
 * button label ("re-run liveness + JD scrape + HM research + corpus
 * reindex + rebuild") finally matches what fires under the hood.
 *
 * Fills 7 cache slots for one apply-now row (or every row when --all):
 *   1. hm-intel         — data/hm-intel/<slug>.json   (HM + recruiter + comp + gaps)
 *   2. toxicity         — data/company-toxicity-cache/<companySlug>.json
 *   3. strategy-ceiling — data/strategy-ceiling/<num>-<metric>.json (per-metric advice)
 *   4. positioning      — data/positioning-cache/<num>.json (council-generated)
 *   5. liveness         — data/liveness-cache.json (URL → active|expired|uncertain)
 *   6. ats-detection    — apply-pack/<padded>-<slug>/*.ai-detection.json (per-artifact)
 *   7. role-enrichment  — data/role-enrichment/<padded>-<slug>.json (shells enrich-apply-now)
 *
 * Cache TTL: 3 days. Resumable via data/intel-refresh-state.json.
 * Concurrency: serial per slot inside a row (sequencer in caller); rate-limit
 *   backoff handled by callCouncil internally.
 *
 * CLI:
 *   node scripts/agents/intel-refresh.mjs --row 044
 *   node scripts/agents/intel-refresh.mjs --row 044 --slots hm-intel,toxicity
 *   node scripts/agents/intel-refresh.mjs --all
 *   node scripts/agents/intel-refresh.mjs --all --slots positioning
 *
 * Each refresh emits NDJSON progress to stderr so the dashboard SSE wrapper
 * can stream it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), override: true });
} catch { /* dotenv optional */ }

import { callCouncil } from '../../lib/council.mjs';
import { installRunRecord } from '../../lib/job-runs-ledger.mjs';

const __jobRun = installRunRecord('intel-refresh');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const VALID_SLOTS = ['hm-intel', 'toxicity', 'strategy-ceiling', 'positioning', 'liveness', 'ats-detection', 'role-enrichment', 'hm-chance', 'interview-likelihood', 'team-health'];
const SLOT_METRICS = ['alignment', 'interview-likelihood', 'hm-noticing'];
const STATE_PATH = join(ROOT, 'data', 'intel-refresh-state.json');
const LIVENESS_CACHE_PATH = join(ROOT, 'data', 'liveness-cache.json');
const LIVENESS_TTL_MS = TTL_MS; // 3 days — same as other slots
const APPLY_PACK_DIR = join(ROOT, 'apply-pack');
const ATS_ARTIFACTS = ['cv-tailored.md', 'cover-letter.md']; // prose-only artifacts

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch (_) {}
}

function readJsonSafe(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}

function isCacheFresh(path, ttlMs = TTL_MS) {
  if (!existsSync(path)) return false;
  try { return Date.now() - statSync(path).mtimeMs < ttlMs; } catch { return false; }
}

function loadState() {
  return readJsonSafe(STATE_PATH) || { rows: {}, last_run: null };
}

function saveState(state) {
  // Atomic write — temp + rename — closes the half-written-state-file failure
  // mode where a process death between writeFileSync open + close leaves
  // STATE_PATH corrupt. With rename, the file either has the prior contents
  // or the new contents — never partial.
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmpPath = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmpPath, STATE_PATH);
  } catch (_) { /* */ }
}

/**
 * Post-write disk verification for child-script slots.
 *
 * The 4 spawnSync slots (hm-intel, role-enrichment, hm-chance,
 * interview-likelihood) shell out to child scripts and previously trusted
 * `result.status === 0` as the success signal. That trust was the source of
 * the row-2387 state-disk drift bug — populate-hm-intel-mini.mjs (or its
 * sibling scripts) can exit 0 without writing to the expected target path.
 *
 * This helper closes that surface by verifying disk-after-exit: if exit_code
 * is 0 but `target` does not exist OR is zero-bytes, downgrade to
 * { ok: false, error: 'script-exited-0-but-no-disk-artifact' }.
 *
 * @param {Object} args
 * @param {string} args.slot         — slot name for emit() telemetry
 * @param {Object} args.row          — apply-now row { num, company, role }
 * @param {string} args.target       — expected disk-artifact path
 * @param {Object} args.spawnResult  — return value of child_process.spawnSync
 * @returns {{ok:boolean, exit_code:number, path:string, error?:string}}
 */
export function verifyChildScriptDiskWrite({ slot, row, target, spawnResult }) {
  const exitCode = spawnResult.status;
  if (exitCode !== 0) {
    return { ok: false, exit_code: exitCode, path: target, error: `exit_code=${exitCode}` };
  }
  if (!existsSync(target)) {
    emit({ slot, row: row.num, step: 'verification-failed', expected: target, reason: 'no-disk-artifact-after-exit-0' });
    return { ok: false, exit_code: exitCode, path: target, error: 'script-exited-0-but-no-disk-artifact' };
  }
  try {
    if (statSync(target).size === 0) {
      emit({ slot, row: row.num, step: 'verification-failed', expected: target, reason: 'empty-file' });
      return { ok: false, exit_code: exitCode, path: target, error: 'script-wrote-empty-file' };
    }
  } catch (e) {
    return { ok: false, exit_code: exitCode, path: target, error: `stat-failed: ${e.message}` };
  }
  return { ok: true, exit_code: exitCode, path: target };
}

/**
 * Compute the next state.rows[rowId] entry from the prior entry + this run's
 * per-slot results. Pure function — no I/O — for testability.
 *
 * Semantics (closes the state-disk drift bug):
 *   - slots that returned ok:true with cache='hit' or 'skipped'  → done (trust)
 *   - slots that returned ok:true with cache='miss' and a path   → done IF disk-verifier passed earlier (already filtered into res.ok)
 *   - slots that returned ok:true with no cache field but path   → done (in-process slots that wrote successfully)
 *   - slots that returned ok:true with per_metric / per_artifact → done (multi-file slots have internal write checks)
 *   - slots that returned ok:false                               → failed (recorded with structured error)
 *   - slots NOT touched this run                                  → preserved from prior state (set-union)
 *
 * @param {Object} args
 * @param {Object|null} args.prevRowState — prior state.rows[rowId] or null
 * @param {Object}      args.results      — per-slot result map for this run
 * @param {string}      args.now          — ISO timestamp for last_refresh
 * @returns {{ last_refresh: string, slots_done: string[], slots_failed?: Array }}
 */
export function computeRowStateAfterRun({ prevRowState, results, now }) {
  const prevDone = Array.isArray(prevRowState?.slots_done) ? prevRowState.slots_done : [];
  const newlyDone = [];
  const newlyFailed = [];
  for (const [slot, res] of Object.entries(results || {})) {
    if (!res || typeof res !== 'object') continue;
    if (res.ok === true) {
      newlyDone.push(slot);
    } else if (res.ok === false) {
      newlyFailed.push({
        slot,
        error: String(res.error || `exit_code=${res.exit_code}` || 'unknown'),
        attempted_at: now,
      });
    }
    // res.ok undefined → slot didn't actually run (shouldn't happen in practice).
  }
  // Set-union of previously-done + newly-done, MINUS any slot that failed this run.
  // (A slot that succeeded yesterday but failed today MUST be removed from done.)
  const failedSet = new Set(newlyFailed.map(f => f.slot));
  const combined = new Set([...prevDone, ...newlyDone].filter(s => !failedSet.has(s)));
  const slots_done = Array.from(combined).sort();
  const out = { last_refresh: now, slots_done };
  if (newlyFailed.length) out.slots_failed = newlyFailed;
  return out;
}

function extractJson(c) {
  const t = String(c || '').trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch (_) {} }
  const fenced = c.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
  const s = c.indexOf('{'); const e = c.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch (_) {} }
  return null;
}

/* -------- SLOT 1: hm-intel — shell out to the existing researcher script -------- */
async function refreshHmIntel(row, opts = {}) {
  const slug = `${slugify(row.company)}-${slugify(row.role)}`;
  const target = join(ROOT, 'data', 'hm-intel', `${slug}.json`);
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'hm-intel', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  // Routing (2026-05-25 full-spec restoration):
  //   - When called with mode === 'deep-council-7' OR opts.deep === true
  //     (the dashboard's "Deep refresh" modal sets this), shell out to the
  //     real full-spec agent at scripts/hiring-manager-research.mjs.
  //   - Otherwise (nightly --all, mini refreshes), fall through to
  //     scripts/populate-hm-intel-mini.mjs which is cheaper (~$0.10/row).
  // The full-spec script enforces $50/row hard cap + $1000/month hard
  // refusal independently — intel-refresh does not need to repeat budget
  // logic.
  const deep = opts.deep === true || opts.mode === 'deep-council-7';
  const fullSpecPath = join(ROOT, 'scripts', 'hiring-manager-research.mjs');
  const miniPath     = join(ROOT, 'scripts', 'populate-hm-intel-mini.mjs');
  const scriptPath   = deep ? fullSpecPath : miniPath;

  if (!existsSync(scriptPath)) {
    emit({ slot: 'hm-intel', row: row.num, step: 'skipped-missing-script', script: scriptPath });
    const hasCache = existsSync(target);
    return { ok: hasCache, cache: hasCache ? 'kept_due_to_missing_script' : 'no_cache_and_no_script', path: target, missing_script: true };
  }

  emit({ slot: 'hm-intel', row: row.num, step: 'starting-research', mode: deep ? 'deep-council-7' : 'mini', script: scriptPath });
  const { spawnSync } = await import('child_process');
  const args = deep
    ? [scriptPath, '--row', String(row.num), ...(opts.force ? ['--force'] : [])]
    : [scriptPath, '--rows', String(row.num)];
  const result = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit', env: process.env, timeout: 1500_000 });
  emit({ slot: 'hm-intel', row: row.num, step: 'research-done', exit_code: result.status, path: target, mode: deep ? 'deep-council-7' : 'mini' });
  // Post-write verification — closes the state-disk drift bug (canonical
  // incident: row 2387 example-co 2026-05-26). Child script may exit 0 without
  // writing target.
  const verification = verifyChildScriptDiskWrite({ slot: 'hm-intel', row, target, spawnResult: result });
  return { ...verification, mode: deep ? 'deep-council-7' : 'mini' };
}

/* -------- SLOT 2: toxicity composite -------- */
async function refreshToxicity(row, opts = {}) {
  const companySlug = slugify(row.company);
  const target = join(ROOT, 'data', 'company-toxicity-cache', `${companySlug}.json`);
  mkdirSync(dirname(target), { recursive: true });
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'toxicity', company: row.company, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }

  emit({ slot: 'toxicity', company: row.company, step: 'researching' });
  const prompt = [
    `# Task — toxicity research for ${row.company}`,
    `Pull employee + ex-employee sentiment from the last 90 days. Sources: Glassdoor, Blind, Reddit r/cscareerquestions, Levels.fyi forums, LinkedIn employee posts, X mentions.`,
    `For each signal, quote the EXACT excerpt (≤200 chars), cite the URL, give a verdict (good/neutral/concerning/blocker).`,
    ``,
    `Return STRICT JSON:`,
    `{`,
    `  "company": "${row.company}",`,
    `  "as_of": "ISO date",`,
    `  "signals": [{ "source": "glassdoor|blind|reddit|levels|linkedin|x", "excerpt": "...", "url": "...", "verdict": "good|neutral|concerning|blocker", "topic": "comp|wlb|management|tech|culture|reorg" }],`,
    `  "composite_score": 0.0,`,
    `  "composite_band": "healthy|mixed|caution|avoid",`,
    `  "drivers": ["1-line summary of the top 3 drivers"],`,
    `  "blockers": ["any single signal that should kill the application by itself"]`,
    `}`,
    `Only include signals where you have a real URL. Never invent quotes.`,
  ].join('\n');

  let cost = 0;
  let council;
  try {
    council = await callCouncil({
      prompt,
      models: ['perplexity:sonar-deep-research', 'xai:grok-4-x-search'],
      opts: { timeoutMs: 180000, maxTokens: 4000 },
    });
    cost = council.report?.totalCost || 0;
  } catch (e) {
    emit({ slot: 'toxicity', company: row.company, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }

  // Merge signals across the two models
  const allSignals = [];
  let composite_score = null;
  let composite_band = null;
  for (const r of council.results || []) {
    if (r.error || !r.content) continue;
    const parsed = extractJson(r.content);
    if (!parsed) continue;
    if (Array.isArray(parsed.signals)) allSignals.push(...parsed.signals);
    if (typeof parsed.composite_score === 'number') composite_score = parsed.composite_score;
    if (parsed.composite_band) composite_band = parsed.composite_band;
  }

  const cache = {
    company: row.company,
    company_slug: companySlug,
    as_of: new Date().toISOString(),
    signals: allSignals,
    composite_score,
    composite_band,
    blockers: allSignals.filter(s => s.verdict === 'blocker'),
    drivers: [...new Set(allSignals.map(s => s.topic).filter(Boolean))].slice(0, 5),
    meta: { cost_usd: cost, models_responded: (council.results || []).filter(r => !r.error).map(r => r.model) },
  };
  writeFileSync(target, JSON.stringify(cache, null, 2), 'utf-8');
  emit({ slot: 'toxicity', company: row.company, step: 'done', signals_count: allSignals.length, composite_band, cost_usd: cost });
  return { ok: true, cache: 'miss', path: target, cost_usd: cost };
}

/* -------- SLOT 3: strategy-ceiling — per-metric per-row -------- */
async function refreshStrategyCeiling(row, opts = {}) {
  const padded = String(row.num).padStart(3, '0');
  // refresh-master Phase 1.5: full cv.md goes into opts.cacheStableContent
  // so Anthropic adapters cache it across all 3 metric refreshes (and across
  // all rows in a single refresh-master pass). Anthropic min cacheable = 1024
  // tokens (~3.5KB chars); full cv.md is ~7-10KB so it qualifies.
  const cvText = existsSync(join(ROOT, 'cv.md')) ? readFileSync(join(ROOT, 'cv.md'), 'utf-8') : '';
  const profileText = existsSync(join(ROOT, 'modes/_profile.md')) ? readFileSync(join(ROOT, 'modes/_profile.md'), 'utf-8') : '';
  const stableCorpus = [
    cvText ? `=== cv.md ===\n${cvText}` : '',
    profileText ? `=== modes/_profile.md ===\n${profileText}` : '',
  ].filter(Boolean).join('\n\n');
  const results = {};
  let totalCost = 0;
  for (const metric of SLOT_METRICS) {
    const target = join(ROOT, 'data', 'strategy-ceiling', `${padded}-${metric}.json`);
    mkdirSync(dirname(target), { recursive: true });
    if (!opts.force && isCacheFresh(target)) {
      results[metric] = { cache: 'hit', path: target };
      emit({ slot: 'strategy-ceiling', metric, row: row.num, cache: 'hit' });
      continue;
    }
    emit({ slot: 'strategy-ceiling', metric, row: row.num, step: 'computing' });
    const prompt = [
      `# Task — strategy-ceiling for metric "${metric}" — ${row.company} ${row.role}`,
      `Mitchell is targeting this role. Given the JD + the cv.md + modes/_profile.md context above + HM intel, what is Mitchell's CURRENT ceiling on ${metric}, and what concrete moves would raise it 5-15 points before he applies?`,
      ``,
      `## Role`,
      `${row.company} — ${row.role}`,
      ``,
      `Return STRICT JSON:`,
      `{`,
      `  "metric": "${metric}",`,
      `  "current_estimate_pct": 0,`,
      `  "ceiling_estimate_pct": 0,`,
      `  "ceiling_lift_moves": [{ "move": "...", "lift_pct": 5, "effort": "low|medium|high", "evidence_citation": "cv.md:NN or hm-intel field" }],`,
      `  "blockers": ["specific blocker that caps the ceiling"],`,
      `  "next_action": "the single highest-leverage move this week"`,
      `}`,
    ].join('\n');

    let council;
    try {
      council = await callCouncil({
        prompt,
        models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5'],
        opts: { timeoutMs: 180000,
          maxTokens: 2000,
          cacheStableContent: stableCorpus,
          cacheCaller: `intel-refresh:strategy-ceiling:${metric}`,
        },
      });
      totalCost += council.report?.totalCost || 0;
    } catch (e) {
      emit({ slot: 'strategy-ceiling', metric, error: String(e.message || e) });
      results[metric] = { ok: false, error: String(e.message || e) };
      continue;
    }
    const parses = (council.results || []).map(r => (r.content ? extractJson(r.content) : null)).filter(Boolean);
    // Take the parse with the most ceiling_lift_moves (richest)
    const best = parses.sort((a, b) => ((b.ceiling_lift_moves || []).length - (a.ceiling_lift_moves || []).length))[0] || {};
    const cache = {
      metric, row: row.num, company: row.company, role: row.role,
      as_of: new Date().toISOString(),
      ...best,
      meta: { models_responded: (council.results || []).filter(r => !r.error).map(r => r.model), cost_usd: council.report?.totalCost || 0 },
    };
    writeFileSync(target, JSON.stringify(cache, null, 2), 'utf-8');
    results[metric] = { cache: 'miss', path: target, lift_moves: (best.ceiling_lift_moves || []).length };
    emit({ slot: 'strategy-ceiling', metric, row: row.num, step: 'done', lift_moves: (best.ceiling_lift_moves || []).length });
  }
  return { ok: true, per_metric: results, cost_usd: totalCost };
}

/* -------- SLOT 4: positioning -------- */
async function refreshPositioning(row, opts = {}) {
  const padded = String(row.num).padStart(3, '0');
  const target = join(ROOT, 'data', 'positioning-cache', `${padded}.json`);
  mkdirSync(dirname(target), { recursive: true });
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'positioning', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  emit({ slot: 'positioning', row: row.num, step: 'asking-council' });

  const hmIntelPath = join(ROOT, 'data', 'hm-intel', `${slugify(row.company)}-${slugify(row.role)}.json`);
  const hmIntel = readJsonSafe(hmIntelPath) || {};
  const cvText = existsSync(join(ROOT, 'cv.md')) ? readFileSync(join(ROOT, 'cv.md'), 'utf-8') : '';
  const profileText = existsSync(join(ROOT, 'modes/_profile.md')) ? readFileSync(join(ROOT, 'modes/_profile.md'), 'utf-8') : '';
  // refresh-master Phase 1.5 cached stable corpus.
  const stableCorpus = [
    cvText ? `=== cv.md ===\n${cvText}` : '',
    profileText ? `=== modes/_profile.md ===\n${profileText}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = [
    `# Task — strongest 3-sentence positioning for Mitchell at ${row.company} — ${row.role}`,
    `Given Mitchell's cv.md + modes/_profile.md above, the JD, and HM intel below, what are the strongest 3 sentences that frame Mitchell's positioning for THIS role? Position him as: (1) the must-meet candidate the HM has on their short list, (2) a 90-day net positive, (3) someone who closes a specific team gap.`,
    ``,
    `## HM intel`,
    JSON.stringify(hmIntel).slice(0, 4000),
    ``,
    `Return STRICT JSON:`,
    `{`,
    `  "positioning_three_sentences": ["sentence 1", "sentence 2", "sentence 3"],`,
    `  "positioning_one_sentence": "the strongest single positioning sentence — for LinkedIn DM use",`,
    `  "anti_positioning": ["framings to AVOID — would hurt the application"],`,
    `  "evidence_citations": ["cv.md:NN — what proof point each sentence anchors to"],`,
    `  "warnings": ["any concern about overclaim or stretch"]`,
    `}`,
  ].join('\n');

  let council, cost = 0;
  try {
    council = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5', 'google:gemini-2.5-pro', 'perplexity:sonar-pro'],
      opts: { timeoutMs: 180000,
        maxTokens: 2500,
        cacheStableContent: stableCorpus,
        cacheCaller: 'intel-refresh:positioning',
      },
    });
    cost = council.report?.totalCost || 0;
  } catch (e) {
    emit({ slot: 'positioning', error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }

  // Adjudicate via Sonnet (cost-distribution Part 2, 2026-05-25 — downgraded
  // from Opus 4.7. Adjudication framing preserved; same skeptical posture.).
  const allParses = (council.results || []).map(r => (r.content ? extractJson(r.content) : null)).filter(Boolean);
  const adjPrompt = [
    `You are the dealbreaker layer. Adjudicate the council's positioning candidates for Mitchell at ${row.company} — ${row.role}.`,
    `Per-model responses: ${JSON.stringify(allParses).slice(0, 5000)}`,
    ``,
    `Return STRICT JSON with the FINAL positioning Mitchell should use:`,
    `{ "positioning_three_sentences": [...], "positioning_one_sentence": "...", "anti_positioning": [...], "evidence_citations": [...], "warnings": [...], "dealbreaker_notes": "..." }`,
    ``,
    `Be ruthless. Prune anything no model could ground in cv.md / HM intel.`,
  ].join('\n');

  let final = allParses[0] || {};
  try {
    const adj = await callCouncil({
      prompt: adjPrompt,
      // cost-distribution Part 2 (2026-05-25): positioning adjudicator downgraded
      // from Opus 4.7 to Sonnet 4.6. Adjudication is a structured-extraction
      // task; Sonnet handles it reliably at ~5x lower cost.
      models: ['anthropic:claude-sonnet-4-6'],
      opts: { timeoutMs: 180000,
        maxTokens: 2000,
        cacheStableContent: stableCorpus,
        cacheCaller: 'intel-refresh:positioning:adjudicate',
      },
    });
    cost += adj.report?.totalCost || 0;
    const adjParsed = adj.results?.[0]?.content ? extractJson(adj.results[0].content) : null;
    if (adjParsed) final = adjParsed;
  } catch (e) {
    emit({ slot: 'positioning', adj_error: String(e.message || e) });
  }

  const cache = {
    row: row.num, company: row.company, role: row.role,
    as_of: new Date().toISOString(),
    ...final,
    meta: { models_responded: (council.results || []).filter(r => !r.error).map(r => r.model), cost_usd: cost },
  };
  writeFileSync(target, JSON.stringify(cache, null, 2), 'utf-8');
  emit({ slot: 'positioning', row: row.num, step: 'done', cost_usd: cost });
  return { ok: true, cache: 'miss', path: target, cost_usd: cost };
}

/* -------- SLOT 5: liveness — verify the canonical_url is still active -------- */
async function refreshLiveness(row, opts = {}) {
  const url = row.canonical_url || row.url || null;
  if (!url) {
    emit({ slot: 'liveness', row: row.num, step: 'no-url' });
    return { ok: true, cache: 'skipped', reason: 'no canonical_url on row' };
  }
  // Lazy-import so non-liveness refreshes don't pay the loader cost.
  const { verifyApplyNowLink } = await import('../../lib/liveness.mjs');
  // Read existing cache to support TTL semantics — liveness-cache.json is URL-keyed.
  let cache = {};
  if (existsSync(LIVENESS_CACHE_PATH)) {
    try { cache = JSON.parse(readFileSync(LIVENESS_CACHE_PATH, 'utf-8')) || {}; } catch { cache = {}; }
  }
  const prior = cache[url];
  if (!opts.force && prior && prior.ts && (Date.now() - prior.ts < LIVENESS_TTL_MS)) {
    emit({ slot: 'liveness', row: row.num, cache: 'hit', status: prior.status });
    return { ok: true, cache: 'hit', status: prior.status, reason: prior.reason };
  }
  emit({ slot: 'liveness', row: row.num, step: 'probing', url: url.slice(0, 80) });
  let verdict;
  try {
    verdict = await verifyApplyNowLink(url);
  } catch (e) {
    emit({ slot: 'liveness', row: row.num, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
  cache[url] = { status: verdict.result, reason: verdict.reason, ts: Date.now() };
  try {
    mkdirSync(dirname(LIVENESS_CACHE_PATH), { recursive: true });
    writeFileSync(LIVENESS_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (e) {
    emit({ slot: 'liveness', row: row.num, write_error: String(e.message || e) });
  }
  emit({ slot: 'liveness', row: row.num, step: 'done', status: verdict.result, reason: verdict.reason });
  return { ok: true, cache: 'miss', status: verdict.result, reason: verdict.reason, path: LIVENESS_CACHE_PATH };
}

/* -------- SLOT 6: ats-detection — re-run detectors on prose artifacts -------- */
async function refreshAtsDetection(row, opts = {}) {
  const padded = String(row.num).padStart(3, '0');
  const packSlug = `${padded}-${slugify(row.company)}-${slugify(row.role)}`;
  const packDir = join(APPLY_PACK_DIR, packSlug);
  if (!existsSync(packDir)) {
    emit({ slot: 'ats-detection', row: row.num, step: 'skipped-no-pack', expected: packDir });
    return { ok: true, cache: 'skipped', reason: 'no apply-pack on disk' };
  }
  const { checkArtifact } = await import('../../lib/ai-detection-gate.mjs');
  const results = {};
  let writes = 0;
  let totalProseWords = 0;
  for (const artifact of ATS_ARTIFACTS) {
    const filePath = join(packDir, artifact);
    if (!existsSync(filePath)) {
      emit({ slot: 'ats-detection', row: row.num, artifact, step: 'skipped-missing' });
      results[artifact] = { ok: false, reason: 'file missing' };
      continue;
    }
    const sidecar = `${filePath}.ai-detection.json`;
    if (!opts.force && isCacheFresh(sidecar)) {
      emit({ slot: 'ats-detection', row: row.num, artifact, cache: 'hit' });
      results[artifact] = { ok: true, cache: 'hit', path: sidecar };
      continue;
    }
    emit({ slot: 'ats-detection', row: row.num, artifact, step: 'detecting' });
    try {
      const result = await checkArtifact(filePath, {});
      writes++;
      totalProseWords += result.prose_word_count || 0;
      results[artifact] = {
        ok: true,
        cache: 'miss',
        band: result.band,
        path: sidecar,
        prose_word_count: result.prose_word_count,
      };
      emit({ slot: 'ats-detection', row: row.num, artifact, step: 'done', band: result.band });
    } catch (e) {
      emit({ slot: 'ats-detection', row: row.num, artifact, error: String(e.message || e) });
      results[artifact] = { ok: false, error: String(e.message || e) };
    }
  }
  return { ok: true, cache: writes > 0 ? 'miss' : 'hit', per_artifact: results, prose_word_count_total: totalProseWords, pack_dir: packDir };
}

/* -------- SLOT 7: role-enrichment — shell out to enrich-apply-now -------- */
async function refreshRoleEnrichment(row, opts = {}) {
  // enrich-apply-now's writer uses `bf<num>` prefix for --rows mode (backfill) and
  // `<rankPad2>` prefix for --ranks mode (curated top-35). Most refreshes go through
  // --rows because the apply-now-queue ranks are stale relative to applications.md.
  // We check BOTH patterns so a refresh after a curated --ranks run still hits cache.
  const slug = `${slugify(row.company)}-${slugify(row.role)}`;
  const bfTarget = join(ROOT, 'data', 'role-enrichment', `bf${row.num}-${slug}.json`);
  const rankTargetGlob = `${row.num}-${slug}.json`; // unpadded; rankPad search below tolerates leading zeros
  const enrichDir = join(ROOT, 'data', 'role-enrichment');
  // Cache freshness check: prefer the backfill path; fall back to any matching slug
  // (rank-mode files share the slug suffix).
  let target = bfTarget;
  let cacheHit = false;
  if (!opts.force && isCacheFresh(bfTarget)) {
    cacheHit = true;
  } else if (!opts.force && existsSync(enrichDir)) {
    try {
      const { readdirSync } = await import('node:fs');
      const matches = readdirSync(enrichDir).filter(f => f.endsWith(`-${slug}.json`));
      for (const f of matches) {
        const fp = join(enrichDir, f);
        if (isCacheFresh(fp)) { target = fp; cacheHit = true; break; }
      }
    } catch { /* fall through */ }
  }
  if (cacheHit) {
    emit({ slot: 'role-enrichment', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  const scriptPath = join(ROOT, 'scripts', 'enrich-apply-now.mjs');
  if (!existsSync(scriptPath)) {
    emit({ slot: 'role-enrichment', row: row.num, step: 'skipped-missing-script', script: scriptPath });
    const hasCache = existsSync(bfTarget);
    return { ok: hasCache, cache: hasCache ? 'kept_due_to_missing_script' : 'no_cache_and_no_script', path: bfTarget, missing_script: true };
  }
  emit({ slot: 'role-enrichment', row: row.num, step: 'enriching' });
  const { spawnSync } = await import('child_process');
  // enrich-apply-now accepts --rows=N (kebab-with-equals form).
  const args = [scriptPath, `--rows=${row.num}`];
  const result = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit', env: process.env, timeout: 600_000 });
  emit({ slot: 'role-enrichment', row: row.num, step: 'enrichment-done', exit_code: result.status, path: bfTarget });
  // Post-write verification — closes the state-disk drift bug.
  return verifyChildScriptDiskWrite({ slot: 'role-enrichment', row, target: bfTarget, spawnResult: result });
}

/* -------- SLOT 8: hm-chance — companion-agent chip popout (--deep only by default) -------- */
async function refreshHmChance(row, opts = {}) {
  const slug = `${String(row.num).padStart(3, '0')}-${slugify(row.company)}-${slugify(row.role)}`;
  const target = join(ROOT, 'data', 'hm-chance', `${slug}.json`);
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'hm-chance', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  const scriptPath = join(ROOT, 'scripts', 'agents', 'hm-chance.mjs');
  if (!existsSync(scriptPath)) {
    emit({ slot: 'hm-chance', row: row.num, step: 'skipped-missing-script', script: scriptPath });
    return { ok: false, cache: 'no_script', missing_script: true };
  }
  emit({ slot: 'hm-chance', row: row.num, step: 'starting-research', script: scriptPath });
  const { spawnSync } = await import('child_process');
  const args = [scriptPath, '--row', String(row.num), '--max-cost-usd', '30'];
  if (opts.force) args.push('--force');
  const result = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit', env: process.env, timeout: 600_000 });
  emit({ slot: 'hm-chance', row: row.num, step: 'research-done', exit_code: result.status, path: target });
  // Post-write verification — closes the state-disk drift bug.
  return verifyChildScriptDiskWrite({ slot: 'hm-chance', row, target, spawnResult: result });
}

/* -------- SLOT 9: interview-likelihood — companion-agent chip popout (--deep only by default) -------- */
async function refreshInterviewLikelihood(row, opts = {}) {
  const slug = `${String(row.num).padStart(3, '0')}-${slugify(row.company)}-${slugify(row.role)}`;
  const target = join(ROOT, 'data', 'interview-likelihood', `${slug}.json`);
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'interview-likelihood', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  const scriptPath = join(ROOT, 'scripts', 'agents', 'interview-likelihood.mjs');
  if (!existsSync(scriptPath)) {
    emit({ slot: 'interview-likelihood', row: row.num, step: 'skipped-missing-script', script: scriptPath });
    return { ok: false, cache: 'no_script', missing_script: true };
  }
  emit({ slot: 'interview-likelihood', row: row.num, step: 'starting-research', script: scriptPath });
  const { spawnSync } = await import('child_process');
  const args = [scriptPath, '--row', String(row.num), '--max-cost-usd', '25'];
  if (opts.force) args.push('--force');
  const result = spawnSync('node', args, { cwd: ROOT, stdio: 'inherit', env: process.env, timeout: 600_000 });
  emit({ slot: 'interview-likelihood', row: row.num, step: 'research-done', exit_code: result.status, path: target });
  // Post-write verification — closes the state-disk drift bug.
  return verifyChildScriptDiskWrite({ slot: 'interview-likelihood', row, target, spawnResult: result });
}

/* -------- SLOT 10: team-health — corpus-grounded synthesis (PR-04, 2026-05-25) -------- */
async function refreshTeamHealth(row, opts = {}) {
  // company-slug (NOT role-slug) — team-health is shared across roles at the
  // same company, cached at data/team-health/<company-slug>.json.
  const companySlug = slugify(row.company);
  const target = join(ROOT, 'data', 'team-health', `${companySlug}.json`);
  if (!opts.force && isCacheFresh(target)) {
    emit({ slot: 'team-health', row: row.num, cache: 'hit', path: target });
    return { ok: true, cache: 'hit', path: target };
  }
  emit({ slot: 'team-health', row: row.num, step: 'starting-synthesis', company: row.company });
  try {
    const { synthesizeTeamHealth } = await import('../../lib/team-health-synthesis.mjs');
    const result = await synthesizeTeamHealth({
      slug: companySlug,
      opts: {
        companyName: row.company,
        roleName: row.role,
        rowId: String(row.num),
        force: opts.force,
      },
    });
    const ok = result.status === 'SYNTHESIZED' || result.status === 'CACHED';
    emit({
      slot: 'team-health',
      row: row.num,
      step: 'synthesis-done',
      status: result.status,
      confidence: result.confidence,
      cost_usd: result.cost_usd,
      path: target,
    });
    return { ok, status: result.status, confidence: result.confidence, cost_usd: result.cost_usd, path: target };
  } catch (err) {
    emit({ slot: 'team-health', row: row.num, step: 'synthesis-failed', error: err.message });
    return { ok: false, error: err.message, path: target };
  }
}

/* -------- Main orchestrator -------- */
async function refreshRow(row, slots, opts = {}) {
  const out = {};
  // 'all' = the 7 standard slots. The 2 companion-agent slots (hm-chance,
  // interview-likelihood) cost ~$3-5/row extra and only fire when explicit-listed
  // OR when opts.deep (the dashboard's "Deep refresh" modal sets mode='deep-council-7').
  // team-health (PR-04) routes to corpus-grounded synth — fires when explicit
  // OR on --all sweeps. ~$0.30/row average.
  const isDeep = opts.deep === true || opts.mode === 'deep-council-7';
  const allIncludesDeep = slots.includes('all') && isDeep;
  if (slots.includes('hm-intel') || slots.includes('all')) out['hm-intel'] = await refreshHmIntel(row, opts);
  if (slots.includes('toxicity') || slots.includes('all')) out.toxicity = await refreshToxicity(row, opts);
  if (slots.includes('strategy-ceiling') || slots.includes('strategy') || slots.includes('all')) out['strategy-ceiling'] = await refreshStrategyCeiling(row, opts);
  if (slots.includes('positioning') || slots.includes('all')) out.positioning = await refreshPositioning(row, opts);
  if (slots.includes('liveness') || slots.includes('all')) out.liveness = await refreshLiveness(row, opts);
  if (slots.includes('ats-detection') || slots.includes('ats') || slots.includes('all')) out['ats-detection'] = await refreshAtsDetection(row, opts);
  if (slots.includes('role-enrichment') || slots.includes('role') || slots.includes('all')) out['role-enrichment'] = await refreshRoleEnrichment(row, opts);
  if (slots.includes('hm-chance') || allIncludesDeep) out['hm-chance'] = await refreshHmChance(row, opts);
  if (slots.includes('interview-likelihood') || allIncludesDeep) out['interview-likelihood'] = await refreshInterviewLikelihood(row, opts);
  if (slots.includes('team-health') || slots.includes('all')) out['team-health'] = await refreshTeamHealth(row, opts);
  return out;
}

export async function runIntelRefresh({ row, rowId, slots = ['all'], all = false, opts = {} } = {}) {
  const t0 = Date.now();
  const state = loadState();

  const apqPath = join(ROOT, 'data', 'apply-now-queue.json');
  if (!existsSync(apqPath)) return { ok: false, error: 'apply-now-queue.json missing' };
  const apq = JSON.parse(readFileSync(apqPath, 'utf-8'));
  const ranked = apq.ranked || [];

  let targetRows;
  if (all) {
    targetRows = ranked.filter(r => r && r.num);
  } else {
    const id = Number(rowId || row);
    targetRows = ranked.filter(r => r && Number(r.num) === id);
    if (!targetRows.length) return { ok: false, error: `row ${rowId || row} not in apply-now-queue` };
  }

  emit({ phase: 'init', rows: targetRows.length, slots });

  const results = {};
  for (const r of targetRows) {
    emit({ phase: 'row-start', row: r.num, company: r.company, role: r.role });
    try {
      results[r.num] = await refreshRow(r, slots, opts);
      // PR-E (2026-05-26): set-union of previously-done + this-run's disk-verified
      // slots, MINUS any slot that failed this run. Was Object.keys(results) which
      // (a) silently included slots whose child-script exited 0 without writing
      // disk artifact, and (b) overwrote prior slots_done on targeted retry.
      state.rows[r.num] = computeRowStateAfterRun({
        prevRowState: state.rows[r.num] || null,
        results: results[r.num],
        now: new Date().toISOString(),
      });
      saveState(state);
    } catch (e) {
      results[r.num] = { error: String(e.message || e) };
      emit({ phase: 'row-error', row: r.num, error: String(e.message || e) });
    }
    emit({ phase: 'row-done', row: r.num });
  }

  state.last_run = new Date().toISOString();
  saveState(state);

  const summary = { ok: true, duration_ms: Date.now() - t0, rows_processed: targetRows.length, results };
  emit({ phase: 'complete', ...summary, results: undefined });
  return summary;
}

/* CLI */
async function cliMain() {
  const args = process.argv.slice(2);
  function arg(f, fb) { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : fb; }
  function flag(f) { return args.includes(f); }
  const row = arg('--row', null);
  const all = flag('--all');
  const force = flag('--force');
  const slotsArg = arg('--slots', 'all');
  // --mode deep-council-7  ⇒  hm-intel slot routes to the full-spec
  // scripts/hiring-manager-research.mjs (council-of-7 + dealbreaker)
  // instead of the cheap mini script. The dashboard's "Deep refresh"
  // modal POSTs to /api/refresh-deep which sets this mode.
  const mode = arg('--mode', null);
  const slots = slotsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (!all && !row) {
    process.stderr.write('Usage: node scripts/agents/intel-refresh.mjs --row <N>  OR  --all\n');
    process.exit(2);
  }
  const out = await runIntelRefresh({ row, all, slots, opts: { force, mode, deep: mode === 'deep-council-7' } });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.ok ? 0 : 1);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) cliMain().catch(err => { process.stderr.write(`FATAL: ${err.stack || err}\n`); process.exit(3); });
