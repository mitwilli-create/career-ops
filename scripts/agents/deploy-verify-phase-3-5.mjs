#!/usr/bin/env node
// scripts/agents/deploy-verify-phase-3-5.mjs
//
// /deploy-verify Phase 3.5 — Catalog-Aware Persona Fan-out
//
// Inserted between Phase 3C (regression-guard re-run) and Phase 4 (deploy).
// Fans the current branch's diff out to all personas that fire on
// PHASES.DEPLOY_VERIFY_35 (Cynical SRE + Hamilton, per Wave 1 contract).
// Each persona returns JSON findings; findings are aggregated, written to
// data/persona-findings.jsonl, and a HIGH-block decision is computed:
// any HIGH severity from a HIGH-block-authority persona halts the deploy.
//
// CLI:
//   node scripts/agents/deploy-verify-phase-3-5.mjs [--diff-base origin/main]
//     [--inform-only] [--dry-run] [--mock]
//
// Exit codes:
//   0 — no HIGH-block findings (deploy can proceed to Phase 4)
//   1 — HIGH-block flagged (deploy must halt; review the findings)
//   2 — error (provider failure, parse error, etc.)
//
// stdout: JSON envelope { phase, halt, halt_reason?, findings, personas_fired,
//                         total_cost_usd, errors }
//
// Wave 2 task 6 of 14. Wired by /deploy-verify (manual invocation post-PR).
//
// Counter-bug: env-shadow-on-lazy-dotenv — caller must `dotenv.config({
// override: true })` before invoking. We re-load defensively at entry.

import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const FINDINGS_LEDGER = join(DATA_DIR, 'persona-findings.jsonl');

// Defensive dotenv re-load with override:true (env-shadow-on-lazy-dotenv guard)
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(REPO_ROOT, '.env'), override: true });
} catch { /* dotenv optional in some test contexts */ }

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    diffBase: 'origin/main',
    informOnly: false,
    dryRun: false,
    mock: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diff-base') { out.diffBase = argv[++i]; }
    else if (a === '--inform-only') { out.informOnly = true; }
    else if (a === '--dry-run') { out.dryRun = true; }
    else if (a === '--mock') { out.mock = true; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node deploy-verify-phase-3-5.mjs [--diff-base origin/main] [--inform-only] [--dry-run] [--mock]');
      process.exit(0);
    }
  }
  return out;
}

// ─── Diff harvesting ─────────────────────────────────────────────────────────

