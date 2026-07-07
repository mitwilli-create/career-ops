#!/usr/bin/env node
/**
 * tests/grounding-guard.test.mjs — unit fixtures for lib/grounding-guard.mjs.
 *
 * CI-safe: fixtures only, no personal data, no network, no apply-pack reads.
 * Covers the four rule families + the chatter stripper, anchored to the
 * 2026-06-11 incidents:
 *   - row 2582: first-person authorship of "Ramp Glass / Inspect / Dojo / Sensei"
 *     (names lifted from the JD/eval report)
 *   - rows 2527 + 2373: "**Changes made:** …" critic debris below the letter body
 *   - rows 2059/2527/2582: retired metrics re-seeded into fresh artifacts
 *   - "Kill List" branding (banned word) in linkedin templates + letters
 *
 * Exit 0 = all pass. Exit 1 = at least one failure (prints each).
 */

import { readFileSync } from 'node:fs';
import {
  RETIRED_METRIC_PATTERNS, RETIRED_METRIC_PROBES, LEVEL_JARGON_RE,
  applyBrandingReplacements, stripEditorialChatter,
  extractTargetProductNames, findProductClaimViolations, findGroundingViolations,
  TIME_ASK_RE,
  CONTINUITY_CLAIM_PATTERNS, CONTINUITY_PROBES, findTriageFramingViolations,
} from '../lib/grounding-guard.mjs';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. Retired-metric patterns cover every canonical probe ───────────────────
console.log('1. retired-metric coverage');
for (const probe of RETIRED_METRIC_PROBES) {
  check(`probe flagged: "${probe}"`, RETIRED_METRIC_PATTERNS.some(p => p.re.test(probe)));
}
// Canonical (verified) phrasings must NOT trip the metric patterns.
const CLEAN_CLAIMS = [
  'a community of 1,000+ Principal, Distinguished, and Fellow engineers',
  '~60% of inbound requests auto-handled without escalation (~55% Low-Touch)',
  'recapturing an estimated ~160 operational hours/year',
  '75,000+ new hires with an 88% CSAT score',
  '179% primetime-viewership-growth window',
  '300+ attendees per forum',
  'two production AI agents',
];
for (const probe of CLEAN_CLAIMS) {
  check(`clean claim passes: "${probe.slice(0, 60)}"`,
    !RETIRED_METRIC_PATTERNS.some(p => p.re.test(probe)),
    RETIRED_METRIC_PATTERNS.filter(p => p.re.test(probe)).map(p => p.label).join('; '));
}

// ── 2. Level jargon ──────────────────────────────────────────────────────────
console.log('2. level jargon');
check('flags "1,000+ L8+ Senior Technical ICs"', LEVEL_JARGON_RE.test('1,000+ L8+ Senior Technical ICs'));
check('flags "L8–L10 tiers"', LEVEL_JARGON_RE.test('senior ICs at L8–L10 tiers'));
check('passes rank-name phrasing', !LEVEL_JARGON_RE.test('Principal, Distinguished, and Fellow engineers'));

// ── 3. Branding + banned word ────────────────────────────────────────────────
console.log('3. branding replacement');
check('replaces "Kill List"',
  applyBrandingReplacements('a Voice DNA corpus paired with a "Kill List" of rejected drafts')
    === 'a Voice DNA corpus paired with a banned-phrase checklist of rejected drafts');
check('replaces hyphen/case variants',
  applyBrandingReplacements('the kill-list layer') === 'the banned-phrase checklist layer');
check('leaves "skill" alone', applyBrandingReplacements('agent-skill design') === 'agent-skill design');

// ── 4. Editorial-chatter stripper ────────────────────────────────────────────
console.log('4. chatter stripper');
const LETTER = 'The challenge of editorial scale is one I have spent a career solving.\n\nAt Google xGE I built two production agents.';
check('strips "**Changes made:**" block',
  stripEditorialChatter(`${LETTER}\n\n---\n\n**Changes made:**\n- Tightened Block 2\n- Removed weak opening\n\n[318 words]`) === LETTER);
