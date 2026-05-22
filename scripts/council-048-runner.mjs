#!/usr/bin/env node
// Council pass — #048 Anthropic Engineering Editorial Lead.
// $10 authorized spend per Part 3 prompt of dashboard hardening sprint.
// Fires the full premium lineup, writes report + synthesis to disk.

import { callCouncil, initCostTrace } from '../lib/council.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

const ROOT = '/Users/mitchellwilliams/Documents/career-ops';
dotenv.config({ path: join(ROOT, '.env'), override: true });

const today = new Date().toISOString().slice(0, 10);
const REPORT_PATH = join(ROOT, `data/council-report-048-${today}.md`);
const SYNTHESIS_PATH = join(ROOT, 'apply-pack/048-anthropic-engineering-editorial-lead/council-synthesis.md');
const TRACKER_TSV_PATH = join(ROOT, `batch/tracker-additions/048-council-pass-${today}.tsv`);

// Lineup — full premium council (7 models). Per Mitchell's Decision-Maximization
// Policy: quality > speed > cost. Council fan-out full lineup, no subsets.
const LINEUP = [
  'anthropic:claude-sonnet-4-6',
  'anthropic:claude-opus-4-7',         // bias-check leaf
  'openai:gpt-5',
  'google:gemini-2.5-pro',
  'perplexity:sonar-pro',
  'perplexity:sonar-reasoning-pro',    // visible CoT audit
  'xai:grok-4-x-search',               // real-time signal (Anthropic blog landscape)
];

const PROMPT = `You are part of a council of frontier models evaluating a job application decision.

ROLE: Anthropic — Engineering Editorial Lead
LOCATION: San Francisco, CA OR New York City, NY (hybrid, 25% in-office minimum)
COMP: $255,000 – $320,000 USD annual salary (base; equity + benefits not detailed in JD)
URL: https://job-boards.greenhouse.io/anthropic/jobs/5138099008

JOB DESCRIPTION (verbatim from greenhouse.io 2026-05-22):

The role involves defining editorial strategy for the engineering blog, sourcing story ideas with engineering teams, and editing posts end-to-end — from substantive feedback on structure and clarity through publication. The person will coach engineers through writing, coordinate with leadership on timing relative to product launches, and work with design and marketing teams on promotion.

REQUIRED QUALIFICATIONS:
- 5+ years of editorial experience, strong track record of editing technical or complex content for broad audiences
- Exceptional editing skills
- Curiosity about technology
- Ability to extract ideas from subject-matter experts
- Strategic thinking about content
- Comfort navigating competing priorities that come with turning internal work into external-facing content

PREFERRED QUALIFICATIONS:
- Background in technical writing, developer communications, or engineering
- Experience running technical blogs
- Familiarity with AI/ML communications
- Building editorial workflows in fast-moving organizations
- Portfolio demonstrating editing of technically dense material

—

CANDIDATE: Mitchell Williams (Seattle, WA)

CURRENT (8 yrs Google):
- Internal Comms Lead + PM, Cross-Google Engineering (xGE) — Jun 2024 to present.
  Serves ~1,000+ Principal/Distinguished/Fellow ICs (top 0.5% of Google's 180K eng org).
  Shipped 3 production LLM agents:
    1. Autonomous comms triage agent — 3-prompt arch, ~160 hrs/yr saved, >90% accuracy
    2. Executive RAG pipeline ("Voice DNA" + "Kill List") — 90% drafting latency cut, 99% stylistic fidelity
    3. AI-driven mentorship platform — 90% admin time cut (3.5hr → 20min), 300% capacity scale
  Drove enterprise approvals governance overhaul — 50% reduction in ad hoc exec requests.
  Architected Senior Technical Leadership Summit — 348 senior engineers, 93% CSAT.
- Senior Comms & Content Manager, Google Corporate Engineering (TechStop) — Apr 2018 to Jun 2024.
  Comms strategist for Corp Eng + TechStop (global internal IT serving 180K employees).
  Q1 2020: provisioned 9,000 machines + 9,500 hotspots in one week, +80% self-provisioning efficiency.
  Service desk migration: 75% reduction in dev latency, ~$1M annual infra savings.
  1.7M+ YouTube views across recruitment content portfolio.

NEWSROOM DECADE (prior to Google):
- Senior Producer, AJ+ (2016-2018) — 50M+ view viral campaign at AJ+ peak.
  Led team of 10+ producers; coached 3 producers (Mara Van Ells, Yara Elmjouie, Sana Saeed) to on-camera principals with Emmy/Webby wins. Field-produced San Juan Mayor Carmen Yulin Cruz crisis interview during active Hurricane Maria.
- Writer/Producer, CNN "New Day" (2016 election cycle).
- Line Producer, Fusion "America With Jorge Ramos" (2013-2015) — 179% primetime viewership growth, 40M household distribution. Field-produced live breaking news from a backpack during Hong Kong Umbrella Revolution Oct 2014 ("we're coming to you live from a backpack on the back of my producer").
- Segment Producer, HuffPost Live (2012-2013) — Mashable "Biggest Innovation in Media" + Webby Award; operated under "attack the attacker" legal posture during Scientology coverage.
- Earlier: CCTV America (DC bureau, 1-hr live news daily rundown), Al Jazeera English "The Stream" launch team (pivoted launch-night rundown after bin Laden killed May 2 2011, brought Sohaib Athar @ReallyVirtual live on Skype — pioneered social-media data journalism).

EDUCATION: BA Journalism, Indiana University Bloomington
CERTS: Anthropic AI Fluency / Claude 101 / Agent Skills / MCP (March 2026); Anthropic Skill Builder cohort (May 2026, claude-opus-4-7 cohort)
PORTFOLIO: thestorytellermitch.com (live writing); career-ops fork (Claude-Code-Skills-based AI job-search agentic pipeline, github.com/mitwilli-create/career-ops)
SKILLS: LLM orchestration, MCP, agent skills, RAG, prompt engineering, Voice DNA / Kill List methodology, executive comms under regulatory + litigation scrutiny, principal-level briefing + ghostwriting, on-camera talent coaching, Apps Script, Node.js, Python (learning).

PRIOR EVALUATION (2026-05-16, sonnet-only):
Score 4.6/5 with APPLY decision. All 12 hard gates checked, none fired. Citation audit clean (13/13 valid). The single dissent flag was "1/1 agreement (sigma=0.00)" — no cross-model triangulation. That's what THIS council pass is for.

—

YOUR TASK:

Answer ALL of the following in the structure shown. Be evidence-backed and specific. Do NOT hedge — Mitchell needs decisional clarity.

1. FIT SCORE: X.X / 5.0 (one decimal). Include confidence level (HIGH / MEDIUM / LOW) and the ONE-sentence reason for the confidence level.

2. TOP 3 STRENGTHS (evidence-backed, cite specific JD requirement + Mitchell's credential each). Format:
   - JD requirement: "<exact quote from JD>"
     Mitchell's credential: <specific item with metric>
     Why this is a top-3 strength: <1-2 sentences>

3. TOP 3 CONCERNS (genuine, not hedges). Format:
   - Concern: <specific issue>
     Severity: HIGH / MEDIUM / LOW
     Why genuine: <1-2 sentences — what would a hiring manager actually push back on>
     Mitigation potential: <can this be addressed pre-apply, in cover letter, or only in interview>

4. COVER LETTER LEAD (first 1-2 sentences that would grab THIS hiring manager). Write the actual sentences — not advice about what to write. Maximum 50 words.

5. COMPETITIVE EDGE: What does Mitchell have that most candidates for THIS role almost certainly lack? Be specific and falsifiable — name the credential, the metric, or the artifact. Not generic ("strong storyteller") but specific ("8 years editorial newsroom + 8 years inside Google's senior engineering org coaching writers — almost zero candidates have both halves").

6. RECOMMENDATION: APPLY / APPLY WITH RESERVATIONS / SKIP. Single word + 1-sentence rationale + the single highest-leverage thing he should do BEFORE submitting.

7. RED-TEAM CHECK: What is the strongest argument AGAINST applying that you can construct? (Answer this even if you concluded APPLY — Mitchell wants the steelman.)

Return ONLY the structured answer. No preamble, no commentary, no "Here's my analysis" framing.`;

