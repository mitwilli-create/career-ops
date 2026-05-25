#!/usr/bin/env node
/**
 * scripts/instance-d-pangram-probe.mjs — GAP-RES-06 diagnostic probe.
 *
 * Direct manual Pangram v3 calls with 4 samples spanning length + register:
 *   short_human   — single-sentence human prose
 *   long_human    — full 500+ word story from data/human-examples/
 *   short_ai      — single-sentence AI-decoy prose
 *   long_ai_decoy — full 500+ word AI-decoy prose
 *
 * Dumps RAW JSON response per sample to data/instance-d-pangram-probe-2026-05-24.json
 * + a markdown summary so the field-shape diff vs the parser at
 * lib/ai-detection-gate.mjs::callPangram is fully transparent.
 *
 * Also calls GPTZero + Originality once each on long_human for sanity (the
 * existing field-audit only covers short samples).
 *
 * Spend: ~$0.10 (8 detector calls).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* ignore */ }

const SHORT_HUMAN = `I started writing this at 11 pm because my brain finally let go of the spreadsheet I'd been chewing on all day. Three rows in pivot, one merged cell that wasn't supposed to be merged, and the AVERAGEIFS was quietly skipping blanks because somebody had typed "n/a" into a column expecting numbers. I killed the merge, swapped the n/a's for empty cells, and the pivot finally agreed with the source-of-truth dashboard. Tiny win. Still annoyed about the two hours.`;

const SHORT_AI = `In today's rapidly evolving landscape, it is important to leverage data-driven insights to navigate complex challenges. Furthermore, organizations must streamline operations and foster a culture of continuous improvement.`;

const LONG_HUMAN_PATH = 'data/human-examples/sample-02-stream-launch-night-breaking-news.md';
const LONG_HUMAN = readFileSync(join(ROOT, LONG_HUMAN_PATH), 'utf-8');

const LONG_AI_DECOY = `In today's rapidly evolving landscape, it is imperative that we leverage data-driven insights to navigate complex challenges. Furthermore, organizations must streamline operations and foster a culture of continuous improvement. By harnessing the power of artificial intelligence, stakeholders can unlock new opportunities and drive transformative growth across the enterprise. Moreover, embracing innovation and championing best practices will ensure that we remain at the forefront of our industry. As we navigate the complexities of the modern business landscape, it becomes increasingly important to align cross-functional teams around a unified vision. By fostering collaboration and breaking down silos, we can unlock synergies that propel organizations toward sustainable growth. Embracing a holistic approach to talent development empowers individuals to thrive while driving collective success.`;

async function callPangramRaw(text, label) {
  const key = process.env.PANGRAM_API_KEY;
  if (!key) return { error: 'PANGRAM_API_KEY missing' };
  const t0 = Date.now();
  try {
    const resp = await fetch('https://text.api.pangram.com/v3', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 5000) }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* leave raw */ }
    return {
      label,
      http_status: resp.status,
      elapsed_ms: Date.now() - t0,
      input_word_count: text.split(/\s+/).filter(Boolean).length,
      input_char_count: text.length,
      raw_body: body.slice(0, 4000),
      parsed,
      top_level_keys: parsed ? Object.keys(parsed) : null,
      fraction_human: parsed?.fraction_human ?? null,
      fraction_ai_assisted: parsed?.fraction_ai_assisted ?? null,
      fraction_ai: parsed?.fraction_ai ?? null,
      headline: parsed?.headline ?? null,
      version: parsed?.version ?? null,
    };
  } catch (e) {
    return { label, error: String(e?.message || e), elapsed_ms: Date.now() - t0 };
  }
}

async function callGPTZeroRaw(text, label) {
  const key = process.env.GPTZERO_API_KEY;
  if (!key) return { error: 'GPTZERO_API_KEY missing' };
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.gptzero.me/v2/predict/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ document: text.slice(0, 5000), multilingual: false }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* leave raw */ }
    const doc = parsed?.documents?.[0] || null;
    return {
      label,
      http_status: resp.status,
      elapsed_ms: Date.now() - t0,
      input_word_count: text.split(/\s+/).filter(Boolean).length,
      doc_average_generated_prob: doc?.average_generated_prob ?? null,
      doc_completely_generated_prob: doc?.completely_generated_prob ?? null,
      predicted_class: doc?.predicted_class ?? null,
      confidence_category: doc?.confidence_category ?? null,
      sentence_count: Array.isArray(doc?.sentences) ? doc.sentences.length : null,
    };
  } catch (e) {
    return { label, error: String(e?.message || e), elapsed_ms: Date.now() - t0 };
  }
}

async function callOriginalityRaw(text, label) {
  const key = process.env.ORIGINALITY_API_KEY;
  if (!key) return { error: 'ORIGINALITY_API_KEY missing' };
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.originality.ai/api/v1/scan/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OAI-API-KEY': key },
      body: JSON.stringify({ content: text.slice(0, 5000), aiModelVersion: '1', storeScan: 'false' }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* leave raw */ }
    return {
      label,
      http_status: resp.status,
      elapsed_ms: Date.now() - t0,
      input_word_count: text.split(/\s+/).filter(Boolean).length,
      score_ai: parsed?.score?.ai ?? null,
      score_original: parsed?.score?.original ?? null,
      credits_used: parsed?.credits_used ?? null,
    };
  } catch (e) {
    return { label, error: String(e?.message || e), elapsed_ms: Date.now() - t0 };
  }
}

