#!/usr/bin/env node
/**
 * scrub-continuity-legacy-debt.mjs — tree-wide deterministic sweep of the
 * legacy comms-triage continuity + achieved-framing debt (2026-07-07).
 *
 * The 2026-07-06 resume-mirror work (resume-mirror-spec § Exclusions + memory
 * project_xge_comms_triage_agent_provenance) established that the comms-triage
 * agent NEVER ran during Mitchell's extended leave and that ~60% auto-handled /
 * ~160 hrs/yr are DESIGN TARGETS, not measured outcomes. Fresh builds are
 * blocked at the tollbooth (lib/grounding-guard.mjs CONTINUITY_CLAIM_PATTERNS
 * + findTriageFramingViolations); this sweep retires the LEGACY tree debt:
 *   - continuity claims ("100% operational continuity", "ran through a
 *     multi-month extended leave", "the team relied on it in my absence",
 *     "zero degradation") → honest framing ("documented end-to-end and handed
 *     off with a full operator runbook")
 *   - achieved-framing triage metrics ("auto-handled ~60%", "recaptured ~160
 *     hours") → design-target framing ("designed to auto-handle ~60% (est.)")
 *   - "(~55% Low-Touch)" parenthetical + all other retired metrics via the
 *     canonical scripts/scrub-fabrications.mjs (single source of rewrite rules)
 *
 * What it does, per file under apply-pack/ + data/interview-likelihood/ +
 * data/hm-chance/:
 *   1. Applies the continuity/achieved-framing RULES below (ordered, clause-
 *      level, grammar-reviewed against the 2026-07-07 census of live shapes).
 *   2. Pipes changed-or-flagged files through scripts/scrub-fabrications.mjs
 *      (Low-Touch parenthetical delete + retired-metric canon).
 *   3. Re-verifies every file with the EXACT guard detectors
 *      (CONTINUITY_CLAIM_PATTERNS + findTriageFramingViolations + PAT/EXCL)
 *      and reports survivors for hand-fixing — never silently mangles.
 *
 * Exclusions (never touched), per standing policy + the model script
 * scripts/scrub-apply-pack-grounding-debt.mjs:
 *   - record packs: 049-perplexity-* (submitted), 2723-anthropic-* (rejected
 *     record) — immutable application history
 *   - google-* packs (internal-audience language is intentional there)
 *   - dot-dirs (.archive/, .embackup-*, .sweep-backups-*)
 *   - *ai-detection* sidecars (QA telemetry quotes flagged phrases by design)
 *
 * Usage:
 *   node scripts/scrub-continuity-legacy-debt.mjs            # dry-run census
 *   node scripts/scrub-continuity-legacy-debt.mjs --apply    # rewrite in place
 *
 * Everything swept is gitignored personal data — this script edits artifacts
 * on disk and never touches git. Backups of every changed file land in
 * data/scrub-backups-2026-07-07-continuity/ (gitignored via data/).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CONTINUITY_CLAIM_PATTERNS, findTriageFramingViolations, TRIAGE_METRIC_RE, TARGET_FRAMING_RE } from '../lib/grounding-guard.mjs';
import { PAT, EXCL } from '../lib/retired-metric-pattern.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const SCRUBBER = join(ROOT, 'scripts', 'scrub-fabrications.mjs');
const BACKUP = join(ROOT, 'data', 'scrub-backups-2026-07-07-continuity');

const SCAN_ROOTS = ['apply-pack', 'data/interview-likelihood', 'data/hm-chance'];

const EXCLUDE_DIR = (d) =>
  d.startsWith('.') ||
  d.startsWith('049-perplexity') ||
  d.startsWith('2723-anthropic') ||
  /google/i.test(d);

const EXCLUDE_FILE = (f) => f.includes('ai-detection');

// ── continuity + achieved-framing rewrite rules (ordered) ────────────────────
// Canonical honest framing (cv.md 2026-07-06 fix): "documented end-to-end and
// handed off with a full operator runbook; designed to auto-handle ~60% of
// inbound (est.)". Each rule is grammar-safe for the census shapes it covers;
// anything novel fails loud in the verify pass and gets hand-fixed.
const HONEST_HANDOFF = 'documented end-to-end and handed off with a full operator runbook';
const RULES = [
  // ── full-clause continuity shapes (longest / most specific first) ──────────
  // "Documented and handed off so it kept running (on intake) through a
  // multi-month extended leave(: the team relied on it in my absence)"
  [/Documented and handed off so it kept running(?: on intake)? through a multi-month extended leave(?::? the team relied on it in (?:my|his) absence)?/gi,
    HONEST_HANDOFF],
  // "; documented (and )handed off (so it )kept it/it running through a multi-month extended leave"
  [/;?\s*documented(?: and)? hand(?:off|ed off)(?: so it)? kept (?:it )?running(?: on intake)? through a multi-month extended leave/gi,
    `; ${HONEST_HANDOFF}`],
  // standalone "(It) kept running on intake through a multi-month extended leave"
  [/\b(?:it|the (?:agent|system)) kept running(?: on intake)? through a multi-month extended leave\b/gi,
    `it was ${HONEST_HANDOFF}`],
  [/\bKept running(?: on intake)? through a multi-month extended leave\b/g,
    `Documented end-to-end and handed off with a full operator runbook`],
  [/\bkept running(?: on intake)? through a multi-month extended leave\b/gi,
    `was ${HONEST_HANDOFF}`],
  // "kept operating autonomously through a multi-month extended leave"
  [/,? and kept operating autonomously through a multi-month extended leave/gi,
    `, and was ${HONEST_HANDOFF}`],
  [/\bkept operating autonomously through a multi-month extended leave\b/gi,
    `was ${HONEST_HANDOFF}`],
  // "ran (autonomously / in production / unattended / without Mitchell) through|during|for
  // (a) (multi-month) (medical) leave (with/without <trailing qualifier>)"
  [/\b[Rr]an(?: autonomously| in production| independently| unattended| without human escalation)?(?: without (?:Mitchell|me|its builder)(?: present)?)? (?:through|during|for) (?:a )?(?:multi-month )?(?:medical )?leave(?: with(?:out)? [^,.;)\]"]{0,60})?/g,
    `was ${HONEST_HANDOFF}`],
  [/\brunning(?: autonomously| in production| unattended)? (?:through|during) (?:a )?(?:multi-month )?(?:medical )?leave\b/gi,
    `${HONEST_HANDOFF}`],
  // "system ran autonomously through a multi-month extended leave"
  [/;?\s*(?:the )?system ran autonomously through a multi-month extended leave/gi,
    `; the system was ${HONEST_HANDOFF}`],
  // "handled intake through a multi-month extended leave while the team depended on it"
  [/\bhandled intake through a multi-month extended leave(?: while the team depended on it)?/gi,
    `was ${HONEST_HANDOFF}`],
  // "sustained operational continuity through a multi-month extended leave"
  [/\bsustained operational continuity through a multi-month (?:extended leave|absence)\b/gi,
    `was ${HONEST_HANDOFF}`],
  // "operational continuity through (a multi-month) extended leave/absence"
  [/\b(?:100% )?operational continuity through (?:a multi-month )?(?:extended leave|absence)\b/gi,
    'a documented operator-runbook handoff'],
  // "maintained 100% operational continuity through/during a multi-month extended leave (without ...)"
  [/\bmaintained 100% operational continuity (?:through|during) a multi-month (?:extended leave|absence)(?: without [^,.;)\]]{0,60})?/gi,
    `were ${HONEST_HANDOFF}`],
  // table cells / terse forms
  [/\bMaintain 100% operational continuity on\b/g, 'Document and hand off'],
  [/\bMaintain operational continuity\b/g, 'Document and hand off the triage system'],
  [/\b100% operational continuity (?:sustained|maintained)(?: through return)?/gi,
    'Full operator-runbook handoff completed'],
  [/\b100% operational continuity\b/gi, 'a full operator-runbook handoff'],
  // "the team relied on it in my/his absence" (standalone survivor)
  [/[;:,]?\s*(?:and )?[Tt]he team relied on it (?:in|through) (?:my|his) absence/g, ''],
  [/[;:,]?\s*(?:and )?[Tt]he team relied on it through a multi-month extended leave/g, ''],
  [/\brelied on (?:it|the agent) in (?:my|his) absence\b/gi, 'received it with a full operator runbook'],
  // "when he went on extended leave, the team relied on it in his absence, which ..."
  [/;?\s*when he went on extended leave, the team relied on it in his absence(,? which [^.;]{0,80})?/gi, ''],
  // "zero degradation ..." continuity variants
  [/\bran independently with zero degradation in classification accuracy\b/gi,
    `was ${HONEST_HANDOFF}`],
  [/[,;]?\s*with zero degradation in (?:classification(?: accuracy)?|accuracy)\b/gi, ''],
  [/\bzero degradation in (?:classification(?: accuracy)?|accuracy)\b/gi, 'a full operator-runbook handoff'],
  // "(operational) continuity through/during extended leave" residue (prose refs)
  [/\b(?:and )?operational continuity through extended leave\b/gi, 'operator-runbook handoff discipline'],

  // exact low-count shape: "and it did: it handled intake through ... while the team depended on it"
  [/,? and it did: it handled intake through a multi-month extended leave(?: while the team depended on it)?/gi,
    `: ${HONEST_HANDOFF}`],
  // verbs OUTSIDE the guard's alternation (2026-07-07 residual census): "continued
  // operating / kept handling intake / remained live / staying live / keeping intake
  // operational ... through a multi-month extended leave (qualifiers)"
  [/\b(?:continued|continuing|kept|keeping|remained|remaining|stayed|staying)\s+[^.!?\n]{0,40}?through a multi-month extended leave(?: handoff)?(?: with(?:out)? [^,.;)\]"]{0,60})?(?:[,;]? while (?:the team|I) [^,.;)\]"]{0,40})?/gi,
    `was ${HONEST_HANDOFF}`],
  // "the team relied on it (autonomously) through a multi-month extended leave"
  [/\b[Tt]he team relied on it(?: autonomously)? through a multi-month extended leave/g,
    'the team received it with a full operator runbook'],
  // "and it did(,)? through a multi-month extended leave" / ", and it did." residue
  [/,? and it did[,:]? (?:keeping [^.!?\n]{0,40}?)?through a multi-month extended leave(?: while the team relied on it)?/gi,
    `: ${HONEST_HANDOFF}`],
  [/\bit did through a multi-month extended leave\b/gi,
    'it was handed off with a full operator runbook'],

  // ── achieved-framing → design-target framing ──────────────────────────────
  // ORDER MATTERS: number-after-verb forms first (they consume the verb), then
  // number-before-verb compact forms, then generic passives, then hours family.
  // participle: "auto-handling ~60% of inbound/incoming ..."
  [/\bauto-handling (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'designed to auto-handle $1'],
  // active past/present: "auto-handled/auto-handles ~60% ..."
  [/\bauto-handled (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'designed to auto-handle $1'],
  [/\bauto-handles (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'is designed to auto-handle $1'],
  // relative-clause + agentive: "that/which auto-handled X" (no number after verb)
  [/\b(?:that|which) auto-handled\b/gi, 'designed to auto-handle'],
  // passive-by: "requests auto-handled by <agent>"
  [/\bauto-handled by\b/gi, 'targeted for auto-handling (design target) by'],
  // rate forms: "~60% auto-handle/auto-handling rate"
  [/(~?\s*60%) auto-handl(?:e|ing) rate\b/gi, '$1 auto-handle design target'],
  // compact stat forms (number right before): "~60% auto-handled" / "(~60% auto-handling, ..."
  [/(~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent)) auto-handl(?:ed|ing)\b/gi, '$1 auto-handle design target'],
  // passive with an intervening noun phrase: "~60% of inbound requests auto-handled"
  [/(~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent)[^,.;:()\n]{0,40}?)\s+auto-handled\b/gi,
    '$1 targeted for auto-handling (design target)'],
  // "handling/handles/handled roughly 60 percent of inbound/comms ..."
  [/\bhandling (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'designed to handle $1'],
  [/\bhandles (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'is designed to handle $1'],
  [/\bhandled (~?\s*(?:roughly |about |approximately )?60\s*(?:%|percent))/gi, 'designed to handle $1'],
  // bare stat tokens: "(~60% auto-handle)" / "~60% inbound handling" / "60% auto-triage"
  [/(~?\s*60%)\s+auto-handle\b(?!\s+design)/gi, '$1 auto-handle design target'],
  [/(~?\s*60%)\s+inbound handling\b/gi, '$1 inbound auto-handle design target'],
  [/(~?\s*60%)\s+auto-(?:triage|resolution)\b/gi, '$1 auto-triage design target'],
  // hours family: "recaptures/recaptured/recapturing/recovered ~160 (operational) hours"
  [/\brecaptures (?:~\s*|about |roughly |an estimated )?160 (operational )?(hours|hrs)/gi, 'is projected to recapture ~160 $1$2'],
  [/\brecaptur(?:ed|ing) (?:~\s*|about |roughly |an estimated )?160 (operational )?(hours|hrs)/gi, 'projected to recapture ~160 $1$2'],
  [/\brecovers (?:~\s*|about |roughly |an estimated )?160 (operational )?(hours|hrs)/gi, 'is projected to recover ~160 $1$2'],
  [/\brecover(?:ed|ing) (?:~\s*|about |roughly |an estimated )?160 (operational )?(hours|hrs)/gi, 'projected to recover ~160 $1$2'],
  // reverse order: "~160 hrs/year recaptured" / "... saved"
  [/(~?\s*160\s+(?:operational\s+)?(?:hours|hrs)(?:\/(?:year|yr)|\s+per\s+year|\s+annually|\s+a\s+year)?)\s+(?:recaptured|saved)\b/gi,
    '$1 projected'],
  // bare parenthetical: "(~160 hrs/year)"
  [/\((~\s*160\s+(?:operational\s+)?(?:hrs|hours)(?:\/(?:year|yr))?)\)/g, '($1 design target)'],
];

// ── fallback pass A: generic continuity-span replacement ─────────────────────
// After the named RULES, any continuity claim still standing gets its guard-
// matched span replaced generically. Grammar is approximate (spans start at
// the claim verb/noun), but the claim itself is FALSE — removing it beats
// preserving fluent fabrication. Keyed to CONTINUITY_CLAIM_PATTERNS order.
const CONTINUITY_FALLBACK = [
  'a full operator-runbook handoff',                       // 100% operational continuity
  'a complete, documented handoff',                        // zero degradation …
  'received it with a full operator runbook',              // relied on it … absence
  `was ${HONEST_HANDOFF}`,                                 // ran … through … leave
  'leave, with the system fully documented and handed off',// leave … continuity
  '',                                                      // ~55% Low-Touch (bare form; separators cleaned below)
];
function applyContinuityFallback(body) {
  CONTINUITY_CLAIM_PATTERNS.forEach(({ re }, i) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    body = body.replace(g, CONTINUITY_FALLBACK[i]);
  });
  // clean dangling separators left by the Low-Touch bare-form deletion
  return body.replace(/\(\s*[;,]\s*/g, '(').replace(/\s*[;,]\s*\)/g, ')').replace(/;\s*;/g, ';');
}

