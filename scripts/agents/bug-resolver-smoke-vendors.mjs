#!/usr/bin/env node
// scripts/agents/bug-resolver-smoke-vendors.mjs
//
// Smoke-test the 3 vendors bug-resolver uses (Gemini 3.1 Pro / GPT-5 / Grok-4).
// One trivial prompt per vendor to confirm wiring + capture per-call cost baseline.
//
// Per Phase 2 Step 1 of data/bug-resolver-plan.md. Budget cap: $5 total.
//
// Run: node scripts/agents/bug-resolver-smoke-vendors.mjs

import 'dotenv/config';
import { callCouncil } from '../../lib/council.mjs';

const MODELS = [
  'google:gemini-2.5-pro',   // auto-escalates to gemini-3.1-pro-preview
  'openai:gpt-5',            // auto-escalates to gpt-5.5 if account has access
  'xai:grok-4',              // grok-4 (substrate may auto-resolve per xAI account tier)
];

const PROMPT = 'Respond with exactly the word PONG. No other text. No explanation.';

async function main() {
  console.log(`[smoke-vendors] start ${new Date().toISOString()}`);
  console.log(`[smoke-vendors] models: ${MODELS.join(', ')}`);
  console.log(`[smoke-vendors] prompt: "${PROMPT}"`);
  console.log('');

  const result = await callCouncil({
    prompt: PROMPT,
    models: MODELS,
    opts: {
      timeoutMs: 90_000,
      maxTokens: 200, // Gemini 3.1 Pro thinking-budget needs headroom; 20 was too small
      systemPrompt: '', // no date anchor — keep prompt minimal for cost
    },
  });

  // callCouncil returns { results: [{model, content, error?, ms, costUsd, tokens?, ...}, ...], missingKeys, totalMs }
  const results = result.results || [];
  let totalCost = 0;

  if (result.missingKeys && result.missingKeys.length > 0) {
    console.log('Missing API keys / undispatchable models:');
    for (const mk of result.missingKeys) {
      if (mk.undispatchable) {
        // Model-id problem, not an env problem — missingEnvVar carries the
        // 'N/A (not dispatchable)' sentinel. Bug class:
        // pricing-map-entry-without-dispatch-block.
        console.log(`  ${mk.model}: NOT DISPATCHABLE — ${mk.reason}${mk.suggestion ? ` (use "${mk.suggestion}")` : ''}`);
      } else {
        console.log(`  ${mk.model}: ${mk.missingEnvVar} not set`);
      }
    }
    console.log('');
  }

  console.log('Per-vendor results:');
  console.log('  Model                          Status   Tokens   Cost($)   Latency(s)   Reply');
  console.log('  -----                          ------   ------   -------   ----------   -----');

  for (const r of results) {
    const ok = !r.error && r.content;
    const status = ok ? 'OK' : 'ERR';
    const cost = Number(r.costUsd) || 0;
    totalCost += cost;
    const reply = ok
      ? (r.content || '').trim().slice(0, 30).replace(/\n/g, ' ')
      : (r.error || 'no-content').slice(0, 50).replace(/\n/g, ' ');
    console.log(
      `  ${(r.model || '?').padEnd(30)} ` +
      `${status.padEnd(6)}   ` +
      `${String(r.tokens || 0).padStart(6)}   ` +
      `${cost.toFixed(4).padStart(7)}   ` +
      `${((r.ms || 0) / 1000).toFixed(1).padStart(10)}   ` +
      `${reply}`
    );
  }

  console.log('');
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Total council time: ${(result.totalMs / 1000).toFixed(1)}s`);
  const allOk = results.length > 0 && results.every(r => !r.error && r.content);
  console.log(`Verdict: ${allOk ? 'ALL VENDORS WORKING' : 'SOME VENDORS FAILED OR ABSENT'}`);
  console.log(`[smoke-vendors] done ${new Date().toISOString()}`);

  if (!allOk) process.exit(1);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack || '');
  process.exit(2);
});
