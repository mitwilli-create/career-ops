#!/usr/bin/env node
/**
 * scripts/populate-team-health.mjs — Team-health populator
 *
 * Phase 1.5 of master-resolution-prompt-2026-05-22.
 *
 * Reads existing data/company-toxicity-cache/<slug>.json signals when
 * present (they already contain Blind/Glassdoor/Reddit/Levels.fyi quotes
 * with verdicts). Wraps them in a Sonnet narrative pass to produce
 * data/team-health/<slug>.json with the schema specified in the master
 * resolution prompt § Phase 1.5 Step 2 team-health entry.
 *
 * Schema:
 *   {
 *     "company": "...",
 *     "synthesized_at": "ISO timestamp",
 *     "providers_called": [...],
 *     "scores": {"overall": N, "leadership": N, "comp": N, "growth": N, "balance": N},
 *     "narrative": "...",
 *     "anecdotes": [{"source": "...", "quote": "...", "url": "...", "date": "..."}],
 *     "_meta": {"owner": "phase-1.5-auto-enrich", "row_nums": [...], "cost_usd": N, "method": "toxicity-derived" | "fresh-research"}
 *   }
 *
 * Tier 1 (toxicity-derived): companies with existing toxicity-cache → cheap.
 * Tier 2 (fresh-research): companies without toxicity-cache → spend a real
 *   council pass via Sonnet + Perplexity Sonar Deep Research.
 *
 * Usage:
 *   node scripts/populate-team-health.mjs --companies "Anthropic,OpenAI,Mistral AI"
 *   node scripts/populate-team-health.mjs --from-audit data/queue-gate-audit-2026-05-22-pre-enrich.json
 *   node scripts/populate-team-health.mjs --all-missing            # auto-discover from audit
 *   node scripts/populate-team-health.mjs --dry-run                # plan only
 *
 * Env:
 *   CAREER_OPS_ROOT      override repo root (default: __dirname/..)
 *   TEAM_HEALTH_BUDGET   total $ cap across the run (default $50)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

// Load .env BEFORE importing council.mjs (env-shadow-on-lazy-dotenv pattern).
try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v = true] = a.slice(2).split('='); return [k, v]; })
);

const DRY_RUN = ARGS['dry-run'] === true || ARGS['dry-run'] === 'true';
const BUDGET_CAP_USD = Number(process.env.TEAM_HEALTH_BUDGET || '50');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function emit(obj) {
  try {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* */ }
}

function readJsonSafe(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null; } catch { return null; }
}

/**
 * Tier 1 — derive team-health JSON from existing toxicity-cache signals.
 * No LLM call; pure transformation. Cost: $0.
 */
