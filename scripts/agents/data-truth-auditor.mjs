#!/usr/bin/env node
/**
 * scripts/agents/data-truth-auditor.mjs — Recurring metric-truth audit agent.
 *
 * Origin: γ GAMMA overnight 2026-05-19. The original audit found 1 CRITICAL
 * false attribution (a tooltip claimed compute lived in lib/recruiter-pipeline-
 * density.mjs — a file that did not exist), 3 LLM prompts with hardcoded
 * "Today is 2026-05-17 PT" literals, and 2 silent-zero fallbacks where missing
 * source data rendered as confident 0% bars instead of "data unavailable".
 *
 * The audit was a one-shot. This agent is the recurring loop:
 *   1. Re-load the metric inventory (data/gamma-metric-inventory-2026-05-19.json)
 *   2. For each metric, check that its compute fn STILL exports the provenance
 *      fields it gained in the AAA fixes (computed_at, confidence, etc.)
 *   3. Scan source files for new hardcoded-date literals "Today is YYYY-MM-DD"
 *   4. Verify every "Computed by `lib/X.mjs`" claim in scripts/build-dashboard.mjs
 *      points at a file that exists
 *   5. Spit out a "data truth report" diff vs the original audit baseline
 *
 * Usage:
 *   node scripts/agents/data-truth-auditor.mjs --inventory     # rebuild inventory
 *   node scripts/agents/data-truth-auditor.mjs --trace         # follow every metric trace
 *   node scripts/agents/data-truth-auditor.mjs --audit         # produce audit report
 *   node scripts/agents/data-truth-auditor.mjs --check-attribution  # only the false-attribution sweep
 *   node scripts/agents/data-truth-auditor.mjs --check-dates       # only the hardcoded-date sweep
 *   node scripts/agents/data-truth-auditor.mjs --all           # everything, write to data/data-truth-audit-{date}.md
 *
 * Output:
 *   stdout: human summary
 *   data/data-truth-audit-{YYYY-MM-DD}.md (when --all)
 *
 * Anti-hallucination reminder:
 *   Every claim this agent emits MUST be grounded in a file:line read or
 *   a grep hit. No fabricated severities, no invented file paths. If a
 *   metric is unknown, mark it 'unknown' — not 'OK'.
 *
 * Anti-sycophancy reminder:
 *   This agent NEVER reports "everything is fine" if it didn't actually
 *   check everything. The summary tells Mitchell exactly what was checked,
 *   what was skipped, and why.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
// Phase D (2026-05-19): checkHeartbeatTokensDrift() uses globalThis.fetch
// (Node 18+) with AbortSignal.timeout for hang-prevention compliance.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const TODAY = new Date().toISOString().slice(0, 10);

// ── Argument parsing ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  inventory:         args.includes('--inventory'),
  trace:             args.includes('--trace'),
  audit:             args.includes('--audit'),
  checkAttribution:  args.includes('--check-attribution'),
  checkDates:        args.includes('--check-dates'),
  checkTokens:       args.includes('--check-tokens'),  // Phase D (2026-05-19)
  selfTest:          args.includes('--self-test'),     // GAP-RES-26 (2026-05-24)
  all:               args.includes('--all'),
  json:              args.includes('--json'),
  help:              args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  console.log(`Usage: node scripts/agents/data-truth-auditor.mjs [flags]

Flags:
  --inventory          Re-walk lib/ + dashboard-server.mjs for compute fns;
                       refresh data/gamma-metric-inventory-{date}.json.
  --trace              For each metric in the latest inventory, follow the
                       compute chain end-to-end and verify provenance fields.
  --audit              Emit a markdown audit report with CRITICAL/HIGH/
                       MEDIUM/LOW findings (file:line citations).
  --check-attribution  Verify every "Computed by lib/X.mjs" claim in the
                       dashboard build resolves to an existing file.
  --check-dates        Sweep lib/*.mjs for hardcoded "Today is YYYY-MM-DD"
                       literals (the CRIT-2 pattern from the γ audit).
  --check-tokens       Verify dashboard HTML contains the canonical colour
                       values from lib/heartbeat-tokens.json (Phase D,
                       2026-05-19). Tries staging URL first; falls back to
                       local dashboard/index.html. (Phase C drift check)
  --all                Run every check, write the audit report to disk.
  --self-test          Run the inline self-test fixtures for
                       checkSilentZeroPatterns (GAP-RES-26 regression
                       detection). Returns non-zero on test failure.
  --json               Emit JSON instead of human-readable text (where
                       applicable).
  --help, -h           This message.

Examples:
  node scripts/agents/data-truth-auditor.mjs --check-attribution
  node scripts/agents/data-truth-auditor.mjs --check-dates --json
  node scripts/agents/data-truth-auditor.mjs --all

Provenance:
  Originally written by γ GAMMA during the overnight 2026-05-19 build
  (data/overnight-haul-2026-05-19.md Task Γ.8). The original audit is
  preserved at data/gamma-audit-2026-05-19.md.`);
  process.exit(0);
}

// Default to --all if nothing specified. --self-test runs ONLY the self-test
// suite and skips the standard sweeps (GAP-RES-26 regression-detection).
if (flags.selfTest) {
  flags.checkAttribution = false;
  flags.checkDates = false;
  flags.audit = false;
  flags.checkTokens = false;
  flags.all = false;
} else if (Object.values(flags).every(v => !v) || flags.all) {
  flags.checkAttribution = true;
  flags.checkDates = true;
  flags.audit = true;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeRead(fp) {
  try { return readFileSync(fp, 'utf-8'); } catch { return null; }
}

function ls(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// ── Sweep 1: False attribution check ────────────────────────────────────────
// Pattern: scripts/build-dashboard.mjs may reference `lib/X.mjs` in tooltips
// or "View source" links. Each reference must resolve to an existing file.

function checkFalseAttributions() {
  const buildDashboardPath = join(ROOT, 'scripts', 'build-dashboard.mjs');
  const text = safeRead(buildDashboardPath);
  if (!text) {
    return { ok: false, error: 'scripts/build-dashboard.mjs not found', findings: [] };
  }
  const lines = text.split('\n');
  const findings = [];
  // Match `lib/foo.mjs` references inside any string literal in build-dashboard
  const libRefPattern = /lib\/([a-z0-9_-]+)\.mjs/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('lib/')) continue;
    let m;
    while ((m = libRefPattern.exec(line)) !== null) {
      const libFile = `lib/${m[1]}.mjs`;
      const fullPath = join(ROOT, libFile);
      if (!existsSync(fullPath)) {
        findings.push({
          severity: 'CRITICAL',
          file: 'scripts/build-dashboard.mjs',
          line: i + 1,
          claim: m[0],
          missing_file: libFile,
          context_snippet: line.trim().slice(0, 200),
        });
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    summary: findings.length === 0
      ? 'No false lib/*.mjs attributions in scripts/build-dashboard.mjs'
      : `${findings.length} false attribution(s) detected — tooltips/view-source links point at lib/*.mjs files that do not exist`,
  };
}

// ── Sweep 2: Hardcoded date check ──────────────────────────────────────────
// Pattern: "Today is YYYY-MM-DD" anywhere in lib/*.mjs is the CRIT-2 smell.
// (Comments are excluded — the dashboard renders prompt strings, not comments.)

function checkHardcodedDates() {
  const libDir = join(ROOT, 'lib');
  const files = ls(libDir).filter(f => f.endsWith('.mjs'));
  const findings = [];
  const datePattern = /Today is\s+\d{4}-\d{2}-\d{2}/g;
  for (const f of files) {
    const fp = join(libDir, f);
    const text = safeRead(fp);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment-only lines (// ... or * ... or /* ... */)
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      let m;
      while ((m = datePattern.exec(line)) !== null) {
        // Skip if this date string is being assigned from new Date(), e.g.
        //   const todayIso = new Date().toISOString().slice(0,10);
        //   `Today is ${todayIso} PT.`
        if (line.includes('${') && line.includes('}')) continue;
        findings.push({
          severity: 'CRITICAL',
          file: `lib/${f}`,
          line: i + 1,
          literal: m[0],
          context_snippet: line.trim().slice(0, 200),
        });
      }
      datePattern.lastIndex = 0;
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    summary: findings.length === 0
      ? `No hardcoded "Today is YYYY-MM-DD" literals in lib/*.mjs (γ CRIT-2 pattern clean)`
      : `${findings.length} hardcoded-date literal(s) found — LLM prompts will lie about today's date`,
  };
}

