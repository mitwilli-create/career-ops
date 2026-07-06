#!/usr/bin/env node
/**
 * tests/scrub-fabrications.test.mjs — integration fixtures for the deterministic
 * retired-metric scrubber (scripts/scrub-fabrications.mjs), pinning the 7 RULES/PAT
 * gaps found 2026-06-14 while scrubbing voice-corpus + storytellermitch portfolio files
 * (each had survived the scrubber and needed a manual fix):
 *
 *   1. "top 0.5% of …"      — rule 83 trailing \b after % silently failed
 *   2. "&gt;90% accuracy"    — HTML-entity > was missed everywhere (rules + PAT)
 *   3. "better than 90%" / bare "90% accuracy" (no "classification")
 *   4. "cut drafting latency 90%" / "… 90 percent" (the 90% AFTER the noun)
 *   5. "99% voice fidelity"  — "voice" between 99% and fidelity slipped through
 *   6. mentorship prose 3.5h→20min forms (auto-fix the "…per match → 20 min" span;
 *      fail-loud via PAT on the varied remainder)
 *   7. PAT verifier kept in sync so any survivor fails-loud for hand-fix
 *
 * WHY integration (spawn the REAL scrubber) over a unit test that re-implements the
 * regexes: this is the exact path scripts/lib/scrub-gate.mjs uses, so it ALSO pins the
 * shell-escaping of the verifier PAT — e.g. the HTML-entity "&gt;" alternative has to
 * survive a double-quoted `grep -nE` invocation, which a pure-JS regex test would miss.
 *
 * Apply mode runs on a temp copy in os.tmpdir() — never a committed fixture. The
 * scrubber's backups land in data/scrub-backups-2026-05-31/ (gitignored); we clean ours.
 * Replacement TARGETS are all grounded in cv.md (canonical): two production agents,
 * ~60% of inbound auto-handled, "a consistent, verified voice",
 * "from manual cohort-matching to an AI-driven, self-serve model".
 *
 * Exit 0 = all pass. Exit 1 = at least one failure (prints each).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRUBBER = join(ROOT, 'scripts', 'scrub-fabrications.mjs');
const BACKUP_DIR = join(ROOT, 'data', 'scrub-backups-2026-05-31');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * Write `content` to a temp file, run the REAL scrubber over it in apply mode, read the
 * (possibly rewritten) file back, then clean up the temp file + its scrubber backup.
 * @returns {{ exit:number, stdout:string, scrubbed:string }}
 */
