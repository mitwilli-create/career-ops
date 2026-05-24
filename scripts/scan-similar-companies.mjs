#!/usr/bin/env node
/**
 * scripts/scan-similar-companies.mjs — Pipeline expansion via LLM-powered
 * similar-company discovery.
 *
 * What it does:
 *   1. Parses data/applications.md to extract all unique company names.
 *   2. Groups companies by archetype (frontier-AI-labs, AI-tooling,
 *      AI-native-scale-ups, enterprise-AI) via keyword heuristics.
 *   3. For each archetype group, issues a Perplexity sonar query asking
 *      which similar companies Mitchell should target for AI PgM / FDE /
 *      Solutions Architect roles.
 *   4. Deduplicates suggestions against the existing pipeline.
 *   5. Writes output to data/similar-companies-{YYYY-MM-DD}.md.
 *
 * Usage:
 *   node scripts/scan-similar-companies.mjs              # full run
 *   node scripts/scan-similar-companies.mjs --dry-run    # preview only, no API
 *   node scripts/scan-similar-companies.mjs --top 30     # limit to 30 most-recent companies
 *
 * Cost: ~5 sonar calls × ~$0.005 ≈ $0.025 per run.
 *
 * Outputs:
 *   data/similar-companies-{YYYY-MM-DD}.md   (gitignored — personal pipeline output)
 *   stderr: NDJSON progress {"t":"...","phase":"...","msg":"..."}
 *   exit 0 on success, 1 on fatal error
 *
 * Safety:
 *   - Reads data/applications.md at runtime, never commits it.
 *   - All API calls go through lib/council.mjs (callCouncil with
 *     perplexity:sonar), which handles auth + retry + hang-prevention.
 *   - Fallback to direct Perplexity fetch if callCouncil errors.
 *   - Max 5 API calls (one per archetype group + one cross-archetype sweep).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Paths ───────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..');

const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const DATA_DIR          = join(ROOT, 'data');

const TODAY = new Date().toISOString().slice(0, 10);
const OUTPUT_PATH = join(DATA_DIR, `similar-companies-${TODAY}.md`);

// ─── CLI args ────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const topArg   = args.find(a => a.startsWith('--top'));
const TOP_N    = topArg ? parseInt(topArg.split(/[= ]/)[1] ?? '20', 10) : 20;

// ─── Cost cap ────────────────────────────────────────────────────────────────
const MAX_API_CALLS = 5;

// ─── stderr NDJSON progress helper ───────────────────────────────────────────
function log(phase, msg) {
  process.stderr.write(
    JSON.stringify({ t: new Date().toISOString(), phase, msg }) + '\n'
  );
}

// ─── Load env (.env optional) ────────────────────────────────────────────────
try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

// ─── Parse applications.md ───────────────────────────────────────────────────
/**
 * Extract unique company names from data/applications.md.
 * Uses lib/parse-applications.mjs when available; falls back to inline parse.
 * Returns array of { company, date } sorted newest-first.
 */
async function loadPipelineCompanies() {
  if (!existsSync(APPLICATIONS_PATH)) {
    throw new Error(`data/applications.md not found at ${APPLICATIONS_PATH}`);
  }

  let rows;
  try {
    const { parseApplicationsFile } = await import('../lib/parse-applications.mjs');
    rows = parseApplicationsFile(APPLICATIONS_PATH);
  } catch {
    // Inline fallback parser matching lib/parse-applications.mjs semantics
    const text = readFileSync(APPLICATIONS_PATH, 'utf8');
    rows = [];
    const HEADER_RE    = /\|\s*#\s*\|/;
    const SEPARATOR_RE = /^[\|\s\-:]+$/;
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      if (SEPARATOR_RE.test(line)) continue;
      if (HEADER_RE.test(line))    continue;
      const cells = line.split('|').map(c => c.trim());
      const date    = cells[2] || '';
      const company = cells[3] || '';
      if (!company) continue;
      rows.push({ company, date });
    }
  }

  // Dedupe by company name (case-insensitive), keep most-recent date per company
  const seen = new Map();
  for (const { company, date } of rows) {
    const key = company.toLowerCase();
    if (!seen.has(key) || date > seen.get(key).date) {
      seen.set(key, { company, date });
    }
  }

  // Sort newest-first and return top N
  return [...seen.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, TOP_N);
}

