#!/usr/bin/env node
/**
 * scripts/agents/task-audit.mjs
 *
 * Standalone task-audit agent. Walks recent Claude session transcripts,
 * extracts user asks, asks Sonnet 4.6 whether each was addressed by
 * session end, writes a findings report + ready-to-paste continuation
 * prompts for any unaddressed asks.
 *
 * Standalone — does NOT depend on regression-guard's mode dispatch, but
 * REUSES its leak-safe primitives (path-encoder, citation-policy, sonnet-
 * synthesis, log-spend) by direct import. Same cross-fork-leak contract:
 * hash_only citations + [PERSONAL — DO NOT PUBLISH] frontmatter.
 *
 * CLI:
 *   node scripts/agents/task-audit.mjs [--last N] [--session <uuid>]
 *                                      [--sessions u1,u2,...]
 *                                      [--since YYYY-MM-DD --until YYYY-MM-DD]
 *                                      [--budget USD] [--dry-run]
 *                                      [--skip-followups]
 *
 * Spec: .claude/skills/task-audit/SKILL.md (locked Q1=last 5, Q2=report+
 * draft prompts, Q3=$20/day).
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import {
  hashCite,
  assertNoInlineQuotesFromSensitivePaths,
} from './regression-guard/lib/citation-policy.mjs';
import {
  encodeProjectPath,
} from './regression-guard/lib/path-encoder.mjs';
import { readJson, readText } from '../../lib/safe-fetch.mjs';

// Derive repo root from the script's own location (scripts/agents/task-audit.mjs → 3 levels up).
// Env override preserved for non-standard layouts.
const __FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = process.env.TASK_AUDIT_REPO_ROOT || dirname(dirname(dirname(__FILE)));

// Load .env with override:true — defends against Pattern E env-shadow (shell may pre-set
// ANTHROPIC_API_KEY="" empty, which without override:true silently wins over the real key in .env).
dotenv.config({ path: join(REPO_ROOT, '.env'), override: true });

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const PROJECT_TRANSCRIPTS_DIR = join(
  PROJECTS_ROOT,
  encodeProjectPath(REPO_ROOT),
);

const TODAY = new Date().toISOString().slice(0, 10);
const AUDIT_DIR = join(REPO_ROOT, '.claude', 'audit', TODAY);
const REPORT_PATH = join(AUDIT_DIR, `task-audit-${TODAY}.md`);
const FOLLOWUPS_PATH = join(AUDIT_DIR, `task-audit-followups-${TODAY}.md`);
const SPEND_LEDGER_PATH = join(REPO_ROOT, 'data', 'task-audit-spend.jsonl');
// Per-session sidecar JSONL — survives interrupt at session N so resume picks up at N+1.
// Append-only during the run; renamed to *.completed.jsonl after final report writes.
const PARTIAL_PATH = join(AUDIT_DIR, `task-audit-partial-${TODAY}.jsonl`);
const PARTIAL_DONE_PATH = join(AUDIT_DIR, `task-audit-partial-${TODAY}.completed.jsonl`);

const DAILY_USD_CAP = Math.max(
  0,
  Math.min(50, Number(process.env.TASK_AUDIT_DAILY_USD) || 20),
);
const PER_CALL_WARN_USD = Number(process.env.TASK_AUDIT_PER_CALL_WARN_USD) || 5;

const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    last: undefined,
    session: undefined,
    sessions: undefined,
    since: undefined,
    until: undefined,
    budget: DAILY_USD_CAP,
    dryRun: false,
    skipFollowups: false,
    forceRestart: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--last') out.last = parseInt(next(), 10);
    else if (a === '--session') out.session = next();
    else if (a === '--sessions') out.sessions = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--since') out.since = next();
    else if (a === '--until') out.until = next();
    else if (a === '--budget') out.budget = Math.max(0, Math.min(50, parseFloat(next())));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-followups') out.skipFollowups = true;
    else if (a === '--force-restart') out.forceRestart = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      process.stderr.write(`unknown flag: ${a}\n`);
      printHelp();
      process.exit(2);
    }
  }
  // Default: --last 5
  if (
    out.last === undefined && !out.session && !out.sessions &&
    !out.since && !out.until
  ) {
    out.last = 5;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`task-audit — review prior sessions for unaddressed asks

usage:
  node scripts/agents/task-audit.mjs [--last N | --session <uuid> | --sessions u1,u2,...]
                                     [--since YYYY-MM-DD --until YYYY-MM-DD]
                                     [--budget USD] [--dry-run] [--skip-followups]
                                     [--force-restart]

flags:
  --force-restart   Ignore today's partial sidecar + audit every in-scope session
                    from scratch. Use after a smoke-test run if you want a clean
                    real-audit on the same day. Without this, a resumable run
                    on the same date picks up where a prior interrupted run
                    left off.

defaults: --last 5, budget=\$${DAILY_USD_CAP}
outputs:
  ${REPORT_PATH}
  ${FOLLOWUPS_PATH}
  ${SPEND_LEDGER_PATH}
  ${PARTIAL_PATH}        (during the run)
  ${PARTIAL_DONE_PATH}   (after successful completion)
`);
}

// ─── Logging + spend ────────────────────────────────────────────────────────

function log(line, level = 'info') {
  const stamp = new Date().toISOString();
  process.stderr.write(`[${stamp}] [${level}] task-audit: ${line}\n`);
}

function getTodaySpend() {
  if (!existsSync(SPEND_LEDGER_PATH)) return 0;
  try {
    const raw = readFileSync(SPEND_LEDGER_PATH, 'utf-8');
    let sum = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.model === 'mock') continue;
        if (r.date === TODAY && typeof r.usd === 'number') sum += r.usd;
      } catch { /* skip */ }
    }
    return sum;
  } catch { return 0; }
}