function deriveFromToxicity(company, toxic, rowNums) {
  const signals = toxic.signals || [];
  const compositeScore = toxic.composite_score;
  const compositeBand = toxic.composite_band;

  // Score derivation (heuristic — confirmed against existing toxicity-cache
  // banding):
  // healthy   = 75-90, mixed = 50-70, caution = 30-49, avoid = 10-30
  let overallScore = 60; // default neutral
  if (typeof compositeScore === 'number' && compositeScore > 0) {
    overallScore = Math.round(compositeScore * 100);
  } else if (compositeBand === 'healthy') overallScore = 78;
  else if (compositeBand === 'mixed')   overallScore = 60;
  else if (compositeBand === 'caution') overallScore = 40;
  else if (compositeBand === 'avoid')   overallScore = 22;

  // Topic-driven sub-scores derived from signal verdicts per topic
  const topicGroups = { leadership: [], comp: [], growth: [], balance: [] };
  const topicKeywords = {
    leadership: /(management|leader|exec|founder|culture|reorg|mission)/i,
    comp:       /(comp|salary|bonus|equity|stock|pay|raise|relo)/i,
    growth:     /(growth|career|promo|opportunity|ramp|impact|tech)/i,
    balance:    /(wlb|balance|hours|sustain|burn|sabbatical|life)/i,
  };
  for (const sig of signals) {
    const verdictScore =
      sig.verdict === 'good' ? 80 :
      sig.verdict === 'neutral' ? 60 :
      sig.verdict === 'concerning' ? 35 :
      sig.verdict === 'blocker' ? 15 :
      60;
    const combo = `${sig.topic || ''} ${sig.excerpt || ''}`;
    for (const [topic, re] of Object.entries(topicKeywords)) {
      if (re.test(combo)) topicGroups[topic].push(verdictScore);
    }
  }
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : overallScore;

  const scores = {
    overall: overallScore,
    leadership: avg(topicGroups.leadership),
    comp: avg(topicGroups.comp),
    growth: avg(topicGroups.growth),
    balance: avg(topicGroups.balance),
  };

  // Narrative — assemble from drivers + composite band
  const drivers = toxic.drivers || [];
  const driversNarrative = drivers.length
    ? `Primary signals: ${drivers.join(', ')}.`
    : 'Limited public signal coverage at synthesis time.';
  const bandPhrase =
    compositeBand === 'healthy' ? 'The aggregate signal trends healthy' :
    compositeBand === 'mixed' ? 'The aggregate signal is mixed' :
    compositeBand === 'caution' ? 'The aggregate signal warrants caution' :
    compositeBand === 'avoid' ? 'The aggregate signal trends negative' :
    'The aggregate signal is too sparse to band definitively';
  const narrative = `${bandPhrase} for ${company} (composite ${compositeBand || 'unbanded'}, ${signals.length} surfaced signal${signals.length === 1 ? '' : 's'}). ${driversNarrative} Sources include ${[...new Set(signals.map(s => s.source).filter(Boolean))].join(', ') || 'Blind / Glassdoor / Reddit / Levels.fyi'}.`;

  // Anecdotes — top 5 signals by salience (good or concerning, with URLs)
  const anecdotes = signals
    .filter(s => s.excerpt && s.url)
    .sort((a, b) => {
      // Prefer signals with verdicts on the extremes (good or blocker)
      const score = (v) =>
        v.verdict === 'blocker' ? 4 :
        v.verdict === 'good' ? 3 :
        v.verdict === 'concerning' ? 2 :
        1;
      return score(b) - score(a);
    })
    .slice(0, 6)
    .map(s => ({
      source: s.source,
      quote: s.excerpt,
      url: s.url,
      date: toxic.as_of?.slice(0, 10) || null,
      topic: s.topic || null,
      verdict: s.verdict || null,
    }));

  return {
    company,
    synthesized_at: new Date().toISOString(),
    providers_called: toxic.meta?.models_responded || ['toxicity-cache-derived'],
    scores,
    narrative,
    anecdotes,
    _meta: {
      owner: 'phase-1.5-auto-enrich',
      method: 'toxicity-derived',
      source_cache: `data/company-toxicity-cache/${slugify(company)}.json`,
      source_as_of: toxic.as_of,
      row_nums: rowNums,
      cost_usd: 0,
    },
  };
}

/**
 * Tier 2 — fresh research via callCouncil (Sonnet + Perplexity Sonar Deep Research).
 * Each company costs ~$3-5. Used when no toxicity-cache exists.
 */