// ─── Archetype classification ─────────────────────────────────────────────────
/**
 * Keyword-match heuristic to bucket companies into archetypes.
 * Returns one of: 'frontier-ai-labs' | 'ai-tooling' | 'ai-native-scale-ups' | 'enterprise-ai'
 *
 * Logic: name and company signals only — no external API call needed here.
 */
const ARCHETYPE_RULES = [
  {
    id: 'frontier-ai-labs',
    label: 'Frontier AI Labs',
    description: 'Foundation model developers and fundamental AI research labs',
    keywords: [
      'anthropic', 'openai', 'deepmind', 'google deepmind', 'meta ai',
      'xai', 'mistral', 'cohere', 'inflection', 'perplexity', 'stability',
      'character', 'mosaic', 'aleph', 'adept', 'imbue', 'reka',
      'moonshot', 'baidu', 'zhipu', '01.ai', 'together',
    ],
  },
  {
    id: 'ai-tooling',
    label: 'AI Tooling & Infrastructure',
    description: 'Developer tools, MLOps, inference infra, observability, and AI platform companies',
    keywords: [
      'baseten', 'replicate', 'modal', 'vast', 'lambda labs', 'coreweave',
      'together ai', 'fireworks', 'anyscale', 'ray', 'weights & biases',
      'wandb', 'mlflow', 'langchain', 'llamaindex', 'vllm', 'nvidia',
      'hugging face', 'datarobot', 'scale ai', 'snorkel', 'labelbox',
      'encord', 'roboflow', 'galileo', 'trulens', 'arize', 'fiddler',
      'whylabs', 'evidently', 'helicone', 'portkey', 'braintrust',
      'livekit', 'daily', 'deepgram', 'assemblyai', 'speechify',
    ],
  },
  {
    id: 'ai-native-scale-ups',
    label: 'AI-Native Scale-ups',
    description: 'Post-seed / Series A–C startups with AI-first product DNA',
    keywords: [
      'cursor', 'anysphere', 'codeium', 'tabnine', 'codiumai', 'github copilot',
      'notion', 'linear', 'retool', 'vercel', 'replit', 'runway',
      'midjourney', 'elevenlabs', 'eleven labs', 'otter', 'fireflies',
      'granola', 'mem', 'reflect', 'glean', 'guru', 'moveworks',
      'writer', 'jasper', 'copy.ai', 'synthesia', 'tavily',
      'hebbia', 'klarna', 'harvey', 'casetext', 'ironclad',
      'kana', 'cast ai', 'livekot', 'hightouch', 'census',
      'hex', 'deepnote', 'mode analytics',
    ],
  },
  {
    id: 'enterprise-ai',
    label: 'Enterprise AI Adoption',
    description: 'Established enterprises deploying AI at scale; internal AI enablement roles',
    keywords: [
      'google', 'microsoft', 'amazon', 'aws', 'meta', 'apple', 'salesforce',
      'servicenow', 'workday', 'sap', 'oracle', 'ibm', 'accenture',
      'mckinsey', 'deloitte', 'bcg', 'bain', 'stripe', 'square', 'block',
      'shopify', 'hubspot', 'zendesk', 'freshworks', 'intercom',
      'twilio', 'sendgrid', 'segment', 'amplitude', 'mixpanel',
      'exampleco', 'databricks', 'dbt labs', 'fivetran', 'airbyte',
      'fxi', 'nvidia', 'qualcomm', 'intel',
    ],
  },
];

function classifyCompany(company) {
  const lc = company.toLowerCase();
  for (const rule of ARCHETYPE_RULES) {
    for (const kw of rule.keywords) {
      if (lc.includes(kw)) return rule.id;
    }
  }
  // Default unknown companies to ai-native-scale-ups (most likely fit for AI roles)
  return 'ai-native-scale-ups';
}

function groupByArchetype(entries) {
  const groups = {};
  for (const archetype of ARCHETYPE_RULES) {
    groups[archetype.id] = [];
  }
  for (const entry of entries) {
    const id = classifyCompany(entry.company);
    groups[id].push(entry.company);
  }
  return groups;
}

