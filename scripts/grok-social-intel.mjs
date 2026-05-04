#!/usr/bin/env node
/**
 * Grok Job #1 — Per-role social intelligence for career-ops batch evaluation.
 *
 * Calls xAI Responses API with web_search tool to gather social intel about
 * the company + team + role: hiring discussion, culture, recent layoffs,
 * employee sentiment, interview experiences. The 90-day recency constraint
 * is enforced via the prompt (xAI removed structured date filtering when
 * Live Search migrated from chat/completions to /v1/responses).
 *
 * Returns a structured markdown block for embedding in evaluation reports.
 * Fails gracefully — Grok failure does NOT kill evaluation.
 *
 * Usage:
 *   node scripts/grok-social-intel.mjs \
 *     --company="Anthropic" \
 *     --role="Communications Manager, Research" \
 *     --url="https://job-boards.greenhouse.io/anthropic/jobs/5153680008"
 *
 * Environment: requires XAI_API_KEY
 *
 * Cost cap: enforced via data/grok-spend.log file. Default $5/day.
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const SPEND_LOG = join(ROOT, 'data/grok-spend.log');
const DAILY_CAP_USD = 5.0;
const ESTIMATED_COST_PER_QUERY = 0.10; // conservative estimate; verify against actual xAI billing
const XAI_ENDPOINT = 'https://api.x.ai/v1/responses';
const XAI_MODEL = 'grok-4-fast-reasoning';
const REQUEST_TIMEOUT_MS = 90000;  // 30s was insufficient — grok-4-fast-reasoning with web_search routinely takes 45-75s

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const COMPANY = args.company;
const ROLE = args.role;
const URL = args.url;

if (!COMPANY || !ROLE) {
  console.error('ERROR: --company and --role are required');
  console.error('Usage: node grok-social-intel.mjs --company="X" --role="Y" [--url="Z"]');
  process.exit(1);
}

if (!process.env.XAI_API_KEY) {
  console.error('ERROR: XAI_API_KEY not set in environment');
  process.exit(2);
}

function checkSpendCap() {
  if (!existsSync(SPEND_LOG)) return { allowed: true, todaySpent: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(SPEND_LOG, 'utf-8').split('\n').filter(Boolean);
  const todayLines = lines.filter(l => l.startsWith(today));
  const todaySpent = todayLines.reduce((sum, l) => {
    const cost = parseFloat(l.split('\t')[2] || 0);
    return sum + (isNaN(cost) ? 0 : cost);
  }, 0);
  return { allowed: todaySpent < DAILY_CAP_USD, todaySpent };
}

function logSpend(cost) {
  const today = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  appendFileSync(SPEND_LOG, `${today}\t${ts}\t${cost.toFixed(4)}\t${COMPANY} - ${ROLE}\n`);
}

function emitFailureBlock(reason) {
  const block = `## Social Intelligence (Grok Job #1)

**Status:** Unavailable — ${reason}

The evaluation continues using corpus/companies/{slug}.md content as fallback
context. No live social signal applied to this report.
`;
  console.log(block);
  process.exit(0);
}

function emitBlock(grokContent, citations) {
  const citationsBlock = citations && citations.length
    ? `\n**Citations:**\n${citations.map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : (c.url || c.title || JSON.stringify(c))}`).join('\n')}\n`
    : '';

  const block = `## Social Intelligence (Grok Job #1)

**Source:** xAI Grok Live Search (${XAI_MODEL}), recency-bounded last 90 days
**Generated:** ${new Date().toISOString()}
**Query scope:** ${COMPANY} + ${ROLE} + culture + hiring + employee sentiment

${grokContent}
${citationsBlock}
---

*This block represents Grok's findings, separated from Claude's reasoning.
Treat as input to the Cultural Signals dimension and ANTHROPIC-POSTING /
EQUITY-RISK-PROFILE / LATERAL-MOVE-TRADEOFF flag evaluation.*
`;
  console.log(block);
}

async function callGrokLiveSearch() {
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const prompt = `You are doing targeted social-channel research for a career evaluation.

TARGET: ${COMPANY} — specifically the team hiring for "${ROLE}"
${URL ? `JOB URL: ${URL}` : ''}

Research the following using web search, focusing ONLY on content published
between ${ninetyDaysAgo} and ${today} (the last 90 days). Skip any source
older than that window.

1. Recent culture signal at ${COMPANY} affecting the org/team this role sits in
2. Layoff history affecting this team or adjacent teams (last 90 days)
3. Leadership behavior patterns for the org this role reports into
4. Employee sentiment from public posts (X, Reddit, Hacker News, public Discord)
5. Interview experiences and hiring patterns specifically for this role type
6. Quality of life indicators (hours, on-call, RTO requirements)

OUTPUT a concise markdown summary with:
- 3-5 specific findings with sources
- Net signal (positive / mixed / negative)
- Specific JD red flags or green flags worth noting

Keep total response under 400 words. Cite every claim with source URL.
Do not paraphrase source language closely. Skip findings without verifiable sources.`;

  const requestBody = {
    model: XAI_MODEL,
    input: [
      { role: 'user', content: prompt }
    ],
    tools: [
      { type: 'web_search' }
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(XAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`xAI API ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();

    // Responses API: output_text is the convenience accessor; otherwise
    // walk output[].content[].text. Citations live at response.citations
    // (top-level, populated when web_search tool was invoked).
    const content = extractContent(data);
    if (!content) throw new Error(`Empty response from xAI. Response keys: ${Object.keys(data).join(',')}`);

    const citations = data.citations || [];
    return { content, citations };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Grok query timeout (${REQUEST_TIMEOUT_MS / 1000}s)`);
    }
    throw err;
  }
}

function extractContent(data) {
  // Try multiple known response shapes; xAI Responses API parity with
  // OpenAI Responses API surfaces both output_text and structured output.
  if (data.output_text) return data.output_text;
  if (Array.isArray(data.output)) {
    const texts = [];
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' || c.type === 'text') {
            if (c.text) texts.push(c.text);
          }
        }
      }
    }
    if (texts.length) return texts.join('\n\n');
  }
  // Fallback to chat-completions-like shape if API still bridges old format
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  return null;
}

async function main() {
  const { allowed, todaySpent } = checkSpendCap();
  if (!allowed) {
    emitFailureBlock(`Daily cost cap reached ($${todaySpent.toFixed(2)} of $${DAILY_CAP_USD})`);
  }

  let result;
  try {
    result = await callGrokLiveSearch();
  } catch (err) {
    emitFailureBlock(`Grok query failed: ${err.message}`);
  }

  logSpend(ESTIMATED_COST_PER_QUERY);
  emitBlock(result.content, result.citations);
}

main();