console.error('[probe] starting — 12 API calls (4 Pangram + 4 GPTZero sanity + 4 Originality sanity)...');

const out = {
  probed_at: new Date().toISOString(),
  purpose: 'GAP-RES-06 — root-cause Pangram saturation finding from 2026-05-24 calibration',
  pangram: {
    short_human: await callPangramRaw(SHORT_HUMAN, 'short_human'),
    long_human: await callPangramRaw(LONG_HUMAN, 'long_human'),
    short_ai: await callPangramRaw(SHORT_AI, 'short_ai'),
    long_ai_decoy: await callPangramRaw(LONG_AI_DECOY, 'long_ai_decoy'),
  },
  gptzero_sanity: {
    long_human: await callGPTZeroRaw(LONG_HUMAN, 'long_human'),
    long_ai_decoy: await callGPTZeroRaw(LONG_AI_DECOY, 'long_ai_decoy'),
  },
  originality_sanity: {
    long_human: await callOriginalityRaw(LONG_HUMAN, 'long_human'),
    long_ai_decoy: await callOriginalityRaw(LONG_AI_DECOY, 'long_ai_decoy'),
  },
};

const outDir = join(ROOT, 'data');
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'instance-d-pangram-probe-2026-05-24.json');
writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf-8');

const md = [];
md.push('# INSTANCE D — Pangram saturation probe');
md.push('');
md.push(`**Probed at:** ${out.probed_at}`);
md.push(`**Purpose:** ${out.purpose}`);
md.push('');
md.push('## Pangram v3 — fraction_ai / fraction_human / fraction_ai_assisted by sample');
md.push('');
md.push('| sample | HTTP | words | fraction_human | fraction_ai_assisted | fraction_ai | headline | version |');
md.push('|---|---|---|---|---|---|---|---|');
for (const [label, r] of Object.entries(out.pangram)) {
  if (r.error) { md.push(`| ${label} | ERR | — | — | — | — | ${r.error} | — |`); continue; }
  md.push(`| ${label} | ${r.http_status} | ${r.input_word_count} | ${r.fraction_human} | ${r.fraction_ai_assisted} | ${r.fraction_ai} | ${r.headline} | ${r.version} |`);
}
md.push('');
md.push('## GPTZero sanity (long samples only — short covered by 2026-05-19 audit)');
md.push('');
md.push('| sample | HTTP | words | avg_generated_prob | completely_generated_prob | predicted_class | confidence_category |');
md.push('|---|---|---|---|---|---|---|');
for (const [label, r] of Object.entries(out.gptzero_sanity)) {
  if (r.error) { md.push(`| ${label} | ERR | — | — | — | — | ${r.error} |`); continue; }
  md.push(`| ${label} | ${r.http_status} | ${r.input_word_count} | ${r.doc_average_generated_prob} | ${r.doc_completely_generated_prob} | ${r.predicted_class} | ${r.confidence_category} |`);
}
md.push('');
md.push('## Originality sanity (long samples only)');
md.push('');
md.push('| sample | HTTP | words | score.ai | score.original | credits_used |');
md.push('|---|---|---|---|---|---|');
for (const [label, r] of Object.entries(out.originality_sanity)) {
  if (r.error) { md.push(`| ${label} | ERR | — | — | — | ${r.error} |`); continue; }
  md.push(`| ${label} | ${r.http_status} | ${r.input_word_count} | ${r.score_ai} | ${r.score_original} | ${r.credits_used} |`);
}
md.push('');
md.push('## Parser cross-check (lib/ai-detection-gate.mjs::callPangram lines 251-259)');
md.push('```js');
md.push('const fAI       = data.fraction_ai         ?? null;');
md.push('const fAssisted = data.fraction_ai_assisted ?? null;');
md.push('const prob = Math.round(((fAI ?? 0) + 0.5 * (fAssisted ?? 0)) * 100) / 100;');
md.push('```');
md.push('');
md.push('## Interpretation guide');
md.push('');
md.push('- If `fraction_ai` is 1.0 on `long_human`: Pangram saturates on Mitchell-register long-form (hypothesis B — register bias, real Pangram behavior, NOT a parser bug).');
md.push('- If `fraction_ai` is 0.0 (and `fraction_human` is 1.0) on `long_human`: the parser is reading the wrong field — hypothesis A confirmed (PARSER_REGRESSION_FIX).');
md.push('- If response shape contains new fields (e.g., `ai_likelihood`, `score.ai`) not the documented `fraction_*` triple: hypothesis C — vendor API change.');
md.push('- If `fraction_ai_assisted` is the dominant signal (= 1.0) and the parser only weights it 0.5: hypothesis D — composite-prob formula is too lenient on assisted-AI.');

const mdPath = join(outDir, 'instance-d-pangram-probe-2026-05-24.md');
writeFileSync(mdPath, md.join('\n'), 'utf-8');

console.error(`[probe] wrote ${jsonPath}`);
console.error(`[probe] wrote ${mdPath}`);
console.error('---');
for (const [label, r] of Object.entries(out.pangram)) {
  if (r.error) { console.error(`Pangram ${label}: ERR ${r.error}`); continue; }
  console.error(`Pangram ${label} (${r.input_word_count}w): http=${r.http_status} fAI=${r.fraction_ai} fHuman=${r.fraction_human} fAssisted=${r.fraction_ai_assisted} headline="${r.headline}"`);
}
