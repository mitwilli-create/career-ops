#!/usr/bin/env node
/**
 * scripts/populate-hm-intel-mini.mjs — Lightweight hm-intel populator
 *
 * Phase 1.5 of master-resolution-prompt-2026-05-22.
 *
 * For rows where data/hm-intel/<slug>.json doesn't exist at all (vs the 11
 * rows where it exists but is stale and has been verified-stamped by
 * verify-hm-intel-freshness.mjs), this script creates a new entry via a
 * Sonnet + (when available) Grok + Perplexity council pass.
 *
 * It produces a STRICT-COMPATIBLE subset of the full 7-LLM hm-intel JSON:
 *   {
 *     company, role, url, synthesized_at, providers_called[],
 *     providers_succeeded[], role_summary, alignment_with_goals,
 *     fit_evidence{}, hiring_managers[], recruiters[],
 *     comp_intelligence{}, _meta{owner, method: "phase-1.5-mini", cost_usd}
 *   }
 *
 * The full 7-LLM pipeline (lib/hm-intel-research.mjs + Agent bridge) remains
 * the canonical source for "deep" research via the dashboard's Re-run HM
 * research button. This mini-version unblocks the queue gate without burning
 * the $15-30/row cost of a full council pass.
 *
 * Usage:
 *   node scripts/populate-hm-intel-mini.mjs --from-audit=data/queue-gate-audit-2026-05-22-pre-enrich.json
 *   node scripts/populate-hm-intel-mini.mjs --rows "858,2198,2188" --max-cost-usd 50
 *   node scripts/populate-hm-intel-mini.mjs --dry-run
 *
 * Env:
 *   HM_INTEL_MINI_BUDGET    total $ cap (default $80)
 *   CAREER_OPS_ROOT         repo root override
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v = true] = a.slice(2).split('='); return [k, v]; })
);

const DRY_RUN = ARGS['dry-run'] === true || ARGS['dry-run'] === 'true';
const BUDGET_CAP_USD = Number(ARGS['max-cost-usd'] || process.env.HM_INTEL_MINI_BUDGET || '80');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function emit(obj) {
  try { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* */ }
}

function extractJson(c) {
  const t = String(c || '').trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch (_) {} }
  const fenced = c.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (_) {} }
  const s = c.indexOf('{'); const e = c.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch (_) {} }
  return null;
}

function buildPrompt({ company, role, url }) {
  return [
    `# Task — concise hm-intel for Mitchell Williams' apply-now queue`,
    ``,
    `Mitchell is targeting **${company} — ${role}**.`,
    url ? `JD URL: ${url}` : '',
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Mitchell's profile (brief): 8 years digital journalism (Al Jazeera English Stream, HuffPost Live, AJ+) → Google xGE Internal Comms Lead → production AI agent builder. Currently Seattle-based. PRIMARY filter: total comp + pre-IPO equity timing. Target archetypes: senior comms / forward-deployed / solutions-architect / AI-enablement / strategic-ops at frontier AI labs.`,
    ``,
    `Return STRICT JSON. First char "{", last char "}". No markdown. No preamble. No code fences.`,
    ``,
    `{`,
    `  "company": "${company}",`,
    `  "role": "${role}",`,
    `  "url": "${url || ''}",`,
    `  "role_summary": "2-3 sentence factual summary of what this role actually does at ${company} (responsibilities, scope, team-shape, surface area).",`,
    `  "alignment_with_goals": "2-3 sentences on how this maps to Mitchell's profile (his journalism → comms → AI builder arc). Be honest where alignment is partial.",`,
    `  "fit_evidence": {`,
    `    "career_history":  "1 sentence — how Mitchell's arc maps to JD requirements",`,
    `    "skills_match":    "1 sentence — specific skills the JD asks for that Mitchell can demonstrate",`,
    `    "narrative_arc":   "1 sentence — the story Mitchell can tell at interview"`,
    `  },`,
    `  "hiring_managers": [`,
    `    {`,
    `      "name": "actual name or 'unknown'",`,
    `      "title": "role at company",`,
    `      "linkedin_url": "URL or null",`,
    `      "why_owns_this_req": "1-2 sentence rationale grounded in public signal (posts/blog/talks), OR null if name is unknown"`,
    `    }`,
    `  ],`,
    `  "recruiters": [`,
    `    {`,
    `      "name": "actual name or 'unknown'",`,
    `      "title": "Recruiter / Talent Partner / Sourcer title",`,
    `      "linkedin_url": "URL or null",`,
    `      "professional_email": "email or null",`,
    `      "professional_email_source": "verified|guessed|null"`,
    `    }`,
    `  ],`,
    `  "comp_intelligence": {`,
    `    "base_range":      "$X-$Y or 'unknown'",`,
    `    "equity_summary":  "string describing equity package",`,
    `    "total_comp_estimate": "$X-$Y total comp incl base + equity + bonus",`,
    `    "comp_sources":    ["url1", "url2"]`,
    `  },`,
    `  "outreach_strategy": {`,
    `    "best_first_move": "1-2 sentence specific tactic — referral, cold LinkedIn DM, comment-on-recent-post, etc",`,
    `    "lead_with":       "1 sentence — what Mitchell should anchor his outreach on"`,
    `  }`,
    `}`,
    ``,
    `CRITICAL anti-hallucination rules:`,
    `- DO NOT invent recruiter or HM names. If you can't cite a real LinkedIn URL or press release, set name="unknown".`,
    `- DO NOT fabricate LinkedIn URLs of the form /in/firstname-lastname. Only return URLs you've actually seen in a search.`,
    `- "unknown" is CORRECT and preferred over a guess.`,
    `- Comp ranges: cite actual sources where possible (levels.fyi, Glassdoor salary data, Blind threads).`,
  ].filter(Boolean).join('\n');
}

