#!/usr/bin/env node
/**
 * scripts/run-council.mjs — General-purpose runner for ~/.claude/agents/council-of-models.
 *
 * Reads a prompt from a file, fans it out to every model whose API key is set
 * via lib/council.mjs, writes the full JSON response to an output path, and
 * prints a one-line summary (also JSON) to stdout.
 *
 * Usage:
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json \
 *        --models perplexity:sonar-deep-research,xai:grok-4,openai:gpt-5
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json --max-tokens 8000
 *
 *   # Defaults (2026-07-04): --max-tokens 32000, --timeout-ms 3600000 (60 min —
 *   # callCouncil's hang-prevention ceiling). Output caps and run-time
 *   # constraints were removed as defaults per Mitchell's Decision-Maximization
 *   # Policy after the 2026-07-04 council-brief run truncated Opus + both
 *   # Perplexity models at 6k tokens and starved gpt-5.5 to an empty
 *   # completion (reasoning tokens consumed the whole budget). Pass explicit
 *   # lower values only for cheap smoke tests.
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json \
 *        --max-tokens 4000 --timeout-ms 180000   # smoke-test sizing
 *
 *   # Opt-in: probe each model's year-belief before firing the real prompt.
 *   # Drops any model that answers ≥ tolerance years off from system clock.
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json --probe
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json --probe --probe-tolerance 0
 *
 *   # Disable the automatic jailbreak-refusal retry (forensic / raw-response mode).
 *   node scripts/run-council.mjs --prompt /tmp/prompt.txt --out /tmp/council.json --no-retry-refusal
 *
 * Designed to be invoked by the council-of-models agent in ~/.claude/agents/.
 *
 * Hang-prevention: lib/council.mjs already wraps every provider call in
 * AbortSignal.timeout(opts.timeoutMs) and reads bodies via lib/safe-fetch.mjs's
 * readJson/readText (which adds the body-read timeout pattern). See AGENTS.md
 * § Bug class: missing-timeout-on-long-running-operation and
 * ~/.claude/knowledge/brain/bug-class-catalog.md.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

try {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });
} catch { /* dotenv optional */ }

import { callCouncil, probeLineup, extractRichContent } from '../lib/council.mjs';

const args = process.argv.slice(2);
function arg(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
function hasFlag(flag) {
  return args.includes(flag);
}

const promptPath      = arg('--prompt');
const outPath         = arg('--out', '/tmp/council-report.json');
const modelsRaw       = arg('--models', '');
// Defaults raised 2026-07-04 per Mitchell's directive: no output cap, no
// run-time constraint on council runs (quality > speed > cost). 32000 output
// tokens is at-or-under every wired provider's ceiling (Anthropic/OpenAI/
// Gemini/xAI/Perplexity) and prevents both reasoning-token starvation
// (gpt-5.5 empty-completion mode) and mid-section truncation. 3600000ms
// (60 min) is callCouncil's hang-prevention ceiling — effectively uncapped
// for any real model call while still hang-proof.
const maxTokens       = parseInt(arg('--max-tokens', '32000'), 10);
const timeoutMs       = parseInt(arg('--timeout-ms', '3600000'), 10);
const doProbe         = hasFlag('--probe');
const probeTolerance  = parseInt(arg('--probe-tolerance', '1'), 10);
const retryOnRefusal  = !hasFlag('--no-retry-refusal');

if (!promptPath) {
  console.error('Usage: node scripts/run-council.mjs --prompt <file> --out <file> [--models a,b]');
  console.error('       [--max-tokens N] [--timeout-ms N] [--probe [--probe-tolerance N]] [--no-retry-refusal]');
  console.error('       Defaults: --max-tokens 32000, --timeout-ms 3600000 (60min ceiling). Uncapped by default.');
  process.exit(1);
}

const prompt = readFileSync(promptPath, 'utf-8');
let models = modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;

// Optional pre-flight: probe each model's year-belief. Drops any model whose
// year-answer is off by more than --probe-tolerance years. Cheap (~$0.01) and
// 2-5s wall-clock, but saves money on real runs when a model is jailbreak-
// refusing or fundamentally confused about the date.
let probeResults = null;
if (doProbe) {
  probeResults = await probeLineup(models, { tolerance: probeTolerance });
  const drops = probeResults.filter(p => !p.passes).map(p => p.model);
  if (drops.length) {
    const keep = probeResults.filter(p => p.passes).map(p => p.model);
    console.error(JSON.stringify({
      probe: 'dropped',
      dropped: probeResults.filter(p => !p.passes).map(p => ({ model: p.model, year: p.year, raw: p.raw, error: p.error })),
      keep,
    }, null, 2));
    models = keep;
  }
}

const report = await callCouncil({ prompt, models, opts: { timeoutMs, maxTokens, retryOnRefusal } });
if (probeResults) report.probe = probeResults;
writeFileSync(outPath, JSON.stringify(report, null, 2));

const ok = report.results.filter(r => !r.error).length;
const failed = report.results.filter(r => r.error).length;
const jailbreakRetries = report.results.filter(r => r.jailbreakRetry).length;
const jailbreakRefused = report.results.filter(r => r.jailbreakRefusal).length;

console.log(JSON.stringify({
  ok,
  failed,
  skipped: report.missingKeys.length,
  jailbreakRetries,
  jailbreakRefused,
  totalMs: report.totalMs,
  models: report.results.map(r => {
    // Use extractRichContent (added 2026-05-18 meta-audit v2 P0 #1) to capture
    // the new `think` and `grounding_urls` fields uniformly — these were being
    // silently dropped before.
    const rich = extractRichContent(r);
    return {
      model: r.model,
      error: r.error || null,
      tokens: rich.tokens,
      citations: rich.citations.length,
      grounding_urls: rich.grounding_urls.length,
      think_chars: rich.think.length,
      ms: rich.ms,
      chars: rich.content.length,
      ...(r.jailbreakRetry ? { jailbreakRetry: true } : {}),
      ...(r.jailbreakRefusal ? { jailbreakRefusal: r.jailbreakRefusal } : {}),
    };
  }),
  missingKeys: report.missingKeys,
  probe: probeResults || undefined,
  out: outPath,
}, null, 2));
