#!/usr/bin/env node
/**
 * scripts/agents/hm-chance.mjs — Council-adjudicated "chance HM will see you"
 *
 * Phase 5.3 of master-resolution-prompt-2026-05-22.
 *
 * Sibling to scripts/agents/interview-likelihood.mjs. Same shape (council
 * fan-out → Opus inline dealbreaker → cached JSON), different question:
 *
 *   "What's the realistic chance the hiring manager actually SEES Mitchell's
 *    application, given HM identity, team makeup, recent projects, engagement
 *    signals (LinkedIn posts, blog cadence), and candidate-volume estimates?"
 *
 * LEADS WITH Mitchell's competitive edges (Q-8.53.32 of master prompt) — the
 * prompt instructs every model to put Mitchell's edges first and then assess
 * visibility from there.
 *
 * Output schema:
 *   {
 *     visibility_pct: 0-100,           // chance HM actually sees the app
 *     confidence: "high" | "medium" | "low",
 *     competitive_edges_first: [string],  // 3-5 Mitchell-edges leading the analysis
 *     visibility_factors: [{ factor, weight, evidence }],
 *     reason_bullets: [string],
 *     citations: [string],
 *     models_used: [string],
 *     dealbreaker_classification: { verified, corroborated, cut },
 *     generated_at: ISO,
 *     cost_usd: number,
 *   }
 *
 * Usage:
 *   node scripts/agents/hm-chance.mjs --row 48
 *   node scripts/agents/hm-chance.mjs --all
 *   node scripts/agents/hm-chance.mjs --all --force
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

import { callCouncil, COUNCIL_FANOUT_LINEUP } from '../../lib/council.mjs';
import { buildGroundedPrompt } from '../../lib/ground-prompt.mjs';
import { reserveQuota, recordTokens } from '../../lib/quota-tracker.mjs';

const OUT_DIR = join(ROOT, 'data', 'hm-chance');
mkdirSync(OUT_DIR, { recursive: true });

const CACHE_TTL_DAYS = 3;

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
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch {} }
  const fenced = t.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}

function summarizeHmIntel(hmIntelJson) {
  if (!hmIntelJson) return { summary: '(no HM intel)', primaryHm: null, recruiters: [], comp: null };
  const hms = hmIntelJson.hiring_managers || [];
  const primary = hms[0] || null;
  const out = [];
  out.push(`Role: ${hmIntelJson.role || 'unknown'}  ·  Company: ${hmIntelJson.company || 'unknown'}`);
  if (hmIntelJson.role_summary)        out.push(`Role summary: ${hmIntelJson.role_summary}`);
  if (hmIntelJson.alignment_with_goals) out.push(`Alignment: ${hmIntelJson.alignment_with_goals}`);
  out.push('');
  out.push(`Hiring managers (${hms.length}):`);
  hms.slice(0, 4).forEach((h, i) => {
    out.push(`  [${i + 1}] ${h.name || 'unknown'} — ${h.title || ''}`);
    if (h.confidence) out.push(`      confidence: ${h.confidence}`);
    if (h.why_owns_this_req) out.push(`      why_owns: ${String(h.why_owns_this_req).slice(0, 400)}`);
    if (Array.isArray(h.recent_activity) && h.recent_activity.length) {
      out.push(`      recent_activity: ${h.recent_activity.length} signal(s)`);
      h.recent_activity.slice(0, 2).forEach(a => {
        out.push(`        - [${a.platform} ${a.date}] ${String(a.summary || '').slice(0, 200)}`);
      });
    }
    if (h.outreach_hook) out.push(`      outreach_hook: ${String(h.outreach_hook).slice(0, 300)}`);
  });
  if (Array.isArray(hmIntelJson.recruiters) && hmIntelJson.recruiters.length) {
    out.push('');
    out.push(`Recruiters (${hmIntelJson.recruiters.length}):`);
    hmIntelJson.recruiters.slice(0, 3).forEach((r, i) => {
      out.push(`  [${i + 1}] ${r.name || 'unknown'} — ${r.title || ''}`);
    });
  }
  if (hmIntelJson.fit_evidence) {
    out.push('');
    out.push('Fit evidence:');
    if (typeof hmIntelJson.fit_evidence === 'object' && !Array.isArray(hmIntelJson.fit_evidence)) {
      for (const [k, v] of Object.entries(hmIntelJson.fit_evidence)) {
        out.push(`  ${k}: ${String(v).slice(0, 300)}`);
      }
    } else if (Array.isArray(hmIntelJson.fit_evidence)) {
      hmIntelJson.fit_evidence.slice(0, 4).forEach(f => out.push(`  - ${String(f).slice(0, 300)}`));
    }
  }
  return {
    summary: out.join('\n').slice(0, 5000),
    primaryHm: primary,
    recruiters: hmIntelJson.recruiters || [],
    comp: hmIntelJson.comp_intelligence || null,
  };
}

function buildResearchPrompt({ company, role, num, cvSnippet, articleSnippet, reportSnippet, hmIntelSummary, jdSnippet, packArtifacts, teamHealth }) {
  const lines = [
    `# Task — assess CHANCE HM WILL SEE Mitchell Williams's application`,
    ``,
    `Mitchell is applying to **${company} — ${role}** (apply-now row #${num}).`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Your job: estimate the realistic chance (0-100%) that the hiring manager actually SEES Mitchell's application — including whether his profile breaks through the recruiter filter, ATS keyword gate, and HM's daily intake.`,
    ``,
    `# 2026-05-25 popout-action-completed-mode — DATA-FIRST behavior`,
    ``,
    `Beyond the headline visibility_pct, you MUST also surface what's ALREADY on disk (evidence[]) and what's HONESTLY MISSING (open_gaps[]). The Mitchell-facing popout renders evidence + open_gaps as the primary content; "Run X agent" suggestions belong in open_gaps[].suggested_agent, NOT scattered across reason_bullets[].`,
    ``,
    `# LEAD WITH MITCHELL'S COMPETITIVE EDGES (rule from Q-8.53.32)`,
    ``,
    `Before assessing visibility factors, identify Mitchell's TOP COMPETITIVE EDGES for THIS specific role:`,
    `- What does Mitchell have that <5% of applicants will?`,
    `- Which edge would actually grab HM attention in a 6-second screen?`,
    `- Cite cv.md / article-digest.md / hm-intel evidence for each edge.`,
    ``,
    `THEN assess visibility, with explicit weight on:`,
    `- HM engagement signals (do they actively review apps? post about hiring? engage on LinkedIn?)`,
    `- Recruiter funnel shape (does this company route via recruiter screen or direct-to-HM?)`,
    `- Candidate volume estimates (popular role at a popular company = lower visibility unless edges are exceptional)`,
    `- Network proximity (1st/2nd-degree connections, mutual contacts, warm intro paths)`,
    `- Application timing (recent posting → higher HM attention; aged → lower)`,
    `- Differentiation: would Mitchell's resume STAND OUT given HM's specific interests/recent projects?`,
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
    `# Job description (top 4000 chars)`,
    jdSnippet || '(no JD text)',
    ``,
    `# HM intel summary`,
    hmIntelSummary || '(no HM intel — visibility estimate must penalize for low-confidence HM identification)',
    ``,
    `# Apply-pack artifacts on disk (read at popout-request time)`,
    packArtifacts || '(no apply-pack files yet — gap: build-apply-pack would create cv-tailored.md + cover-letter.md + polish-summary.json)',
    ``,
    `# Team health intel (data/team-health/<company-slug>.json)`,
    teamHealth || '(no team-health snapshot — gap: team-health-scrapers would Glassdoor/Indeed/Blind/Levels.fyi)',
    ``,
    `# Output — STRICT JSON, first char "{", last char "}". No markdown, no preamble, no code fences.`,
    ``,
    `{`,
    `  "visibility_pct": <integer 0-100>,`,
    `  "confidence": "high" | "medium" | "low",`,
    `  "competitive_edges_first": [`,
    `    "<edge 1 — what Mitchell has that most candidates don't, with [cv.md:N] / [article-digest.md:N] / [hm-intel] citation>",`,
    `    ...   // 3-5 items, LEADING the analysis`,
    `  ],`,
    `  "visibility_factors": [`,
    `    { "factor": "<short>", "weight": "high"|"medium"|"low", "evidence": "<citation or rationale>" },`,
    `    ...   // 4-6 items`,
    `  ],`,
    `  "reason_bullets": [`,
    `    "<plain-language reason for the percentage with citations>",`,
    `    ...   // 3-5 items`,
    `  ],`,
    `  "best_path_to_hm": "<one sentence — referral, LinkedIn DM, cold email, recent-post comment, etc>",`,
    `  "candidate_volume_estimate": "<low | medium | high | very-high — with one-sentence rationale>",`,
    `  "rationale": "<2-3 sentences justifying the percentage>",`,
    ``,
    `  // 2026-05-25 popout-action-completed-mode — NEW FIELDS:`,
    `  "evidence": [`,
    `    {`,
    `      "what_data": "<short — name of the data point on disk>",`,
    `      "what_it_reveals": "<1-2 sentence synthesis of what THIS DATA reveals about HM visibility>",`,
    `      "source_path": "<concrete: cv.md / article-digest.md / data/hm-intel/<slug>.json / reports/NNN-...md / data/team-health/<slug>.json / data/apply-packs/<slug>/cv-tailored.md / data/apply-packs/<slug>/cover-letter.md>",`,
    `      "source_date": "<YYYY-MM-DD when known>",`,
    `      "confidence": "high" | "medium" | "low"`,
    `    }`,
    `    // 0-5 items. Cite what's ACTUALLY in the context provided. Do NOT cite a file marked "(empty)" or "(no X)".`,
    `  ],`,
    `  "open_gaps": [`,
    `    {`,
    `      "what_is_missing": "<short — what data / artifact / research is absent>",`,
    `      "why_it_matters": "<1 sentence — why this gap reduces confidence in visibility_pct>",`,
    `      "suggested_agent": "<specific real agent: 'intel-refresh' | 'network-enricher' | 'network-emailer' | 'team-health-scrapers' | 'build-apply-pack' | 'hm-chance'>",`,
    `      "est_cost_usd": <number — your honest cost estimate>`,
    `    }`,
    `    // 0-5 items. If everything needed is already on disk, emit zero gaps.`,
    `  ]`,
    `}`,
    ``,
    `Anti-hallucination rules:`,
    `- DO NOT invent metrics, employers, or experiences not visible in the corpus.`,
    `- Cite line numbers OR file names. "[hm-intel]" is acceptable for HM-derived claims.`,
    `- For evidence[], cite paths from the context above. Do NOT cite a file marked "(empty)" or "(no X)".`,
    `- For open_gaps[], suggested_agent must be a real script name from the list above. est_cost_usd is your honest estimate.`,
    `- If HM intel is empty or low-confidence, set confidence="low" and penalize visibility_pct by 15-25%.`,
    `- Calibration: 0-20% = HM probably never sees it, 21-40% = recruiter filter risk, 41-60% = depends on resume quality, 61-80% = strong signal, 81-100% = warm intro or named in HM-intel.`,
  ];
  return lines.join('\n');
}

function buildAdjudicationPrompt({ company, role, num, councilResponses }) {
  const lines = [
    `# Dealbreaker adjudication — HM CHANCE synthesis`,
    ``,
    `4 council models have independently assessed the chance the hiring manager actually SEES Mitchell Williams's application for **${company} — ${role}** (row #${num}).`,
    `Your job: act as the dealbreaker. Classify each claim verified (≥3 models) / corroborated (2) / unique-distinctive (1) / cut.`,
    `Then emit ONE consolidated JSON that the dashboard will serve to Mitchell.`,
    ``,
    `LEAD WITH Mitchell's competitive edges (Q-8.53.32) — surface the strongest edges first.`,
    `Default to skepticism. Cut anything not corroborated.`,
    `For visibility_pct: take the median of model estimates, then adjust ±10 based on the strength of corroborated evidence.`,
    ``,
  ];
  for (let i = 0; i < councilResponses.length; i++) {
    const r = councilResponses[i];
    lines.push(`## Model ${i + 1}: ${r.model}` + (r.modelUsed ? ` (used ${r.modelUsed})` : ''));
    lines.push('```json');
    lines.push(JSON.stringify(r.parsed, null, 2).slice(0, 4500));
    lines.push('```');
    lines.push('');
  }
  lines.push(``);
  lines.push(`# Output — STRICT JSON. First char "{", last char "}". No markdown, no preamble, no code fences.`);
  lines.push(``);
  lines.push(`{`);
  lines.push(`  "visibility_pct": <integer 0-100, your final adjudicated estimate>,`);
  lines.push(`  "confidence": "high" | "medium" | "low",`);
  lines.push(`  "competitive_edges_first": ["<3-5 edges LEADING the analysis, only verified or corroborated>"],`);
  lines.push(`  "visibility_factors": [{ "factor": "...", "weight": "high"|"medium"|"low", "evidence": "..." }],`);
  lines.push(`  "reason_bullets":     ["<3-5 plain-language reasons with citations>"],`);
  lines.push(`  "best_path_to_hm":         "<one sentence>",`);
  lines.push(`  "candidate_volume_estimate":"<low | medium | high | very-high — with rationale>",`);
  lines.push(`  "citations":               ["<list of cv.md / article-digest.md / hm-intel refs cited>"],`);
  lines.push(`  "rationale":               "<2-3 sentences>",`);
  lines.push(`  "dealbreaker_classification": {`);
  lines.push(`    "verified":     ["<claim text>"],`);
  lines.push(`    "corroborated": ["<claim text>"],`);
  lines.push(`    "cut":          ["<claim text> — reason cut"]`);
  lines.push(`  },`);
  lines.push(`  "model_estimates": [{ "model": "...", "pct": <int>, "confidence": "..." }],`);
  lines.push(``);
  lines.push(`  // 2026-05-25 popout-action-completed-mode — adjudicated data-first fields.`);
  lines.push(`  // evidence[] = union of all models' evidence[] arrays; keep ONLY items where ≥2 models cited the same`);
  lines.push(`  // source_path OR 1 model cited it with confidence='high'. open_gaps[] = union of model gaps with`);
  lines.push(`  // dedup by suggested_agent + what_is_missing keyword overlap.`);
  lines.push(`  "evidence": [`);
  lines.push(`    {`);
  lines.push(`      "what_data": "<short>",`);
  lines.push(`      "what_it_reveals": "<1-2 sentences>",`);
  lines.push(`      "source_path": "<concrete path>",`);
  lines.push(`      "source_date": "<YYYY-MM-DD or omit>",`);
  lines.push(`      "confidence": "high" | "medium" | "low"`);
  lines.push(`    }`);
  lines.push(`  ],`);
  lines.push(`  "open_gaps": [`);
  lines.push(`    {`);
  lines.push(`      "what_is_missing": "<short>",`);
  lines.push(`      "why_it_matters": "<1 sentence>",`);
  lines.push(`      "suggested_agent": "<real agent name>",`);
  lines.push(`      "est_cost_usd": <number>`);
  lines.push(`    }`);
  lines.push(`  ]`);
  lines.push(`}`);
  return lines.join('\n');
}

async function runCouncilResearch(row, opts = {}) {
  const slug = row.slug;
  const num = row.num;
  emit({ slot: 'hm-chance', row: num, phase: 'load-corpus' });

  const cvSnippet = readSafe(join(ROOT, 'cv.md'), 6000);
  const articleSnippet = readSafe(join(ROOT, 'article-digest.md'), 4000);
  const reportPath = findLatestReport(num);
  const reportSnippet = reportPath ? readSafe(reportPath, 4000) : '';
  const roleSlug = findRoleSlug(slug);
  const hmIntelJson = readJsonSafe(join(ROOT, 'data', 'hm-intel', roleSlug + '.json'));
  const hmIntelSummary = summarizeHmIntel(hmIntelJson).summary;
  const packDir = findPackDir(slug);
  let jdSnippet = '';
  if (packDir) {
    for (const cand of ['jd.txt', 'jd.md', 'JD.md', 'job-description.md']) {
      const p = join(packDir, cand);
      if (existsSync(p)) { jdSnippet = readSafe(p, 4000); break; }
    }
  }

  // 2026-05-25 popout-action-completed-mode — read apply-pack artifacts +
  // team-health so the LLM can SYNTHESIZE what's already on disk. Same
  // pattern as interview-likelihood.mjs.
  let packArtifacts = '';
  if (packDir) {
    const parts = [];
    for (const cand of [
      { name: 'cv-tailored.md',                limit: 2500, path: join(packDir, 'cv-tailored.md') },
      { name: 'cover-letter.md',               limit: 2500, path: join(packDir, 'cover-letter.md') },
      { name: 'polish-orchestrator-summary.json', limit: 2500, path: join(packDir, 'polish-orchestrator-summary.json') },
    ]) {
      if (existsSync(cand.path)) {
        const content = readSafe(cand.path, cand.limit);
        parts.push(`## ${cand.name} (top ${cand.limit} chars)\n${content}`);
      }
    }
    packArtifacts = parts.length > 0 ? parts.join('\n\n') : '';
  }

  let teamHealth = '';
  try {
    const companySlug = String(row.company || '').toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
      .replace(/--+/g, '-').replace(/^-+|-+$/g, '');
    const thPath = join(ROOT, 'data', 'team-health', companySlug + '.json');
    if (existsSync(thPath)) {
      const thJson = readJsonSafe(thPath);
      if (thJson) teamHealth = JSON.stringify(thJson, null, 2).slice(0, 3000);
    }
  } catch { /* soft-fail */ }

  emit({ slot: 'hm-chance', row: num, phase: 'council-research',
    inputs: { cv: cvSnippet.length, article: articleSnippet.length, report: reportSnippet.length, hm: hmIntelSummary.length, jd: jdSnippet.length, pack: packArtifacts.length, teamHealth: teamHealth.length },
  });

  const prompt = buildResearchPrompt({
    company: row.company, role: row.role, num,
    cvSnippet, articleSnippet, reportSnippet, hmIntelSummary, jdSnippet,
    packArtifacts, teamHealth,
  });

  // 2026-05-23 B5 — popout grounding (locked decision #1: all 4 popouts grounded).
  // See scripts/agents/interview-likelihood.mjs for full rationale. We inject
  // the analyst-to-Mitchell system prompt + personality corpus only; the
  // dynamic prompt is unchanged because buildResearchPrompt already inlines
  // cv.md + article-digest.md + JD + hm-intel.
  const grounded = buildGroundedPrompt({
    task: 'hm_chance',
    rowId: num,
    role: row.role, company: row.company,
    metricKey: 'hm_chance',
    currentValue: null,
  });
  const personalityBlock = Array.isArray(grounded.cacheStableContent)
    ? grounded.cacheStableContent[0] || ''
    : '';

  const t0 = Date.now();
  const council = await callCouncil({
    prompt,
    systemPrompt: grounded.system,
    // 2026-05-26 fix: post-2026-05-25 DEFAULT_LINEUP was downgraded to single-vendor
    // (anthropic:claude-sonnet-4-6), so leaving models unspecified produced ONE
    // response — but line 458's `parses.length < 2` threshold meant every call
    // returned `council-too-thin` for 0 file writes (~$1/row burned for nothing).
    // Explicit COUNCIL_FANOUT_LINEUP restores the pre-2026-05-25 4-vendor
    // adversarial fan-out that the script's adjudication step requires.
    models: COUNCIL_FANOUT_LINEUP,
    opts: {
      timeoutMs: 180_000,
      maxTokens: 3500,
      agentSlug: 'hm-chance',
      cacheStableContent: personalityBlock ? [personalityBlock] : '',
      cacheCaller: 'hm-chance',
    },
  });
  const councilMs = Date.now() - t0;
  const councilCost = (council.results || []).reduce((s, r) => s + (r.costUsd || 0), 0);
  try { recordTokens('anthropic', (council.results || []).reduce((s, r) => s + (r.tokens || 0), 0)); } catch {}

  const succeeded = (council.results || []).filter(r => !r.error && r.content);
  const parses = succeeded
    .map(r => ({ model: r.model, modelUsed: r.modelUsed, parsed: extractJson(r.content), tokens: r.tokens, costUsd: r.costUsd }))
    .filter(r => r.parsed && typeof r.parsed.visibility_pct === 'number');

  emit({ slot: 'hm-chance', row: num, phase: 'council-done',
    succeeded: succeeded.length, parsed: parses.length,
    cost_usd: Number(councilCost.toFixed(4)), ms: councilMs,
    estimates: parses.map(p => ({ model: p.model, pct: p.parsed.visibility_pct, conf: p.parsed.confidence })),
  });

  if (parses.length < 2) {
    return { error: 'council-too-thin', succeeded: succeeded.length, parsed: parses.length, council_cost_usd: councilCost };
  }
  return { parses, council_cost_usd: councilCost, council_ms: councilMs };
}