check('strips trailing "[N words]" line', stripEditorialChatter(`${LETTER}\n\n[312 words]`) === LETTER);
check('strips trailing "Word count: N"', stripEditorialChatter(`${LETTER}\n\nFinal word count: 322 words`) === LETTER);
check('strips leading meta-preamble',
  stripEditorialChatter(`Here is the corrected cover letter:\n\n${LETTER}`) === LETTER);
check('clean letter unchanged', stripEditorialChatter(LETTER) === LETTER);

// ── 5. Target-product extraction + first-person claim guard ──────────────────
console.log('5. product-claim guard');
const FIXTURE_REPORT = `
## A) Role Summary
Hooli is hiring an AI Operations Specialist. The team owns Hooli Glass, the internal
agent workspace, plus Inspect, Dojo, and Sensei. Glass routes inbound, Inspect audits
outputs, Dojo trains workflows, Sensei scores them. Glass and Dojo ship weekly.
Inspect and Sensei are Hooli's flagship internal systems.
`;
const FIXTURE_CORPUS = 'Mitchell built a communications-triage agent and a Voice DNA digital twin at Google xGE.';
const products = extractTargetProductNames({
  reportText: FIXTURE_REPORT, companyName: 'Hooli', corpusText: FIXTURE_CORPUS,
});
check('extracts company-attached product ("Glass")', products.includes('Glass'), JSON.stringify(products));
check('extracts repeated suite names ("Inspect" or "Dojo" or "Sensei")',
  ['Inspect', 'Dojo', 'Sensei'].some(p => products.includes(p)), JSON.stringify(products));
check('does not extract the company name itself', !products.includes('Hooli'), JSON.stringify(products));

const claimViolations = findProductClaimViolations(
  'At Google xGE, I built Glass, Inspect, Dojo, and Sensei to route executive communications.',
  products);
check('flags first-person-past authorship of target products (row-2582 shape)', claimViolations.length >= 1);

check('prospective phrasing passes ("I\'d be building workflows like Glass")',
  findProductClaimViolations("At Hooli, I'd be building workflows like Glass and Dojo from day one.", products).length === 0);
check('their-work phrasing passes ("you\'ve built Glass")',
  findProductClaimViolations("I was struck by how your team has built Glass into the default workspace.", products).length === 0);
check('canonical-source past tense passes (no product token)',
  findProductClaimViolations('At Google xGE, I built and deployed two production AI agents.', products).length === 0);

// ── 6. Aggregate gate ────────────────────────────────────────────────────────
console.log('6. aggregate findGroundingViolations');
const DIRTY = `At Google xGE I shipped agents for 1,000+ L8+ Senior Technical ICs at 99% stylistic fidelity.
I built Glass and Dojo for executive routing.
<!-- FABRICATION FLAGS -->`;
const agg = findGroundingViolations(DIRTY, { productNames: products, isGoogleTarget: false });
const kinds = new Set(agg.map(v => v.kind));
check('aggregate catches retired-metric', kinds.has('retired-metric'), JSON.stringify([...kinds]));
check('aggregate catches level-jargon', kinds.has('level-jargon'));
check('aggregate catches product claim', kinds.has('product-claim-first-person'));
check('aggregate catches fabrication-flag comment', kinds.has('fabrication-flag'));

const CLEAN = `At Google's Office of Cross-Google Engineering, I built and deployed production AI agents for a community of 1,000+ Principal, Distinguished, and Fellow engineers. The triage agent auto-handles ~60% of inbound, recapturing ~160 operational hours per year. At Hooli, I'd extend Glass-style routing with the same discipline.`;
check('aggregate passes canonical clean prose',
  findGroundingViolations(CLEAN, { productNames: products, isGoogleTarget: false }).length === 0,
  JSON.stringify(findGroundingViolations(CLEAN, { productNames: products, isGoogleTarget: false })));

// ── 7. Em-dash gate (opt-in, 2026-06-12) ─────────────────────────────────────
// Em dashes are banned in submitted/spoken materials (AI tell). The check is
// OPT-IN so legacy consumers keep their behavior; the generation tollbooth in
// build-apply-packs.mjs passes checkEmDashes: true. En dashes stay legal.
console.log('7. em-dash gate');
const EM_DIRTY = 'I built the triage agent — it auto-handles most inbound.';
const EM_CLEAN = 'I built the triage agent: it auto-handles most inbound. Tenure: June 2024 – present.';
check('em dash flagged when checkEmDashes: true',
  findGroundingViolations(EM_DIRTY, { checkEmDashes: true }).some(v => v.kind === 'em-dash'));