function appendSpendLedger(rec) {
  if (!existsSync(dirname(SPEND_LEDGER_PATH))) {
    mkdirSync(dirname(SPEND_LEDGER_PATH), { recursive: true });
  }
  appendFileSync(SPEND_LEDGER_PATH, JSON.stringify(rec) + '\n');
}

// ─── Partial-sidecar persistence (resume-on-restart) ────────────────────────
//
// Default-to-restart is a tax on memory-only state. Two consecutive runs on
// 2026-05-28 (60% and 91% complete) died before producing a report; ~$7.42
// was burned because nothing on disk recorded "we got this far." The sidecar
// fixes that — every audited session is appended as one JSONL line. On
// re-launch, the loop preloads the cache + skips already-audited sessions.
//
// Schema (minimum fields enforced at load):
//   { session_sha256: "sha256:...", mtime_ms: number, asks_count: number,
//     verdicts: array, session_result: full-shape SessionResult }
//
// The schema's `session_result` field carries the rendering-time shape
// (uuid, uuidHash, mtime, asks[], verdicts[], cost_usd, skipped_reason)
// so the final report can render without re-parsing transcripts.

function loadPartialSidecar() {
  if (!existsSync(PARTIAL_PATH)) return null;
  const auditedSHAs = new Set();
  const results = [];
  let raw;
  try { raw = readFileSync(PARTIAL_PATH, 'utf-8'); }
  catch (e) { log(`partial sidecar read fail: ${e.message}`, 'warn'); return null; }
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch (e) {
      log(`partial sidecar line ${lineNo} JSON parse skip: ${e.message}`, 'warn');
      continue;
    }
    // Minimum-schema validation
    if (typeof entry.session_sha256 !== 'string' ||
        typeof entry.mtime_ms !== 'number' ||
        typeof entry.asks_count !== 'number' ||
        !Array.isArray(entry.verdicts) ||
        !entry.session_result || typeof entry.session_result !== 'object') {
      log(`partial sidecar line ${lineNo} schema invalid — skip`, 'warn');
      continue;
    }
    auditedSHAs.add(entry.session_sha256);
    results.push(entry.session_result);
  }
  return { auditedSHAs, results };
}