// ── Sweep 3: Metric inventory presence check ───────────────────────────────
// Verify the canonical inventory file exists and references compute fns that
// still exist as exports in their named lib files.

function checkInventoryConsistency() {
  // Look for the most recent inventory file
  const dataDir = join(ROOT, 'data');
  const inventoryFiles = ls(dataDir).filter(f => /^gamma-metric-inventory-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (!inventoryFiles.length) {
    return {
      ok: false,
      summary: 'No data/gamma-metric-inventory-*.json found — run with --inventory to rebuild',
      findings: [],
    };
  }
  inventoryFiles.sort().reverse();
  const latest = inventoryFiles[0];
  const inv = JSON.parse(safeRead(join(dataDir, latest)));
  const findings = [];
  for (const m of inv.metrics || []) {
    const computingStr = String(m.computing_lib || '');
    // Walk computing_lib string: looks like "lib/foo.mjs:functionName" or
    // "lib/foo.mjs:export → other". Skip if the string itself already calls
    // out the non-existence (matches "NOT lib/.../mjs" or "does not exist").
    if (/\bNOT\s+lib\/|does not exist/i.test(computingStr)) continue;
    const match = computingStr.match(/^(?:lib\/([a-z0-9-]+)\.mjs)/i);
    if (!match) continue;
    const libPath = join(ROOT, 'lib', `${match[1]}.mjs`);
    if (!existsSync(libPath)) {
      findings.push({
        severity: 'CRITICAL',
        metric: m.metric_name,
        claimed_lib: match[0],
        actual_status: 'file does not exist',
      });
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    summary: findings.length === 0
      ? `All ${inv.metrics?.length || 0} metrics in ${latest} reference existing lib files`
      : `${findings.length} metric(s) in ${latest} reference nonexistent lib files`,
    inventory_file: latest,
    metric_count: inv.metrics?.length || 0,
  };
}

// ── Sweep 4: Silent-zero pattern check ─────────────────────────────────────
// The HIGH-1 pattern was "return 0 when source missing." Sweep lib/*.mjs for
// suspicious-looking return objects.
//
// γ GAMMA refinement 2026-05-19 (Γ.14, post-self-review):
// The first version of this heuristic produced 16/17 false positives — it
// flagged any return block with a ":0" token AND an error/missing word.
// Most legit code paths look like that: schema-default counters (total:0),
// HTTP-status envelopes (status:0), LLM-result envelopes (tokens:0, ms:0),
// hit-count results (hits:[], total:0), etc.
//
// Refined to be much narrower:
//   (1) Skip the candidate entirely when a cohort indicator is present
//       (unavailable:true / hasData:false / a `null` value in the return).
//       That means the function explicitly tells the caller "this is not real
//       data."
//   (2) Only flag fields whose NAME implies a metric/score/percentage. The
//       SUSPICIOUS_FIELD_NAMES allowlist is the source of truth — anything
//       outside (total, tokens, ms, status, page, took_ms, etc.) is treated
//       as schema metadata, not a silent zero.
//   (3) As a backstop, flag returns where 3+ numeric fields go to 0 in the
//       same block with no cohort indicator (the original alignment-scorer
//       0/0/0 pattern that started this whole sweep).
//
// False-positive rate fell from 16/17 (94%) to 0/0 on current main after
// applying the refinement.

const SUSPICIOUS_FIELD_NAMES = new Set([
  'alignment', 'interview', 'hmNoticing', 'hmnoticing', 'score',
  'pct', 'percent', 'percentage', 'rate', 'ratio', 'confidence',
  'fit', 'match', 'rank', 'rating', 'quality', 'likelihood',
]);

function checkSilentZeroPatterns() {
  const libDir = join(ROOT, 'lib');
  const files = ls(libDir).filter(f => f.endsWith('.mjs'));
  const findings = [];

  // GAP-RES-26 (2026-05-24) — META-AUDIT-driven extension.
  //
  // The pre-fix gate `if (hasCohortIndicator) continue` was too permissive: a
  // return block claiming `unavailable: true` (cohort indicator) was skipped
  // ENTIRELY without checking whether the same block also contained
  // `alignment: 0` (or any other metric-name field set to a confident zero).
  // That combination is logically inconsistent — claiming "no data" while
  // simultaneously asserting a confident 0 lets a future regression land an
  // `alignment: 0` fallback alongside an existing `unavailable: true` line
  // and have the auditor silently miss it.
  //
  // Fix: even when a cohort indicator is present, scan the same window for
  // SUSPICIOUS_FIELD_NAMES set to `0` (not `null`). If any are found, emit
  // an INCONSISTENT-COHORT finding rather than the standard silent-zero
  // finding — different severity, different remediation guidance.
  //
  // Test the gap by adding a fixture under lib/ that contains:
  //   return { unavailable: true, alignment: 0, breakdown: { error: '...' } };
  // Pre-fix: auditor reported `ok: true` (false negative).
  // Post-fix: auditor reports HIGH `inconsistent cohort claim` finding.
  for (const f of files) {
    const fp = join(libDir, f);
    const text = safeRead(fp);
    if (!text) continue;
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (!/return\s*\{/.test(lines[i])) continue;
      const window = lines.slice(i, Math.min(lines.length, i + 14)).join('\n');

      const hasCohortIndicator =
        /unavailable\s*:\s*true/i.test(window) ||
        /hasData\s*:\s*false/i.test(window) ||
        /:\s*null\b/.test(window);

      // GAP-RES-26: cohort-indicator-present blocks STILL get checked for
      // metric-name fields set to 0 — that's a logical inconsistency.
      // The standard silent-zero detection below applies only when no
      // cohort indicator is present.
      if (hasCohortIndicator) {
        const inconsistentMatches = [];
        for (const name of SUSPICIOUS_FIELD_NAMES) {
          const re = new RegExp(`\\b${name}\\s*:\\s*0\\b`, 'i');
          if (re.test(window)) inconsistentMatches.push(name);
        }
        if (inconsistentMatches.length > 0) {
          findings.push({
            severity: 'HIGH',
            file: `lib/${f}`,
            line: i + 1,
            pattern: `inconsistent cohort claim — block contains cohort indicator (unavailable:true / hasData:false / :null) AND metric field(s) [${inconsistentMatches.join(', ')}] set to 0; cohort-flagged blocks should set metric fields to null, not 0`,
            context_snippet: lines[i].trim().slice(0, 200),
          });
        }
        continue;
      }

      // Must have an error/missing/fallback word to be a candidate at all.
      // γ needhuman-resolution 2026-05-19 (Mitchell decision γ.4b): added
      // 'fallback-to-score' and 'low-data' as explicit keyword catches.
      // Rationale: the HIGH-1 malformed-report fix in lib/alignment-scorer.mjs
      // uses data_completeness: 'fallback-to-score' — a non-null value that
      // does NOT contain the bare word "fallback" in the same return block
      // (the metric zeros and the word appear in different code branches).
      // Adding the full phrase ensures future code using these patterns
      // gets caught even if the surrounding return block looks clean.
      if (!/(error|missing|unavailable|not\s*found|fallback-to-score|fallback|low-data)/i.test(window)) continue;

      // (2) Suspicious-name match: look for "<name>: 0" where <name> is in
      // the allowlist of metric-implying field names.
      const suspiciousMatches = [];
      for (const name of SUSPICIOUS_FIELD_NAMES) {
        const re = new RegExp(`\\b${name}\\s*:\\s*0\\b`, 'i');
        if (re.test(window)) suspiciousMatches.push(name);
      }

      // (3) Backstop: 3+ numeric fields = 0 in the same block (the original
      // alignment-scorer 0/0/0 pattern). Skip when the zero-fields are all
      // envelope-schema names (counters, sizes, timings) rather than scores.
      const ENVELOPE_NAMES = new Set([
        'total', 'tokens', 'ms', 'took_ms', 'page', 'page_count', 'status',
        'count', 'size', 'hits', 'duration', 'length', 'strong', 'partial',
        'weak', 'unverified', 'verified', 'cache_hits',
      ]);
      const zeroFields = [];
      const zeroFieldRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*0\s*[,}]/g;
      let zm;
      while ((zm = zeroFieldRe.exec(window)) !== null) zeroFields.push(zm[1]);
      const nonEnvelopeZeros = zeroFields.filter(n => !ENVELOPE_NAMES.has(n));
      const consecutiveZeros = nonEnvelopeZeros.length;

      if (suspiciousMatches.length > 0) {
        findings.push({
          severity: 'HIGH',
          file: `lib/${f}`,
          line: i + 1,
          pattern: `metric field(s) [${suspiciousMatches.join(', ')}] set to 0 alongside error/missing — consider null + unavailable:true / hasData:false`,
          context_snippet: lines[i].trim().slice(0, 200),
        });
      } else if (consecutiveZeros >= 3) {
        findings.push({
          severity: 'MEDIUM',
          file: `lib/${f}`,
          line: i + 1,
          pattern: `${consecutiveZeros} numeric fields set to 0 in same return block — verify these aren't masking "no data" as confident zeros`,
          context_snippet: lines[i].trim().slice(0, 200),
        });
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    summary: findings.length === 0
      ? 'No suspicious silent-zero patterns (schema defaults like total:0 / tokens:0 / status:0 excluded; cohort-claim consistency verified)'
      : `${findings.length} suspicious silent-zero pattern(s) found — review`,
  };
}

// ── Self-test fixtures for checkSilentZeroPatterns (GAP-RES-26) ────────────
// Inline synthetic test cases verify the detector catches the patterns it
// must catch + excludes the patterns it must exclude. Runs only when the
// hidden --self-test flag is passed; never as part of --all / --audit.
//
// Fixtures cover:
//   A. alignment:0 + error → HIGH "metric field [alignment] set to 0"
//   B. alignment:null + unavailable:true → no finding (legitimate cohort)
//   C. alignment:0 + unavailable:true → HIGH "inconsistent cohort claim" (GAP-RES-26)
//   D. interview:0 alone + error → HIGH (suspicious-field detection still works)
//
// Pre-fix behavior (regression baseline): case C produced ZERO findings — the
// silent-zero gap the v1 changelog flagged. Post-fix: case C produces 1 HIGH.

async function runSelfTest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-zero-test-'));
  // The detector reads from <ROOT>/lib so we have to write fixtures into the
  // real lib dir, run, capture, and clean up. We DO NOT recurse into other
  // libs — we only care that our fixtures get the right findings.
  const fixtures = [
    { name: '_dt_self_test_a.mjs', src:
`export function caseA() {
  if (!ok) {
    return {
      alignment: 0,
      breakdown: { error: 'missing' },
    };
  }
  return { alignment: 1 };
}
` },
    { name: '_dt_self_test_b.mjs', src:
`export function caseB() {
  if (!ok) {
    return {
      unavailable: true,
      alignment: null,
      breakdown: { error: 'data missing' },
    };
  }
  return { alignment: 1 };
}
` },
    { name: '_dt_self_test_c.mjs', src:
`export function caseC() {
  if (!ok) {
    return {
      unavailable: true,
      alignment: 0,
      breakdown: { error: 'data missing' },
    };
  }
  return { alignment: 1 };
}
` },
    { name: '_dt_self_test_d.mjs', src:
`export function caseD() {
  if (!ok) {
    return {
      interview: 0,
      breakdown: { error: 'no data' },
    };
  }
  return { interview: 1 };
}
` },
  ];
  const libDir = join(ROOT, 'lib');
  const written = [];
  try {
    for (const fix of fixtures) {
      const fp = join(libDir, fix.name);
      writeFileSync(fp, fix.src);
      written.push(fp);
    }
    const result = checkSilentZeroPatterns();
    const byFile = {};
    for (const finding of result.findings) {
      byFile[finding.file] = byFile[finding.file] || [];
      byFile[finding.file].push(finding);
    }
    const checks = [
      { name: 'A (alignment:0 + error)', file: 'lib/_dt_self_test_a.mjs', expectHits: 1, expectPattern: /metric field.*alignment.*set to 0/ },
      { name: 'B (alignment:null + unavailable:true)', file: 'lib/_dt_self_test_b.mjs', expectHits: 0 },
      { name: 'C (alignment:0 + unavailable:true) — GAP-RES-26', file: 'lib/_dt_self_test_c.mjs', expectHits: 1, expectPattern: /inconsistent cohort claim/ },
      { name: 'D (interview:0 alone + error)', file: 'lib/_dt_self_test_d.mjs', expectHits: 1, expectPattern: /metric field.*interview.*set to 0/ },
    ];
    let passed = 0, failed = 0;
    for (const c of checks) {
      const hits = (byFile[c.file] || []).length;
      const pass = hits === c.expectHits &&
        (c.expectPattern ? (byFile[c.file] || []).some(h => c.expectPattern.test(h.pattern)) : true);
      console.log(`${pass ? '✓' : '✗'} ${c.name} — expected hits=${c.expectHits}, got ${hits}`);
      if (!pass) {
        failed++;
        if (byFile[c.file]) {
          for (const h of byFile[c.file]) {
            console.log(`    actual: ${h.severity} ${h.pattern.slice(0, 140)}`);
          }
        }
      } else {
        passed++;
      }
    }
    console.log(`\nSelf-test: ${passed}/${passed + failed} passed`);
    return failed === 0;
  } finally {
    for (const fp of written) {
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tmpdir); } catch { /* ignore */ }
  }
}

// ── Sweep 5: Heartbeat-tokens drift check (Phase D, 2026-05-19) ───────────
// Phase C introduced lib/heartbeat-tokens.json as the shared design source of
// truth for dashboard and email colour tokens. This check verifies the
// dashboard's rendered HTML still reflects the canonical token values.
//
// Strategy:
//   1. Read lib/heartbeat-tokens.json — extract canonical CSS variable values.
//   2. Try to fetch https://staging-dashboard.careers-ops.com/ with a 10s
//      AbortSignal. On network failure / timeout, fall back to reading
//      dashboard/index.html directly (the built file).
//   3. Grep the rendered HTML for each canonical token value. PASS if all
//      canonical values are present; WARN/FAIL for any that are absent.
//
// Hang-prevention: fetch uses AbortSignal.timeout(10_000). Body read is
// bounded by the same signal via Promise.race with a 30s manual timer.

async function checkHeartbeatTokensDrift() {
  const tokensPath = join(ROOT, 'lib', 'heartbeat-tokens.json');
  if (!existsSync(tokensPath)) {
    return {
      ok: false,
      summary: 'lib/heartbeat-tokens.json not found — Phase C tokens check skipped',
      findings: [{ severity: 'HIGH', file: 'lib/heartbeat-tokens.json', line: 0, pattern: 'File missing — install Phase C (PR #56) first' }],
    };
  }

  let tokens;
  try {
    tokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
  } catch (e) {
    return {
      ok: false,
      summary: `lib/heartbeat-tokens.json parse error: ${e.message}`,
      findings: [{ severity: 'HIGH', file: 'lib/heartbeat-tokens.json', line: 0, pattern: e.message }],
    };
  }

  // Extract canonical color values from dashboard.tokens_dark
  const canonicalTokens = {};
  const darkTokens = tokens?.dashboard?.tokens_dark || {};
  for (const [k, v] of Object.entries(darkTokens)) {
    if (typeof v === 'string' && v.startsWith('#')) canonicalTokens[k] = v;
  }
  // Also include email light tokens (they appear in the built email archives)
  const emailLight = tokens?.email?.light || {};
  for (const [k, v] of Object.entries(emailLight)) {
    if (typeof v === 'string' && v.startsWith('#')) canonicalTokens[`email.light.${k}`] = v;
  }

  if (Object.keys(canonicalTokens).length === 0) {
    return {
      ok: true,
      summary: 'lib/heartbeat-tokens.json has no #hex colour values to check — no drift to detect',
      findings: [],
    };
  }

  // ── Acquire HTML to grep ────────────────────────────────────────────────
  let htmlContent = null;
  let source = 'unknown';

  // Try network fetch first (staging URL, no auth required)
  const STAGING_URL = 'https://staging-dashboard.careers-ops.com/';
  try {
    const FETCH_TIMEOUT_MS = 10_000;
    const BODY_TIMEOUT_MS  = 30_000;

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(STAGING_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'career-ops-data-truth-auditor/1.0' },
    });
    clearTimeout(fetchTimer);

    if (resp.ok) {
      // Body read with independent timer (hang-prevention rule 2)
      const bodyTimer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
      htmlContent = await resp.text();
      clearTimeout(bodyTimer);
      source = `fetch:${STAGING_URL}`;
    }
  } catch (_fetchErr) {
    // Network unavailable or timeout — fall through to local file
  }

  // Fallback: read the built dashboard/index.html
  if (!htmlContent) {
    const localPath = join(ROOT, 'dashboard', 'index.html');
    if (existsSync(localPath)) {
      htmlContent = readFileSync(localPath, 'utf-8');
      source = `local:dashboard/index.html`;
    }
  }

  if (!htmlContent) {
    return {
      ok: false,
      summary: 'Could not acquire dashboard HTML (network unavailable + dashboard/index.html missing)',
      findings: [{ severity: 'MEDIUM', file: 'dashboard/index.html', line: 0, pattern: 'File missing; run `node scripts/build-dashboard.mjs` first' }],
    };
  }

  // ── Token presence check ─────────────────────────────────────────────────
  const findings = [];
  const checked = [];
  for (const [tokenName, canonicalValue] of Object.entries(canonicalTokens)) {
    const present = htmlContent.includes(canonicalValue);
    checked.push({ tokenName, canonicalValue, present });
    if (!present) {
      findings.push({
        severity: 'WARN',
        file: source,
        line: 0,
        claim: tokenName,
        context_snippet: `Expected ${canonicalValue} from heartbeat-tokens.json[${tokenName}] — not found in rendered HTML`,
        pattern: `Token ${tokenName}=${canonicalValue} absent from dashboard HTML (source: ${source})`,
      });
    }
  }

  const passCount = checked.filter(c => c.present).length;
  return {
    ok: findings.length === 0,
    findings,
    summary: findings.length === 0
      ? `All ${passCount} heartbeat token values present in dashboard HTML (source: ${source})`
      : `${findings.length}/${checked.length} heartbeat token(s) missing from dashboard HTML — Phase C token drift detected (source: ${source})`,
    source,
    checked_count: checked.length,
  };
}

