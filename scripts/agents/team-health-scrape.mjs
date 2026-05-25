#!/usr/bin/env node
/**
 * scripts/agents/team-health-scrape.mjs — Phase 5.2 v2 orchestrator
 *
 * Sibling to team-health-research.mjs (v1 Sonnet-only). This script actually
 * scrapes Glassdoor / Indeed / Blind / Levels.fyi via CDP-first + headless
 * fallback (lib/team-health-scrapers/multi-source-scraper.mjs), then passes
 * the rawSignals to synthesizeTeamHealth (lib/team-health.mjs).
 *
 * Records get tagged generated_by:'team-health-scrape:v2-cdp-hybrid' so
 * downstream consumers can distinguish scraper-backed v2 records from
 * v1 Sonnet-only synthesis.
 *
 * 5 companies (handoff Q2 lock 2026-05-25):
 *   Cursor (Anysphere) → slug cursor-anysphere
 *   Cohere             → slug cohere
 *   Cognition          → slug cognition
 *   WorkOS             → slug workos
 *   Baseten            → slug baseten
 *
 * Usage:
 *   node scripts/agents/team-health-scrape.mjs                       # all 5
 *   node scripts/agents/team-health-scrape.mjs --company "Cursor"    # one
 *   node scripts/agents/team-health-scrape.mjs --dry-run             # plan only
 *   node scripts/agents/team-health-scrape.mjs --force               # ignore cache
 *   node scripts/agents/team-health-scrape.mjs --verbose             # per-source progress
 *
 * Cost: ~$2-5/company (4 sources × ~$0.50/source Sonnet extraction). Hard
 * cap $100 total via --max-cost-usd flag.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

import { callCouncil } from '../../lib/council.mjs';
import {
  synthesizeTeamHealth,
  loadTeamHealth,
  saveTeamHealth,
  companySlugFromName,
  isFresh,
} from '../../lib/team-health.mjs';
import { scrapeAllSources } from '../../lib/team-health-scrapers/multi-source-scraper.mjs';

const TARGETS = [
  { name: 'Cursor (Anysphere)', slug: 'cursor-anysphere', row_nums: ['840'] },
  { name: 'Cohere',             slug: 'cohere',           row_nums: ['863'] },
  { name: 'Cognition',          slug: 'cognition',        row_nums: ['1514'] },
  { name: 'WorkOS',             slug: 'workos',           row_nums: ['2373'] },
  { name: 'Baseten',            slug: 'baseten',          row_nums: ['2342'] },
];

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}

function parseArgs(argv) {
  const out = { dryRun: false, force: false, maxCostUsd: 100, company: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--company') out.company = argv[++i];
    else if (a.startsWith('--company=')) out.company = a.slice('--company='.length);
    else if (a === '--max-cost-usd') out.maxCostUsd = Number(argv[++i]);
    else if (a.startsWith('--max-cost-usd=')) out.maxCostUsd = Number(a.slice('--max-cost-usd='.length));
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/agents/team-health-scrape.mjs [--company NAME] [--dry-run] [--force] [--verbose] [--max-cost-usd N]`);
      process.exit(0);
    }
  }
  return out;
}

async function scrapeCompany(target, opts) {
  const { name, slug, row_nums } = target;
  emit({ slot: 'th-scrape', phase: 'company-start', company: name, slug });

  if (!opts.force) {
    const cached = loadTeamHealth(slug);
    if (cached && isFresh(cached) && cached._meta?.generated_by?.startsWith('team-health-scrape:v2')) {
      emit({ slot: 'th-scrape', phase: 'cache-hit', company: name, slug });
      return { company: name, slug, ok: true, cached: true, cost_usd: 0 };
    }
  }

  if (opts.dryRun) {
    emit({ slot: 'th-scrape', phase: 'dry-run', company: name, slug });
    return { company: name, slug, ok: true, dry: true, cost_usd: 0 };
  }

  // Phase A: scrape all 4 sources
  let scrapeResult;
  try {
    scrapeResult = await scrapeAllSources(name, { companySlug: slug, verbose: opts.verbose });
  } catch (err) {
    emit({ slot: 'th-scrape', phase: 'scrape-threw', company: name, slug, error: String(err.message || err) });
    return { company: name, slug, ok: false, error: String(err.message || err), cost_usd: 0 };
  }

  emit({
    slot: 'th-scrape', phase: 'scrape-done', company: name, slug,
    scrape_log: scrapeResult.scrapeLog, scrape_cost_usd: Number(scrapeResult.totalCostUsd.toFixed(4)),
  });

  // Phase B: pass to synthesizer
  let synthResult;
  try {
    synthResult = await synthesizeTeamHealth(name, {
      force: opts.force,
      rowNums: row_nums,
      budgetUsd: 5,
      rawSignals: scrapeResult.rawSignals,
      callCouncil,
    });
  } catch (err) {
    emit({ slot: 'th-scrape', phase: 'synth-threw', company: name, slug, error: String(err.message || err) });
    return { company: name, slug, ok: false, error: String(err.message || err), cost_usd: scrapeResult.totalCostUsd };
  }

  // Tag the record with v2 provenance
  if (synthResult.status === 'SYNTHESIZED' && synthResult.record) {
    const recordWithMeta = {
      ...synthResult.record,
      _meta: {
        ...(synthResult.record._meta || {}),
        generated_by: 'team-health-scrape:v2-cdp-hybrid',
        scraped: true,
        scrape_log: scrapeResult.scrapeLog,
      },
    };
    saveTeamHealth(slug, recordWithMeta);
  }

  const totalCost = scrapeResult.totalCostUsd + (synthResult.cost_usd_estimate || 0);
  emit({
    slot: 'th-scrape', phase: 'company-done', company: name, slug,
    status: synthResult.status, total_cost_usd: Number(totalCost.toFixed(4)),
  });
  return {
    company: name, slug, ok: synthResult.status === 'SYNTHESIZED' || synthResult.status === 'CACHED',
    status: synthResult.status,
    cost_usd: totalCost,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let targets = TARGETS;
  if (opts.company) {
    targets = TARGETS.filter(t => t.name.toLowerCase().includes(opts.company.toLowerCase()));
    if (targets.length === 0) {
      console.error(`No target matched "${opts.company}". Known targets:`);
      TARGETS.forEach(t => console.error(`  - ${t.name}`));
      process.exit(2);
    }
  }

  emit({ slot: 'th-scrape', phase: 'start', count: targets.length, dry_run: opts.dryRun, force: opts.force, max_cost_usd: opts.maxCostUsd });

  let totalCost = 0;
  const summary = [];
  for (const t of targets) {
    if (totalCost >= opts.maxCostUsd) {
      console.warn(`[team-health-scrape] cost cap $${opts.maxCostUsd} reached — stopping at ${summary.length}/${targets.length}`);
      break;
    }
    const r = await scrapeCompany(t, opts);
    totalCost += r.cost_usd || 0;
    summary.push(r);
  }

  emit({ slot: 'th-scrape', phase: 'done', total_cost_usd: Number(totalCost.toFixed(4)), count: summary.length });
  console.log(JSON.stringify({ ok: true, total_cost_usd: Number(totalCost.toFixed(4)), summary }, null, 2));
}

main().catch((err) => {
  console.error('[team-health-scrape] unhandled error:', err);
  process.exit(1);
});
