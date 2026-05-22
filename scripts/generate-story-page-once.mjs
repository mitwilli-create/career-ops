#!/usr/bin/env node
// One-shot story page generator for a specific requirement slug.
// Used when a Wave C-A drill-in links to a requirement-slug story page
// that doesn't exist yet in dashboard/stories/.
//
// Usage:
//   node scripts/generate-story-page-once.mjs \
//     --slug=exceptionally-skilled-editor-improve-without-losing-voice \
//     --requirement="Exceptionally skilled editor who improves pieces without losing essence" \
//     --company="Anthropic" \
//     --role="Engineering Editorial Lead" \
//     --report=reports/047-anthropic-engineering-editorial-lead-2026-04-27.md

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), override: true });

const args = process.argv.slice(2);
const getOpt = (prefix) => { const a = args.find(x => x.startsWith(prefix)); return a ? a.slice(prefix.length) : null; };

const SLUG       = getOpt('--slug=');
const REQUIREMENT = getOpt('--requirement=');
const COMPANY    = getOpt('--company=');
const ROLE       = getOpt('--role=');
const REPORT_REL = getOpt('--report=');

if (!SLUG || !REQUIREMENT || !COMPANY || !ROLE) {
  console.error('Usage: node scripts/generate-story-page-once.mjs --slug=... --requirement="..." --company="..." --role="..." [--report=...]');
  process.exit(1);
}

const STORIES_DIR = join(ROOT, 'dashboard', 'stories');
if (!existsSync(STORIES_DIR)) mkdirSync(STORIES_DIR, { recursive: true });

const outFp = join(STORIES_DIR, `${SLUG}.html`);

// Load corpus files
const voiceRef     = existsSync(join(ROOT, 'writing-samples/voice-reference.md'))
  ? readFileSync(join(ROOT, 'writing-samples/voice-reference.md'), 'utf-8') : '';
const cvMd         = existsSync(join(ROOT, 'cv.md'))
  ? readFileSync(join(ROOT, 'cv.md'), 'utf-8') : '';
const articleDigest = existsSync(join(ROOT, 'article-digest.md'))
  ? readFileSync(join(ROOT, 'article-digest.md'), 'utf-8') : '';

// Load report Block F if provided
let reportContext = '';
if (REPORT_REL) {
  const fp = REPORT_REL.startsWith('/') ? REPORT_REL : join(ROOT, REPORT_REL);
  if (existsSync(fp)) {
    const text = readFileSync(fp, 'utf-8');
    // Extract STAR stories table from Block F
    const m = text.match(/###\s+STAR\s+stories[^\n]*\n([\s\S]+?)(?=\n###|\n##\s|\Z)/i);
    if (m) reportContext = 'STAR+R stories from report Block F:\n' + m[1].slice(0, 4000);
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('FATAL: ANTHROPIC_API_KEY not set'); process.exit(1); }

const prompt = `You are Mitchell Williams writing a 650-900 word expansion of one specific editorial strength for an AI-native job interview. The output becomes a child-page in his career-ops dashboard — it will be read by recruiters and HMs at ${COMPANY}.

HARD RULES:
- NEVER invent metrics, dates, or experience beyond what's documented in the corpus below
- Voice must match Mitchell's voice-reference.md style exactly: precision, directness, editorial pace, em-dash usage, AP-style numbers, no hedge words
- First person ("I", not "Mitchell")
- Structure: 1 short lead paragraph (what the skill is and why it's hard), 2-3 paragraphs on action + methodology + craft details, 1 paragraph on the measurable results, 1 short reflection/forward-looking paragraph
- Use ONLY metrics/specifics that appear in CV, article-digest, or the STAR stories provided
- No AI-isms: avoid "leverage", "synergy", "ensure", "delve", "tapestry", "robust", "deep dive"
- No bullet lists — flowing prose only
- No heading H2/H3 — paragraph breaks only
- 650-900 words

JD requirement this narrative addresses: "${REQUIREMENT}"
This is for: ${COMPANY} — ${ROLE}

${reportContext ? reportContext + '\n\n' : ''}
═══ Mitchell's voice reference (style anchor — match this voice precisely) ═══
${voiceRef.slice(0, 5000)}

═══ Mitchell's CV (canonical source — only use facts/metrics that appear here) ═══
${cvMd.slice(0, 8000)}

═══ Article digest (proof points — only use what's documented here) ═══
${articleDigest.slice(0, 4000)}

Write the expanded narrative now. Output the prose body ONLY — no header, no metadata, no preamble, no "Here is the narrative:" intro. Start directly with the first word of the story.`;

console.log(`Generating story page: ${SLUG}`);
console.log(`Requirement: ${REQUIREMENT}`);
console.log(`Role: ${COMPANY} — ${ROLE}`);

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  }),
});

if (!res.ok) {
  const err = await res.text();
  console.error('API error:', res.status, err.slice(0, 300));
  process.exit(1);
}
const j = await res.json();
const body = j.content?.[0]?.text?.trim() || '';
const wordCount = body.split(/\s+/).length;
console.log(`Generated: ${wordCount} words`);

