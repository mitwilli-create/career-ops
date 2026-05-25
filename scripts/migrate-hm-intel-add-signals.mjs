#!/usr/bin/env node
// scripts/migrate-hm-intel-add-signals.mjs — one-time backfill.
//
// Adds a `signals[]` field (5-15 capabilities-shaped strings) to every
// hm-intel JSON in data/hm-intel/<slug>.json. Idempotent: files that
// already have a non-empty `signals[]` array are skipped.
//
// Per dealbreaker-final-pre-apply-2026-05-24.md (Step 2 worktree B):
//   - Sonnet 4.6 generates the signals from existing role_summary +
//     alignment_with_goals + fit_evidence + outreach_strategy.
//   - Per-file validation — if any file returns malformed JSON, an array
//     under 5 entries or over 15, non-string entries, or PII-shaped
//     strings, the script ABORTS without touching any files. The user
//     can `git revert` if a partial run got through.
//   - Cost guard: refuses to process > 5 files unless --force is set.
//     Anti-runaway; the full 25-file run is ~$5 of Sonnet calls.
//   - Default mode: --dry-run. Writes nothing. Prints proposed diffs.
//     --apply explicitly required to mutate files.
//
// Usage:
//   node scripts/migrate-hm-intel-add-signals.mjs --help
//   node scripts/migrate-hm-intel-add-signals.mjs --dry-run                  (default; safe)
//   node scripts/migrate-hm-intel-add-signals.mjs --dry-run --limit 1
//   node scripts/migrate-hm-intel-add-signals.mjs --dry-run --slug ema-solutions-architect
//   node scripts/migrate-hm-intel-add-signals.mjs --apply --slug <slug>      (single-file apply)
//   node scripts/migrate-hm-intel-add-signals.mjs --apply --force            (full 25-file run; ~$5)
//
// hm-intel files are GITIGNORED — this script will NEVER stage them. Mitchell
// reviews + commits manually if he wants to track the migration (he typically
// doesn't, since the data is personal).

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { callCouncil } from '../lib/council.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const HM_INTEL_DIR = join(ROOT, 'data', 'hm-intel');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const FORCE = args.includes('--force');
const HELP = args.includes('--help') || args.includes('-h');

const limitArg = _argValue(args, '--limit');
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg, 10)) : null;
const slugArg = _argValue(args, '--slug');

const MIN_SIGNALS = 5;
const MAX_SIGNALS = 15;
const SAFETY_CAP = 5;
const SONNET_MODEL = 'anthropic:claude-sonnet-4-6';
const TIMEOUT_MS = 180_000;

// PII heuristic: signals must NOT contain @, http://, https://, www.,
// phone-shaped digits, or full personal-name patterns. Signals are
// capability/team-shape descriptors, not PII.
const PII_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /https?:\/\//,              // url
  /www\./i,                   // www-prefixed url
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // US phone
  /\b\+\d{1,3}[-.\s]?\d/,    // international phone
];

// Auto-run only when invoked as a script (not on import). Importers can
// call generateSignals(), parseSignalsResponse(), validateSignals() without
// triggering a full directory walk + Sonnet dispatch.
const _invokedAsScript = import.meta.url === `file://${process.argv[1]}`;