async function runDealbreakerAdjudication(row, parses, opts = {}) {
  emit({ slot: 'hm-chance', row: row.num, phase: 'adjudicate-start', model_count: parses.length });
  const adjudicationPrompt = buildAdjudicationPrompt({
    company: row.company, role: row.role, num: row.num,
    councilResponses: parses,
  });

  const systemPrompt = [
    `You are the dealbreaker — the final reviewer of cross-model research.`,
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    `You are deliberately skeptical. Default to cutting, not keeping.`,
    ``,
    `For HM-chance specifically:`,
    `- LEAD WITH Mitchell's competitive edges (Q-8.53.32) — surface the strongest first.`,
    `- Classify each claim: verified (≥3 models) / corroborated (2) / unique-distinctive (1) / cut.`,
    `- Median the model visibility estimates, then adjust ±10 based on evidence strength.`,
    `- Output STRICT JSON. First char "{", last char "}". No markdown, no preamble, no code fences.`,
  ].join('\n');

  // cost-distribution Part 2 (2026-05-25): adjudication downgraded from Opus 4.7
  // to Sonnet 4.6 via callCouncil. Routing: structured_extraction taskType
  // resolves to Sonnet 4.6 by default. Skeptical-adjudicator framing preserved
  // via systemPrompt.
  const t0 = Date.now();
  let adjudicated = null;
  let adjudicationCost = 0;
  let usage = {};
  try {
    const adj = await callCouncil({
      prompt: adjudicationPrompt,
      opts: {
        taskType: 'structured_extraction',
        systemPrompt,
        maxTokens: 4000,
        timeoutMs: 180_000,
        agentSlug: 'hm-chance:dealbreaker',
      },
    });
    const result = adj.results?.[0];
    if (!result || result.error) {
      const errMsg = result?.error || 'callCouncil returned no result';
      emit({ slot: 'hm-chance', row: row.num, phase: 'adjudicate-failed', error: errMsg });
      throw new Error(errMsg);
    }
    const content = result.content || '';
    adjudicated = extractJson(content);
    if (!adjudicated || typeof adjudicated.visibility_pct !== 'number') {
      const adjudicationMs = Date.now() - t0;
      return { error: 'adjudication-parse-failed', raw: content.slice(0, 500), adjudication_ms: adjudicationMs };
    }
    adjudicationCost = adj.report?.totalCost || result.costUsd || 0;
    usage = { input_tokens: 0, output_tokens: 0, total_tokens: result.tokens || 0 };
  } catch (err) {
    emit({ slot: 'hm-chance', row: row.num, phase: 'adjudicate-failed', error: String(err.message || err) });
    throw err;
  }
  const adjudicationMs = Date.now() - t0;

  emit({ slot: 'hm-chance', row: row.num, phase: 'adjudicate-done',
    pct: adjudicated.visibility_pct, conf: adjudicated.confidence,
    cost_usd: Number(adjudicationCost.toFixed(4)), ms: adjudicationMs,
    tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  });
  return { adjudicated, adjudication_cost_usd: adjudicationCost, adjudication_ms: adjudicationMs };
}

