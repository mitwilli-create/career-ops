#!/usr/bin/env node
// scripts/agents/apply-pack-interview.mjs
//
// Theme 7 PR 3 (2026-05-29) — LLM-backed agent for the interview-driven
// apply-pack revision workflow. Companion to
// .claude/skills/apply-pack-interview/SKILL.md, which orchestrates the
// conversational loop with Mitchell.
//
// The agent itself does NOT prompt the user interactively. Claude handles
// the question-by-question conversation + writes answers into the per-role
// state file directly; this agent just supplies (a) the question list when
// Claude asks for it and (b) the artifact revisions when Claude is ready
// to apply them.
//
// CLI sub-commands:
//   --plan ROLE_SLUG    Generate revision questions for one role
//                       (LLM call: Sonnet 4.6 + corpus context)
//   --apply ROLE_SLUG   Revise apply-pack artifacts using answers in state
//                       (one LLM call per touched artifact)
//   --status ROLE_SLUG  Show progress (questions / answers / pending)
//
// Flags:
//   --dry-run           Compose prompts + print sizes, no LLM calls
//
// State: data/apply-pack-interview-<slug>.json (gitignored)
//
// Library exports (for tests + skill orchestration):
//   loadInterviewState, saveInterviewState, loadApplyPack,
//   composePlanPrompt, parseQuestionPlan,
//   composeReviseArtifactPrompt, planRevision, reviseArtifact,
//   groupAnswersByArtifact, parseArgs

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env BEFORE importing modules that read process.env at module-load.
// Mitchell's shell pre-sets ANTHROPIC_API_KEY="" so override:true is required
// (the empty value would otherwise win against the .env value). Bug class:
// env-shadow-on-lazy-dotenv — see AGENTS.md.
try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), override: true });
} catch { /* dotenv optional — silently skip if not installed */ }

import { scanCorpus } from '../../lib/corpus-scanner.mjs';
import { loadRoles } from './position-ranker.mjs';
import { callCouncil, initCostTrace } from '../../lib/council.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STATE_DIR = join(ROOT, 'data');

// ────────────────────────────────────────────────────────────────────────────
// State management

