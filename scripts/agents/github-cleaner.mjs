#!/usr/bin/env node
/**
 * scripts/agents/github-cleaner.mjs — GitHub hiring-readiness cleanup agent.
 *
 * Audits ANY or ALL of Mitchell's GitHub repos at mitwilli-create + every
 * profile surface (profile README, bio, pinned repos), through an aggressive
 * hiring-manager + recruiter lens for his target roles, AND self-implements
 * the recommendations via PR. The agent is NOT scoped to a single project —
 * default is every owned repo; --repo / --repos / --cwd-repo / --repo-filter
 * narrow when needed. Voice + detector gates protect every artifact before
 * it ships.
 *
 * Extends the existing /github-readiness agent (which produces a gap analysis
 * but doesn't self-implement). The cheap (cached-rubric) path is suitable for
 * nightly + post-push triggers; the expensive (full council) path runs monthly
 * or on --force-research.
 *
 * Design: data/github-cleaner-design-2026-05-22.md
 *
 * STATUS: SKELETON — orchestrator wired up, lib/github-cleaner/* stubs throw
 * NOT_IMPLEMENTED for the heavy work pending the full build pass.
 *
 * CLI:
 *   node scripts/agents/github-cleaner.mjs --dry-run
 *   node scripts/agents/github-cleaner.mjs --apply
 *   node scripts/agents/github-cleaner.mjs --apply --force-research
 *   node scripts/agents/github-cleaner.mjs --apply --pre-apply 048-anthropic-comms-lead
 *   node scripts/agents/github-cleaner.mjs --apply --confirm-make-public <repo>
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const { config } = await import('dotenv');
  config({
    path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'),
    override: true,
  });
} catch { /* dotenv optional */ }

import { installRunRecord } from '../../lib/job-runs-ledger.mjs';

import { buildInventory } from '../../lib/github-cleaner/inventory.mjs';
import { loadKB, appendRun as kbAppendRun, annotateInventoryWithKB } from '../../lib/github-cleaner/kb.mjs';
import {
  getCachedRubric,
  computeProfileSha,
  refreshRubric,
  RUBRIC_CACHE_PATH,
} from '../../lib/github-cleaner/rubric-cache.mjs';
import { runAudit, shouldShortCircuit, persistAudit } from '../../lib/github-cleaner/audit.mjs';
import { generateArtifact } from '../../lib/github-cleaner/generate.mjs';
import { runGate, MAX_GATE_CYCLES } from '../../lib/github-cleaner/gate.mjs';
import { implementArtifact } from '../../lib/github-cleaner/implement.mjs';
import { runVerification, printVerbalSummary } from '../../lib/github-cleaner/verify.mjs';
import {
  preCheck as budgetPreCheck,
  recordSpend,
  monthlySpendSoFar,
  DEFAULT_RUN_CAP_USD,
  DEFAULT_MONTHLY_CAP_USD,
} from '../../lib/github-cleaner/budget.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const __jobRun = installRunRecord('github-cleaner');

/* ──────────────────────── CLI parsing ──────────────────────── */

function parseArgs(argv) {
  const args = argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f, fb) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : fb;
  };
  return {
    dryRun: has('--dry-run'),
    apply: has('--apply'),
    forceResearch: has('--force-research'),
    skipResearch: has('--skip-research'),
    preApplySlug: val('--pre-apply', null),
    councilSubset: val('--council-subset', null),
    targetRepos: resolveTargetReposSpec(args, val, has),
    runCapUsd: Number(val('--run-cap-usd', DEFAULT_RUN_CAP_USD)),
    monthlyCapUsd: Number(val('--monthly-cap-usd', DEFAULT_MONTHLY_CAP_USD)),
    confirmFlags: {
      confirm_identity_change: has('--confirm-identity-change'),
      ...parseConfirmFlags(args),
    },
    handle: val('--handle', 'mitwilli-create'),
    verbose: has('--verbose') || has('-v'),
    // 2026-05-26 forward-port — Mitchell's locked-decision aliases.
    // These are no-op flags that simply allow the documented invocation
    // command in /github-readiness +  /github-cleaner spec language to
    // parse without erroring. The behavior they describe is already the
    // default in this orchestrator (aggressive=all repos, unified-lens
    // weights tuned in config/github-cleaner-personas.yml, auto-profile
    // requires no draft pause).
    //   --aggressive    — alias; orchestrator default is already 'all' scope
    //   --unified-lens  — alias; lens balance is set in personas.yml verticals
    //   --auto-profile  — alias; profile changes auto-apply unless
    //                     --confirm-identity-change gate is needed
    aggressive: has('--aggressive'),
    unifiedLens: has('--unified-lens'),
    autoProfile: has('--auto-profile'),
  };
}