// ── fallback pass B: sentence-aware design-target injection ──────────────────
// Any sentence still failing findTriageFramingViolations gets " (design
// target)" injected directly after its metric token — the minimal honest patch
// that satisfies the guard's target-framing requirement. Runs per line, so
// JSON string values stay intact.
// TRIAGE_METRIC_RE + TARGET_FRAMING_RE are imported from lib/grounding-guard.mjs
// (2026-07-07 review finding #6: this file previously hand-mirrored both as
// *_LOCAL consts because TARGET_FRAMING_RE was unexported — a silent-drift
// risk where the sweep's fallback and the tollbooth stop agreeing on the next
// pattern edit).
const HOURS_RE = /(~?\s*160\s+(?:operational\s+)?(?:hours|hrs)(?:\/(?:year|yr))?)/i;
function applyFramingFallback(body) {
  return body.split('\n').map(line => {
    if (!TRIAGE_METRIC_RE.test(line)) return line;
    return line.split(/(?<=[.!?])\s+/).map(s => {
      if (!TRIAGE_METRIC_RE.test(s) || TARGET_FRAMING_RE.test(s)) return s;
      if (/auto-handl/i.test(s)) return s.replace(/(auto-handl\w*)/i, '$1 (design target)');
      if (HOURS_RE.test(s)) return s.replace(HOURS_RE, '$1 (design target)');
      return s.replace(TRIAGE_METRIC_RE, '$& (design target)');
    }).join(' ');
  }).join('\n');
}

