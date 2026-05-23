#!/usr/bin/env node
/**
 * scripts/populate-company-intel-mini.mjs — Lightweight company-intel populator
 *
 * Phase 1.5 of master-resolution-prompt-2026-05-22.
 *
 * Creates data/company-intel-cache/<slug>/intel-<DATE>.json with a
 * STRICT-COMPATIBLE subset of the canonical company-intel-cache shape:
 *   {
 *     company, company_display, computed_at, council_models_used,
 *     tto_estimate{}, toxicity_score{}, hiring_posture, equity_story,
 *     team_intel{}, negative_signals[], _meta{owner, method, cost_usd}
 *   }
 *
 * The canonical deep pipeline (whatever produced anthropic/intel-2026-05-16.json)
 * remains the source of truth for "intel-of-record". This mini version
 * unblocks the queue gate without re-running the full pipeline.
 *
 * Usage:
 *   node scripts/populate-company-intel-mini.mjs --companies "Databricks,Deepgram,Ramp"
 *   node scripts/populate-company-intel-mini.mjs --from-audit=data/queue-gate-audit-2026-05-22-mid-enrich.json
 *   node scripts/populate-company-intel-mini.mjs --dry-run
 *
 * Env:
 *   COMPANY_INTEL_MINI_BUDGET   total $ cap (default $40)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

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
const BUDGET_CAP_USD = Number(process.env.COMPANY_INTEL_MINI_BUDGET || '40');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* */ }
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

function isPopulated(companySlug) {
  const dir = join(ROOT, 'data', 'company-intel-cache', companySlug);
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir).filter(e => e.endsWith('.json'));
    return entries.some(e => e.startsWith('intel-') || e.startsWith('council-') || e === '_meta.json');
  } catch {
    return false;
  }
}

async function researchOne(company) {
  const { callCouncil } = await import('../lib/council.mjs');

  const prompt = [
    `# Task — company-intel snapshot for ${company}`,
    ``,
    `Mitchell Williams is considering applying to roles at ${company}. Today: ${new Date().toISOString().slice(0, 10)}.`,
    ``,
    `Return STRICT JSON. First char "{", last char "}". No markdown. No preamble.`,
    ``,
    `{`,
    `  "company": "${company}",`,
    `  "tto_estimate": {`,
    `    "weeks_estimate": integer (typical time-to-offer from application, 3-12),`,
    `    "velocity_tier": "fast|medium|slow",`,
    `    "basis": "string — what informed the estimate",`,
    `    "confidence": "high|medium|low"`,
    `  },`,
    `  "toxicity_score": {`,
    `    "score": integer 0-100 (higher = more toxic),`,
    `    "verdict": "healthy|caution|avoid|unknown",`,
    `    "triggered_signals": [`,
    `      { "signal": "string e.g. layoffs_recent|ipo_imminent|cofounder_drama|comp_freeze|reorg", "weight": integer, "source": "url|unknown", "date": "ISO date|null", "note": "1-line context" }`,
    `    ]`,
    `  },`,
    `  "hiring_posture": "actively-hiring|hiring-selectively|frozen|unknown",`,
    `  "equity_story": "2-3 sentence summary of equity package, vesting, recent valuation, pre-IPO timing. Cite source if known.",`,
    `  "team_intel": {`,
    `    "size_estimate": "string e.g. '~500 employees as of late 2025'",`,
    `    "growth_trajectory": "string — recent headcount trend",`,
    `    "key_orgs": ["list of teams Mitchell's roles would likely sit in"]`,
    `  },`,
    `  "negative_signals": [`,
    `    "1-line specific concern, with source URL"`,
    `  ],`,
    `  "positive_signals": [`,
    `    "1-line specific bull case, with source URL"`,
    `  ]`,
    `}`,
    ``,
    `CRITICAL:`,
    `- Cite source URLs where possible.`,
    `- Be honest about uncertainty: "unknown" is preferred over guesses.`,
    `- The toxicity_score is the gating signal for whether Mitchell should apply — calibrate carefully.`,
  ].join('\n');

  let council;
  try {
    council = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6', 'xai:grok-4-x-search'],
      opts: { timeoutMs: 180_000, maxTokens: 3500 },
    });
  } catch (e) {
    emit({ slot: 'company-intel-mini', company, error: String(e.message || e) });
    return null;
  }

  const cost = council.report?.totalCost || 0;
  const succeeded = (council.results || []).filter(r => !r.error && r.content);
  if (!succeeded.length) return null;
  const parses = succeeded.map(r => extractJson(r.content)).filter(Boolean);
  if (!parses.length) return null;

  // Take parse with the most triggered_signals (richest)
  const best = parses.sort((a, b) => {
    const aSigs = (a.toxicity_score?.triggered_signals?.length || 0) + (a.negative_signals?.length || 0) + (a.positive_signals?.length || 0);
    const bSigs = (b.toxicity_score?.triggered_signals?.length || 0) + (b.negative_signals?.length || 0) + (b.positive_signals?.length || 0);
    return bSigs - aSigs;
  })[0];

  const computedAt = new Date().toISOString();
  const today = computedAt.slice(0, 10);

  return {
    payload: {
      company: slugify(company),
      company_display: company,
      computed_at: computedAt,
      council_models_used: succeeded.map(r => r.model),
      cost_usd: cost,
      tto_estimate: best.tto_estimate || { weeks_estimate: 8, velocity_tier: 'medium', basis: 'phase-1.5 mini default', confidence: 'low' },
      toxicity_score: best.toxicity_score || { score: 50, verdict: 'unknown', triggered_signals: [] },
      hiring_posture: best.hiring_posture || 'unknown',
      equity_story: best.equity_story || '',
      team_intel: best.team_intel || {},
      negative_signals: Array.isArray(best.negative_signals) ? best.negative_signals : [],
      positive_signals: Array.isArray(best.positive_signals) ? best.positive_signals : [],
      _meta: { owner: 'phase-1.5-auto-enrich', method: 'phase-1.5-mini', cost_usd: cost },
    },
    fileName: `intel-${today}.json`,
  };
}

