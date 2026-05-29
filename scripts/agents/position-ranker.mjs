#!/usr/bin/env node
// scripts/agents/position-ranker.mjs
//
// Theme 7 PR 2 (2026-05-29) — cross-role ranking agent. Ingests Mitchell's
// career corpus via lib/corpus-scanner + a list of candidate roles, calls
// Sonnet 4.6 to rank by corpus fit, writes ranked output + per-role rationale.
//
// CLI:
//   node scripts/agents/position-ranker.mjs [--top N] [--output PATH] [--dry-run]
//
// Flags:
//   --top N            Number of roles to rank (default 20)
//   --output PATH      Output JSON path (default data/position-ranking-<DATE>.json)
//   --dry-run          Compose prompt + print size, don't call LLM (free)
//   --roles-from src   Roles source (default 'apply-now-queue')
//   --print            Pretty-print ranking summary to stdout after write
//
// Library exports (for tests + downstream skill in PR 3):
//   loadRoles, composePrompt, parseRanking, rankPositions

import { scanCorpus, summarizeCorpus } from '../../lib/corpus-scanner.mjs';
import { callCouncil, initCostTrace } from '../../lib/council.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ────────────────────────────────────────────────────────────────────────────
// CLI parsing

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    top: 20,
    output: null,
    dryRun: false,
    rolesFrom: 'apply-now-queue',
    print: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--dry-run' || a === '--no-call') args.dryRun = true;
    else if (a === '--roles-from') args.rolesFrom = argv[++i];
    else if (a === '--print') args.print = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/agents/position-ranker.mjs [--top N] [--output PATH] [--dry-run] [--roles-from apply-now-queue] [--print]');
      process.exit(0);
    }
  }
  return args;
}

// ────────────────────────────────────────────────────────────────────────────
// Role loading