// ── file enumeration ─────────────────────────────────────────────────────────
function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (/\.(md|json)$/.test(e.name) && !EXCLUDE_FILE(e.name)) {
      out.push(join(dir, e.name));
    }
  }
}

const files = [];
for (const r of SCAN_ROOTS) walk(join(ROOT, r), files);

// ── detector helpers (byte-identical to the guards + the broad census grep) ──
// BROAD_CENSUS mirrors the standing census command from memory
// (grep -rli "operational continuity|relied on it in|zero degradation|through
// a multi-month medical") — wider than the guard patterns, so the sweep's
// zero matches the census's zero.
const BROAD_CENSUS = [
  { re: /\boperational continuity\b/i, label: 'census: operational continuity' },
  { re: /\brelied on it in\b/i, label: 'census: relied on it in' },
  { re: /\bzero degradation\b/i, label: 'census: zero degradation' },
  { re: /\bthrough a multi-month medical\b/i, label: 'census: through a multi-month medical' },
];
const patRe = new RegExp(PAT, 'i');
const exclRe = new RegExp(EXCL, 'i');
function violations(body) {
  const v = [];
  for (const { re, label } of CONTINUITY_CLAIM_PATTERNS) {
    const m = body.match(re);
    if (m) v.push({ kind: 'continuity', label, excerpt: m[0].slice(0, 120) });
  }
  for (const { re, label } of BROAD_CENSUS) {
    const m = body.match(re);
    if (m) {
      const i = body.search(re);
      v.push({ kind: 'continuity', label, excerpt: body.slice(Math.max(0, i - 60), i + 80).replace(/\n/g, ' ').trim() });
    }
  }
  for (const t of findTriageFramingViolations(body)) v.push({ kind: t.kind, label: t.label, excerpt: t.excerpt });
  for (const line of body.split('\n')) {
    if (patRe.test(line) && !exclRe.test(line)) { v.push({ kind: 'PAT', label: 'retired-metric PAT hit', excerpt: line.trim().slice(0, 120) }); break; }
  }
  return v;
}