function appendPartialSidecar(sessionResult) {
  try {
    if (!existsSync(dirname(PARTIAL_PATH))) {
      mkdirSync(dirname(PARTIAL_PATH), { recursive: true });
    }
    const entry = {
      session_sha256: sessionResult.uuidHash,
      mtime_ms: new Date(sessionResult.mtime).getTime(),
      asks_count: sessionResult.asks.length,
      verdicts: sessionResult.verdicts,
      session_result: sessionResult,
    };
    appendFileSync(PARTIAL_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Non-fatal — log + continue. The whole point is that an interrupted run
    // should remain partly-recoverable; a sidecar-write failure can't take
    // down the run.
    log(`partial sidecar append fail (non-fatal): ${e.message}`, 'warn');
  }
}

function finalizePartialSidecar() {
  try {
    if (existsSync(PARTIAL_PATH)) {
      renameSync(PARTIAL_PATH, PARTIAL_DONE_PATH);
      log(`finalized partial sidecar → ${PARTIAL_DONE_PATH}`);
    }
  } catch (e) {
    log(`partial sidecar finalize fail (non-fatal): ${e.message}`, 'warn');
  }
}

// ─── Session enumeration ────────────────────────────────────────────────────

function enumerateSessions(opts) {
  if (!existsSync(PROJECT_TRANSCRIPTS_DIR)) {
    return { sessions: [], descriptor: 'no-transcripts-dir' };
  }
  // Explicit UUID(s)
  if (opts.session) {
    return enumerateExplicit([opts.session]);
  }
  if (opts.sessions && opts.sessions.length > 0) {
    return enumerateExplicit(opts.sessions);
  }
  // mtime-based
  const now = Date.now();
  let sinceMs, untilMs;
  if (Number.isFinite(opts.last)) {
    sinceMs = now - opts.last * 86400 * 1000;
    untilMs = now;
  } else {
    sinceMs = opts.since
      ? new Date(opts.since + 'T00:00:00').getTime()
      : now - 5 * 86400 * 1000;
    untilMs = opts.until
      ? new Date(opts.until + 'T23:59:59').getTime()
      : now;
  }
  if (sinceMs > untilMs) {
    throw new Error(`--since after --until`);
  }
  const found = [];
  for (const e of readdirSync(PROJECT_TRANSCRIPTS_DIR)) {
    if (!e.endsWith('.jsonl')) continue;
    const fp = join(PROJECT_TRANSCRIPTS_DIR, e);
    try {
      const st = statSync(fp);
      if (!st.isFile()) continue;
      const mt = st.mtimeMs;
      if (mt >= sinceMs && mt <= untilMs) {
        found.push({ uuid: e.replace(/\.jsonl$/, ''), path: fp, mtimeMs: mt, bytes: st.size });
      }
    } catch { /* skip */ }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const descriptor = Number.isFinite(opts.last)
    ? `last-${opts.last}-days`
    : `${opts.since || '<auto>'}..${opts.until || '<now>'}`;
  return { sessions: found, descriptor };
}

// Canonical Claude session UUID format: v4 lowercase. Reject anything else
// to keep `--session` / `--sessions` CLI input from reaching the fs layer
// with path-traversal payloads (e.g. "../../etc/passwd").
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionUuid(s) {
  return typeof s === 'string' && SESSION_UUID_RE.test(s);
}

function enumerateExplicit(uuids) {
  const out = [];
  for (const u of uuids) {
    if (!isValidSessionUuid(u)) {
      log(`WARN: rejected non-UUID session id: ${String(u).slice(0, 40)}`, 'warn');
      continue;
    }
    const fp = join(PROJECT_TRANSCRIPTS_DIR, `${u}.jsonl`);
    // Defense-in-depth: confirm the resolved path is still inside the
    // transcripts dir even after `join` normalization. Catches edge cases
    // the regex didn't anticipate.
    if (!fp.startsWith(PROJECT_TRANSCRIPTS_DIR + '/')) {
      log(`WARN: rejected path-traversal attempt: ${u}`, 'warn');
      continue;
    }
    if (!existsSync(fp)) {
      log(`WARN: session not on disk: ${u}`, 'warn');
      continue;
    }
    const st = statSync(fp);
    out.push({ uuid: u, path: fp, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  return { sessions: out, descriptor: `explicit-${uuids.length}` };
}

// ─── Transcript parsing ─────────────────────────────────────────────────────

/**
 * Returns: { asks: [{ uuid, content, timestamp, idx }],
 *            assistantSegments: [{ afterUserUuid, summary, hadTools, toolNames[] }],
 *            firstTs, lastTs }
 *
 * An "ask" is a top-level user turn (NOT a tool-result message). We treat
 * user messages with non-string content (arrays containing tool_result
 * blocks) as tool-results, not asks. Real user asks come in as either
 * a plain string in `message.content` OR an array with a `text` block
 * whose `type==='text'`.
 */
function parseTranscript(filepath) {
  let raw;
  try { raw = readFileSync(filepath, 'utf-8'); }
  catch (e) { log(`read err ${filepath}: ${e.message}`, 'warn'); return null; }
  const lines = raw.split('\n');
  const asks = [];
  const assistantSegments = [];
  let firstTs = null;
  let lastTs = null;
  let currentAssistantBuf = { afterUserUuid: null, textParts: [], toolNames: [] };

  function flushAssistant() {
    if (currentAssistantBuf.afterUserUuid && (currentAssistantBuf.textParts.length || currentAssistantBuf.toolNames.length)) {
      const summary = currentAssistantBuf.textParts.join('\n').trim();
      assistantSegments.push({
        afterUserUuid: currentAssistantBuf.afterUserUuid,
        summary,
        hadTools: currentAssistantBuf.toolNames.length > 0,
        toolNames: currentAssistantBuf.toolNames.slice(),
      });
    }
    currentAssistantBuf = { afterUserUuid: currentAssistantBuf.afterUserUuid, textParts: [], toolNames: [] };
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = rec.timestamp || null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (rec.type === 'user' && rec.message?.role === 'user') {
      const content = rec.message.content;
      // Skip tool-result turns
      const isToolResult = Array.isArray(content) && content.some(
        b => b && typeof b === 'object' && b.type === 'tool_result',
      );
      if (isToolResult) continue;
      let askText = '';
      if (typeof content === 'string') askText = content;
      else if (Array.isArray(content)) {
        askText = content
          .filter(b => b && typeof b === 'object' && b.type === 'text')
          .map(b => b.text || '')
          .join('\n');
      }
      askText = (askText || '').trim();
      if (!askText) continue;
      // Skip system-reminder-only turns
      if (/^<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(askText)) continue;
      flushAssistant();
      asks.push({
        uuid: rec.uuid,
        content: askText,
        timestamp: ts,
        idx: asks.length,
      });
      currentAssistantBuf.afterUserUuid = rec.uuid;
    } else if (rec.type === 'assistant' && rec.message?.role === 'assistant') {
      const content = rec.message.content;
      if (typeof content === 'string') {
        currentAssistantBuf.textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && b.text) currentAssistantBuf.textParts.push(b.text);
          else if (b.type === 'tool_use' && b.name) currentAssistantBuf.toolNames.push(b.name);
        }
      }
    }
  }
  flushAssistant();
  return { asks, assistantSegments, firstTs, lastTs };
}

// ─── Assistant-segment summarization ────────────────────────────────────────

/**
 * Build a compact "what Claude did for this ask" summary suitable for
 * inclusion in the Sonnet adjudication prompt. Truncates verbose tool
 * activity to a name+count list + the first ~600 chars of assistant text.
 */
function summarizeAssistantForAsk(seg) {
  if (!seg) return '<no assistant response captured>';
  const text = (seg.summary || '').trim();
  const truncated = text.length > 600 ? text.slice(0, 600) + '…[truncated]' : text;
  const toolMap = {};
  for (const t of seg.toolNames) toolMap[t] = (toolMap[t] || 0) + 1;
  const toolLine = Object.keys(toolMap).length
    ? `Tools: ${Object.entries(toolMap).map(([k, v]) => `${k}×${v}`).join(', ')}`
    : 'Tools: none';
  return `${toolLine}\nResponse: ${truncated || '<no text response>'}`;
}

// ─── Sonnet adjudication ────────────────────────────────────────────────────

const ADJUDICATE_SYSTEM = `You are an audit assistant that reviews Claude Code sessions for execution completeness.

For each user ask in a session, you receive:
- the ask text (verbatim)
- a summary of what Claude did in response (tool calls + assistant text)

Return STRICT JSON with one object per ask in the order received. Each object:
{
  "ask_index": <number — position in input>,
  "ask_paraphrase": "<≤80 chars, no PII verbatim, generic enough to cite>",
  "addressed": <"yes" | "partial" | "no" | "deferred">,
  "confidence": <"H" | "M" | "L">,
  "evidence": "<≤200 chars: what makes you confident; reference tool counts, file paths, or response shape — NOT verbatim user text>",
  "gap_description": "<≤200 chars: ONLY if addressed != 'yes'; what specifically was missed or deferred>",
  "suggested_followup_framing": "<≤300 chars: ONLY if addressed != 'yes'; how a follow-up session should reopen this. Generic framing, no PII.>"
}

Rules:
- "yes" — Claude fully addressed the ask. Every sub-item shipped or the response answers the question.
- "partial" — Claude addressed some but not all of a multi-part ask, OR shipped a degraded/incomplete version.
- "no" — Claude did not address the ask. Could be: pivot to a different topic, refused, errored out, never resumed after a tool failure.
- "deferred" — Claude explicitly said "I'll do X later" / "follow-up PR" / "TBD" and there's no later evidence X shipped in the same session.
- "exploratory" questions answered with discussion are "yes" — don't penalize for not coding.
- A user follow-up that says "great, do X next" SUPERSEDES any unaddressed earlier ask; mark earlier as "yes" if the user moved on contentedly.
- If the user issued a system-reminder-style instruction (no real ask), mark "addressed":"yes" and confidence:"H".

Output: a JSON array. No prose around it. No markdown fence.`;

async function callSonnetAdjudicate(prompt, opts = {}) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) {
    return { content: null, error: 'ANTHROPIC_API_KEY not set', usd: 0 };
  }
  if (opts.dryRun) return { content: null, dryRun: true, usd: 0 };
  const timeoutMs = opts.timeoutMs || 180_000;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 4096,
        system: ADJUDICATE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timer);
    if (!r.ok) {
      // Body-read timeout: 30s for error bodies (small)
      const errBody = await readText(r, 30_000, 'sonnet-error-body').catch(() => '');
      return { content: null, error: `HTTP ${r.status}: ${errBody.slice(0, 240)}`, usd: 0 };
    }
    // Body-read timeout: 120s for success bodies (canonical missing-timeout-on-long-running-operation
    // bug class — Node's r.json() is NOT signal-aware after the fetch resolves, so a stalled response
    // stream can hang the process indefinitely. The 5.6 MB session #2f260f40327b hit this on 2026-05-28).
    const j = await readJson(r, 120_000, 'sonnet-success-body');
    const content = (j?.content || []).map(b => b.text || '').join('\n');
    const tokens_in = j?.usage?.input_tokens || 0;
    const tokens_out = j?.usage?.output_tokens || 0;
    const usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000;
    return { content, usd, tokens_in, tokens_out };
  } catch (err) {
    return { content: null, error: err.message, usd: 0 };
  }
}