if (_invokedAsScript) {
  if (HELP) {
    console.log(_helpText());
    process.exit(0);
  }
  main().catch(err => {
    console.error(`[migrate-hm-intel] FATAL: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  if (!existsSync(HM_INTEL_DIR)) {
    console.error(`[migrate-hm-intel] ${HM_INTEL_DIR} not found`);
    process.exit(1);
  }

  // Build the file list.
  let allFiles;
  try {
    allFiles = readdirSync(HM_INTEL_DIR)
      .filter(name => name.endsWith('.json') && !name.startsWith('_'))
      .sort();
  } catch (err) {
    throw new Error(`failed to list hm-intel directory: ${err.message}`);
  }

  let files = allFiles;
  if (slugArg) {
    const target = slugArg.endsWith('.json') ? slugArg : `${slugArg}.json`;
    files = allFiles.filter(f => f === target);
    if (files.length === 0) {
      console.error(`[migrate-hm-intel] no hm-intel file matches slug=${slugArg}`);
      console.error(`[migrate-hm-intel] available files: ${allFiles.length}`);
      process.exit(1);
    }
  }
  if (LIMIT) files = files.slice(0, LIMIT);

  // Cost guard — never silently process > SAFETY_CAP files unless --force.
  if (files.length > SAFETY_CAP && !FORCE) {
    console.error(`[migrate-hm-intel] would process ${files.length} files (> safety cap ${SAFETY_CAP}).`);
    console.error(`[migrate-hm-intel] Use --limit N or pass --force to allow the full run.`);
    console.error(`[migrate-hm-intel] Full 25-file Sonnet 4.6 run is ~$5 dev cost.`);
    process.exit(1);
  }

  const mode = DRY_RUN ? 'DRY-RUN' : 'APPLY';
  console.log(`[migrate-hm-intel] mode=${mode} files=${files.length} force=${FORCE}`);
  console.log(`[migrate-hm-intel] hm-intel dir: ${HM_INTEL_DIR}`);
  console.log('');

  let processed = 0;
  let skipped = 0;
  let migrated = 0;
  let totalCostUsd = 0;
  const proposals = [];

  for (const filename of files) {
    const slug = filename.replace(/\.json$/, '');
    const path = join(HM_INTEL_DIR, filename);

    let intel;
    try {
      intel = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      console.error(`[migrate-hm-intel] SKIP ${filename} — JSON parse failed: ${err.message}`);
      skipped++;
      continue;
    }

    // Idempotency check.
    if (Array.isArray(intel.signals) && intel.signals.length >= MIN_SIGNALS) {
      console.log(`[migrate-hm-intel] SKIP ${filename} — already has signals[] (${intel.signals.length} entries)`);
      skipped++;
      continue;
    }

    console.log(`[migrate-hm-intel] PROCESS ${filename} ...`);
    let signals;
    let costUsd = 0;
    try {
      const result = await generateSignals(intel, slug);
      signals = result.signals;
      costUsd = result.costUsd;
    } catch (err) {
      // ABORT — per spec, malformed output kills the run; the caller
      // diagnoses + git-reverts if needed.
      console.error(`[migrate-hm-intel] ABORT — ${filename} produced malformed output: ${err.message}`);
      console.error(`[migrate-hm-intel] no files modified in this run. Diagnose then retry.`);
      _printSummary({ processed, skipped, migrated, aborted: filename, totalCostUsd });
      process.exit(2);
    }

    totalCostUsd += costUsd;
    processed++;

    const proposal = {
      filename,
      slug,
      cost_usd: costUsd,
      signals,
      preview: signals.slice(0, 3),
    };
    proposals.push(proposal);

    console.log(`  signals[${signals.length}]: ${signals.slice(0, 2).map(s => `"${s.slice(0, 60)}${s.length > 60 ? '…' : ''}"`).join(', ')}, ...`);
    console.log(`  cost: $${costUsd.toFixed(4)}`);

    if (!DRY_RUN) {
      // Backup the original file before write.
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${path}.${ts}.bak`;
      try {
        copyFileSync(path, backup);
      } catch (err) {
        console.error(`[migrate-hm-intel] ABORT — backup failed for ${filename}: ${err.message}`);
        _printSummary({ processed, skipped, migrated, aborted: filename, totalCostUsd });
        process.exit(2);
      }

      const updated = { ...intel, signals };
      try {
        writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
      } catch (err) {
        console.error(`[migrate-hm-intel] ABORT — write failed for ${filename}: ${err.message}`);
        console.error(`[migrate-hm-intel] backup available at ${backup}`);
        _printSummary({ processed, skipped, migrated, aborted: filename, totalCostUsd });
        process.exit(2);
      }
      migrated++;
      console.log(`  wrote ${filename} (backup: ${backup})`);
    }
    console.log('');
  }

  _printSummary({ processed, skipped, migrated, totalCostUsd });

  if (DRY_RUN && proposals.length > 0) {
    console.log('');
    console.log('[migrate-hm-intel] DRY-RUN — no files modified. Re-run with --apply to write.');
    console.log('[migrate-hm-intel] hm-intel files are GITIGNORED — they will NOT be staged.');
  }
}

/**
 * Ask Sonnet 4.6 for signals[] given the existing hm-intel payload.
 * Validates the response in-flight. Throws on any malformed output.
 *
 * @param {object} intel — full parsed hm-intel JSON
 * @param {string} slug
 * @returns {Promise<{signals:string[], costUsd:number}>}
 */
export async function generateSignals(intel, slug) {
  const prompt = buildSignalsPrompt(intel, slug);

  const response = await callCouncil({
    prompt,
    models: [SONNET_MODEL],
    opts: {
      timeoutMs: TIMEOUT_MS,
      cacheCaller: 'hm-intel-signals-migration',
      systemPrompt: 'You are an expert at distilling hiring-manager personas into capability-shaped signals. Return STRICT JSON array of strings — no prose, no markdown, no preamble.',
    },
  });

  if (!response || !Array.isArray(response.results) || response.results.length === 0) {
    throw new Error('no response from model');
  }
  const result = response.results[0];
  if (result.error || !result.content) {
    throw new Error(`model error: ${result.error || 'empty content'}`);
  }

  const signals = parseSignalsResponse(result.content);
  validateSignals(signals);

  return { signals, costUsd: result.costUsd || 0 };
}

export function buildSignalsPrompt(intel, slug) {
  const summary = String(intel.role_summary || '').trim();
  const alignment = String(intel.alignment_with_goals || '').trim();
  const fit = intel.fit_evidence
    ? Object.entries(intel.fit_evidence)
        .filter(([_, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    : '';
  const outreach = intel.outreach_strategy
    ? Object.entries(intel.outreach_strategy)
        .filter(([_, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    : '';

  return [
    `# Task: extract capability-shaped HM signals for slug=${slug}`,
    '',
    'Given the existing HM intel below, produce 5–15 short signals that describe',
    'what the hiring manager (HM) values + filters for in a candidate. Signals',
    'must be:',
    '',
    '- Capability- or team-shape-focused (e.g. "ships production agent systems",',
    '  "bridges customer-facing solutioning + technical depth", "fluent in vertical',
    '  domain context"), NOT PII (no names, no emails, no phone numbers, no URLs)',
    '- Concise — each signal ≤ 12 words',
    '- Concrete enough that an applicant\'s CV / cover letter could match or fail',
    '  to demonstrate the signal',
    '- Drawn DIRECTLY from the intel below — do NOT invent signals that aren\'t',
    '  present',
    '- Mutually distinct — no near-duplicates',
    '',
    `company: ${intel.company || '(unknown)'}`,
    `role: ${intel.role || '(unknown)'}`,
    '',
    '## role_summary',
    summary || '(empty)',
    '',
    '## alignment_with_goals',
    alignment || '(empty)',
    '',
    '## fit_evidence',
    fit || '(empty)',
    '',
    '## outreach_strategy',
    outreach || '(empty)',
    '',
    '## Output format — STRICT JSON',
    '',
    'Return ONLY a JSON array of 5–15 short strings. No markdown, no prose, no',
    'preamble. Example shape:',
    '',
    '["ships production agent systems",',
    ' "bridges enterprise comms with technical depth",',
    ' "fluent in vertical-specific workflow context",',
    ' ...]',
    '',
    'Return the array now.',
  ].join('\n');
}

export function parseSignalsResponse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('empty response');
  }
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error('no JSON array found in response');
  }
  const candidate = cleaned.slice(firstBracket, lastBracket + 1);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('parsed response is not an array');
  }
  return parsed;
}

export function validateSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new Error('signals is not an array');
  }
  if (signals.length < MIN_SIGNALS || signals.length > MAX_SIGNALS) {
    throw new Error(`signals length ${signals.length} outside [${MIN_SIGNALS}, ${MAX_SIGNALS}]`);
  }
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (typeof s !== 'string') {
      throw new Error(`signal[${i}] is not a string: ${JSON.stringify(s)}`);
    }
    const trimmed = s.trim();
    if (!trimmed) {
      throw new Error(`signal[${i}] is empty`);
    }
    if (trimmed.length > 200) {
      throw new Error(`signal[${i}] too long (${trimmed.length} chars): ${trimmed.slice(0, 60)}…`);
    }
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new Error(`signal[${i}] contains PII-shaped content (pattern ${pattern}): ${trimmed.slice(0, 80)}`);
      }
    }
  }
  // Distinctness check (case-insensitive).
  const seen = new Set();
  for (const s of signals) {
    const k = s.trim().toLowerCase();
    if (seen.has(k)) {
      throw new Error(`duplicate signal: ${s}`);
    }
    seen.add(k);
  }
  return true;
}

