#!/usr/bin/env node
/**
 * tests/apply-pack-fabricated-employer-invariant.test.mjs
 *
 * INVARIANT: no user-facing apply-pack prose artifact (cover-letter.md /
 * form-fields.md / one-pager.md) carries a first-person employment claim whose
 * employer is not in cv.md's Experience-section employer set — and no
 * anonymized-employer claim ("I've run comms at a company on a similar growth
 * trajectory") at all.
 *
 * Born 2026-06-10: the row-2729 (Lovable) build shipped a cover letter claiming
 * Mitchell worked "At Replit" — with the TARGET company's own growth metrics
 * recast as personal history — because the claim-consistency / jd-keyword-score
 * subprocesses exit 1 on findings, execSync conflated that with a spawn
 * failure, and the build swallowed the findings as "⚠️ skipped: Command failed"
 * while reporting the pack as built. Mirrors
 * tests/apply-pack-no-scaffold-invariant.test.mjs.
 *
 * Extended 2026-06-11: the row-2726 (OpenAI) cover letter opened with
 * "I currently own OpenAI's end-to-end education strategy…" — a possessive
 * first-person employment claim with no "at <Company>" anywhere, which all
 * four at-anchored patterns missed (the 2026-06-10 census passed it). The lib
 * now extracts 'possessive-stewardship' ("I own/run/lead/manage <Company>'s
 * <thing>") and 'currently-possessive' ("I currently <verb> <Company>'s
 * <thing>") claims, with consumption/prospective phrasing exempt.
 *
 * Two parts:
 *   1. UNIT — lib/employer-claims.mjs behavior on a fixture CV + the canonical
 *      fabrication/legit phrasings. Always runs (CI-safe: no personal data).
 *   2. CENSUS — every apply-pack/<slug>/{cover-letter,form-fields,one-pager}.md
 *      against the REAL cv.md allowlist. Runs only when cv.md + apply-pack/
 *      exist on disk (local tree); skips silently in CI where both are
 *      gitignored. A green census IS the proof — not a claim.
 *
 * Exit 0 = clean. Exit 1 = unit regression or census violation (prints every
 * offender as file → claim so the gap list is explicit, never buried).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCvEmployers,
  extractEmployerClaims,
  findEmployerViolations,
  isAllowedEmployer,
} from '../lib/employer-claims.mjs';

const ROOT = process.env.CAREER_OPS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Part 1: unit tests on a fixture CV (no personal data) ───────────────────

const FIXTURE_CV = `# Jane Doe

## Summary

Builder.

## Experience

### Lead Widget Wrangler
**Acme Corp — Widget Engineering (AWE)**  |  2020 – present

- Did widget things.

### Producer
**Globex (Initech Media Network)**  |  2016 – 2018

### Earlier Career
**Initech English "The Show" · KTV America**  |  2011 – 2012

## Education

**BA, Journalism**  |  State University  |  2007
`;

console.log('Part 1 — lib/employer-claims.mjs unit tests (fixture CV)');

const allow = parseCvEmployers(FIXTURE_CV);
check('parses fixture employer set', allow.size >= 6, `got ${allow.size}: ${[...allow].join(', ')}`);
check('allowlist includes primary employer', allow.has('acme corp'));
check('allowlist includes parenthetical alias', allow.has('awe'));
check('allowlist includes quoted show name', allow.has('the show'));
check('allowlist excludes Education-section orgs', !allow.has('state university') && !allow.has('ba'));
check('isAllowedEmployer: containment both directions',
  isAllowedEmployer('Acme Corp Widget Division', allow) && isAllowedEmployer('Globex', allow));

// Canonical fabrications — every one of these shipped (or nearly shipped) on
// 2026-06-10 and MUST be violations.
const FABRICATIONS = [
  ['at-x past-tense', 'At Replit, I ran product and technical communications through hypergrowth — 8M users, 50M+ projects.'],
  ['verb-at', "I've run executive communications programs at Replit during its fastest growth phase."],
  ['worked-at', 'Before this, I worked at Replit on developer education.'],
  ['anonymized descriptor', "I've run comms at a company on a similar growth trajectory."],
  ['anonymized superlative', 'I scaled editorial operations at the fastest-growing software company on record.'],
  ['insider-we at target', 'At Lovable, we grew from zero to 8M users in two years.'],
  // 2026-06-11 extension — possessive employment claims (row-2726 OpenAI miss:
  // "own <Company>'s <thing>" needs no "at", so P1-P4 never fired).
  ['possessive stewardship present', "I own Hooli's developer education strategy and roadmap."],
  ['possessive stewardship we', "We run Hooli's partner enablement program."],
  ['possessive stewardship past', "I previously led Hooli's developer relations function."],
  ['currently + steward verb', "I currently manage Hooli's technical content team."],
  ['currently + broad verb', "I currently orchestrate Hooli's launch communications."],
  ['gerund possessive', "I'm currently leading Hooli's developer education program."],
  ['possessive function phrase behind product noun', "I own Hooli's API strategy."],
  ['2726 regression (exact sentence)', "I currently own OpenAI's end-to-end education strategy for developers and non-technical users learning to build with Codex, ChatGPT, APIs, and frontier models — strategy, roadmap, formats, feedback loops, and launch integration."],
];
for (const [label, text] of FABRICATIONS) {
  const v = findEmployerViolations(text, { allowedEmployers: allow });
  check(`fabrication flagged: ${label}`, v.length >= 1, JSON.stringify(extractEmployerClaims(text)));
}

// Legitimate phrasings — none of these may block (calibrated against the
// hand-corrected 2729-lovable pack, which passes clean).
const LEGIT = [
  ['allowlisted employer', 'At Acme Corp, I built and deployed two production agents for senior engineers.'],
  ['allowlisted alias', 'At AWE, I led communications for 1,000+ senior engineers.'],
  ['prospective at target', "At Lovable, I'd bring the same documentation system."],
  ['company-context (second person)', "At Lovable, you've built the fastest-growing software company on record."],
  ['observational stative', 'At Lovable, I was struck by how the team ships.'],
  ['observational verb', 'At Lovable, I see a team that treats docs as product.'],
  ['newsroom anonymization allowed', 'I produced live coverage at a global news network.'],
  // 2026-06-11 extension calibration — prospective/consumption possessives and
  // target-company-as-subject phrasing must NOT flag.
  ['prospective own (want to)', 'I want to own that full surface.'],
  ['prospective own (contraction)', "I'd own Hooli's developer education roadmap from day one."],
  ['prospective own (will)', "I will own Hooli's education strategy if hired."],
  ['target company as subject', "OpenAI ships capability faster than any team I've worked with."],
  ['product consumption (currently use)', "I currently use Hooli's APIs in three production systems."],
  ['product consumption (run models)', "I run Hooli's models locally for every prototype."],
  ['observational consumption (follow research)', "I currently follow Hooli's research closely."],
  ['customer deployment (led rollout)', "I led Hooli's rollout across our 400-person org."],
  ['allowlisted possessive stewardship', "I own Acme Corp's editorial calendar."],
  // Person-subject story credit (2026-06-12, row-49-era OpenAI pack): producing
  // a story SUBJECT's on-record break is a newsroom credit, not employment.
  ['person-subject story credit (on-record break)', "I produced Jenna Miscavige Hill's on-record break with Scientology, the niece of the church's leader."],
  ['person-subject story credit (sit-down)', "I booked the senator's first sit-down after the verdict."],
];
for (const [label, text] of LEGIT) {
  const v = findEmployerViolations(text, { allowedEmployers: allow });
  check(`legit passes: ${label}`, v.length === 0, JSON.stringify(v));
}

// Pattern labels for the 2026-06-11 possessive family route correctly.
{
  const steward = extractEmployerClaims("I currently own OpenAI's end-to-end education strategy for developers.");
  check('2726 sentence extracts as possessive-stewardship',
    steward.some(c => c.pattern === 'possessive-stewardship' && /openai/i.test(c.employer)),
    JSON.stringify(steward));
  const broad = extractEmployerClaims("I currently orchestrate Hooli's launch communications.");
  check('broad currently-form extracts as currently-possessive',
    broad.some(c => c.pattern === 'currently-possessive' && /hooli/i.test(c.employer)),
    JSON.stringify(broad));
}

// Empty allowlist must fail closed (claims become violations, not passes).
check('fail-closed on empty allowlist',
  findEmployerViolations('At Acme Corp, I built the program.', { allowedEmployers: new Set() }).length === 1);

// ── Part 2: census against the real tree (local only) ───────────────────────

const cvPath = path.join(ROOT, 'cv.md');
const packBase = path.join(ROOT, 'apply-pack');
const TRIO = ['cover-letter.md', 'form-fields.md', 'one-pager.md'];

if (fs.existsSync(cvPath) && fs.existsSync(packBase)) {
  console.log('\nPart 2 — census: every apply-pack prose artifact vs cv.md employer set');
  const realAllow = parseCvEmployers(fs.readFileSync(cvPath, 'utf8'));
  check('real cv.md employer set parses (fail-closed guard)', realAllow.size >= 3, `got ${realAllow.size}`);
  let scanned = 0;
  const violations = [];
  for (const d of fs.readdirSync(packBase)) {
    const dir = path.join(packBase, d);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const a of TRIO) {
      const p = path.join(dir, a);
      if (!fs.existsSync(p)) continue;
      scanned++;
      for (const v of findEmployerViolations(fs.readFileSync(p, 'utf8'), { allowedEmployers: realAllow })) {
        violations.push({ file: `apply-pack/${d}/${a}`, ...v });
      }
    }
  }
  console.log(`  census scanned ${scanned} artifact(s) across the pack tree`);
  if (violations.length) {
    failures++;
    console.error(`  ✗ ${violations.length} fabricated-employer claim(s) on disk:`);
    for (const v of violations.slice(0, 20)) {
      console.error(`     ${v.file} [${v.pattern}] "${v.raw.slice(0, 90)}" → ${v.employer}`);
    }
  } else {
    console.log('  ✓ census clean — zero fabricated-employer claims in user-facing prose');
  }
} else {
  console.log('\nPart 2 — census skipped (cv.md / apply-pack/ not on disk — CI context)');
}

if (failures > 0) {
  console.error(`\n✗ FAIL — ${failures} check(s) failed. Fabricated-employer content must never ship; fix the artifact or the lib, never the invariant.`);
  process.exit(1);
}
console.log('\n✓ PASS — employer-claim invariant holds.');
process.exit(0);