async function runRow(row, opts = {}) {
  const slug = row.slug;
  emit({ slot: 'hm-chance', row: row.num, phase: 'row-start', slug });

  if (isCacheFresh(slug, opts.force)) {
    const cached = readJsonSafe(join(OUT_DIR, slug + '.json'));
    emit({ slot: 'hm-chance', row: row.num, phase: 'cache-hit', pct: cached?.visibility_pct });
    return { row: row.num, slug, ok: true, cached: true, pct: cached?.visibility_pct, cost_usd: 0 };
  }

  const research = await runCouncilResearch(row, opts);
  if (research.error) {
    return { row: row.num, slug, ok: false, error: research.error, cost_usd: research.council_cost_usd || 0 };
  }

  const adj = await runDealbreakerAdjudication(row, research.parses, opts);
  if (adj.error) {
    return { row: row.num, slug, ok: false, error: adj.error,
      cost_usd: (research.council_cost_usd || 0) + (adj.adjudication_cost_usd || 0) };
  }

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

  const packDir = findPackDir(slug);
  if (packDir) {
    try { writeFileSync(join(packDir, 'hm-chance.json'), JSON.stringify(out, null, 2)); } catch {}
  }

  emit({ slot: 'hm-chance', row: row.num, phase: 'row-done',
    pct: out.visibility_pct, conf: out.confidence, cost_usd: out.cost_usd,
  });

  return { row: row.num, slug, ok: true, pct: out.visibility_pct, conf: out.confidence, cost_usd: out.cost_usd };
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
  else {
    // 2026-05-25: fall back to apply-now-queue / applications.md lookup so
    // the deep-refresh button can populate chips for any row, not just PASS_ROWS.
    const { resolveRow } = await import('../lib/row-resolver.mjs');
    const resolved = resolveRow(String(ARGS.slug));
    if (resolved) targets.push(resolved);
    else targets.push({ num: '?', company: '', role: '', slug: String(ARGS.slug) });
  }
} else if (ARGS.row) {
  const match = PASS_ROWS.find(r => String(r.num) === String(ARGS.row));
  if (match) targets.push(match);
  else {
    // 2026-05-25: fall back to apply-now-queue / applications.md lookup so
    // the deep-refresh button can populate chips for any row, not just PASS_ROWS.
    const { resolveRow } = await import('../lib/row-resolver.mjs');
    const resolved = resolveRow(String(ARGS.row));
    if (resolved) targets.push(resolved);
    else {
      console.error(`Row #${ARGS.row} not found in PASS_ROWS, apply-now-queue.json, or applications.md.`);
      process.exit(2);
    }
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

emit({ slot: 'hm-chance', phase: 'start', target_count: targets.length, dry_run: DRY_RUN, force: FORCE, max_cost_usd: MAX_COST_USD });

if (DRY_RUN) {
  console.log(`[hm-chance] DRY RUN — would process ${targets.length} rows:`);
  for (const t of targets) {
    const cached = isCacheFresh(t.slug, false);
    console.log(`  #${t.num} ${t.company} — ${t.role}  ${cached ? '(cache fresh)' : '(would refresh)'}`);
  }
  console.log(`[hm-chance] estimated cost: $${(targets.length * 20).toFixed(2)} (~$20/row at council + opus adjudication)`);
  process.exit(0);
}

let totalCost = 0;
const summary = [];
for (let i = 0; i < targets.length; i++) {
  if (totalCost >= MAX_COST_USD) {
    console.warn(`[hm-chance] cost cap $${MAX_COST_USD} reached — stopping at ${summary.length}/${targets.length}`);
    break;
  }
  const t = targets[i];
  try {
    const r = await runRow(t, { force: FORCE });
    totalCost += r.cost_usd || 0;
    summary.push(r);
  } catch (err) {
    emit({ slot: 'hm-chance', row: t.num, phase: 'row-threw', error: String(err.message || err) });
    summary.push({ row: t.num, slug: t.slug, ok: false, error: String(err.message || err), cost_usd: 0 });
  }
}

emit({ slot: 'hm-chance', phase: 'done', total_cost_usd: Number(totalCost.toFixed(4)), count: summary.length });
console.log(JSON.stringify({ ok: true, total_cost_usd: Number(totalCost.toFixed(4)), summary }, null, 2));