function buildAdjudicatePrompt(sessionMeta, asks, assistantByUuid) {
  const header = `Session date: ${sessionMeta.mtime}\nAsks in this session: ${asks.length}\n\n`;
  const parts = [];
  for (const a of asks) {
    const seg = assistantByUuid.get(a.uuid);
    parts.push(`---\nASK #${a.idx}\nTimestamp: ${a.timestamp || 'unknown'}\nUser ask:\n${a.content}\n\nWhat Claude did:\n${summarizeAssistantForAsk(seg)}\n`);
  }
  parts.push('---\n\nReturn the JSON array now.');
  return header + parts.join('\n');
}

function parseAdjudicateResponse(text, expectedCount) {
  if (!text) return null;
  // Strip code fences if present
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Find first '[' and last ']'
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    if (arr.length !== expectedCount) {
      log(`WARN: adjudicate returned ${arr.length} verdicts, expected ${expectedCount}`, 'warn');
    }
    return arr;
  } catch (e) {
    log(`adjudicate JSON parse fail: ${e.message}`, 'warn');
    return null;
  }
}

// ─── Per-session audit ──────────────────────────────────────────────────────

async function auditOneSession(sessionMeta, opts) {
  const parsed = parseTranscript(sessionMeta.path);
  if (!parsed || parsed.asks.length === 0) {
    return {
      uuid: sessionMeta.uuid,
      uuidHash: hashCite(sessionMeta.uuid),
      mtime: new Date(sessionMeta.mtimeMs).toISOString(),
      asks: [],
      verdicts: [],
      cost_usd: 0,
      skipped_reason: parsed ? 'no-asks' : 'parse-failed',
    };
  }
  const assistantByUuid = new Map();
  for (const seg of parsed.assistantSegments) {
    if (seg.afterUserUuid) assistantByUuid.set(seg.afterUserUuid, seg);
  }
  const prompt = buildAdjudicatePrompt(
    { mtime: new Date(sessionMeta.mtimeMs).toISOString() },
    parsed.asks,
    assistantByUuid,
  );

  let verdicts = null;
  let cost = 0;
  if (opts.dryRun) {
    verdicts = parsed.asks.map(a => ({
      ask_index: a.idx,
      ask_paraphrase: '<dry-run paraphrase>',
      addressed: 'yes',
      confidence: 'L',
      evidence: '<dry-run>',
      gap_description: '',
      suggested_followup_framing: '',
    }));
  } else {
    const { content, error, usd, tokens_in, tokens_out } = await callSonnetAdjudicate(prompt, { dryRun: false });
    cost = usd || 0;
    if (cost > 0) {
      appendSpendLedger({
        date: TODAY,
        timestamp: new Date().toISOString(),
        model: SONNET_MODEL,
        usd: cost,
        tokens_in: tokens_in || null,
        tokens_out: tokens_out || null,
        label: `adjudicate-${hashCite(sessionMeta.uuid)}`,
      });
      if (cost > PER_CALL_WARN_USD) {
        log(`WARN: per-call $${cost.toFixed(4)} > $${PER_CALL_WARN_USD}`, 'warn');
      }
    }
    if (error) {
      log(`sonnet error on session ${hashCite(sessionMeta.uuid)}: ${error}`, 'warn');
      return {
        uuid: sessionMeta.uuid,
        uuidHash: hashCite(sessionMeta.uuid),
        mtime: new Date(sessionMeta.mtimeMs).toISOString(),
        asks: parsed.asks,
        verdicts: [],
        cost_usd: cost,
        skipped_reason: `sonnet-error: ${error.slice(0, 120)}`,
      };
    }
    verdicts = parseAdjudicateResponse(content, parsed.asks.length);
    if (!verdicts) {
      return {
        uuid: sessionMeta.uuid,
        uuidHash: hashCite(sessionMeta.uuid),
        mtime: new Date(sessionMeta.mtimeMs).toISOString(),
        asks: parsed.asks,
        verdicts: [],
        cost_usd: cost,
        skipped_reason: 'json-parse-fail',
      };
    }
  }

  return {
    uuid: sessionMeta.uuid,
    uuidHash: hashCite(sessionMeta.uuid),
    mtime: new Date(sessionMeta.mtimeMs).toISOString(),
    asks: parsed.asks,
    verdicts,
    cost_usd: cost,
    skipped_reason: null,
  };
}

