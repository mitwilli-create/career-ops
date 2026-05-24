#!/usr/bin/env node
/**
 * scripts/agents/research-chain.mjs — direct-CLI researcher → dealbreaker chain.
 *
 * Belt-and-suspenders backup for the /researcher → /dealbreaker subagent chain.
 * Invariant under harness subagent-recursion restrictions, mid-session MCP
 * disconnects, registry agent-type removals, and main-session unavailability.
 * Calls lib/council.mjs directly; no Agent-tool dispatch anywhere in the chain.
 *
 * Established 2026-05-23 alongside the handoff-file contract that decouples
 * researcher from dealbreaker (see ~/.claude/agents/researcher.md § Handoff
 * Protocol + ~/.claude/agents/dealbreaker.md § Step 0.A).
 *
 * USAGE
 *   node scripts/agents/research-chain.mjs --question "..." [--ceiling-usd 5] [--no-dealbreaker]
 *
 * OUTPUTS
 *   ~/.claude/agents/runs/researcher-report-<ts>.md       (Phase B)
 *   ~/.claude/agents/runs/_handoffs/dealbreaker-<ts>-<hex>.json   (Phase C)
 *   ~/.claude/agents/runs/dealbreaker-final-<ts>.md       (Phase E, unless --no-dealbreaker)
 *
 * NDJSON heartbeat to stderr every phase per the hang-prevention pattern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { recordRun } from '../../lib/run-metrics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

const HANDOFF_DIR = join(homedir(), '.claude', 'agents', 'runs', '_handoffs');
const RUNS_DIR = join(homedir(), '.claude', 'agents', 'runs');

function heartbeat(phase, extra = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), agent: 'research-chain', phase, ...extra });
  process.stderr.write(line + '\n');
}

function parseArgs(argv) {
  const args = { question: '', ceilingUsd: 5, noDealbreaker: false, model: 'anthropic:claude-haiku-4-5' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--question' || a === '-q') args.question = argv[++i] || '';
    else if (a === '--ceiling-usd') args.ceilingUsd = Number(argv[++i] || 5);
    else if (a === '--no-dealbreaker') args.noDealbreaker = true;
    else if (a === '--model') args.model = argv[++i] || args.model;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: research-chain.mjs --question "..." [--ceiling-usd 5] [--no-dealbreaker] [--model anthropic:claude-haiku-4-5]');
      console.log('  Default model: anthropic:claude-haiku-4-5 (cheapest single-model chain).');
      console.log('  Other valid slots: anthropic:claude-sonnet-4-6, anthropic:claude-opus-4-7.');
      process.exit(0);
    }
  }
  if (!args.question.trim()) {
    console.error('ERROR: --question is required');
    process.exit(2);
  }
  return args;
}

function tsCompact() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}-${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}`;
}

function hex8() {
  return randomBytes(4).toString('hex');
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function runResearcher({ question, model }) {
  heartbeat('researcher-start', { model, question_len: question.length });
  const { callCouncil } = await import(join(ROOT, 'lib', 'council.mjs'));
  const prompt = [
    `You are a single-model researcher running in direct-CLI mode (no KB lookup, no subagent dialogue).`,
    `Produce a researcher report for the following question. Output ONLY the markdown report body — no preamble.`,
    ``,
    `Required sections in order:`,
    `1. ## Task — restate the question`,
    `2. ## Synthesized Answer — 3-6 paragraphs, direct + grounded`,
    `3. ## Unresolved Impasses — bullet list, slug-style IDs (e.g. impasse-foo-bar), one-line description each. Empty list if none.`,
    `4. ## Handoff to Dealbreaker — confidence: high|medium|low; cite anything load-bearing you couldn't verify`,
    ``,
    `Research question:`,
    question,
  ].join('\n');

  const res = await callCouncil({
    prompt,
    models: [model],
    opts: { timeoutMs: 180_000, maxTokens: 8000 },
  });
  if (res?.missingKeys?.length) {
    throw new Error(`researcher cannot fire — missing env keys: ${res.missingKeys.map(m => `${m.model} needs ${m.missingEnvVar}`).join(', ')}`);
  }
  const results = res?.results || [];
  if (!results.length) {
    throw new Error('researcher returned empty council response');
  }
  const r = results.find(x => x.ok || x.content) || results[0];
  if (!r) throw new Error('researcher returned no usable result');
  if (r.error && !r.content) throw new Error(`researcher failed: ${r.error}`);
  const body = (r.content || '').trim();
  if (!body.includes('## Synthesized Answer')) {
    throw new Error(`researcher output missing required sections (got ${body.length} chars). First 200: ${body.slice(0, 200)}`);
  }
  heartbeat('researcher-done', { chars: body.length, cost_usd: r.costUsd ?? null });
  try { recordRun({ agent: 'research-chain', stage: 'researcher', costUsd: r.costUsd ?? 0, status: 'success', model: r.modelUsed || r.model || model }); } catch {}
  return { body, costUsd: r.costUsd ?? 0, model: r.modelUsed || r.model || model };
}

function writeResearcherReport({ question, body, model, ts }) {
  const reportPath = join(RUNS_DIR, `researcher-report-${ts}.md`);
  const frontmatter = [
    '---',
    'agent: researcher',
    `mode: direct-cli`,
    `model: ${model}`,
    `timestamp: ${new Date().toISOString()}`,
    '---',
    '',
    `# Researcher Report (direct-CLI chain) — ${question.slice(0, 80)}${question.length > 80 ? '…' : ''}`,
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(reportPath, frontmatter);
  return reportPath;
}

function extractImpassesFromBody(body) {
  const m = body.match(/##\s+Unresolved Impasses\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!m) return [];
  const section = m[1].trim();
  if (/^(\s*[-*]\s*)?none\b/i.test(section) || section === '') return [];
  const items = [];
  for (const line of section.split('\n')) {
    const lm = line.match(/^\s*[-*]\s+(?:\*\*)?([\w-]+?)(?:\*\*)?\s*[—:-]\s*(.+?)\s*$/);
    if (lm) items.push({ id: lm[1], description: lm[2] });
  }
  return items;
}

function writeHandoff({ reportPath, question, ceilingUsd, noDealbreaker, audit_items, ts }) {
  ensureDir(HANDOFF_DIR);
  const hex = hex8();
  const handoffPath = join(HANDOFF_DIR, `dealbreaker-${ts}-${hex}.json`);
  const envelope = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    source_agent: 'research-chain',
    target_agent: 'dealbreaker',
    report_path: reportPath,
    audit_items,
    ceiling_usd: ceilingUsd,
    mode: noDealbreaker ? 'impasse-breaking-deferred' : 'impasse-breaking',
    context_paths: [],
    original_question: question.slice(0, 500),
    status: 'pending',
    dispatched_at: null,
    completed_at: null,
    result_path: null,
  };
  writeFileSync(handoffPath, JSON.stringify(envelope, null, 2) + '\n');
  return { handoffPath, envelope };
}

async function runDealbreaker({ handoffPath, reportPath, ceilingUsd, model }) {
  heartbeat('dealbreaker-start', { ceiling_usd: ceilingUsd, model });
  const { callCouncil } = await import(join(ROOT, 'lib', 'council.mjs'));
  const reportContent = readFileSync(reportPath, 'utf8');
  const prompt = [
    `You are a dealbreaker running in direct-CLI mode. Adjudicate the following research report.`,
    `Budget: $${ceilingUsd} (no actual WebSearch — base on report content + your training).`,
    ``,
    `Workflow:`,
    `1. Read the report's ## Synthesized Answer and ## Unresolved Impasses.`,
    `2. For each impasse, mark BROKEN (with rationale) / UNDECIDABLE / DISMISSED.`,
    `3. Re-write or validate the synthesis lead (1-3 paragraphs).`,
    `4. Output ONLY the markdown report body — no preamble. Standard sections:`,
    `   ## Headline (one sentence)`,
    `   ## Executive synthesis (1-3 paragraphs)`,
    `   ## Impasse verdicts (table or bullets)`,
    `   ## Confidence (high|medium|low) + one-line rationale`,
    ``,
    `Research report:`,
    `---`,
    reportContent,
    `---`,
  ].join('\n');
  const res = await callCouncil({
    prompt,
    models: [model],
    opts: { timeoutMs: 180_000, maxTokens: 6000 },
  });
  if (res?.missingKeys?.length) {
    throw new Error(`dealbreaker cannot fire — missing env keys: ${res.missingKeys.map(m => `${m.model} needs ${m.missingEnvVar}`).join(', ')}`);
  }
  const results = res?.results || [];
  const r = results.find(x => x.ok || x.content) || results[0];
  if (!r) throw new Error('dealbreaker returned no usable result');
  if (r.error && !r.content) throw new Error(`dealbreaker failed: ${r.error}`);
  const body = (r.content || '').trim();
  heartbeat('dealbreaker-done', { chars: body.length, cost_usd: r.costUsd ?? null });
  return { body, costUsd: r.costUsd ?? 0, model: r.modelUsed || r.model || model };
}

function writeDealbreakerReport({ body, model, sourceReportPath, handoffPath, ts }) {
  const resultPath = join(RUNS_DIR, `dealbreaker-final-${ts}.md`);
  const frontmatter = [
    '---',
    'agent: dealbreaker',
    `mode: impasse-breaking`,
    `dispatch: direct-cli`,
    `model: ${model}`,
    `input_report: ${sourceReportPath}`,
    `handoff_envelope: ${handoffPath}`,
    `timestamp: ${new Date().toISOString()}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(resultPath, frontmatter);
  return resultPath;
}

function patchHandoff({ handoffPath, status, extra = {} }) {
  const h = JSON.parse(readFileSync(handoffPath, 'utf8'));
  h.status = status;
  for (const [k, v] of Object.entries(extra)) h[k] = v;
  writeFileSync(handoffPath, JSON.stringify(h, null, 2) + '\n');
  return h;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ts = tsCompact();
  heartbeat('chain-start', { ceiling_usd: args.ceilingUsd, no_dealbreaker: args.noDealbreaker });

  ensureDir(RUNS_DIR);
  ensureDir(HANDOFF_DIR);

  // Phase A + B — researcher
  const researcher = await runResearcher({ question: args.question, model: args.model });
  const reportPath = writeResearcherReport({ question: args.question, body: researcher.body, model: researcher.model, ts });
  console.error(`Researcher report: ${reportPath}`);

  // Phase C — handoff envelope
  const audit_items = extractImpassesFromBody(researcher.body);
  const { handoffPath } = writeHandoff({
    reportPath,
    question: args.question,
    ceilingUsd: args.ceilingUsd,
    noDealbreaker: args.noDealbreaker,
    audit_items,
    ts,
  });
  console.error(`Handoff envelope: ${handoffPath}`);
  console.log(`HANDOFF_WRITTEN: ${handoffPath}`);

  // Phase D — gate on --no-dealbreaker
  if (args.noDealbreaker) {
    heartbeat('chain-deferred', { handoff_path: handoffPath });
    console.error(`--no-dealbreaker set; chain ends here. Handoff at ${handoffPath} (status=pending, mode=deferred).`);
    return;
  }

  // Phase E + F — dealbreaker
  patchHandoff({ handoffPath, status: 'dispatched', extra: { dispatched_at: new Date().toISOString() } });
  const dealbreaker = await runDealbreaker({ handoffPath, reportPath, ceilingUsd: args.ceilingUsd, model: args.model });
  const resultPath = writeDealbreakerReport({
    body: dealbreaker.body,
    model: dealbreaker.model,
    sourceReportPath: reportPath,
    handoffPath,
    ts,
  });
  patchHandoff({
    handoffPath,
    status: 'completed',
    extra: { completed_at: new Date().toISOString(), result_path: resultPath },
  });
  console.error(`Dealbreaker final: ${resultPath}`);

  // Phase G — summary
  const totalCost = (researcher.costUsd || 0) + (dealbreaker.costUsd || 0);
  heartbeat('chain-done', { result_path: resultPath, total_cost_usd: totalCost });
  console.log(`\nResearch chain complete.`);
  console.log(`  Researcher: ${reportPath}`);
  console.log(`  Dealbreaker: ${resultPath}`);
  console.log(`  Handoff:    ${handoffPath}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
}

main().catch(err => {
  heartbeat('chain-error', { error: String(err?.message || err) });
  console.error(`research-chain failed: ${err?.stack || err}`);
  process.exit(1);
});