// Build the HTML using the same council-converged design tokens as generate-story-pages.mjs
const today = new Date().toISOString().slice(0, 10);
const titleText = REQUIREMENT.slice(0, 110);
const bodyHtml = body.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, ' ').trim() + '</p>').join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleText} — Mitchell Williams</title>
<style>
  :root {
    --bg: #f8f9fb;
    --surface: #ffffff;
    --surface-2: #f4f4f6;
    --border: #e5e7eb;
    --text: #111827;
    --text-2: #374151;
    --text-3: #6b7280;
    --green-fg: #16a34a;
    --green-fg-dark: #166534;
    --green-bg: #dcfce7;
    --green-border: #86efac;
    --link: #0969da;
    --link-hover: #0550ae;
    --radius-sm: 6px;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--link);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #06070d;
      --surface: #11131c;
      --surface-2: #181b27;
      --border: #232737;
      --text: #fafafa;
      --text-2: #e4e4e7;
      --text-3: #b8b8c0;
      --green-fg: #86efac;
      --green-fg-dark: #bbf7d0;
      --green-bg: rgba(22,163,74,.12);
      --green-border: rgba(22,163,74,.3);
      --link: #58a6ff;
      --link-hover: #79c0ff;
      --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--link);
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-sans);
    max-width: 68ch;
    margin: 56px auto;
    padding: 0 24px;
    line-height: 1.62;
    color: var(--text);
    background: var(--bg);
    font-size: 16px;
  }
  .reading-shell { position: relative; padding-left: 18px; }
  .reading-shell::before {
    content: '';
    position: absolute;
    left: 0; top: 6px; bottom: 6px;
    width: 2px;
    background: var(--link);
    border-radius: 2px;
    opacity: 0.6;
  }
  h1 {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 10px;
    color: var(--text);
    line-height: 1.25;
    letter-spacing: -0.015em;
  }
  .meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-3);
    margin: 0 0 32px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    letter-spacing: 0.005em;
  }
  .meta-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 9px;
    border-radius: var(--radius-sm);
    font-size: 11px; font-weight: 600;
    background: var(--green-bg);
    color: var(--green-fg-dark);
    border: 1px solid var(--green-border);
  }
  .body {
    font-size: 18px;
    line-height: 1.62;
    color: var(--text-2);
  }
  .body p { margin: 0 0 22px; }
  .body p:last-child { margin-bottom: 0; }
  .footer {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-3);
    margin-top: 48px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    letter-spacing: 0.005em;
  }
  a { color: var(--link); text-decoration: none; transition: color .12s ease; }
  a:hover { color: var(--link-hover); text-decoration: underline; }
  a:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 3px; }
  .back-link { color: var(--text-3); font-weight: 500; }
  .back-link:hover { color: var(--text); }
  .story-actions {
    display: flex; justify-content: flex-end; gap: 10px;
    margin: 0 0 16px;
  }
  .story-action-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
    border-radius: var(--radius-sm);
    font-size: 12px; font-weight: 500;
    cursor: pointer;
    transition: border-color .12s, color .12s, background .12s;
    font-family: var(--font-mono);
  }
  .story-action-btn:hover { color: var(--text); border-color: var(--text-3); background: var(--surface-2); }
  .story-action-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  .req-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(9,105,218,.1);
    color: var(--link);
    border: 1px solid rgba(9,105,218,.2);
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.01em;
    font-family: var(--font-sans);
  }
  @media print {
    .story-actions, .back-link, .req-tag { display: none; }
    body { max-width: none; margin: 24px 36px; }
    .reading-shell::before { display: none; }
    .reading-shell { padding-left: 0; }
    a { color: black; text-decoration: underline; }
  }
  @media (max-width: 600px) {
    body { font-size: 15px; margin: 32px auto; }
    h1 { font-size: 22px; }
    .body { font-size: 16px; }
  }
</style>
</head><body>
<div class="reading-shell">
  <div class="story-actions" aria-hidden="false">
    <button type="button" class="story-action-btn" onclick="window.print()"
      title="Download as PDF (browser print → Save as PDF)" aria-label="Download as PDF">
      &#x2913; PDF
    </button>
  </div>
  <h1>${titleText}</h1>
  <div class="meta">
    <span>Source: ${COMPANY} &mdash; ${ROLE}</span>
    <span class="req-tag">JD requirement</span>
    <span class="meta-badge">&#x2713; voice-calibrated</span>
    <span>Generated ${today}</span>
  </div>
  <div class="body">
${bodyHtml}
  </div>
  <div class="footer">
    <span>Generated ${today} &middot; voice-calibrated against writing-samples/voice-reference.md, cv.md, article-digest.md</span>
    <span style="margin-left:auto"><a href="../index.html" class="back-link">&larr; back to dashboard</a></span>
  </div>
</div>
</body></html>`;

writeFileSync(outFp, html, 'utf-8');
console.log(`✓ Written: ${outFp}`);
console.log(`  URL: https://dashboard.careers-ops.com/stories/${SLUG}.html`);
