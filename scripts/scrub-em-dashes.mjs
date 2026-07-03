#!/usr/bin/env node
/**
 * scripts/scrub-em-dashes.mjs — grammar-safe em-dash removal for apply-pack artifacts.
 *
 * Em dashes (U+2014) are banned in Mitchell's submission-facing / spoken-verbatim
 * materials — they read as an AI tell (feedback_no_em_dashes_in_materials,
 * 2026-06-11). En dashes in date ranges (June 2024 – present) are standard
 * résumé typography and MUST be preserved.
 *
 * Blind replacement is NOT grammar-safe (comma splices, broken appositives), so
 * each em-dash line is rewritten by an LLM (Sonnet) that picks the right
 * punctuation — comma, colon, period, semicolon, or parentheses — and every
 * rewrite is then verified by a DETERMINISTIC proof harness:
 *
 *   1. zero U+2014 in the rewritten line;
 *   2. en-dash (U+2013) count unchanged;
 *   3. normalize(old) === normalize(new), where normalize strips ONLY the
 *      characters allowed to change ([—,:;.()] + whitespace) and lowercases
 *      (capitalization may legitimately change when a dash becomes a period).
 *
 * The harness guarantees the model changed punctuation and case ONLY — no word
 * edits, no dropped markdown, no smuggled rewrites. Lines that fail verification
 * after one retry are LEFT UNTOUCHED and listed for manual review (exit 2).
 *
 * Scope: the user-facing artifact set gated by
 * tests/apply-pack-no-scaffold-invariant.test.mjs (GROUNDING_ARTIFACTS +
 * linkedin/peer-referral.md), excluding immutable record packs
 * (049-perplexity-*, 2723-anthropic-*), /google/i packs (restored-from-backup
 * precedent, 2026-06-11), and dot-dirs (.archive, .sweep-backups-*).
 *
 * Usage:
 *   node scripts/scrub-em-dashes.mjs --census               # $0 report only
 *   node scripts/scrub-em-dashes.mjs --apply                # full sweep (LLM)
 *   node scripts/scrub-em-dashes.mjs --apply --pack <slug>  # one pack
 *   node scripts/scrub-em-dashes.mjs --apply --extra <file> # arbitrary file(s)
 *   node scripts/scrub-em-dashes.mjs --apply --limit-files N
 *
 * Backups: apply-pack/.embackup-<YYYY-MM-DD>/<pack>__<artifact>.bak before any
 * write (flat naming, mirrors .sweep-backups-2026-06-11 convention).
 *
 * Zero personal data in this script — file contents flow API-ward only at run
 * time (same trust boundary as scripts/build-apply-packs.mjs generation calls).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = { census: false, apply: false, pack: null, extras: [], limitFiles: 0, concurrency: 4, model: 'claude-sonnet-4-6' };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--census') args.census = true;
  else if (argv[i] === '--apply') args.apply = true;
  else if (argv[i] === '--pack' && argv[i + 1]) args.pack = argv[++i];
  else if (argv[i] === '--extra' && argv[i + 1]) args.extras.push(argv[++i]);
  else if (argv[i] === '--limit-files' && argv[i + 1]) args.limitFiles = parseInt(argv[++i], 10) || 0;
  else if (argv[i] === '--concurrency' && argv[i + 1]) args.concurrency = Math.max(1, Math.min(8, parseInt(argv[++i], 10) || 4));
  else if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
}
if (!args.census && !args.apply) {
  console.error('Pass --census (free report) or --apply (LLM rewrite). See header for flags.');
  process.exit(1);
}

// ── API key (same layered loader as build-apply-packs.mjs) ──────────────────
function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return process.env.ANTHROPIC_API_KEY.trim();
  for (const p of [join(ROOT, '.env'), join(process.env.HOME || '', '.secrets')]) {
    try {
      const m = readFileSync(p, 'utf-8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* next source */ }
  }
  return null;
}

// ── Scope ────────────────────────────────────────────────────────────────────
const EM = '—';
const EN = '–';
const ARTIFACTS = [
  'cv-tailored.md', 'tailored-cv.md', 'cover-letter.md', 'impact-doc.md',
  'references.md', 'referrals.md', 'one-pager.md', 'form-fields.md',
  'interview-prep-full.md', 'interview-prep-teaser.md',
  'linkedin/hiring-manager.md', 'linkedin/recruiter.md', 'linkedin/peer-referral.md',
];
const RECORD_PACK_RE = /^049-perplexity|^2723-anthropic/;

