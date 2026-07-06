#!/usr/bin/env node
/**
 * scripts/agents/network-draft-intro.mjs (ζ needhuman-resolution 2026-05-19)
 *
 * Drafts a warm-intro LinkedIn DM from Mitchell to a connection, using
 * Mitchell's calibrated LinkedIn-DM voice. Called by /api/network/draft-intro.
 *
 * Voice anchor — four rules calibrated from Mitchell's sent Kevin Dubouis
 * message (2026-05-11, feedback_linkedin_outreach_voice.md):
 *
 *  1. Full role names — never abbreviate. Mirror the exact JD title.
 *  2. Career arc in time-component chunks, not aggregate totals.
 *     "8 years in news — AJ+, HuffPost Live, CNN — evolved into 8 years of
 *      enterprise content comms at Google"  NOT "18 years in news".
 *  3. Concrete qualifiers after every metric.
 *     "leading to 88% self-provisioning their own devices in 24 hours"
 *     NOT "88% self-provisioning in 24 hours".
 *  4. Standalone impact lines and closing requests get their own paragraph.
 *     White space is a rhythm tool. Punchlines / asks land isolated.
 *
 * Mitchell's voice (from writing-samples/voice-reference.md + CLAUDE.md memory):
 *  - Problem-statement openers, no em dashes, metric anchoring
 *  - "The cognitive move is identical" earned-closer pattern
 *  - Agency-first framing, colloquial not corporate
 *  - Root-word discipline (no repeats within ~50 words)
 *  - First mention of a role includes "role" or "position" suffix
 *
 * LinkedIn DM register rules (contacto.md):
 *  - Max 300 characters for a connection request note (warn if over)
 *  - Longer warm DM after connected: 3-sentence framework per contact type
 *  - NO corporate-speak, NO "I'm passionate about..."
 *  - NEVER share phone number
 *
 * CLI:
 *   node scripts/agents/network-draft-intro.mjs \
 *     --person <id>            required  person ID from network-database.json
 *     --target-company <slug>  required  which apply-now target they can intro to
 *     --format connection|dm   optional  defaults to "dm" (post-connection message)
 *     --dry-run                optional  skip LLM; return a template
 *
 * Stdout: JSON { ok, person_id, target_company, format, draft, note_count, cost_usd }
 * Non-zero exit on error.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

try {
  const { config } = await import('dotenv');
  config({ path: join(ROOT, '.env'), override: true });
} catch { /* dotenv optional */ }

import { personById as networkPersonById, loadDatabase } from '../../lib/network-database-search.mjs';
import { recordTokens } from '../../lib/quota-tracker.mjs';
import { buildLeanGroundingForAgent } from '../../lib/ground-prompt.mjs';
import { runVoiceRulesGate } from '../../lib/voice-rules-gate.mjs';

// PR-02 (2026-05-25): lean grounding helper — see scripts/agents/cv-tailor.mjs for canonical doc.
// network-draft-intro uses Anthropic Sonnet exclusively; full corpus grounding is safe.
function _groundedSystem(baseSystem, ctx) {
  try {
    const r = buildLeanGroundingForAgent({
      agentName: 'NETWORK_DRAFT_INTRO', vendor: 'anthropic:claude-sonnet-4-6', task: 'network-draft-intro',
      rowId: ctx?.rowId || '', role: ctx?.role || '', company: ctx?.company || '',
    });
    if (r.mode === 'disabled') return baseSystem;
    return r.prepend + baseSystem;
  } catch (e) {
    process.stderr.write(JSON.stringify({ t: new Date().toISOString(), warn: 'network-draft-intro-grounding-failed', err: e.message }) + '\n');
    return baseSystem;
  }
}

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] || true) : null;
}

const PERSON_ID      = flag('--person');
const TARGET_COMPANY = flag('--target-company');
const FORMAT         = flag('--format') || 'dm';
const DRY_RUN        = argv.includes('--dry-run');

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

if (!PERSON_ID)      fail('--person <id> is required');
if (!TARGET_COMPANY) fail('--target-company <slug> is required');
if (!['connection', 'dm'].includes(FORMAT)) fail('--format must be "connection" or "dm"');

// Load the person record
loadDatabase();
const person = networkPersonById(PERSON_ID);
if (!person) fail(`person not found: ${PERSON_ID}`);

// Find their warm path to the target company
const warmPath = (person.warm_to_target_companies || []).find(
  w => w.company_slug === TARGET_COMPANY
);
if (!warmPath) fail(`${person.full_name} has no warm path to ${TARGET_COMPANY}`);

