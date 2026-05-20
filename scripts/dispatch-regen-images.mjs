#!/usr/bin/env node
// Phase F-2 — Production rotation generator
// Winner: gpt-image-1 (locked).
// Generates 7 morning + 7 evening hero images using fixed prompts.
//
// Usage:
//   node scripts/dispatch-regen-images.mjs              # generate all 14
//   node scripts/dispatch-regen-images.mjs --morning    # morning only
//   node scripts/dispatch-regen-images.mjs --evening    # evening only

import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const MODEL = 'gpt-image-1';
const SIZE = '1024x1024';

const MORNING_SUFFIX = 'Editorial black-and-white photography. No people, no human hands, no text. Apartamento / Cabana magazine aesthetic. Square 1024×1024. Generous negative space. High contrast, sharp focus on subject, soft falloff into shadow.';
const EVENING_SUFFIX = 'Editorial warm-monochrome photography, amber + sepia tones. No people, no human hands, no text. Apartamento / Cabana magazine aesthetic. Square 1024×1024. Generous negative space. Dim ambient light, single warm-source highlight, sharp focus on subject, soft falloff into shadow.';

const MORNING_PROMPTS = [
  { day: 'mon', subject: 'coffee cup at dawn', body: 'A single ceramic coffee cup on a weathered concrete window ledge at dawn. Warm side-light from a tall industrial window slants in from the left, slight steam rising from the cup. Composition leaves negative space at top-right.' },
  { day: 'tue', subject: 'open book + reading glasses', body: 'An open book lying flat on a wooden table with a pair of round reading glasses resting on the page. Soft morning side-light from the left rakes across the page texture. Composition leaves negative space at upper portion of frame.' },
  { day: 'wed', subject: 'Brutalist concrete column corner', body: 'Architectural fragment — the corner of a Brutalist concrete column, showing board-form texture and a chamfered edge. Raking morning light from the left creates a hard shadow line. Composition leaves negative space at right side.' },
  { day: 'thu', subject: 'linen curtain catching light', body: 'A simple linen curtain catching morning light through a tall window. A single sharp shadow falls diagonally across the fabric. Composition leaves negative space at upper-right.' },
  { day: 'fri', subject: 'single citrus on stone', body: 'A single citrus fruit (an orange or a lemon) resting on a textured pale stone surface. Warm raking morning light from the left. The citrus is the unambiguous hero. Composition leaves negative space at upper-right.' },
  { day: 'sat', subject: 'typewriter near window', body: 'A vintage manual typewriter on a wooden desk near a window. Soft morning light bathes the keys from the left. A single sheet of paper rolled into the carriage. Composition leaves negative space at upper-right.' },
  { day: 'sun', subject: 'clay vessel on textured surface', body: 'A single hand-thrown clay vessel sitting on a textured stone or wood surface. Morning light from the left side reveals the clay surface and the form. Composition leaves negative space at upper-right.' },
];

const EVENING_PROMPTS = [
  { day: 'mon', subject: 'single malt at amber-light', body: 'A single crystal glass of single-malt whisky on a dark wood bar surface. Brass detail just visible in the soft-focus background. Warm amber light from a single source illuminates the glass. Composition leaves negative space at upper area.' },
  { day: 'tue', subject: 'open book on leather chair', body: 'An open book resting on a worn leather chair, lit by the warm glow of a single reading lamp just out of frame. Evening dimness in the surrounding space. Composition leaves negative space at upper-right.' },
  { day: 'wed', subject: 'brass desk lamp glow', body: 'A brass desk lamp casting warm light onto a dark wood surface with scattered paper documents. Evening dimness in the surrounding space, single warm-amber source. Composition leaves negative space at upper area.' },
  { day: 'thu', subject: 'wool blanket on window seat at dusk', body: 'A folded wool blanket on a wooden window seat at dusk. A single warm-amber table lamp visible at the edge of frame. Composition leaves negative space at upper-right.' },
  { day: 'fri', subject: 'bookshelf detail in dim light', body: 'A close-in detail of a wooden bookshelf — leather and cloth book spines, slightly worn. Dim warm light from a single source at the edge of frame. Composition leaves negative space at upper-right.' },
  { day: 'sat', subject: 'jazz record on turntable', body: 'An old vinyl jazz record sitting on a turntable platter, the tonearm hovering just above. A single warm lamp glow from one side, dim background. Composition leaves negative space at upper-right.' },
  { day: 'sun', subject: 'glass paperweight at evening', body: 'A single glass paperweight on a dark wood desk, catching the last evening light from a dim window. Soft warm tones, single warm source. Composition leaves negative space at upper-right.' },
];