async function processCompany(company) {
  const slug = slugify(company);

  if (isPopulated(slug)) {
    emit({ slot: 'company-intel-mini', company, cache: 'hit', step: 'already-populated' });
    return { ok: true, cache: 'hit', cost: 0 };
  }

  if (DRY_RUN) {
    emit({ slot: 'company-intel-mini', company, step: 'dry-run-plan' });
    return { ok: true, cache: 'planned', cost: 5 };
  }

  emit({ slot: 'company-intel-mini', company, step: 'researching' });
  const result = await researchOne(company);
  if (!result) return { ok: false, error: 'research-failed' };

  const dir = join(ROOT, 'data', 'company-intel-cache', slug);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, result.fileName);
  writeFileSync(outPath, JSON.stringify(result.payload, null, 2), 'utf-8');
  emit({ slot: 'company-intel-mini', company, step: 'written', path: outPath, cost_usd: result.payload._meta?.cost_usd });
  return { ok: true, path: outPath, cost: result.payload._meta?.cost_usd || 0 };
}

function loadCompaniesFromAudit(auditPath) {
  const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
  const rows = audit.auto_enrich || [];
  const set = new Set();
  for (const r of rows) {
    if (!r.company || r.company === 'Unknown') continue;
    if (r._gate?.missing_repositories?.includes('company')) {
      set.add(r.company);
    }
  }
  return [...set];
}

async function main() {
  let companies = [];
  if (ARGS['from-audit']) {
    companies = loadCompaniesFromAudit(join(ROOT, ARGS['from-audit']));
  } else if (ARGS['companies']) {
    companies = String(ARGS['companies']).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    console.error('Usage:');
    console.error('  --companies "A,B,C"   explicit list');
    console.error('  --from-audit <path>   read from queue-gate audit JSON (missing-company rows)');
    console.error('  --dry-run             plan only');
    process.exit(2);
  }

  console.log(`[company-intel-mini] ${companies.length} companies to research`);
  for (const c of companies) {
    console.log(`  ${c}${isPopulated(slugify(c)) ? '  (already populated — will skip)' : ''}`);
  }
  console.log(`[company-intel-mini] budget cap: $${BUDGET_CAP_USD}`);

  if (DRY_RUN) {
    const newCount = companies.filter(c => !isPopulated(slugify(c))).length;
    console.log(`\n[company-intel-mini] DRY-RUN — estimated cost: $${(newCount * 5).toFixed(2)}`);
    return;
  }

  let totalCost = 0;
  const results = [];
  for (const c of companies) {
    if (totalCost >= BUDGET_CAP_USD) {
      console.warn(`[company-intel-mini] budget cap $${BUDGET_CAP_USD} reached — stopping at ${results.length} processed`);
      break;
    }
    const res = await processCompany(c);
    totalCost += res.cost || 0;
    results.push({ company: c, ...res });
  }

  console.log(`\n[company-intel-mini] done. ${results.filter(r => r.ok).length}/${results.length} ok. cost: $${totalCost.toFixed(2)}`);
  for (const r of results) {
    const status = r.ok ? (r.cache === 'hit' ? '✓ cached' : '✓ written') : '✗ failed';
    console.log(`  ${status}  ${r.company}${r.cost ? ` ($${r.cost.toFixed(2)})` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }
}

main().catch(e => {
  console.error('[company-intel-mini] FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});