async function researchFresh(company, rowNums) {
  const { callCouncil } = await import('../lib/council.mjs');

  const prompt = [
    `# Task — team-health snapshot for ${company}`,
    `Goal: Produce a calibrated team-health assessment for Mitchell Williams' apply-now queue.`,
    ``,
    `Sources to pull from (cite each with URL + date):`,
    `- Glassdoor company page (reviews + ratings — last 90 days preferred)`,
    `- Blind reviews (https://www.teamblind.com/company/${company.replace(/\s+/g, '')}/reviews)`,
    `- levels.fyi (compensation + ratings)`,
    `- Reddit r/cscareerquestions + r/ExperiencedDevs threads (last 90 days)`,
    `- Recent LinkedIn employee posts (last 60 days)`,
    `- X/Twitter mentions of the company (last 60 days)`,
    ``,
    `Return STRICT JSON only. No markdown, no preamble. Start with { end with }.`,
    ``,
    `{`,
    `  "company": "${company}",`,
    `  "scores": {`,
    `    "overall":    integer 0-100,`,
    `    "leadership": integer 0-100,`,
    `    "comp":       integer 0-100,`,
    `    "growth":     integer 0-100,`,
    `    "balance":    integer 0-100`,
    `  },`,
    `  "narrative": "3-4 sentence calibrated assessment grounded in surfaced signals — what's actually happening at the company per most recent employee/ex-employee voice. Cite Glassdoor and Blind specifically where applicable.",`,
    `  "anecdotes": [`,
    `    {`,
    `      "source":  "glassdoor|blind|reddit|levels|linkedin|x",`,
    `      "quote":   "the literal employee/ex-employee quote, ≤200 chars",`,
    `      "url":     "the URL where you found it",`,
    `      "date":    "ISO date if available, else null",`,
    `      "topic":   "leadership|comp|growth|balance|culture|other",`,
    `      "verdict": "good|neutral|concerning|blocker"`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `CRITICAL rules:`,
    `- Only include anecdotes where you have a real URL. NEVER fabricate quotes or URLs.`,
    `- Surface 5-8 anecdotes. Mix of good + concerning if possible.`,
    `- If signal coverage is sparse, say so in narrative and reduce anecdote count.`,
    `- Scores must be calibrated to actual sentiment, not rated on a curve.`,
  ].join('\n');

  let council;
  try {
    council = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6', 'perplexity:sonar-deep-research'],
      opts: { timeoutMs: 180_000, maxTokens: 3000 },
    });
  } catch (e) {
    emit({ slot: 'team-health', company, error: String(e.message || e) });
    return null;
  }

  const cost = council.report?.totalCost || 0;
  const succeeded = (council.results || []).filter(r => !r.error && r.content);
  if (!succeeded.length) {
    emit({ slot: 'team-health', company, step: 'all-models-failed' });
    return null;
  }

  // Take the parse with the most anecdotes (richest)
  const parses = succeeded.map(r => {
    const c = String(r.content || '').trim();
    if (c.startsWith('{')) { try { return JSON.parse(c); } catch (_) {} }
    const fenced = c.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
    const s = c.indexOf('{'); const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch (_) {} }
    return null;
  }).filter(Boolean);

  if (!parses.length) {
    emit({ slot: 'team-health', company, step: 'no-parseable-json' });
    return null;
  }

  const best = parses.sort((a, b) =>
    (b.anecdotes?.length || 0) - (a.anecdotes?.length || 0)
  )[0];

  return {
    company,
    synthesized_at: new Date().toISOString(),
    providers_called: succeeded.map(r => r.model),
    scores: best.scores || { overall: 60, leadership: 60, comp: 60, growth: 60, balance: 60 },
    narrative: best.narrative || `(narrative synthesis returned no content for ${company})`,
    anecdotes: Array.isArray(best.anecdotes) ? best.anecdotes : [],
    _meta: {
      owner: 'phase-1.5-auto-enrich',
      method: 'fresh-research',
      row_nums: rowNums,
      cost_usd: cost,
    },
  };
}

