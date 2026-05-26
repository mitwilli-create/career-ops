/**
 * lib/_agent-bridge.mjs — Council-backed Agent bridge
 *
 * Implements the Agent({ subagent_type: 'researcher', prompt }) interface that
 * lib/company-pulse.mjs (and similar libs) call when running outside Claude Code
 * (i.e., in launchd-scheduled scripts where the Agent tool is unavailable).
 *
 * Maps researcher calls → callCouncil() with live-search models, writes the
 * result to data/company-pulse-reports/ and returns { path, cost_estimate }.
 *
 * Design constraints:
 *  - Must stay within the per-call budget passed in the prompt (default $2)
 *  - Must write a markdown file that parsePulseReport() can read
 *  - Must return { path, cost_estimate } matching the researcher agent contract
 *  - Single model (sonar-reasoning-pro) — multi-model is caller's prerogative
 *
 * Created 2026-05-26 to unblock company-pulse (all 30 daily calls were failing
 * with "Agent bridge not available" — 0% success rate since lib/ was shipped).
 */

import { callCouncil } from './council.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const REPORTS_DIR = join(REPO_ROOT, 'data', 'company-pulse-reports');

// Models suited for live company-signal research.
// perplexity:sonar-reasoning-pro — real-time web + X search, good citation density.
// Stays within the default $2/call budget.
const RESEARCH_MODELS = ['perplexity:sonar-reasoning-pro'];

/**
 * Agent bridge — implements the Claude Code Agent tool signature.
 *
 * @param {object} opts
 * @param {string} opts.subagent_type — only 'researcher' is supported
 * @param {string} opts.prompt        — the research prompt (may include | --fast etc.)
 * @returns {Promise<{ path: string, cost_estimate: number }>}
 */
export async function Agent({ subagent_type, prompt }) {
  if (subagent_type !== 'researcher') {
    throw new Error(
      `_agent-bridge: subagent_type '${subagent_type}' not supported. Only 'researcher' is bridged.`
    );
  }

  // Strip | --fast, | --no-dealbreaker, and similar CLI flags injected by callers.
  const cleanPrompt = prompt.replace(/\s*\|?\s*--[\w-]+/g, '').trim();

  const t0 = Date.now();
  let responseText = '';
  let costEstimate = 0;

  try {
    const councilResult = await callCouncil({
      prompt: cleanPrompt,
      models: RESEARCH_MODELS,
      opts: {
        taskType:  'long_form_research',
        timeoutMs: 110_000,
      },
    });

    const succeeded = (councilResult.results || []).filter(r => !r.error);
    if (succeeded.length === 0) {
      const errors = (councilResult.results || []).map(r => r.error || '(no error)').join('; ');
      responseText = `## Research Error\n\nAll council models failed. Errors: ${errors}`;
    } else {
      responseText = succeeded
        .map(r => `## Research Results (${r.modelUsed || r.model})\n\n${r.content || ''}`)
        .join('\n\n---\n\n');
      costEstimate = councilResult.report?.totalCost ?? 0;
    }
  } catch (err) {
    responseText = `## Research Error\n\nCouncil call failed: ${err.message}`;
  }

  // Wrap in a dated header so parsePulseReport section extractors have context.
  const isoNow  = new Date().toISOString();
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  const report = `---
generated_at: ${isoNow}
elapsed_s: ${elapsedS}
cost_estimate_usd: ${costEstimate.toFixed(4)}
bridge: _agent-bridge → callCouncil(${RESEARCH_MODELS.join(',')})
---

${responseText}
`;

  mkdirSync(REPORTS_DIR, { recursive: true });
  const fname = `pulse-report-${isoNow.replace(/[:.]/g, '-')}.md`;
  const path  = join(REPORTS_DIR, fname);
  writeFileSync(path, report, 'utf8');

  return { path, cost_estimate: costEstimate };
}