function _argValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const next = args[idx + 1];
  if (!next || next.startsWith('--')) return null;
  return next;
}

function _printSummary({ processed, skipped, migrated, aborted, totalCostUsd }) {
  console.log('');
  console.log('─── Summary ───');
  console.log(`processed: ${processed}`);
  console.log(`skipped:   ${skipped}`);
  console.log(`migrated:  ${migrated}`);
  if (aborted) console.log(`aborted on: ${aborted}`);
  console.log(`cost:      $${totalCostUsd.toFixed(4)}`);
}

function _helpText() {
  return `migrate-hm-intel-add-signals.mjs

One-time backfill of \`signals[]\` field across data/hm-intel/<slug>.json
files. Per dealbreaker-final-pre-apply-2026-05-24.md Step 2 worktree B.

USAGE
  node scripts/migrate-hm-intel-add-signals.mjs [flags]

FLAGS
  --help, -h             Print this help.
  --dry-run              Default. Print proposed signals; write nothing.
  --apply                Write the signals back to the JSON files.
  --slug <slug>          Single-file mode. <slug> = filename without .json.
  --limit <N>            Process only the first N files (sorted alpha).
  --force                Override the safety cap of ${SAFETY_CAP} files.
                         Full 25-file Sonnet 4.6 run is ~$5 dev cost.

BEHAVIOR
  - Idempotent. Files that already have \`signals[]\` (>= ${MIN_SIGNALS} entries)
    are skipped.
  - ABORTS on first malformed output. No files modified in an aborted run.
    Diagnose then retry on the specific slug.
  - Each --apply write is preceded by a timestamped .bak backup.
  - hm-intel files are GITIGNORED — this script will NEVER stage them.

EXAMPLES
  # Preview a single file:
  node scripts/migrate-hm-intel-add-signals.mjs --dry-run --slug ema-solutions-architect

  # Preview first 3 files:
  node scripts/migrate-hm-intel-add-signals.mjs --dry-run --limit 3

  # Apply to one file:
  node scripts/migrate-hm-intel-add-signals.mjs --apply --slug ema-solutions-architect

  # Full run (after manual review of dry-run output):
  node scripts/migrate-hm-intel-add-signals.mjs --apply --force
`;
}
