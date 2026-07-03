#!/usr/bin/env node
/**
 * relocation-career-strategy.mjs
 *
 * Multi-model strategic analysis: optimal career + wealth path for a
 * user-defined international relocation plan.
 *
 * Fires simultaneously across:
 *   - xAI Grok (web_search + x_search)
 *   - Perplexity sonar-deep-research
 *   - Gemini 2.5 Pro (Google Search grounded)
 *   - OpenAI GPT-5 / o3 fallback
 *
 * PERSONAL-DATA CONTRACT (why this file is safe to track in a fork):
 *   This script contains NO personal data. The subject's profile — identity,
 *   compensation, relocation plan, political filters — is loaded at RUNTIME
 *   from a gitignored JSON file, so it never enters version control or a
 *   cross-fork PR.
 *     - Real profile (yours, gitignored):  data/relocation-profile.json
 *     - Committed placeholder scaffold:     data/relocation-profile.example.json
 *   If the real file is absent, the example is used with a loud warning.
 *   Do NOT inline a profile back into this file — see AGENTS.md Data Contract
 *   and lib/leak-guard.mjs (data/relocation-profile.json is a sensitive path).
 *
 * Usage:  node scripts/relocation-career-strategy.mjs
 * Output: /tmp/relocation-career-strategy-YYYY-MM-DD.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const env = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const TODAY = new Date().toISOString().slice(0, 10);
const OUT = `/tmp/relocation-career-strategy-${TODAY}.md`;

// --- profile loader: real (gitignored) first, committed example as fallback ---
const REAL_PROFILE = join(ROOT, 'data', 'relocation-profile.json');
const EXAMPLE_PROFILE = join(ROOT, 'data', 'relocation-profile.example.json');

function loadProfile() {
  if (existsSync(REAL_PROFILE)) {
    return { profile: JSON.parse(readFileSync(REAL_PROFILE, 'utf8')), source: 'data/relocation-profile.json' };
  }
  if (existsSync(EXAMPLE_PROFILE)) {
    console.warn('⚠️  data/relocation-profile.json not found — using the committed PLACEHOLDER example.');
    console.warn('    The output will be generic. To run against your real profile:');
    console.warn('    cp data/relocation-profile.example.json data/relocation-profile.json   # the real file is gitignored');
    return { profile: JSON.parse(readFileSync(EXAMPLE_PROFILE, 'utf8')), source: 'data/relocation-profile.example.json (PLACEHOLDER)' };
  }
  console.error('❌ No profile found. Create data/relocation-profile.json (copy data/relocation-profile.example.json).');
  process.exit(1);
}

function bulletize(arr) {
  return (arr || []).map(s => `- ${s}`).join('\n');
}

/**
 * Build the research prompt entirely from a profile object. No personal data
 * is hard-coded here — every person- or destination-specific value comes from
 * the loaded profile.
 */