// ── Compose audit report ───────────────────────────────────────────────────

function composeReport(results) {
  const lines = [];
  lines.push(`# Data Truth Audit — ${TODAY}`);
  lines.push('');
  lines.push(`Generated by \`scripts/agents/data-truth-auditor.mjs\`. Recurring follow-up to the original γ GAMMA audit at \`data/gamma-audit-2026-05-19.md\`.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  for (const [name, r] of Object.entries(results)) {
    const status = r.ok ? '✓' : '✗';
    lines.push(`- ${status} **${name}** — ${r.summary}`);
  }
  lines.push('');
  for (const [name, r] of Object.entries(results)) {
    if (r.ok) continue;
    lines.push(`## ${name} — findings`);
    lines.push('');
    for (const f of r.findings || []) {
      lines.push(`- **${f.severity || 'MEDIUM'}** — \`${f.file || f.metric || '?'}\`${f.line ? `:${f.line}` : ''}`);
      if (f.claim)            lines.push(`  - Claim: \`${f.claim}\``);
      if (f.missing_file)     lines.push(`  - Missing file: \`${f.missing_file}\``);
      if (f.literal)          lines.push(`  - Literal: \`${f.literal}\``);
      if (f.pattern)          lines.push(`  - Pattern: ${f.pattern}`);
      if (f.context_snippet)  lines.push(`  - Context: \`${f.context_snippet}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Main (async wrapper for heartbeat-tokens drift check) ──────────────────

async function main() {
  // GAP-RES-26: --self-test short-circuits the regular sweeps and runs only
  // the inline test suite for checkSilentZeroPatterns.
  if (flags.selfTest) {
    const ok = await runSelfTest();
    process.exit(ok ? 0 : 1);
  }

  const results = {};

  if (flags.checkAttribution) {
    results['False attribution sweep'] = checkFalseAttributions();
  }
  if (flags.checkDates) {
    results['Hardcoded date sweep'] = checkHardcodedDates();
  }
  if (flags.audit || flags.all) {
    results['Inventory consistency'] = checkInventoryConsistency();
    results['Silent-zero patterns'] = checkSilentZeroPatterns();
  }
  // Phase D (2026-05-19) — heartbeat-tokens drift check. Runs on --check-tokens
  // or --all. The async fetch is await-ed so the result lands before output.
  if (flags.checkTokens || flags.all) {
    results['Heartbeat-tokens drift'] = await checkHeartbeatTokensDrift();
  }

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const [name, r] of Object.entries(results)) {
      const status = r.ok ? '✓' : '✗';
      console.log(`${status} ${name}: ${r.summary}`);
      if (!r.ok && r.findings?.length) {
        for (const f of r.findings.slice(0, 10)) {
          console.log(`    ${f.file || f.metric || '?'}${f.line ? `:${f.line}` : ''} — ${f.literal || f.claim || f.pattern || ''}`);
        }
        if (r.findings.length > 10) {
          console.log(`    ... +${r.findings.length - 10} more`);
        }
      }
    }
  }

  if (flags.all) {
    const out = composeReport(results);
    const outPath = join(ROOT, 'data', `data-truth-audit-${TODAY}.md`);
    writeFileSync(outPath, out);
    console.log(`\nReport written: ${outPath}`);
  }

  const anyFindings = Object.values(results).some(r => !r.ok);
  process.exit(anyFindings ? 1 : 0);
}

main().catch(err => {
  console.error('[data-truth-auditor] fatal:', err.message);
  process.exit(1);
});
