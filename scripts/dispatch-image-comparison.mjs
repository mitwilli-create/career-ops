#!/usr/bin/env node
// Phase F-2 — 3-way image-gen comparison
// Calls Nano Banana (gemini-2.5-flash-image), gpt-image-1, gpt-image-2 with
// the same editorial-photography prompt; saves outputs to comparison/.

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env
const envText = readFileSync(path.join(ROOT, '.env'), 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!GEMINI_API_KEY || !OPENAI_API_KEY) {
  console.error('Missing API keys');
  process.exit(1);
}

const PROMPT = `Editorial black-and-white photography, single subject, high contrast. A single ceramic coffee cup on a weathered concrete window ledge at dawn. Warm side-light from a tall industrial window slants in from the left, slight steam rising from the cup. No human hands, no people. Aesthetic reference: Apartamento Magazine, Cabana, The Gentlewoman magazine. Composition leaves negative space at top-right. Square 1024×1024. Sharp focus on the cup, soft falloff into shadow. No text overlays.`;

const OUT_DIR = path.join(ROOT, 'dashboard/img/dispatch/comparison');
mkdirSync(OUT_DIR, { recursive: true });

const results = [];

// ===== Nano Banana (gemini-2.5-flash-image) =====
async function genNanoBanana() {
  const start = Date.now();
  console.log('\n[1/3] Nano Banana (gemini-2.5-flash-image)...');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('No inline image in response');
    const b64 = imgPart.inlineData.data;
    const mime = imgPart.inlineData.mimeType || 'image/png';
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const rawPath = path.join(OUT_DIR, `nano-banana.${ext}`);
    writeFileSync(rawPath, Buffer.from(b64, 'base64'));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✓ saved ${rawPath} (${elapsed}s)`);
    return { model: 'nano-banana (gemini-2.5-flash-image)', rawPath, mime, elapsed_s: +elapsed, ok: true };
  } catch (e) {
    console.error('  ✗ Nano Banana failed:', e.message);
    return { model: 'nano-banana (gemini-2.5-flash-image)', ok: false, error: e.message };
  }
}

// ===== gpt-image-1 =====
async function genGptImage1() {
  const start = Date.now();
  console.log('\n[2/3] gpt-image-1...');
  const url = 'https://api.openai.com/v1/images/generations';
  const body = {
    model: 'gpt-image-1',
    prompt: PROMPT,
    n: 1,
    size: '1024x1024'
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const img = data?.data?.[0];
    if (!img) throw new Error('No image in response');
    let buf;
    if (img.b64_json) {
      buf = Buffer.from(img.b64_json, 'base64');
    } else if (img.url) {
      const imgRes = await fetch(img.url);
      buf = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No b64_json or url in response');
    }
    const rawPath = path.join(OUT_DIR, 'gpt-image-1.png');
    writeFileSync(rawPath, buf);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✓ saved ${rawPath} (${elapsed}s)`);
    return { model: 'gpt-image-1', rawPath, mime: 'image/png', elapsed_s: +elapsed, ok: true };
  } catch (e) {
    console.error('  ✗ gpt-image-1 failed:', e.message);
    return { model: 'gpt-image-1', ok: false, error: e.message };
  }
}

// ===== gpt-image-2 (fallback for Imagen 3 since no Vertex AI) =====
async function genGptImage2() {
  const start = Date.now();
  console.log('\n[3/3] gpt-image-2 (Imagen-3 fallback — no Vertex AI access)...');
  const url = 'https://api.openai.com/v1/images/generations';
  const body = {
    model: 'gpt-image-2',
    prompt: PROMPT,
    n: 1,
    size: '1024x1024'
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const img = data?.data?.[0];
    if (!img) throw new Error('No image in response');
    let buf;
    if (img.b64_json) {
      buf = Buffer.from(img.b64_json, 'base64');
    } else if (img.url) {
      const imgRes = await fetch(img.url);
      buf = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No b64_json or url in response');
    }
    const rawPath = path.join(OUT_DIR, 'gpt-image-2.png');
    writeFileSync(rawPath, buf);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✓ saved ${rawPath} (${elapsed}s)`);
    return { model: 'gpt-image-2', rawPath, mime: 'image/png', elapsed_s: +elapsed, ok: true };
  } catch (e) {
    console.error('  ✗ gpt-image-2 failed:', e.message);
    return { model: 'gpt-image-2', ok: false, error: e.message };
  }
}

// ===== Convert to WebP =====
function toWebP(rawPath, outName) {
  const outPath = path.join(OUT_DIR, outName);
  try {
    execFileSync('cwebp', ['-q', '85', '-m', '6', '-resize', '1024', '0', rawPath, '-o', outPath], { stdio: 'pipe' });
    const stat = statSync(outPath);
    console.log(`  → WebP ${outName} (${(stat.size / 1024).toFixed(1)} KB)`);
    return { outPath, sizeKB: +(stat.size / 1024).toFixed(1) };
  } catch (e) {
    console.error(`  ✗ WebP convert failed for ${rawPath}:`, e.message);
    return { outPath: null, sizeKB: null };
  }
}

// ===== Main =====
(async () => {
  console.log('Phase F-2 Comparison Run');
  console.log('Prompt:', PROMPT.slice(0, 80) + '...');
  console.log('Output:', OUT_DIR);

  const r1 = await genNanoBanana();
  const r2 = await genGptImage1();
  const r3 = await genGptImage2();

  for (const r of [r1, r2, r3]) {
    if (r.ok) {
      let outName;
      if (r.model.startsWith('nano-banana')) outName = 'nano-banana.webp';
      else if (r.model === 'gpt-image-1') outName = 'gpt-image-1.webp';
      else outName = 'gpt-image-2.webp';
      const conv = toWebP(r.rawPath, outName);
      r.webpPath = conv.outPath;
      r.webp_kb = conv.sizeKB;
    }
    results.push(r);
  }

  writeFileSync(
    path.join(ROOT, 'data/dispatch/comparison-results.json'),
    JSON.stringify({ prompt: PROMPT, generated_at: new Date().toISOString(), results }, null, 2)
  );
  console.log('\n✓ Results written to data/dispatch/comparison-results.json');
})();