// Load Mitchell's CV summary for context (not the full cv.md — that's gitignored)
function loadVoiceContext() {
  const voicePath = join(ROOT, 'writing-samples', 'voice-reference.md');
  if (!existsSync(voicePath)) return '';
  // Truncate to the canonical exemplar section — enough voice signal without
  // blowing the prompt with the full 2000-word doc.
  const full = readFileSync(voicePath, 'utf-8');
  const canonicalIdx = full.indexOf('## Canonical Exemplar');
  if (canonicalIdx < 0) return full.slice(0, 1200);
  return full.slice(canonicalIdx, canonicalIdx + 1200);
}

// Load profile from config/profile.yml for context
function loadProfileContext() {
  try {
    const raw = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
    // Extract just the name + narrative lines — no full YAML parse dependency
    const lines = raw.split('\n');
    const relevant = lines.filter(l =>
      /name:|narrative:|summary:|headline:|linkedin_summary:/i.test(l)
    ).slice(0, 10).join('\n');
    return relevant || '';
  } catch { return ''; }
}

const voiceExemplar = loadVoiceContext();
const profileCtx    = loadProfileContext();

// Build the LLM prompt
function buildPrompt(p, warmPath, format, voiceExemplar, profileCtx) {
  const emailLine = (() => {
    const best = (p.emails?.professional || []).find(e => e.confidence !== 'low');
    return best ? `${best.email} (${best.confidence} confidence)` : 'no verified email on file';
  })();

  const warmEvidence = warmPath.target_name
    ? `They are connected to ${warmPath.target_name} (${warmPath.target_title || 'role unknown'}) at ${TARGET_COMPANY}`
    : `They currently work at ${TARGET_COMPANY} or have a documented warm path via ${warmPath.evidence}`;

  const formatNote = format === 'connection'
    ? 'This is a LinkedIn CONNECTION REQUEST NOTE. Hard limit 300 characters. Be concise.'
    : 'This is a post-connection LinkedIn DM (longer, 2-4 short paragraphs, warm but direct).';

  return `You are drafting a LinkedIn message FROM Mitchell Williams TO ${p.full_name}.

MITCHELL'S VOICE — calibrated from his actual sent messages. Match this register exactly.

Voice rules (MANDATORY):
1. Spell out full role names — never abbreviate. "Media Partnerships and AI Deployment role" not "ADE."
2. Career arc in time-chunk chunks, not aggregate totals. NOT "18 years in news" — YES "8 years in news — AJ+, HuffPost Live, CNN — then 8 years enterprise content comms at Google."
3. After any metric, name the concrete object. NOT "88% self-provisioning in 24 hours" — YES "leading to 88% of engineers self-provisioning their own devices in 24 hours."
4. Standalone asks and closing lines get their own paragraph. White space is a rhythm tool.
5. First mention of a target role includes "role" or "position" after the title.
6. Problem-statement opener (name the gap, not the concept).
7. No em dashes (use commas, colons, or parentheses; en dashes only in date ranges). Agency-first framing. No corporate-speak. No "I'm passionate about."
8. Root-word discipline: no repeated root word within ~50 words.

Mitchell's canonical voice exemplar (match this register):
${voiceExemplar}

CONTEXT about Mitchell:
${profileCtx || '- 8 years in news media (AJ+, HuffPost Live, The Stream/Al Jazeera English)\n- 8 years at Google in enterprise communications, Cross-Google Engineering\n- Built a production communications triage agent serving Google\'s 1,000 most senior engineers (top 0.5% of 180,000)\n- Currently in job search targeting AI-native comms and editorial roles at frontier AI companies'}

ABOUT ${p.full_name}:
- Current company: ${p.current_company || 'unknown'}
- Current role: ${p.current_role || 'unknown'}
- LinkedIn: ${p.linkedin_url || 'not on file'}
- Email: ${emailLine}
- Warm path: ${warmEvidence}
- Inferred drives: ${(p.inferred?.drives || []).join('; ') || 'not yet enriched'}
- Notes: ${p.notes || 'none'}

TARGET: Mitchell is hoping ${p.full_name} can make a warm intro at ${TARGET_COMPANY}.
He is targeting AI-native communications leadership roles there.

${formatNote}

Draft the message now. Return ONLY the message text — no labels, no JSON, no preamble.
The message should be from Mitchell in first person, addressed directly to ${p.full_name}.
It must feel like a genuine human DM, not a template. It should earn the read.`;
}

