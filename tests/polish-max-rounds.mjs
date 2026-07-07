#!/usr/bin/env node
/**
 * tests/polish-max-rounds.mjs
 *
 * Smoke test for the 2026-05-24 convergence-impossible-runaway fix:
 *   - lib/polish-loop.mjs § Max-rounds-per-artifact cap
 *   - lib/polish-loop.mjs § Cost-warn threshold
 *
 * Canonical incident — 2026-05-24 PID 45655 on row #48 (Anthropic Engineering
 * Editorial Lead). polishArtifact ran 18 inner rounds × 3 outer attempts =
 * effective 18 rounds without abandonment, $8.27 spent, process killed before
 * polish-orchestrator-summary.json could be written.
 *
 * Coverage:
 *   T1. polishArtifact respects opts.maxRoundsPerArtifact and abandons at the
 *       cap with abandon_reason='max-rounds-exceeded' when the council never
 *       returns a converging response.
 *   T2. Return shape includes the new fields: abandoned, abandon_reason,
 *       total_rounds_across_outer, max_rounds_per_artifact, cost_warn_usd,
 *       early_abandoned (mirrors abandoned for status-loader back-compat).
 *   T3. POLISH_COST_WARN_USD env-var crossing emits an NDJSON WARN line per
 *       round on stderr (level: 'WARN', msg: 'cost-warn-threshold-crossed').
 *   T4. opts.installSignalHandlers === false leaves the test process's signal
 *       handler table untouched (smoke tests must not inherit SIGTERM/SIGINT
 *       handlers from runPolishPack).
 *
 * No live API calls — opts.callCouncil dependency injection delivers canned
 * non-converging responses to every critic / author / adjudicator /
 * adversarial / verifier call site.
 *
 * Usage:
 *   node tests/polish-max-rounds.mjs
 *
 * Exits 0 on pass; 1 on any failure.
 */

import { polishArtifact } from '../lib/polish-loop.mjs';

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

/**
 * Fake callCouncil that returns a non-converging response for every call site.
 *  - critic.score = 0.5 (well below 0.99 target)
 *  - author.author_self_score = 0.5
 *  - adjudicator.weighted_confidence = 0.5 (never crosses 0.99)
 *  - adversarial.blocking_findings = [{ severity: 'blocker' }] (passes := false)
 *
 * Each call counts toward `state.calls` so the test can verify exactly how
 * many council invocations the loop made.
 */
function makeFakeCouncil(state) {
  return async ({ prompt: _p, models, opts: _o }) => {
    state.calls += 1;
    const content = JSON.stringify({
      // Critic shape
      score: 0.5,
      gaps: ['mock-gap'],
      concrete_rewrites: [],
      // Author shape
      accepted_rewrites: [],
      rejected_rewrites: [],
      merged_artifact_text: 'Mock author revision. Holds the same content. No real change.',
      author_self_score: 0.5,
      author_notes: 'mock author',
      // Adjudicator shape
      final_artifact_text: 'Mock adjudicated artifact. Repeated content. No real change.',
      weighted_confidence: 0.5,
      remaining_concerns: ['mock-concern'],
      adjudicator_notes: 'mock adjudicator',
      // Adversarial shape — blocker keeps passes=false so convergence never fires
      blocking_findings: [{ finding: 'mock blocker', severity: 'blocker', fix_suggestion: 'mock' }],
      passes: false,
      adversarial_notes: 'mock adversarial',
      // Round 5 verifier shape (won't fire because adversarial fails)
      voice_drift_score: 0.1,
      overclaim_count: 0,
      ats_keyword_overstuffing: false,
      cross_arch_findings: [],
      verdict_rationale: 'mock verifier',
    });
    // Each model in `models` gets one entry — matches the lineup shape used by
    // critic (1 model per critic), author (1), adjudicator (1), adversarial (2).
    const results = (models && models.length > 0 ? models : ['mock:mock']).map(m => ({
      model: m,
      status: 'ok',
      content,
      error: null,
    }));
    return {
      results,
      // Match the shape lib/polish-loop.mjs reads at r.report?.totalCost
      report: { totalCost: 0.10 },
    };
  };
}