function buildPrompt(p) {
  const ind = p.individual || {};
  const tr = p.target_roles || {};
  const rel = p.relocation || {};
  const st = rel.short_term || {};
  const lt = rel.long_term || {};
  const filters = rel.political_filters || [];
  const stRegion = st.region || st.country || 'the destination region';

  return `
You are conducting rigorous strategic career and financial planning for a specific individual.
Read every detail of his profile carefully: the analysis must be tailored to him, not generic.

---

## THE INDIVIDUAL

**Name:** ${ind.name}, ${ind.age}, ${ind.descriptors}
**Current role:** ${ind.current_role}
**Current location:** ${ind.current_location}
**Total comp target:** ${ind.comp_target_usd}
**Minimum floor:** ${ind.comp_floor_usd}

**Core skills and demonstrated production:**
${(p.skills_and_production || []).map(s => `- ${s}`).join('\n')}

**Target roles:**
- Primary: ${tr.primary}
- Secondary: ${tr.secondary}

**CV notes relevant to career strategy:**
${bulletize(p.cv_notes)}

---

## HIS RELOCATION PLAN

**Short-term destination (${st.window}): ${st.place}**
${bulletize(st.reasons)}
${bulletize(st.notes)}

**Long-term destination (${lt.window}): ${lt.place}**
${bulletize(lt.reasons)}
${bulletize(lt.notes)}

**Political filters (non-negotiable, affects employer selection too):**
${bulletize(filters)}

---

## THE STRATEGIC QUESTIONS

Answer each of the following with specificity, current data, and honest tradeoff analysis. Do not give him generic expat advice. Apply his exact profile.

### QUESTION 1: TIMING. How many more years in the US optimizes lifetime wealth?

Given ${ind.current_comp_estimate}, what is the mathematical case for staying in the US for 1, 2, 3, or 5 more years before ${st.place}?

Factor in:
- US tech AI market comp trajectory for his archetype (${tr.primary}) in 2026–2028
- The cost-of-living differential between ${ind.current_location} and ${st.place} (his spending power multiplies dramatically: what does this mean for net wealth accumulation per year?)
- What savings/runway amount makes ${st.place} livable as a fully independent operator without US-employer dependency?
- Tax implications of the move (FEIE, Foreign Tax Credit, US worldwide taxation of citizens: he cannot escape US taxes by moving)
- At what savings number does the ${st.place} move become self-sustaining regardless of employment?

### QUESTION 2: LEGAL STRUCTURE. What entity and tax structure maximizes his income from ${st.place}?

He will be working remotely, either as an employee of a US/global company or as an independent operator. Analyze:

**Option A: Remain a US employee (W-2) while living in ${st.place}**
- Which companies and roles allow full remote from ${stRegion}?
- What does US tech comp look like for remote roles at his level when the employer knows he's in ${st.country}?
- HR/legal risk of working US W-2 while resident in ${st.country}: permanent establishment risk, payroll tax issues, benefits cliff

**Option B: US LLC / S-Corp structure with client contracts**
- Wyoming or Delaware LLC for freelance/consulting
- Self-employment tax burden vs. W-2
- FEIE ($126,500 exempt in 2024, adjusts annually): how much of his income is shielded?
- ${st.country} tax implications: does ${st.country} tax foreign-sourced income for residents?
- What consulting rate does his profile support? ($200–$400/hr range? What's realistic for his archetype?)

**Option C: ${st.country} residency / talent-visa structures**
${bulletize(st.research_anchors)}
- What's the practical visa path for someone at his level moving to ${st.place} to work remotely for non-${st.country} clients?

**Option D: Regional entity for Asia-based billing (e.g. Singapore/Hong Kong)**
- Pros/cons of billing through a Singapore Pte. Ltd. vs. keeping everything US-structured
- The relevant US tax treaty; territorial tax system benefits
- Is this worth the overhead for someone at his income level?

What is the optimal structure, and what are the realistic after-tax income scenarios under each?

### QUESTION 3: EMPLOYER + CLIENT TARGETING. Which companies and client types are ${st.place}-compatible at his comp level?

Name specific companies, not categories. Consider:

**Remote-first or remote-friendly AI companies that:**
- Hire internationally / allow ${stRegion}-based employees or contractors
- Respect his political filters (listed above) — he will not work where they are violated
- Are building the kinds of AI systems his archetype fits (${tr.primary})
- Pay at or above his floor (${ind.comp_floor_usd}) even for remote/international work
- Have cultures where his public positions are not employment-liabilities

**Consulting/freelance client types that:**
- Pay $200–$400/hr or equivalent project rates
- Need AI agent architecture, executive comms AI, or LLM pipeline work
- Can be served entirely remotely from ${st.place}
- Respect his political filters

Name specific companies. Name what his consulting positioning should be. Name what his rate ceiling realistically is.

### QUESTION 4: CAREER POSITIONING. What should he build in the next 12–24 months to maximize earning power from ${st.place}?

Given that he is already shipping production agents and has a public GitHub, what specific moves in 2026–2027 materially increase his ${st.country}-independent income ceiling?

- Should he stay at his current employer for another 1–2 years specifically to acquire credentials/projects that command higher freelance rates?
- What certifications, publications, or public work would most move his consulting rate?
- What is the "minimum viable exit" from his current employer that still gives him ${st.place}-level income independence?
- How should he position his public identity (site, LinkedIn, GitHub) for the ${st.place}-based operator persona?

### QUESTION 5: LONG-TERM. What does the career path look like from ${st.place} to ${lt.place}?

Assuming he moves to ${lt.place} around ${lt.window}:
${bulletize(lt.research_anchors)}
- What ${lt.country}-based companies or regional roles would be natural next steps from his ${st.country} consulting base?
- What should he be building from ${st.window} in ${st.place} that sets up a ${lt.place} career or consulting practice for the second half of his life?
- Is there a scenario where his ${st.country} consulting practice evolves into a Southeast Asia / APAC AI consultancy that makes ${lt.country} a regional hub rather than a fresh start?

### QUESTION 6: RISK ASSESSMENT. What are the realistic threats to this plan?

Be direct about:
- US taxation risk: can he actually implement FEIE + LLC structure without triggering IRS scrutiny at his income level?
- ${st.country} political risk: what is the realistic scenario where ${st.country}'s political situation becomes untenable for someone of his profile?
- ${st.country} social/legal risk: what is the realistic social and legal environment for someone of his profile living openly in ${st.place} in 2026–2030?
- Employment risk: his CV documents politically outspoken editorial work. What is the realistic risk that this limits his employer options in the US tech market in 2026?
- The ${lt.country} timing risk: if circumstances delay the ${lt.place} move past ${lt.window}, what is the contingency plan from ${st.place}?

---

Be specific. Use current data (2025–2026). Name actual companies, actual visa categories, actual tax rules, actual numbers. Do not hedge into vague career advice. He has done the research on the relocation side. Now he needs the career and financial architecture to make it executable.
`.trim();
}

