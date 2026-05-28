// lib/persona-omega-review.mjs
//
// Wave 2 task 8 of 14. Persona fan-in for /omega-steward Phase 4 proposals.
// When called, scans the omega recommendation list and asks DHH + Howard +
// Hickey (per their `when` predicates) whether each proposal warrants their
// review voice. Adds `persona_findings: [{persona, findings:[...]}]` to each
// reviewed recommendation. Non-blocking — advisory only per Wave 1 contract.
//
// Env kill switch: PERSONA_OMEGA_REVIEW=false disables the whole pass.
//
// Cross-fork-leak: this module reads recommendation text only (which is
// public omega-proposal content). It does NOT inline-quote sensitive paths
// in the persona prompts.

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

/**
 * Classify a recommendation's "shape" — does it mint a new agent/plist?
 * Net-new library code? Touches enums/schemas/contracts?
 * Used by the personas' `when` predicates.
 *
 * @param {object} rec — omega recommendation record
 * @returns {object} shape signal — { mintsNewAgent, mintsNewPlist, netNewLibrary, touchesContracts }
 */
export function classifyProposalShape(rec) {
  const tag = String(rec?.tag || '').toLowerCase();
  const title = String(rec?.short_title || rec?.title || '').toLowerCase();
  const proposed = String(rec?.proposed_change || '').toLowerCase();
  const all = `${tag} ${title} ${proposed}`;

  return {
    mintsNewAgent: /\b(new agent|create agent|add agent|scripts\/agents\/[\w-]+\.mjs.*\b(new|create|add))\b/i.test(all),
    mintsNewPlist: /\b(new plist|create plist|launchd.*\b(add|new|register)|\.plist)\b/i.test(all),
    netNewLibrary: /\b(new lib|new module|new helper|lib\/[\w-]+\.mjs.*\b(new|create|add))\b/i.test(all),
    touchesContracts: /\b(schema|enum|contract|api shape|payload shape|json shape|states\.yml|portals\.yml|profile\.yml)\b/i.test(all),
  };
}

/**
 * Build the user prompt for a persona's review of an omega recommendation.
 */
function buildPersonaReviewPrompt(persona, rec) {
  return [
    `Phase: /omega-steward Phase 4 (catalog-aware persona review of an omega proposal)`,
    `Persona: ${persona.displayName} (${persona.name})`,
    `Authority: ${persona.blockingAuthority} (advisory in this phase per Wave 1 contract)`,
    ``,
    `Review this omega-steward recommendation for the bug classes you watch.`,
    `Per your systemPrompt's persona-specific concerns, decide whether this`,
    `proposal warrants a flag.`,
    ``,
    `## Recommendation`,
    `ID: ${rec.id}`,
    `Target agent: ${rec.target_agent || '(unknown)'}`,
    `Tag: ${rec.tag || '(none)'}`,
    `Title: ${rec.short_title || rec.title || '(no title)'}`,
    `Current state: ${rec.current_state || rec.evidence || '(not provided)'}`,
    `Proposed change: ${rec.proposed_change || rec.proposal || '(not provided)'}`,
    `Rationale: ${rec.rationale || '(not provided)'}`,
    `Risk: ${rec.risk || '(unspecified)'}`,
    ``,
    `Return STRICT JSON: an array of findings per your output format.`,
    `Empty array (no concerns) is valid + expected when the proposal aligns`,
    `with your principles.`,
  ].join('\n');
}

/**
 * Annotate omega recommendations with persona findings.
 *
 * Mutates recommendations in-place (adds `persona_findings` field). Returns
 * a summary {reviewedCount, findingsCount, costUsd, errors}.
 *
 * @param {object[]} recommendations — omega's recommendation array
 * @param {object} [opts]
 * @param {boolean} [opts.mock=false]   — use deterministic mock responses
 * @param {boolean} [opts.dryRun=false] — return what WOULD fire, don't call LLMs
 * @returns {Promise<{reviewedCount, findingsCount, costUsd, errors}>}
 */
export async function annotateOmegaRecommendationsWithPersonaReview(recommendations, opts = {}) {
  if (process.env.PERSONA_OMEGA_REVIEW === 'false') {
    return { reviewedCount: 0, findingsCount: 0, costUsd: 0, errors: [], skipped: 'PERSONA_OMEGA_REVIEW=false' };
  }
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    return { reviewedCount: 0, findingsCount: 0, costUsd: 0, errors: [] };
  }

  const { personasFor, PHASES } = await import(join(REPO_ROOT, 'lib', 'council-personas.mjs'));
  const summary = { reviewedCount: 0, findingsCount: 0, costUsd: 0, errors: [], wouldFire: [] };

  for (const rec of recommendations) {
    // Skip "no changes" recommendations — nothing to review
    if (rec.tag === 'NO-CHANGES-THIS-CYCLE') continue;

    const proposal = classifyProposalShape(rec);
    const files = []; // omega recommendations don't carry file lists; predicate uses proposal only
    const fileStatus = {};
    const ctx = { phase: PHASES.OMEGA_STEWARD_4, proposal, files, fileStatus };

    const firing = personasFor(PHASES.OMEGA_STEWARD_4, ctx);
    if (firing.length === 0) continue;

    if (opts.dryRun) {
      summary.wouldFire.push({ recId: rec.id, personas: firing.map(p => p.name), proposalShape: proposal });
      continue;
    }

    if (opts.mock) {
      rec.persona_findings = firing.map(p => ({ persona: p.name, findings: [], mocked: true }));
      summary.reviewedCount++;
      continue;
    }

    // Real persona invocations — SEQUENTIAL per single-active rule (NB: HTTP
    // calls are async, but invoking multiple personas back-to-back keeps
    // spend predictable + matches the bug-resolver pattern).
    const { callCouncil } = await import(join(REPO_ROOT, 'lib', 'council.mjs'));
    rec.persona_findings = [];
    for (const persona of firing) {
      try {
        const prompt = buildPersonaReviewPrompt(persona, rec);
        const r = await callCouncil({
          prompt,
          opts: {
            personaName: persona.name,
            personaPhase: 'omega-steward-4',
            personaLabel: `omega-rec-${rec.id}`,
            timeoutMs: 120_000,
            maxTokens: 2000,
          },
        });
        const hit = (r.results || []).find(x => !x.error);
        let findings = [];
        if (hit) {
          const cleaned = String(hit.content || '').replace(/```json\n?|\n?```/g, '').trim();
          try { findings = JSON.parse(cleaned); } catch { /* non-JSON → empty */ }
          if (!Array.isArray(findings)) findings = [];
        }
        rec.persona_findings.push({
          persona: persona.name,
          findings,
          costUsd: r.report?.totalCost || 0,
        });
        summary.findingsCount += findings.length;
        summary.costUsd += r.report?.totalCost || 0;
      } catch (e) {
        rec.persona_findings.push({ persona: persona.name, findings: [], error: String(e?.message || e) });
        summary.errors.push({ recId: rec.id, persona: persona.name, error: String(e?.message || e) });
      }
    }
    summary.reviewedCount++;
  }

  return summary;
}