// Common input fixture — minimal valid shape; the loop only reads strings.
function makeInput({ extraOpts = {} } = {}) {
  return {
    artifactKind: 'cv-tailored',
    artifactText: 'Initial artifact text. Brief. Will be polished.',
    signals: { hiring_manager_priorities: [], dealbreaker_pruned: [], meta: { cache: 'fresh' } },
    cvText: '# CV\n- Built X.\n- Shipped Y.',
    articleDigest: '# Article digest\n- Proof point Z.',
    voiceBrief: '# Voice brief\nBanned-phrase checklist: delve, tapestry, leverage.',
    opts: {
      targetConfidence: 0.99,
      // Skip the L1 + L2 gates — they hit external APIs / are unrelated to
      // the cap behavior under test.
      skipGates: true,
      // Disable early-abandonment so the test exercises the new cap path
      // independently of the legacy low-conf+flat-trajectory path.
      earlyAbandonDisabled: true,
      // Skip Round 5 verifier (won't fire when adversarial fails anyway, but
      // be explicit).
      skipRound5: true,
      // Force diff-cap to a high number so the loop accepts mock rewrites.
      diffCap: 1.0,
      // Tight outerRetries so the test runs fast.
      outerRetries: 2,
      // Keep council per-call timeout small so the test doesn't take ages
      // even if something is wrong with the mock.
      ...extraOpts,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// T1+T2: Max-rounds-per-artifact cap fires; return shape carries new fields.
// ─────────────────────────────────────────────────────────────────────────
{
  const state = { calls: 0 };
  const input = makeInput({
    extraOpts: {
      maxRoundsPerArtifact: 3,
      maxRounds: 6,         // inner per-outer cap
      outerRetries: 2,      // outer cap
      callCouncil: makeFakeCouncil(state),
    },
  });

  const r = await polishArtifact(input);

  check('T1.a abandoned === true', r.abandoned === true, { abandoned: r.abandoned, calls: state.calls });
  check('T1.b abandon_reason === "max-rounds-exceeded"', r.abandon_reason === 'max-rounds-exceeded', { abandon_reason: r.abandon_reason });
  check('T1.c total_rounds_across_outer === 3 (== cap)', r.total_rounds_across_outer === 3, { total_rounds: r.total_rounds_across_outer });
  check('T1.d converged === false', r.converged === false, { converged: r.converged });

  // T2: shape contract for downstream consumers
  check('T2.a result has max_rounds_per_artifact field', r.max_rounds_per_artifact === 3, { max: r.max_rounds_per_artifact });
  check('T2.b result has cost_warn_usd field', typeof r.cost_warn_usd === 'number', { cost_warn_usd: r.cost_warn_usd });
  check('T2.c early_abandoned mirrors abandoned for status-loader back-compat', r.early_abandoned === true, { early_abandoned: r.early_abandoned });
  check('T2.d confidence_history populated', Array.isArray(r.confidence_history) && r.confidence_history.length > 0, { len: r.confidence_history?.length });
  check('T2.e polish_trace records the abandonment', /MAX-ROUNDS-PER-ARTIFACT CAP/.test(r.polish_trace || ''), { trace_excerpt: (r.polish_trace || '').slice(0, 240) });
}

// ─────────────────────────────────────────────────────────────────────────
// T3: Cost-warn threshold emits NDJSON WARN to stderr every round after
// threshold is crossed.
// ─────────────────────────────────────────────────────────────────────────
{
  const state = { calls: 0 };
  // Capture stderr writes
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    try { stderrLines.push(String(chunk)); } catch { /* */ }
    return origWrite(chunk, ...rest);
  };

  try {
    const input = makeInput({
      extraOpts: {
        maxRoundsPerArtifact: 4,
        // costWarnUsd: 0.01 is well below the per-round mock cost (~0.10/critic
        // × 3 critics + 0.10 author + 0.10 adjudicator + 0.10×2 adversarial = ~0.70)
        // so the threshold should cross by the end of round 1.
        costWarnUsd: 0.01,
        callCouncil: makeFakeCouncil(state),
      },
    });
    const r = await polishArtifact(input);

    const warnLines = stderrLines.filter(l => /cost-warn-threshold-crossed/.test(l));
    check('T3.a at least one cost-warn NDJSON line written to stderr', warnLines.length >= 1, { warnLines: warnLines.length, total_stderr_lines: stderrLines.length });

    // Each WARN line is one JSON record
    const parsed = warnLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    check('T3.b WARN line is parseable JSON', parsed.length >= 1, { parsed: parsed.length });
    if (parsed.length > 0) {
      const w = parsed[0];
      check('T3.c WARN has level=WARN', w.level === 'WARN', { level: w.level });
      check('T3.d WARN has threshold_usd === 0.01', w.threshold_usd === 0.01, { threshold: w.threshold_usd });
      check('T3.e WARN has total_cost_usd ≥ threshold', typeof w.total_cost_usd === 'number' && w.total_cost_usd >= w.threshold_usd, { total: w.total_cost_usd, threshold: w.threshold_usd });
    }
    // One WARN per round means at least 1 (round 1 already crosses), at most
    // maxRoundsPerArtifact. Validate the upper bound to ensure no runaway.
    check('T3.f WARN count ≤ maxRoundsPerArtifact', warnLines.length <= 4, { warnLines: warnLines.length, cap: 4 });

    // Trace should include the once-per-artifact COST WARN line
    check('T3.g trace has one COST WARN entry', /COST WARN — total \$[0-9.]+ ≥ warn-threshold/.test(r.polish_trace || ''), { trace_excerpt: (r.polish_trace || '').slice(0, 500) });
  } finally {
    process.stderr.write = origWrite;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// T4: opts.installSignalHandlers === false has no effect on polishArtifact
// (it lives on runPolishPack), but verify that polishArtifact itself does
// not attach any signal handlers as a side effect — important for test
// process hygiene.
// ─────────────────────────────────────────────────────────────────────────
{
  const sigtermBefore = process.listenerCount('SIGTERM');
  const sigintBefore = process.listenerCount('SIGINT');

  const state = { calls: 0 };
  const input = makeInput({
    extraOpts: {
      maxRoundsPerArtifact: 2,
      callCouncil: makeFakeCouncil(state),
    },
  });
  await polishArtifact(input);

  const sigtermAfter = process.listenerCount('SIGTERM');
  const sigintAfter = process.listenerCount('SIGINT');

  check('T4.a polishArtifact did not leak SIGTERM listeners', sigtermAfter === sigtermBefore, { before: sigtermBefore, after: sigtermAfter });
  check('T4.b polishArtifact did not leak SIGINT listeners', sigintAfter === sigintBefore, { before: sigintBefore, after: sigintAfter });
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
    console.error(`  - ${f.name} → ${String(d).slice(0, 320)}`);
  }
  process.exit(1);
}
process.exit(0);