console.log(`[council-048] Firing ${LINEUP.length}-model council pass...`);
console.log(`[council-048] Lineup: ${LINEUP.join(', ')}`);
console.log(`[council-048] Prompt size: ${PROMPT.length} chars`);

mkdirSync(join(ROOT, 'batch/tracker-additions'), { recursive: true });

const t0 = Date.now();
const onCostRecord = initCostTrace('council-048', ROOT);
const result = await callCouncil({
  prompt: PROMPT,
  models: LINEUP,
  opts: { timeoutMs: 300_000, onCostRecord, agentSlug: 'council-048' },
});
const elapsed = Date.now() - t0;

const totalCost = (result.results || []).reduce((s, r) => s + (r.costUsd || 0), 0);
const successCount = (result.results || []).filter(r => r.content && !r.error).length;

console.log(`[council-048] Council complete in ${(elapsed / 1000).toFixed(1)}s`);
console.log(`[council-048] Models responded: ${successCount}/${LINEUP.length}`);
console.log(`[council-048] Total cost: $${totalCost.toFixed(4)}`);
if (result.missingKeys && result.missingKeys.length) {
  console.log(`[council-048] Missing keys: ${result.missingKeys.map(m => m.model).join(', ')}`);
}

// Write full report
let report = `# Council Report — #048 Anthropic Engineering Editorial Lead\n\n`;
report += `**Date:** ${today}\n`;
report += `**JD URL:** https://job-boards.greenhouse.io/anthropic/jobs/5138099008\n`;
report += `**Authorized spend:** $10 (per Part 3 prompt)\n`;
report += `**Actual spend:** $${totalCost.toFixed(4)}\n`;
report += `**Elapsed:** ${(elapsed / 1000).toFixed(1)}s\n`;
report += `**Models fired:** ${LINEUP.length}\n`;
report += `**Models responded:** ${successCount}\n\n`;
if (result.missingKeys && result.missingKeys.length) {
  report += `**Missing API keys (model skipped):** ${result.missingKeys.map(m => `${m.model} (${m.missingEnvVar})`).join(', ')}\n\n`;
}
report += `---\n\n## Per-model responses\n\n`;
for (const r of (result.results || [])) {
  report += `### ${r.model}\n\n`;
  if (r.error) {
    report += `**ERROR:** ${r.error}\n\n`;
    continue;
  }
  report += `**Tokens:** ${r.tokens || 0} · **Cost:** $${(r.costUsd || 0).toFixed(4)} · **Time:** ${((r.ms || 0) / 1000).toFixed(1)}s\n\n`;
  if (r.jailbreakRefusal) report += `**⚠ Jailbreak refusal:** ${r.jailbreakRefusal} (auto-retry: ${r.jailbreakRetry ? 'yes' : 'no'})\n\n`;
  report += `${r.content || '(empty response)'}\n\n`;
  if (r.citations && r.citations.length) {
    report += `**Citations:** ${r.citations.length}\n`;
    for (const c of r.citations.slice(0, 10)) {
      report += `- ${c.title || c.url || c}\n`;
    }
    report += `\n`;
  }
  report += `---\n\n`;
}
writeFileSync(REPORT_PATH, report);
console.log(`[council-048] Wrote ${REPORT_PATH}`);