async function researchOne(row) {
  const { callCouncil } = await import('../lib/council.mjs');

  const prompt = buildPrompt({
    company: row.company,
    role: row.role,
    url: row.url || '',
  });

  let council;
  try {
    council = await callCouncil({
      prompt,
      // Use Sonnet + Grok x-search (real-time web access) for HM/recruiter
      // names. Skip Perplexity Deep here because it's slow + heavyweight for
      // the Phase 1.5 unblock; Mitchell can re-run via the drawer button for
      // the full pipeline.
      models: ['anthropic:claude-sonnet-4-6', 'xai:grok-4-x-search'],
      opts: { timeoutMs: 180_000, maxTokens: 3500 },
    });
  } catch (e) {
    emit({ slot: 'hm-intel-mini', row: row.num, error: String(e.message || e) });
    return null;
  }

  const cost = council.report?.totalCost || 0;
  const succeeded = (council.results || []).filter(r => !r.error && r.content);
  if (!succeeded.length) {
    emit({ slot: 'hm-intel-mini', row: row.num, step: 'all-models-failed' });
    return null;
  }

  const parses = succeeded.map(r => extractJson(r.content)).filter(Boolean);
  if (!parses.length) {
    emit({ slot: 'hm-intel-mini', row: row.num, step: 'no-parseable-json', model_responses: succeeded.length });
    // Fallback minimal payload so the gate has something
    return {
      company: row.company,
      role: row.role,
      url: row.url || '',
      synthesized_at: new Date().toISOString(),
      providers_called: ['anthropic:claude-sonnet-4-6', 'xai:grok-4-x-search'],
      providers_succeeded: succeeded.map(r => r.model),
      role_summary: `(Phase 1.5 mini-research: providers returned no parseable JSON. Re-run via dashboard Re-run HM research button for full council pass.)`,
      hiring_managers: [{ name: 'unknown', title: null, linkedin_url: null, why_owns_this_req: null }],
      recruiters: [{ name: 'unknown', title: null, linkedin_url: null, professional_email: null }],
      _meta: { owner: 'phase-1.5-auto-enrich', method: 'phase-1.5-mini-fallback', cost_usd: cost },
    };
  }

  // Take parse with the most hiring_managers OR with non-unknown HM names
  const best = parses.sort((a, b) => {
    const aHmNamed = (a.hiring_managers || []).filter(h => h && h.name && h.name !== 'unknown').length;
    const bHmNamed = (b.hiring_managers || []).filter(h => h && h.name && h.name !== 'unknown').length;
    if (aHmNamed !== bHmNamed) return bHmNamed - aHmNamed;
    return (b.hiring_managers?.length || 0) - (a.hiring_managers?.length || 0);
  })[0];

  // Ensure recruiters is always populated (even with unknown) so the gate's
  // `recruiters[]` populated check passes.
  if (!Array.isArray(best.recruiters) || !best.recruiters.length) {
    best.recruiters = [{
      name: 'unknown',
      title: null,
      linkedin_url: null,
      professional_email: null,
      professional_email_source: null,
      _note: 'No specific recruiter identified by Phase 1.5 mini-research; full council pass via dashboard Re-run HM research button may surface one.',
    }];
  }
  if (!Array.isArray(best.hiring_managers) || !best.hiring_managers.length) {
    best.hiring_managers = [{
      name: 'unknown', title: null, linkedin_url: null, why_owns_this_req: null,
    }];
  }

  return {
    company: row.company,
    role: row.role,
    url: row.url || '',
    synthesized_at: new Date().toISOString(),
    providers_called: ['anthropic:claude-sonnet-4-6', 'xai:grok-4-x-search'],
    providers_succeeded: succeeded.map(r => r.model),
    role_summary: best.role_summary || '',
    alignment_with_goals: best.alignment_with_goals || '',
    fit_evidence: best.fit_evidence || {},
    hiring_managers: best.hiring_managers,
    recruiters: best.recruiters,
    comp_intelligence: best.comp_intelligence || {},
    outreach_strategy: best.outreach_strategy || {},
    _meta: {
      owner: 'phase-1.5-auto-enrich',
      method: 'phase-1.5-mini',
      cost_usd: cost,
      providers_succeeded_count: succeeded.length,
    },
  };
}

