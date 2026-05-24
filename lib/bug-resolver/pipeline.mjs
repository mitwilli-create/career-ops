// lib/bug-resolver/pipeline.mjs
//
// 7-phase per-bug processing pipeline. Takes one LedgerEntry, walks it through
// audit → research → adjudicate → action_plan → implement → verify → harden,
// returns a structured result with status (DRAFT_PR | NEEDS_HUMAN | WONT_FIX),
// vendor_log, cost ledger, and (when implement succeeded) the generated patch.
//
// PR creation lives in lib/bug-resolver/draft-pr.mjs — this module produces
// the patch + metadata only.
//
// Refinements baked in (per data/bug-resolver-plan.md § Phase 2 — Refinements):
//   1. Audit RE-READS source files (not ledger summary)
//   2. Audit handles semantic dedup via findCandidateDupes + LLM check
//   3. Audit classifies bug_class against catalog
//   4. Audit re-validates severity (catches keyword false-positives)
//   5. Opt-in / sensitive entries auto-route to NEEDS_HUMAN

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { callPhase, VendorDisabledError } from './vendor-router.mjs';
import { findCandidateDupes, linkEntries } from './ledger.mjs';
import { hashCite, isSensitivePath } from '../leak-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const BRAIN_CATALOG = join(process.env.HOME || '', '.claude/knowledge/brain/bug-class-catalog.md');

// ─── Errors ─────────────────────────────────────────────────────────────────
export class CostCapExceeded extends Error {
  constructor(msg, totalCost, cap) {
    super(msg);
    this.name = 'CostCapExceeded';
    this.totalCost = totalCost;
    this.cap = cap;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Re-read source file fresh (not the intake-cached summary).
// Returns { content, hash, drifted, exists }.
function readSource(sourceSurface, expectedHash) {
  // Handle non-file sources (github, transcript, memory prefixes)
  if (sourceSurface.startsWith('github://') ||
      sourceSurface.startsWith('transcript:') ||
      sourceSurface.startsWith('memory:')) {
    return { content: '', hash: null, drifted: false, exists: false, kind: 'non-file' };
  }
  // Resolve relative-to-repo paths
  const absPath = sourceSurface.startsWith('/')
    ? sourceSurface
    : join(REPO_ROOT, sourceSurface);
  if (!existsSync(absPath)) {
    return { content: '', hash: null, drifted: false, exists: false, kind: 'missing' };
  }
  try {
    const content = readFileSync(absPath, 'utf-8');
    const hash = hashCite(content);
    return {
      content,
      hash,
      drifted: expectedHash && hash !== expectedHash,
      exists: true,
      kind: 'file',
      absPath,
    };
  } catch (err) {
    return { content: '', hash: null, drifted: false, exists: false, kind: 'unreadable', error: err.message };
  }
}

// Get bug-class-catalog pattern names + 1-line summaries for the audit prompt.
// Cached per process to avoid re-reading on every bug.
let _catalogCache = null;
function readBugClassCatalog() {
  if (_catalogCache !== null) return _catalogCache;
  if (!existsSync(BRAIN_CATALOG)) {
    _catalogCache = '(no catalog file available)';
    return _catalogCache;
  }
  try {
    const raw = readFileSync(BRAIN_CATALOG, 'utf-8');
    // Extract pattern headers (## Pattern X — name) for prompt context
    const patterns = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^##\s+(Pattern\s+[A-Z]\s+[—-]\s+.+)$/);
      if (m) patterns.push(m[1].trim());
    }
    _catalogCache = patterns.length > 0
      ? patterns.map(p => `  - ${p}`).join('\n')
      : '(no pattern headers found)';
    return _catalogCache;
  } catch {
    _catalogCache = '(catalog read failed)';
    return _catalogCache;
  }
}

// Repair diff hunk headers whose line counts don't match the actual hunk content.
// GPT-5 frequently generates @@ -X,Y +X,Y @@ with incorrect Y values; git
// rejects those as "corrupt patch". This re-counts each hunk and rewrites the
// header to match the actual content.
function repairDiffCounts(patch) {
  const lines = patch.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('@@')) {
      out.push(line);
      i++;
      continue;
    }
    const hm = line.match(/^(@@\s+-\d+)(?:,\d+)?(\s+\+\d+)(?:,\d+)?(\s+@@.*)$/);
    if (!hm) {
      out.push(line);
      i++;
      continue;
    }
    i++;
    const hunkLines = [];
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      hunkLines.push(lines[i]);
      i++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (const hl of hunkLines) {
      if (hl.startsWith('-')) { oldCount++; }
      else if (hl.startsWith('+')) { newCount++; }
      else { oldCount++; newCount++; } // context or blank
    }
    out.push(`${hm[1]},${oldCount}${hm[2]},${newCount}${hm[3]}`);
    out.push(...hunkLines);
  }
  return out.join('\n');
}