async function processCompany(company, rowNums, opts = {}) {
  const outPath = join(ROOT, 'data', 'team-health', `${slugify(company)}.json`);
  mkdirSync(dirname(outPath), { recursive: true });

  if (!opts.force && existsSync(outPath)) {
    emit({ slot: 'team-health', company, cache: 'hit', path: outPath });
    return { ok: true, cache: 'hit', path: outPath, cost: 0 };
  }

  // Try Tier 1 first
  const toxicPath = join(ROOT, 'data', 'company-toxicity-cache', `${slugify(company)}.json`);
  const toxic = readJsonSafe(toxicPath);

  let payload;
  let cost = 0;
  if (toxic && toxic.signals && toxic.signals.length > 0) {
    emit({ slot: 'team-health', company, step: 'tier1-derive', signals: toxic.signals.length });
    payload = deriveFromToxicity(company, toxic, rowNums);
  } else {
    if (opts.dryRun) {
      emit({ slot: 'team-health', company, step: 'tier2-research', dryRun: true });
      return { ok: true, cache: 'plan-only', cost: 5, plan: 'tier2-research' };
    }
    emit({ slot: 'team-health', company, step: 'tier2-research', estimatedCost: '$3-5' });
    payload = await researchFresh(company, rowNums);
    if (!payload) return { ok: false, error: 'tier2-research-failed' };
    cost = payload._meta?.cost_usd || 0;
  }

  if (opts.dryRun) {
    emit({ slot: 'team-health', company, step: 'tier1-derive', dryRun: true });
    return { ok: true, cache: 'plan-only', cost: 0 };
  }

  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  emit({ slot: 'team-health', company, step: 'written', path: outPath, cost_usd: cost });
  return { ok: true, cache: 'miss', path: outPath, cost };
}

// ──────── CLI ────────

function loadCompaniesFromAudit(auditPath) {
  const audit = readJsonSafe(auditPath);
  if (!audit) {
    throw new Error(`audit file not found: ${auditPath}`);
  }
  const rows = [...(audit.auto_enrich || []), ...(audit.pass || [])];
  // Group rows by company; collect row_nums per company
  const byCompany = new Map();
  for (const r of rows) {
    if (!r.company || r.company === 'Unknown') continue;
    if (!byCompany.has(r.company)) byCompany.set(r.company, []);
    byCompany.get(r.company).push(r.num);
  }
  return [...byCompany.entries()].map(([company, rowNums]) => ({ company, rowNums }));
}

async function main() {
  let targets = [];
  if (ARGS['from-audit']) {
    targets = loadCompaniesFromAudit(join(ROOT, ARGS['from-audit']));
  } else if (ARGS['all-missing']) {
    // Auto-pick the most recent audit
    const auditPath = join(ROOT, `data/queue-gate-audit-${new Date().toISOString().slice(0, 10)}-pre-enrich.json`);
    targets = loadCompaniesFromAudit(auditPath);
  } else if (ARGS['companies']) {
    const list = String(ARGS['companies']).split(',').map(s => s.trim()).filter(Boolean);
    targets = list.map(c => ({ company: c, rowNums: [] }));
  } else {
    console.error('Usage:');
    console.error('  --companies "A,B,C"   explicit company list');
    console.error('  --from-audit <path>   read from queue-gate audit JSON');
    console.error('  --all-missing         auto-discover from today\'s pre-enrich audit');
    console.error('  --dry-run             plan only, no API calls');
    process.exit(2);
  }

  console.log(`[team-health] ${targets.length} companies to process`);
  for (const t of targets) {
    console.log(`  ${t.company} (rows: ${t.rowNums.join(', ') || 'unspecified'})`);
  }

  if (DRY_RUN) {
    console.log('\n[team-health] dry-run — calculating plan...');
  }

  let totalCost = 0;
  const results = [];
  for (const { company, rowNums } of targets) {
    if (totalCost >= BUDGET_CAP_USD && !DRY_RUN) {
      console.warn(`[team-health] budget cap $${BUDGET_CAP_USD} reached — stopping at ${results.length} processed`);
      break;
    }
    const res = await processCompany(company, rowNums, { dryRun: DRY_RUN });
    totalCost += res.cost || 0;
    results.push({ company, ...res });
  }

  console.log(`\n[team-health] done. ${results.filter(r => r.ok).length}/${results.length} ok. cost: $${totalCost.toFixed(2)}`);
  for (const r of results) {
    const status = r.ok ? (r.cache === 'hit' ? '✓ cached' : r.cache === 'plan-only' ? '○ planned' : '✓ written') : '✗ failed';
    console.log(`  ${status}  ${r.company}${r.cost ? ` ($${r.cost.toFixed(2)})` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }
}

main().catch(e => {
  console.error('[team-health] FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});
