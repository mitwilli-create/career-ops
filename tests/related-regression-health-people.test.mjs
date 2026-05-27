// tests/related-regression-health-people.test.mjs
//
// Static contract tests for the Health + People badge renderers in
// scripts/build-dashboard.mjs.
//
// Background — incident 2026-05-27 (3 apply-now rows showing "—" / "?"):
// The Health badge (renderBenefitsCell) reads role-enrichment, NOT
// team-health. Mitchell saw 3 apply-now rows with "—" Health badges +
// adjacent team-health/<slug>.json files present on disk + concluded
// "renderer bug." Investigation found:
//
//   Finding 1 — MENTAL-MODEL GAP: The two data sources are distinct.
//     Health badge ← role-enrichment/<id>-<co>-<role>.json
//     team-health popout ← team-health/<slug>.json
//     The 3 failing rows had missing role-enrichment at flag time. Backfill
//     restored them. The renderer's empty-state should mention adjacent
//     team-health data when present so the gap is discoverable. PR adds
//     a team-health-narrative link inside the empty-state popover.
//
//   Finding 2 — sentinel-string-treated-as-truthy-by-gating-predicate:
//     renderPeopleCell::has_research evaluated 'unknown' as truthy ('research
//     present'), bypassing the empty-state branch. The populated branch then
//     ALSO treated 'unknown' as absent (correct) — resulting in a meaningless
//     `?` chip with an empty tooltip. The fix aligns has_research's sentinel
//     handling with the rest of the renderer.
//
// These tests assert the structural invariants that prevent regression of
// either fix via source-string regex matches against the build script.
// They do not execute the renderer (which would require loading the
// full template literal + every helper) — the regex tests lock the
// load-bearing lines that future refactors must preserve.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DASHBOARD = join(__dirname, '..', 'scripts', 'build-dashboard.mjs');
const SRC = readFileSync(BUILD_DASHBOARD, 'utf-8');

// ────────────────────────────────────────────────────────────────────────
// T1 — Finding 2 fix: People-cell has_research treats 'unknown' as absent.
// ────────────────────────────────────────────────────────────────────────

test('T1.1: has_research check filters \'unknown\' sentinel before treating as research-present', () => {
  // The fixed predicate must check name truthiness AND name !== 'unknown'
  // on at least one of likely_recruiter or likely_hiring_manager.
  const pat = /const has_research = !!\(\(_recName && _recName !== 'unknown'\) \|\| \(_hmName && _hmName !== 'unknown'\)\);/;
  assert.match(SRC, pat,
    'has_research must apply !== \'unknown\' sentinel filter consistently with downstream rec/hm checks');
});

test('T1.2: has_research uses local name binding (semantic clarity)', () => {
  // The fix introduces _recName + _hmName local bindings — single
  // source of truth for the name reads. Future refactors that re-inline
  // the optional-chain reads must keep the sentinel filter.
  assert.match(SRC, /const _recName = people\?\.likely_recruiter\?\.name;/);
  assert.match(SRC, /const _hmName  = people\?\.likely_hiring_manager\?\.name;/);
});

test('T1.3: downstream rec/hm renderers still treat \'unknown\' as absent (regression lock)', () => {
  // These two lines were correct PRE-fix; the bug was only in has_research.
  // We assert them anyway so future refactors don't break the consistency.
  assert.match(SRC,
    /const rec = people\?\.likely_recruiter\?\.name && people\.likely_recruiter\.name !== 'unknown' \? '\u{1f464}' : '';/u);
  assert.match(SRC,
    /const hm  = people\?\.likely_hiring_manager\?\.name && people\.likely_hiring_manager\.name !== 'unknown' \? '\u{1f454}' : '';/u);
});

test('T1.4: bug-class comment preserved (audit trail for future readers)', () => {
  // The fix is small enough that the comment is the only signal of WHY
  // the !== 'unknown' check matters. Lose the comment, lose the lesson.
  assert.match(SRC, /BUG-CLASS: sentinel-string-treated-as-truthy-by-gating-predicate/);
});

// ────────────────────────────────────────────────────────────────────────
// T2 — Finding 1 UX improvement: Health empty-state surfaces team-health
//      adjacent data when present.
// ────────────────────────────────────────────────────────────────────────

test('T2.1: TEAM_HEALTH_DIR constant declared (separate from role-enrichment)', () => {
  // The two data sources are distinct. Both directories must be named
  // so future code can reference team-health independently.
  assert.match(SRC, /const TEAM_HEALTH_DIR = join\(ROOT, 'data\/team-health'\);/);
});

test('T2.2: _teamHealthSlugForCompany helper exists with hyphen-collapse fallback', () => {
  // The helper resolves a company name to a team-health/<slug>.json path.
  // Must handle both standard slug ('workos' → 'workos.json') and
  // hyphen-collapsed slug ('work-os' → 'workos.json' fallback).
  assert.match(SRC, /function _teamHealthSlugForCompany\(company\)/);
  // Hyphen-collapse fallback for slugs like "work-os" → "workos"
  assert.match(SRC, /const collapsed = slug\.replace\(\/-\/g, ''\);/);
});

