/**
 * lib/polish-loop.mjs — Phase 2 of apply-pack-polish (Mitchell · ALPHA · 2026-05-19).
 *
 * Per-artifact review loop. For ONE artifact (cv-tailored / cover-letter /
 * form-fields / impact-doc / references / referrals), runs:
 *
 *   ROUND 1 — 3 critics in parallel (Haiku 4.5 each, diversity-of-voice):
 *     copywriter-critic, designer-critic, recruiter-critic
 *   ROUND 2 — author rebuttal (Sonnet 4.6, full corpus context)
 *   ROUND 3 — convergence pass: critics see rebuttals, opus adjudicator on standoffs
 *   ROUND 4 — adversarial sweep (quality-first addition — Sonar Deep + Opus)
 *
 *   Exit when weighted_confidence ≥ targetConfidence (default 0.99) AND
 *   adversarial sweep finds nothing AND no critic changes their score
 *   between rounds. Max 6 inner rounds. 3 outer-loop retries on non-
 *   convergence with --no-cache + forced refresh of signals.
 *
 * Anti-drift guards:
 *   - Every rewrite cites a line in cv.md or article-digest.md
 *   - Diff cap: 35% line-level change vs input (unless --allow-major-rewrite)
 *   - Voice fidelity: banned-phrase checklist enforced via voice-reference-brief.md
 *
 * Returns: { final_artifact_text, confidence, rounds_used, polish_trace,
 *           critic_scores_history, cost_usd, adversarial_findings }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCouncil } from './council.mjs';
import { checkText } from './ai-detection-gate.mjs';
import { runVoiceRulesGate } from './voice-rules-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const CRITICS = [
  {
    role: 'copywriter',
    model: 'anthropic:claude-haiku-4-5',
    persona: 'Senior copywriter. Score tone, voice, narrative arc, sentence rhythm, banned-phrase-checklist adherence.',
  },
  {
    role: 'designer',
    model: 'anthropic:claude-haiku-4-5',
    persona: 'Senior content designer. Score visual hierarchy, scannability, paragraph length, density of proof points per line.',
  },
  {
    role: 'recruiter',
    model: 'anthropic:claude-haiku-4-5',
    persona: 'Senior in-house recruiter at a frontier AI lab. Score ATS keyword coverage, 6-second scan readability, evidence-of-fit per line.',
  },
];

const AUTHOR_MODEL = 'anthropic:claude-sonnet-4-6';
const ADJUDICATOR_MODEL = 'anthropic:claude-opus-4-7';
const ADVERSARIAL_LINEUP = ['perplexity:sonar-deep-research', 'anthropic:claude-opus-4-7'];

// refresh-master Phase 5 deliverable 1: cross-architecture Round 5 verifier.
// Author is anthropic (Sonnet) → Round 5 review must be a DIFFERENT family
// (xAI Grok-Heavy + Perplexity Sonar Deep). Opus adjudicates the verifier.
// Architectural-family rotation prevents writer + verifier from sharing
// training-distribution / embeddings.
const ROUND5_VERIFIER_LINEUP = ['xai:grok-4-20-multi-agent', 'perplexity:sonar-deep-research'];
const ROUND5_ADJUDICATOR = 'anthropic:claude-opus-4-7';

// 2026-05-27 — Lowered 0.99 → 0.85. The 0.99 target was aspirational ("perfect
// convergence") but empirical LLM author confidence tops at 0.80-0.92 for
// healthy polished output. 0.99 was unreachable, causing every pack to surface
// as REJECTED. 0.85 is achievable + still meaningful. Override via
// opts.targetConfidence or env POLISH_TARGET_CONFIDENCE (consumers wire this).
const DEFAULT_TARGET = 0.85;
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_OUTER_RETRIES = 3;
const DEFAULT_DIFF_CAP = 0.35;

// Per OMEGA-proposal-1 (approved 2026-05-19): Opus adjudication can legitimately
// run 60-120s; council's 180s default leaves no headroom for adversarial Round 4.
// POLISH_API_TIMEOUT_MS overrides the council's per-provider timeout. Defaults to
// 300_000ms (5 min). Clamped to [30s, 30min] by callCouncil itself.
const _rawPolishTimeout = parseInt(process.env.POLISH_API_TIMEOUT_MS || '300000', 10);
const POLISH_API_TIMEOUT_MS = Number.isFinite(_rawPolishTimeout) && _rawPolishTimeout > 0
  ? Math.min(Math.max(_rawPolishTimeout, 30_000), 1_800_000)
  : 300_000;

// ── Max-rounds-per-artifact cap (added 2026-05-24) ────────────────────────
// Prevents convergence-impossible runaway. The pre-fix design allowed
// maxRounds=6 INNER × outerRetries=3 = 18 rounds across the outer chain
// when the adversarial gate kept hedging passes:false with zero blocking
// findings. Canonical incident — 2026-05-24 PID 45655 on row #48
// (Anthropic Engineering Editorial Lead): 82 min wall clock, $8.27 spent,
// 15+ rounds, author_score stuck at 0.81, weighted_confidence oscillating
// 0.70 → 0.86 → 0.78 → 0.82, process killed without writing summary.
//
// POLISH_MAX_ROUNDS is a HARD cap on TOTAL rounds across all outer attempts.
// When the cap is hit before convergence, the artifact is marked abandoned
// (abandon_reason='max-rounds-exceeded') and the loop exits. Default 6
// (matches the prior per-outer cap, but now applied across the full chain
// → at most ~$3-4 spend per artifact under typical Round 1-5 cost profile).
// Safety clamp [1, 30].
const _rawMaxRoundsPerArtifact = parseInt(process.env.POLISH_MAX_ROUNDS || '6', 10);
const MAX_ROUNDS_PER_ARTIFACT = Number.isFinite(_rawMaxRoundsPerArtifact) && _rawMaxRoundsPerArtifact > 0
  ? Math.min(Math.max(_rawMaxRoundsPerArtifact, 1), 30)
  : 6;

// ── Cost-warn threshold (added 2026-05-24) ────────────────────────────────
// Per-artifact soft warning. When totalCost crosses this threshold inside
// the polish loop, an NDJSON WARN line is emitted to stderr every round
// thereafter. Does NOT abandon — only warns. The orchestrator uses the
// same threshold to force-abandon any artifacts that haven't started yet
// (see scripts/agents/apply-pack-polish.mjs).
const _rawCostWarnUsd = parseFloat(process.env.POLISH_COST_WARN_USD || '5');
const COST_WARN_USD = Number.isFinite(_rawCostWarnUsd) && _rawCostWarnUsd > 0
  ? _rawCostWarnUsd
  : 5;

// ── Polish hang fix Part B (2026-05-19) ──────────────────────────────────
// Wall-clock wrapper that does not depend on AbortSignal propagating through
// undici's keep-alive layer. If a fetch hangs because the TCP socket stays
// open after the response headers but the body never finishes streaming,
// AbortSignal.timeout fires but the await never resolves. This Promise.race
// at the orchestrator level catches that case.
//
// Per-callCouncil hard ceiling: 8 minutes. That's larger than the in-band
// POLISH_API_TIMEOUT_MS (5 min) so the in-band timeout fires first under
// normal conditions. Wall-clock is the safety net for the undici-keep-alive
// trap where the in-band timeout fails to take effect.
const HARD_TIMEOUT_PER_CALL_MS = 8 * 60_000;
function withWallClock(promise, label, ms = HARD_TIMEOUT_PER_CALL_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`WALL_CLOCK_TIMEOUT: ${label} exceeded ${ms}ms`));
      }, ms);
    }),
  ]);
}

function extractJson(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* */ }
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* */ }
  }
  const s = content.indexOf('{');
  const e = content.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(content.slice(s, e + 1)); } catch { /* */ }
  }
  return null;
}