function listTargets() {
  const targets = [];
  const base = join(ROOT, 'apply-pack');
  let dirs = [];
  try {
    dirs = readdirSync(base).filter(d => {
      try { return statSync(join(base, d)).isDirectory(); } catch { return false; }
    });
  } catch { /* no apply-pack tree */ }
  for (const d of dirs) {
    if (d.startsWith('.') || RECORD_PACK_RE.test(d) || /google/i.test(d)) continue;
    if (args.pack && d !== args.pack) continue;
    for (const a of ARTIFACTS) {
      const p = join(base, d, a);
      if (existsSync(p)) targets.push({ abs: p, rel: `apply-pack/${d}/${a}`, backupName: `apply-pack__${d}__${a.replace(/\//g, '__')}.bak` });
    }
  }
  for (const e of args.extras) {
    const abs = resolve(ROOT, e);
    if (existsSync(abs)) targets.push({ abs, rel: e, backupName: `extra__${e.replace(/[\/]/g, '__')}.bak` });
    else console.error(`  ⚠ --extra not found, skipping: ${e}`);
  }
  return targets;
}

// The cross-fork-leak frontmatter marker "[PERSONAL — DO NOT PUBLISH]" is a
// structural internal annotation whose canonical spelling contains an em dash.
// It is exempt: strip the exact token before counting/collecting, so a line
// whose only em dash is the marker is left alone (mirrors the invariant test).
const PERSONAL_MARKER = '[PERSONAL — DO NOT PUBLISH]';
const stripMarker = (s) => s.split(PERSONAL_MARKER).join('');
const countEm = (s) => (stripMarker(s).match(/—/g) || []).length;
const countEn = (s) => (s.match(/–/g) || []).length;

// ── Census ───────────────────────────────────────────────────────────────────
const targets = listTargets();
let censusFiles = 0, censusEm = 0, censusLines = 0;
const work = []; // { abs, rel, backupName, lines[], emLineIdx[] }
for (const t of targets) {
  const txt = readFileSync(t.abs, 'utf8');
  const em = countEm(txt);
  if (em === 0) continue;
  const lines = txt.split('\n');
  const emLineIdx = [];
  for (let i = 0; i < lines.length; i++) if (stripMarker(lines[i]).includes(EM)) emLineIdx.push(i);
  censusFiles++; censusEm += em; censusLines += emLineIdx.length;
  work.push({ ...t, lines, emLineIdx, hadTrailingNewline: txt.endsWith('\n') });
}
console.log(`scrub-em-dashes: ${targets.length} file(s) in scope; ${censusFiles} carry ${censusEm} em dash(es) across ${censusLines} line(s).`);
if (args.census || censusFiles === 0) process.exit(0);

// ── LLM rewrite engine ───────────────────────────────────────────────────────
const API_KEY = loadApiKey();
if (!API_KEY) { console.error('No ANTHROPIC_API_KEY available — cannot run --apply.'); process.exit(1); }

const SYSTEM = `You remove em dashes (—) from lines of job-application prose, replacing each with standard punctuation chosen for the sentence: a comma, colon, period (capitalize the next word), semicolon, or parentheses for paired em-dash asides. Pick what reads most naturally and grammatically; never create a comma splice (independent clause after the dash takes a period or colon, not a comma). You may also simply delete the dash where punctuation is unnecessary (e.g. list attributions).

ABSOLUTE RULES:
- Change ONLY em dashes, the punctuation replacing them, adjacent whitespace, and letter case where a new sentence begins. Every other character stays byte-identical: words, hyphens, en dashes (–, used in date ranges — keep them), markdown markers (#, *, _, |, >, [], backticks), quotes, numbers.
- Never reword, reorder, correct, or improve anything.
- Never replace an em dash with a hyphen (-) or an en dash (–).
- Output format: for EVERY input line, emit exactly one output line of the form <index><TAB><rewritten text>. Plain text, one line per input line, no JSON, no markdown fences, no commentary.`;