// ─── Report rendering ───────────────────────────────────────────────────────

function renderReport(sessionResults, opts, totalSpent) {
  const totalAsks = sessionResults.reduce((s, r) => s + r.asks.length, 0);
  const flatVerdicts = [];
  for (const sr of sessionResults) {
    for (let i = 0; i < sr.verdicts.length; i++) {
      const v = sr.verdicts[i];
      const ask = sr.asks[i];
      if (!v || !ask) continue;
      flatVerdicts.push({
        sessionHash: sr.uuidHash,
        sessionUuid: sr.uuid,
        sessionMtime: sr.mtime,
        askIdx: ask.idx,
        askHash: hashCite(ask.content),
        askContent: ask.content,
        ...v,
      });
    }
  }
  const unaddressed = flatVerdicts.filter(v => v.addressed === 'no' || v.addressed === 'partial' || v.addressed === 'deferred');
  const addressedCount = flatVerdicts.filter(v => v.addressed === 'yes').length;

  // Citation policy guard — every citation hashed
  const citations = sessionResults.map(sr => ({
    path: sr.uuid && PROJECT_TRANSCRIPTS_DIR
      ? join(PROJECT_TRANSCRIPTS_DIR, `${sr.uuid}.jsonl`)
      : '',
    mode: 'hash_only',
    hash: sr.uuidHash,
  }));
  assertNoInlineQuotesFromSensitivePaths(citations);

  const findingsLines = unaddressed.map((v, i) => {
    const para = (v.ask_paraphrase || '').replace(/\|/g, '\\|').slice(0, 80);
    return `| F${i + 1} | #${v.sessionHash.replace('sha256:', '')} | ${escMd(para)} | ${v.addressed} | ${v.confidence} | See followups § F${i + 1} |`;
  }).join('\n');

  const sessionRows = sessionResults.map(sr => {
    const sAsks = sr.asks.length;
    const sAdjudicated = sr.verdicts.length;
    const sAddressed = sr.verdicts.filter(v => v && v.addressed === 'yes').length;
    const sUnaddressed = sAdjudicated - sAddressed;
    const skip = sr.skipped_reason ? `(${sr.skipped_reason})` : '';
    return `| #${sr.uuidHash.replace('sha256:', '')} | ${sr.mtime.slice(0, 19).replace('T', ' ')} | ${sAsks} | ${sAddressed} | ${sUnaddressed} | $${sr.cost_usd.toFixed(4)} ${skip} |`;
  }).join('\n');

  const tldr = unaddressed.length === 0
    ? `${addressedCount} of ${totalAsks} asks addressed — 0 unaddressed across ${sessionResults.length} session(s). Clean cycle.`
    : `${unaddressed.length} of ${totalAsks} asks were not fully addressed across ${sessionResults.length} session(s). Highest-confidence gaps surfaced first.`;

  const topGaps = unaddressed
    .filter(v => v.confidence === 'H')
    .slice(0, 5)
    .map(v => `- session #${v.sessionHash.replace('sha256:', '')} ask #${v.askHash.replace('sha256:', '')} — "${escMd((v.ask_paraphrase || '').slice(0, 70))}"`)
    .join('\n') || '_(none at H confidence)_';

  return `---
classification: "[PERSONAL — DO NOT PUBLISH]"
generated_at: ${new Date().toISOString()}
scope: ${opts.session ? `session ${opts.session}` : opts.sessions ? `sessions ${opts.sessions.length}` : opts.last ? `--last ${opts.last}` : `${opts.since || '?'}..${opts.until || '?'}`}
sessions_scanned: ${sessionResults.length}
asks_extracted: ${totalAsks}
addressed: ${addressedCount}
unaddressed: ${unaddressed.length}
spend_usd: ${totalSpent.toFixed(4)}
budget_usd: ${opts.budget}
dry_run: ${opts.dryRun}
---

# Task audit — ${TODAY}

## TL;DR

${tldr}

**Highest-confidence gaps:**

${topGaps}

## Findings

${unaddressed.length === 0
  ? '_No unaddressed asks in scope._'
  : `| # | Session | Ask (paraphrase, ≤80 chars) | Status | Conf | Followup |
|---|---|---|---|---|---|
${findingsLines}`}

## Sessions scanned

| UUID hash | mtime | asks | addressed | unaddressed | cost |
|---|---|---|---|---|---|
${sessionRows || '_(none)_'}

## Wins

${flatVerdicts.filter(v => v.addressed === 'yes' && v.confidence === 'H').length} asks shipped at HIGH confidence. ${flatVerdicts.filter(v => v.addressed === 'yes' && v.confidence === 'M').length} at MEDIUM.

## Notes

- Citations are hash_only (sha256:12-hex of session UUID + ask content).
- Cross-fork-leak guard fired clean: 0 inline quotes from sensitive paths.
- Daily cap: $${opts.budget}. Spent: $${totalSpent.toFixed(4)}.
- For continuation prompts on each finding, see \`${FOLLOWUPS_PATH.replace(REPO_ROOT + '/', '')}\`.
`;
}