// LLM call via callCouncil (cost-distribution Part 2, 2026-05-25).
// Refactored from direct Anthropic fetch — routes through callCouncil for
// prompt-cache breakpoints + per-vendor monthly-cap guards. voice_match_writing
// taskType keeps Opus 4.7 as the default (Mitchell's locked decision for
// voice-matching). Switch to structured_extraction or pass explicit
// `models: ['anthropic:claude-sonnet-4-6']` if cost matters more than fidelity
// for a given run.
async function callSonnet(prompt, groundingCtx = {}) {
  const { callCouncil } = await import('../../lib/council.mjs');
  const baseSystem = `You are a voice-matching assistant. You draft LinkedIn messages that sound exactly like Mitchell Williams — a specific human being with a calibrated written voice. You match his register: no em dashes, problem-statement openers, concrete metric anchoring, earned closers. You never write corporate PR language.`;
  const systemPrompt = _groundedSystem(baseSystem, groundingCtx);

  const res = await callCouncil({
    prompt,
    opts: {
      taskType: 'voice_match_writing',  // → anthropic:claude-opus-4-7
      systemPrompt,
      maxTokens: 600,
      timeoutMs: 120_000,
      agentSlug: 'network-draft-intro',
    },
  });
  const result = res.results?.[0];
  if (!result) throw new Error('callCouncil returned no results');
  if (result.error) {
    if (/timeout/i.test(String(result.error))) {
      throw new Error('LLM API timeout — slow upstream. Not retrying.');
    }
    throw new Error(`LLM error: ${result.error}`);
  }
  const content = result.content || '';
  const totalTok = result.tokens || 0;
  const inputTokens  = Math.round(totalTok * 0.85);
  const outputTokens = Math.round(totalTok * 0.15);
  // Use callCouncil's costUsd estimate — it knows the resolved model and rates.
  const costUsd = Number(result.costUsd) || ((inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15);
  try { recordTokens('anthropic', inputTokens + outputTokens); } catch {}
  return { content, inputTokens, outputTokens, costUsd };
}

// Dry-run fallback
function buildDryRunDraft(p, targetCompany, format) {
  if (format === 'connection') {
    return `Hi ${p.first} — I've admired your work. I'm exploring roles at ${targetCompany} and would love to stay connected. Mitchell`;
  }
  return [
    `${p.first} —`,
    ``,
    `[DRY-RUN TEMPLATE — no LLM call made]`,
    ``,
    `Problem-statement opener about why you're reaching out, specific to their work at ${p.current_company}.`,
    ``,
    `8 years in news — AJ+, HuffPost Live, The Stream — then 8 years enterprise content comms at Google, where I built the communications triage agent serving the top 0.5% of a 180,000-person org. Now targeting [specific role] at ${targetCompany}.`,
    ``,
    `Any visibility into who's thinking about [specific challenge] on the team would mean a lot. Even a point in the right direction is genuinely useful.`,
  ].join('\n');
}

// Main
const prompt   = buildPrompt(person, warmPath, FORMAT, voiceExemplar, profileCtx);
let draft      = '';
let costUsd    = 0;
let inputTokens  = 0;
let outputTokens = 0;

if (DRY_RUN) {
  draft = buildDryRunDraft(person, TARGET_COMPANY, FORMAT);
} else {
  try {
    const result = await callSonnet(prompt, { rowId: person.id || '', role: '', company: TARGET_COMPANY });
    draft        = result.content.trim();
    costUsd      = result.costUsd;
    inputTokens  = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (e) {
    fail(`LLM call failed: ${e.message}`);
  }
}

const noteCount = draft.length;
const overLimit = FORMAT === 'connection' && noteCount > 300;

// PR-02: voice-rules-gate Layer 2 post-process on the draft.
let voiceGate = null;
try {
  if (draft && draft.length >= 50) voiceGate = runVoiceRulesGate(draft);
} catch (vErr) {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), warn: 'network-draft-intro-voice-gate-failed', err: vErr.message }) + '\n');
}

console.log(JSON.stringify({
  ok: true,
  person_id:      person.id,
  full_name:      person.full_name,
  target_company: TARGET_COMPANY,
  format:         FORMAT,
  draft,
  note_count:     noteCount,
  over_limit:     overLimit,
  cost_usd:       Math.round(costUsd * 10000) / 10000,
  tokens: { input: inputTokens, output: outputTokens },
  warm_path:      warmPath,
  voice_gate:     voiceGate ? { verdict: voiceGate.rollup.verdict, score: voiceGate.rollup.score, signal_quality: voiceGate.rollup.signal_quality } : null,
  _dry_run:       DRY_RUN,
}, null, 2));