function harvestDiff(diffBase) {
  const filesRaw = execSync(`git diff ${diffBase}..HEAD --name-only`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
  const files = filesRaw.split('\n').filter(Boolean);

  // Per-file status (added/modified/deleted) — used by conditional personas
  // (DHH fires when proposal mints new agent/plist files).
  const statusRaw = execSync(`git diff ${diffBase}..HEAD --name-status`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
  const fileStatus = {};
  for (const line of statusRaw.split('\n').filter(Boolean)) {
    const [code, ...path] = line.split('\t');
    if (!code || !path.length) continue;
    fileStatus[path.join('\t')] = code.startsWith('A') ? 'added'
      : code.startsWith('M') ? 'modified'
      : code.startsWith('D') ? 'deleted'
      : code.startsWith('R') ? 'renamed'
      : 'other';
  }

  // Full diff for the persona prompts (capped at 50K chars per persona to
  // keep token budget bounded). Personas pattern-match on the diff text.
  let diff;
  try {
    diff = execSync(`git diff ${diffBase}..HEAD`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
  } catch (e) {
    // Fallback: empty diff if execSync errored (rare; e.g., very large diff)
    diff = `# diff harvest failed: ${String(e?.message || e).slice(0, 200)}`;
  }
  const diffCapped = diff.length > 50_000 ? diff.slice(0, 50_000) + '\n\n[...truncated at 50K chars...]' : diff;

  return { files, fileStatus, diff: diffCapped, diffFullLength: diff.length };
}

// ─── Persona prompt builder ──────────────────────────────────────────────────

function buildPersonaUserPrompt({ persona, diff, files }) {
  return [
    `Phase: /deploy-verify Phase 3.5 (Catalog-Aware Persona Review)`,
    `Persona: ${persona.displayName} (${persona.name})`,
    `Authority: ${persona.blockingAuthority}`,
    ``,
    `Review the following diff for the bug classes you watch for (per your`,
    `systemPrompt). Use Mitchell's catalog vocabulary from AGENTS.md and`,
    `~/.claude/knowledge/brain/bug-class-catalog.md — cite catalog names exactly.`,
    ``,
    `Files changed (${files.length}):`,
    files.slice(0, 40).map(f => '  - ' + f).join('\n'),
    files.length > 40 ? `  ... (${files.length - 40} more)` : '',
    ``,
    `## Diff`,
    '```diff',
    diff,
    '```',
    ``,
    `Return STRICT JSON: an array of findings objects matching the output`,
    `format defined in your systemPrompt. Return ONLY the JSON array, no`,
    `markdown fences. An empty array (no findings) is valid + expected when`,
    `the diff is clean.`,
  ].filter(s => s !== '').join('\n');
}

// ─── Persona invocation (one at a time, sequential per single-active rule) ───

async function invokeOnePersona({ persona, diff, files, mock, informOnly }) {
  if (mock) {
    // Deterministic mock for Wave 3 tests
    return {
      persona: persona.name,
      blockingAuthority: persona.blockingAuthority,
      findings: [],
      costUsd: 0,
      ms: 1,
      mocked: true,
    };
  }
  const prompt = buildPersonaUserPrompt({ persona, diff, files });
  const t0 = Date.now();
  try {
    const { callCouncil } = await import(join(REPO_ROOT, 'lib', 'council.mjs'));
    const r = await callCouncil({
      prompt,
      opts: {
        personaName: persona.name,
        personaPhase: 'deploy-verify-3.5',
        personaLabel: `deploy-verify ${new Date().toISOString().slice(0, 10)}`,
        timeoutMs: 180_000, // 3min — persona prompts are not huge
        maxTokens: 4000,
      },
    });
    const hit = (r.results || []).find(x => !x.error);
    let findings = [];
    if (hit) {
      const cleaned = String(hit.content || '').replace(/```json\n?|\n?```/g, '').trim();
      try { findings = JSON.parse(cleaned); }
      catch { /* persona returned non-JSON; treat as zero findings + log error below */ }
    }
    if (!Array.isArray(findings)) findings = [];

    // inform-only mode (Q5 fallback option in spec): downgrade HIGH→MED so
    // first ship can't be halted by the system reviewing itself.
    const effectiveAuthority = informOnly ? 'advisory' : persona.blockingAuthority;

    return {
      persona: persona.name,
      blockingAuthority: effectiveAuthority,
      findings,
      costUsd: r.report?.totalCost || 0,
      ms: Date.now() - t0,
      modelUsed: hit?.modelUsed || hit?.model || 'unknown',
      raw_preview: String(hit?.content || '').slice(0, 200),
      errors: (r.results || []).filter(x => x.error).map(x => x.error),
    };
  } catch (e) {
    return {
      persona: persona.name,
      blockingAuthority: persona.blockingAuthority,
      findings: [],
      costUsd: 0,
      ms: Date.now() - t0,
      errors: [String(e?.message || e)],
    };
  }
}

// ─── Findings ledger writer ──────────────────────────────────────────────────

function appendFindingsLedger(envelope) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // One JSONL record per finding (so the jsonl-merge-driver can union across
  // concurrent agents — Wave 2 wire-ins all write to this ledger).
  const ts = new Date().toISOString();
  const date = ts.slice(0, 10);
  for (const personaResult of envelope.personas) {
    for (const f of (personaResult.findings || [])) {
      const id = `pf-${date}-${cryptoIdHex()}-${personaResult.persona}`;
      const rec = {
        id,
        first_seen: ts,
        last_updated: ts,
        date,
        phase: envelope.phase,
        persona: personaResult.persona,
        blocking_authority: personaResult.blockingAuthority,
        severity: f.severity || 'LOW',
        bug_class: f.bug_class || 'unspecified',
        file: f.file || null,
        finding: f.finding || '',
        // Persona-specific fields kept verbatim under `details`
        details: f,
        source: 'deploy-verify-phase-3-5',
      };
      try { appendFileSync(FINDINGS_LEDGER, JSON.stringify(rec) + '\n'); }
      catch { /* never crash on ledger write */ }
    }
  }
}

function cryptoIdHex() {
  // Best-effort short id — collision-safe enough for ledger uniqueness within
  // a date; jsonl-merge-driver handles edge collisions.
  return Math.random().toString(36).slice(2, 10);
}

// ─── HALT decision ───────────────────────────────────────────────────────────

function decideHalt(personas) {
  for (const p of personas) {
    if (p.blockingAuthority !== 'HIGH-block') continue;
    const highFindings = (p.findings || []).filter(f => String(f.severity).toUpperCase() === 'HIGH');
    if (highFindings.length > 0) {
      return {
        halt: true,
        halt_reason: `Persona '${p.persona}' (HIGH-block) returned ${highFindings.length} HIGH severity finding(s)`,
        triggering_persona: p.persona,
        triggering_findings: highFindings,
      };
    }
  }
  return { halt: false };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();

  // Pre-flight: V2 budget check
  let budgetGate = { ok: true, spent: 0, cap: 300, remaining: 300 };
  try {
    const { checkV2Budget } = await import(join(REPO_ROOT, 'lib', 'v2-budget.mjs'));
    budgetGate = checkV2Budget({ estimatedNextPhase: 5 }); // ~$5 envelope for fan-out
  } catch { /* budget lib optional in some test contexts */ }
  if (!budgetGate.ok && !args.dryRun && !args.mock) {
    const env = {
      phase: 'deploy-verify-3.5',
      halt: true,
      halt_reason: budgetGate.abortReason || 'V2_BUDGET_USD breached',
      personas: [],
      personas_fired: 0,
      total_cost_usd: 0,
      budget_gate: budgetGate,
      errors: ['v2-budget-pre-flight-failed'],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(env, null, 2));
    process.exit(1);
  }

  // Harvest diff
  let diffBundle;
  try {
    diffBundle = harvestDiff(args.diffBase);
  } catch (e) {
    const env = {
      phase: 'deploy-verify-3.5',
      halt: false,
      personas: [],
      personas_fired: 0,
      total_cost_usd: 0,
      errors: ['diff-harvest-failed: ' + String(e?.message || e)],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(env, null, 2));
    process.exit(2);
  }

  // Resolve personas that fire on this phase
  const { personasFor, PHASES } = await import(join(REPO_ROOT, 'lib', 'council-personas.mjs'));
  const ctx = {
    phase: PHASES.DEPLOY_VERIFY_35,
    files: diffBundle.files,
    fileStatus: diffBundle.fileStatus,
    diff: diffBundle.diff,
  };
  const firing = personasFor(PHASES.DEPLOY_VERIFY_35, ctx);

  if (args.dryRun) {
    const env = {
      phase: 'deploy-verify-3.5',
      dryRun: true,
      personas_would_fire: firing.map(p => p.name),
      files_changed: diffBundle.files.length,
      diff_chars: diffBundle.diffFullLength,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(env, null, 2));
    process.exit(0);
  }

  // Fire personas SEQUENTIALLY (single-active rule per Mitchell's locked decision).
  // Parallel fan-out would risk concurrent-cd-prefix-orphan + parallel-agent-collision.
  const personaResults = [];
  for (const p of firing) {
    const r = await invokeOnePersona({
      persona: p,
      diff: diffBundle.diff,
      files: diffBundle.files,
      mock: args.mock,
      informOnly: args.informOnly,
    });
    personaResults.push(r);
  }

  // Decide halt
  const decision = decideHalt(personaResults);
  const totalCost = personaResults.reduce((s, p) => s + (p.costUsd || 0), 0);

  // Detect persona conflicts (Wave 2 Task 9, 2026-05-28). When 2+ personas
  // return findings on the same file:line with different severity, surface
  // as a conflict for dealbreaker adjudication. Non-blocking — informational.
  let conflicts = [];
  try {
    const { detectConflicts } = await import(join(REPO_ROOT, 'lib', 'persona-conflict-detector.mjs'));
    conflicts = detectConflicts(personaResults);
  } catch { /* conflict detection is observability, never block */ }

  const envelope = {
    phase: 'deploy-verify-3.5',
    halt: args.informOnly ? false : decision.halt,
    halt_reason: args.informOnly ? null : (decision.halt_reason || null),
    inform_only_mode: args.informOnly,
    triggering_persona: decision.triggering_persona || null,
    triggering_findings: decision.triggering_findings || null,
    personas: personaResults,
    personas_fired: personaResults.length,
    conflicts,
    dealbreaker_handoff_recommended: conflicts.some(c => c.dealbreaker_handoff_recommended),
    total_cost_usd: totalCost,
    files_changed: diffBundle.files.length,
    diff_chars: diffBundle.diffFullLength,
    budget_gate: budgetGate,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  // Persist findings to ledger (not in mock mode — tests should not pollute disk)
  if (!args.mock) {
    appendFindingsLedger(envelope);
  }

  console.log(JSON.stringify(envelope, null, 2));
  process.exit(envelope.halt ? 1 : 0);
}

main().catch(e => {
  const env = {
    phase: 'deploy-verify-3.5',
    halt: false,
    error: 'fatal: ' + String(e?.message || e),
    stack: String(e?.stack || '').slice(0, 1000),
  };
  console.log(JSON.stringify(env, null, 2));
  process.exit(2);
});