// ─── Perplexity sonar call ────────────────────────────────────────────────────
/**
 * Call Perplexity sonar via lib/council.mjs (callCouncil).
 * Falls back to direct fetch if callCouncil isn't available.
 */
async function queryPerplexity(prompt, label) {
  log('api-call', `${label}: querying perplexity:sonar`);

  // Attempt via lib/council.mjs (preferred — handles auth + retry + timeouts)
  let councilAvailable = false;
  try {
    const { callCouncil } = await import('../lib/council.mjs');
    councilAvailable = true;
    const results = await callCouncil({
      prompt,
      models: ['perplexity:sonar'],
      opts: {
        timeoutMs: 30_000,
        maxTokens: 2000,
      },
    });
    const success = results.find(r => !r.error && r.content);
    if (success) {
      log('api-call', `${label}: council response received (${success.tokens || 0} tokens, ~$${(success.costUsd || 0).toFixed(5)})`);
      return success.content;
    }
    const firstErr = results.find(r => r.error);
    if (firstErr) throw new Error(firstErr.error);
    throw new Error('No successful council response');
  } catch (err) {
    if (councilAvailable) {
      log('api-warn', `${label}: council call failed (${err.message}) — trying direct fetch`);
    }
  }

  // Direct Perplexity API fallback (PERPLEXITY_API_KEY must be set)
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) {
    throw new Error('PERPLEXITY_API_KEY not set and lib/council.mjs call failed — cannot query Perplexity');
  }

  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: `Today is ${TODAY}. You are a career intelligence researcher helping a senior AI product and engineering professional expand their job search.`,
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
      search_mode: 'web',
      web_search_options: { search_context_size: 'high' },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '(unreadable)');
    throw new Error(`Perplexity HTTP ${r.status}: ${body.slice(0, 200)}`);
  }

  const json = await r.json();
  const content = json.choices?.[0]?.message?.content || '';
  const tokens  = json.usage?.total_tokens || 0;
  log('api-call', `${label}: direct fetch response received (${tokens} tokens)`);
  return content;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(archetypeLabel, companies, existingSet) {
  const companyList = companies.slice(0, 5).join(', ');
  const existingSample = [...existingSet].slice(0, 20).join(', ');
  return `I'm a senior AI product manager, Forward Deployed Engineer, and Solutions Architect candidate evaluating job opportunities in 2026. My pipeline already includes these ${archetypeLabel} companies: ${existingSample} (and ${existingSet.size} others).

Based on these ${archetypeLabel} reference companies already in my pipeline: ${companyList}

What OTHER similar companies should I target for AI PgM, FDE, or Solutions Architect roles in 2026? Focus on companies that are:
1. Actively hiring in these role categories (AI PgM, FDE, Solutions Architect, AI Enablement, Applied AI)
2. Well-funded (Series B+, growth-stage, or established), growing, and AI-native or AI-forward
3. NOT already in my pipeline: ${existingSample}
4. Particularly good fits for someone with a background in: internal AI tooling at large tech, 3 production LLM agents, content/comms crossover, and AI product strategy

Return a JSON array of 8–12 company objects. Each object: { "company": "Name", "why": "1-sentence reason why similar", "stage": "Series X / public / private", "hiring_signal": "brief evidence" }

ONLY return the JSON array. No prose before or after.`;
}

// ─── Parse LLM JSON output ────────────────────────────────────────────────────
function parseLlmJson(raw) {
  if (!raw) return [];
  // Strip markdown fences if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // Find the outermost JSON array
  const start = stripped.indexOf('[');
  const end   = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.company === 'string' && item.company.trim());
  } catch {
    return [];
  }
}

// ─── Dedup suggested companies against existing pipeline ─────────────────────
function deduplicateSuggestions(suggestions, existingSet) {
  return suggestions.filter(s => {
    const lc = s.company.toLowerCase().trim();
    // Check for substring match both ways to catch "OpenAI" vs "OpenAI (ChatGPT)" etc.
    for (const existing of existingSet) {
      const elc = existing.toLowerCase();
      if (lc.includes(elc) || elc.includes(lc)) return false;
      // Also dedupe on ≥ 80% word overlap
      const sugWords = new Set(lc.split(/\s+/).filter(w => w.length > 2));
      const exWords  = new Set(elc.split(/\s+/).filter(w => w.length > 2));
      if (sugWords.size > 0 && exWords.size > 0) {
        const overlap = [...sugWords].filter(w => exWords.has(w)).length;
        const jaccard  = overlap / Math.max(sugWords.size, exWords.size);
        if (jaccard >= 0.8) return false;
      }
    }
    return true;
  });
}

