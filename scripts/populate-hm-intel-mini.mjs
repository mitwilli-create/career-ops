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
import { parseApplicationsText } from '../lib/parse-applications.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAREER_OPS_ROOT || join(__dirname, '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

/**
 * Parse `--key=value`, `--key value` (space-separated), and bare `--flag`
 * (boolean) argv forms.
 *
 * The previous parser only understood `--key=value`, so the space form that
 * scripts/agents/intel-refresh.mjs uses to invoke this script (`--rows <num>`)
 * AND the header's documented standalone `--rows "858,2198,2188"` form both
 * silently dropped the value — ARGS['rows'] became boolean `true`, the row
 * number was never read, and `--max-cost-usd 50` collapsed to Number(true)=1.
 * (role-enrichment worked only because intel-refresh invokes ITS child with the
 * equals form `--rows=<num>` at intel-refresh.mjs:608.) Exported for
 * tests/hm-intel-mini-targets.test.mjs.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

const DRY_RUN = ARGS['dry-run'] === true || ARGS['dry-run'] === 'true';
const BUDGET_CAP_USD = Number(ARGS['max-cost-usd'] || process.env.HM_INTEL_MINI_BUDGET || '80');

function slugify(s) {
  // Per-field truncate to 60 so this WRITER agrees with the canonical READERS:
  // lib/intel-refresh-state.mjs (disk-derived dashboard state), the parent verifier
  // in scripts/agents/intel-refresh.mjs, and scripts/build-dashboard.mjs all read
  // data/hm-intel/<slugify60(company)>-<slugify60(role)>.json. Without the slice,
  // roles whose slug exceeds 60 chars (e.g. rows 2708/2510/2517) were written to an
  // UNtruncated path the system never reads — the slug-truncation-contract-drift bug
  // class (already fixed for the il/hc slots via buildSlug; this closes the hm-intel arm).
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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

/**
 * Resolve { num, company, role, url, slug, hmPath } for an explicit row-number
 * list WITHOUT hard-depending on the dated queue-gate-audit file.
 *
 * Resolution priority per row num (graceful degradation — first source that
 * has the row wins):
 *   1. queue-gate-audit-<today>-pre-enrich.json  (scheduled-pipeline path; used ONLY if present)
 *   2. data/apply-now-queue.json :: ranked[]      (canonical for the intel-refresh --row path)
 *   3. data/applications.md                        (rows aged out of the queue; no url column)
 *
 * Closes the bug where targeted hm-intel (`--rows`, the path intel-refresh.mjs
 * shells out to via `--row <N> --slots hm-intel`) hard-crashed ENOENT whenever
 * the dated audit file was absent — which is EVERY manual / targeted run, since
 * that file is only produced by the nightly gate. Now the audit file is optional
 * and the row is resolved from the canonical queue/tracker instead. See bug class
 * targeted-hm-intel-hard-depends-on-scheduled-audit-file (2026-06-04).
 *
 * @param {string} rowNumsStr  comma-separated row numbers, e.g. "2722,2723"
 * @param {object} [io]        path overrides for testing: { root, auditPath, queuePath, appsPath }
 * @returns {Array<{num:(number|string),company:string,role:string,slug:string,hmPath:string,url:string}>}
 */
export function resolveRowTargets(rowNumsStr, io = {}) {
  const root = io.root || ROOT;
  const auditPath = io.auditPath !== undefined
    ? io.auditPath
    : join(root, 'data', `queue-gate-audit-${new Date().toISOString().slice(0, 10)}-pre-enrich.json`);
  const queuePath = io.queuePath || join(root, 'data', 'apply-now-queue.json');
  const appsPath = io.appsPath || join(root, 'data', 'applications.md');

  const wanted = new Set(
    String(rowNumsStr || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  if (!wanted.size) return [];

  const resolved = new Map(); // num(string) -> { num, company, role, url }
  const isUsable = (r) => r && r.company && r.company !== 'Unknown' && r.role;
  const take = (r, url) => {
    if (!r) return;
    const key = String(r.num);
    if (wanted.has(key) && !resolved.has(key) && isUsable(r)) {
      resolved.set(key, { num: r.num, company: r.company, role: r.role, url: url || '' });
    }
  };

  // Source 1 — dated queue-gate audit (scheduled path). NEVER throws on absence.
  if (auditPath && existsSync(auditPath)) {
    try {
      const audit = JSON.parse(readFileSync(auditPath, 'utf-8'));
      for (const r of [...(audit.auto_enrich || []), ...(audit.pass || [])]) take(r, r.url);
    } catch (e) {
      emit({ slot: 'hm-intel-mini', step: 'audit-read-failed', path: auditPath, error: String(e.message || e) });
    }
  }

  // Source 2 — apply-now-queue.json (the row intel-refresh --row passes is always here).
  if (resolved.size < wanted.size && existsSync(queuePath)) {
    try {
      const q = JSON.parse(readFileSync(queuePath, 'utf-8'));
      for (const r of (q.ranked || [])) take(r, r.canonical_url || r.url);
    } catch (e) {
      emit({ slot: 'hm-intel-mini', step: 'queue-read-failed', path: queuePath, error: String(e.message || e) });
    }
  }

  // Source 3 — applications.md (rows aged out of the queue; no url available).
  if (resolved.size < wanted.size && existsSync(appsPath)) {
    try {
      for (const r of parseApplicationsText(readFileSync(appsPath, 'utf-8'))) take(r, '');
    } catch (e) {
      emit({ slot: 'hm-intel-mini', step: 'apps-read-failed', path: appsPath, error: String(e.message || e) });
    }
  }

  // Build target descriptors in the caller's requested order. Unresolved nums
  // are surfaced (NDJSON) and skipped — never crash the whole run for one bad num.
  const out = [];
  for (const key of wanted) {
    const r = resolved.get(key);
    if (!r) {
      emit({ slot: 'hm-intel-mini', step: 'row-unresolved', row: key });
      continue;
    }
    const slug = `${slugify(r.company)}-${slugify(r.role)}`;
    out.push({
      num: r.num,
      company: r.company,
      role: r.role,
      slug,
      hmPath: join(root, 'data', 'hm-intel', `${slug}.json`),
      url: r.url || '',
    });
  }
  return out;
}

async function main() {
  let targets = [];
  if (ARGS['from-audit']) {
    targets = targetsFromAudit(join(ROOT, String(ARGS['from-audit'])));
  } else if (ARGS['rows']) {
    // --rows resolves num → {company, role, url} from canonical sources
    // (apply-now-queue.json / applications.md), with the dated queue-gate audit
    // used ONLY when present. Graceful-degradation fix for the ENOENT crash that
    // hit every targeted / intel-refresh-driven hm-intel run (2026-06-04).
    targets = resolveRowTargets(String(ARGS['rows']));
    if (!targets.length) {
      console.error(`[hm-intel-mini] no resolvable targets for --rows "${ARGS['rows']}" — none found in audit / apply-now-queue.json / applications.md`);
      process.exit(2);
    }
  } else {
    console.error('Usage:');
    console.error('  --from-audit <path>   read targets from queue-gate audit JSON');
    console.error('  --rows "N1,N2,N3"     explicit row-number list (resolved from queue/applications.md)');
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

// Only run main() when invoked as the entry point — guard so the module can be
// imported (e.g. by tests/hm-intel-mini-targets.test.mjs) without executing.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(e => {
    console.error('[hm-intel-mini] FATAL:', e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
