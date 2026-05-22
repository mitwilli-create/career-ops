#!/usr/bin/env node
/**
 * scripts/generate-interview-likelihood.mjs
 *
 * Sonnet-powered per-role interview likelihood analyzer for the A4 chip popout.
 * Reads JD + corpus evidence (via lib/corpus-index.mjs indexQuery), calls
 * claude-sonnet-4-6, writes structured JSON to data/interview-likelihood/<slug>.json.
 *
 * Usage:
 *   node scripts/generate-interview-likelihood.mjs --top=5
 *   node scripts/generate-interview-likelihood.mjs --slug=048-anthropic-engineering-editorial-lead
 *   node scripts/generate-interview-likelihood.mjs --row=48
 *
 * Hang prevention:
 *   - AbortSignal.timeout(120_000) on every Anthropic call
 *   - readJson via lib/safe-fetch.mjs (body-timeout 60s)
 *   - Sequential per-role (no parallel fan-out)
 *
 * Cost: ~$0.50 per role (sonnet-4-6, ~3K tokens system+user, ~1K tokens output).
 * Cap default = 5 roles per run (override via --top=N).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { fetchJson } from '../lib/safe-fetch.mjs';
import { indexQuery } from '../lib/corpus-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

const OUT_DIR = join(ROOT, 'data', 'interview-likelihood');
mkdirSync(OUT_DIR, { recursive: true });

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {}
}

function findPackDir(slug) {
  for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
    const d = join(base, slug);
    if (existsSync(d)) return d;
  }
  return null;
}

function findSlugForRow(num) {
  const padded = String(num).padStart(3, '0') + '-';
  for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
    if (!existsSync(base)) continue;
    try {
      const hit = readdirSync(base).find(n => n.startsWith(padded));
      if (hit) return hit;
    } catch {}
  }
  return null;
}

function readJdText(packDir) {
  const candidates = ['jd.txt', 'jd.md', 'JD.md', 'job-description.md', 'README.md'];
  for (const f of candidates) {
    const p = join(packDir, f);
    if (existsSync(p)) { try { return readFileSync(p, 'utf-8'); } catch {} }
  }
  return '';
}

async function analyzeRole({ slug, company, role, num }) {
  const packDir = findPackDir(slug);
  if (!packDir) return { slug, error: 'no pack dir found' };
  const jdText = readJdText(packDir);
  if (!jdText) return { slug, error: 'no JD text in pack' };

  // Pull top corpus snippets relevant to the JD.
  let corpus = [];
  try {
    corpus = await indexQuery({
      query: jdText.slice(0, 6000),
      topK: 12,
      filter: { sources: ['cv', 'brain', 'corpus'] },
    });
  } catch (e) {
    emit({ slug, phase: 'corpus_failed', error: e.message });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = [
    'You assess interview likelihood for a specific candidate (Mitchell Williams) against a specific role.',
    'Be honest, not optimistic. Cite specific evidence from the provided corpus snippets in every claim.',
    'Output STRICT JSON only, no preamble, no commentary, no code fences.',
    'JSON schema:',
    '{',
    '  "likelihood_pct": <integer 0-100>,',
    '  "confidence": "high" | "medium" | "low",',
    '  "top_strengths": [ { "claim": "<short>", "evidence": "<specific corpus citation>" } ],  // EXACTLY 3 items',
    '  "real_gaps":     [ { "gap": "<short>", "severity": "blocking" | "significant" | "minor" } ],  // 2-3 items',
    '  "opening_talking_point": "<one sentence Mitchell can lead with in his cover letter or intro call>",',
    '  "competitive_edge": "<one sentence — what Mitchell has that most candidates lack>"',
    '}',
  ].join('\n');

  const userParts = [
    '# Role',
    `${company} — ${role}`,
    '',
    '# Job description',
    jdText.slice(0, 10000),
  ];
  if (corpus.length) {
    userParts.push('', '# Candidate corpus evidence (top relevant snippets)');
    for (let i = 0; i < Math.min(8, corpus.length); i++) {
      const c = corpus[i];
      userParts.push(`## Snippet ${i + 1} (${c.source || 'unknown'}, score ${c.score})`, c.text || '');
    }
  }
  userParts.push('', '# Output', 'Return ONLY the JSON. No prose, no preamble.');

  const t0 = Date.now();
  const j = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userParts.join('\n') }],
    }),
  }, { bodyTimeoutMs: 90_000, errPrefix: 'anthropic-il' });
  const elapsed = Date.now() - t0;

  const content = (j.content && j.content[0] && j.content[0].text) || '';
  // Strip code fences if present.
  let jsonText = content.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { slug, error: 'JSON parse failed: ' + e.message, rawContent: content.slice(0, 500) };
  }

  // Validate shape.
  if (typeof parsed.likelihood_pct !== 'number' || !Array.isArray(parsed.top_strengths)) {
    return { slug, error: 'invalid shape', parsed };
  }

  const usage = j.usage || {};
  const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  // Sonnet 4.6 pricing: $3/$15 per 1M input/output (approximate).
  const costUsd = (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;

  parsed.generated_at = new Date().toISOString();
  parsed.slug = slug;
  parsed.company = company;
  parsed.role = role;
  parsed.num = num;
  parsed.elapsed_ms = elapsed;
  parsed.tokens = tokens;
  parsed.cost_usd = Number(costUsd.toFixed(4));
  parsed.corpus_hits = corpus.length;

  const outPath = join(OUT_DIR, slug + '.json');
  writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  // Mirror into apply-pack/<slug>/interview-likelihood.json (gitignored but
  // useful for offline review).
  if (packDir) {
    try { writeFileSync(join(packDir, 'interview-likelihood.json'), JSON.stringify(parsed, null, 2)); } catch {}
  }
  return { slug, ok: true, pct: parsed.likelihood_pct, conf: parsed.confidence, cost: parsed.cost_usd, elapsed_ms: elapsed };
}

// ─── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name) {
  const m = args.find(a => a.startsWith('--' + name + '='));
  if (m) return m.slice(name.length + 3);
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return null;
}

const topN = parseInt(arg('top') || '5', 10);
const singleSlug = arg('slug');
const singleRow = arg('row');

let targets = [];
if (singleSlug) {
  targets.push({ slug: singleSlug, company: '', role: '', num: '' });
} else if (singleRow) {
  const slug = findSlugForRow(singleRow);
  if (!slug) { console.error('no pack dir for row ' + singleRow); process.exit(1); }
  targets.push({ slug, company: '', role: '', num: singleRow });
} else {
  // Load apply-now-queue.json
  const qPath = join(ROOT, 'data', 'apply-now-queue.json');
  if (!existsSync(qPath)) { console.error('apply-now-queue.json missing'); process.exit(1); }
  const q = JSON.parse(readFileSync(qPath, 'utf-8'));
  const ranked = q.ranked || [];
  for (const r of ranked) {
    const slug = findSlugForRow(r.num);
    if (!slug) continue;
    targets.push({ slug, company: r.company || '', role: r.role || '', num: r.num });
    if (targets.length >= topN) break;
  }
}

emit({ phase: 'start', target_count: targets.length, targets: targets.map(t => t.slug) });

let totalCost = 0;
const summary = [];
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  emit({ phase: 'role_start', i: i + 1, of: targets.length, slug: t.slug });
  try {
    const r = await analyzeRole(t);
    if (r.error) {
      emit({ phase: 'role_failed', slug: t.slug, error: r.error });
      summary.push({ ...t, ...r });
    } else {
      totalCost += r.cost || 0;
      emit({ phase: 'role_done', slug: t.slug, pct: r.pct, conf: r.conf, cost: r.cost, total_cost: totalCost.toFixed(4) });
      summary.push({ ...t, ...r });
    }
  } catch (e) {
    emit({ phase: 'role_threw', slug: t.slug, error: e.message });
    summary.push({ ...t, error: e.message });
  }
}

emit({ phase: 'done', total_cost: totalCost.toFixed(4), count: summary.length });
console.log(JSON.stringify({ ok: true, total_cost_usd: Number(totalCost.toFixed(4)), summary }, null, 2));