async function callGrok(prompt) {
  const key = process.env.XAI_API_KEY;
  if (!key) return { model: 'xai:grok', error: 'XAI_API_KEY not set' };
  const t0 = Date.now();
  for (const model of ['grok-4.3', 'grok-4-0709', 'grok-3-fast']) {
    try {
      const r = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content: prompt }],
          tools: [{ type: 'web_search' }, { type: 'x_search' }],
        }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!r.ok) { const t = await r.text(); if (r.status === 404 || r.status === 400) continue; return { model: `xai:${model}`, error: `HTTP ${r.status}: ${t.slice(0,240)}` }; }
      const j = await r.json();
      let content = j.output_text || '';
      if (!content && Array.isArray(j.output)) {
        const texts = [];
        for (const item of j.output) {
          if (item.type === 'message' && Array.isArray(item.content))
            for (const c of item.content)
              if ((c.type === 'output_text' || c.type === 'text') && c.text) texts.push(c.text);
        }
        content = texts.join('\n');
      }
      return { model: `xai:${model}+web+x_search`, content, tokens: j.usage?.total_tokens || 0, ms: Date.now() - t0 };
    } catch (e) { if (e.name === 'TimeoutError') return { model: `xai:${model}`, error: 'Timeout' }; continue; }
  }
  return { model: 'xai:grok', error: 'All variants unavailable' };
}

async function callPerplexity(prompt) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { model: 'perplexity:sonar-deep-research', error: 'PERPLEXITY_API_KEY not set' };
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonar-deep-research', messages: [{ role: 'user', content: prompt }], max_tokens: 8000 }),
      signal: AbortSignal.timeout(360_000),
    });
    if (!r.ok) return { model: 'perplexity:sonar-deep-research', error: `HTTP ${r.status}: ${(await r.text()).slice(0,240)}` };
    const j = await r.json();
    return { model: 'perplexity:sonar-deep-research', content: j.choices?.[0]?.message?.content || '', citations: j.citations || [], tokens: j.usage?.total_tokens || 0, ms: Date.now() - t0 };
  } catch (e) { return { model: 'perplexity:sonar-deep-research', error: e.name === 'TimeoutError' ? 'Timeout' : String(e.message) }; }
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { model: 'google:gemini', error: 'GEMINI_API_KEY not set' };
  const t0 = Date.now();
  for (const model of ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8000 }, tools: [{ google_search: {} }] };
      let r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
      if (!r.ok) {
        const errTxt = await r.text();
        if (errTxt.includes('google_search')) {
          body.tools = [{ google_search_retrieval: {} }];
          r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
          if (!r.ok) { if (r.status === 404) continue; return { model: `google:${model}`, error: `HTTP ${r.status}` }; }
        } else { if (r.status === 404) continue; return { model: `google:${model}`, error: `HTTP ${r.status}: ${errTxt.slice(0,240)}` }; }
      }
      const j = await r.json();
      return { model: `google:${model}+search`, content: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''), tokens: j.usageMetadata?.totalTokenCount || 0, ms: Date.now() - t0 };
    } catch (e) { if (e.name === 'TimeoutError') return { model: `google:${model}`, error: 'Timeout' }; continue; }
  }
  return { model: 'google:gemini', error: 'All variants unavailable' };
}