let tmpCounter = 0;
function runScrubber(content) {
  const name = `scrub-fab-fixture-${process.pid}-${tmpCounter++}.md`;
  const fpath = join(tmpdir(), name);
  writeFileSync(fpath, content, 'utf8');
  let exit = 0, stdout = '';
  try {
    stdout = execFileSync(process.execPath, [SCRUBBER, fpath], { encoding: 'utf8', cwd: ROOT });
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : -1;
    stdout = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const scrubbed = existsSync(fpath) ? readFileSync(fpath, 'utf8') : '';
  try { rmSync(fpath); } catch { /* best-effort */ }
  // backup name is the path-flattened temp path + ".bak"; match defensively by suffix
  try {
    if (existsSync(BACKUP_DIR)) {
      for (const f of readdirSync(BACKUP_DIR)) {
        if (f.endsWith(`${name}.bak`)) rmSync(join(BACKUP_DIR, f));
      }
    }
  } catch { /* best-effort */ }
  return { exit, stdout, scrubbed };
}

// ── Gap 1 — "top 0.5% of …" (trailing \b dropped) ────────────────────────────
console.log('1. gap 1 — top 0.5% of (trailing \\b was the bug)');
{
  const r = runScrubber('Mitchell operates in the top 0.5% of a large engineering org.\n');
  check('exit 0 (auto-fixed + verifier clean)', r.exit === 0, `exit=${r.exit}`);
  check('"top 0.5%" removed', !/top 0\.5%/.test(r.scrubbed), r.scrubbed.trim());
  check('grounded target present ("most senior engineering tier")',
    /most senior engineering tier/.test(r.scrubbed));
}

// ── Gap 2 — HTML-entity &gt;90% ──────────────────────────────────────────────
console.log('2. gap 2 — &gt;90% (HTML-entity > missed by rules + PAT)');
{
  const r = runScrubber('The triage agent runs at &gt;90% classification accuracy on intake.\n'
    + 'A second pass hits &gt;90% accuracy too.\n');
  check('exit 0', r.exit === 0, `exit=${r.exit} :: ${r.stdout.slice(-200)}`);
  check('"&gt;90%" classification/accuracy removed', !/&gt;\s*90%/.test(r.scrubbed), r.scrubbed.trim());
  check('grounded target present (~60% auto-handled)', /~60% of inbound auto-handled/.test(r.scrubbed));
}

// ── Gap 3 — "better than 90%" + bare "90% accuracy" ──────────────────────────
console.log('3. gap 3 — better than 90% + bare 90% accuracy (no "classification")');
{
  const r = runScrubber('It achieved better than 90% accuracy.\n'
    + 'The router hit 90% accuracy on first contact.\n');
  check('exit 0', r.exit === 0, `exit=${r.exit} :: ${r.stdout.slice(-200)}`);
  check('no "90% accuracy" survives', !/90%\s+accuracy/.test(r.scrubbed), r.scrubbed.trim());
  check('no "better than 90%" survives', !/better than\s+90%/.test(r.scrubbed));
}

// ── Gap 4 — word-order "cut drafting latency 90%" / "… 90 percent" ───────────
console.log('4. gap 4 — drafting latency 90% (90% AFTER the noun)');
{
  const r = runScrubber('We cut drafting latency 90% last quarter.\n'
    + 'The team reduced drafting latency by 90 percent.\n');
  check('exit 0', r.exit === 0, `exit=${r.exit} :: ${r.stdout.slice(-200)}`);
  check('no "drafting latency 90" survives', !/drafting latency\s+(?:by\s+)?90/.test(r.scrubbed), r.scrubbed.trim());
  check('grounded soft target present ("cut drafting time")',
    (r.scrubbed.match(/cut drafting time/g) || []).length >= 2);
}

// ── Gap 5 — "99% voice fidelity" ─────────────────────────────────────────────
console.log('5. gap 5 — 99% voice fidelity ("voice" between 99% and fidelity)');
{
  const r = runScrubber('The digital twin drafts at 99% voice fidelity.\n'
    + 'It sustained 99% voice fidelity across memos.\n');
  check('exit 0', r.exit === 0, `exit=${r.exit} :: ${r.stdout.slice(-200)}`);
  check('no "99% voice fidelity" survives', !/99%\s+voice\s+fidelity/.test(r.scrubbed), r.scrubbed.trim());
  check('grounded target present ("consistent, verified voice")',
    /consistent, verified voice/.test(r.scrubbed));
}

// ── Gap 6a/6b — mentorship prose forms that FAIL-LOUD (varied shapes) ─────────
console.log('6. gap 6 — mentorship 3.5h prose: fail-loud on varied shapes, auto-fix the per-match→20min span');
{
  // standalone "3.5 hours per match" — no auto-fix rule → must fail-loud (exit 1)
  const a = runScrubber('Manual matching took 3.5 hours per match before automation.\n');
  check('6a standalone "3.5 hours per match" → exit 1 (fail-loud)', a.exit === 1, `exit=${a.exit}`);
  check('6a survivor surfaced for hand-fix', /SURVIVING LEAK/.test(a.stdout) && /3\.5 hours/.test(a.stdout), a.stdout.slice(-200));

  // "3.5 hours of admin work to 20 minutes" — different shape → fail-loud (exit 1)
  const b = runScrubber('We cut 3.5 hours of admin work to 20 minutes.\n');
  check('6b "3.5 hours of admin work …" → exit 1 (fail-loud)', b.exit === 1, `exit=${b.exit}`);
  check('6b survivor surfaced', /SURVIVING LEAK/.test(b.stdout), b.stdout.slice(-200));

  // "(3.5 hours → under 20 min)" parenthetical — pre-existing rule 79 strips it → exit 0
  const c = runScrubber('Matching time fell (3.5 hours → under 20 min per match) once automated.\n');
  check('6c parenthetical form still auto-stripped → exit 0', c.exit === 0, `exit=${c.exit} :: ${c.stdout.slice(-200)}`);
  check('6c "3.5 hours" gone from parenthetical', !/3\.5 hours/.test(c.scrubbed), c.scrubbed.trim());

  // "dropped from 3.5 hours per match to under 20 minutes" — EXCL filters lines with the
  // word "dropped", so PAT alone can't fail-loud; the conservative rule auto-fixes it.
  const d = runScrubber('Matching dropped from 3.5 hours per match to under 20 minutes.\n');
  check('6d "dropped from 3.5 hours … 20 min" auto-fixed (EXCL bypass) → exit 0', d.exit === 0, `exit=${d.exit} :: ${d.stdout.slice(-200)}`);
  check('6d "3.5 hours" gone', !/3\.5 hours/.test(d.scrubbed), d.scrubbed.trim());
  check('6d grounded target present ("manual cohort-matching")',
    /from manual cohort-matching to an AI-driven, self-serve model/.test(d.scrubbed), d.scrubbed.trim());
}

// ── Acceptance — ALL auto-fixable gap forms in one fixture → 0 survive ────────
console.log('7. acceptance — combined auto-fixable fixture (gaps 1-5 + gap-6 span) → exit 0, 0 survive');
{
  const combined = [
    'He sits in the top 0.5% of the eng org.',                       // gap 1
    'The agent runs at &gt;90% classification accuracy.',           // gap 2
    'Independent testing showed better than 90% accuracy; routing held 90% accuracy.', // gap 3
    'We cut drafting latency 90%, and a sister team reduced drafting latency by 90 percent.', // gap 4
    'The digital twin drafts at 99% voice fidelity.',              // gap 5
    'Match time dropped from 3.5 hours per match to under 20 minutes.', // gap 6 (auto-fix span)
    '',
  ].join('\n');
  const r = runScrubber(combined);
  check('exit 0 (verifier-clean)', r.exit === 0, `exit=${r.exit} :: ${r.stdout.slice(-300)}`);
  check('stdout reports "verifier-clean"', /verifier-clean/.test(r.stdout), r.stdout.slice(-200));
  // census: NONE of the retired forms remain
  const RETIRED = [
    /top 0\.5%/, /&gt;\s*90%/, /90%\s+accuracy/, /better than\s+90%/,
    /drafting latency\s+(?:by\s+)?90/, /99%\s+voice\s+fidelity/, /3\.5 hours/,
  ];
  check('census: zero retired forms survive', RETIRED.every(re => !re.test(r.scrubbed)),
    RETIRED.filter(re => re.test(r.scrubbed)).map(String).join('; '));
}

// ── Regression — clean canonical prose must pass untouched ───────────────────
console.log('8. regression — cv.md-grounded clean prose untouched (no over-match)');
{
  const clean = 'At Google xGE I built and deployed two production agents for a community of '
    + '1,000+ Principal, Distinguished, and Fellow engineers, auto-handling ~60% of inbound '
    + 'in a consistent, verified voice.\n';
  const r = runScrubber(clean);
  check('exit 0', r.exit === 0, `exit=${r.exit}`);
  check('clean prose byte-for-byte unchanged', r.scrubbed === clean, JSON.stringify(r.scrubbed.slice(0, 120)));
}

// ── Regression — non-retired "90%" + comp figures must NOT be mangled ─────────
console.log('9. regression — broadened 90% rule must not over-match unrelated "90%"/comp');
{
  const r1 = runScrubber('The migration is 90% complete and rollout is 90% of the way done.\n');
  check('"90% complete"/"90% of the way" untouched', r1.exit === 0 && /90% complete/.test(r1.scrubbed)
    && /90% of the way/.test(r1.scrubbed), `exit=${r1.exit} :: ${r1.scrubbed.trim()}`);

  const r2 = runScrubber('Targeting a $120K base salary in Seattle.\n');
  check('"$120K base salary" comp figure untouched',
    r2.exit === 0 && /\$120K base salary/.test(r2.scrubbed), `exit=${r2.exit} :: ${r2.scrubbed.trim()}`);
}

console.log(`\nscrub-fabrications: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