// ── pass 0: census ───────────────────────────────────────────────────────────
const flagged = [];
for (const p of files) {
  let body; try { body = readFileSync(p, 'utf8'); } catch { continue; }
  const v = violations(body);
  if (v.length) flagged.push({ p, v });
}
const tally = {};
for (const f of flagged) for (const v of f.v) tally[v.kind] = (tally[v.kind] || 0) + 1;
console.log(`scan scope: ${files.length} files · flagged: ${flagged.length} file(s)${APPLY ? '' : '  [DRY-RUN]'}`);
console.log(`violation tally by kind: ${JSON.stringify(tally)}`);
if (!APPLY) {
  // dry-run: show per-kind unique excerpts so novel shapes are visible pre-apply
  const seen = new Set();
  for (const f of flagged) for (const v of f.v) {
    const key = `${v.kind}|${v.excerpt}`;
    if (seen.has(key)) continue; seen.add(key);
  }
  console.log(`unique violation excerpts: ${seen.size} (rerun with --apply to fix)`);
  process.exit(flagged.length ? 1 : 0);
}

// ── pass 1: continuity/achieved-framing rules ────────────────────────────────
if (!existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });
let ruleHits = 0, filesChanged = 0;
for (const { p } of flagged) {
  let body = readFileSync(p, 'utf8');
  const orig = body;
  for (const [re, to] of RULES) body = body.replace(re, to);
  body = applyContinuityFallback(body);
  body = applyFramingFallback(body);
  if (body !== orig) {
    // preserve the FIRST backup across re-runs — it holds the true pre-sweep state
    const bak = join(BACKUP, p.replace(ROOT + '/', '').replace(/[\/ ]/g, '__') + '.bak');
    if (!existsSync(bak)) copyFileSync(p, bak);
    writeFileSync(p, body);
    filesChanged++; ruleHits++;
  }
}
console.log(`pass 1 (continuity/framing rules): rewrote ${filesChanged} file(s)`);