/**
 * Resolve the targetRepos config from CLI flags.
 *
 * Precedence (first match wins): --repo > --repos > --cwd-repo > --repo-filter > 'all'.
 * See data/github-cleaner-design-2026-05-22.md § Phase 1 for the spec.
 */
function resolveTargetReposSpec(args, val, has) {
  const single = val('--repo', null);
  if (single) return single;
  const multi = val('--repos', null);
  if (multi) return multi.split(',').map(s => s.trim()).filter(Boolean);
  if (has('--cwd-repo')) return 'cwd';
  const filter = val('--repo-filter', null);
  if (filter) {
    // Bound the regex source — defense against catastrophic-backtracking input
    // (CodeQL js/regex-injection — addressed via length cap + safe-char allowlist).
    // The github-cleaner is operator-invoked, but the regex still walks every owned
    // repo name so a pathological pattern could ReDoS the scan loop.
    if (filter.length > 200) {
      throw new Error(`--repo-filter regex too long (${filter.length} chars, max 200). Tighten the pattern.`);
    }
    // Reject patterns containing nested quantifiers and other catastrophic-backtrack
    // signatures. Allowlist-style — only common regex metacharacters + alnum + hyphen +
    // underscore are permitted. Matches what GitHub repo slugs can contain anyway.
    const SAFE_REGEX_PATTERN = /^[A-Za-z0-9_\-./^$|()?*+\[\]{},\s]+$/;
    if (!SAFE_REGEX_PATTERN.test(filter)) {
      throw new Error(`--repo-filter contains characters outside the safe-regex allowlist (alphanumeric, _-./^$|()?*+[]{},). Tighten the pattern.`);
    }
    try { return { include: new RegExp(filter) }; }
    catch (e) { throw new Error(`Invalid --repo-filter regex: ${filter} (${e.message})`); }
  }
  return 'all';
}

function parseConfirmFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm-make-public') flags[`confirm_make_public_${args[i + 1]}`] = true;
    if (args[i] === '--confirm-popular-repo') flags[`confirm_popular_repo_${args[i + 1]}`] = true;
  }
  return flags;
}

/* ──────────────────────── Heartbeat ──────────────────────── */

function emit(obj) {
  try {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* */ }
}

/** Render the targetRepos spec into a short label for the heartbeat log. */
function describeTargetRepos(spec) {
  if (spec === 'all' || spec == null) return 'all owned repos';
  if (spec === 'cwd') return 'cwd-repo (git remote of $PWD)';
  if (typeof spec === 'string') return `single:${spec}`;
  if (Array.isArray(spec)) return `multi:[${spec.join(',')}]`;
  if (spec && typeof spec === 'object' && spec.include instanceof RegExp) return `regex:${spec.include.source}`;
  return `unknown:${JSON.stringify(spec)}`;
}

/* ──────────────────────── Run-dir setup ──────────────────────── */

function makeRunDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(ROOT, 'data', 'github-cleaner', ts);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  mkdirSync(join(runDir, 'drafts'), { recursive: true });
  mkdirSync(join(runDir, 'screenshots'), { recursive: true });
  return { ts, runDir };
}

/* ──────────────────────── Pre-flight ──────────────────────── */