function renderFollowups(sessionResults) {
  const flat = [];
  for (const sr of sessionResults) {
    for (let i = 0; i < sr.verdicts.length; i++) {
      const v = sr.verdicts[i];
      const ask = sr.asks[i];
      if (!v || !ask) continue;
      if (v.addressed === 'no' || v.addressed === 'partial' || v.addressed === 'deferred') {
        flat.push({
          sessionHash: sr.uuidHash,
          sessionMtime: sr.mtime,
          askHash: hashCite(ask.content),
          askContent: ask.content,
          ...v,
        });
      }
    }
  }
  if (flat.length === 0) {
    return `# Continuation prompts — ${TODAY}

_No unaddressed asks in scope. Nothing to continue._
`;
  }
  const sections = flat.map((v, i) => `## F${i + 1} — session #${v.sessionHash.replace('sha256:', '')} ask #${v.askHash.replace('sha256:', '')}

**Status:** ${v.addressed} · **Confidence:** ${v.confidence}
**Session date:** ${v.sessionMtime.slice(0, 10)}
**Gap:** ${v.gap_description || '(unspecified)'}

### Original ask (paste-ready)

> ${v.askContent.split('\n').join('\n> ')}

### Suggested continuation prompt

${v.suggested_followup_framing || `_(no specific framing suggested — restate the ask above with context that the prior session shipped only part of it; identify which part fell through and ask for that part to ship.)_`}

---
`).join('\n');

  return `# Continuation prompts — ${TODAY}

${flat.length} unaddressed ask(s). Each section has the original ask (paste-ready) + suggested framing for a fresh session.

**Note:** This file is gitignored under .claude/audit/. The asks are stored verbatim because that IS the deliverable — you paste them into a new session.

${sections}
`;
}