function batchesFor(file) {
  // Batch em-dash lines, capped by count and char volume so outputs stay well
  // under max_tokens.
  const batches = [];
  let cur = [], curChars = 0;
  for (const i of file.emLineIdx.filter(i => !file.done?.has(i))) {
    const len = file.lines[i].length;
    if (cur.length >= 20 || (curChars + len > 5000 && cur.length > 0)) { batches.push(cur); cur = []; curChars = 0; }
    cur.push(i); curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

let totalIn = 0, totalOut = 0, apiCalls = 0;
// TSV in / TSV out — the original JSON protocol broke deterministically on
// quote-heavy lines (the model mis-escaped its own JSON every attempt on
// cv-tailored bullets with straight+curly quotes). Tab-separated lines need
// no escaping; the deterministic proof harness remains the real safety net.
async function callModel(payloadLines, attemptNote = '') {
  const user = `${attemptNote}Rewrite these lines per the rules. One output line per input line: <index><TAB><rewritten text>.\n\n${payloadLines.map(l => `${l.i}\t${l.text}`).join('\n')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: args.model, max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      apiCalls++;
      totalIn += data.usage?.input_tokens || 0;
      totalOut += data.usage?.output_tokens || 0;
      let text = (data.content || []).map(c => c.text || '').join('').trim();
      text = text.replace(/^```\w*\s*\n?/i, '').replace(/\n?\s*```$/, '');
      const rewrites = [];
      for (const ln of text.split('\n')) {
        const m = ln.match(/^(\d+)\t(.*)$/);
        if (m) rewrites.push({ i: parseInt(m[1], 10), text: m[2] });
      }
      if (rewrites.length === 0) throw new Error('no parseable <index>\\t<text> lines in response');
      return rewrites;
    } catch (err) {
      if (attempt === 3) throw err;
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ev: 'retry', attempt, err: String(err.message).slice(0, 120) }) + '\n');
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// Proof harness: punctuation/whitespace/case-only delta, en dashes preserved.
const norm = (s) => s.toLowerCase().replace(/[—,:;.()\s]/g, '');
function verifyLine(oldLine, newLine) {
  if (typeof newLine !== 'string' || newLine.length === 0) return 'empty';
  if (stripMarker(newLine).includes(EM)) return 'em-dash-remains';
  if (countEn(newLine) !== countEn(oldLine)) return 'en-dash-count-changed';
  if (norm(newLine) !== norm(oldLine)) return 'content-drift';
  return null;
}

async function processFile(file) {
  file.done = new Set();
  file.failed = [];
  // up to 2 passes: initial + one retry pass for failed lines
  for (let pass = 1; pass <= 2; pass++) {
    const pending = file.emLineIdx.filter(i => !file.done.has(i) && !file.failed.some(f => f.i === i));
    if (!pending.length) break;
    const note = pass === 2 ? 'RETRY — your previous rewrite changed words or kept an em dash. Punctuation, whitespace, and case ONLY. ' : '';
    for (const batch of batchesFor(file)) {
      const payload = batch.map(i => ({ i, text: file.lines[i] }));
      let rewrites;
      try { rewrites = await callModel(payload, note); }
      catch (err) {
        for (const i of batch) if (pass === 2) file.failed.push({ i, why: `api: ${String(err.message).slice(0, 80)}` });
        continue;
      }
      const byIdx = new Map(rewrites.map(r => [r.i, r.text]));
      for (const i of batch) {
        const candidate = byIdx.get(i);
        const why = verifyLine(file.lines[i], candidate ?? '');
        if (!why) { file.lines[i] = candidate; file.done.add(i); }
        else if (pass === 2) file.failed.push({ i, why });
      }
    }
  }
  return file;
}

// ── Run with bounded concurrency ─────────────────────────────────────────────
const backupDir = join(ROOT, 'apply-pack', `.embackup-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(backupDir, { recursive: true });

let filesDone = 0, filesChanged = 0, emFixed = 0;
const manualReview = [];
const queue = args.limitFiles > 0 ? work.slice(0, args.limitFiles) : work;
const totalFiles = queue.length; // capture BEFORE workers shift() the queue down

async function worker() {
  while (queue.length) {
    const file = queue.shift();
    if (!file) break;
    await processFile(file);
    if (file.done.size > 0) {
      copyFileSync(file.abs, join(backupDir, file.backupName));
      writeFileSync(file.abs, file.lines.join('\n'));
      filesChanged++;
    }
    emFixed += file.done.size;
    for (const f of file.failed) manualReview.push({ rel: file.rel, line: f.i + 1, why: f.why, snippet: file.lines[f.i].trim().slice(0, 100) });
    filesDone++;
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ev: 'file', n: filesDone, of: totalFiles, rel: file.rel, fixedLines: file.done.size, failed: file.failed.length }) + '\n');
  }
}
await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

// ── Report ───────────────────────────────────────────────────────────────────
const costUsd = (totalIn / 1e6) * 3 + (totalOut / 1e6) * 15;
console.log(`\nDone. files changed: ${filesChanged}/${filesDone}; em-dash lines fixed: ${emFixed}; manual-review lines: ${manualReview.length}`);
console.log(`API: ${apiCalls} calls, ${totalIn} in / ${totalOut} out tokens, ~$${costUsd.toFixed(2)} (${args.model})`);
console.log(`Backups: ${backupDir}`);
if (manualReview.length) {
  console.log('\nMANUAL REVIEW NEEDED (left untouched):');
  for (const m of manualReview.slice(0, 60)) console.log(`  ${m.rel}:${m.line} [${m.why}] "${m.snippet}"`);
  process.exit(2);
}