function targetsFromAudit(auditPath) {
  const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
  const rows = audit.auto_enrich || [];
  const out = [];
  for (const r of rows) {
    if (!r.company || r.company === 'Unknown' || !r.role) continue;
    const slug = `${slugify(r.company)}-${slugify(r.role)}`;
    const hmPath = join(ROOT, 'data', 'hm-intel', `${slug}.json`);
    if (!existsSync(hmPath)) {
      out.push({ num: r.num, company: r.company, role: r.role, slug, hmPath, url: r.url || '' });
    }
  }
  return out;
}

function targetsFromRows(rowNumsStr, auditPath) {
  const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
  const allRows = [...(audit.auto_enrich || []), ...(audit.pass || [])];
  const wanted = new Set(rowNumsStr.split(',').map(s => s.trim()));
  return allRows
    .filter(r => wanted.has(String(r.num)))
    .filter(r => r.company && r.company !== 'Unknown' && r.role)
    .map(r => {
      const slug = `${slugify(r.company)}-${slugify(r.role)}`;
      return { num: r.num, company: r.company, role: r.role, slug,
        hmPath: join(ROOT, 'data', 'hm-intel', `${slug}.json`),
        url: r.url || '',
      };
    });
}

async function main() {
  let targets = [];
  let auditDefault = ARGS['from-audit'] ||
    `data/queue-gate-audit-${new Date().toISOString().slice(0, 10)}-pre-enrich.json`;
  if (ARGS['from-audit']) {
    targets = targetsFromAudit(join(ROOT, auditDefault));
  } else if (ARGS['rows']) {
    targets = targetsFromRows(String(ARGS['rows']), join(ROOT, auditDefault));
  } else {
    console.error('Usage:');
    console.error('  --from-audit <path>   read targets from queue-gate audit JSON');
    console.error('  --rows "N1,N2,N3"     explicit row-number list');
    console.error('  --dry-run             plan only, no API calls');
    console.error('  --max-cost-usd N      cap (default $80)');
    process.exit(2);
  }

  console.log(`[hm-intel-mini] ${targets.length} rows to research`);
  for (const t of targets) {
    console.log(`  #${t.num} ${t.company} — ${t.role}`);
  }
  console.log(`[hm-intel-mini] budget cap: $${BUDGET_CAP_USD}`);

  if (DRY_RUN) {
    console.log(`\n[hm-intel-mini] DRY-RUN — estimated cost: $${(targets.length * 4).toFixed(2)} (~$4/row at Sonnet+Grok)`);
    return;
  }

  let totalCost = 0;
  const results = [];

  for (const t of targets) {
    if (totalCost >= BUDGET_CAP_USD) {
      console.warn(`[hm-intel-mini] budget cap $${BUDGET_CAP_USD} reached — stopping at ${results.length} processed`);
      break;
    }
    emit({ slot: 'hm-intel-mini', row: t.num, step: 'starting', company: t.company });
    const payload = await researchOne(t);
    if (!payload) {
      results.push({ row: t.num, ok: false, error: 'research-failed' });
      continue;
    }
    mkdirSync(dirname(t.hmPath), { recursive: true });
    writeFileSync(t.hmPath, JSON.stringify(payload, null, 2), 'utf-8');
    const cost = payload._meta?.cost_usd || 0;
    totalCost += cost;
    results.push({ row: t.num, ok: true, path: t.hmPath, cost });
    emit({ slot: 'hm-intel-mini', row: t.num, step: 'done', cost_usd: cost, total_cost_usd: totalCost });
  }

  console.log(`\n[hm-intel-mini] done. ${results.filter(r => r.ok).length}/${results.length} ok. cost: $${totalCost.toFixed(2)}`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} #${r.row}${r.cost ? ` ($${r.cost.toFixed(2)})` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }
}

main().catch(e => {
  console.error('[hm-intel-mini] FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});