export function loadInterviewState(roleSlug, root = ROOT) {
  const path = join(root, 'data', `apply-pack-interview-${roleSlug}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (_) { return null; }
}

export function saveInterviewState(roleSlug, state, root = ROOT) {
  const dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `apply-pack-interview-${roleSlug}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  return path;
}

export function loadApplyPack(roleSlug, root = ROOT) {
  const dir = join(root, 'apply-pack', roleSlug);
  if (!existsSync(dir)) return null;
  let files;
  try { files = readdirSync(dir); } catch (_) { return null; }
  const artifacts = {};
  for (const f of files) {
    if (!f.endsWith('.md') && !f.endsWith('.json')) continue;
    const name = f.replace(/\.(md|json)$/, '');
    try {
      artifacts[name] = {
        path: join(dir, f),
        content: readFileSync(join(dir, f), 'utf8'),
        ext: f.endsWith('.json') ? 'json' : 'md',
      };
    } catch (_) { /* skip unreadable */ }
  }
  return artifacts;
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt composition

export function composePlanPrompt({ role, corpus, applyPack }) {
  const artifactsList = Object.keys(applyPack || {});
  const corpusExcerpts = (corpus?.entries || [])
    .filter(e => ['canonical', 'profile', 'intel'].includes(e.source_type))
    .slice(0, 6)
    .map(e => `### ${e.source_path}\n${(e.content || '').slice(0, 2500)}`)
    .join('\n\n');

  return `You are helping Mitchell Williams revise the apply-pack materials for a specific role through an interview process.

# Role
Company: ${role.company || '(unknown)'}
Role: ${role.role || '(unknown)'}
Slug: ${role.slug || '(unknown)'}
${role.fit_rationale ? `Fit rationale: ${role.fit_rationale}` : ''}
${role.top_gap ? `Top gap: ${role.top_gap}` : ''}
${role.key_corpus_evidence?.length ? `Key corpus evidence:\n${role.key_corpus_evidence.map(e => `  - ${e}`).join('\n')}` : ''}

# Current apply-pack artifacts (filenames; full content NOT inlined for prompt size)
${artifactsList.length ? artifactsList.map(a => `  - ${a}`).join('\n') : '  (none)'}

# Career corpus excerpts (canonical + profile + intel for this role, truncated)
${corpusExcerpts}

# Task
Generate a list of 5-8 revision QUESTIONS to ask Mitchell one at a time. Each question should:
- Target a specific weakness, missing context, or improvement opportunity for THIS role
- Have a focused, concrete answer (NOT open-ended brainstorming)
- Be answerable in 2-3 sentences max
- Surface information that's NOT already in the corpus (asking the corpus questions is wasteful)

Output a JSON array of objects, each MUST have:
  - id              (short kebab-case slug like "lead-with" or "metric-hook")
  - artifact        (which apply-pack artifact this revises: "cv-tailored" / "cover-letter" / "form-fields" / "linkedin-dm" / "impact-doc" / "references" / "referrals")
  - question        (the actual question to ask Mitchell, written conversationally)
  - why             (1 sentence: why this question matters for THIS role)
  - example_answer  (1 short example showing the shape of answer we need)

Return ONLY the JSON array. No preamble, no closing remarks, no code fences.`;
}

export function parseQuestionPlan(text) {
  if (!text || typeof text !== 'string') return [];
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
  }
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end < 0 || end < start) return [];
  let arr;
  try { arr = JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((q, i) => ({
    id: String(q.id || `q-${i + 1}`),
    artifact: String(q.artifact || 'cv-tailored'),
    question: String(q.question || ''),
    why: String(q.why || ''),
    example_answer: String(q.example_answer || ''),
  })).filter(q => q.question);
}

export function composeReviseArtifactPrompt({ role, artifactName, currentContent, qa }) {
  const qaBlock = qa.map(({ question, answer }) =>
    `Q: ${question}\nA: ${answer}`).join('\n\n');

  return `You are revising Mitchell Williams' apply-pack artifact "${artifactName}" for a specific role.

# Role
${role.company || '(unknown)'} — ${role.role || '(unknown)'}

# Current artifact content
\`\`\`
${(currentContent || '').slice(0, 12000)}
\`\`\`

# Mitchell's answers to revision questions targeting this artifact
${qaBlock}

# Task
Produce a REVISED version of the artifact that incorporates Mitchell's answers. Rules:
- Preserve the artifact's original structure + section headings
- Preserve the artifact's voice (factual, evidence-cited, no overclaiming)
- Preserve any markdown formatting
- CHANGE only what the Q&A requires — do NOT rewrite untouched sections
- Do NOT invent details Mitchell did not provide
- Do NOT add fluff, hedges, or filler

Return ONLY the revised artifact body. No preamble, no commentary, no code fences.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Q/A grouping

export function groupAnswersByArtifact(state) {
  const groups = {};
  if (!state?.questions || !state?.answers) return groups;
  for (const q of state.questions) {
    const a = state.answers[q.id];
    if (a === undefined || a === null || a === '') continue;
    if (!groups[q.artifact]) groups[q.artifact] = [];
    groups[q.artifact].push({ id: q.id, question: q.question, answer: a });
  }
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// LLM-backed operations

export async function planRevision({
  role, corpus, applyPack, dryRun = false, agentSlug = 'apply-pack-interview',
} = {}) {
  if (!role) return { prompt: '', questions: [], cost_usd: 0, error: 'no role provided' };
  if (!corpus) return { prompt: '', questions: [], cost_usd: 0, error: 'no corpus' };
  const prompt = composePlanPrompt({ role, corpus, applyPack: applyPack || {} });
  if (dryRun) return { prompt, questions: [], cost_usd: 0, dry_run: true };

  const onCostRecord = initCostTrace(agentSlug, ROOT);
  let result;
  try {
    result = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6'],
      opts: {
        taskType: 'long_form_research',
        callerLabel: 'apply-pack-interview-plan',
        agentSlug,
        maxTokens: 4000,
        timeoutMs: 120_000,
        onCostRecord,
      },
    });
  } catch (err) {
    return { prompt, questions: [], cost_usd: 0, error: String(err?.message || err) };
  }
  const first = result.results?.[0];
  if (!first || first.error) {
    return { prompt, questions: [], cost_usd: 0, error: first?.error || 'no result' };
  }
  return {
    prompt,
    questions: parseQuestionPlan(first.content),
    cost_usd: first.costUsd || 0,
    model_used: first.modelUsed || first.model,
  };
}

export async function reviseArtifact({
  role, artifactName, currentContent, qa, dryRun = false,
  agentSlug = 'apply-pack-interview',
} = {}) {
  if (!role || !artifactName) {
    return { prompt: '', revised: '', cost_usd: 0, error: 'missing role or artifactName' };
  }
  if (!Array.isArray(qa) || qa.length === 0) {
    return { prompt: '', revised: '', cost_usd: 0, error: 'no qa' };
  }
  const prompt = composeReviseArtifactPrompt({ role, artifactName, currentContent: currentContent || '', qa });
  if (dryRun) return { prompt, revised: '', cost_usd: 0, dry_run: true };

  const onCostRecord = initCostTrace(agentSlug, ROOT);
  let result;
  try {
    result = await callCouncil({
      prompt,
      models: ['anthropic:claude-sonnet-4-6'],
      opts: {
        taskType: 'voice_match_writing',
        callerLabel: 'apply-pack-interview-revise',
        agentSlug,
        maxTokens: 8000,
        timeoutMs: 180_000,
        onCostRecord,
      },
    });
  } catch (err) {
    return { prompt, revised: '', cost_usd: 0, error: String(err?.message || err) };
  }
  const first = result.results?.[0];
  if (!first || first.error) {
    return { prompt, revised: '', cost_usd: 0, error: first?.error || 'no result' };
  }
  return {
    prompt,
    revised: first.content || '',
    cost_usd: first.costUsd || 0,
    model_used: first.modelUsed || first.model,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI parsing + main

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { cmd: null, roleSlug: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan')        { args.cmd = 'plan';   args.roleSlug = argv[++i]; }
    else if (a === '--apply')  { args.cmd = 'apply';  args.roleSlug = argv[++i]; }
    else if (a === '--status') { args.cmd = 'status'; args.roleSlug = argv[++i]; }
    else if (a === '--dry-run' || a === '--no-call') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/agents/apply-pack-interview.mjs (--plan SLUG | --apply SLUG | --status SLUG) [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function cmdPlan(roleSlug, dryRun) {
  const corpus = scanCorpus({ root: ROOT });
  const roles = loadRoles({ root: ROOT, top: 200 });
  const role = roles.find(r => r.slug === roleSlug)
            || { slug: roleSlug, company: '(unknown — not in apply-now queue)', role: '(unknown)' };
  const applyPack = loadApplyPack(roleSlug);
  if (!applyPack) {
    console.error(`No apply-pack directory found for ${roleSlug} (expected apply-pack/${roleSlug}/)`);
    process.exit(1);
  }
  const result = await planRevision({ role, corpus, applyPack, dryRun });
  if (result.error) { console.error(`[plan] error: ${result.error}`); process.exit(1); }

  if (dryRun) {
    console.log('--- DRY RUN PROMPT (first 4000 chars) ---');
    console.log(result.prompt.slice(0, 4000));
    console.log('--- END ---');
    console.log(`prompt size: ${result.prompt.length} chars`);
    return;
  }

  const state = {
    role_slug: roleSlug,
    role,
    generated_at: new Date().toISOString(),
    model_used: result.model_used,
    plan_cost_usd: result.cost_usd,
    questions: result.questions,
    answers: {},     // {q.id: "answer text"} — populated by Claude during interview
    apply_log: [],   // populated by --apply
  };
  const path = saveInterviewState(roleSlug, state);
  console.log(`[plan] generated ${result.questions.length} questions for ${roleSlug} ($${result.cost_usd.toFixed(4)})`);
  console.log(`[plan] saved to ${path}`);
  for (const q of result.questions) {
    console.log(`  [${q.id}] (${q.artifact}) ${q.question}`);
  }
}

async function cmdStatus(roleSlug) {
  const state = loadInterviewState(roleSlug);
  if (!state) { console.log(`No interview state for ${roleSlug}`); return; }
  const total = state.questions?.length || 0;
  const answered = Object.keys(state.answers || {}).filter(k => state.answers[k]).length;
  console.log(`${roleSlug}: ${answered}/${total} answered`);
  for (const q of state.questions || []) {
    const mark = state.answers?.[q.id] ? '✓' : '·';
    console.log(`  ${mark} [${q.id}] (${q.artifact}) ${q.question}`);
  }
  if (state.apply_log?.length) {
    console.log('apply log:');
    for (const e of state.apply_log) console.log(`  ${e.timestamp_iso} — ${e.artifact}: ${e.action}`);
  }
}

async function cmdApply(roleSlug, dryRun) {
  const state = loadInterviewState(roleSlug);
  if (!state) { console.error(`No interview state for ${roleSlug}`); process.exit(1); }
  const applyPack = loadApplyPack(roleSlug);
  if (!applyPack) { console.error(`No apply-pack/${roleSlug}/`); process.exit(1); }

  const groups = groupAnswersByArtifact(state);
  const targets = Object.keys(groups);
  if (targets.length === 0) {
    console.log(`[apply] no answered questions yet — nothing to revise`);
    return;
  }

  let totalCost = 0;
  const log = [...(state.apply_log || [])];
  for (const artifactName of targets) {
    const artifact = applyPack[artifactName];
    if (!artifact) {
      log.push({ timestamp_iso: new Date().toISOString(), artifact: artifactName, action: 'skipped:missing-from-applypack' });
      continue;
    }
    const result = await reviseArtifact({
      role: state.role,
      artifactName,
      currentContent: artifact.content,
      qa: groups[artifactName],
      dryRun,
    });
    if (result.error) {
      console.error(`[apply] ${artifactName}: ${result.error}`);
      log.push({ timestamp_iso: new Date().toISOString(), artifact: artifactName, action: `error:${result.error}` });
      continue;
    }
    totalCost += result.cost_usd || 0;
    if (dryRun) {
      console.log(`[apply] ${artifactName} (DRY RUN) — prompt ${result.prompt.length} chars`);
      log.push({ timestamp_iso: new Date().toISOString(), artifact: artifactName, action: 'dry-run' });
    } else {
      writeFileSync(artifact.path, result.revised, 'utf8');
      log.push({ timestamp_iso: new Date().toISOString(), artifact: artifactName, action: 'revised', cost_usd: result.cost_usd });
      console.log(`[apply] ${artifactName} revised → ${artifact.path} ($${(result.cost_usd || 0).toFixed(4)})`);
    }
  }

  state.apply_log = log;
  state.last_applied_at = new Date().toISOString();
  state.total_apply_cost_usd = (state.total_apply_cost_usd || 0) + totalCost;
  saveInterviewState(roleSlug, state);
  console.log(`[apply] total cost this run: $${totalCost.toFixed(4)}`);
}

async function main() {
  const args = parseArgs();
  if (!args.cmd) {
    console.error('No command. Use --plan SLUG, --apply SLUG, or --status SLUG');
    process.exit(1);
  }
  if (!args.roleSlug) {
    console.error('Missing ROLE_SLUG');
    process.exit(1);
  }
  if (args.cmd === 'plan')   await cmdPlan(args.roleSlug, args.dryRun);
  else if (args.cmd === 'status') await cmdStatus(args.roleSlug);
  else if (args.cmd === 'apply')  await cmdApply(args.roleSlug, args.dryRun);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[apply-pack-interview] FATAL:', err.message);
    process.exit(1);
  });
}