function escMd(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/`/g, '\\`');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // Already-complete short-circuit. If today's report + DONE sidecar exist
  // AND no in-flight PARTIAL exists, exit without re-burning $ on the same
  // date. --force-restart bypasses.
  if (!opts.forceRestart
      && (existsSync(PARTIAL_DONE_PATH) || existsSync(REPORT_PATH))
      && !existsSync(PARTIAL_PATH)) {
    log(`today already complete (--force-restart to redo)`);
    process.stdout.write(`task-audit done. (already-complete)\n`);
    return;
  }

  // Daily cap pre-check
  const todaySpend = getTodaySpend();
  if (todaySpend >= opts.budget) {
    log(`CAP EXHAUSTED: $${todaySpend.toFixed(4)} >= $${opts.budget}`, 'error');
    process.exit(3);
  }

  // --force-restart: unlink today's PARTIAL so the loop starts clean.
  if (opts.forceRestart && existsSync(PARTIAL_PATH)) {
    log(`--force-restart: unlinking partial sidecar`);
    try { unlinkSync(PARTIAL_PATH); }
    catch (e) { log(`force-restart unlink fail: ${e.message}`, 'warn'); }
  }

  // Load resume state from today's PARTIAL sidecar (if any) — preloads
  // sessionResults + builds the skip-set the loop consults.
  const resumeState = opts.forceRestart ? null : loadPartialSidecar();
  const auditedSHAs = resumeState?.auditedSHAs ?? new Set();
  const sessionResults = resumeState ? resumeState.results.slice() : [];
  if (auditedSHAs.size > 0) {
    log(`[resume] preloaded ${auditedSHAs.size} session(s) from sidecar at ${PARTIAL_PATH}`);
  }

  log(`scope: ${JSON.stringify({ last: opts.last, session: opts.session, sessions: opts.sessions, since: opts.since, until: opts.until })}, budget=$${opts.budget}, dryRun=${opts.dryRun}, forceRestart=${opts.forceRestart}`);

  const { sessions, descriptor } = enumerateSessions(opts);
  if (sessions.length === 0) {
    log(`no sessions in scope (${descriptor})`, 'warn');
    if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, renderReport([], opts, todaySpend));
    if (!opts.skipFollowups) writeFileSync(FOLLOWUPS_PATH, renderFollowups([]));
    finalizePartialSidecar();
    process.stdout.write(`wrote ${REPORT_PATH}\n`);
    return;
  }
  log(`found ${sessions.length} session(s) in scope (${descriptor})`);

  let spentThisRun = 0;
  for (const sm of sessions) {
    const smHash = hashCite(sm.uuid);
    if (auditedSHAs.has(smHash)) {
      log(`[resumed] sha256:${smHash.replace('sha256:', '').slice(0, 12)} — skipping (in sidecar)`);
      continue;
    }
    if (todaySpend + spentThisRun >= opts.budget) {
      log(`CAP HIT mid-run: ${sessionResults.length} results so far, ${sessions.length} in scope`, 'error');
      break;
    }
    log(`auditing session #${smHash.replace('sha256:', '')} (${sm.bytes} bytes)`);
    let result;
    try {
      result = await auditOneSession(sm, opts);
      spentThisRun += result.cost_usd;
      log(`  → ${result.asks.length} asks, ${result.verdicts.length} verdicts, $${result.cost_usd.toFixed(4)}`);
    } catch (e) {
      log(`  ! session failed: ${e.message}`, 'warn');
      result = {
        uuid: sm.uuid,
        uuidHash: smHash,
        mtime: new Date(sm.mtimeMs).toISOString(),
        asks: [],
        verdicts: [],
        cost_usd: 0,
        skipped_reason: `exception: ${e.message.slice(0, 120)}`,
      };
    }
    sessionResults.push(result);
    // Persist BEFORE moving to the next session — the whole point of the
    // sidecar is that an interrupt here loses at most this session's verdicts,
    // not the whole run.
    appendPartialSidecar(result);
  }

  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  const totalSpent = todaySpend + spentThisRun;
  const reportMd = renderReport(sessionResults, opts, totalSpent);
  writeFileSync(REPORT_PATH, reportMd);
  log(`wrote ${REPORT_PATH}`);
  if (!opts.skipFollowups) {
    const followupsMd = renderFollowups(sessionResults);
    writeFileSync(FOLLOWUPS_PATH, followupsMd);
    log(`wrote ${FOLLOWUPS_PATH}`);
  }
  // Atomically signal "today is complete" by renaming PARTIAL → DONE. The
  // already-complete short-circuit at top of main() reads this on next launch.
  finalizePartialSidecar();
  process.stdout.write(`task-audit done. sessions=${sessionResults.length} spent=$${spentThisRun.toFixed(4)} report=${REPORT_PATH}\n`);
}

main().catch(err => {
  log(`fatal: ${err.message}\n${err.stack}`, 'error');
  process.exit(1);
});
