#!/usr/bin/env node
/**
 * tests/_polish-sigterm-runner.mjs (internal — driven by polish-sigterm-e2e.test.mjs)
 *
 * Spawns runPolishPack with installSignalHandlers:true + a DI'd polishArtifact
 * that blocks until SIGTERM arrives. Emits PHASE2_READY:<summaryPath> on stdout
 * once it's in Phase 2 so the parent test knows it's safe to send SIGTERM.
 *
 * Process exits 143 on SIGTERM (the polish orchestrator's handler does
 * process.exit(143) after writing the partial summary).
 *
 * Argv:
 *   --slug <test-pack-slug>     unique test pack slug (created by parent)
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPolishPack } from '../scripts/agents/apply-pack-polish.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function arg(name, fb = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fb;
}

const slug = arg('--slug');
if (!slug) {
  process.stderr.write('RUNNER_ERROR: --slug is required\n');
  process.exit(2);
}

const applyPackDir = join(REPO_ROOT, 'apply-pack', slug);
const dataPackDir = join(REPO_ROOT, 'data', 'apply-packs', slug);
mkdirSync(applyPackDir, { recursive: true });
mkdirSync(dataPackDir, { recursive: true });
if (!existsSync(join(applyPackDir, 'tailored-cv.md'))) {
  writeFileSync(join(applyPackDir, 'tailored-cv.md'), '# CV\n- mock', 'utf-8');
}
if (!existsSync(join(applyPackDir, 'cover-letter.md'))) {
  writeFileSync(join(applyPackDir, 'cover-letter.md'), '# Cover\n- mock', 'utf-8');
}
if (!existsSync(join(applyPackDir, 'form-fields.md'))) {
  writeFileSync(join(applyPackDir, 'form-fields.md'), '# Form\n- mock', 'utf-8');
}

const summaryPath = join(dataPackDir, 'polish-orchestrator-summary.json');

// Signal handshake — parent reads this stdout line and then sends SIGTERM.
// Print it BEFORE starting runPolishPack so the parent can race ahead and
// have SIGTERM ready by the time we're inside Phase 2.
process.stdout.write(`PHASE2_READY:${summaryPath}\n`);

const fakeHarvest = async () => ({
  hiring_manager_priorities: [],
  dealbreaker_pruned: [],
  meta: { cache: 'fresh', cost_usd: 0 },
});

// Slow polishArtifact — blocks for 60 seconds (way past the test budget).
// The parent will SIGTERM us mid-block; the orchestrator's signal handler
// runs synchronously, writes the partial summary, then process.exit(143).
const fakePolishArtifact = async (input) => {
  process.stdout.write(`POLISH_STARTED:${input.artifactKind}\n`);
  await new Promise(resolve => setTimeout(resolve, 60_000));
  // Should never reach here under SIGTERM test
  return {
    artifact_kind: input.artifactKind,
    final_artifact_text: 'unreachable',
    confidence: 0,
    rounds_used: 0,
    converged: false,
    early_abandoned: false,
    abandoned: false,
    abandon_reason: null,
    confidence_history: [],
    adversarial_findings: [],
    polish_trace: '',
    cost_usd: 0,
    duration_ms: 60_000,
    l1_detection: null,
    l2_voice_rules: null,
    l1_error: null,
    combined_final_confidence: 0,
    combined_gate_status: 'PASS',
    combined_gate_reasons: [],
    detection_revisions_used: 0,
    detection_revision_trace: '',
    needs_human_detection: false,
  };
};

const fakeCoherence = async () => ({ final_recommendation: 'APPROVED', blocking_issues: [], per_artifact_confidence: {}, cross_coherence: {}, diff_narrative: '', meta: { generated_at: new Date().toISOString() } });

try {
  await runPolishPack({
    artifacts: ['cv'],
    packInfoOverride: { slug, company: 'TestCorp', role: 'TestRole', rowId: 9998 },
    installSignalHandlers: true,
    harvestPolishSignals: fakeHarvest,
    polishArtifact: fakePolishArtifact,
    checkPackCoherence: fakeCoherence,
    costWarnUsd: 1000,
    targetConfidence: 0.99,
  });
  // Should never complete — parent should SIGTERM us first
  process.stdout.write('RUNNER_COMPLETED_UNEXPECTEDLY\n');
  process.exit(0);
} catch (e) {
  process.stderr.write(`RUNNER_ERROR: ${String(e.message || e)}\n`);
  process.exit(3);
}