export function loadRoles({ source = 'apply-now-queue', root = ROOT, top = 20 } = {}) {
  if (source === 'apply-now-queue') {
    const path = join(root, 'data/apply-now-queue.json');
    if (!existsSync(path)) return [];
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (_) {
      return [];
    }
    const ranked = (raw.ranked || raw.roles || []).slice(0, top);
    return ranked.map(r => ({
      num: r.num,
      role: r.role || r.title || '',
      company: r.company || '',
      score: r.score ?? r.composite ?? null,
      composite: r.composite ?? r.score ?? null,
      slug: r.slug || `${r.num || 0}-${(r.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    }));
  }
  throw new Error(`Unknown roles source: ${source}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt composition

export function composePrompt({ corpus, roles }) {
  const corpusSummary = summarizeCorpus(corpus);
  const inlineEntries = corpus.entries
    .filter(e => ['canonical', 'profile', 'tracker'].includes(e.source_type))
    .slice(0, 5);
  const inlineText = inlineEntries
    .map(e => `### ${e.source_path}\n${(e.content || '').slice(0, 8000)}`)
    .join('\n\n');

  const roleList = roles
    .map((r, i) => `${i + 1}. ${r.company} — ${r.role} (current score: ${r.score ?? 'n/a'})`)
    .join('\n');

  return `You are an expert career advisor helping Mitchell Williams rank job positions by corpus fit.

# Mitchell's career corpus (summary)
${corpusSummary}

# Inline corpus excerpts (canonical + profile + tracker, up to ~40K chars total)
${inlineText}

# Candidate roles (${roles.length} total)
${roleList}

# Task
Rank these roles by fit with Mitchell's corpus. For each role, consider:
1. Skill match — does the corpus show evidence of skills the role requires?
2. Trajectory fit — does the role advance Mitchell's stated career direction (AI PgM / FDE / Solutions Architect at AI-native orgs)?
3. Differentiation — what unique edge does Mitchell bring to this role?
4. Risk — what gaps could cost him the role?

Output a JSON array of objects, one per role, sorted with rank=1 as best fit. Each object MUST have:
  - rank          (integer, 1 = best fit)
  - role_idx      (1-indexed position in the input list)
  - company       (string)
  - role          (string)
  - fit_rationale (2-3 sentences, evidence-cited from the corpus)
  - key_corpus_evidence (array of 2-4 short citations like "cv.md: 6yr Field Eng at Google")
  - top_gap       (1 sentence on biggest weakness or risk)

Return ONLY the JSON array. No preamble, no closing remarks, no code fences.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Response parsing — tolerant of code fences, preamble, malformed JSON

export function parseRanking(text) {
  if (!text || typeof text !== 'string') return [];
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
  }
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart < 0 || arrEnd < 0 || arrEnd < arrStart) return [];
  const arrText = cleaned.slice(arrStart, arrEnd + 1);
  let parsed;
  try {
    parsed = JSON.parse(arrText);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((r, i) => ({
      rank: Number(r.rank ?? i + 1),
      role_idx: r.role_idx ?? i + 1,
      company: String(r.company || ''),
      role: String(r.role || ''),
      fit_rationale: String(r.fit_rationale || ''),
      key_corpus_evidence: Array.isArray(r.key_corpus_evidence)
        ? r.key_corpus_evidence.map(String)
        : [],
      top_gap: String(r.top_gap || ''),
    }))
    .sort((a, b) => a.rank - b.rank);
}

// ────────────────────────────────────────────────────────────────────────────
// Main orchestration — library API

export async function rankPositions({
  roles,
  corpus,
  dryRun = false,
  agentSlug = 'position-ranker',
} = {}) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return { prompt: '', ranking: [], cost_usd: 0, error: 'no roles provided' };
  }
  if (!corpus || !Array.isArray(corpus.entries)) {
    return { prompt: '', ranking: [], cost_usd: 0, error: 'invalid corpus' };
  }

  const prompt = composePrompt({ corpus, roles });
  if (dryRun) {
    return { prompt, ranking: [], cost_usd: 0, dry_run: true };
  }

  const onCostRecord = initCostTrace(agentSlug, ROOT);
  let result;
  try {
    result = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6'],
      opts: {
        taskType: 'long_form_research',
        callerLabel: 'position-ranker',
        agentSlug,
        maxTokens: 8000,
        timeoutMs: 180_000,
        onCostRecord,
      },
    });
  } catch (err) {
    return { prompt, ranking: [], cost_usd: 0, error: String(err?.message || err) };
  }

  const first = result.results?.[0];
  if (!first || first.error) {
    return { prompt, ranking: [], cost_usd: 0, error: first?.error || 'no result' };
  }

  const ranking = parseRanking(first.content);
  return {
    prompt,
    ranking,
    cost_usd: first.costUsd || 0,
    model_used: first.modelUsed || first.model,
    ms: result.totalMs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry point

async function main() {
  const args = parseArgs();
  console.log(`[position-ranker] scanning corpus + loading top ${args.top} roles from ${args.rolesFrom}...`);
  const corpus = scanCorpus({ root: ROOT });
  console.log(summarizeCorpus(corpus));

  const roles = loadRoles({ source: args.rolesFrom, root: ROOT, top: args.top });
  console.log(`[position-ranker] loaded ${roles.length} roles`);
  if (roles.length === 0) {
    console.log('[position-ranker] no roles loaded — aborting (check data/apply-now-queue.json)');
    process.exit(1);
  }

  console.log(`[position-ranker] composing prompt + calling Sonnet 4.6${args.dryRun ? ' (DRY RUN — no LLM call)' : ''}...`);
  const result = await rankPositions({ roles, corpus, dryRun: args.dryRun });

  if (args.dryRun) {
    console.log('--- DRY RUN PROMPT (first 4000 chars) ---');
    console.log(result.prompt.slice(0, 4000) + (result.prompt.length > 4000 ? '\n...[truncated]' : ''));
    console.log('--- END ---');
    console.log(`prompt size: ${result.prompt.length} chars`);
    return;
  }

  if (result.error) {
    console.error(`[position-ranker] error: ${result.error}`);
    process.exit(1);
  }

  console.log(`[position-ranker] ranking complete (${result.ranking.length} entries, $${result.cost_usd.toFixed(4)}, ${result.ms}ms)`);

  const date = new Date().toISOString().slice(0, 10);
  const outPath = args.output || join(ROOT, 'data', `position-ranking-${date}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    roles_count: roles.length,
    model_used: result.model_used,
    cost_usd: result.cost_usd,
    ranking: result.ranking,
  }, null, 2), 'utf8');
  console.log(`[position-ranker] wrote ${outPath}`);

  if (args.print) {
    console.log('\n--- TOP 5 ---');
    for (const r of result.ranking.slice(0, 5)) {
      console.log(`#${r.rank}  ${r.company} — ${r.role}`);
      console.log(`   ${r.fit_rationale}`);
      console.log(`   gap: ${r.top_gap}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[position-ranker] FATAL:', err.message);
    process.exit(1);
  });
}