async function preflight(opts) {
  emit({ phase: 'preflight', step: 'start' });

  // 1. gh CLI must be authed
  try {
    const { execFileSync } = await import('node:child_process');
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf-8', timeout: 10_000,
    }).trim();
    if (login !== opts.handle) {
      emit({ phase: 'preflight', error: 'gh_auth_wrong_handle', got: login, expected: opts.handle });
      throw new Error(`gh CLI authed as ${login}, expected ${opts.handle}. Run 'gh auth login' as the right user.`);
    }
    emit({ phase: 'preflight', step: 'gh_auth_ok', login });
  } catch (e) {
    emit({ phase: 'preflight', error: 'gh_auth_failed', detail: String(e.message || e) });
    throw e;
  }

  // 2. safe-gh-pr.sh exists
  const safePr = join(ROOT, 'scripts', 'safe-gh-pr.sh');
  if (!existsSync(safePr)) {
    throw new Error(`scripts/safe-gh-pr.sh not found — required for cross-fork-safe PRs. Abort.`);
  }
  emit({ phase: 'preflight', step: 'safe_pr_wrapper_ok' });

  // 3. Budget snapshot
  const monthly = monthlySpendSoFar();
  emit({ phase: 'preflight', step: 'budget', monthly_so_far_usd: monthly, monthly_cap_usd: opts.monthlyCapUsd });

  // 4. KB snapshot — emit history stats so the heartbeat surfaces how much
  //    prior context the cleaner is operating with.
  const kb = loadKB();
  emit({
    phase: 'preflight',
    step: 'kb',
    runs_known: kb.runs?.length || 0,
    last_run_ts: kb.runs?.length ? kb.runs[kb.runs.length - 1].ts : null,
    kb_as_of: kb.as_of,
  });

  emit({ phase: 'preflight', step: 'done' });
}

/* ──────────────────────── Main pipeline ──────────────────────── */