const MORNING_DIR = path.join(ROOT, 'dashboard/img/dispatch/morning');
const EVENING_DIR = path.join(ROOT, 'dashboard/img/dispatch/evening');
mkdirSync(MORNING_DIR, { recursive: true });
mkdirSync(EVENING_DIR, { recursive: true });

async function genOne(fullPrompt, outBaseNoExt) {
  const start = Date.now();
  const url = 'https://api.openai.com/v1/images/generations';
  const body = { model: MODEL, prompt: fullPrompt, n: 1, size: SIZE };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
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
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
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
      const pngPath = `${outBaseNoExt}.png`;
      writeFileSync(pngPath, buf);
      // Convert PNG → WebP via cwebp
      const webpPath = `${outBaseNoExt}.webp`;
      execFileSync('cwebp', ['-q', '85', '-m', '6', pngPath, '-o', webpPath], { stdio: 'pipe' });
      const stat = statSync(webpPath);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      // Drop the intermediate PNG — production rotation uses WebP only
      try { execFileSync('rm', [pngPath]); } catch {}
      return { ok: true, pngPath, webpPath, webp_kb: +(stat.size / 1024).toFixed(1), elapsed_s: +elapsed };
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown' };
}

function promptHash(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

async function runRotation(label, prompts, outDir, suffix) {
  console.log(`\n=== ${label.toUpperCase()} rotation (${prompts.length} images) ===`);
  const indexEntries = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const fullPrompt = `${p.body} ${suffix}`;
    const outBase = path.join(outDir, String(i + 1));
    console.log(`[${i + 1}/${prompts.length}] ${p.day} — ${p.subject}`);
    const r = await genOne(fullPrompt, outBase);
    if (r.ok) {
      console.log(`  ✓ ${r.webpPath} (${r.webp_kb} KB, ${r.elapsed_s}s)`);
      indexEntries.push({
        day: p.day,
        path: path.relative(ROOT, r.webpPath),
        subject: p.subject,
        prompt_hash: promptHash(fullPrompt),
        webp_kb: r.webp_kb,
        elapsed_s: r.elapsed_s
      });
    } else {
      console.error(`  ✗ FAILED after 3 retries: ${r.error}`);
      indexEntries.push({
        day: p.day,
        path: null,
        subject: p.subject,
        prompt_hash: promptHash(fullPrompt),
        error: r.error
      });
    }
  }
  return indexEntries;
}

(async () => {
  const args = process.argv.slice(2);
  const doMorning = args.length === 0 || args.includes('--morning');
  const doEvening = args.length === 0 || args.includes('--evening');

  const indexPath = path.join(ROOT, 'data/dispatch/image-rotation-index.json');
  let existing = { morning: [], evening: [] };
  try { existing = JSON.parse(readFileSync(indexPath, 'utf-8')); } catch {}

  if (doMorning) {
    existing.morning = await runRotation('morning', MORNING_PROMPTS, MORNING_DIR, MORNING_SUFFIX);
  }
  if (doEvening) {
    existing.evening = await runRotation('evening', EVENING_PROMPTS, EVENING_DIR, EVENING_SUFFIX);
  }

  const indexObj = {
    winner_model: MODEL,
    comparison_doc: 'data/dispatch/image-gen-comparison.md',
    morning: existing.morning,
    evening: existing.evening,
    regeneration_command: 'node scripts/dispatch-regen-images.mjs'
  };
  writeFileSync(indexPath, JSON.stringify(indexObj, null, 2));
  console.log('\n✓ Index written to', indexPath);
})();