check('em dash NOT flagged by default (opt-in only)',
  findGroundingViolations(EM_DIRTY, {}).every(v => v.kind !== 'em-dash'));
check('en dash (date range) passes with checkEmDashes: true',
  findGroundingViolations(EM_CLEAN, { checkEmDashes: true }).length === 0,
  JSON.stringify(findGroundingViolations(EM_CLEAN, { checkEmDashes: true })));
check('clean aggregate prose still passes with checkEmDashes: true',
  findGroundingViolations(CLEAN, { productNames: products, isGoogleTarget: false, checkEmDashes: true }).length === 0);

// ── 8. Time-ask gate (opt-in, 2026-06-26) ───────────────────────────────────
// Mitchell's hard rule: no "N minutes" time box in any cover-letter / outreach
// close. The gold reference + both cover-letter templates were the SOURCE that
// seeded "I'd value 15 minutes to walk through ..." into every regenerated
// letter; this gate is the fail-closed backstop. Opt-in (checkTimeAsk) so the
// no-scaffold invariant + legacy consumers keep their behavior; the generation
// tollbooth turns it on.
console.log('8. time-ask gate');
// Direct regex: canonical leak + the prompt's synthetic + spelled-out variant.
check('regex flags the original gold-reference shape',
  TIME_ASK_RE.test('If the role is still open, I would value 15 minutes to walk through the design.'));
check('regex flags the synthetic "I\'d value 20 minutes to chat"',
  TIME_ASK_RE.test("If the role is still open, I'd value 20 minutes to chat about the role."));
check('regex flags spelled-out "fifteen minutes to walk you through"',
  TIME_ASK_RE.test("I'd value fifteen minutes to walk you through it."));
check('regex flags hyphenated "20-minute call"',
  TIME_ASK_RE.test('Happy to set up a 20-minute call if useful.'));
// No false positives: the new no-time-box close + minutes-as-a-metric.
const TIMEASK_CLEAN_CLOSE = 'If the role is still open, I can share a brief write-up of the Voice DNA banned-phrase checklist design and the AJ+ talent pipeline, or walk through either directly.';
check('regex passes the no-time-box value-offer close',
  !TIME_ASK_RE.test(TIMEASK_CLEAN_CLOSE), TIMEASK_CLEAN_CLOSE);
check('regex passes minutes-as-a-metric (no offer cue nearby)',
  !TIME_ASK_RE.test('Each automated reply saves the team roughly 30 minutes of manual triage every day.'));
check('regex passes offer-FIRST metric ("walk through how it saves 20 minutes")',
  !TIME_ASK_RE.test('I can walk through how the agent saves 20 minutes per request.'));
// Gate-level: opt-in fires, default does not, clean prose still passes.
const TIMEASK_DIRTY = `The challenge of editorial scale is one I have spent a career solving.\n\nIf the role is still open, I would value 15 minutes to walk through the Voice DNA design.`;
check('gate flags time-ask when checkTimeAsk: true',
  findGroundingViolations(TIMEASK_DIRTY, { checkTimeAsk: true }).some(v => v.kind === 'time-ask'));
check('gate does NOT flag time-ask by default (opt-in only)',
  findGroundingViolations(TIMEASK_DIRTY, {}).every(v => v.kind !== 'time-ask'));
check('clean aggregate prose still passes with checkTimeAsk: true',
  findGroundingViolations(CLEAN, { productNames: products, isGoogleTarget: false, checkTimeAsk: true }).length === 0,
  JSON.stringify(findGroundingViolations(CLEAN, { productNames: products, isGoogleTarget: false, checkTimeAsk: true })));
check('no-time-box close passes the gate with checkTimeAsk: true',
  findGroundingViolations(TIMEASK_CLEAN_CLOSE, { checkTimeAsk: true }).length === 0,
  JSON.stringify(findGroundingViolations(TIMEASK_CLEAN_CLOSE, { checkTimeAsk: true })));

