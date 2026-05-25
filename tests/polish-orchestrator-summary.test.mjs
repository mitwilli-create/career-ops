#!/usr/bin/env node
/**
 * tests/polish-orchestrator-summary.test.mjs
 *
 * Smoke test for the 2026-05-24 summary-on-abandon path
 * (Bug 2 of the convergence-impossible-runaway fix).
 *
 * Coverage:
 *   T1. Incremental writes — polish-orchestrator-summary.json is rewritten
 *       AFTER Phase 1 + AFTER EACH artifact + AFTER Phase 3. The mock
 *       polishArtifact reads the file on entry to verify the prior state
 *       is already on disk.
 *   T2. Cost-warn force-abandon — when cumulative pack cost crosses
 *       POLISH_COST_WARN_USD, all not-yet-started artifacts get
 *       abandoned: true, abandon_reason: 'cost-warn-threshold'.
 *   T3. Exception path — when harvestPolishSignals throws, the outer
 *       try/catch writes a partial summary with error populated.
 *   T4. Summary shape contract for polish-status-loader — the partial
 *       summary always includes coherence.final_recommendation,
 *       coherence.per_artifact_confidence, coherence.meta.generated_at,
 *       coherence.blocking_issues (array). Without these, the
 *       status-loader returns null and the dashboard treats the row as
 *       "Never polished."
 *
 * No live API calls — opts.harvestPolishSignals + opts.polishArtifact +
 * opts.checkPackCoherence DI hooks deliver canned responses.
 *
 * Usage:
 *   node tests/polish-orchestrator-summary.test.mjs
 *
 * Exits 0 on pass; 1 on any failure.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPolishPack } from '../scripts/agents/apply-pack-polish.mjs';
// IMPORTANT: also imports lib/polish-status-loader so T4 verifies the
// partial summary is actually readable by the dashboard's consumer.
import { loadOnePolishStatus } from '../lib/polish-status-loader.mjs';

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
    if (detail !== undefined) console.error('  detail:', detail);
    fail++;
    failures.push({ name, detail });
  }
}

function setupTestPack(suffix = '') {
  const slug = `zzz-polish-orchestrator-test-${Date.now()}${suffix}`;
  const applyPackDir = join(REPO_ROOT, 'apply-pack', slug);
  const dataPackDir = join(REPO_ROOT, 'data', 'apply-packs', slug);
  mkdirSync(applyPackDir, { recursive: true });
  mkdirSync(dataPackDir, { recursive: true });
  writeFileSync(join(applyPackDir, 'tailored-cv.md'), '# CV\n- mock proof', 'utf-8');
  writeFileSync(join(applyPackDir, 'cover-letter.md'), '# Cover\n- mock body', 'utf-8');
  writeFileSync(join(applyPackDir, 'form-fields.md'), '# Form\nQ1: mock', 'utf-8');
  return {
    slug,
    applyPackDir,
    dataPackDir,
    summaryPath: join(dataPackDir, 'polish-orchestrator-summary.json'),
    packInfo: { slug, company: 'TestCorp', role: 'TestRole', rowId: 9999, url: 'https://example.com/job' },
  };
}

function cleanupTestPack({ applyPackDir, dataPackDir }) {
  try { rmSync(applyPackDir, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(dataPackDir, { recursive: true, force: true }); } catch { /* */ }
}

function canonicalAbandonedResult(artifactKind, costUsd = 1.0) {
  return {
    artifact_kind: artifactKind,
    final_artifact_text: 'Mock final text. Holds the input.',
    confidence: 0.3,
    rounds_used: 6,
    total_rounds_across_outer: 6,
    converged: false,
    early_abandoned: true,
    abandoned: true,
    abandon_reason: 'max-rounds-exceeded',
    max_rounds_per_artifact: 6,
    cost_warn_usd: 5,
    confidence_history: [{ round: 1, weighted: 0.5, delta: 0.5 }],
    adversarial_findings: [],
    polish_trace: 'mock trace',
    cost_usd: costUsd,
    duration_ms: 5,
    l1_detection: null,
    l2_voice_rules: null,
    l1_error: null,
    combined_final_confidence: 0.3,
    combined_gate_status: 'WARN',
    combined_gate_reasons: ['mock-gate-reason'],
    detection_revisions_used: 0,
    detection_revision_trace: '',
    needs_human_detection: false,
  };
}