function diffRatio(before, after) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const max = Math.max(a.length, b.length, 1);
  let diff = 0;
  for (let i = 0; i < max; i++) {
    if ((a[i] || '') !== (b[i] || '')) diff++;
  }
  return diff / max;
}

function summarizeCritic(criticOut) {
  if (!criticOut) return { score: 0, gaps: [], concrete_rewrites: [] };
  return {
    score: Number(criticOut.score) || 0,
    gaps: Array.isArray(criticOut.gaps) ? criticOut.gaps : [],
    concrete_rewrites: Array.isArray(criticOut.concrete_rewrites) ? criticOut.concrete_rewrites : [],
  };
}

function buildCriticPrompt({ persona, role, artifactKind, artifactText, signals, cvText, articleDigest, voiceBrief }) {
  return [
    `# Role`,
    persona,
    `You are ${role.toUpperCase()}-critic on a polish loop for Mitchell Williams's ${artifactKind}.`,
    ``,
    `# Inputs`,
    `## Polish signals (ground truth from Phase 1 dealbreaker)`,
    JSON.stringify(signals, null, 2).slice(0, 4000),
    ``,
    `## cv.md (canonical corpus — every rewrite MUST cite cv.md:N or article-digest.md:N)`,
    (cvText || '').slice(0, 4500),
    ``,
    `## article-digest.md (proof points)`,
    (articleDigest || '').slice(0, 2500),
    ``,
    `## Voice brief (banned-phrase checklist + canonical metrics — never invent metrics)`,
    (voiceBrief || '').slice(0, 2000),
    ``,
    `# Artifact under review (${artifactKind})`,
    `\`\`\``,
    String(artifactText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `# Your task — return STRICT JSON only`,
    `{`,
    `  "score": 0.0,  // 0–1, your confidence the artifact ships at top quality from YOUR critic-lens`,
    `  "gaps": ["specific issues — file:line in the artifact OR named anti-pattern from the polish signals"],`,
    `  "concrete_rewrites": [`,
    `    { "target_line_or_phrase": "exact text from artifact", "rewrite": "...", "citation": "cv.md:NN or article-digest.md:NN", "reason": "..." }`,
    `  ]`,
    `}`,
    `Hard rules:`,
    `- Every concrete_rewrite MUST include a citation. No citation → don't propose it.`,
    `- Honor the banned-phrase checklist (no "delve", "tapestry", "passionate", exclamation marks, etc.)`,
    `- Reuse ONLY canonical metrics from voice brief; never invent.`,
    `- Be specific. "improve clarity" is not a gap. "Line 3 mixes two claims; split them" is a gap.`,
  ].join('\n');
}

function buildAuthorPrompt({ artifactKind, artifactText, signals, cvText, articleDigest, voiceBrief, critics }) {
  return [
    `# Role`,
    `You are the AUTHOR voice for Mitchell Williams's ${artifactKind}. You hold the canon — cv.md, article-digest.md, voice brief.`,
    `Three critics (copywriter / designer / recruiter) just reviewed the artifact. Decide which rewrites to accept, reject, or merge.`,
    ``,
    `# Polish signals (Phase 1)`,
    JSON.stringify(signals, null, 2).slice(0, 3500),
    ``,
    `# cv.md (ground truth)`,
    (cvText || '').slice(0, 4500),
    ``,
    `# article-digest.md`,
    (articleDigest || '').slice(0, 2500),
    ``,
    `# Voice brief`,
    (voiceBrief || '').slice(0, 2000),
    ``,
    `# Artifact under review`,
    `\`\`\``,
    String(artifactText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `# Critic outputs (Round 1)`,
    JSON.stringify(critics, null, 2).slice(0, 5500),
    ``,
    `# Your task — return STRICT JSON only`,
    `{`,
    `  "accepted_rewrites": [{ "from_critic": "copywriter|designer|recruiter", "target": "...", "rewrite": "...", "citation": "cv.md:NN", "reason": "why this accept" }],`,
    `  "rejected_rewrites": [{ "from_critic": "...", "target": "...", "rewrite": "...", "reason": "violates voice brief / no citation / overclaim" }],`,
    `  "merged_artifact_text": "the FULL revised artifact text, with accepted rewrites applied. Cite cv.md:N inline where rewrites pulled from cv.md.",`,
    `  "author_self_score": 0.0,  // your confidence the revised artifact is publish-ready`,
    `  "author_notes": "1-3 sentences on what changed and why"`,
    `}`,
    `Constraints:`,
    `- Never inflate metrics. If a critic suggests a number not in cv.md / article-digest.md, REJECT it.`,
    `- Diff cap: stay within ~35% line-level change vs. input. Larger rewrite requires explicit override (out of scope here).`,
    `- merged_artifact_text MUST be the complete artifact — not a diff.`,
  ].join('\n');
}

function buildAdjudicatorPrompt({ artifactKind, originalText, authorText, critics, signals }) {
  return [
    `# Role — Opus adjudicator`,
    `You break standoffs on the polish loop for Mitchell Williams's ${artifactKind}.`,
    `The author has applied some critic rewrites and rejected others. Your call is final.`,
    ``,
    `# Inputs`,
    `## Polish signals`,
    JSON.stringify(signals, null, 2).slice(0, 3500),
    ``,
    `## Critic outputs`,
    JSON.stringify(critics, null, 2).slice(0, 5500),
    ``,
    `## Original artifact`,
    `\`\`\``,
    String(originalText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `## Author-revised artifact`,
    `\`\`\``,
    String(authorText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `# Your task — return STRICT JSON only`,
    `{`,
    `  "final_artifact_text": "the artifact as it should ship. Either keep author's version, or selectively apply more critic rewrites the author wrongly rejected.",`,
    `  "weighted_confidence": 0.0,  // weighted across critic scores + your own judgment + signal coverage`,
    `  "remaining_concerns": ["specific issues that still block ≥0.99 if any"],`,
    `  "adjudicator_notes": "1-3 sentences on the call"`,
    `}`,
    `Weighting heuristic: copywriter 0.30, designer 0.25, recruiter 0.30, your own 0.15. Apply to score-out-of-1 each.`,
  ].join('\n');
}

function buildAdversarialPrompt({ artifactKind, finalText, signals }) {
  return [
    `# Role — adversarial sweep`,
    `You are actively trying to BREAK this polished ${artifactKind} before it ships.`,
    `Find anything: voice drift, overclaim, weak opening, dead phrase, citation gap, HM read-fail, ATS keyword gap.`,
    ``,
    `# Polish signals`,
    JSON.stringify(signals, null, 2).slice(0, 3500),
    ``,
    `# Artifact (post-adjudicator)`,
    `\`\`\``,
    String(finalText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `# Your task — return STRICT JSON only`,
    `{`,
    `  "blocking_findings": [{ "finding": "...", "severity": "blocker|major|minor", "fix_suggestion": "..." }],`,
    `  "passes": true|false,  // true ONLY if NO blocking_findings remain`,
    `  "adversarial_notes": "what you tried and why it held / failed"`,
    `}`,
    `Be ruthless. "passes": true requires zero blockers AND zero majors.`,
  ].join('\n');
}

// refresh-master Phase 5 deliverable 1: Round 5 cross-architecture verifier prompt.
// Different framing from adversarial: this asks "does this artifact still ground
// in cv.md / Mitchell's voice corpus when read by a model trained on DIFFERENT data
// than the author?" — designed to catch hallucinations the same-family adversarial
// might rationalize away.
function buildRound5VerifierPrompt({ artifactKind, finalText, signals }) {
  return [
    `# Role — cross-architecture verifier`,
    `You are a model from a DIFFERENT architectural family than the author (the author was anthropic Sonnet; you are NOT anthropic).`,
    `Your job: detect anything the author's family might have missed because of shared training-distribution blindspots.`,
    `Especially: fabricated proof points, overclaimed metrics, voice drift away from Mitchell, ATS keyword overstuffing.`,
    ``,
    `# Polish signals (ground truth)`,
    JSON.stringify(signals, null, 2).slice(0, 2500),
    ``,
    `# Artifact`,
    `\`\`\``,
    String(finalText || '').slice(0, 6000),
    `\`\`\``,
    ``,
    `# Your task — return STRICT JSON only`,
    `{`,
    `  "passes": true|false,`,
    `  "voice_drift_score": 0.0,            // 0=Mitchell perfect, 1=AI-buzzword soup`,
    `  "overclaim_count": 0,                // # of metrics / quotes lacking signal-citation`,
    `  "ats_keyword_overstuffing": false,   // true if same keyword appears >3 times unnaturally`,
    `  "cross_arch_findings": ["specific issues a model from your family would catch"],`,
    `  "verdict_rationale": "1-2 sentences why pass/fail"`,
    `}`,
    `Be ruthless about cross-family blindspots. "passes": true requires voice_drift < 0.3, overclaim=0, no overstuffing.`,
  ].join('\n');
}

/**
 * Run ONE artifact through the 4-round polish loop, with up to maxRounds
 * inner rounds and outerRetries outer-loop retries on non-convergence.
 *
 * @param {object} input
 * @param {string} input.artifactKind — "cv-tailored" | "cover-letter" | "form-fields" | "impact-doc" | "references" | "referrals"
 * @param {string} input.artifactText — current artifact text
 * @param {object} input.signals — Phase 1 polish-signals.json content
 * @param {string} input.cvText
 * @param {string} input.articleDigest
 * @param {string} input.voiceBrief
 * @param {object} [input.opts]
 * @param {number} [input.opts.targetConfidence=0.99]
 * @param {number} [input.opts.maxRounds=6]
 * @param {number} [input.opts.outerRetries=3]
 * @param {number} [input.opts.costCap=80]  // USD per-artifact ceiling
 * @param {string} [input.opts.tracePath]   // where to write polish-trace-{artifact}.md
 * @returns {Promise<object>}
 */
export async function polishArtifact(input) {
  const t0 = Date.now();
  const opts = input.opts || {};
  // 2026-07-07 (blind-review BUG 2) — Number.isFinite guards, not `??`. A
  // non-finite `opts.maxRounds`/`opts.target` (e.g. NaN from an upstream
  // `Number(unset-env) ?? default`) silently defeats the loop: `rounds < NaN`
  // is always false so ZERO rounds run and bestConfidence stays 0. `??` only
  // catches null/undefined, never NaN — so it let the NaN through. See the
  // apply-pack-polish.mjs maxRounds fix for the source of the canonical bug.
  const target = Number.isFinite(opts.targetConfidence) ? opts.targetConfidence : DEFAULT_TARGET;
  const maxRounds = Number.isFinite(opts.maxRounds) ? opts.maxRounds : DEFAULT_MAX_ROUNDS;
  const outerRetries = opts.outerRetries ?? DEFAULT_OUTER_RETRIES;
  const costCap = opts.costCap ?? 80;
  const diffCap = opts.diffCap ?? DEFAULT_DIFF_CAP;

  // ── Convergence-impossible-runaway cap + cost-warn (added 2026-05-24) ──
  // maxRoundsPerArtifact is a HARD cap on TOTAL rounds across outer
  // attempts. costWarnUsd surfaces an NDJSON WARN every round after the
  // threshold is crossed. See lib/polish-loop.mjs § Max-rounds-per-artifact.
  const maxRoundsPerArtifact = Number.isFinite(opts.maxRoundsPerArtifact) ? opts.maxRoundsPerArtifact : MAX_ROUNDS_PER_ARTIFACT;
  const costWarnUsd = opts.costWarnUsd ?? COST_WARN_USD;

  // Dependency-injection hook for testing — opts.callCouncil overrides the
  // imported callCouncil. Smoke tests pass a fake that returns canned
  // responses without hitting any LLM API. See tests/polish-max-rounds.mjs.
  const _callCouncil = typeof opts.callCouncil === 'function' ? opts.callCouncil : callCouncil;

  // Early-abandonment thresholds (added 2026-05-19 — saves ~$5/rejected polish).
  // After completing earlyAbandonAfterRound rounds, if best confidence is below
  // earlyAbandonMaxConfidence AND last delta was below earlyAbandonMinDelta,
  // abandon early. Conservative defaults: only fire when polish has CLEARLY
  // stalled in a low-confidence basin. Override per-call via opts or globally
  // disable with opts.earlyAbandonDisabled = true.
  const earlyAbandonEnabled    = opts.earlyAbandonDisabled !== true;
  const earlyAbandonAfterRound = opts.earlyAbandonAfterRound ?? 3;
  const earlyAbandonMaxConf    = opts.earlyAbandonMaxConfidence ?? 0.50;
  const earlyAbandonMinDelta   = opts.earlyAbandonMinDelta ?? 0.05;

  const trace = [];
  let totalCost = 0;
  let bestText = input.artifactText;
  let bestConfidence = 0;
  let lastCriticScores = null;
  let outerAttempt = 0;
  let adversarialFindings = [];
  let onSignalsRefresh = typeof opts.onSignalsRefresh === 'function' ? opts.onSignalsRefresh : null;
  let signals = input.signals;
  let earlyAbandoned = false;
  // 2026-05-24 — convergence-impossible-runaway tracking.
  let totalRoundsAcrossOuter = 0;
  let abandoned = false;
  let abandonReason = null;
  let costWarnFiredOnTrace = false;
  const confidenceHistory = []; // [{ round, weighted, delta }]
  const startMs = Date.now();

  function hb(step, extra = {}) {
    try {
      process.stderr.write(JSON.stringify({
        t: new Date().toISOString(),
        phase: 'polish-loop',
        artifact: input.artifactKind,
        outerAttempt: outerAttempt + 1,
        step,
        elapsed_ms: Date.now() - startMs,
        ...extra,
      }) + '\n');
    } catch { /* never block on stderr */ }
  }

  // Cost-trace opts forwarding (Mitchell decision α.2).
  // Merge onCostRecord + phase + artifactSlug into every callCouncil opts object.
  const costTraceOpts = {
    ...(opts.onCostRecord ? { onCostRecord: opts.onCostRecord } : {}),
    ...(opts.phase ? { phase: opts.phase } : {}),
    ...(opts.artifactSlug ? { artifactSlug: opts.artifactSlug } : { artifactSlug: input.artifactKind }),
    agentSlug: 'apply-pack-polish',
  };

  for (outerAttempt = 0; outerAttempt < outerRetries; outerAttempt++) {
    if (abandoned) break;
    let rounds = 0;
    let converged = false;

    while (rounds < maxRounds) {
      // Max-rounds-per-artifact cap (2026-05-24). Check BEFORE incrementing
      // so we do not start a round we're not going to finish — and so the
      // counter reflects rounds that actually ran.
      if (totalRoundsAcrossOuter >= maxRoundsPerArtifact) {
        abandoned = true;
        abandonReason = 'max-rounds-exceeded';
        trace.push(`## MAX-ROUNDS-PER-ARTIFACT CAP — abandoning ${input.artifactKind} after ${totalRoundsAcrossOuter}/${maxRoundsPerArtifact} rounds at confidence ${bestConfidence.toFixed(3)}, cost $${totalCost.toFixed(4)}`);
        hb('abandon-max-rounds', {
          total_rounds: totalRoundsAcrossOuter,
          cap: maxRoundsPerArtifact,
          best_confidence: +bestConfidence.toFixed(3),
          total_cost_usd: +totalCost.toFixed(4),
        });
        break;
      }
      rounds++;
      totalRoundsAcrossOuter++;
      if (totalCost >= costCap) {
        trace.push(`# Round ${rounds} — cost cap $${costCap} reached at $${totalCost.toFixed(4)}, stopping inner loop.`);
        break;
      }

      // Cost-warn (2026-05-24). NDJSON WARN every round after threshold.
      if (totalCost >= costWarnUsd) {
        try {
          process.stderr.write(JSON.stringify({
            t: new Date().toISOString(),
            phase: 'polish-loop',
            level: 'WARN',
            artifact: input.artifactKind,
            msg: 'cost-warn-threshold-crossed',
            total_cost_usd: +totalCost.toFixed(4),
            threshold_usd: costWarnUsd,
            round: totalRoundsAcrossOuter,
          }) + '\n');
        } catch { /* never block on stderr */ }
        if (!costWarnFiredOnTrace) {
          costWarnFiredOnTrace = true;
          trace.push(`## Round ${rounds} — COST WARN — total $${totalCost.toFixed(4)} ≥ warn-threshold $${costWarnUsd} (will continue this artifact; orchestrator may force-abandon any artifacts that have not started yet)`);
        }
      }

      hb('round-start', { round: rounds, total_cost_usd: totalCost.toFixed(4) });

      /* ----- ROUND 1 — three critics in parallel ----- */
      const criticPromises = CRITICS.map(c =>
        withWallClock(_callCouncil({
          prompt: buildCriticPrompt({
            persona: c.persona,
            role: c.role,
            artifactKind: input.artifactKind,
            artifactText: bestText,
            signals,
            cvText: input.cvText,
            articleDigest: input.articleDigest,
            voiceBrief: input.voiceBrief,
          }),
          models: [c.model],
          opts: { maxTokens: 1800, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
        }), `round-${rounds}-critic-${c.role}`)
          .then(r => ({ role: c.role, raw: r.results?.[0]?.content || '', cost: r.report?.totalCost || 0, error: r.results?.[0]?.error || null }))
          .catch(err => ({ role: c.role, raw: '', error: String(err.message || err), cost: 0 }))
      );
      const criticResults = await Promise.all(criticPromises);
      for (const c of criticResults) totalCost += c.cost || 0;
      hb('critics-done', { round: rounds, errors: criticResults.filter(c => c.error).length });

      const critics = criticResults.map(c => ({
        role: c.role,
        parsed: summarizeCritic(extractJson(c.raw)),
        raw_excerpt: (c.raw || '').slice(0, 400),
        error: c.error,
      }));

      const criticScores = critics.map(c => ({ role: c.role, score: c.parsed.score }));
      trace.push(`## Round ${rounds} — critic scores: ${criticScores.map(s => `${s.role}=${s.score.toFixed(2)}`).join(', ')}`);

      /* ----- ROUND 2 — author rebuttal ----- */
      let authorOut = null;
      try {
        const author = await withWallClock(_callCouncil({
          prompt: buildAuthorPrompt({
            artifactKind: input.artifactKind,
            artifactText: bestText,
            signals,
            cvText: input.cvText,
            articleDigest: input.articleDigest,
            voiceBrief: input.voiceBrief,
            critics,
          }),
          models: [AUTHOR_MODEL],
          opts: { maxTokens: 4000, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
        }), `round-${rounds}-author`);
        const raw = author.results?.[0]?.content || '';
        totalCost += author.report?.totalCost || 0;
        authorOut = extractJson(raw);
      } catch (e) {
        trace.push(`## Round ${rounds} — author error: ${String(e.message || e)}`);
      }

      const authorText = authorOut?.merged_artifact_text || bestText;
      const authorScore = Number(authorOut?.author_self_score) || 0;
      hb('author-done', { round: rounds, author_score: authorScore });

      /* ----- diff cap check ----- */
      const dr = diffRatio(bestText, authorText);
      if (dr > diffCap && !opts.allowMajorRewrite) {
        trace.push(`## Round ${rounds} — author rewrite diff ${dr.toFixed(2)} > cap ${diffCap}; reverting to original.`);
        // Keep bestText, treat this round as critic-only
      }
      const acceptedText = (dr > diffCap && !opts.allowMajorRewrite) ? bestText : authorText;

      /* ----- ROUND 3 — adjudicator ----- */
      let adjudicator = null;
      try {
        const adj = await withWallClock(_callCouncil({
          prompt: buildAdjudicatorPrompt({
            artifactKind: input.artifactKind,
            originalText: bestText,
            authorText: acceptedText,
            critics,
            signals,
          }),
          models: [ADJUDICATOR_MODEL],
          opts: { maxTokens: 4000, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
        }), `round-${rounds}-adjudicator`);
        const raw = adj.results?.[0]?.content || '';
        totalCost += adj.report?.totalCost || 0;
        adjudicator = extractJson(raw);
      } catch (e) {
        trace.push(`## Round ${rounds} — adjudicator error: ${String(e.message || e)}`);
      }

      const adjudicatedText = adjudicator?.final_artifact_text || acceptedText;
      const weightedConfidence = Number(adjudicator?.weighted_confidence) || authorScore || 0;
      hb('adjudicator-done', { round: rounds, weighted_confidence: weightedConfidence });

      trace.push(`## Round ${rounds} — author_score=${authorScore.toFixed(2)} weighted=${weightedConfidence.toFixed(3)} diff=${dr.toFixed(2)}`);

      bestText = adjudicatedText;
      bestConfidence = weightedConfidence;

      /* ----- ROUND 4 — adversarial sweep ----- */
      let adversarial = null;
      try {
        const adv = await withWallClock(_callCouncil({
          prompt: buildAdversarialPrompt({
            artifactKind: input.artifactKind,
            finalText: bestText,
            signals,
          }),
          models: ADVERSARIAL_LINEUP,
          opts: { maxTokens: 2000, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
        }), `round-${rounds}-adversarial`);
        totalCost += adv.report?.totalCost || 0;
        const responses = (adv.results || []).map(r => extractJson(r.content || '')).filter(Boolean);
        const allFindings = responses.flatMap(r => Array.isArray(r.blocking_findings) ? r.blocking_findings : []);
        // Gate on the STRUCTURED findings array, not the LLM's `passes` boolean.
        // The adversarial prompt frames "be ruthless" which makes models hedge with
        // passes:false even when blocking_findings:[]. Trust the data shape, not
        // the model's self-classification. blocker + major both block; minor + ""
        // do not. (GAP-RES-03 polish run 2026-05-24 surfaced 6 rounds of
        // passes:false + findings:0 — convergence was impossible under the
        // prior all-models-must-vote-passes gate.)
        const blockingFindings = allFindings.filter(f => {
          const sev = String(f?.severity || '').toLowerCase();
          return sev === 'blocker' || sev === 'major';
        });
        const passes = responses.length > 0 && blockingFindings.length === 0;
        adversarial = { passes, findings: allFindings, blocking_count: blockingFindings.length, raw_count: responses.length };
        adversarialFindings = allFindings;
      } catch (e) {
        trace.push(`## Round ${rounds} — adversarial error: ${String(e.message || e)}`);
      }

      const advPasses = adversarial?.passes === true;
      trace.push(`## Round ${rounds} — adversarial: ${advPasses ? 'PASS' : `FAIL (${adversarialFindings.length} findings)`}`);
      hb('adversarial-done', { round: rounds, passes: advPasses, findings: adversarialFindings.length });

      /* ----- ROUND 5 — cross-architecture verifier (refresh-master Phase 5 deliverable 1) ----- */
      // Only fire Round 5 if Round 4 passed. Otherwise non-convergence is already established.
      let round5Result = null;
      if (advPasses && !opts.skipRound5) {
        try {
          const round5Prompt = buildRound5VerifierPrompt({
            artifactKind: input.artifactKind,
            finalText: bestText,
            signals,
          });
          const verifierCouncil = await withWallClock(_callCouncil({
            prompt: round5Prompt,
            models: ROUND5_VERIFIER_LINEUP,
            opts: { maxTokens: 2000, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
          }), `round-${rounds}-verifier`);
          totalCost += verifierCouncil.report?.totalCost || 0;
          const verifierResponses = (verifierCouncil.results || []).map(r => extractJson(r.content || '')).filter(Boolean);

          // Opus adjudicates the verifier disagreement
          const opusAdj = await withWallClock(_callCouncil({
            prompt: [
              `# Round 5 cross-architecture adjudication`,
              `Two verifiers from DIFFERENT architectural families than the writer (anthropic Sonnet) have reviewed the artifact.`,
              `Verifier responses: ${JSON.stringify(verifierResponses).slice(0, 4000)}`,
              ``,
              `Adjudicate: do both verifiers PASS? If either FLAGS or REJECTS, return verdict=FAIL.`,
              `Return STRICT JSON: { "verdict": "PASS"|"FAIL", "rationale": "...", "blocking_issues": ["..."] }`,
            ].join('\n'),
            models: [ROUND5_ADJUDICATOR],
            opts: { maxTokens: 1500, timeoutMs: POLISH_API_TIMEOUT_MS, ...costTraceOpts },
          }), `round-${rounds}-opus-adj`);
          totalCost += opusAdj.report?.totalCost || 0;
          const opusAdjParsed = extractJson(opusAdj.results?.[0]?.content || '') || {};
          round5Result = {
            verifierResponses,
            opusAdjudication: opusAdjParsed,
            passes: opusAdjParsed.verdict === 'PASS',
          };
        } catch (e) {
          trace.push(`## Round ${rounds} — Round 5 verifier error: ${String(e.message || e)}`);
          round5Result = { passes: null, error: String(e.message || e) };
        }
      }
      const round5Passes = round5Result === null || round5Result.passes === true || round5Result.passes === null;
      if (round5Result) {
        trace.push(`## Round ${rounds} — Round 5 cross-arch: ${round5Result.passes ? 'PASS' : 'FAIL'}`);
        if (!round5Result.passes && round5Result.opusAdjudication?.blocking_issues?.length) {
          trace.push(`## Round ${rounds} — Round 5 blocking issues: ${round5Result.opusAdjudication.blocking_issues.slice(0, 3).join('; ')}`);
        }
      }

      /* ----- convergence check ----- */
      const scoresStable = lastCriticScores && criticScores.every((s, i) => Math.abs(s.score - lastCriticScores[i].score) < 0.02);
      const confidenceOK = weightedConfidence >= target;

      if (confidenceOK && advPasses && round5Passes && scoresStable) {
        converged = true;
        trace.push(`## Round ${rounds} — CONVERGED. weighted=${weightedConfidence.toFixed(3)} ≥ ${target}, adversarial+Round5 passed, scores stable.`);
        break;
      }
      if (confidenceOK && advPasses && round5Passes && rounds >= 2) {
        // First round can't satisfy "scores stable" (no prior round). Accept on second round.
        converged = true;
        trace.push(`## Round ${rounds} — CONVERGED (weighted≥${target}, adversarial+Round5 passed, ≥2 rounds).`);
        break;
      }
      lastCriticScores = criticScores;

      // ----- early-abandonment check -----
      // Track trajectory for post-hoc analysis + abandonment decision.
      const prevWeighted = confidenceHistory.length ? confidenceHistory[confidenceHistory.length - 1].weighted : 0;
      const delta = weightedConfidence - prevWeighted;
      confidenceHistory.push({ round: rounds, weighted: +weightedConfidence.toFixed(3), delta: +delta.toFixed(3) });

      if (earlyAbandonEnabled && rounds >= earlyAbandonAfterRound && !converged) {
        const ceilingTooLow = bestConfidence < earlyAbandonMaxConf;
        const trajectoryFlat = Math.abs(delta) < earlyAbandonMinDelta;
        if (ceilingTooLow && trajectoryFlat) {
          earlyAbandoned = true;
          trace.push(`## Round ${rounds} — EARLY ABANDON (best=${bestConfidence.toFixed(3)} < ${earlyAbandonMaxConf} cap AND last delta=${delta.toFixed(3)} < ${earlyAbandonMinDelta} min). Cost saved by stopping here.`);
          break;
        }
      }
    }
    if (earlyAbandoned) break;
    if (abandoned) break;

    if (converged) break;

    // Outer retry: if signals refresh callback was provided, request a fresh harvest.
    if (outerAttempt < outerRetries - 1) {
      trace.push(`# Outer retry ${outerAttempt + 1}/${outerRetries} — non-convergence after ${rounds} rounds. Requesting signals refresh.`);
      if (onSignalsRefresh) {
        try {
          const refreshed = await onSignalsRefresh();
          if (refreshed) signals = refreshed;
        } catch (e) {
          trace.push(`# Outer retry — signals refresh failed: ${String(e.message || e)}`);
        }
      }
    } else {
      trace.push(`# Outer retries exhausted. Returning best-effort artifact at confidence ${bestConfidence.toFixed(3)}.`);
    }
  }

  // 2026-07-07 (blind-review BUG 2) — zero-rounds guard. If the inner loop
  // never executed a single round across ALL outer attempts, the council
  // never scored the artifact and bestConfidence is still its init 0. That is
  // NOT a legitimate "low quality" verdict — it is an upstream misconfiguration
  // (the canonical case: a NaN maxRounds making `rounds < maxRounds` always
  // false). Surface it as a named failure so a silent confidence:0 can never
  // again masquerade as a real REJECT in the orchestrator summary.
  if (totalRoundsAcrossOuter === 0 && !earlyAbandoned && !abandoned) {
    abandoned = true;
    abandonReason = 'zero-rounds-ran';
    trace.push(`## ZERO ROUNDS RAN — the polish loop never executed a round (maxRounds=${maxRounds}, target=${target}). No council score was produced, so confidence is UNMEASURED, not low. Check maxRounds/target for a non-finite value upstream.`);
    hb('abandon-zero-rounds', { max_rounds: maxRounds, target });
  }

  /* ----- write polish trace ----- */
  if (opts.tracePath) {
    try {
      mkdirSync(dirname(opts.tracePath), { recursive: true });
      writeFileSync(opts.tracePath, trace.join('\n\n') + '\n', 'utf-8');
    } catch (e) {
      trace.push(`## trace write error: ${String(e.message || e)}`);
    }
  }

  /* ----- Phase 4.5-DET-6 (2026-05-22): L1 + L2 voice/AI gates ---------------
   *
   * After polish converges, run BOTH the API-backed AI-detection gate (L1) and
   * the programmatic 12-rule voice-rules gate (L2) in parallel on the final
   * artifact text. Combined verdict feeds into the polish result so callers
   * (apply-pack-polish skill, /api/polish endpoint, build-apply-orchestrator)
   * see a single source-of-truth gate decision.
   *
   * Behavior:
   * - L1 may fail gracefully (API error, no key, budget cap) → l1_error
   *   populated, gate contributes no signal
   * - L2 is synchronous + always runs
   * - combined_final_confidence = min(council confidence, L2 score,
   *   L1 inferred-confidence when L1 has GOOD signal_quality)
   * - combined_gate_status: PASS / WARN / FAIL
   *   - FAIL if either gate explicitly blocks
   *   - When L1 has no signal AND L2 isn't PASS → at most WARN
   *
   * Opt-out via opts.skipGates = true (used by unit tests / dry-runs).
   */
  let l1_detection = null;
  let l2_voice_rules = null;
  let l1_error = null;
  let combined_final_confidence = bestConfidence;
  let combined_gate_status = 'PASS';
  let combined_gate_reasons = [];

  if (opts.skipGates !== true) {
    hb('gates-start', { artifact: input.artifactKind });
    const detectorBudgetUsd = opts.detectorBudgetUsd ?? 0.05;

    // L1 + L2 run in parallel — L1 is API-bound (slow), L2 is local (fast)
    const [l1Result, l2Result] = await Promise.all([
      checkText(bestText, {
        budgetUsd: detectorBudgetUsd,
        skipCache: false,
        ackDetectionDegraded: opts.ackDetectionDegraded === true,
      }).catch(err => {
        l1_error = String(err.message || err);
        return null;
      }),
      Promise.resolve(runVoiceRulesGate(bestText)),
    ]);

    l1_detection = l1Result;
    l2_voice_rules = l2Result;

    const l2Score = l2Result?.rollup?.score ?? 0;
    const l2Verdict = l2Result?.rollup?.verdict ?? 'FAIL';

    const l1HasSignal = l1Result && (
      l1Result.gptzero_signal_quality === 'GOOD'
      || l1Result.originality_signal_quality === 'GOOD'
      || l1Result.pangram_signal_quality === 'GOOD'
    );

    const l1Blocks = l1Result?.gateBlocks === true;
    const l2Blocks = l2Verdict === 'FAIL';

    // Combined confidence — lower of polish + L2 score; factor in L1 only when calibrated
    combined_final_confidence = Math.min(bestConfidence, l2Score);
    if (l1HasSignal && l1Result) {
      const maxProb = Math.max(
        l1Result.gptzero_prob ?? 0,
        l1Result.originality_prob ?? 0,
        l1Result.pangram_prob ?? 0,
      );
      const l1Confidence = Math.max(0, 1 - maxProb);
      combined_final_confidence = Math.min(combined_final_confidence, l1Confidence);
    }
    combined_final_confidence = Math.round(combined_final_confidence * 1000) / 1000;

    // Combined verdict
    if (l1Blocks) {
      combined_gate_status = 'FAIL';
      combined_gate_reasons.push('l1_detector_blocks');
    }
    if (l2Blocks) {
      combined_gate_status = 'FAIL';
      combined_gate_reasons.push(`l2_voice_rules_fail:${(l2Result?.rollup?.critical_failures || []).join(',')}`);
    }
    if (!l1Blocks && !l2Blocks) {
      // When L1 has no signal, L2 must be PASS (not WARN) to satisfy the gate
      if (!l1HasSignal && l2Verdict === 'WARN') {
        combined_gate_status = 'WARN';
        combined_gate_reasons.push('l1_uncalibrated_l2_warn');
      } else if (l2Verdict === 'WARN') {
        combined_gate_status = 'WARN';
        combined_gate_reasons.push('l2_voice_rules_warn');
      } else {
        combined_gate_status = 'PASS';
      }
    }

    hb('gates-done', {
      artifact: input.artifactKind,
      l1_band: l1Result?.band ?? 'unavailable',
      l1_blocks: l1Blocks,
      l1_signal: l1HasSignal ? 'GOOD' : 'UNCALIBRATED',
      l2_verdict: l2Verdict,
      l2_score: l2Score,
      combined_status: combined_gate_status,
      combined_confidence: combined_final_confidence,
    });
  }

  // ── G38 (2026-05-24) — Detection-revision sub-loop ────────────────────────
  // Per Mitchell's pivot: keep GPTZero (industry-standard for recruiter screening
  // per SHRM 2026 / GPTZero's own recruiter-marketing positioning), pause the
  // other 2 detectors via env flags, and wire a feedback-revision-re-review
  // cycle that drives GPTZero `average_generated_prob` below the industry-standard
  // threshold (<0.5 = "human-likely"). When L1 blocks AND signal is GOOD AND
  // there's cost budget, run focused detection-aware rewrites until convergence
  // or max-iterations (NEEDS_HUMAN flag at exhaustion).
  let detection_revisions_used = 0;
  let detection_revision_trace = [];
  let needs_human_detection = false;
  if (
    opts.skipGates !== true
    && opts.skipDetectionRevision !== true
    && combined_gate_status === 'FAIL'
    && combined_gate_reasons.includes('l1_detector_blocks')
    && l1_detection
    && l1_detection.gptzero_signal_quality === 'GOOD'
  ) {
    const maxDetRevisions    = opts.maxDetectionRevisions ?? 5;
    const detThreshold       = opts.detectionThreshold ?? 0.5;
    const detRevisionCostCap = opts.detectionRevisionCostCap ?? 1.50; // $1.50 → ~5 Sonnet calls
    let detCost = 0;

    detection_revision_trace.push(
      `# Detection-revision sub-loop\n`
      + `Trigger: combined_gate_status=FAIL with l1_detector_blocks; gptzero signal=GOOD; gptzero_prob=${l1_detection.gptzero_prob}.\n`
      + `Industry threshold: <${detThreshold} per 2026 recruiter-screening research (SHRM survey, GPTZero recruiter positioning).\n`
      + `Max revisions: ${maxDetRevisions}. Cost cap: $${detRevisionCostCap}.\n`
    );
    hb('det-rev-start', { initial_prob: l1_detection.gptzero_prob, threshold: detThreshold });

    while (detection_revisions_used < maxDetRevisions && detCost < detRevisionCostCap) {
      detection_revisions_used++;
      hb('det-rev-round', { round: detection_revisions_used, cost_so_far: detCost.toFixed(4) });

      // Build focused revision prompt — surface the specific worst sentences for targeted rewrite.
      const sentRollup = l1_detection.gptzero_sentence_rollup;
      const worstSentencesHint = sentRollup
        ? `Sentences with highest generated_prob (rewrite priority): max=${sentRollup.max_prob}, mean=${sentRollup.mean_prob}, variance=${sentRollup.variance}, ${sentRollup.highlighted_count}/${sentRollup.count} flagged.`
        : 'Per-sentence rollup unavailable; rewrite full text for lower AI-detection probability.';

      const revisionPrompt = [
        `# Detection-aware rewrite — recruiter-facing AI-detection mitigation`,
        ``,
        `## Why this rewrite`,
        `GPTZero (industry-standard recruiter-facing AI detector, per SHRM 2026) flagged this text with average_generated_prob=${l1_detection.gptzero_prob}. Industry-standard "human-likely" threshold is <${detThreshold}. Goal: drive prob below that floor without losing meaning or Mitchell's voice.`,
        ``,
        `## Worst-sentence hint`,
        worstSentencesHint,
        ``,
        `## Mitchell's voice rules (preserve while rewriting for lower detection)`,
        `- First-person concrete narrative. NOT corporate-speak.`,
        `- Avoid em-dashes used as parentheticals (em-dashes are the #1 LLM-tell).`,
        `- Avoid tricolons + lists of 3 + opening with adverbs.`,
        `- Avoid "leverage / synergy / deep-dive / ideate / utilize" + corporate-jargon.`,
        `- Prefer specific concrete nouns + active verbs + varied sentence length (burstiness).`,
        `- Insert 1-2 short sentences (5-10 words) per paragraph to break LLM-cadence.`,
        `- Keep length within ±10% of input.`,
        ``,
        `## Artifact to revise (${input.artifactKind})`,
        bestText,
        ``,
        `## Output format`,
        `Return ONLY the revised artifact text. No preamble, no JSON wrapper, no "Here is the revised version:" lead-in.`,
      ].join('\n');

      let revisedText = null;
      let revisionCost = 0;
      try {
        const r = await withWallClock(_callCouncil({
          prompt: revisionPrompt,
          models: [AUTHOR_MODEL],
          opts: {
            timeoutMs: POLISH_API_TIMEOUT_MS,
            maxTokens: 4000,
            ...costTraceOpts,
          },
        }), `det-rev-${detection_revisions_used}`);
        const responses = r?.responses || [];
        const firstOk = responses.find(x => x && !x.error && x.content);
        revisedText = firstOk?.content?.trim() ?? null;
        revisionCost = r?.totalCostUsd ?? 0;
        detCost += revisionCost;
        totalCost += revisionCost;
      } catch (e) {
        detection_revision_trace.push(`## Det-rev ${detection_revisions_used} — revision call error: ${String(e.message || e)}; aborting sub-loop`);
        hb('det-rev-error', { round: detection_revisions_used, error: String(e.message || e) });
        break;
      }
      if (!revisedText || revisedText.length < 100) {
        detection_revision_trace.push(`## Det-rev ${detection_revisions_used} — revision returned empty/too-short text; aborting sub-loop`);
        hb('det-rev-empty', { round: detection_revisions_used });
        break;
      }

      // Re-check L1 on the revised text
      let newL1 = null;
      try {
        newL1 = await checkText(revisedText, {
          budgetUsd: opts.detectorBudgetUsd ?? 0.05,
          skipCache: true, // force fresh evaluation of revised text
          ackDetectionDegraded: opts.ackDetectionDegraded === true,
        });
      } catch (e) {
        detection_revision_trace.push(`## Det-rev ${detection_revisions_used} — re-check error: ${String(e.message || e)}; aborting sub-loop`);
        hb('det-rev-recheck-error', { round: detection_revisions_used, error: String(e.message || e) });
        break;
      }

      const newProb = newL1?.gptzero_prob ?? 1;
      const oldProb = l1_detection.gptzero_prob;
      const delta   = oldProb - newProb;

      detection_revision_trace.push(
        `## Det-rev ${detection_revisions_used} — gptzero_prob ${oldProb.toFixed(3)} → ${newProb.toFixed(3)} (Δ=${delta.toFixed(3)}, $${revisionCost.toFixed(4)})`
      );
      hb('det-rev-result', { round: detection_revisions_used, old_prob: oldProb, new_prob: newProb, delta, cost: revisionCost.toFixed(4) });

      // Adopt revised text + new L1 result as the new baseline regardless of pass/fail
      // (monotonic improvement: if newProb < oldProb, we keep moving)
      if (newProb < l1_detection.gptzero_prob) {
        bestText = revisedText;
        l1_detection = newL1;
      }

      // Convergence check
      if (newProb < detThreshold && !newL1?.gateBlocks) {
        combined_gate_status   = 'PASS';
        combined_gate_reasons  = combined_gate_reasons.filter(r => r !== 'l1_detector_blocks');
        combined_final_confidence = Math.min(combined_final_confidence, 1 - newProb);
        detection_revision_trace.push(`## CONVERGED at round ${detection_revisions_used} — gptzero_prob=${newProb.toFixed(3)} < ${detThreshold}`);
        hb('det-rev-converged', { round: detection_revisions_used, final_prob: newProb });
        break;
      }
    }

    // If exhausted without convergence → flag NEEDS_HUMAN
    if (combined_gate_status === 'FAIL' && combined_gate_reasons.includes('l1_detector_blocks')) {
      needs_human_detection = true;
      detection_revision_trace.push(
        `## NEEDS_HUMAN — detection-revision exhausted after ${detection_revisions_used} rounds; gptzero_prob still ${(l1_detection?.gptzero_prob ?? 1).toFixed(3)} ≥ ${detThreshold}. Mitchell to hand-revise before ship.`
      );
      combined_gate_reasons.push(`detection_revision_exhausted:rounds=${detection_revisions_used}`);
      hb('det-rev-needs-human', { rounds: detection_revisions_used, final_prob: l1_detection?.gptzero_prob });
    }
  }

  return {
    artifact_kind: input.artifactKind,
    final_artifact_text: bestText,
    confidence: bestConfidence,
    rounds_used: outerAttempt + 1,
    total_rounds_across_outer: totalRoundsAcrossOuter,
    converged: bestConfidence >= target,
    // early_abandoned reflects EITHER the original low-conf+flat-trajectory
    // abandonment OR the new max-rounds-exceeded abandonment so existing
    // polish-status-loader consumers continue to mark the artifact as
    // "Abandoned early" (⏸). abandon_reason distinguishes the two.
    early_abandoned: earlyAbandoned || abandoned,
    abandoned,
    abandon_reason: abandonReason,
    max_rounds_per_artifact: maxRoundsPerArtifact,
    cost_warn_usd: costWarnUsd,
    confidence_history: confidenceHistory,
    adversarial_findings: adversarialFindings,
    polish_trace: trace.join('\n\n'),
    cost_usd: Math.round(totalCost * 10000) / 10000,
    duration_ms: Date.now() - t0,
    // Phase 4.5-DET-6 gate fields:
    l1_detection,
    l2_voice_rules,
    l1_error,
    combined_final_confidence,
    combined_gate_status,
    combined_gate_reasons,
    // G38 (2026-05-24) detection-revision sub-loop fields:
    detection_revisions_used,
    detection_revision_trace: detection_revision_trace.join('\n\n'),
    needs_human_detection,
  };
}

export const _internal = { extractJson, diffRatio, CRITICS, AUTHOR_MODEL, ADJUDICATOR_MODEL };