export async function runGithubCleaner(opts = {}) {
  const t0 = Date.now();
  const runId = `gc-${Date.now()}`;
  const { ts, runDir } = makeRunDir();

  emit({ phase: 'init', run_id: runId, run_dir: runDir, opts: { ...opts, confirmFlags: undefined } });

  await preflight(opts);

  /* PHASE 1 — Inventory */
  emit({ phase: 'phase1', step: 'inventory_start', target_repos: describeTargetRepos(opts.targetRepos) });
  let inventory = await buildInventory({
    handle: opts.handle,
    runDir,
    targetRepos: opts.targetRepos,
  });
  // KB annotation: each repo gets last_touched / first_audited / audit_count
  // so Phase 3 can prioritize repos the cleaner hasn't looked at in a while.
  inventory = annotateInventoryWithKB(inventory);
  emit({ phase: 'phase1', step: 'inventory_done', in_scope: inventory?.scope_summary?.in_scope_count });

  /* PHASE 2 — Rubric (cache-first) */
  emit({ phase: 'phase2', step: 'rubric_check' });
  const profileSha = computeProfileSha();
  let rubric = getCachedRubric({ profileSha, forceFresh: opts.forceResearch });
  if (rubric) {
    emit({ phase: 'phase2', step: 'rubric_cache_hit', as_of: rubric.as_of });
  } else if (opts.skipResearch) {
    emit({ phase: 'phase2', step: 'rubric_missing_skipped', warn: 'cached rubric missing; --skip-research set; cleaner will run with reduced confidence' });
    rubric = { items: [], must_haves: [], nice_to_haves: [], red_flags: [], degraded: true };
  } else {
    emit({ phase: 'phase2', step: 'rubric_refresh_start', cost_estimate_usd: 25 });
    const budgetGate = budgetPreCheck({
      runId, phase: 'rubric_refresh', estimatedCostUsd: 35,
      runCapUsd: opts.runCapUsd, monthlyCapUsd: opts.monthlyCapUsd,
    });
    if (!budgetGate.ok) {
      emit({ phase: 'phase2', step: 'budget_blocked', detail: budgetGate });
      throw new Error(`budget gate refused phase 2: ${budgetGate.reason}`);
    }
    rubric = await refreshRubric({
      profileSha, councilSubset: opts.councilSubset,
      preApplySlug: opts.preApplySlug, runId,
    });
    emit({ phase: 'phase2', step: 'rubric_refresh_done' });
  }

  /* PHASE 3 — Audit */
  emit({ phase: 'phase3', step: 'audit_start' });
  const audit = await runAudit({ inventory, rubric, runDir });
  persistAudit(audit, runDir);
  emit({ phase: 'phase3', step: 'audit_done', items: audit?.items?.length, no_work: audit?.no_work });

  if (audit?.no_work) {
    emit({ phase: 'short_circuit', reason: 'no_actionable_findings' });
    const reportPath = join(runDir, 'report.md');
    writeFileSync(reportPath, `# github-cleaner — no work\n\nNo actionable findings vs prior run.\n`, 'utf-8');
    printVerbalSummary({
      reposTouched: 0, prsMerged: 0, prsOpen: 0,
      profileUrl: `https://github.com/${opts.handle}`,
      reportPath, nextAction: 'nothing to do — repos already match the cached rubric.',
    });
    return { ok: true, no_work: true, duration_ms: Date.now() - t0, run_dir: runDir };
  }

  /* PHASES 4 + 5 — Generate, gate, implement (skipped under --dry-run) */
  const phaseResults = { generated: [], gated_pass: [], gated_fail_drafts: [], implemented: [] };
  if (opts.apply) {
    for (const rec of audit.items || []) {
      emit({ phase: 'phase4', step: 'generate', target: rec.target, kind: rec.recommendation });
      const ctx = { recommendation: rec, inventory, corpus: { /* loaded lazily by generate.mjs */ } };
      let artifact = await generateArtifact(ctx);
      recordSpend({ runId, phase: 'phase4_generate', model: 'sonnet', cost_usd: artifact?.model_cost_usd ?? 0 });

      let gateResult = null;
      for (let cycle = 1; cycle <= MAX_GATE_CYCLES; cycle++) {
        gateResult = await runGate(artifact, { runId });
        recordSpend({ runId, phase: 'phase4_gate', model: 'detectors', cost_usd: gateResult?.cost_usd ?? 0 });
        if (gateResult.pass) break;
        emit({ phase: 'phase4', step: 'gate_fail', cycle, failure_modes: gateResult.failure_modes });
        if (cycle === MAX_GATE_CYCLES) break;
        artifact = await regenerateWithRemediation({ originalArtifact: artifact, gateFailure: gateResult, ctx });
        recordSpend({ runId, phase: 'phase4_regenerate', model: 'sonnet', cost_usd: artifact?.model_cost_usd ?? 0 });
      }

      if (gateResult.pass) {
        const artifactPath = join(runDir, 'artifacts', `${rec.scope}-${rec.target}-${rec.recommendation}.md`);
        writeFileSync(artifactPath, artifact.content, 'utf-8');
        phaseResults.gated_pass.push({ rec, artifactPath });
        emit({ phase: 'phase5', step: 'implement_start', target: rec.target });
        const implResult = await implementArtifact({
          artifact, recommendation: rec,
          logPath: join(runDir, 'implement-log.jsonl'),
          confirmFlags: opts.confirmFlags,
        });
        phaseResults.implemented.push(implResult);
        emit({ phase: 'phase5', step: 'implement_done', target: rec.target, ok: implResult.ok, action: implResult.action });
      } else {
        const draftPath = join(runDir, 'drafts', `${rec.scope}-${rec.target}-${rec.recommendation}.md`);
        writeFileSync(draftPath, artifact.content, 'utf-8');
        phaseResults.gated_fail_drafts.push({ rec, draftPath, gateResult });
        emit({ phase: 'phase4', step: 'gate_skip', target: rec.target, cycles: MAX_GATE_CYCLES });
      }
    }
  } else {
    emit({ phase: 'phase4_5', step: 'skipped_dry_run' });
  }

  /* PHASE 6 — Verify + report */
  emit({ phase: 'phase6', step: 'verify_start' });
  const verification = await runVerification({
    inventory, audit, implementResults: phaseResults.implemented, runDir,
  });
  emit({ phase: 'phase6', step: 'verify_done', screenshots: verification?.screenshot_paths?.length });

  const summary = {
    ok: true,
    duration_ms: Date.now() - t0,
    run_id: runId,
    run_dir: runDir,
    repos_touched: phaseResults.implemented.length,
    prs_merged: phaseResults.implemented.filter(r => r.action === 'pr_merged').length,
    prs_open: phaseResults.implemented.filter(r => r.action === 'pr_opened').length,
    drafts: phaseResults.gated_fail_drafts.length,
    monthly_spend_usd: monthlySpendSoFar(),
  };

  // Append this run to the KB so future runs can suppress duplicate work +
  // emit the Trajectory section.
  try {
    kbAppendRun({
      run_id: runId,
      ts: new Date().toISOString(),
      run_dir: runDir,
      mode: opts.apply ? (opts.forceResearch ? 'apply+force-research' : 'apply') : 'dry-run',
      scope: { target_repos: describeTargetRepos(opts.targetRepos), in_scope_count: inventory?.scope_summary?.in_scope_count },
      rubric_sha: rubric?.identity_sha || rubric?.profile_sha || null,
      rubric_snapshot: rubric?.degraded ? null : { must_have_count: rubric?.must_haves?.length || 0, red_flag_count: rubric?.red_flags?.length || 0 },
      audit_summary: audit ? { items_count: audit?.items?.length || 0, no_work: !!audit?.no_work } : null,
      implementations: phaseResults.implemented,
      gate_results: phaseResults.gated_pass.concat(phaseResults.gated_fail_drafts).map(r => ({
        artifact: r.artifactPath || r.draftPath, pass: !!r.artifactPath, gate_result: r.gateResult || null,
      })),
      spend_usd: monthlySpendSoFar() - (Number(process.env.__GC_SPEND_BEFORE) || 0),
    });
    emit({ phase: 'kb', step: 'run_appended', kb_path: 'data/github-cleaner/kb-index.json' });
  } catch (kbErr) {
    emit({ phase: 'kb', step: 'append_failed', error: String(kbErr.message || kbErr) });
  }

  printVerbalSummary({
    reposTouched: summary.repos_touched,
    prsMerged: summary.prs_merged,
    prsOpen: summary.prs_open,
    profileUrl: `https://github.com/${opts.handle}`,
    reportPath: join(runDir, 'report.md'),
    nextAction: summary.prs_open > 0
      ? `review the ${summary.prs_open} open PRs and merge or close.`
      : `open ${`https://github.com/${opts.handle}`} in incognito to see what a recruiter sees fresh.`,
  });

  emit({ phase: 'complete', ...summary });
  return summary;
}