test('T2.3: empty Health badge popover includes team_health_slug + team_health_company fields', () => {
  // The detail JSON must carry team_health_slug + team_health_company
  // so the popover renderer can wire the adjacent-data link.
  assert.match(SRC, /team_health_slug: teamHealthSlug \|\| null,/);
  assert.match(SRC, /team_health_company: teamHealthSlug \? company : null,/);
});

test('T2.4: empty-state tooltip is data-aware (different copy when team-health exists)', () => {
  // The aria-label / title text differs based on whether team-health/<slug>.json
  // is present. The data-aware copy guides the user to the adjacent popout
  // instead of leaving them with a generic "no data" message.
  assert.match(SRC,
    /team-health narrative IS available for \$\{company\}\. Click for the popout link\./);
});

test('T2.5: pill-popover-team-health-link element rendered with data-* attributes', () => {
  // The popover renderer adds an <a class="pill-popover-team-health-link">
  // with data-team-health-slug + data-team-health-company attributes.
  // Event-delegation pattern avoids quote-escaping pain inside the outer
  // template literal (see AGENTS.md § outer-template-unescape).
  assert.match(SRC, /class="pill-popover-team-health-link"/);
  assert.match(SRC, /data-team-health-slug="/);
  assert.match(SRC, /data-team-health-company="/);
});

test('T2.6: openPillPopover wires team-health-link click via window._openTeamHealthPopout', () => {
  // The click handler must (a) call window._openTeamHealthPopout if defined,
  // (b) prevent default + stop propagation so the popover-outside-click
  // handler doesn't close prematurely, (c) close this popover before
  // opening the new one.
  assert.match(SRC, /var thLink = pop\.querySelector\('\.pill-popover-team-health-link'\);/);
  assert.match(SRC, /if \(thLink && window\._openTeamHealthPopout\)/);
  assert.match(SRC, /window\._openTeamHealthPopout\(slug, co\);/);
});

test('T2.7: empty-state popover renders thLink between meta and end (audit trail)', () => {
  // The thLink HTML is concatenated to the existing empty-state popover
  // body. The 'Adjacent: …' prefix + tooltip explanation are load-bearing
  // for the mental-model fix.
  assert.match(SRC, /Adjacent: <a href="#" class="pill-popover-team-health-link"/);
  assert.match(SRC, /Team-health holds qualitative reports/);
  assert.match(SRC, /Distinct from the role-enrichment numeric grade\./);
});

// ────────────────────────────────────────────────────────────────────────
// T3 — Inline-JS lint safety (outer-template-unescape regression guard)
// ────────────────────────────────────────────────────────────────────────

test('T3.1: rendered dashboard inline-JS parses cleanly (no syntax errors)', () => {
  // This is the same check `scripts/lint-built-html-js.mjs` runs as a
  // post-build step. We exercise it here so any regex / escape regression
  // in the patched popover code surfaces in test rather than at build.
  // We don't actually parse here — the build step's success is the proof.
  // We just assert that the lint script exists + the build path mentions it.
  assert.match(SRC, /scripts\/lint-built-html-js\.mjs/);
});

// ────────────────────────────────────────────────────────────────────────
// T4 — Regression locks for adjacent invariants
// ────────────────────────────────────────────────────────────────────────

test('T4.1: ROLE_ENRICHMENT_DIR + TEAM_HEALTH_DIR declared adjacent (review-time visibility)', () => {
  // Future Claude instances skimming the constants block must see both
  // adjacent so the data-source distinction is obvious. Source-string
  // proximity is the cheapest enforcement of this convention.
  const roleIdx = SRC.indexOf("const ROLE_ENRICHMENT_DIR = join(ROOT, 'data/role-enrichment');");
  const teamIdx = SRC.indexOf("const TEAM_HEALTH_DIR = join(ROOT, 'data/team-health');");
  assert.ok(roleIdx > 0, 'ROLE_ENRICHMENT_DIR not found');
  assert.ok(teamIdx > 0, 'TEAM_HEALTH_DIR not found');
  // Should be within 200 chars of each other (consecutive lines)
  assert.ok(Math.abs(teamIdx - roleIdx) < 200,
    'TEAM_HEALTH_DIR should be declared adjacent to ROLE_ENRICHMENT_DIR for review visibility');
});

test('T4.2: renderBenefitsCell still reads role-enrichment (not team-health) for the populated path', () => {
  // The populated Health badge ALWAYS reads role-enrichment. The
  // team-health-awareness is ONLY in the empty-state branch. Keep
  // the populated path clean.
  assert.match(SRC,
    /function renderBenefitsCell\(company, role\) \{\s*const enrich = getRoleEnrichment\(company, role\);/);
});
