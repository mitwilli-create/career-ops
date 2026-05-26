/**
 * lib/github-cleaner/gate.mjs — Phase 4B of github-cleaner.
 *
 * The voice + AI-detector gate. Every artifact from Phase 4A passes through
 * here before it can be shipped in Phase 5. Loop, max 3 cycles:
 *   1. Voice match (target ≥ 80) against lib/voice-corpus.mjs baseline.
 *   2. AI-detection (target each < 60%, signal_quality not USELESS) via
 *      lib/ai-detection-gate.mjs (GPTZero + Originality + Pangram).
 *   3. If both PASS → return PASS, ship.
 *   4. If either FAILS → return failure modes for generate.mjs to remediate.
 *   5. After 3 failed cycles → SKIP, save to drafts/, surface in report.
 *
 * See: data/github-cleaner-design-2026-05-22.md § Phase 4B.
 */

import { checkText } from '../ai-detection-gate.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const DESIGN_DOC_REF = 'data/github-cleaner-design-2026-05-22.md § Phase 4B';

/** Voice match target — stylometric similarity score (0-100) against corpus. */
export const VOICE_MATCH_TARGET = 80;

/** AI-detection target — each detector prob must be below this. */
export const DETECTOR_PROB_THRESHOLD = 0.60;

/** Max retry cycles before SKIP. */
export const MAX_GATE_CYCLES = 3;

// Buzzword tells (AI-generated "tells") — presence → lower voice score
const BUZZWORD_PATTERNS = [
  /rapidly evolving/i,
  /cutting[- ]edge/i,
  /unlock(s|ing)?\s+(value|potential|power)/i,
  /in today'?s\s+/i,
  /leverag(ed?|ing)\s+(the\s+)?(power|capabilities)/i,
  /at the intersection of/i,
  /game[- ]changer/i,
  /paradigm shift/i,
  /\bseamless(ly)?\b/i,
  /\bsynerg(y|ies|istic)\b/i,
  /robust\s+solution/i,
  /scalable\s+platform/i,
  /\bempowering\b/i,
  /\bdeliver(ing)?\s+value\b/i,
  /\bdriving\s+impact\b/i,
  /\btransformative\b/i,
  /\bworld-?class\b/i,
  /\binnovative\s+solution/i,
  /\bbest-?in-?class\b/i,
];

// Mitchell signature constructions — presence → higher voice score
const MITCHELL_TELL_PATTERNS = [
  /\b— [a-z]/,                    // em-dash + lowercase
  /\baudience(s)?\b/i,
  /\b(build|built|building|ship(ped|ping)?)\b/i,
  /\bsignal(s)?\b/i,
  /\bhuman[- ]readable\b/i,
  /\bproof[- ]of[- ]work\b/i,
  /\ba[gt](ent|ents)?\b/i,
  /\bpipeline(s)?\b/i,
  /\bstorytelll?er\b/i,
  /\bnarrative\b/i,
  /\bclaim(s)?\b/i,
];

/**
 * Voice-match scoring (0–100). Compares stylometric features against corpus.
 * Uses the lexical approach from voice-drift-monitor.mjs:
 *   - Buzzword rate (lower = better score)
 *   - Mitchell tell rate (higher = better score)
 *   - Sentence length distribution vs corpus baseline
 */
export async function voiceMatchScore(content, voiceCorpusBaseline) {
  if (!content || content.trim().length < 50) return 50;

  const words = content.split(/\s+/).filter(Boolean);
  const wordCount = words.length || 1;

  // Sentence length analysis
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const avgSentenceWords = sentences.length > 0
    ? sentences.reduce((s, sent) => s + sent.split(/\s+/).length, 0) / sentences.length
    : wordCount;

  // Corpus baseline (from voice-corpus.mjs or fallback)
  let baseline = voiceCorpusBaseline;
  if (!baseline) {
    baseline = {
      avgSentenceWords: 18,
      mitchellTellRatePer100: 1.5,
      buzzwordRatePer100: 0.05,
    };
    // Try to load from voice-corpus.mjs
    try {
      const { loadHumanBaselineProse } = await import('../voice-corpus.mjs');
      const proseEntries = loadHumanBaselineProse();
      if (proseEntries.length > 0) {
        const sampleProse = proseEntries.map(e => e.prose || '').join(' ').slice(0, 5000);
        if (sampleProse.length > 200) {
          const sampleSentences = sampleProse.split(/[.!?]+/).filter(s => s.trim().length > 10);
          baseline.avgSentenceWords = sampleSentences.length > 0
            ? sampleSentences.reduce((s, sent) => s + sent.split(/\s+/).length, 0) / sampleSentences.length
            : 18;
          const sampleWords = sampleProse.split(/\s+/).filter(Boolean).length || 1;
          baseline.mitchellTellRatePer100 = (MITCHELL_TELL_PATTERNS.filter(p => p.test(sampleProse)).length / sampleWords) * 100;
          baseline.buzzwordRatePer100 = (BUZZWORD_PATTERNS.filter(p => p.test(sampleProse)).length / sampleWords) * 100;
        }
      }
    } catch { /* voice-corpus.mjs may not exist */ }
  }

  // Compute metrics for this content
  const buzzwordHits = BUZZWORD_PATTERNS.filter(p => p.test(content)).length;
  const mitchellHits = MITCHELL_TELL_PATTERNS.filter(p => p.test(content)).length;
  const buzzwordRate = (buzzwordHits / wordCount) * 100;
  const mitchellRate = (mitchellHits / wordCount) * 100;

  // Score components (each 0–100, then weighted average)
  // 1. Sentence length similarity (close to baseline = high score)
  const sentLenDelta = Math.abs(avgSentenceWords - (baseline.avgSentenceWords || 18));
  const sentLenScore = Math.max(0, 100 - sentLenDelta * 8);

  // 2. Buzzword penalty (few buzzwords = high score)
  const buzzwordPenalty = Math.min(50, buzzwordHits * 12);
  const buzzwordScore = Math.max(0, 100 - buzzwordPenalty);

  // 3. Mitchell tell bonus (more Mitchell-isms = higher score)
  const mitchellBonus = Math.min(100, mitchellHits * 15);

  // Weighted composite
  const composite = (
    sentLenScore * 0.35 +
    buzzwordScore * 0.40 +
    mitchellBonus * 0.25
  );

  return Math.round(Math.min(100, Math.max(0, composite)));
}