async function callGPT(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { model: 'openai:gpt', error: 'OPENAI_API_KEY not set' };
  const t0 = Date.now();
  for (const [model, body] of [
    ['gpt-4o', { model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], max_tokens: 8000 }],
    ['o3',     { model: 'o3',     messages: [{ role: 'user', content: prompt }], max_completion_tokens: 8000 }],
    ['o1',     { model: 'o1',     messages: [{ role: 'user', content: prompt }], max_completion_tokens: 6000 }],
  ]) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      if (!r.ok) { if (r.status === 404 || r.status === 400) continue; return { model: `openai:${model}`, error: `HTTP ${r.status}: ${(await r.text()).slice(0,240)}` }; }
      const j = await r.json();
      return { model: `openai:${model}`, content: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, ms: Date.now() - t0 };
    } catch (e) { if (e.name === 'TimeoutError') return { model: `openai:${model}`, error: 'Timeout' }; continue; }
  }
  return { model: 'openai:gpt', error: 'All variants unavailable' };
}

async function main() {
  const { profile, source } = loadProfile();
  const PROMPT = buildPrompt(profile);
  const ind = profile.individual || {};
  const st = profile.relocation?.short_term || {};
  const lt = profile.relocation?.long_term || {};

  console.log('🌏  Firing relocation career strategy research across 4 models in parallel...');
  console.log(`    Profile: ${ind.name || 'subject'} → ${st.place || '?'} → ${lt.place || '?'}  [source: ${source}]`);
  console.log('    Questions: timing, legal structure, employer targeting, positioning, long-term path, risk');
  console.log(`    Output: ${OUT}\n`);

  const t0 = Date.now();
  const [grok, perplexity, gemini, gpt] = await Promise.all([
    callGrok(PROMPT).then(r => { console.log(`  ✓ Grok        ${r.error ? '❌ ' + r.error : '✅ ' + r.ms + 'ms'}`); return r; }),
    callPerplexity(PROMPT).then(r => { console.log(`  ✓ Perplexity  ${r.error ? '❌ ' + r.error : '✅ ' + r.ms + 'ms'}`); return r; }),
    callGemini(PROMPT).then(r => { console.log(`  ✓ Gemini      ${r.error ? '❌ ' + r.error : '✅ ' + r.ms + 'ms'}`); return r; }),
    callGPT(PROMPT).then(r => { console.log(`  ✓ GPT/o3      ${r.error ? '❌ ' + r.error : '✅ ' + r.ms + 'ms'}`); return r; }),
  ]);

  console.log(`\n  Total: ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  let out = `# Relocation Career Strategy: ${ind.name || 'Subject'}, ${TODAY}\n\n`;
  out += `Profile: ${ind.current_role || ''} → ${st.place || '?'} (${st.window || ''}) → ${lt.place || '?'} (${lt.window || ''})\n`;
  out += `Questions: timing | legal structure | employer targeting | positioning | long-term path | risk\n\n---\n\n`;

  for (const r of [grok, perplexity, gemini, gpt]) {
    out += `## ${r.model}${r.tokens ? ` (${r.tokens} tok, ${r.ms}ms)` : ''}\n\n`;
    out += r.error ? `> ❌ Error: ${r.error}\n\n` : r.content + '\n\n';
    if (r.citations?.length) out += `**Citations:**\n${r.citations.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\n`;
    out += '---\n\n';
  }

  writeFileSync(OUT, out);
  console.log(`📄  Results written to: ${OUT}`);
}

// Import guard: only fire the (paid) model calls when run directly, so the
// module can be imported for testing buildPrompt()/loadProfile() with no spend.
const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  await main();
}

export { buildPrompt, loadProfile };
