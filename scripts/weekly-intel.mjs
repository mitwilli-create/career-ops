#!/usr/bin/env node
/**
 * Weekly market intelligence pipeline for Mitchell's job search.
 *
 * Runs Sunday 02:00 PT via launchd (com.mitchell.career-ops.weekly-intel.plist).
 * Uses Claude to generate research on: target roles, company health, comp/equity
 * trends, IPO/stock signals, emerging skills, recommended LinkedIn contacts,
 * and optimal cities. Also writes ready-to-paste prompts for ChatGPT, Gemini,
 * Perplexity Pro, and Grok so Mitchell can run those manually.
 *
 * Outputs:
 *   data/weekly-intel/CURRENT.md          — always the latest report
 *   data/weekly-intel/YYYY-MM-DD.md       — dated archive
 *   data/weekly-intel/prompts/            — external-platform prompt files
 *
 * Usage:
 *   node scripts/weekly-intel.mjs            # full run
 *   node scripts/weekly-intel.mjs --dry-run  # print Claude prompt, skip writes
 *   node scripts/weekly-intel.mjs --prompts-only  # only regenerate prompt files
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

const ROOT = process.cwd();
const INTEL_DIR   = join(ROOT, 'data/weekly-intel');
const PROMPTS_DIR = join(INTEL_DIR, 'prompts');
const CURRENT     = join(INTEL_DIR, 'CURRENT.md');
const DATE        = new Date().toISOString().slice(0, 10);
const DATED       = join(INTEL_DIR, `${DATE}.md`);

const args = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const PROMPTS_ONLY = args.includes('--prompts-only');

for (const d of [INTEL_DIR, PROMPTS_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ─── Load profile for research context ───────────────────────────────────────

let profileContext = '';
try {
  const profileYml = readFileSync(join(ROOT, 'config/profile.yml'), 'utf-8');
  const cvMd = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  // Pull target roles section from profile
  const rolesMatch = profileYml.match(/target_roles:([\s\S]*?)narrative:/);
  const roles = rolesMatch ? rolesMatch[1].trim() : '';
  // Pull headline
  const headlineMatch = profileYml.match(/headline:\s*"([^"]+)"/);
  const headline = headlineMatch ? headlineMatch[1] : '';
  // Pull comp target
  const compMatch = profileYml.match(/target_range:\s*"([^"]+)"/);
  const comp = compMatch ? compMatch[1] : '$140K-$240K';
  profileContext = `
CANDIDATE CONTEXT:
- Name: Mitchell Williams
- Current: ${headline}
- Target comp: ${comp}
- Primary archetypes: AI Solutions Architect, Forward Deployed Engineer, Applied AI Engineer, AI Enablement Lead, AI Program Manager, Communications Manager (AI-native), Developer Education Lead, Engineering Editorial Lead
- Location: Seattle WA, open to relocation globally
- Key differentiators: shipped 3 production AI systems at Google xGE for 1,000+ senior engineers; 18 years editorial (CNN, Al Jazeera, AJ+, Fusion, HuffPost); Voice DNA methodology; comms × builder hybrid
`.trim();
} catch {
  profileContext = 'Candidate: Mitchell Williams, AI Communications + Builder PgM @ Google xGE.';
}

// ─── Previous report for trend comparison ────────────────────────────────────

function lastReport() {
  if (!existsSync(INTEL_DIR)) return '';
  const files = readdirSync(INTEL_DIR)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .sort()
    .reverse();
  if (files.length === 0) return '';
  const prev = files[0];
  if (prev === `${DATE}.md`) return files[1] ? readFileSync(join(INTEL_DIR, files[1]), 'utf-8') : '';
  return readFileSync(join(INTEL_DIR, prev), 'utf-8');
}

const previousReport = lastReport();
const prevContext = previousReport
  ? `\nPREVIOUS REPORT DATE: ${previousReport.match(/# Weekly Intel — (\S+)/)?.[1] || 'prior week'}\nUse it to flag shifts, reversals, or confirmations of prior signals. Do not repeat unchanged info — only what changed.\n`
  : '\nThis is the first report — no prior baseline.\n';

// ─── Claude research prompt ───────────────────────────────────────────────────

const CLAUDE_PROMPT = `You are a career intelligence analyst running a weekly market briefing for a senior professional who is actively searching for AI-native roles.

${profileContext}
${prevContext}
TODAY: ${DATE}

Generate a concise, actionable weekly intel report. Use your training data and reasoning to surface what you know about the current AI job market. Where information is uncertain or time-sensitive, flag it explicitly with "[VERIFY]" so the candidate knows to cross-check before acting.

Output EXACTLY this structure (preserve all headers):

# Weekly Intel — ${DATE}

## 1. Market Pulse — Hiring Activity

Which of the following companies are actively hiring for Mitchell's archetypes (AI Solutions Architect, Forward Deployed Engineer, Applied AI Engineer, AI Enablement Lead, AI PgM, Comms/Editorial AI-native)?

List the 8–12 highest-signal companies right now with one line each:
**[Company]** — [what they're hiring for] — [signal: recent funding / product launch / headcount signal] [VERIFY if uncertain]

## 2. Company Health Signals

For the top 15 AI-native companies Mitchell should target (Anthropic, OpenAI, Google DeepMind, Mistral, Cohere, Perplexity, Inflection, xAI, Character.AI, Adept, Imbue, Stability AI, Runway, ElevenLabs, Harvey), provide:

**[Company]** — [financial health: funded/profitable/burning] — [hiring: expanding/flat/contracting] — [IPO/acquisition likelihood: high/medium/low] [VERIFY if uncertain]

## 3. Compensation & Equity Trends

Current market rates for Mitchell's target archetypes at Series B+ AI companies and Big Tech AI divisions. Format as a table:

| Role | Base | Equity (annual) | Total Comp | Notes |
|------|------|-----------------|------------|-------|
[8–10 rows covering his primary archetypes at different company stages]

Flag: Is the market moving up or down vs. 3 months ago? Which companies are expanding comp bands?

## 4. IPO & Liquidity Signals

Which AI companies are most likely to IPO or be acquired in the next 12–18 months? Why does this matter for joining them now?

List 5–8 companies with:
**[Company]** — [IPO/exit likelihood] — [timeline estimate] — [what joining now means for equity] [VERIFY]

## 5. Skill & Certification Signals

What skills and certifications are appearing in JDs for Mitchell's target archetypes that weren't prominent 6 months ago? What is becoming a table-stakes requirement?

Format as:
**[Skill/cert]** — [frequency signal: emerging/growing/table-stakes] — [recommended action: learn/showcase/ignore]

Focus on: LLM orchestration frameworks, MCP, agent evaluation, RAG architecture, specific tools (LangChain, DSPy, LlamaIndex, Vertex AI, Bedrock), and communications-specific AI skills.

## 6. Recommended LinkedIn Contacts

For each of the top 5 companies Mitchell should prioritize this week, identify the profile type (not specific names since those change) most worth cold-reaching:

**[Company]** — reach out to: [job title / team] — [why: hiring manager / gatekeeper / connector] — [suggested angle for outreach]

## 7. Geography Intelligence

Where are Mitchell's target roles concentrating right now?

- Top 3 US metros for his archetypes (with signal: remote-friendly vs. onsite pressure)
- Top 3 international cities where AI-native companies are expanding that offer strong quality-of-life + reasonable comp (with visa pathway notes)
- Any cities to deprioritize this cycle

## 8. Application & Profile Intelligence

What is working right now for candidates targeting AI-native companies at this seniority level?

- What resume formats/lengths are passing ATS filters
- What profile elements are triggering recruiter outreach
- What cover letter approaches are landing interviews
- What is immediately disqualifying candidates at screening
- Any platform-specific (LinkedIn, GitHub) signals this week

## 9. This Week's Priority Actions

Given all of the above, the 5 highest-leverage actions Mitchell should take this week (ranked):

1. [Action] — [why now] — [time estimate]
2. ...

## 10. Signals to Watch

3–5 market signals that are uncertain now but worth monitoring. Set a mental reminder for each.

---
*Generated by \`scripts/weekly-intel.mjs\` on ${DATE}. Sections marked [VERIFY] should be cross-checked against live sources before acting on them.*`;

// ─── External platform prompts ────────────────────────────────────────────────

const SHARED_CONTEXT = `Context: I'm a senior professional searching for AI-native roles (AI Solutions Architect, Forward Deployed Engineer, Applied AI Engineer, AI Enablement Lead, AI Program Manager, Communications Lead at AI-native companies). I have 18 years in editorial (CNN, Al Jazeera, AJ+, HuffPost Live) plus 6 years at Google shipping production AI systems for 1,000+ senior engineers. Target comp: $140K–$240K. Open to relocation globally. I need the most current market intelligence to target the right companies, roles, and cities.`;

const PLATFORM_PROMPTS = {
  'chatgpt.md': `# ChatGPT Research Prompt — ${DATE}

Paste this into ChatGPT (GPT-4o with web search or plugins enabled for best results):

---

${SHARED_CONTEXT}

I need your most current intelligence (search the web if you can) on the following:

1. **Hiring activity**: Which AI-native companies (Anthropic, OpenAI, Cohere, Mistral, Perplexity, xAI, ElevenLabs, Runway, Harvey, Imbue, Character.AI, Adept) are actively expanding headcount right now, specifically for roles involving AI deployment, communications, solutions architecture, or program management?

2. **Compensation bands**: What are current total comp ranges (base + equity) for "Forward Deployed Engineer" and "AI Solutions Architect" roles at Series B–D AI companies vs. Big Tech AI divisions? Has this moved in the last 90 days?

3. **IPO signals**: Which AI companies are most likely to IPO or be acquired in the next 12–18 months? What does joining them now mean for equity?

4. **Skill gaps**: What technical or domain skills are appearing in AI-role JDs now that weren't required 6 months ago? What's becoming a table-stakes requirement for my target roles?

5. **Geography**: Where are AI-native companies concentrating their non-engineering hires (comms, solutions, enablement, editorial) right now — US metros and internationally?

Give me specific, actionable intelligence. Flag anything uncertain.

---
`,

  'gemini.md': `# Gemini Research Prompt — ${DATE}

Paste this into Gemini Advanced (1.5 Pro or Ultra with Google Search grounding):

---

${SHARED_CONTEXT}

Using your most current Google Search data, give me a weekly market briefing:

**Section A — Company Health Check**
For each of these companies, tell me their current funding status, headcount trajectory, and likelihood of IPO or acquisition in the next 12–18 months: Anthropic, OpenAI, Cohere, Mistral, Perplexity, xAI, Character.AI, ElevenLabs, Runway, Harvey AI, Imbue, Adept.

**Section B — Role Intelligence**
What are recruiters at these companies actually filtering for in "AI Solutions Architect," "Forward Deployed Engineer," and "Applied AI PM" roles right now? What resume elements are passing ATS, and what's getting screened out?

**Section C — Compensation Shifts**
Is total compensation for senior AI-adjacent non-engineering roles (comms, enablement, program management) trending up or down vs. 3 months ago? What companies are expanding comp bands?

**Section D — LinkedIn Signal**
What's working for senior candidates doing outbound LinkedIn outreach to recruiters and hiring managers at AI-native companies right now? What approach is getting response rates above 20%?

Be specific. Cite sources where you can. Flag uncertain information.

---
`,

  'perplexity.md': `# Perplexity Pro Research Prompt — ${DATE}

Paste this into Perplexity Pro (use "Focus: All" for broadest coverage):

---

${SHARED_CONTEXT}

Run the following 4 targeted searches and synthesize the results:

**Search 1**: "AI company hiring 2026 solutions architect forward deployed engineer"
→ What companies are actively posting these roles? What's the volume trend?

**Search 2**: "AI startup IPO 2026 2027 Anthropic Cohere Mistral xAI"
→ Which companies are preparing for IPO? What's the current valuation trajectory?

**Search 3**: "AI job market compensation 2026 total comp equity non-engineering"
→ Current comp benchmarks for AI-adjacent roles (not pure engineering). What's the equity picture at different stages?

**Search 4**: "best cities AI jobs 2026 relocation international remote"
→ Where are the best opportunities concentrating geographically for AI-native companies?

For each search, give me: key findings, most credible sources, what's uncertain, and what I should do with this information this week.

---
`,

  'grok.md': `# Grok Research Prompt — ${DATE}

Paste this into Grok (Heavy mode or Deep Search for best coverage of X/Twitter signals):

---

${SHARED_CONTEXT}

I need X/Twitter and real-time web signals on the following. Search X posts, threads, job postings, and news from the last 7–14 days:

**Thread 1 — Hiring signals from AI companies**
Search X for: hiring announcements, job posting signals, or headcount discussions at Anthropic, OpenAI, Cohere, Mistral, xAI, Perplexity, ElevenLabs, Runway, Harvey, Character.AI, Imbue, Adept. Who's hiring and for what? Who's quietly freezing?

**Thread 2 — Comp and equity discussions**
What are AI workers on X saying about compensation, equity, and offer quality right now? Are vesting schedules changing? Is the equity-to-base ratio shifting?

**Thread 3 — AI job search meta-intelligence**
What are recruiters, hiring managers, and senior AI professionals saying on X about what's working and what's failing in AI job applications right now? What's getting candidates fast-tracked? What's getting them ghosted?

**Thread 4 — IPO and exit signals**
What's the X/Twitter sentiment on Anthropic, Cohere, Mistral, and xAI IPO likelihood? Any insider signals, secondary market activity, or analyst commentary?

**Thread 5 — Skills and certifications**
What skills are AI practitioners and recruiters on X flagging as newly important or newly required in 2026? Any certs going viral as table-stakes?

**Thread 6 — Geography shifts**
Are there any X signals about AI companies expanding to new cities, changing their remote policy, or concentrating hiring in specific markets?

Synthesize each thread into 3–5 actionable bullets. Flag anything contradictory or uncertain.

---
`,
};

// ─── Run Claude research ──────────────────────────────────────────────────────

function runClaudeResearch() {
  console.log('Running Claude market intelligence research…');
  const result = spawnSync('claude', ['-p', '--output-format=text'], {
    input: CLAUDE_PROMPT,
    encoding: 'utf-8',
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });

  if (result.status !== 0) {
    console.error('Claude research failed:');
    console.error(result.stderr || '(no stderr)');
    return null;
  }

  return (result.stdout || '').trim();
}

// ─── Write outputs ────────────────────────────────────────────────────────────

function writePrompts() {
  for (const [filename, content] of Object.entries(PLATFORM_PROMPTS)) {
    const path = join(PROMPTS_DIR, filename);
    writeFileSync(path, content);
    console.log(`Prompt written: ${path}`);
  }
}

function archiveCount() {
  return readdirSync(INTEL_DIR).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/)).length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n=== CLAUDE RESEARCH PROMPT ===\n');
  console.log(CLAUDE_PROMPT);
  console.log('\n=== PLATFORM PROMPTS (would write) ===');
  for (const f of Object.keys(PLATFORM_PROMPTS)) console.log(`  data/weekly-intel/prompts/${f}`);
  console.log('\n[Dry run — no files written]');
  process.exit(0);
}

if (PROMPTS_ONLY) {
  writePrompts();
  console.log('Prompts updated. Copy from data/weekly-intel/prompts/ into each platform.');
  process.exit(0);
}

const report = runClaudeResearch();
if (!report) process.exit(1);

// Write dated archive
writeFileSync(DATED, report);
console.log(`Archive written: ${DATED}`);

// Overwrite CURRENT
writeFileSync(CURRENT, report);
console.log(`CURRENT updated: ${CURRENT}`);

// Write platform prompts
writePrompts();

console.log(`\nWeekly intel complete. ${archiveCount()} reports in archive.`);
console.log('Next: open data/weekly-intel/CURRENT.md and check sections marked [VERIFY].');
console.log('Then copy prompts from data/weekly-intel/prompts/ into ChatGPT / Gemini / Perplexity / Grok.');