/**
 * Run the 3-detector AI gate via the existing lib/ai-detection-gate.mjs.
 */
export async function runDetectorGate(content, opts = {}) {
  const result = await checkText(content, { budgetUsd: opts.budgetUsd ?? 0.15 });
  const detectorProbs = {
    gptzero: result.gptzero_prob,
    originality: result.originality_prob,
    pangram: result.pangram_prob,
  };
  const maxProb = Math.max(
    ...Object.values(detectorProbs).filter(p => typeof p === 'number')
  );
  const passes = maxProb < DETECTOR_PROB_THRESHOLD && result.signal_quality !== 'USELESS';
  return { passes, max_prob: maxProb, detector_probs: detectorProbs, signal_quality: result.signal_quality, raw: result };
}

/**
 * Identify which sentences the detector flagged.
 * Pangram returns per-sentence scores; Originality returns per-paragraph.
 */
export function identifyFlaggedSentences(content, detectorResult) {
  const flagged = [];

  // Try Pangram's per-sentence scores
  const pangram = detectorResult?.raw?.pangram_sentences || detectorResult?.raw?.per_sentence;
  if (Array.isArray(pangram)) {
    for (const item of pangram) {
      if ((item.score || item.ai_prob || 0) > 0.5) {
        flagged.push(item.text || item.sentence || '');
      }
    }
    if (flagged.length > 0) return flagged.filter(Boolean).slice(0, 5);
  }

  // Originality per-paragraph scores
  const originality = detectorResult?.raw?.originality_paragraphs;
  if (Array.isArray(originality)) {
    for (const para of originality) {
      if ((para.ai_score || para.score || 0) > 0.5) {
        flagged.push(para.text || para.paragraph || '');
      }
    }
    if (flagged.length > 0) return flagged.filter(Boolean).slice(0, 5);
  }

  // Fallback: heuristic — sentences containing buzzwords are likely flagged
  if (detectorResult?.max_prob > DETECTOR_PROB_THRESHOLD || detectorResult?.raw?.max_prob > DETECTOR_PROB_THRESHOLD) {
    const sentences = content.split(/[.!?]+\s*/).filter(s => s.trim().length > 20);
    for (const s of sentences) {
      if (BUZZWORD_PATTERNS.some(p => p.test(s))) {
        flagged.push(s.trim());
      }
    }
  }

  return flagged.filter(Boolean).slice(0, 5);
}

/**
 * Run the gate on a single artifact.
 *
 * @param {{ content: string, kind: string }} artifact
 * @param {object} opts - { voiceCorpusEntries, detectorBudgetUsd, debugLog }
 * @returns {Promise<{ pass: boolean, voice_score: number, detector_result: object, failure_modes: string[], cycles_used: number, cost_usd: number }>}
 */
export async function runGate(artifact, opts = {}) {
  const { content, kind } = artifact;
  let costUsd = 0;
  const failureModes = [];
  let flaggedSentences = [];

  // 1. Voice match
  let voiceScore = 50;
  try {
    voiceScore = await voiceMatchScore(content, opts.voiceCorpusEntries || null);
  } catch (e) {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'gate', step: 'voice_error', error: String(e.message).slice(0, 120) }) + '\n');
  }

  const voicePasses = voiceScore >= VOICE_MATCH_TARGET;
  if (!voicePasses) {
    failureModes.push('voice_match');
  }

  // 2. AI detector gate
  let detectorResult = { passes: null, max_prob: null, signal_quality: null };
  try {
    detectorResult = await runDetectorGate(content, { budgetUsd: opts.detectorBudgetUsd ?? 0.15 });
    costUsd += detectorResult.raw?.cost_usd_estimate || 0.04;
  } catch (e) {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), phase: 'gate', step: 'detector_error', error: String(e.message).slice(0, 120) }) + '\n');
    // Detector failed — don't block on it (fail-open per Closure 3.09)
    detectorResult = { passes: true, max_prob: null, signal_quality: 'USELESS' };
  }

  const detectorPasses = detectorResult.passes === null || detectorResult.passes === true;
  if (!detectorPasses) {
    failureModes.push('detector');
    flaggedSentences = identifyFlaggedSentences(content, detectorResult);
  }

  const pass = voicePasses && detectorPasses;

  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(), phase: 'gate', step: 'result',
    kind, pass, voice_score: voiceScore, detector_max_prob: detectorResult.max_prob,
    failure_modes: failureModes,
  }) + '\n');

  return {
    pass,
    voice_score: voiceScore,
    detector_result: detectorResult,
    failure_modes: failureModes,
    flagged_sentences: flaggedSentences,
    cycles_used: 1,
    cost_usd: costUsd,
  };
}