// ── pass 2: canonical scrubber (Low-Touch parenthetical + retired metrics) ───
const CHUNK = 150;
const targets = flagged.map(f => f.p);
for (let i = 0; i < targets.length; i += CHUNK) {
  const chunk = targets.slice(i, i + CHUNK);
  try {
    execFileSync(process.execPath, [SCRUBBER, ...chunk], { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 });
  } catch (err) {
    if (typeof err.status !== 'number') throw err; // exit 1 = survivors (verified below); real spawn faults rethrow
  }
}
console.log(`pass 2 (scrub-fabrications canon): done over ${targets.length} file(s)`);

// ── pass 3: fail-loud re-verify with the exact guard detectors ───────────────
const survivors = [];
for (const p of targets) {
  let body; try { body = readFileSync(p, 'utf8'); } catch { survivors.push({ p, v: [{ kind: 'verify-failed', label: 'unreadable post-scrub', excerpt: '' }] }); continue; }
  const v = violations(body);
  if (v.length) survivors.push({ p, v });
}
if (survivors.length) {
  console.log(`\n🔴 ${survivors.length} file(s) carry novel shapes the rules cannot safely rewrite — HAND-FIX:`);
  for (const s of survivors) {
    console.log(`   ${s.p.replace(ROOT + '/', '')}`);
    for (const v of s.v) console.log(`      [${v.kind}] ${v.excerpt}`);
  }
  process.exit(1);
}
console.log('✅ verifier-clean across the swept tree (continuity + framing + PAT)');
process.exit(0);
