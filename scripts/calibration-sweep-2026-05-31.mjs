#!/usr/bin/env node
/**
 * calibration-sweep-2026-05-31.mjs — Post-Process-All apply-readiness calibration.
 *
 * After Process All adds new rows to the apply-now queue, this sweep enforces the
 * full per-row Definition of Done so new rows automatically reach apply-ready —
 * the same bar the three hand-finished rows (#48/#1/#49) cleared on 2026-05-31.
 *
 * Two jobs, both DRY-RUN by default (repo convention: every mutation is
 * dry-run + approval-gated; see AGENTS.md § Recurring audits / corpus-librarian):
 *
 *   1. AUTO-DISCARD — flag off-positioning high-scorers (pure IC Software
 *      Engineering, pure Program/Product Manager) that slipped past the
 *      comp-floor + hard-disqualifier gates. Keeps the queue ruthlessly focused
 *      on the locked positioning (Applied-AI builder / Enablement / Comms).
 *      A whitelist of on-positioning role tokens guards against false discards.
 *
 *   2. DoD SWEEP — for every live (non-discarded) row, shell out to
 *      verify-dashboard-real-2026-05-31.mjs (the single source of truth for what
 *      "apply-ready" means) and turn each gap into a concrete fix command.
 *      Gaps with a confirmed generator interface are dispatched in --apply mode;
 *      gaps without one are printed as manual commands (never guessed-and-fired).
 *
 * Usage:
 *   node scripts/calibration-sweep-2026-05-31.mjs                 # dry-run plan (default)
 *   node scripts/calibration-sweep-2026-05-31.mjs --rows 2049,59  # limit to rows
 *   node scripts/calibration-sweep-2026-05-31.mjs --no-discard    # skip discard scan
 *   node scripts/calibration-sweep-2026-05-31.mjs --apply         # dispatch confirmed generators + mark discards (gated)
 *
 * Exit code = number of live rows still carrying >=1 gap after the run
 *             (0 = every live row apply-ready).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE = path.join(ROOT, 'data', 'apply-now-queue.json');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-dashboard-real-2026-05-31.mjs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NO_DISCARD = args.includes('--no-discard');
const rowsFlag = args.indexOf('--rows');
const onlyRows = rowsFlag >= 0 && args[rowsFlag + 1] ? args[rowsFlag + 1].split(',') : null;

// ── Off-positioning detection ────────────────────────────────────────────────
// Locked positioning (memory user-positioning-builder-enabler-fit-over-comp):
// comms-native applied-AI builder / Enablement. Pure IC SWE and pure Program/
// Product Manager are off-positioning — discard them from the queue.
const OFF_POSITIONING = [
  { name: 'pure-ic-software-engineer', re: /\b(senior |staff |principal |sr\.? )?(software|infrastructure|backend|frontend|full[- ]?stack|platform|systems?)\s+engineer\b/i },
  { name: 'pure-program-manager', re: /\b(technical\s+)?program\s+manager\b/i },
  { name: 'pure-product-manager', re: /\bproduct\s+manager\b/i },
];
// On-positioning tokens — if a role contains ANY of these, never auto-discard it
// even if an off-positioning pattern also matches (e.g. "Applied AI Engineer",
// "Forward Deployed Engineer", "AI Product Manager" = north-star aspirational).
const ON_POSITIONING_GUARD = /\b(applied[- ]?ai|forward[- ]?deployed|developer\s+(advocate|relations|education)|devrel|solutions?\s+architect|enablement|adoption|evangelist|communications?|comms|editorial|ai\s+operations|ai\s+product\s+manager|agentic|architect,?\s+(industries|commercial)|member of technical staff)\b/i;

function isOffPositioning(role) {
  if (!role) return null;
  if (ON_POSITIONING_GUARD.test(role)) return null; // whitelisted — keep
  for (const p of OFF_POSITIONING) if (p.re.test(role)) return p.name;
  return null;
}

// ── Gap → fix-command mapping ────────────────────────────────────────────────
// Only build-apply-packs (--row) and interview-likelihood (--row) have confirmed
// CLI interfaces verified on 2026-05-31. Everything else is printed as a manual
// command — the sweep never fires a generator whose interface it can't confirm.
function fixPlanFor(gap, num) {
  const g = gap.replace(/\(.*\)$/, ''); // strip "(123w)" suffix
  switch (g) {
    case 'report':
    case 'cover-letter':
      return { auto: true, cmd: `node scripts/build-apply-packs.mjs --row ${num}` };
    case 'IL':
      return { auto: true, cmd: `node scripts/agents/interview-likelihood.mjs --row ${num}` };
    case 'HC':
      return { auto: false, cmd: `# MANUAL: hm-chance generator (no confirmed CLI) — generate hm-chance.json for row ${num} via the drawer "Generate apply pack" or intel-refresh` };
    case 'story':
      return { auto: false, cmd: `# MANUAL: story rewrite for row ${num} (voice-grounded, /ai-detection-hardener) — see interview-prep/stories/` };
    case 'scrub':
      return { auto: false, cmd: `# MANUAL: retired metric present in an apply-pack artifact for row ${num} — deterministic scrub required (do NOT rely on LLM polish; see memory feedback_polish_does_not_strip_fabrications)` };
    case 'popout-cache':
      return { auto: false, cmd: `curl -s "http://localhost:3097/api/drill/percentage/${num}/alignment?refresh=1" >/dev/null  # warm strategy-cache` };
    default:
      return { auto: false, cmd: `# MANUAL: unmapped gap "${gap}" for row ${num}` };
  }
}

// ── Load queue ───────────────────────────────────────────────────────────────
const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
let live = (queue.ranked || []).filter(r => !r._dropped && r.status !== 'Discarded');
if (onlyRows) live = live.filter(r => onlyRows.includes(String(r.num)));

console.log(`\n=== calibration sweep — ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${live.length} live row(s) ===\n`);

// ── 1. Auto-discard scan ─────────────────────────────────────────────────────
const discardCandidates = [];
if (!NO_DISCARD) {
  for (const r of live) {
    const reason = isOffPositioning(r.role);
    if (reason) discardCandidates.push({ num: r.num, company: r.company, role: r.role, reason });
  }
  console.log(`-- Auto-discard scan: ${discardCandidates.length} off-positioning candidate(s) --`);
  for (const d of discardCandidates) {
    console.log(`   ${APPLY ? '🗑  DISCARD' : '⚠️  would-discard'} #${d.num} ${d.company} — ${d.role}  [${d.reason}]`);
  }
  if (!discardCandidates.length) console.log('   (none — queue is on-positioning)');
  console.log('');

  if (APPLY && discardCandidates.length) {
    // Archive-first, then mark _dropped (reversible: flip _dropped back to false).
    const stamp = execSync('date +%Y%m%d-%H%M%S', { encoding: 'utf8' }).trim();
    const archive = path.join(ROOT, 'data', `apply-now-queue.pre-calibration-${stamp}.json`);
    fs.writeFileSync(archive, JSON.stringify(queue, null, 2));
    const discardNums = new Set(discardCandidates.map(d => String(d.num)));
    for (const r of queue.ranked) {
      if (discardNums.has(String(r.num))) {
        r._dropped = true;
        r._dropped_reason = `calibration-auto-discard: off-positioning (${isOffPositioning(r.role)})`;
      }
    }
    fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2));
    console.log(`   archived pre-state → ${path.relative(ROOT, archive)}; marked ${discardCandidates.length} row(s) _dropped\n`);
    // Recompute live set after discard.
    live = live.filter(r => !discardNums.has(String(r.num)));
  }
}

// ── 2. DoD sweep (verifier is the single source of truth) ────────────────────
const sweepRows = live.map(r => String(r.num));
let gapReport = '';
if (sweepRows.length) {
  try {
    gapReport = execSync(`node ${JSON.stringify(VERIFIER)} --rows ${sweepRows.join(',')}`, { encoding: 'utf8', cwd: ROOT });
  } catch (e) {
    // verifier exits non-zero = gap count; output still on stdout.
    gapReport = (e.stdout || '').toString();
  }
}

// Parse "⚠️ #<num> ..." followed by "   GAPS: a, b, c".
const gapsByRow = {};
const lines = gapReport.split('\n');
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/#(\d+)\s/);
  const g = (lines[i + 1] || '').match(/^\s*GAPS:\s*(.+)$/);
  if (m && g) gapsByRow[m[1]] = g[1].split(',').map(s => s.trim()).filter(Boolean);
}

const rowsWithGaps = Object.keys(gapsByRow);
console.log(`-- DoD sweep: ${rowsWithGaps.length} of ${sweepRows.length} live row(s) carry gaps --\n`);

const autoCommands = [];
for (const num of rowsWithGaps) {
  const row = live.find(r => String(r.num) === num);
  console.log(`⚠️  #${num} ${row ? row.company + ' — ' + row.role : ''}`);
  for (const gap of gapsByRow[num]) {
    const plan = fixPlanFor(gap, num);
    console.log(`     ${plan.auto ? '▶ AUTO ' : '✋ MANUAL'} [${gap}] ${plan.cmd}`);
    if (plan.auto) autoCommands.push({ num, gap, cmd: plan.cmd });
  }
}
if (!rowsWithGaps.length) console.log('✅ every live row is apply-ready — nothing to do.');

// ── 3. Dispatch (gated) ──────────────────────────────────────────────────────
if (APPLY && autoCommands.length) {
  console.log(`\n-- Dispatching ${autoCommands.length} auto-fix command(s) --`);
  // De-dup identical commands (build-apply-packs fixes report+cover-letter in one run).
  const uniq = [...new Map(autoCommands.map(c => [c.cmd, c])).values()];
  for (const c of uniq) {
    console.log(`   ▶ ${c.cmd}`);
    try {
      execSync(c.cmd, { encoding: 'utf8', cwd: ROOT, stdio: 'inherit', timeout: 30 * 60 * 1000 });
    } catch (e) {
      console.log(`     ✗ failed: ${e.message.slice(0, 120)} (continuing)`);
    }
  }
  console.log('\n-- Re-verifying after dispatch --');
  try {
    const out = execSync(`node ${JSON.stringify(VERIFIER)} --rows ${sweepRows.join(',')}`, { encoding: 'utf8', cwd: ROOT });
    console.log(out);
  } catch (e) { console.log((e.stdout || '').toString()); }
} else if (!APPLY && (autoCommands.length || rowsWithGaps.length)) {
  console.log(`\n(DRY-RUN — re-run with --apply to dispatch ${autoCommands.length} AUTO command(s); MANUAL gaps always need a human.)`);
}

// Exit code = live rows still carrying gaps (post-apply if applied).
let finalGapCount = rowsWithGaps.length;
if (APPLY && autoCommands.length) {
  try {
    execSync(`node ${JSON.stringify(VERIFIER)} --rows ${sweepRows.join(',')} --gaps`, { encoding: 'utf8', cwd: ROOT });
    finalGapCount = 0;
  } catch (e) { finalGapCount = e.status || 0; }
}
console.log(`\n=== sweep complete — ${finalGapCount} live row(s) with remaining gaps ===`);
process.exit(finalGapCount);
