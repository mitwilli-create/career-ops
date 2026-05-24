#!/usr/bin/env node
/**
 * scripts/agents/interview-likelihood.mjs — Council-adjudicated interview likelihood
 *
 * Phase 5.2 of master-resolution-prompt-2026-05-22.
 *
 * Per-row interview-likelihood JSON, populated via:
 *   1. Full council fan-out (Sonnet + GPT-5 + Gemini Pro + Perplexity Pro)
 *      grounded with cv.md, article-digest.md, the row's report, hm-intel
 *   2. Opus inline dealbreaker pass — adjudicates the 4 model responses,
 *      classifies claims (verified ≥3 / corroborated 2 / unique-distinctive 1)
 *      and emits a single consolidated JSON
 *   3. Cached 3d at data/interview-likelihood/<slug>.json
 *
 * Output schema (matches the existing /api/intel-chips consumer):
 *   {
 *     likelihood_pct: 0-100,
 *     confidence: "high" | "medium" | "low",
 *     top_strengths: [{ claim, evidence }] (3 items),
 *     real_gaps: [{ gap, severity }] (2-3 items),
 *     opening_talking_point: string,
 *     competitive_edge: string,
 *     reason_bullets: [string],         // 3-5 plain-language reasons w/ corpus citations
 *     citations: [string],              // [cv.md:N] / [article-digest.md:N] / [hm-intel] refs
 *     models_used: [string],            // council models that succeeded
 *     dealbreaker_classification: { verified: [], corroborated: [], cut: [] },
 *     generated_at: ISO,
 *     cost_usd: number,
 *     elapsed_ms: number,
 *   }
 *
 * Usage:
 *   node scripts/agents/interview-likelihood.mjs --row 48
 *   node scripts/agents/interview-likelihood.mjs --slug 048-anthropic-engineering-editorial-lead
 *   node scripts/agents/interview-likelihood.mjs --all              # runs 4 PASS rows
 *   node scripts/agents/interview-likelihood.mjs --all --force      # ignores 3d cache
 *   node scripts/agents/interview-likelihood.mjs --row 48 --dry-run # plan only
 *
 * Hang-prevention (rules in ~/.claude/projects/.../feedback_hang_prevention_patterns.md):
 *   - Council calls pass opts.timeoutMs: 180_000 (3 min) — clamped to [30s, 30min]
 *   - Opus adjudication call uses AbortSignal.timeout(180_000) + lib/safe-fetch.mjs body timeout
 *   - NDJSON heartbeat to stderr every phase boundary
 *   - Sequential per-row (no parallel fan-out across rows — council fans out per row)
 *
 * Cost target (per Decision-Maximization Policy: quality > speed > cost):
 *   - Council fan-out (4 models, ~3K-5K tokens each): ~$2-6 / row
 *   - Opus adjudication (input: 4 model responses ~8K-12K tokens, output ~1.5K): ~$5-12 / row
 *   - Total expected: $8-20 / row × 4 rows = $32-80
 *   - Hard cap: $200 / run (--max-cost-usd flag)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

import { callCouncil } from '../../lib/council.mjs';
import { fetchJson } from '../../lib/safe-fetch.mjs';
import { buildGroundedPrompt } from '../../lib/ground-prompt.mjs';
import { reserveQuota, recordTokens } from '../../lib/quota-tracker.mjs';

const OUT_DIR = join(ROOT, 'data', 'interview-likelihood');
mkdirSync(OUT_DIR, { recursive: true });

const CACHE_TTL_DAYS = 3;

// 4 PASS rows from handoff-completion-2026-05-22.md § 3.6
const PASS_ROWS = [
  { num: 48, company: 'Anthropic',   role: 'Engineering Editorial Lead',                                  slug: '048-anthropic-engineering-editorial-lead' },
  { num: 49, company: 'Perplexity',  role: 'Executive Communications Manager (Sr Manager, Exec Comms)',   slug: '049-perplexity-executive-communications-manager-sr-manager-exec-comms' },
  { num: 1,  company: 'Anthropic',   role: 'Communications Manager, Research',                            slug: '001-anthropic-communications-manager-research' },
  { num: 50, company: 'ElevenLabs',  role: 'Communications Manager',                                      slug: '050-elevenlabs-communications-manager' },
];

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}

function readSafe(path, maxChars) {
  try {
    if (!existsSync(path)) return '';
    const txt = readFileSync(path, 'utf-8');
    return maxChars ? txt.slice(0, maxChars) : txt;
  } catch { return ''; }
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function findPackDir(slug) {
  for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
    const d = join(base, slug);
    if (existsSync(d)) return d;
  }
  return null;
}

function findRoleSlug(slug) {
  // Strip the NNN- prefix: "048-anthropic-engineering-editorial-lead" -> "anthropic-engineering-editorial-lead"
  return slug.replace(/^[0-9]+-/, '');
}

function findLatestReport(num) {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return null;
  const padded = String(num).padStart(3, '0');
  try {
    const matches = readdirSync(reportsDir)
      .filter(f => f.startsWith(padded + '-') && f.endsWith('.md'))
      .sort()
      .reverse();
    return matches[0] ? join(reportsDir, matches[0]) : null;
  } catch { return null; }
}

function isCacheFresh(slug, force) {
  if (force) return false;
  const p = join(OUT_DIR, slug + '.json');
  if (!existsSync(p)) return false;
  try {
    const j = readJsonSafe(p);
    const gen = j?.generated_at;
    if (!gen) return false;
    const ageMs = Date.now() - Date.parse(gen);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays < CACHE_TTL_DAYS && (j?.method || '').startsWith('council-adjudicated');
  } catch { return false; }
}

function extractJson(content) {
  const t = String(content || '').trim();
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch {}
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}

function buildResearchPrompt({ company, role, num, cvSnippet, articleSnippet, reportSnippet, hmIntel, jdSnippet }) {
  const lines = [
    `# Task — assess Mitchell Williams's INTERVIEW LIKELIHOOD for a specific role`,
    ``,
    `Mitchell is applying to **${company} — ${role}** (apply-now row #${num}).`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Your job: estimate the realistic interview likelihood (0-100%) and back it with corpus-grounded evidence.`,
    `Be honest, not optimistic. Cite specific lines from cv.md, article-digest.md, the JD, or hm-intel in every claim.`,
    ``,
    `# Mitchell's CV (cv.md, top 6000 chars)`,
    cvSnippet || '(empty)',
    ``,
    `# Mitchell's article digest (article-digest.md, top 4000 chars)`,
    articleSnippet || '(empty)',
    ``,
    `# Prior evaluation report (auto-evaluation, top 4000 chars)`,
    reportSnippet || '(no report)',
    ``,
    `# Job description (top 6000 chars)`,
    jdSnippet || '(no JD text)',
    ``,
    `# HM intel (synthesized from council research, top 5000 chars)`,
    hmIntel || '(no HM intel)',
    ``,
    `# Output — STRICT JSON, first char "{", last char "}". No markdown, no preamble, no code fences.`,
    ``,
    `{`,
    `  "likelihood_pct": <integer 0-100>,`,
    `  "confidence": "high" | "medium" | "low",`,
    `  "top_strengths": [`,
    `    { "claim": "<short claim>", "evidence": "<corpus citation, e.g. cv.md:42 or article-digest.md:67>" },`,
    `    ...   // EXACTLY 3 items`,
    `  ],`,
    `  "real_gaps": [`,
    `    { "gap": "<short gap>", "severity": "blocking" | "significant" | "minor" },`,
    `    ...   // 2-3 items`,
    `  ],`,
    `  "opening_talking_point": "<one sentence Mitchell can lead with in his cover letter or recruiter intro>",`,
    `  "competitive_edge": "<one sentence — what Mitchell has that most candidates lack>",`,
    `  "reason_bullets": [`,
    `    "<plain-language reason with [cv.md:N] / [article-digest.md:N] / [hm-intel] citation>",`,
    `    ...   // 3-5 items`,
    `  ],`,
    `  "rationale": "<2-3 sentence justification of the percentage>"`,
    `}`,
    ``,
    `Anti-hallucination rules:`,
    `- DO NOT invent metrics, employers, or experiences not visible in the corpus.`,
    `- Cite line numbers OR file names. "cv.md" with no line is acceptable when the claim spans the whole file.`,
    `- If you can't ground a claim, drop it. Cutting beats hallucinating.`,
    `- Calibration: 0-20% = no chance, 21-40% = unlikely, 41-60% = competitive, 61-80% = strong, 81-100% = near-certain.`,
  ];
  return lines.join('\n');
}

function buildAdjudicationPrompt({ company, role, num, councilResponses }) {
  const lines = [
    `# Dealbreaker adjudication — INTERVIEW LIKELIHOOD synthesis`,
    ``,
    `4 council models have independently assessed Mitchell Williams's interview likelihood for **${company} — ${role}** (row #${num}).`,
    `Your job: act as the dealbreaker. Classify each claim verified (≥3 models agree) / corroborated (2 agree) / unique-distinctive (1 model, architecturally plausible) / unique-unsupported (1 model, suspect) / contradicted / stale.`,
    `Then emit ONE consolidated JSON that the dashboard will serve to Mitchell.`,
    ``,
    `Default to skepticism. Cut anything not corroborated or not grounded in citable evidence.`,
    `For the likelihood_pct: take the median of model estimates, then adjust ±10 based on the strength of corroborated evidence.`,
    ``,
  ];
  for (let i = 0; i < councilResponses.length; i++) {
    const r = councilResponses[i];
    lines.push(`## Model ${i + 1}: ${r.model}` + (r.modelUsed ? ` (used ${r.modelUsed})` : ''));
    lines.push('```json');
    lines.push(JSON.stringify(r.parsed, null, 2).slice(0, 4000));
    lines.push('```');
    lines.push('');
  }
  lines.push(``);
  lines.push(`# Output — STRICT JSON. First char "{", last char "}". No markdown, no preamble, no code fences.`);
  lines.push(``);
  lines.push(`{`);
  lines.push(`  "likelihood_pct": <integer 0-100, your final adjudicated estimate>,`);
  lines.push(`  "confidence": "high" | "medium" | "low",`);
  lines.push(`  "top_strengths": [{ "claim": "...", "evidence": "..." }],   // 3 items — keep only verified/corroborated`);
  lines.push(`  "real_gaps":     [{ "gap": "...", "severity": "blocking" | "significant" | "minor" }],   // 2-3 items`);
  lines.push(`  "opening_talking_point": "<one sentence>",`);
  lines.push(`  "competitive_edge":      "<one sentence>",`);
  lines.push(`  "reason_bullets":        ["<3-5 plain-language reasons with citations>"],`);
  lines.push(`  "citations":             ["<list of cv.md:N / article-digest.md:N / hm-intel refs cited>"],`);
  lines.push(`  "rationale":             "<2-3 sentences justifying the percentage>",`);
  lines.push(`  "dealbreaker_classification": {`);
  lines.push(`    "verified":     ["<claim text>"],   // ≥3 models`);
  lines.push(`    "corroborated": ["<claim text>"],   // 2 models`);
  lines.push(`    "cut":          ["<claim text> — reason cut"]`);
  lines.push(`  },`);
  lines.push(`  "model_estimates": [{ "model": "...", "pct": <int>, "confidence": "..." }]`);
  lines.push(`}`);
  return lines.join('\n');
}

async function runCouncilResearch(row, opts = {}) {
  const slug = row.slug;
  const num = row.num;
  const company = row.company;
  const role = row.role;

  emit({ slot: 'il', row: num, phase: 'load-corpus' });

  // ─── Load corpus ───
  const cvSnippet = readSafe(join(ROOT, 'cv.md'), 6000);
  const articleSnippet = readSafe(join(ROOT, 'article-digest.md'), 4000);
  const reportPath = findLatestReport(num);
  const reportSnippet = reportPath ? readSafe(reportPath, 4000) : '';
  const roleSlug = findRoleSlug(slug);
  const hmIntelJson = readJsonSafe(join(ROOT, 'data', 'hm-intel', roleSlug + '.json'));
  const hmIntel = hmIntelJson ? JSON.stringify(hmIntelJson, null, 2).slice(0, 5000) : '';
  const packDir = findPackDir(slug);
  let jdSnippet = '';
  if (packDir) {
    for (const cand of ['jd.txt', 'jd.md', 'JD.md', 'job-description.md']) {
      const p = join(packDir, cand);
      if (existsSync(p)) { jdSnippet = readSafe(p, 6000); break; }
    }
  }

  emit({ slot: 'il', row: num, phase: 'council-research',
    inputs: { cv: cvSnippet.length, article: articleSnippet.length, report: reportSnippet.length, hm: hmIntel.length, jd: jdSnippet.length },
  });

  const prompt = buildResearchPrompt({
    company, role, num,
    cvSnippet, articleSnippet, reportSnippet, hmIntel, jdSnippet,
  });

  // 2026-05-23 B5 — popout grounding (locked decision #1: all 4 popouts grounded).
  //
  // We use buildGroundedPrompt purely for its analyst-to-Mitchell system prompt
  // + personality corpus (tone-safety rules, voice constraints, analyst lens).
  // We DO NOT use its profile corpus or user-prompt builder — buildResearchPrompt
  // already inlines cv.md + article-digest.md + JD + hm-intel as the dynamic
  // research surface, and replacing the multi-stage research+adjudicate flow
  // would balloon B5's blast radius.
  //
  // Result: each council model receives Mitchell's voice rules + personality
  // lens as cached stable context, while the existing per-call research prompt
  // unchanged. Backwards-compat: legacy mode flag returns the empty array, so
  // callCouncil falls back to no-cache no-system shape (matches v0 behavior).
  const grounded = buildGroundedPrompt({
    task: 'interview',
    rowId: num,
    role, company,
    metricKey: 'interview_likelihood',
    currentValue: null,
    // No responseSchema — buildResearchPrompt provides its own.
  });
  // Pass only the personality block as cacheStableContent (profile corpus is
  // already inlined into the dynamic prompt — would duplicate context).
  const personalityBlock = Array.isArray(grounded.cacheStableContent)
    ? grounded.cacheStableContent[0] || ''
    : '';

  // Full council fan-out per Decision-Maximization Policy (no subsets unless cost-capped).
  // DEFAULT_LINEUP in lib/council.mjs is Sonnet + GPT-5 + Gemini 2.5 Pro + Perplexity Sonar Pro.
  const t0 = Date.now();
  const council = await callCouncil({
    prompt,
    systemPrompt: grounded.system,
    opts: {
      timeoutMs: 180_000,   // 3 min per provider (rule: pass timeoutMs per hang-prevention)
      maxTokens: 3500,
      agentSlug: 'interview-likelihood',
      cacheStableContent: personalityBlock ? [personalityBlock] : '',
      cacheCaller: 'interview-likelihood',
    },
  });
  const councilMs = Date.now() - t0;
  const councilCost = (council.results || []).reduce((s, r) => s + (r.costUsd || 0), 0);
  try { recordTokens('anthropic', (council.results || []).reduce((s, r) => s + (r.tokens || 0), 0)); } catch {}

  const succeeded = (council.results || []).filter(r => !r.error && r.content);
  const parses = succeeded
    .map(r => ({ model: r.model, modelUsed: r.modelUsed, parsed: extractJson(r.content), tokens: r.tokens, costUsd: r.costUsd }))
    .filter(r => r.parsed && typeof r.parsed.likelihood_pct === 'number');

  emit({ slot: 'il', row: num, phase: 'council-done',
    succeeded: succeeded.length, parsed: parses.length,
    cost_usd: Number(councilCost.toFixed(4)), ms: councilMs,
    estimates: parses.map(p => ({ model: p.model, pct: p.parsed.likelihood_pct, conf: p.parsed.confidence })),
  });

  if (parses.length < 2) {
    return { error: 'council-too-thin', succeeded: succeeded.length, parsed: parses.length, council_cost_usd: councilCost };
  }

  return { parses, succeeded, council_cost_usd: councilCost, council_ms: councilMs };
}

async function runDealbreakerAdjudication(row, parses, opts = {}) {
  emit({ slot: 'il', row: row.num, phase: 'adjudicate-start', model_count: parses.length });
  const adjudicationPrompt = buildAdjudicationPrompt({
    company: row.company, role: row.role, num: row.num,
    councilResponses: parses,
  });

  // Opus inline dealbreaker pass. The dealbreaker agent (~/.claude/agents/dealbreaker.md)
  // uses opus model + claim-adjudication mode. Here we invoke Opus directly via the
  // Anthropic API to mirror the same skeptical-classification workflow without spawning
  // a separate Agent (Agent tool isn't available inside an .mjs script context).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = [
    `You are the dealbreaker — the final reviewer of cross-model research.`,
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    `You are deliberately skeptical. Default to cutting, not keeping.`,
    `The cost of a false claim in Mitchell's final dashboard widget is higher than the cost of cutting a real one.`,
    ``,
    `For interview-likelihood specifically:`,
    `- Classify each claim: verified (≥3 models) / corroborated (2 models) / unique-distinctive (1, architecturally plausible) / cut (unsupported).`,
    `- Median the model likelihood estimates, then adjust ±10 based on evidence strength.`,
    `- Keep only verified or corroborated strengths/gaps. Cut everything else.`,
    `- Output STRICT JSON. First char "{", last char "}". No markdown, no preamble, no code fences.`,
  ].join('\n');

  const t0 = Date.now();
  let j;
  try {
    j = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: adjudicationPrompt }],
      }),
    }, { bodyTimeoutMs: 120_000, errPrefix: 'anthropic-opus-dealbreaker' });
  } catch (err) {
    emit({ slot: 'il', row: row.num, phase: 'adjudicate-failed', error: String(err.message || err) });
    throw err;
  }
  const adjudicationMs = Date.now() - t0;

  const content = (j.content && j.content[0] && j.content[0].text) || '';
  const adjudicated = extractJson(content);
  if (!adjudicated || typeof adjudicated.likelihood_pct !== 'number') {
    return { error: 'adjudication-parse-failed', raw: content.slice(0, 500), adjudication_ms: adjudicationMs };
  }

  const usage = j.usage || {};
  // Opus 4.7 pricing approx: $15/$75 per 1M input/output (rough).
  const adjudicationCost = (usage.input_tokens || 0) * 15 / 1_000_000 + (usage.output_tokens || 0) * 75 / 1_000_000;

  emit({ slot: 'il', row: row.num, phase: 'adjudicate-done',
    pct: adjudicated.likelihood_pct, conf: adjudicated.confidence,
    cost_usd: Number(adjudicationCost.toFixed(4)), ms: adjudicationMs,
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  });

  return { adjudicated, adjudication_cost_usd: adjudicationCost, adjudication_ms: adjudicationMs };
}

async function runRow(row, opts = {}) {
  const slug = row.slug;
  emit({ slot: 'il', row: row.num, phase: 'row-start', slug });

  if (isCacheFresh(slug, opts.force)) {
    const cached = readJsonSafe(join(OUT_DIR, slug + '.json'));
    emit({ slot: 'il', row: row.num, phase: 'cache-hit', pct: cached?.likelihood_pct });
    return { row: row.num, slug, ok: true, cached: true, pct: cached?.likelihood_pct, cost_usd: 0 };
  }

  // ─── Phase 1: council research ───
  const research = await runCouncilResearch(row, opts);
  if (research.error) {
    return { row: row.num, slug, ok: false, error: research.error, cost_usd: research.council_cost_usd || 0 };
  }

  // ─── Phase 2: Opus adjudication (dealbreaker) ───
  const adj = await runDealbreakerAdjudication(row, research.parses, opts);
  if (adj.error) {
    return { row: row.num, slug, ok: false, error: adj.error,
      cost_usd: (research.council_cost_usd || 0) + (adj.adjudication_cost_usd || 0) };
  }

  // ─── Phase 3: write consolidated JSON ───
  const out = {
    ...adj.adjudicated,
    slug,
    num: String(row.num),
    company: row.company,
    role: row.role,
    models_used: research.parses.map(p => p.modelUsed || p.model),
    generated_at: new Date().toISOString(),
    method: 'council-adjudicated-v1',
    cost_usd: Number((research.council_cost_usd + adj.adjudication_cost_usd).toFixed(4)),
    cost_breakdown: {
      council_usd: Number(research.council_cost_usd.toFixed(4)),
      adjudication_usd: Number(adj.adjudication_cost_usd.toFixed(4)),
    },
    elapsed_ms: research.council_ms + adj.adjudication_ms,
    cache_ttl_days: CACHE_TTL_DAYS,
  };

  const outPath = join(OUT_DIR, slug + '.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

  // Mirror to apply-pack dir for offline review
  const packDir = findPackDir(slug);
  if (packDir) {
    try { writeFileSync(join(packDir, 'interview-likelihood.json'), JSON.stringify(out, null, 2)); } catch {}
  }

  emit({ slot: 'il', row: row.num, phase: 'row-done',
    pct: out.likelihood_pct, conf: out.confidence, cost_usd: out.cost_usd,
  });

  return { row: row.num, slug, ok: true, pct: out.likelihood_pct, conf: out.confidence, cost_usd: out.cost_usd };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

// Arg parser that supports BOTH `--key=value` and `--key value` forms.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[k] = next;
        i += 1;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const FORCE = ARGS.force === true || ARGS.force === 'true';
const DRY_RUN = ARGS['dry-run'] === true || ARGS['dry-run'] === 'true';
const MAX_COST_USD = Number(ARGS['max-cost-usd'] || '200');

let targets = [];
if (ARGS.all === true || ARGS.all === 'true') {
  targets = PASS_ROWS.slice();
} else if (ARGS.slug) {
  const match = PASS_ROWS.find(r => r.slug === ARGS.slug);
  if (match) targets.push(match);
  else targets.push({ num: '?', company: '', role: '', slug: String(ARGS.slug) });
} else if (ARGS.row) {
  const match = PASS_ROWS.find(r => String(r.num) === String(ARGS.row));
  if (match) targets.push(match);
  else {
    console.error(`Row #${ARGS.row} not in the 4 PASS-row list. Add it to PASS_ROWS or pass --slug.`);
    process.exit(2);
  }
} else {
  console.error('Usage:');
  console.error('  --all                run all 4 PASS rows');
  console.error('  --row N              run a single row by num');
  console.error('  --slug X             run a single row by slug');
  console.error('  --force              ignore 3d cache');
  console.error('  --dry-run            plan only, no API calls');
  console.error('  --max-cost-usd N     hard cap (default $200)');
  process.exit(2);
}

emit({ slot: 'il', phase: 'start', target_count: targets.length, dry_run: DRY_RUN, force: FORCE, max_cost_usd: MAX_COST_USD });

if (DRY_RUN) {
  console.log(`[interview-likelihood] DRY RUN — would process ${targets.length} rows:`);
  for (const t of targets) {
    const cached = isCacheFresh(t.slug, false);
    console.log(`  #${t.num} ${t.company} — ${t.role}  ${cached ? '(cache fresh, would skip unless --force)' : '(would refresh)'}`);
  }
  console.log(`[interview-likelihood] estimated cost: $${(targets.length * 14).toFixed(2)} (~$14/row at council + opus adjudication)`);
  process.exit(0);
}

let totalCost = 0;
const summary = [];
for (let i = 0; i < targets.length; i++) {
  if (totalCost >= MAX_COST_USD) {
    console.warn(`[interview-likelihood] cost cap $${MAX_COST_USD} reached — stopping at ${summary.length}/${targets.length}`);
    break;
  }
  const t = targets[i];
  try {
    const r = await runRow(t, { force: FORCE });
    totalCost += r.cost_usd || 0;
    summary.push(r);
  } catch (err) {
    emit({ slot: 'il', row: t.num, phase: 'row-threw', error: String(err.message || err) });
    summary.push({ row: t.num, slug: t.slug, ok: false, error: String(err.message || err), cost_usd: 0 });
  }
}

emit({ slot: 'il', phase: 'done', total_cost_usd: Number(totalCost.toFixed(4)), count: summary.length });
console.log(JSON.stringify({ ok: true, total_cost_usd: Number(totalCost.toFixed(4)), summary }, null, 2));