// ─── Markdown report renderer ─────────────────────────────────────────────────
function renderReport({ allSuggestions, archetypeResults, pipelineCompanies, topN, apiCallCount }) {
  const totalSuggested = allSuggestions.length;
  const newTargets = allSuggestions; // already deduped

  const lines = [];
  lines.push(`# Similar Companies — ${TODAY}`);
  lines.push('');
  lines.push('> **Personal output — do not publish.** Generated by `scripts/scan-similar-companies.mjs`.');
  lines.push(`> Pipeline snapshot: ${pipelineCompanies.length} companies (top ${topN} by recency) · API calls: ${apiCallCount} · Suggestions: ${totalSuggested}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Company | Archetype | Why Similar | Stage | Hiring Signal |');
  lines.push('|---------|-----------|-------------|-------|---------------|');
  for (const s of allSuggestions) {
    const why     = (s.why || '').replace(/\|/g, '·').slice(0, 80);
    const stage   = (s.stage || 'Unknown').replace(/\|/g, '·').slice(0, 20);
    const signal  = (s.hiring_signal || '').replace(/\|/g, '·').slice(0, 60);
    const at      = s._archetype || 'unknown';
    lines.push(`| ${s.company} | ${at} | ${why} | ${stage} | ${signal} |`);
  }
  lines.push('');

  // New targets section (all are new — already deduped)
  lines.push('## New Targets (not yet in pipeline)');
  lines.push('');
  if (newTargets.length === 0) {
    lines.push('_All suggested companies are already in the pipeline._');
  } else {
    for (const s of newTargets) {
      lines.push(`### ${s.company}`);
      lines.push(`- **Archetype:** ${s._archetype || 'unknown'}`);
      lines.push(`- **Why:** ${s.why || 'Similar company in the same space'}`);
      lines.push(`- **Stage:** ${s.stage || 'Unknown'}`);
      lines.push(`- **Hiring signal:** ${s.hiring_signal || 'No data'}`);
      lines.push('');
    }
  }

  // Per-archetype breakdown
  lines.push('## Per-Archetype Results');
  lines.push('');
  for (const { archetype, raw, parsed, error } of archetypeResults) {
    const arch = ARCHETYPE_RULES.find(a => a.id === archetype);
    lines.push(`### ${arch?.label || archetype}`);
    if (error) {
      lines.push(`> ⚠️ API call failed: ${error}`);
    } else if (parsed.length === 0) {
      lines.push('> No suggestions returned or JSON parse failed.');
      if (raw) {
        lines.push('');
        lines.push('<details><summary>Raw response</summary>');
        lines.push('');
        lines.push('```');
        lines.push(raw.slice(0, 1000));
        lines.push('```');
        lines.push('</details>');
      }
    } else {
      lines.push(`_${parsed.length} suggestions returned_`);
    }
    lines.push('');
  }

  // Reference: pipeline sample
  lines.push('## Pipeline Reference (top companies by recency)');
  lines.push('');
  lines.push(pipelineCompanies.map(e => e.company).join(' · '));
  lines.push('');

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('start', `scan-similar-companies starting — dry-run=${DRY_RUN} top=${TOP_N}`);

  // 1. Load pipeline companies
  log('parse', 'reading data/applications.md');
  let pipelineCompanies;
  try {
    pipelineCompanies = await loadPipelineCompanies();
  } catch (err) {
    log('fatal', `Failed to load pipeline: ${err.message}`);
    process.exit(1);
  }
  log('parse', `found ${pipelineCompanies.length} unique companies (top ${TOP_N} by recency)`);

  if (pipelineCompanies.length === 0) {
    log('warn', 'No companies found in pipeline — check data/applications.md format');
    process.exit(1);
  }

  // Build a Set of existing company names for dedup
  const existingSet = new Set(pipelineCompanies.map(e => e.company));

  // 2. Group by archetype
  log('classify', 'grouping companies by archetype');
  const groups = groupByArchetype(pipelineCompanies);

  for (const arch of ARCHETYPE_RULES) {
    const count = groups[arch.id]?.length || 0;
    log('classify', `${arch.id}: ${count} companies — ${(groups[arch.id] || []).slice(0, 5).join(', ')}${count > 5 ? '...' : ''}`);
  }

  // 3. Dry-run: print plan and exit
  if (DRY_RUN) {
    log('dry-run', 'DRY RUN — API calls skipped');
    for (const arch of ARCHETYPE_RULES) {
      const companies = groups[arch.id] || [];
      if (companies.length === 0) continue;
      const prompt = buildPrompt(arch.label, companies, existingSet);
      log('dry-run', `Would query [${arch.id}] with ${companies.length} seed companies`);
      process.stderr.write('\n--- PROMPT PREVIEW ---\n' + prompt.slice(0, 300) + '...\n\n');
    }
    log('dry-run', `Would write to ${OUTPUT_PATH}`);
    process.exit(0);
  }

  // 4. Query Perplexity for each archetype (up to MAX_API_CALLS)
  log('query', `starting API calls (max ${MAX_API_CALLS})`);
  let apiCallCount = 0;
  const archetypeResults = [];
  const allSuggestions   = [];

  for (const arch of ARCHETYPE_RULES) {
    if (apiCallCount >= MAX_API_CALLS) {
      log('query', `hit max API calls (${MAX_API_CALLS}) — skipping ${arch.id}`);
      archetypeResults.push({ archetype: arch.id, raw: '', parsed: [], error: 'skipped (API cap)' });
      continue;
    }

    const companies = groups[arch.id] || [];
    if (companies.length === 0) {
      log('query', `${arch.id}: no companies in group — skipping`);
      archetypeResults.push({ archetype: arch.id, raw: '', parsed: [], error: null });
      continue;
    }

    const prompt = buildPrompt(arch.label, companies, existingSet);

    let raw = '';
    let parsed = [];
    let error = null;

    try {
      raw = await queryPerplexity(prompt, arch.id);
      apiCallCount++;
      parsed = parseLlmJson(raw);
      log('parse', `${arch.id}: parsed ${parsed.length} company suggestions`);

      // Tag each with archetype
      for (const s of parsed) s._archetype = arch.label;

      // Deduplicate against existing pipeline
      const fresh = deduplicateSuggestions(parsed, existingSet);
      log('dedup', `${arch.id}: ${parsed.length} suggested → ${fresh.length} not in pipeline`);
      allSuggestions.push(...fresh);

      // Add ALL suggested companies to existingSet to avoid cross-archetype dups
      for (const s of parsed) existingSet.add(s.company);

    } catch (err) {
      error = err.message;
      log('error', `${arch.id}: API call failed — ${error}`);
    }

    archetypeResults.push({ archetype: arch.id, raw, parsed, error });
  }

  // 5. Write report
  log('write', `writing report to ${OUTPUT_PATH}`);
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const report = renderReport({
      allSuggestions,
      archetypeResults,
      pipelineCompanies,
      topN: TOP_N,
      apiCallCount,
    });
    writeFileSync(OUTPUT_PATH, report, 'utf8');
    log('done', `report written — ${allSuggestions.length} new targets → ${OUTPUT_PATH}`);
  } catch (err) {
    log('fatal', `Failed to write report: ${err.message}`);
    process.exit(1);
  }

  // 6. Summary to stdout (human-readable)
  const newCount = allSuggestions.length;
  console.log(`\nSimilar-companies scan complete.`);
  console.log(`  Pipeline companies analyzed: ${pipelineCompanies.length} (top ${TOP_N} by recency)`);
  console.log(`  API calls made: ${apiCallCount} / ${MAX_API_CALLS} max`);
  console.log(`  New targets found: ${newCount}`);
  console.log(`  Report: ${OUTPUT_PATH}`);
  if (newCount > 0) {
    console.log('\nTop new targets:');
    for (const s of allSuggestions.slice(0, 10)) {
      console.log(`  • ${s.company} [${s._archetype}] — ${(s.why || '').slice(0, 70)}`);
    }
    if (newCount > 10) console.log(`  … and ${newCount - 10} more in the report.`);
  }
}

main().catch(err => {
  log('fatal', err.message);
  process.exit(1);
});