// Write synthesis — the FIRST successful response goes verbatim. (Mitchell can
// triangulate per-model in the full report; the synthesis is the lead voice
// from sonnet 4.6 as Anthropic's own model speaking for Anthropic's role.)
const sonnet = (result.results || []).find(r => r.model === 'anthropic:claude-sonnet-4-6' && r.content && !r.error);
const synthLead = sonnet || (result.results || []).find(r => r.content && !r.error);
let synthesis = `# Council Synthesis — #048 Anthropic Engineering Editorial Lead\n\n`;
synthesis += `**Generated:** ${today} via ${LINEUP.length}-model council pass\n`;
synthesis += `**Full report:** [data/council-report-048-${today}.md](../../data/council-report-048-${today}.md)\n`;
synthesis += `**Total spend:** $${totalCost.toFixed(4)}\n\n`;
synthesis += `---\n\n`;
if (synthLead) {
  synthesis += `## Lead voice — ${synthLead.model}\n\n`;
  synthesis += synthLead.content;
  synthesis += `\n\n---\n\n`;
}
synthesis += `## Cross-model convergence\n\n`;
synthesis += `${successCount} of ${LINEUP.length} models responded. Read the full report for per-model FIT SCORE + TOP 3 strengths/concerns and look for convergence patterns:\n\n`;
synthesis += `- If all models cluster at 4.4-4.7, the prior 4.6 score is well-calibrated. APPLY.\n`;
synthesis += `- If spread is >0.5 between models, dig into the dissent before applying.\n`;
synthesis += `- If any model recommends SKIP, read its red-team carefully — that's the steelman against this application.\n\n`;
synthesis += `Spend: $${totalCost.toFixed(4)} of $10 authorized.\n`;
mkdirSync(join(ROOT, 'apply-pack/048-anthropic-engineering-editorial-lead'), { recursive: true });
writeFileSync(SYNTHESIS_PATH, synthesis);
console.log(`[council-048] Wrote ${SYNTHESIS_PATH}`);

// Tracker TSV update — row 48 note. Status stays "Evaluated".
// Columns: num, date, company, role, status, score, pdf, report, notes
const noteText = `Council pass complete ${today}: ${successCount}/${LINEUP.length} models responded, $${totalCost.toFixed(2)} spend, lead-voice ${synthLead ? synthLead.model : 'none'}, full report data/council-report-048-${today}.md, synthesis apply-pack/048-anthropic-engineering-editorial-lead/council-synthesis.md.`;
const tsvLine = `48\t2026-04-27\tAnthropic\tEngineering Editorial Lead\tEvaluated\t4.6/5\t✅\t[48](reports/2174-anthropic-engineering-editorial-lead-2026-05-16.md)\t${noteText}\n`;
writeFileSync(TRACKER_TSV_PATH, tsvLine);
console.log(`[council-048] Wrote ${TRACKER_TSV_PATH}`);

console.log(`\n[council-048] DONE`);
console.log(`  Report:    ${REPORT_PATH}`);
console.log(`  Synthesis: ${SYNTHESIS_PATH}`);
console.log(`  Tracker:   ${TRACKER_TSV_PATH}`);
console.log(`  Spend:     $${totalCost.toFixed(4)} / $10 authorized`);