// ── 9. Continuity-claim + triage-framing gate (opt-in, 2026-07-06) ──────────
// resume-mirror-spec-2026-07-06 exclusions: the comms-triage agent never ran
// during the 2026 leave; ~60% / ~160 hrs are DESIGN TARGETS. Opt-in
// (checkContinuity) so the tree-wide no-scaffold invariant + legacy sweeps
// keep their behavior; the generation tollbooth turns it on.
console.log('9. continuity-claim + triage-framing gate (checkContinuity)');
// Weakening canary: every probe must be caught by the pattern family.
for (const probe of CONTINUITY_PROBES) {
  check(`continuity probe caught: "${probe.slice(0, 50)}"`,
    CONTINUITY_CLAIM_PATTERNS.some(p => p.re.test(probe)) || findTriageFramingViolations(probe).length > 0, probe);
}
const CONT_DIRTY = 'Engineered autonomous frameworks that maintained 100% operational continuity during a multi-month extended leave of absence.';
check('gate flags continuity claim when checkContinuity: true',
  findGroundingViolations(CONT_DIRTY, { checkContinuity: true }).some(v => v.kind === 'continuity-claim'));
check('gate does NOT flag continuity by default (opt-in only)',
  findGroundingViolations(CONT_DIRTY, {}).every(v => v.kind !== 'continuity-claim'));
check('gate flags achieved-result triage framing',
  findGroundingViolations('The agent recaptures ~160 operational hours per year, auto-handling most inbound.', { checkContinuity: true })
    .some(v => v.kind === 'triage-achieved-framing'));
check('design-target framing passes',
  findGroundingViolations('Documented end-to-end and handed off with a full operator runbook; designed to auto-handle ~60% of inbound (est.) and projected to recapture ~160 operational hours/year (est.).', { checkContinuity: true }).length === 0);
check('"~60% auto-handle design target" (scrubber rewrite target) passes',
  findGroundingViolations('The pipeline runs with a ~60% auto-handle design target.', { checkContinuity: true }).length === 0);
check('~70% VP review metric passes (new verified asset)',
  findGroundingViolations('An executive-communications digital twin, cutting review back-and-forth with the VP by about 70%.', { checkContinuity: true }).length === 0);
check('"~55% Low-Touch" flags as retired share',
  findGroundingViolations('with ~60% designed to auto-handle (~55% Low-Touch)', { checkContinuity: true }).some(v => v.kind === 'continuity-claim'));

// ── 10. Static contracts (2026-07-07 code-review findings #1 + #6) ───────────
// Pin the tollbooth's artifact coverage and the shared-detector imports so a
// refactor can't silently narrow either. Source-text assertions over sibling
// scripts, same pattern as tests/spec5-renderer-contracts.test.mjs. Still
// CI-safe: reads repo source files only, no personal data.
console.log('10. static contracts (tollbooth CV coverage + shared detector imports)');
const bapSrc = readFileSync(new URL('../scripts/build-apply-packs.mjs', import.meta.url), 'utf-8');
check('tollbooth gates the tailored-CV markdown (finding #1)',
  /'cover-letter\.md',\s*'form-fields\.md',\s*'one-pager\.md',\s*'tailored-cv\.md',\s*'cv-tailored\.md'/.test(bapSrc));
check('tollbooth keeps checkContinuity on', /checkContinuity:\s*true/.test(bapSrc));
const sweepSrc = readFileSync(new URL('../scripts/scrub-continuity-legacy-debt.mjs', import.meta.url), 'utf-8');
check('sweep imports guard detectors instead of hand-mirroring them (finding #6)',
  /TRIAGE_METRIC_RE\b[\s\S]{0,80}?TARGET_FRAMING_RE\b[\s\S]{0,200}?from '\.\.\/lib\/grounding-guard\.mjs'/.test(sweepSrc.slice(0, sweepSrc.indexOf('const ROOT')))
  && !/TRIAGE_METRIC_RE_LOCAL|TARGET_FRAMING_RE_LOCAL/.test(sweepSrc));

console.log(`\ngrounding-guard: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