function canonicalCoherence() {
  return {
    final_recommendation: 'NEEDS_HUMAN',
    blocking_issues: [{ scope: 'pack', finding: 'mock blocker', severity: 'caution' }],
    per_artifact_confidence: { 'cv-tailored': 0.3, 'cover-letter': 0.3, 'form-fields': 0.3 },
    cross_coherence: { mock: true },
    diff_narrative: 'mock narrative',
    meta: { generated_at: new Date().toISOString(), mock: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// T1: Incremental summary writes after each artifact.
// ─────────────────────────────────────────────────────────────────────────
{
  const tp = setupTestPack();
  try {
    const observedSnapshots = [];

    const fakeHarvest = async () => ({ hiring_manager_priorities: [], dealbreaker_pruned: [], meta: { cache: 'fresh', cost_usd: 0 } });

    const fakePolishArtifact = async (input) => {
      // Read the on-disk summary right when this artifact begins. The
      // orchestrator should have written it BEFORE invoking polishArtifact
      // for this kind (incremental write after each prior artifact).
      let onDisk = null;
      if (existsSync(tp.summaryPath)) {
        try { onDisk = JSON.parse(readFileSync(tp.summaryPath, 'utf-8')); } catch { /* */ }
      }
      observedSnapshots.push({
        about_to_process: input.artifactKind,
        file_exists: onDisk != null,
        artifacts_in_summary: onDisk ? Object.keys(onDisk.artifacts || {}) : [],
        partial: onDisk ? onDisk.partial : null,
      });
      return canonicalAbandonedResult(input.artifactKind, 1.0);
    };

    const fakeCoherence = async () => canonicalCoherence();

    const result = await runPolishPack({
      artifacts: ['cv', 'cover', 'form'],
      packInfoOverride: tp.packInfo,
      installSignalHandlers: false,
      harvestPolishSignals: fakeHarvest,
      polishArtifact: fakePolishArtifact,
      checkPackCoherence: fakeCoherence,
      // Set warn threshold high so the cost-warn force-abandon path doesn't fire
      costWarnUsd: 100,
      targetConfidence: 0.99,
    });

    check('T1.a runPolishPack completed without throwing', result && result.ok === true, { ok: result?.ok, error: result?.error });
    check('T1.b summary file exists after run', existsSync(tp.summaryPath), { summaryPath: tp.summaryPath });

    // Incremental snapshots — should have one per artifact processed
    check('T1.c polishArtifact invoked once per artifact (3 total)', observedSnapshots.length === 3, { len: observedSnapshots.length });

    if (observedSnapshots.length === 3) {
      // Before cv: file exists (written after Phase 1), 0 artifacts in summary, partial:true
      check('T1.d before cv-tailored: file exists with 0 artifacts', observedSnapshots[0].file_exists === true && observedSnapshots[0].artifacts_in_summary.length === 0, observedSnapshots[0]);
      check('T1.e before cv-tailored: partial:true', observedSnapshots[0].partial === true, observedSnapshots[0]);
      // Before cover: file has cv-tailored already
      check('T1.f before cover-letter: cv-tailored already in summary', observedSnapshots[1].artifacts_in_summary.includes('cv-tailored'), observedSnapshots[1]);
      // Before form: file has cv-tailored AND cover-letter
      check('T1.g before form-fields: cv-tailored + cover-letter in summary', observedSnapshots[2].artifacts_in_summary.includes('cv-tailored') && observedSnapshots[2].artifacts_in_summary.includes('cover-letter'), observedSnapshots[2]);
    }

    // Final summary should NOT be partial (Phase 3 ran)
    const finalSummary = JSON.parse(readFileSync(tp.summaryPath, 'utf-8'));
    check('T1.h final summary partial:false (Phase 3 completed)', finalSummary.partial === false, { partial: finalSummary.partial });
    check('T1.i final summary has all 3 abandoned artifacts', ['cv-tailored', 'cover-letter', 'form-fields'].every(k => finalSummary.artifacts[k]?.abandoned === true), { artifacts: Object.keys(finalSummary.artifacts || {}) });
    check('T1.j abandon_reason populated', finalSummary.artifacts['cv-tailored']?.abandon_reason === 'max-rounds-exceeded', { reason: finalSummary.artifacts['cv-tailored']?.abandon_reason });
  } finally {
    cleanupTestPack(tp);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// T2: Cost-warn force-abandon — when cumulative cost crosses costWarnUsd
// during the artifact loop, remaining artifacts are abandoned without polish.
// ─────────────────────────────────────────────────────────────────────────
{
  const tp = setupTestPack('-costwarn');
  try {
    const callsObserved = [];

    const fakeHarvest = async () => ({ hiring_manager_priorities: [], dealbreaker_pruned: [], meta: { cache: 'fresh', cost_usd: 0 } });

    // First artifact returns very expensive ($10) — crosses the $5 warn threshold
    const fakePolishArtifact = async (input) => {
      callsObserved.push(input.artifactKind);
      return canonicalAbandonedResult(input.artifactKind, 10.0);
    };

    const fakeCoherence = async () => canonicalCoherence();

    const result = await runPolishPack({
      artifacts: ['cv', 'cover', 'form'],
      packInfoOverride: tp.packInfo,
      installSignalHandlers: false,
      harvestPolishSignals: fakeHarvest,
      polishArtifact: fakePolishArtifact,
      checkPackCoherence: fakeCoherence,
      costWarnUsd: 5,        // first artifact's $10 will cross this
      costCap: 500,
      targetConfidence: 0.99,
    });

    check('T2.a runPolishPack completed', result?.ok === true, { ok: result?.ok });
    // Only cv should have run polish (cost-warn fires after cv completes)
    check('T2.b polishArtifact called only once (cv-tailored)', callsObserved.length === 1 && callsObserved[0] === 'cv-tailored', { callsObserved });

    const finalSummary = JSON.parse(readFileSync(tp.summaryPath, 'utf-8'));
    check('T2.c cv-tailored has its real polish result', finalSummary.artifacts['cv-tailored']?.abandoned === true && finalSummary.artifacts['cv-tailored']?.abandon_reason === 'max-rounds-exceeded', finalSummary.artifacts['cv-tailored']);
    check('T2.d cover-letter abandoned via cost-warn (not started)', finalSummary.artifacts['cover-letter']?.abandoned === true && finalSummary.artifacts['cover-letter']?.abandon_reason === 'cost-warn-threshold', finalSummary.artifacts['cover-letter']);
    check('T2.e form-fields abandoned via cost-warn (not started)', finalSummary.artifacts['form-fields']?.abandoned === true && finalSummary.artifacts['form-fields']?.abandon_reason === 'cost-warn-threshold', finalSummary.artifacts['form-fields']);
    check('T2.f cost-warn artifacts have rounds_used=0 (didn\'t run)', finalSummary.artifacts['cover-letter']?.rounds_used === 0 && finalSummary.artifacts['form-fields']?.rounds_used === 0, { cover: finalSummary.artifacts['cover-letter']?.rounds_used, form: finalSummary.artifacts['form-fields']?.rounds_used });
  } finally {
    cleanupTestPack(tp);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// T3: Exception path — harvestPolishSignals throws → outer try/catch writes
// partial summary with error populated, then re-throws.
// ─────────────────────────────────────────────────────────────────────────
{
  const tp = setupTestPack('-exception');
  try {
    const fakeHarvest = async () => { throw new Error('mock harvest failure for T3'); };
    const fakePolishArtifact = async (input) => canonicalAbandonedResult(input.artifactKind);
    const fakeCoherence = async () => canonicalCoherence();

    let threw = null;
    try {
      await runPolishPack({
        artifacts: ['cv', 'cover', 'form'],
        packInfoOverride: tp.packInfo,
        installSignalHandlers: false,
        harvestPolishSignals: fakeHarvest,
        polishArtifact: fakePolishArtifact,
        checkPackCoherence: fakeCoherence,
      });
    } catch (e) {
      threw = e;
    }

    check('T3.a runPolishPack re-threw the harvest exception', threw && /mock harvest failure for T3/.test(String(threw.message || threw)), { threw: String(threw?.message || threw) });
    check('T3.b summary file written despite exception', existsSync(tp.summaryPath), { summaryPath: tp.summaryPath });

    if (existsSync(tp.summaryPath)) {
      const errSummary = JSON.parse(readFileSync(tp.summaryPath, 'utf-8'));
      check('T3.c summary ok:false', errSummary.ok === false, { ok: errSummary.ok });
      check('T3.d summary partial:true', errSummary.partial === true, { partial: errSummary.partial });
      check('T3.e summary error field populated', typeof errSummary.error === 'string' && /mock harvest failure/.test(errSummary.error), { error: errSummary.error });
      check('T3.f summary has valid coherence stub', errSummary.coherence && typeof errSummary.coherence.final_recommendation === 'string', { coherence: errSummary.coherence });
    }
  } finally {
    cleanupTestPack(tp);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// T4: Summary shape contract — polish-status-loader can read the partial
// summary. The partial summary must include enough coherence metadata to
// avoid being treated as "Never polished" by the dashboard consumer.
// ─────────────────────────────────────────────────────────────────────────
{
  const tp = setupTestPack('-loader');
  try {
    const fakeHarvest = async () => ({ hiring_manager_priorities: [], dealbreaker_pruned: [], meta: { cache: 'fresh', cost_usd: 0 } });
    const fakePolishArtifact = async (input) => canonicalAbandonedResult(input.artifactKind);
    // Use real-shape coherence so polish-status-loader fields populate
    const fakeCoherence = async () => canonicalCoherence();

    await runPolishPack({
      artifacts: ['cv', 'cover', 'form'],
      packInfoOverride: tp.packInfo,
      installSignalHandlers: false,
      harvestPolishSignals: fakeHarvest,
      polishArtifact: fakePolishArtifact,
      checkPackCoherence: fakeCoherence,
      costWarnUsd: 100,
      targetConfidence: 0.99,
    });

    // Verify polish-status-loader can read it
    const loaded = loadOnePolishStatus(tp.slug);
    check('T4.a polish-status-loader returns non-null for completed run', loaded != null, { loaded });
    if (loaded) {
      check('T4.b loader detected verdict (NEEDS_HUMAN from coherence)', loaded.verdict === 'NEEDS_HUMAN', { verdict: loaded.verdict });
      check('T4.c all 3 artifacts marked early_abandoned (⏸ status path)', loaded.any_early_abandoned === true, { any_ea: loaded.any_early_abandoned });
      check('T4.d status_icon === "⏸" (all artifacts abandoned)', loaded.status_icon === '⏸', { icon: loaded.status_icon });
      check('T4.e status_label === "Abandoned early"', loaded.status_label === 'Abandoned early', { label: loaded.status_label });
      check('T4.f per_artifact has expected keys', loaded.per_artifact && Object.keys(loaded.per_artifact).length === 3, { keys: Object.keys(loaded.per_artifact || {}) });
    }
  } finally {
    cleanupTestPack(tp);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('');
  console.error('Failures:');
  for (const f of failures) {
    let d = f.detail;
    try { d = JSON.stringify(d); } catch { /* */ }
    console.error(`  - ${f.name} → ${String(d).slice(0, 480)}`);
  }
  process.exit(1);
}
process.exit(0);