// regenerateWithRemediation lives in generate.mjs; the orchestrator
// references it through the import shape below.
async function regenerateWithRemediation(args) {
  const { regenerateWithRemediation: fn } = await import('../../lib/github-cleaner/generate.mjs');
  return fn(args);
}

/* ──────────────────────── CLI entry ──────────────────────── */

async function cliMain() {
  const opts = parseArgs(process.argv);

  if (!opts.dryRun && !opts.apply) {
    process.stderr.write([
      'Usage:',
      '  node scripts/agents/github-cleaner.mjs --dry-run',
      '  node scripts/agents/github-cleaner.mjs --apply [--force-research]',
      '  node scripts/agents/github-cleaner.mjs --apply --repo <owner/repo>',
      '  node scripts/agents/github-cleaner.mjs --apply --repos r1,r2,r3',
      '  node scripts/agents/github-cleaner.mjs --apply --cwd-repo',
      '  node scripts/agents/github-cleaner.mjs --apply --repo-filter <regex>',
      '  node scripts/agents/github-cleaner.mjs --apply --pre-apply <slug>',
      '',
      'Default scope: ALL Mitchell\'s repos + profile. Council research is cached',
      '30 days; KB layer suppresses duplicate work. See',
      'data/github-cleaner-design-2026-05-22.md for the full design.',
      '',
    ].join('\n'));
    process.exit(2);
  }

  try {
    const out = await runGithubCleaner(opts);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(out.ok ? 0 : 1);
  } catch (e) {
    emit({ phase: 'fatal', error: String(e.message || e), stack: e.stack });
    process.stderr.write(`FATAL: ${e.message || e}\n`);
    process.exit(3);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) cliMain();
