#!/usr/bin/env node
/**
 * tests/team-health-synthesizer.test.mjs
 *
 * Smoke test for GAP-RES-13 — team-health real synthesizer. Verifies:
 *   - NEEDS_SCRAPERS when no rawSignals provided
 *   - CACHED when fresh record exists + force not set
 *   - SYNTHESIZED via mock injection (no API call)
 *   - BUDGET_EXCEEDED when callCouncil overshoots
 *   - ERROR when Sonnet returns non-JSON
 *   - ERROR when invalid company name
 *
 * No live API calls — uses opts.callCouncil dependency injection for the
 * paths that would normally hit Sonnet.
 *
 * Usage:
 *   node tests/team-health-synthesizer.test.mjs
 *
 * Exits 0 on pass; 1 on any failure.
 */

import { synthesizeTeamHealth, TEAM_HEALTH_PER_ROW_USD_CAP, loadTeamHealth, companySlugFromName } from '../lib/team-health.mjs';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.error(`✗ ${name}`);
    if (detail) console.error('  detail:', detail);
    fail++;
    failures.push({ name, detail });
  }
}

// ── Test 1: invalid company → ERROR ────────────────────────────────────────
{
  const r = await synthesizeTeamHealth('');
  check('invalid empty name → ERROR', r.status === 'ERROR', r);
  const r2 = await synthesizeTeamHealth('   ');
  check('whitespace-only name → ERROR', r2.status === 'ERROR', r2);
}

// ── Test 2: no rawSignals + no scrapers → NEEDS_SCRAPERS ──────────────────
{
  const r = await synthesizeTeamHealth('ZetaTestCorp-' + Date.now(), { force: true });
  check('no rawSignals → NEEDS_SCRAPERS', r.status === 'NEEDS_SCRAPERS', r);
  check('next_action mentions Chrome MCP / Phase 5.2', /scrapers|chrome mcp|rawSignals/i.test(r.next_action || ''), r);
  check('cost_usd_estimate is 0', r.cost_usd_estimate === 0, r);
}

// ── Test 3: mock injection → SYNTHESIZED ──────────────────────────────────
{
  const company = 'MockTestCorp-' + Date.now();
  const slug = companySlugFromName(company);
  const mockPath = join(REPO_ROOT, 'data/team-health', `${slug}.json`);
  try {
    const r = await synthesizeTeamHealth(company, {
      force: true,
      mock: {
        providers_called: ['glassdoor'],
        providers_succeeded: ['glassdoor'],
        sources: { glassdoor: { url: 'https://test', overall_score: 3.5, sample_count: 12 } },
        scores: { overall: 3.5, leadership: 3.0, comp: 4.0, growth: 3.0, balance: 3.5 },
        narrative: 'Mixed signals across leadership and pace.',
        anecdotes: [{ source: 'glassdoor', quote: 'Sample.', date: '2026-05-01', sentiment: 'mixed' }],
        toxicity_flags: ['limited-sample'],
      },
    });
    check('mock → SYNTHESIZED', r.status === 'SYNTHESIZED', r);
    check('mock record persisted', existsSync(mockPath), { mockPath });
    check('mock record loadable', !!loadTeamHealth(slug), { slug });
    check('mock cost is 0', r.cost_usd_estimate === 0, r);
  } finally {
    if (existsSync(mockPath)) unlinkSync(mockPath);
  }
}

// ── Test 4: cache hit → CACHED ────────────────────────────────────────────
{
  const company = 'CacheTestCorp-' + Date.now();
  const slug = companySlugFromName(company);
  const mockPath = join(REPO_ROOT, 'data/team-health', `${slug}.json`);
  try {
    // First call: seed cache via mock.
    await synthesizeTeamHealth(company, {
      force: true,
      mock: {
        providers_called: [],
        sources: {},
        scores: { overall: 4.0 },
        narrative: 'seeded for cache test',
        anecdotes: [],
        toxicity_flags: [],
      },
    });
    // Second call: no force → should hit cache.
    const r = await synthesizeTeamHealth(company);
    check('cache hit → CACHED', r.status === 'CACHED', r);
    check('cache hit returns record', !!r.record && r.record.narrative === 'seeded for cache test', r);
    check('cache hit cost is 0', r.cost_usd_estimate === 0, r);
  } finally {
    if (existsSync(mockPath)) unlinkSync(mockPath);
  }
}