// Truncate source content to fit prompt budget. Keep top + bottom; middle elided.
function truncateForPrompt(content, maxChars = 12_000) {
  if (!content || content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars - 80;
  return content.slice(0, headChars)
    + '\n\n... [TRUNCATED — middle elided for prompt budget] ...\n\n'
    + content.slice(-tailChars);
}

// Extract JSON from a model response. 4-strategy cascade handles Gemini's
// tendency to wrap JSON in fences + prose regardless of "JSON ONLY" instructions.
function parseJsonResponse(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Strategy 1: direct parse
  try { return JSON.parse(s); } catch {}

  // Strategy 2: strip markdown fences
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // Strategy 3: brace-balanced extract (find first { and its matching })
  const firstBrace = s.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(firstBrace, i + 1)); } catch { break; }
        }
      }
    }
  }

  // Strategy 4: prose-prefix strip ("Here is the JSON:\n{...}")
  const prefixMatch = s.match(/(?:here(?:'s| is) (?:the )?json:?\s*\n?)([\s\S]+)/i);
  if (prefixMatch) {
    return parseJsonResponse(prefixMatch[1]);
  }

  return null;
}

// Build prompts per phase. Each builder returns { prompt, citations }.
// citations is the array passed to leak-guard pre-flight.

function buildAuditPrompt(bug, sourceInfo, candidateDupes) {
  const truncated = truncateForPrompt(sourceInfo.content);
  const catalog = readBugClassCatalog();
  const dupeList = candidateDupes.length === 0
    ? '(no heuristic candidates — bug is likely unique)'
    : candidateDupes.map(d => `  - ${d.id}: ${d.title.slice(0, 100)} (bug_class=${d.bug_class || 'null'})`).join('\n');

  const prompt = `You are auditing a bug entry from career-ops's bug ledger. Your job:
1. Re-validate severity based on actual impact (NOT just keyword presence)
2. Classify bug_class against known patterns
3. Check if this bug is a semantic duplicate of any candidate
4. Identify any escalation reasons (sensitive data, ambiguous repro, high blast radius)

Bug entry:
  ID: ${bug.id}
  Title: ${bug.title}
  Severity (intake-inferred): ${bug.severity}
  bug_class (intake-inferred): ${bug.bug_class || 'null'}
  Source: ${bug.source_surface}
  First seen: ${bug.first_seen}
  Source-hash drift detected: ${sourceInfo.drifted ? 'YES — source updated since intake' : 'no'}

Source content (re-read fresh):
\`\`\`
${truncated || '(source unavailable: ' + sourceInfo.kind + ')'}
\`\`\`

Heuristic candidate duplicates:
${dupeList}

Known bug-class patterns (from bug-class-catalog.md):
${catalog}

Respond with JSON ONLY (no prose, no fences). Schema:
{
  "severity": "CRIT|HIGH|MED|LOW",
  "severity_changed": <bool>,
  "severity_rationale": "<one sentence>",
  "bug_class": "<pattern-letter-and-name or null>",
  "is_duplicate_of": "<bug_id or null>",
  "duplicate_rationale": "<one sentence or null>",
  "escalate_reason": "<one sentence or null>",
  "summary": "<≤300 char plain-language bug description>",
  "blast_radius": "low|medium|high"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  const citations = [{ path: bug.source_surface, mode: 'summary_only' }];
  return { prompt, citations };
}

function buildResearchPrompt(bug, auditResult, sourceInfo) {
  const truncated = truncateForPrompt(sourceInfo.content, 8_000);
  const prompt = `You are researching a bug for career-ops. Audit phase concluded:

Audit summary: ${auditResult.summary}
Severity: ${auditResult.severity}
bug_class: ${auditResult.bug_class || 'unclassified'}
Blast radius: ${auditResult.blast_radius}

Source content:
\`\`\`
${truncated}
\`\`\`

Research task:
1. What's the most likely root cause? (technical hypothesis, not just symptoms)
2. Are there known fixes for this bug class? Reference patterns / public discussions if you can identify them.
3. What's the smallest reasonable fix scope? (file paths / line ranges if extractable from source)
4. Any related bugs in the same codebase area that should be fixed together?

Respond with JSON ONLY. Schema:
{
  "root_cause_hypothesis": "<2-3 sentences>",
  "fix_scope": "<file paths + line ranges + brief>",
  "known_fixes_reference": "<URLs or pattern names if identified, else null>",
  "related_bugs_in_scope": ["<file:line snippets if any>", ...],
  "confidence": "high|medium|low",
  "confidence_rationale": "<one sentence>"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  const citations = [{ path: bug.source_surface, mode: 'summary_only' }];
  return { prompt, citations };
}

function buildAdjudicatePrompt(bug, auditResult, researchResult) {
  const prompt = `You are adjudicating a bug-audit conclusion as an INDEPENDENT verifier from a different LLM vendor than the auditor. Your job is to push back where audit may have been wrong, NOT to rubber-stamp.

Bug: ${bug.title}
Source: ${bug.source_surface}

Auditor's conclusions:
- Severity: ${auditResult.severity} (changed from intake's ${bug.severity}? ${auditResult.severity_changed})
- Severity rationale: ${auditResult.severity_rationale}
- bug_class: ${auditResult.bug_class || 'unclassified'}
- Blast radius: ${auditResult.blast_radius}
- Summary: ${auditResult.summary}

Researcher's conclusions:
- Root cause: ${researchResult.root_cause_hypothesis}
- Fix scope: ${researchResult.fix_scope}
- Confidence: ${researchResult.confidence} (${researchResult.confidence_rationale})

Your task — answer with explicit YES/NO + rationale:
1. Is the severity assessment correct?
2. Is the root-cause hypothesis plausible?
3. Is the fix scope appropriately narrow (not over-scoped)?
4. Should this bug proceed to action_plan + implement, or escalate to NEEDS_HUMAN?

Respond with JSON ONLY. Schema:
{
  "severity_correct": <bool>,
  "severity_disagreement": "<rationale if disagreeing, else null>",
  "root_cause_plausible": <bool>,
  "root_cause_disagreement": "<rationale or null>",
  "fix_scope_appropriate": <bool>,
  "fix_scope_disagreement": "<rationale or null>",
  "verdict": "PROCEED|ESCALATE",
  "escalate_reason": "<required if ESCALATE>"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  return { prompt, citations: [] };
}

function buildActionPlanPrompt(bug, auditResult, researchResult, adjudicateResult) {
  const prompt = `You are writing a code-change action plan for a bug in career-ops. Adjudication PROCEEDED. Your job: produce a CONCRETE, narrowly-scoped plan a code-writer can execute without further analysis.

Bug: ${bug.title}
Source: ${bug.source_surface}
Root cause: ${researchResult.root_cause_hypothesis}
Fix scope: ${researchResult.fix_scope}

Constraints:
- The fix must NOT modify any files outside the fix scope unless absolutely necessary (changes propagate to PR review burden)
- The fix must NOT modify gitignored files (cv.md, applications.md, data/hm-intel/, etc.)
- The fix MUST include a test or verification step Mitchell can run locally
- If the fix touches a file that has a bug-class catalog pattern, the patch should match the established prevention pattern

Respond with JSON ONLY. Schema:
{
  "files_to_modify": [{"path": "...", "change_summary": "...", "estimated_loc": <int>}],
  "files_to_create": [{"path": "...", "purpose": "..."}],
  "test_plan": "<single-paragraph: what to run + what success looks like>",
  "rollback_plan": "<one sentence: how to revert if patch is bad>",
  "pr_title": "<≤70 chars>",
  "pr_body_outline": "<3-5 bullet points covering: problem, fix, test plan, risks>"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  return { prompt, citations: [] };
}

function buildImplementPrompt(bug, actionPlan, sourceInfo) {
  const truncated = truncateForPrompt(sourceInfo.content, 10_000);
  const fileList = actionPlan.files_to_modify.map(f => `  - ${f.path}: ${f.change_summary}`).join('\n');
  const prompt = `You are writing a unified-diff patch for career-ops. The action plan is approved. Produce a patch that applies cleanly via \`git apply\` and passes \`node --check\` for any .mjs/.js files touched.

Bug: ${bug.title}
Files to modify:
${fileList}
${actionPlan.files_to_create.length > 0 ? 'Files to create:\n' + actionPlan.files_to_create.map(f => '  - ' + f.path + ': ' + f.purpose).join('\n') : ''}

Source content of the primary file (${bug.source_surface}):
\`\`\`
${truncated || '(source unavailable)'}
\`\`\`

Test plan: ${actionPlan.test_plan}

Output requirements:
- Unified-diff format starting with \`diff --git\` headers
- Patch must apply with \`git apply --check\` against current HEAD
- Patch MUST NOT touch any path under: cv.md, data/applications.md, data/hm-intel/, data/apply-pack(s)/, ~/.claude/projects/
- Patch MUST NOT modify .gitignore or scripts/safe-gh-pr.sh
- Include line context lines (3 above, 3 below) per standard diff format

Respond with the patch ONLY — no prose, no fences, no JSON. Start with \`diff --git\`. End with the last patch line.`;

  return { prompt, citations: [{ path: bug.source_surface, mode: 'summary_only' }] };
}

function buildVerifyPrompt(bug, patch, actionPlan) {
  const truncatedPatch = patch.length > 20_000 ? patch.slice(0, 20_000) + '\n... [PATCH TRUNCATED]' : patch;
  const prompt = `You are verifying a patch produced for a bug in career-ops. Your job: confirm the patch is safe to ship as a DRAFT PR (Mitchell will still review before merge).

Bug: ${bug.title}
PR title: ${actionPlan.pr_title}
Test plan: ${actionPlan.test_plan}

The patch:
\`\`\`diff
${truncatedPatch}
\`\`\`

Verification checklist:
1. Does the patch touch any forbidden paths? (cv.md, data/applications.md, data/hm-intel/, data/apply-pack(s)/, ~/.claude/projects/, .gitignore, safe-gh-pr.sh)
2. Does the patch match the action plan's files_to_modify list?
3. Are there any obviously-broken changes (unbalanced braces, broken imports, hardcoded secrets)?
4. Is the patch scope appropriately narrow?

Respond with JSON ONLY:
{
  "forbidden_paths_touched": <bool>,
  "forbidden_paths_list": ["<path>", ...],
  "matches_action_plan": <bool>,
  "scope_appropriate": <bool>,
  "obvious_issues": ["<issue>", ...],
  "verdict": "SHIP|HOLD",
  "hold_reason": "<required if HOLD>"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  return { prompt, citations: [] };
}

function buildHardenPrompt(bug, auditResult, actionPlan, patch) {
  const prompt = `You are writing hardening guidance for a bug that was just fixed in career-ops. Output a brief markdown section that either:
(A) Adds a new pattern to ~/.claude/knowledge/brain/bug-class-catalog.md, OR
(B) Adds a case-study note to an existing pattern there.

Bug: ${bug.title}
bug_class: ${auditResult.bug_class || 'unclassified'}
Root cause (per audit): ${auditResult.summary}
Fix scope: ${actionPlan.files_to_modify.map(f => f.path).join(', ')}

Required structure (Pick A or B):

(A) Brand new pattern:
\`\`\`
### Bug class: <pattern-slug>

<1-paragraph description of the pattern>

**The bug pattern** (do NOT write):
\`\`\`code\`\`\`

**The safe patterns**:
\`\`\`code\`\`\`

**Known fixed instances**: <bug.id> at <files>. Do NOT re-introduce.

**Detection**: <one-liner how to grep/lint for the bad pattern>
\`\`\`

(B) Existing-pattern case study:
\`\`\`
### Bug class: <existing-pattern-slug> — case study <bug.id>

<2-3 sentences: how this instance manifested, what was fixed, what to watch for in similar files>
\`\`\`

Respond with JSON ONLY:
{
  "mode": "A|B",
  "target_pattern_slug": "<existing slug for B; new slug for A>",
  "markdown_block": "<the full markdown block per the format above>"
}

CRITICAL OUTPUT FORMAT: Respond with raw JSON only. NO markdown fences. NO \`\`\`json wrapper. NO prose before. NO prose after. Your entire response MUST start with the character { and end with the character }. Nothing else. If you cannot produce valid JSON, output {"error": "<reason>"}.`;

  return { prompt, citations: [] };
}

// ─── Main pipeline ──────────────────────────────────────────────────────────
//
// processBug(bug, opts?) — runs the 7-phase pipeline on one ledger entry.
//
//   bug: LedgerEntry (full schema)
//   opts: { perBugCap?: number, dryRun?: boolean }
//
// Returns:
//   {
//     status: 'DRAFT_PR' | 'NEEDS_HUMAN' | 'WONT_FIX' | 'ABORTED',
//     linked_to?: string,         // when WONT_FIX via semantic-dedup
//     patch?: string,             // when status='DRAFT_PR' or 'NEEDS_HUMAN' after implement
//     pr_metadata?: {title, body_outline, test_plan, rollback_plan},
//     hardening_md?: string,      // generated by harden phase
//     audit_summary?: string,
//     needs_human_reasons: string[],
//     vendor_log: [{phase, vendor, ms, tokens, costUsd, ok, error?}, ...],
//     total_cost_usd: number,
//   }
export async function processBug(bug, opts = {}) {
  const log = [];
  const human_reasons = [];
  let totalCost = 0;
  const dryRun = !!opts.dryRun;

  function recordCall(phaseResult) {
    log.push({
      phase: phaseResult.phase,
      vendor: phaseResult.vendor,
      ms: phaseResult.ms,
      tokens: phaseResult.tokens,
      costUsd: phaseResult.costUsd,
      ok: !phaseResult.error,
      error: phaseResult.error,
    });
    totalCost += phaseResult.costUsd || 0;
    if (opts.perBugCap && totalCost >= opts.perBugCap) {
      throw new CostCapExceeded(
        `Per-bug cap $${opts.perBugCap} exceeded ($${totalCost.toFixed(2)} spent)`,
        totalCost, opts.perBugCap
      );
    }
  }

  function finalize(extra = {}) {
    return {
      needs_human_reasons: human_reasons,
      vendor_log: log,
      total_cost_usd: totalCost,
      ...extra,
    };
  }

  // ─── Phase 0: Pre-flight ──────────────────────────────────────────────
  if (bug.intake_metadata?.is_sensitive_source) {
    return finalize({
      status: 'NEEDS_HUMAN',
      needs_human_reasons: ['sensitive-source — opt-in entries need human triage to extract bug detail (Phase 2 V1 does not auto-process sensitive sources)'],
    });
  }
  if (bug.linked_to) {
    return finalize({
      status: 'WONT_FIX',
      linked_to: bug.linked_to,
      needs_human_reasons: [`Already linked to ${bug.linked_to}`],
    });
  }

  // Re-read source fresh
  const sourceInfo = readSource(bug.source_surface, bug.source_hash);
  if (!sourceInfo.exists) {
    return finalize({
      status: 'NEEDS_HUMAN',
      needs_human_reasons: [`Source ${bug.source_surface} unavailable (${sourceInfo.kind}); cannot re-read for audit`],
    });
  }
  if (sourceInfo.drifted) {
    human_reasons.push(`Source hash drifted since intake — content has changed; audit proceeding with fresh content`);
  }

  if (dryRun) {
    return finalize({
      status: 'NEEDS_HUMAN',
      needs_human_reasons: ['DRY-RUN mode — pipeline pre-flight passed; no LLM calls made'],
    });
  }

  // ─── Phase 1: Audit ────────────────────────────────────────────────────
  let auditResult;
  try {
    const candidates = findCandidateDupes(bug, 5);
    const { prompt, citations } = buildAuditPrompt(bug, sourceInfo, candidates);
    const r = await callPhase({ phase: 'audit', prompt, citations });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`audit-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN' });
    }
    auditResult = parseJsonResponse(r.content);
    if (!auditResult) {
      human_reasons.push(`audit-parse-error: response was not valid JSON`);
      return finalize({ status: 'NEEDS_HUMAN', audit_raw: r.content.slice(0, 500) });
    }
  } catch (err) {
    if (err instanceof CostCapExceeded) {
      human_reasons.push(err.message);
      return finalize({ status: 'NEEDS_HUMAN' });
    }
    if (err instanceof VendorDisabledError) {
      human_reasons.push(err.message);
      return finalize({ status: 'NEEDS_HUMAN' });
    }
    human_reasons.push(`audit-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN' });
  }

  // Audit-driven branching
  if (auditResult.is_duplicate_of) {
    linkEntries(bug.id, auditResult.is_duplicate_of, auditResult.duplicate_rationale || 'semantic-duplicate per audit');
    return finalize({
      status: 'WONT_FIX',
      linked_to: auditResult.is_duplicate_of,
      audit_summary: auditResult.summary,
    });
  }
  if (auditResult.escalate_reason) {
    human_reasons.push(`audit-escalate: ${auditResult.escalate_reason}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
  }

  // ─── Phase 2: Research ─────────────────────────────────────────────────
  let researchResult;
  try {
    const { prompt, citations } = buildResearchPrompt(bug, auditResult, sourceInfo);
    const r = await callPhase({ phase: 'research', prompt, citations });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`research-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
    researchResult = parseJsonResponse(r.content);
    if (!researchResult) {
      human_reasons.push(`research-parse-error: response was not valid JSON`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
  } catch (err) {
    human_reasons.push(`research-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
  }

  // ─── Phase 3: Adjudicate ───────────────────────────────────────────────
  let adjudicateResult;
  try {
    const { prompt } = buildAdjudicatePrompt(bug, auditResult, researchResult);
    const r = await callPhase({ phase: 'adjudicate', prompt });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`adjudicate-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
    adjudicateResult = parseJsonResponse(r.content);
    if (!adjudicateResult) {
      human_reasons.push(`adjudicate-parse-error: response was not valid JSON`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
  } catch (err) {
    human_reasons.push(`adjudicate-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
  }

  if (adjudicateResult.verdict === 'ESCALATE') {
    human_reasons.push(`adjudicate-escalate: ${adjudicateResult.escalate_reason || 'no rationale provided'}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
  }

  // ─── Phase 4: Action plan ──────────────────────────────────────────────
  let actionPlan;
  try {
    const { prompt } = buildActionPlanPrompt(bug, auditResult, researchResult, adjudicateResult);
    const r = await callPhase({ phase: 'action_plan', prompt });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`action_plan-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
    actionPlan = parseJsonResponse(r.content);
    if (!actionPlan || !Array.isArray(actionPlan.files_to_modify)) {
      human_reasons.push(`action_plan-parse-error: response missing files_to_modify`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
    }
  } catch (err) {
    human_reasons.push(`action_plan-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary });
  }

  // Pre-implement check: all files_to_modify must exist in this repo.
  // Catches third-party-tool bugs before burning a GPT-5 implement call.
  for (const f of actionPlan.files_to_modify || []) {
    const absPath = f.path.startsWith('/') ? f.path : join(REPO_ROOT, f.path);
    if (!existsSync(absPath)) {
      human_reasons.push(
        `action_plan-target-not-in-repo: ${f.path} — this file does not exist in career-ops. ` +
        `The fix targets a third-party or external codebase and cannot be auto-applied here.`
      );
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan });
    }
  }

  // ─── Phase 5: Implement ────────────────────────────────────────────────
  let patch;
  try {
    const { prompt, citations } = buildImplementPrompt(bug, actionPlan, sourceInfo);
    const r = await callPhase({ phase: 'implement', prompt, citations });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`implement-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan });
    }
    patch = String(r.content || '').trim();
    // Strip fences if model wrapped output
    const fence = patch.match(/^```(?:diff|patch)?\s*([\s\S]*?)\s*```$/);
    if (fence) patch = fence[1].trim();
    // Repair hunk line counts (GPT-5 often miscounts @@ -X,Y +X,Y @@)
    patch = repairDiffCounts(patch);
    if (!patch.startsWith('diff --git')) {
      human_reasons.push(`implement-format-error: output is not a unified diff (no 'diff --git' header)`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan, patch });
    }
  } catch (err) {
    human_reasons.push(`implement-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan });
  }

  // Sanitize the patch: CRLF → LF; remove any UTF-8 BOM.
  // LLMs (especially GPT-5) sometimes emit CRLF diffs which git rejects
  // as "corrupt patch" even when the diff logic is correct.
  patch = patch
    .replace(/^﻿/, '')          // BOM
    .replace(/\r\n/g, '\n')          // Windows CRLF
    .replace(/\r/g, '\n');           // stray CR

  // Apply-check the patch (does NOT actually apply — just validates)
  try {
    execSync('git apply --check -', {
      input: patch,
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      timeout: 10_000,
    });
  } catch (err) {
    // Write the raw patch to /tmp for diagnosis — allows manual inspection
    // without re-running the expensive LLM phases.
    try {
      const { writeFileSync: wf } = await import('node:fs');
      wf('/tmp/bug-resolver-last-patch.diff', patch, 'utf-8');
    } catch { /* never crash on debug write */ }
    human_reasons.push(`implement-apply-check-failed: patch will not apply cleanly to current HEAD`);
    return finalize({
      status: 'NEEDS_HUMAN',
      audit_summary: auditResult.summary,
      action_plan: actionPlan,
      patch,
      apply_check_error: String(err.message || err).slice(0, 300),
    });
  }

  // ─── Phase 6: Verify ───────────────────────────────────────────────────
  let verifyResult;
  try {
    const { prompt } = buildVerifyPrompt(bug, patch, actionPlan);
    const r = await callPhase({ phase: 'verify', prompt });
    recordCall(r);
    if (r.error) {
      human_reasons.push(`verify-error: ${r.error}`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan, patch });
    }
    verifyResult = parseJsonResponse(r.content);
    if (!verifyResult) {
      human_reasons.push(`verify-parse-error: response was not valid JSON`);
      return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan, patch });
    }
  } catch (err) {
    human_reasons.push(`verify-exception: ${err.message}`);
    return finalize({ status: 'NEEDS_HUMAN', audit_summary: auditResult.summary, action_plan: actionPlan, patch });
  }

  if (verifyResult.verdict === 'HOLD') {
    human_reasons.push(`verify-hold: ${verifyResult.hold_reason || 'no rationale'}`);
    return finalize({
      status: 'NEEDS_HUMAN',
      audit_summary: auditResult.summary,
      action_plan: actionPlan,
      patch,
      verify_result: verifyResult,
    });
  }
  if (verifyResult.forbidden_paths_touched) {
    human_reasons.push(`verify-leak-risk: patch touches forbidden paths: ${(verifyResult.forbidden_paths_list || []).join(', ')}`);
    return finalize({
      status: 'NEEDS_HUMAN',
      audit_summary: auditResult.summary,
      action_plan: actionPlan,
      patch,
      verify_result: verifyResult,
    });
  }

  // ─── Phase 7: Harden ───────────────────────────────────────────────────
  let hardeningResult;
  try {
    const { prompt } = buildHardenPrompt(bug, auditResult, actionPlan, patch);
    const r = await callPhase({ phase: 'harden', prompt });
    recordCall(r);
    if (r.error) {
      // Hardening failure is non-fatal — PR can still ship
      human_reasons.push(`harden-error (non-fatal): ${r.error}`);
    } else {
      hardeningResult = parseJsonResponse(r.content);
    }
  } catch (err) {
    human_reasons.push(`harden-exception (non-fatal): ${err.message}`);
  }

  // ─── DONE — ready for DRAFT PR ─────────────────────────────────────────
  return finalize({
    status: 'DRAFT_PR_READY', // main orchestrator calls draft-pr.mjs to actually create the PR
    audit_summary: auditResult.summary,
    audit_result: auditResult,
    research_result: researchResult,
    adjudicate_result: adjudicateResult,
    action_plan: actionPlan,
    patch,
    verify_result: verifyResult,
    hardening_md: hardeningResult?.markdown_block || null,
    hardening_target_pattern: hardeningResult?.target_pattern_slug || null,
    hardening_mode: hardeningResult?.mode || null,
    pr_metadata: {
      title: actionPlan.pr_title,
      body_outline: actionPlan.pr_body_outline,
      test_plan: actionPlan.test_plan,
      rollback_plan: actionPlan.rollback_plan,
    },
  });
}