// ── Test 5: dependency-injected callCouncil happy path → SYNTHESIZED ──────
{
  const company = 'InjectTestCorp-' + Date.now();
  const slug = companySlugFromName(company);
  const mockPath = join(REPO_ROOT, 'data/team-health', `${slug}.json`);
  try {
    const fakeCouncil = async ({ prompt, models, opts }) => ({
      results: [{
        model: 'anthropic:claude-sonnet-4-6',
        status: 'ok',
        costUsd: 0.012,
        content: JSON.stringify({
          scores: { overall: 3.2, leadership: 3.0, comp: 4.0, growth: 3.0, balance: 3.5 },
          narrative: 'Synthesized narrative from injected council.',
          anecdotes: [{ source: 'glassdoor', quote: 'OK place to work.', date: '2026-04-15', sentiment: 'mixed' }],
          toxicity_flags: [],
          sources: { glassdoor: { url: 'https://glassdoor.com/test', overall_score: 3.2 } },
        }),
      }],
    });
    const r = await synthesizeTeamHealth(company, {
      force: true,
      rawSignals: { glassdoor: { url: 'https://glassdoor.com/test', overall_score: 3.2 } },
      callCouncil: fakeCouncil,
    });
    check('injected council → SYNTHESIZED', r.status === 'SYNTHESIZED', r);
    check('record has narrative', r.record && r.record.narrative === 'Synthesized narrative from injected council.', r);
    check('cost recorded', r.cost_usd_estimate === 0.012, r);
  } finally {
    if (existsSync(mockPath)) unlinkSync(mockPath);
  }
}

// ── Test 6: budget exceeded → BUDGET_EXCEEDED ─────────────────────────────
{
  const company = 'BudgetTestCorp-' + Date.now();
  const slug = companySlugFromName(company);
  const mockPath = join(REPO_ROOT, 'data/team-health', `${slug}.json`);
  try {
    const expensiveCouncil = async () => ({
      results: [{
        model: 'anthropic:claude-sonnet-4-6',
        status: 'ok',
        costUsd: 99.99,
        content: JSON.stringify({ scores: { overall: 3 }, narrative: 'x', anecdotes: [], toxicity_flags: [], sources: {} }),
      }],
    });
    const r = await synthesizeTeamHealth(company, {
      force: true,
      rawSignals: { glassdoor: { url: 'https://test' } },
      callCouncil: expensiveCouncil,
      budgetUsd: 1.0,  // tight cap
    });
    check('over-budget → BUDGET_EXCEEDED', r.status === 'BUDGET_EXCEEDED', r);
    check('over-budget record NOT saved', !existsSync(mockPath), { mockPath });
    check('cost reported in response', r.cost_usd_estimate === 99.99, r);
  } finally {
    if (existsSync(mockPath)) unlinkSync(mockPath);
  }
}

// ── Test 7: non-JSON content → ERROR ──────────────────────────────────────
{
  const company = 'NonJsonTestCorp-' + Date.now();
  const fakeCouncil = async () => ({
    results: [{
      model: 'anthropic:claude-sonnet-4-6',
      status: 'ok',
      costUsd: 0.01,
      content: 'this is not json at all just plain text from a misbehaving model',
    }],
  });
  const r = await synthesizeTeamHealth(company, {
    force: true,
    rawSignals: { glassdoor: { url: 'https://test' } },
    callCouncil: fakeCouncil,
  });
  check('non-JSON content → ERROR', r.status === 'ERROR', r);
  check('error mentions parse failure', /non-json|json|parse/i.test(r.next_action || ''), r);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${pass} passed, ${fail} failed`);
console.log(`Per-row cap exposed: $${TEAM_HEALTH_PER_ROW_USD_CAP}`);
if (fail > 0) {
  console.error('');
  console.error('Failures:');
  for (const f of failures) {
    console.error('  -', f.name, '→', JSON.stringify(f.detail).slice(0, 240));
  }
  process.exit(1);
}
process.exit(0);
