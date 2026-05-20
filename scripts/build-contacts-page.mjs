#!/usr/bin/env node
/**
 * scripts/build-contacts-page.mjs — standalone full-screen relationship-
 * intelligence directory at dashboard/contacts.html.
 *
 * 2026-05-19 — REWRITTEN by β BRAVO (overnight haul) per dealbreaker spec
 * (data/dealbreaker-bravo-contacts-2026-05-19.md):
 *
 *   1. Uses shared dashboard shell (lib/dashboard-shell.mjs) so the page
 *      has the same sidebar / skip-link / ARIA landmarks / keyboard
 *      shortcuts as index.html. No more orphan page.
 *   2. Computes enrichment tier (3 / 2 / 1) per contact and DEFAULT-HIDES
 *      Tier 1 stubs except those that are warm-to-target. Header bar shows
 *      "868 enriched of 2,824 — 1,956 stubs hidden [Show all]" so the
 *      progress is transparent without burying signal.
 *   3. Replaces the 7 single-select filter pills with a stackable chip row
 *      aligned to Mitchell's career-ops goals (warm to apply-now, target
 *      company multi-select, has email, in outreach, warm ≥3, tier, last
 *      touched, degree, archetype, pre-IPO).
 *   4. Sort dropdown — default "Opportunity Score" (composite, hover-
 *      explainer) plus raw options: warm path, last touched, connected,
 *      tier, name, data richness.
 *   5. `/` keyboard shortcut focuses the search input. Token search
 *      (`company:openai tier:3+`) is parsed into the filter set.
 *   6. Card density: enriched cards stay rich, stub cards collapse to
 *      40 px dense one-liners when "Show all" is on.
 *
 * Re-uses the deterministic enricher pipeline from scripts/build-dashboard.mjs
 * by reading the already-baked contacts dataset out of the freshly-built
 * dashboard/index.html (via window._CONTACTS_DATA + window._CONTACTS_STATS).
 *
 * Output: dashboard/contacts.html — self-contained HTML with embedded CSS +
 * the shared shell. Run on every dashboard build (chained from
 * build-dashboard.mjs).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDashboardShell, esc } from '../lib/dashboard-shell.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// 2026-05-20 — Pull contacts from the externalized JSON (build-dashboard.mjs
// emits dashboard/data/contacts.json since the data-pill externalization on
// 2026-05-20 commit `da92be5`). Fall back to in-HTML regex extraction for
// older builds where the data was still inlined.
const dashboardHtmlPath = join(REPO_ROOT, 'dashboard/index.html');
const contactsJsonPath = join(REPO_ROOT, 'dashboard/data/contacts.json');
let contacts = [];
let stats = {};

if (existsSync(contactsJsonPath)) {
  try {
    const payload = JSON.parse(readFileSync(contactsJsonPath, 'utf8'));
    contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
    stats = payload.stats || {};
    console.log(`[build-contacts-page] loaded ${contacts.length} contacts from ${contactsJsonPath}`);
  } catch (e) {
    console.warn('[build-contacts-page] contacts.json parse failed:', e.message);
  }
}

if (contacts.length === 0) {
  if (!existsSync(dashboardHtmlPath)) {
    console.error('[build-contacts-page] dashboard/index.html missing AND dashboard/data/contacts.json absent — run `node scripts/build-dashboard.mjs` first');
    process.exit(1);
  }
  const html = readFileSync(dashboardHtmlPath, 'utf8');
  const extract = (varName) => {
    const re = new RegExp(`var ${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\});`, 'm');
    const m = html.match(re);
    if (!m) return null;
    try { return JSON.parse(m[1].replace(/<\\\//g, '</')); } catch (e) { return null; }
  };
  contacts = extract('_CONTACTS_DATA') || [];
  stats = extract('_CONTACTS_STATS') || {};
}

if (contacts.length === 0) {
  console.error('[build-contacts-page] no contacts extracted — check the bake pipeline in build-dashboard.mjs (expected dashboard/data/contacts.json or inline _CONTACTS_DATA)');
  process.exit(1);
}

console.log(`[build-contacts-page] extracted ${contacts.length} contacts from baked dashboard`);

// ---------------------------------------------------------------------------
// Enrichment-tier computation per dealbreaker spec D-Impasse-1.
// ---------------------------------------------------------------------------

function computeEnrichmentTier(c) {
  // Tier 3 — has 2+ enrichment signals beyond email
  let signalCount = 0;
  if (c.enrichment_status === 'complete') signalCount += 2;
  if (c.engagement && (c.engagement.linkedin_topics?.length || c.engagement.x_topics?.length)) signalCount++;
  if (c.outreach_recommendation && (c.outreach_recommendation.positioning || c.outreach_recommendation.best_channel)) signalCount++;
  if (c.inferred_relationship && c.inferred_relationship.arc) signalCount++;
  if (signalCount >= 2) return 3;
  // Tier 2 — has professional email
  if (c.email_professional) return 2;
  // Tier 1 — stub
  return 1;
}

// ---------------------------------------------------------------------------
// Target companies — sourced from data/apply-now-queue.json at build time.
// 2026-05-20 (BRAVO followup, Item 5 / AA-2): previous instance hard-coded a
// 10-company alias map that didn't reflect Mitchell's live apply-now queue
// (was missing Databricks, Deepgram, Ema, LangChain, Ramp at score ≥4.0).
// Now the canonical list IS the queue. Known multi-string variations (cursor
// → anysphere; eleven → elevenlabs) live in a small static alias map.
// ---------------------------------------------------------------------------

// Static aliases for companies whose name appears with multiple spellings in
// the LinkedIn corpus. The KEY is the canonical slug; values are lower-case
// strings to substring-match against contact.company.
const KNOWN_ALIASES = {
  openai: ['openai', 'open ai'],
  anthropic: ['anthropic'],
  anysphere: ['cursor', 'anysphere'],
  elevenlabs: ['elevenlabs', 'eleven labs', 'eleven'],
  'mistral ai': ['mistral ai', 'mistral'],
  perplexity: ['perplexity'],
  cohere: ['cohere'],
  cognition: ['cognition'],
  pinecone: ['pinecone'],
  sierra: ['sierra'],
  langchain: ['langchain', 'lang chain'],
  databricks: ['databricks'],
  deepgram: ['deepgram'],
  ramp: ['ramp'],
  ema: ['ema unlimited', 'ema'],
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function loadTargetCompanies() {
  const queuePath = join(REPO_ROOT, 'data/apply-now-queue.json');
  if (!existsSync(queuePath)) {
    console.warn('[build-contacts-page] data/apply-now-queue.json missing — falling back to static alias map');
    return KNOWN_ALIASES;
  }
  try {
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    const ranked = Array.isArray(queue.ranked) ? queue.ranked : [];
    // Score threshold 4.0 mirrors what dashboard-server.mjs uses for the apply-now economics
    // (search "applyNowSize" in dashboard-server.mjs).
    const companies = new Set();
    for (const row of ranked) {
      if (row._dropped) continue;
      const score = Number(row.eval_score || row.score || 0);
      if (score < 4.0) continue;
      const co = String(row.company || '').trim();
      if (co) companies.add(co.toLowerCase());
    }
    if (companies.size === 0) {
      console.warn('[build-contacts-page] apply-now-queue.json has no rows ≥4.0 — falling back');
      return KNOWN_ALIASES;
    }
    // Merge with alias map. Each entry → { slug: [aliases] }.
    const out = {};
    for (const co of companies) {
      // Find any KNOWN_ALIASES entry whose aliases include this company (or a substring of it).
      let knownSlug = null;
      for (const [slug, aliases] of Object.entries(KNOWN_ALIASES)) {
        if (aliases.some((a) => co.includes(a) || a.includes(co))) {
          knownSlug = slug;
          break;
        }
      }
      const slug = knownSlug || slugify(co);
      if (!out[slug]) out[slug] = knownSlug ? KNOWN_ALIASES[knownSlug].slice() : [];
      if (!out[slug].includes(co)) out[slug].push(co);
    }
    console.log(`[build-contacts-page] target-company list sourced from apply-now-queue.json: ${Object.keys(out).length} companies`);
    return out;
  } catch (e) {
    console.warn('[build-contacts-page] failed to parse apply-now-queue.json:', e.message);
    return KNOWN_ALIASES;
  }
}

const TARGET_COMPANY_ALIASES = loadTargetCompanies();

function isTargetCompany(c) {
  const co = String(c.company || '').toLowerCase().trim();
  if (!co) return false;
  for (const slug of Object.keys(TARGET_COMPANY_ALIASES)) {
    for (const alias of TARGET_COMPANY_ALIASES[slug]) {
      if (co.includes(alias)) return slug;
    }
  }
  return false;
}

function isWarmToApplyNow(c) {
  // The contacts.html embedded ALL_DATA has limited warm signal — for now,
  // we approximate by checking if there's any others_at_company or
  // two_degree_path pointing at a target.
  if (!c.others_at_company?.length && !c.two_degree_path?.candidate_count) return false;
  const slug = isTargetCompany(c);
  return Boolean(slug);
}

function lastTouchedDays(c) {
  if (!c.last_touch_ts) return Infinity;
  const ts = Date.parse(c.last_touch_ts);
  if (isNaN(ts)) return Infinity;
  return Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
}

// Annotate contacts with computed fields (used by sort + filter logic in browser).
const annotated = contacts.map((c) => ({
  ...c,
  _tier: computeEnrichmentTier(c),
  _target_slug: isTargetCompany(c) || null,
  _is_warm_apply_now: isWarmToApplyNow(c),
  _last_touched_days: lastTouchedDays(c),
}));

const tierCounts = { 1: 0, 2: 0, 3: 0 };
const targetCounts = {};
let inOutreachCount = 0;
let warmToApplyNowCount = 0;
annotated.forEach((c) => {
  tierCounts[c._tier]++;
  if (c.in_outreach) inOutreachCount++;
  if (c._is_warm_apply_now) warmToApplyNowCount++;
  if (c._target_slug) targetCounts[c._target_slug] = (targetCounts[c._target_slug] || 0) + 1;
});

console.log(`[build-contacts-page] tiers: T3=${tierCounts[3]} T2=${tierCounts[2]} T1=${tierCounts[1]}; warm-to-apply-now=${warmToApplyNowCount}; in-outreach=${inOutreachCount}`);

// Emit the resolved target-company list to a runtime JSON file so other
// surfaces (network-database.html, future filter-harmonization) can consume
// the same source-of-truth. Keyed by slug, values = { aliases, count }.
const targetListPath = join(REPO_ROOT, 'dashboard/data/apply-now-targets.json');
const targetListPayload = {
  generated_at: new Date().toISOString(),
  source: 'data/apply-now-queue.json (rows with eval_score|score ≥ 4.0)',
  targets: Object.fromEntries(
    Object.entries(TARGET_COMPANY_ALIASES).map(([slug, aliases]) => [
      slug,
      { aliases, count: targetCounts[slug] || 0 },
    ])
  ),
};
try {
  writeFileSync(targetListPath, JSON.stringify(targetListPayload, null, 2));
  console.log(`[build-contacts-page] wrote ${targetListPath} (${Object.keys(targetListPayload.targets).length} targets)`);
} catch (e) {
  console.warn('[build-contacts-page] failed to write apply-now-targets.json:', e.message);
}

// ---------------------------------------------------------------------------
// 2026-05-20 — P0.1 dual-corpus refactor (Phase 2 of the "deferred to a
// separate PR" Phase 2 from the freshness IIFE comment). Emit a companion
// JSON file with the four computed annotation fields baked in, so the
// browser can render cards client-side without re-doing tier/target/warm
// computation that depends on Node-only data (apply-now-queue.json,
// TARGET_COMPANY_ALIASES). Browser fetches this instead of contacts.json
// so it gets the same data the build-time renderCard saw.
// ---------------------------------------------------------------------------
const annotatedPath = join(REPO_ROOT, 'dashboard/data/contacts-annotated.json');
const annotatedPayload = {
  generated_at: new Date().toISOString(),
  contacts: annotated,
  stats: {
    total: contacts.length,
    tier1: tierCounts[1],
    tier2: tierCounts[2],
    tier3: tierCounts[3],
    warm_to_apply_now: warmToApplyNowCount,
    in_outreach: inOutreachCount,
    target_counts: targetCounts,
  },
};
try {
  writeFileSync(annotatedPath, JSON.stringify(annotatedPayload));
  console.log(`[build-contacts-page] wrote ${annotatedPath} (${annotated.length} annotated contacts)`);
} catch (e) {
  console.warn('[build-contacts-page] failed to write contacts-annotated.json:', e.message);
}

// ---------------------------------------------------------------------------
// Page CSS — page-specific styles that complement the shell.
// ---------------------------------------------------------------------------

const pageCSS = `
.contacts-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 18px;
  flex-wrap: wrap;
  gap: 12px;
}
.contacts-header h1 { margin: 0; font-size: 22px; font-weight: 700; }
.contacts-header .stats {
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.contacts-header .stats strong { color: var(--text); font-weight: 700; }

/* ── BRAVO followup Item 8 / AA-4 — clickable stat tiles ──────────── */
.stat-tile {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
  font-family: inherit;
}
.stat-tile strong { color: var(--text); font-weight: 700; }
.stat-tile:hover {
  background: var(--surface);
  border-color: var(--border);
}
.stat-tile:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.stat-tile[aria-pressed="true"] {
  background: var(--blue-bg);
  border-color: var(--blue-fg);
  color: var(--blue-fg);
}
.stat-tile[aria-pressed="true"] strong { color: var(--blue-fg); }

/* Progress bar — empty-corpus transparency */
.contacts-progress {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--amber-fg);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--text-2);
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  line-height: 1.4;
}
.contacts-progress strong { color: var(--text); }
.contacts-progress .progress-cta {
  margin-left: auto;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 5px 12px;
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.contacts-progress .progress-cta:hover { background: var(--border); }
.contacts-progress .progress-cta.active {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-border);
}

/* BRAVO followup 2026-05-20 Item 4 — live data freshness chip. */
.contacts-freshness {
  font-size: 11px;
  color: var(--text-2);
  padding: 6px 12px;
  margin: -6px 0 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-3);
  border-radius: var(--radius-sm);
  display: inline-block;
}
.contacts-freshness[data-state="live"] { border-left-color: var(--green-fg); }
.contacts-freshness[data-state="stale"] { border-left-color: var(--amber-fg); color: var(--amber-fg); }

/* Filter chip row */
.controls {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
  align-items: center;
}
.controls input[type="search"] {
  flex: 1 1 280px;
  min-width: 220px;
  padding: 8px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.controls input[type="search"]:focus {
  outline: none;
  border-color: var(--blue-fg);
  box-shadow: 0 0 0 3px var(--blue-bg);
}
.filters-row {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  flex-wrap: wrap;
  align-items: center;
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background .12s, color .12s, border-color .12s;
}
.filter-chip:hover { color: var(--text); border-color: var(--text-3); }
.filter-chip.active,
.filter-chip[aria-pressed="true"] {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-border);
  font-weight: 600;
}
.filter-chip[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
.filter-chip-count {
  font-size: 10.5px;
  background: rgba(0,0,0,0.2);
  padding: 1px 5px;
  border-radius: 99px;
  color: inherit;
}
.filter-chip.active .filter-chip-count { background: rgba(255,255,255,0.18); }

/* Multi-select dropdown chip (target companies) */
.filter-dropdown {
  position: relative;
  display: inline-block;
}
.filter-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 10px 32px rgba(0,0,0,0.45);
  padding: 6px;
  z-index: 100;
  display: none;
  max-height: 320px;
  overflow-y: auto;
}
.filter-dropdown.open .filter-dropdown-menu { display: block; }
.filter-dropdown-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--text-2);
}
.filter-dropdown-option:hover { background: var(--surface-2); color: var(--text); }
.filter-dropdown-option input { margin: 0; }
.filter-dropdown-option-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-4);
  background: var(--surface-2);
  padding: 1px 6px;
  border-radius: 99px;
}

/* Sort + view toggle */
.controls-trailing {
  display: flex;
  gap: 6px;
  margin-left: auto;
  align-items: center;
}
.sort-dropdown {
  position: relative;
}
.sort-dropdown-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.sort-dropdown-trigger:hover { color: var(--text); border-color: var(--text-3); }
.sort-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 220px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 10px 32px rgba(0,0,0,0.45);
  padding: 4px;
  z-index: 100;
  display: none;
}
.sort-dropdown.open .sort-dropdown-menu { display: block; }
.sort-dropdown-option {
  display: block;
  padding: 7px 10px;
  border-radius: 4px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  border: 0;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
}
.sort-dropdown-option:hover { background: var(--surface-2); color: var(--text); }
.sort-dropdown-option.active { color: var(--blue-fg); font-weight: 600; }
.sort-dropdown-option-hint {
  display: block;
  font-size: 10.5px;
  color: var(--text-4);
  margin-top: 2px;
}

/* View switcher (Cards | Table) */
.view-switcher {
  display: inline-flex;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  padding: 2px;
  gap: 2px;
}
.view-switcher a, .view-switcher button {
  padding: 4px 10px;
  border-radius: var(--radius-full);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  text-decoration: none;
}
.view-switcher a.active,
.view-switcher button.active {
  background: var(--blue-bg);
  color: var(--blue-fg);
}
.view-switcher a:hover, .view-switcher button:hover { color: var(--text); }

.meta-line {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 12px;
}

/* Grid */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 14px;
}

/* ── Contact card rules ─────────────────────────────────────────── */
.contact-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  transition: border-color .12s, background .12s;
}
.contact-card:hover { border-color: var(--text-3); background: var(--surface); }
.contact-card-head { display: flex; gap: 14px; align-items: flex-start; }
.contact-card-avatar { width: 60px; height: 60px; flex-shrink: 0; position: relative; }
.contact-card-photo {
  width: 60px; height: 60px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border);
}
.contact-card-photo-fallback {
  width: 60px; height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--blue-bg), var(--surface-2));
  color: var(--text-2);
  font-weight: 700;
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
}
.contact-card-identity { flex: 1 1 auto; min-width: 0; }
.contact-card-name {
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 3px;
}
.contact-card-role { font-size: 13px; color: var(--text-3); }
.contact-card-company { color: var(--text-2); font-weight: 500; }
.contact-card-connected { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
.contact-card-goals {
  font-size: 11px;
  margin-top: 6px;
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
}
.contact-card-section-label {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-4);
  margin-right: 8px;
  display: inline-block;
}
.contact-card-overlap,
.contact-card-others,
.contact-card-twodeg {
  font-size: 12.5px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
}
.contact-card-overlap { border-left: 3px solid var(--green-fg); }
.contact-card-overlap-item {
  font-weight: 600;
  color: var(--text);
  margin-right: 10px;
}
.contact-card-others-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.contact-card-other-btn {
  text-align: left;
  background: none;
  border: 0;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-family: inherit;
}
.contact-card-other-btn:hover { background: var(--surface-2); }
.contact-card-twodeg-count { color: var(--green-fg); font-weight: 600; }
.contact-card-enriched {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--blue-bg);
  border-left: 3px solid var(--blue-fg);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.contact-card-enriched p {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text);
}
.contact-card-enrich-pending {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px dashed var(--border);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}
.contact-card-emails {
  font-size: 12px;
  padding: 6px 0;
  border-top: 1px dashed var(--border);
}
.contact-card-email-label {
  font-weight: 600;
  color: var(--text-3);
  margin-right: 4px;
}
.contact-card-emails code {
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
}
.contact-card-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.contact-act {
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  text-decoration: none;
  font-family: inherit;
}
.contact-act:hover { color: var(--text); border-color: var(--text-3); text-decoration: none; }
.contact-act-enrich,
.contact-act-photo {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-border);
  font-weight: 600;
}
.contact-act-disabled { opacity: 0.4; cursor: not-allowed; }
.muted-text { color: var(--text-3); }
.pill-tiny {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-3);
  margin-right: 4px;
}
.pill-tiny.pill-preipo {
  background: var(--green-bg);
  color: var(--green-fg);
  border-color: var(--green-fg);
}
.pill-tiny.pill-archetype {
  background: var(--amber-bg);
  color: var(--amber-fg);
  border-color: var(--amber-fg);
}
.pill-tiny.pill-outreach {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-fg);
}
.pill-tiny.pill-tier-3 {
  background: var(--green-bg);
  color: var(--green-fg);
  border-color: var(--green-fg);
}
.pill-tiny.pill-tier-2 {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-fg);
}
.pill-tiny.pill-tier-1 {
  background: var(--surface);
  color: var(--text-4);
  border-color: var(--border);
}
.contact-card.contact-card-flash {
  box-shadow: 0 0 0 2px var(--amber-fg);
  transition: box-shadow 0.6s ease-out;
}

/* Compact stub card — dense one-line treatment */
.contact-card.is-stub-compact {
  padding: 6px 12px;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.contact-card.is-stub-compact .contact-card-head { gap: 8px; align-items: center; }
.contact-card.is-stub-compact .contact-card-avatar { width: 28px; height: 28px; }
.contact-card.is-stub-compact .contact-card-photo,
.contact-card.is-stub-compact .contact-card-photo-fallback {
  width: 28px; height: 28px; font-size: 11px;
}
.contact-card.is-stub-compact .contact-card-name {
  font-size: 12.5px;
  margin: 0;
}
.contact-card.is-stub-compact .contact-card-role {
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.contact-card.is-stub-compact .contact-card-connected,
.contact-card.is-stub-compact .contact-card-goals,
.contact-card.is-stub-compact .contact-card-overlap,
.contact-card.is-stub-compact .contact-card-others,
.contact-card.is-stub-compact .contact-card-twodeg,
.contact-card.is-stub-compact .contact-card-enrich-pending,
.contact-card.is-stub-compact .contact-card-emails {
  display: none;
}
.contact-card.is-stub-compact .contact-card-actions {
  padding-top: 0;
  border-top: 0;
  margin-left: auto;
}
.contact-card.is-stub-compact .contact-act {
  padding: 3px 8px;
  font-size: 10.5px;
}

/* ── BRAVO followup Item 6 / AA-7 — enrichment confirmation modal ─── */
.enrich-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  z-index: 10001;
  display: none;
  align-items: center;
  justify-content: center;
}
.enrich-modal-backdrop.visible { display: flex; }
.enrich-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  padding: 24px 28px;
  max-width: 480px;
  width: 90%;
  color: var(--text);
  box-shadow: 0 20px 60px rgba(0,0,0,0.4);
}
.enrich-modal h2 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}
.enrich-modal-body {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-2);
  margin: 0 0 18px;
}
.enrich-modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.enrich-modal-cancel,
.enrich-modal-confirm {
  padding: 9px 16px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border);
  cursor: pointer;
}
.enrich-modal-cancel {
  background: var(--surface-2);
  color: var(--text-2);
}
.enrich-modal-cancel:hover { background: var(--border); }
.enrich-modal-confirm {
  background: var(--blue-bg);
  color: var(--blue-fg);
  border-color: var(--blue-fg);
}
.enrich-modal-confirm:hover { filter: brightness(1.1); }
.enrich-modal-cancel:focus-visible,
.enrich-modal-confirm:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* ── BRAVO followup Item 7 / AA-3 — J/K card navigation ───────────── */
.contact-card[tabindex] { outline: none; }
.contact-card[tabindex]:focus-visible {
  outline: 2px solid var(--blue-fg);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(100,116,139,0.18);
}
.contact-card.contact-card-jk-active {
  border-color: var(--blue-fg);
  background: var(--surface);
}

/* When compact-mode is on (Show all stubs toggled), STUBS render as
   single-column dense rows but enriched cards KEEP their multi-col rhythm.
   2026-05-20 — BRAVO followup Item 3 / AAA-5: the previous instance collapsed
   the whole grid to 1fr which stretched enriched cards to full width on wide
   viewports. Now only stub cards span the full row via grid-column: 1 / -1. */
.grid.compact-stubs {
  /* Keep the auto-fill multi-col grid; gap shrinks slightly so stub rows pack
     denser, but enriched cards still flow as 2+ columns at 1440px. */
  gap: 8px;
}
.grid.compact-stubs .contact-card.is-stub-compact {
  grid-column: 1 / -1;
  margin-top: 0;
}
.grid.compact-stubs .contact-card:not(.is-stub-compact) {
  /* Enriched cards keep their multi-col rhythm — no override needed since
     the grid container still uses auto-fill minmax(420px, 1fr). */
}

/* Result meta + empty state */
.result-empty {
  text-align: center;
  padding: 40px 24px;
  color: var(--text-3);
  font-size: 13.5px;
}
.result-empty strong { color: var(--text); }

/* ── P0.1 dual-corpus refactor 2026-05-20 — skeleton + shimmer ─────── */
.contact-card-skel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius, 10px);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 132px;
}
.skel-row-head { display: flex; gap: 12px; align-items: center; }
.skel-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
}
.skel-identity { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.skel-line {
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg,
    var(--border) 0%,
    var(--surface-2, var(--border)) 50%,
    var(--border) 100%);
  background-size: 200% 100%;
  animation: contacts-skel-shimmer 1.4s ease-in-out infinite;
}
.skel-line-name { width: 60%; height: 14px; }
.skel-line-role { width: 80%; }
.skel-line-detail { width: 95%; }
.skel-line-detail.short { width: 55%; }
@keyframes contacts-skel-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .skel-line { animation: none; }
}
/* Hide skeletons once real cards render. */
.grid[data-render-state="ready"] .contact-card-skel { display: none; }
/* Render-state chip on the freshness banner */
.contacts-render-chip {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: var(--radius-sm, 6px);
  font-size: 11px;
  background: var(--surface);
  color: var(--text-3);
  border: 1px solid var(--border);
}

@media (max-width: 720px) {
  .grid { grid-template-columns: 1fr; }
  .controls-trailing { width: 100%; justify-content: flex-end; flex-wrap: wrap; }
}
`;

// ---------------------------------------------------------------------------
// Card render — kept compatible with existing schema, with tier annotations.
// ---------------------------------------------------------------------------

function gracefulInitial(name) {
  // Handle surrogate pairs + missing names per audit AA-5
  const chars = Array.from(String(name || ''));
  return (chars[0] || '?').toUpperCase();
}

function renderCard(c) {
  const name = c.name || '';
  const company = c.company || '';
  const position = c.position || '';
  const email = c.email_professional || '';
  const personalEmail = c.email_personal || '';
  const linkedinUrl = c.linkedin_url || '';
  const xHandle = c.x_handle || '';
  const tierBadge = c.tier ? `<span class="pill-tiny">${esc(c.tier)}</span>` : '';
  const outreachBadge = c.in_outreach ? '<span class="pill-tiny pill-outreach">in outreach</span>' : '';
  const tierIndicator = c._tier
    ? `<span class="pill-tiny pill-tier-${c._tier}" title="Enrichment tier ${c._tier}">T${c._tier}</span>`
    : '';

  // Avatar — graceful fallback for one-part / surrogate-pair names
  let photoHtml;
  const initials = gracefulInitial(c.first_name) + gracefulInitial(c.last_name);
  const initialsTrimmed = initials.length === 2 ? initials : (initials.length === 1 ? initials : '?');
  if (c.photo_path) {
    photoHtml = `<img class="contact-card-photo" src="${esc(c.photo_path)}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="contact-card-photo-fallback" style="display:none">${esc(initialsTrimmed)}</div>`;
  } else {
    photoHtml = `<div class="contact-card-photo-fallback">${esc(initialsTrimmed)}</div>`;
  }

  const overlapHtml = (c.overlap_with_mitchell && c.overlap_with_mitchell.length) ?
    `<div class="contact-card-overlap"><span class="contact-card-section-label">↗ Shared employer</span>${c.overlap_with_mitchell.map(o => `<span class="contact-card-overlap-item">${esc(o.company)} <span class="muted-text">(${esc(o.mitchell_years)})</span></span>`).join('')}</div>` : '';

  const othersHtml = (c.others_at_company && c.others_at_company.length) ?
    `<div class="contact-card-others"><span class="contact-card-section-label">Other contacts at ${esc(company)} (${c.others_at_company.length})</span><div class="contact-card-others-list">${c.others_at_company.slice(0,6).map(o => {
      const pill = o.in_outreach ? '<span class="pill-tiny pill-outreach">in outreach</span>' : '';
      const aMatch = o.archetype_match ? '<span class="pill-tiny pill-archetype">★</span>' : '';
      return `<button type="button" class="contact-card-other-btn" onclick="focusById('${esc(o.id)}')">${esc(o.name)} <span class="muted-text">${esc((o.position||'').slice(0,28))}</span> ${aMatch}${pill}</button>`;
    }).join('')}${c.others_at_company.length > 6 ? `<span class="muted-text">+${c.others_at_company.length - 6} more</span>` : ''}</div></div>` : '';

  const twoDegHtml = (c.two_degree_path && c.two_degree_path.candidate_count > 0) ?
    `<div class="contact-card-twodeg"><span class="contact-card-section-label">2nd-degree paths at ${esc(company)}</span><span class="contact-card-twodeg-count">${c.two_degree_path.candidate_count} warm-intro candidates</span></div>` : '';

  let goalHtml = '';
  if (c.goal_alignment) {
    const ga = c.goal_alignment;
    const marks = [];
    if (ga.pre_ipo_match) marks.push('<span class="pill-tiny pill-preipo">pre-IPO</span>');
    if (ga.archetype_match) marks.push('<span class="pill-tiny pill-archetype">archetype-match</span>');
    if (marks.length) {
      goalHtml = `<div class="contact-card-goals">${marks.join('')} <span class="muted-text">alignment ${ga.composite_score}</span></div>`;
    }
  }

  let connectedHtml = '';
  if (c.connected_on || c.position_at_connection) {
    connectedHtml = `<div class="contact-card-connected muted-text">Connected ${c.connected_on ? esc(c.connected_on) : 'date unknown'}${c.position_at_connection ? ' as ' + esc(c.position_at_connection) : ''}</div>`;
  }

  let enrichHtml;
  if (c.enrichment_status === 'complete' && c.outreach_recommendation) {
    enrichHtml = `<div class="contact-card-enriched">${c.outreach_recommendation.positioning ? `<div><span class="contact-card-section-label">Positioning recommendation</span><p>${esc(c.outreach_recommendation.positioning)}</p></div>` : ''}${c.outreach_recommendation.best_channel ? `<div><span class="contact-card-section-label">Best channel</span> ${esc(c.outreach_recommendation.best_channel)}</div>` : ''}${(c.engagement && c.engagement.linkedin_topics) ? `<div><span class="contact-card-section-label">Engages with</span> ${(c.engagement.linkedin_topics||[]).map(t=>`<span class="pill-tiny">${esc(t)}</span>`).join('')}</div>` : ''}${(c.inferred_relationship && c.inferred_relationship.arc) ? `<div><span class="contact-card-section-label">Relationship context</span><p class="muted-text">${esc(c.inferred_relationship.arc)}</p></div>` : ''}</div>`;
  } else {
    enrichHtml = `<div class="contact-card-enrich-pending"><span class="muted-text">Engagement topics, outreach positioning, and inferred relationship context pending LLM enrichment.</span> <button type="button" class="contact-act contact-act-enrich" onclick="enrichNow('${esc(c.id)}')">↻ Enrich now</button></div>`;
  }

  const emailAction = (addr, type) => {
    if (!addr) return `<button class="contact-act contact-act-disabled" disabled>${esc(type)} ✉︎</button>`;
    return `<button class="contact-act" onclick="revealEmail(this, '${esc(addr)}')">${esc(type)} →</button>`;
  };
  const linkedinAction = linkedinUrl
    ? `<a class="contact-act" href="${esc(linkedinUrl)}" target="_blank" rel="noopener noreferrer">LinkedIn →</a>`
    : '<button class="contact-act contact-act-disabled" disabled>LinkedIn</button>';
  const xAction = xHandle
    ? `<a class="contact-act" href="https://x.com/${esc(String(xHandle).replace(/^@/,''))}" target="_blank" rel="noopener noreferrer">X →</a>`
    : '<button class="contact-act contact-act-disabled" disabled>X</button>';
  const photoBtn = c.photo_path
    ? ''
    : `<button type="button" class="contact-act contact-act-photo" onclick="scrapePhoto('${esc(c.id)}','${esc(linkedinUrl)}')">📸 Photo</button>`;

  return `<article class="contact-card" id="contact-card-${esc(c.id)}" tabindex="0" aria-label="${esc(name)} — ${esc(position || 'role unknown')} at ${esc(company || 'company unknown')}" data-tier="${c._tier}" data-target="${esc(c._target_slug||'')}" data-warm-apply-now="${c._is_warm_apply_now?1:0}" data-in-outreach="${c.in_outreach?1:0}" data-has-email="${email?1:0}" data-warm-strength="${c.warm_path_strength||0}" data-last-touched-days="${c._last_touched_days===Infinity?9999:c._last_touched_days}">
    <div class="contact-card-head">
      <div class="contact-card-avatar">${photoHtml}</div>
      <div class="contact-card-identity">
        <div class="contact-card-name">${esc(name)} ${tierIndicator} ${tierBadge} ${outreachBadge}</div>
        <div class="contact-card-role">${esc(position || '—')}${company ? ` · <span class="contact-card-company">${esc(company)}</span>` : ''}</div>
        ${connectedHtml}
        ${goalHtml}
      </div>
    </div>
    ${overlapHtml}
    ${othersHtml}
    ${twoDegHtml}
    ${enrichHtml}
    ${email || personalEmail ? `<div class="contact-card-emails">${email ? `<span class="contact-card-email-label">Pro:</span> <code>${esc(email)}</code>` : ''}${personalEmail ? ` <span class="contact-card-email-label">Personal:</span> <code>${esc(personalEmail)}</code>` : ''}</div>` : ''}
    <div class="contact-card-actions">
      ${emailAction(email, 'Pro')}
      ${emailAction(personalEmail, 'Personal')}
      ${linkedinAction}
      ${xAction}
      ${photoBtn}
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Build main HTML
// ---------------------------------------------------------------------------

const totalT3 = tierCounts[3];
const totalT2 = tierCounts[2];
const totalT1 = tierCounts[1];
const totalContacts = annotated.length;
const enrichedRate = ((totalT3 + totalT2) / totalContacts * 100).toFixed(1);

// 2026-05-20 — P0.1 dual-corpus refactor. Cards are now rendered CLIENT-SIDE
// from /data/contacts-annotated.json. The initial bake has been replaced with
// 50 skeleton placeholders that shimmer until the fetch resolves. This drops
// contacts.html from ~5.66 MB to a thin shell (~110-180 KB).
const SKELETON_COUNT = 50;
const skeletonHtml = Array.from({ length: SKELETON_COUNT }, () =>
  '<article class="contact-card-skel" aria-hidden="true"><div class="skel-row-head"><div class="skel-avatar"></div><div class="skel-identity"><div class="skel-line skel-line-name"></div><div class="skel-line skel-line-role"></div></div></div><div class="skel-line skel-line-detail"></div><div class="skel-line skel-line-detail short"></div></article>'
).join('');

// Build the target-companies dropdown options — sorted by warm-contact count
// (descending) so the most useful targets surface first. The label comes from
// the canonical company name (longest alias entry, title-cased), with a small
// override map for the known display-name remaps (anysphere → Cursor, etc.).
const DISPLAY_NAME_OVERRIDES = {
  anysphere: 'Cursor (Anysphere)',
  elevenlabs: 'ElevenLabs',
  'mistral ai': 'Mistral AI',
  openai: 'OpenAI',
  langchain: 'LangChain',
};

const targetCompaniesHtml = Object.entries(TARGET_COMPANY_ALIASES)
  .map(([slug, aliases]) => ({
    slug,
    count: targetCounts[slug] || 0,
    label: DISPLAY_NAME_OVERRIDES[slug]
      || aliases.reduce((longest, a) => a.length > longest.length ? a : longest, slug)
        .replace(/\b\w/g, (c) => c.toUpperCase()),
  }))
  .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
  .map(({ slug, count, label }) => `<label class="filter-dropdown-option">
    <input type="checkbox" data-target-company="${esc(slug)}" />
    <span>${esc(label)}</span>
    <span class="filter-dropdown-option-count">${count}</span>
  </label>`)
  .join('\n');

const mainHTML = `
  <div class="contacts-header">
    <div>
      <h1>Network <span class="muted-text" style="font-weight:400;font-size:14px;margin-left:8px">relationship intelligence</span></h1>
    </div>
    <!-- BRAVO followup Item 8 / AA-4 — clickable stat tiles.
         Each tile is a button mapping to a filter preset:
         total → clear all filters; with signal → toggle Has email + Tier 3/2;
         warm targets → toggle Warm to Apply-Now; in outreach → toggle In outreach. -->
    <div class="stats" role="group" aria-label="Network corpus stats — click a tile to apply that filter">
      <button type="button" class="stat-tile" data-stat-filter="all" aria-label="Show all contacts — clear filters" aria-pressed="false">
        <strong>${totalContacts}</strong> contacts
      </button>
      <button type="button" class="stat-tile" data-stat-filter="signal" aria-label="Filter to contacts with signal (email or full enrichment)" aria-pressed="false">
        <strong>${totalT3 + totalT2}</strong> with signal <span class="muted-text">(${enrichedRate}%)</span>
      </button>
      <button type="button" class="stat-tile" data-stat-filter="warm-apply-now" aria-label="Filter to warm contacts at apply-now target companies" aria-pressed="false">
        <strong>${warmToApplyNowCount}</strong> warm to apply-now targets
      </button>
      <button type="button" class="stat-tile" data-stat-filter="outreach" aria-label="Filter to contacts currently in outreach" aria-pressed="false">
        <strong>${inOutreachCount}</strong> in outreach
      </button>
    </div>
  </div>

  <div class="contacts-progress" role="status" aria-live="polite">
    <div>
      <strong>${totalT2}</strong> with email + <strong>${totalT3}</strong> fully enriched = <strong>${totalT2 + totalT3}</strong> usable now of <strong>${totalContacts}</strong> total.
      <span class="muted-text">Enriching ~50/day via LinkedIn scrape. ETA ~${Math.ceil(totalT1 / 50)} days.</span>
    </div>
    <button type="button" class="progress-cta" id="toggle-stubs" aria-pressed="false" title="Show or hide the ${totalT1} unenriched stub cards">
      Show all (${totalT1} stubs hidden)
    </button>
  </div>
  <!-- BRAVO followup 2026-05-20 Item 4 — live data freshness chip. Painted
       by the hydration JS at the bottom of pageJS. data-state values:
       'live' (post-fetch) | 'stale' (fetch failed). -->
  <div class="contacts-freshness" id="contacts-freshness" data-state="loading" role="status" aria-live="polite">Loading live data…</div>
  <script>window.__CONTACTS_BAKED_AT__=${JSON.stringify(new Date().toISOString())};</script>

  <div class="controls" role="search">
    <input id="contacts-search" type="search"
      placeholder="Search name / company / role / email — try ‘company:openai tier:3+’ — / to focus"
      autocomplete="off" spellcheck="false"
      aria-label="Search contacts (supports company:X, tier:N+, outreach:active, warm:>=N, email:yes tokens)" />
    <div class="controls-trailing">
      <div class="view-switcher" role="group" aria-label="View mode">
        <a href="/contacts.html" class="active" aria-current="page">Cards</a>
        <a href="/network-database.html">Table</a>
      </div>
      <div class="sort-dropdown" id="sort-dropdown">
        <button type="button" class="sort-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false" id="sort-trigger" onclick="toggleSortDropdown()">
          Sort: <span id="sort-label">Opportunity</span> ▾
        </button>
        <div class="sort-dropdown-menu" role="listbox">
          <button type="button" class="sort-dropdown-option active" data-sort="opportunity" onclick="setSort('opportunity','Opportunity')">
            Opportunity Score <span class="sort-dropdown-option-hint">warm to apply-now ×5 + target ×3 + warm ≥3 ×2 + email ×1 + tier-3 ×2</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="warm" onclick="setSort('warm','Warm path')">
            Warm path strength <span class="sort-dropdown-option-hint">highest first</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="touched" onclick="setSort('touched','Last touched')">
            Last touched <span class="sort-dropdown-option-hint">most recent first</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="connected" onclick="setSort('connected','Connected')">
            Connected on <span class="sort-dropdown-option-hint">most recent first</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="tier" onclick="setSort('tier','Tier')">
            Enrichment tier <span class="sort-dropdown-option-hint">3 → 2 → 1</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="name" onclick="setSort('name','Name')">
            Name <span class="sort-dropdown-option-hint">A → Z</span>
          </button>
          <button type="button" class="sort-dropdown-option" data-sort="richness" onclick="setSort('richness','Data richness')">
            Data richness <span class="sort-dropdown-option-hint">most populated fields first</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="filters-row" role="group" aria-label="Filter chips — stackable, AND semantics">
    <button type="button" class="filter-chip" data-filter="warm-apply-now" aria-pressed="false" title="Filter: warm path to a company in the apply-now queue">
      🎯 Warm to Apply-Now <span class="filter-chip-count">${warmToApplyNowCount}</span>
    </button>
    <div class="filter-dropdown" id="target-dropdown">
      <button type="button" class="filter-chip" id="target-dropdown-trigger" aria-haspopup="true" aria-expanded="false" onclick="toggleTargetDropdown()" title="Filter by target company (multi-select)">
        🏢 Target company <span class="filter-chip-count" id="target-selected-count">0</span> ▾
      </button>
      <div class="filter-dropdown-menu" role="group" aria-label="Target companies — multi-select (OR within facet, AND across facets)">
        ${targetCompaniesHtml}
      </div>
    </div>
    <button type="button" class="filter-chip" data-filter="email" aria-pressed="false" title="Has professional email">✉ Has email</button>
    <button type="button" class="filter-chip" data-filter="outreach" aria-pressed="false" title="Currently in outreach">💬 In outreach</button>
    <button type="button" class="filter-chip" data-filter="warm-strong" aria-pressed="false" title="Warm path strength ≥3">🔥 Warm ≥3</button>
    <button type="button" class="filter-chip" data-filter="tier-3" aria-pressed="false" title="Fully enriched (signal density ≥2)">🪪 Tier 3</button>
    <button type="button" class="filter-chip" data-filter="tier-2" aria-pressed="false" title="Has email (Tier 2)">🪪 Tier 2</button>
    <button type="button" class="filter-chip" data-filter="tier-1" aria-pressed="false" title="Stub (no enrichment)">🪪 Tier 1</button>
    <button type="button" class="filter-chip" data-filter="touched-30d" aria-pressed="false" title="Touched in last 30 days">⏱ Touched 30d</button>
    <button type="button" class="filter-chip" data-filter="degree-1" aria-pressed="false" title="1st-degree connection">1️⃣ 1st-deg</button>
    <button type="button" class="filter-chip" data-filter="archetype" aria-pressed="false" aria-disabled="${tierCounts[3] === 0 ? 'true' : 'false'}" title="${tierCounts[3] === 0 ? 'Filter unavailable — no archetype data populated yet (depends on enrichment)' : 'Archetype-match contacts'}">★ Archetype</button>
    <button type="button" class="filter-chip" data-filter="preipo" aria-pressed="false" aria-disabled="${tierCounts[3] === 0 ? 'true' : 'false'}" title="${tierCounts[3] === 0 ? 'Filter unavailable — no pre-IPO data populated yet (depends on enrichment)' : 'Pre-IPO match'}">💎 Pre-IPO</button>
    <button type="button" class="filter-chip" id="clear-filters" data-clear="1" style="margin-left:auto" title="Clear all filters">✕ Clear</button>
  </div>

  <div class="meta-line" id="result-meta" aria-live="polite"></div>

  <div class="grid" id="grid" data-render-state="skeleton">
    ${skeletonHtml}
  </div>

  <div class="result-empty" id="result-empty" hidden>
    <strong>No contacts match your filters.</strong>
    <div class="muted-text" style="margin-top:6px">Try clearing filters, or toggle "Show all stubs" if you're searching for an unenriched contact.</div>
  </div>
`;

// ---------------------------------------------------------------------------
// Page-specific JS (filter + sort + token-search). Lives below the shell JS.
// ---------------------------------------------------------------------------

const pageJS = `
<script>
/* ════════════════════════════════════════════════════════════════════
 * P0.1 — Dual-corpus client-side rendering (2026-05-20)
 *
 * Skeleton placeholders ship in the initial HTML; this script fetches
 * /data/contacts-annotated.json, hydrates the grid, and only THEN
 * calls initContactsPage() to bind filter/sort/keyboard handlers.
 * localStorage cache (TTL 1h, keyed by generated_at) makes the warm
 * load instant.
 *
 * Browser renderCard uses string concatenation (NOT template literals)
 * because the entire pageJS lives inside an outer template-literal in
 * build-contacts-page.mjs — inner dollar-brace would interpolate at
 * build time and inner backticks would close the outer template (see
 * CLAUDE.md outer-template-unescape bug class).
 * ════════════════════════════════════════════════════════════════════ */
function _esBC(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function _giBC(name) {
  var chars = Array.from(name == null ? '' : String(name));
  return (chars[0] || '?').toUpperCase();
}

// Browser-side renderCard — mirror of Node renderCard at scripts/build-contacts-page.mjs:961
// Maintain byte-for-byte structural parity with the Node version so all
// downstream selectors (filter chips, sort dropdown, J/K nav) keep working.
function _rcBC(c) {
  var name = c.name || '';
  var company = c.company || '';
  var position = c.position || '';
  var email = c.email_professional || '';
  var personalEmail = c.email_personal || '';
  var linkedinUrl = c.linkedin_url || '';
  var xHandle = c.x_handle || '';
  var initials = _giBC(c.first_name) + _giBC(c.last_name);
  var initialsTrimmed = initials.length === 2 ? initials : (initials.length === 1 ? initials : '?');

  var tierBadge = c.tier ? ('<span class="pill-tiny">' + _esBC(c.tier) + '</span>') : '';
  var outreachBadge = c.in_outreach ? '<span class="pill-tiny pill-outreach">in outreach</span>' : '';
  var tierIndicator = c._tier
    ? ('<span class="pill-tiny pill-tier-' + c._tier + '" title="Enrichment tier ' + c._tier + '">T' + c._tier + '</span>')
    : '';

  var photoHtml;
  if (c.photo_path) {
    photoHtml = '<img class="contact-card-photo" src="' + _esBC(c.photo_path) + '" alt="' + _esBC(name) + '" loading="lazy" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\'" /><div class="contact-card-photo-fallback" style="display:none">' + _esBC(initialsTrimmed) + '</div>';
  } else {
    photoHtml = '<div class="contact-card-photo-fallback">' + _esBC(initialsTrimmed) + '</div>';
  }

  var overlapHtml = '';
  if (c.overlap_with_mitchell && c.overlap_with_mitchell.length) {
    var oItems = c.overlap_with_mitchell.map(function (o) {
      return '<span class="contact-card-overlap-item">' + _esBC(o.company) + ' <span class="muted-text">(' + _esBC(o.mitchell_years) + ')</span></span>';
    }).join('');
    overlapHtml = '<div class="contact-card-overlap"><span class="contact-card-section-label">↗ Shared employer</span>' + oItems + '</div>';
  }

  var othersHtml = '';
  if (c.others_at_company && c.others_at_company.length) {
    var oList = c.others_at_company.slice(0, 6).map(function (o) {
      var pill = o.in_outreach ? '<span class="pill-tiny pill-outreach">in outreach</span>' : '';
      var aMatch = o.archetype_match ? '<span class="pill-tiny pill-archetype">★</span>' : '';
      return '<button type="button" class="contact-card-other-btn" onclick="focusById(\\'' + _esBC(o.id) + '\\')">' + _esBC(o.name) + ' <span class="muted-text">' + _esBC((o.position || '').slice(0, 28)) + '</span> ' + aMatch + pill + '</button>';
    }).join('');
    var more = c.others_at_company.length > 6 ? ('<span class="muted-text">+' + (c.others_at_company.length - 6) + ' more</span>') : '';
    othersHtml = '<div class="contact-card-others"><span class="contact-card-section-label">Other contacts at ' + _esBC(company) + ' (' + c.others_at_company.length + ')</span><div class="contact-card-others-list">' + oList + more + '</div></div>';
  }

  var twoDegHtml = '';
  if (c.two_degree_path && c.two_degree_path.candidate_count > 0) {
    twoDegHtml = '<div class="contact-card-twodeg"><span class="contact-card-section-label">2nd-degree paths at ' + _esBC(company) + '</span><span class="contact-card-twodeg-count">' + c.two_degree_path.candidate_count + ' warm-intro candidates</span></div>';
  }

  var goalHtml = '';
  if (c.goal_alignment) {
    var ga = c.goal_alignment;
    var marks = [];
    if (ga.pre_ipo_match) marks.push('<span class="pill-tiny pill-preipo">pre-IPO</span>');
    if (ga.archetype_match) marks.push('<span class="pill-tiny pill-archetype">archetype-match</span>');
    if (marks.length) {
      goalHtml = '<div class="contact-card-goals">' + marks.join('') + ' <span class="muted-text">alignment ' + ga.composite_score + '</span></div>';
    }
  }

  var connectedHtml = '';
  if (c.connected_on || c.position_at_connection) {
    connectedHtml = '<div class="contact-card-connected muted-text">Connected ' + (c.connected_on ? _esBC(c.connected_on) : 'date unknown') + (c.position_at_connection ? ' as ' + _esBC(c.position_at_connection) : '') + '</div>';
  }

  var enrichHtml;
  if (c.enrichment_status === 'complete' && c.outreach_recommendation) {
    var rec = c.outreach_recommendation;
    var parts = [];
    if (rec.positioning) parts.push('<div><span class="contact-card-section-label">Positioning recommendation</span><p>' + _esBC(rec.positioning) + '</p></div>');
    if (rec.best_channel) parts.push('<div><span class="contact-card-section-label">Best channel</span> ' + _esBC(rec.best_channel) + '</div>');
    if (c.engagement && c.engagement.linkedin_topics) {
      var topics = (c.engagement.linkedin_topics || []).map(function (t) {
        return '<span class="pill-tiny">' + _esBC(t) + '</span>';
      }).join('');
      parts.push('<div><span class="contact-card-section-label">Engages with</span> ' + topics + '</div>');
    }
    if (c.inferred_relationship && c.inferred_relationship.arc) {
      parts.push('<div><span class="contact-card-section-label">Relationship context</span><p class="muted-text">' + _esBC(c.inferred_relationship.arc) + '</p></div>');
    }
    enrichHtml = '<div class="contact-card-enriched">' + parts.join('') + '</div>';
  } else {
    enrichHtml = '<div class="contact-card-enrich-pending"><span class="muted-text">Engagement topics, outreach positioning, and inferred relationship context pending LLM enrichment.</span> <button type="button" class="contact-act contact-act-enrich" onclick="enrichNow(\\'' + _esBC(c.id) + '\\')">↻ Enrich now</button></div>';
  }

  function _emailAction(addr, type) {
    if (!addr) return '<button class="contact-act contact-act-disabled" disabled>' + _esBC(type) + ' ✉︎</button>';
    return '<button class="contact-act" onclick="revealEmail(this, \\'' + _esBC(addr) + '\\')">' + _esBC(type) + ' →</button>';
  }
  var linkedinAction = linkedinUrl
    ? '<a class="contact-act" href="' + _esBC(linkedinUrl) + '" target="_blank" rel="noopener noreferrer">LinkedIn →</a>'
    : '<button class="contact-act contact-act-disabled" disabled>LinkedIn</button>';
  var xClean = String(xHandle || '').replace(/^@/, '');
  var xAction = xHandle
    ? '<a class="contact-act" href="https://x.com/' + _esBC(xClean) + '" target="_blank" rel="noopener noreferrer">X →</a>'
    : '<button class="contact-act contact-act-disabled" disabled>X</button>';
  var photoBtn = c.photo_path
    ? ''
    : '<button type="button" class="contact-act contact-act-photo" onclick="scrapePhoto(\\'' + _esBC(c.id) + '\\',\\'' + _esBC(linkedinUrl) + '\\')">📸 Photo</button>';

  var emailsLine = '';
  if (email || personalEmail) {
    emailsLine = '<div class="contact-card-emails">' + (email ? '<span class="contact-card-email-label">Pro:</span> <code>' + _esBC(email) + '</code>' : '') + (personalEmail ? ' <span class="contact-card-email-label">Personal:</span> <code>' + _esBC(personalEmail) + '</code>' : '') + '</div>';
  }

  var head = '<div class="contact-card-head"><div class="contact-card-avatar">' + photoHtml + '</div><div class="contact-card-identity"><div class="contact-card-name">' + _esBC(name) + ' ' + tierIndicator + ' ' + tierBadge + ' ' + outreachBadge + '</div><div class="contact-card-role">' + _esBC(position || '—') + (company ? ' · <span class="contact-card-company">' + _esBC(company) + '</span>' : '') + '</div>' + connectedHtml + goalHtml + '</div></div>';
  var actions = '<div class="contact-card-actions">' + _emailAction(email, 'Pro') + _emailAction(personalEmail, 'Personal') + linkedinAction + xAction + photoBtn + '</div>';

  var dsTier = c._tier == null ? '' : String(c._tier);
  var dsTarget = c._target_slug || '';
  var dsWarmApply = c._is_warm_apply_now ? '1' : '0';
  var dsInOutreach = c.in_outreach ? '1' : '0';
  var dsHasEmail = email ? '1' : '0';
  var dsWarmStrength = String(c.warm_path_strength || 0);
  var dsLastTouched = (c._last_touched_days === null || c._last_touched_days === undefined || c._last_touched_days === Infinity || c._last_touched_days === 9999) ? '9999' : String(c._last_touched_days);

  return '<article class="contact-card" id="contact-card-' + _esBC(c.id) + '" tabindex="0" aria-label="' + _esBC(name) + ' — ' + _esBC(position || 'role unknown') + ' at ' + _esBC(company || 'company unknown') + '" data-tier="' + dsTier + '" data-target="' + _esBC(dsTarget) + '" data-warm-apply-now="' + dsWarmApply + '" data-in-outreach="' + dsInOutreach + '" data-has-email="' + dsHasEmail + '" data-warm-strength="' + dsWarmStrength + '" data-last-touched-days="' + dsLastTouched + '">' + head + overlapHtml + othersHtml + twoDegHtml + enrichHtml + emailsLine + actions + '</article>';
}

function _renderAllCards(contacts) {
  var grid = document.getElementById('grid');
  if (!grid) return;
  var html = '';
  for (var i = 0; i < contacts.length; i++) {
    html += _rcBC(contacts[i]);
  }
  grid.innerHTML = html;
  grid.setAttribute('data-render-state', 'ready');
}

function initContactsPage() {
  // Idempotent guard — render orchestrator may try to call us twice
  // (cache hit + fetch fingerprint diff). Once is enough.
  if (window.__contactsInitDone) return;
  window.__contactsInitDone = true;

  // State
  var activeFilters = new Set();
  var selectedTargets = new Set();
  var activeSort = 'opportunity';
  var showAllStubs = false;
  var activeQuery = '';

  var grid = document.getElementById('grid');
  var allCards = Array.prototype.slice.call(grid.querySelectorAll('.contact-card'));
  var resultMeta = document.getElementById('result-meta');
  var resultEmpty = document.getElementById('result-empty');

  // ── Token-search parser ──────────────────────────────────────────
  function parseQuery(q) {
    var tokens = {};
    var free = [];
    var parts = String(q || '').toLowerCase().trim().split(/\\s+/);
    parts.forEach(function (p) {
      var m = p.match(/^([a-z_-]+):(.+)$/);
      if (m) tokens[m[1]] = m[2];
      else if (p) free.push(p);
    });
    return { tokens: tokens, free: free.join(' ') };
  }

  // ── Opportunity score ───────────────────────────────────────────
  function opportunityScore(card) {
    var s = 0;
    if (card.dataset.warmApplyNow === '1') s += 5;
    if (card.dataset.target) s += 3;
    var w = parseInt(card.dataset.warmStrength || '0', 10);
    if (w >= 3) s += 2;
    if (card.dataset.hasEmail === '1') s += 1;
    if (card.dataset.tier === '3') s += 2;
    var d = parseInt(card.dataset.lastTouchedDays || '9999', 10);
    if (d > 90) s -= 1;
    return s;
  }

  // ── Filter logic ────────────────────────────────────────────────
  function passesFilters(card) {
    var c = card.dataset;
    var tier = c.tier;
    var defaultHide = (tier === '1' && c.warmApplyNow !== '1');

    if (!showAllStubs && defaultHide) {
      // Stub & not warm-to-apply-now: hide by default unless search hits
      if (activeQuery && cardMatchesQuery(card, activeQuery)) {
        /* search override always shows */
      } else if (Array.from(activeFilters).indexOf('tier-1') >= 0) {
        /* explicit tier-1 filter — show */
      } else {
        return false;
      }
    }

    if (activeFilters.has('warm-apply-now') && c.warmApplyNow !== '1') return false;
    if (activeFilters.has('email')          && c.hasEmail !== '1')      return false;
    if (activeFilters.has('outreach')       && c.inOutreach !== '1')    return false;
    if (activeFilters.has('warm-strong')    && parseInt(c.warmStrength || '0', 10) < 3) return false;
    if (activeFilters.has('tier-3')         && c.tier !== '3')          return false;
    if (activeFilters.has('tier-2')         && c.tier !== '2')          return false;
    if (activeFilters.has('tier-1')         && c.tier !== '1')          return false;
    if (activeFilters.has('touched-30d')    && parseInt(c.lastTouchedDays || '9999', 10) > 30) return false;
    if (activeFilters.has('degree-1')) {
      // We don't track degree per card; in-corpus all are 1st-degree (degree=1 in network-database.json).
      // Leave permissive for the demo set.
    }
    // archetype + preipo are gated/disabled when populated=0; if user manages to toggle them,
    // they apply but most cards will fail.
    if (activeFilters.has('archetype') && c.archetype !== '1') return false;
    if (activeFilters.has('preipo')    && c.preipo !== '1')    return false;

    if (selectedTargets.size > 0) {
      if (!c.target || !selectedTargets.has(c.target)) return false;
    }
    return true;
  }

  function cardMatchesQuery(card, q) {
    var p = parseQuery(q);
    // Free-text search
    var name = (card.querySelector('.contact-card-name') || {}).textContent || '';
    var role = (card.querySelector('.contact-card-role') || {}).textContent || '';
    var emailEl = card.querySelector('.contact-card-emails');
    var emails = emailEl ? emailEl.textContent : '';
    var hay = (name + ' ' + role + ' ' + emails).toLowerCase();
    if (p.free && hay.indexOf(p.free) === -1) return false;

    // Token search
    if (p.tokens.company) {
      var co = (card.querySelector('.contact-card-company') || {}).textContent || '';
      if (co.toLowerCase().indexOf(p.tokens.company) === -1) return false;
    }
    if (p.tokens.tier) {
      var want = p.tokens.tier.replace('+', '');
      var got = parseInt(card.dataset.tier || '0', 10);
      if (p.tokens.tier.endsWith('+')) {
        if (got < parseInt(want, 10)) return false;
      } else {
        if (got !== parseInt(want, 10)) return false;
      }
    }
    if (p.tokens.outreach === 'active' && card.dataset.inOutreach !== '1') return false;
    if (p.tokens.email === 'yes' && card.dataset.hasEmail !== '1') return false;
    if (p.tokens.email === 'no'  && card.dataset.hasEmail !== '0') return false;
    if (p.tokens.warm) {
      var w = parseInt(card.dataset.warmStrength || '0', 10);
      var m = p.tokens.warm.match(/^(>=|<=|>|<|=)?(\\d+)/);
      if (m) {
        var op = m[1] || '=';
        var n = parseInt(m[2], 10);
        if (op === '>=' && !(w >= n)) return false;
        if (op === '<=' && !(w <= n)) return false;
        if (op === '>'  && !(w >  n)) return false;
        if (op === '<'  && !(w <  n)) return false;
        if (op === '='  && !(w === n)) return false;
      }
    }
    return true;
  }

  // ── Sort logic ──────────────────────────────────────────────────
  function sortKey(card, mode) {
    switch (mode) {
      case 'opportunity': return -opportunityScore(card);
      case 'warm': return -parseInt(card.dataset.warmStrength || '0', 10);
      case 'touched': return parseInt(card.dataset.lastTouchedDays || '9999', 10);
      case 'tier': return -parseInt(card.dataset.tier || '0', 10);
      case 'connected':
        var conn = (card.querySelector('.contact-card-connected') || {}).textContent || '';
        return -Date.parse(conn.replace('Connected ', '').replace(/\\sas.*$/, '')) || 0;
      case 'name':
        return (card.querySelector('.contact-card-name') || {}).textContent || '';
      case 'richness':
        // count populated children
        var score = 0;
        if (card.querySelector('.contact-card-overlap')) score++;
        if (card.querySelector('.contact-card-others'))  score++;
        if (card.querySelector('.contact-card-twodeg'))  score++;
        if (card.querySelector('.contact-card-enriched'))score += 2;
        if (card.querySelector('.contact-card-emails'))  score++;
        if (card.querySelector('.contact-card-goals'))   score++;
        return -score;
      default: return 0;
    }
  }

  function applyFilters() {
    var visible = 0;
    // Determine visibility per card
    var visibleCards = [];
    allCards.forEach(function (card) {
      var ok = activeQuery ? (cardMatchesQuery(card, activeQuery) && passesFilters(card)) : passesFilters(card);
      if (ok) {
        visibleCards.push(card);
        visible++;
      } else {
        card.style.display = 'none';
      }
    });

    // Sort visible cards
    visibleCards.sort(function (a, b) {
      var ka = sortKey(a, activeSort);
      var kb = sortKey(b, activeSort);
      if (typeof ka === 'string' || typeof kb === 'string') {
        return String(ka).localeCompare(String(kb));
      }
      return ka - kb;
    });

    // Re-attach in sort order
    visibleCards.forEach(function (card) {
      grid.appendChild(card);
      card.style.display = '';
    });

    // Compact-stub mode
    grid.classList.toggle('compact-stubs', showAllStubs);
    allCards.forEach(function (card) {
      var isStub = card.dataset.tier === '1';
      card.classList.toggle('is-stub-compact', showAllStubs && isStub);
    });

    resultMeta.textContent = visible + ' contact' + (visible === 1 ? '' : 's') + ' visible';
    resultEmpty.hidden = (visible > 0);
  }

  // ── Filter chip handlers ────────────────────────────────────────
  document.querySelectorAll('.filter-chip[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var f = btn.dataset.filter;
      if (btn.getAttribute('aria-disabled') === 'true') return;
      if (activeFilters.has(f)) {
        activeFilters.delete(f);
        btn.setAttribute('aria-pressed', 'false');
      } else {
        activeFilters.add(f);
        btn.setAttribute('aria-pressed', 'true');
      }
      applyFilters();
    });
  });

  // Clear all filters
  function clearAllFilters() {
    activeFilters.clear();
    selectedTargets.clear();
    document.querySelectorAll('.filter-chip[data-filter]').forEach(function (b) {
      b.setAttribute('aria-pressed', 'false');
    });
    document.querySelectorAll('input[data-target-company]').forEach(function (inp) { inp.checked = false; });
    var tgtCount = document.getElementById('target-selected-count');
    if (tgtCount) tgtCount.textContent = '0';
    var tgtTrigger = document.querySelector('#target-dropdown .filter-chip');
    if (tgtTrigger) tgtTrigger.setAttribute('aria-pressed', 'false');
    document.getElementById('contacts-search').value = '';
    activeQuery = '';
    document.querySelectorAll('.stat-tile').forEach(function (t) { t.setAttribute('aria-pressed', 'false'); });
    applyFilters();
  }
  document.getElementById('clear-filters').addEventListener('click', clearAllFilters);

  // ── BRAVO followup Item 8 / AA-4 — clickable stat tiles ──────────
  // Each tile maps to a filter preset. Click toggles the filter on/off
  // and reflects state via aria-pressed.
  function setChipPressed(filterKey, pressed) {
    var chip = document.querySelector('.filter-chip[data-filter="' + filterKey + '"]');
    if (!chip) return;
    if (pressed) { activeFilters.add(filterKey); chip.setAttribute('aria-pressed', 'true'); }
    else { activeFilters.delete(filterKey); chip.setAttribute('aria-pressed', 'false'); }
  }
  function updateStatTilePressedStates() {
    document.querySelectorAll('.stat-tile').forEach(function (tile) {
      var k = tile.dataset.statFilter;
      var pressed = false;
      if (k === 'all') {
        pressed = activeFilters.size === 0 && selectedTargets.size === 0 && !activeQuery;
      } else if (k === 'signal') {
        // "with signal" = Tier 3 or Tier 2. Pressed when both T3+T2 chips are on.
        pressed = activeFilters.has('tier-3') && activeFilters.has('tier-2');
      } else if (k === 'warm-apply-now') {
        pressed = activeFilters.has('warm-apply-now');
      } else if (k === 'outreach') {
        pressed = activeFilters.has('outreach');
      }
      tile.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }
  document.querySelectorAll('.stat-tile').forEach(function (tile) {
    tile.addEventListener('click', function () {
      var k = tile.dataset.statFilter;
      if (k === 'all') {
        clearAllFilters();
        return;
      }
      if (k === 'signal') {
        // Toggle Tier 3 AND Tier 2 together to represent "with signal"
        var on = !(activeFilters.has('tier-3') && activeFilters.has('tier-2'));
        setChipPressed('tier-3', on);
        setChipPressed('tier-2', on);
      } else if (k === 'warm-apply-now') {
        setChipPressed('warm-apply-now', !activeFilters.has('warm-apply-now'));
      } else if (k === 'outreach') {
        setChipPressed('outreach', !activeFilters.has('outreach'));
      }
      updateStatTilePressedStates();
      applyFilters();
      // Announce
      var ann = document.getElementById('_shortcut-announcer');
      if (ann) ann.textContent = (tile.getAttribute('aria-pressed') === 'true' ? 'Applied ' : 'Removed ') + (tile.querySelector('strong').textContent + ' ' + tile.lastChild.textContent).trim();
    });
  });
  // Also recompute stat-tile pressed state whenever a chip is toggled.
  // applyFilters() is a function declaration so we can't easily reassign it;
  // instead, hook the chip-click + clear-filter call sites we control.
  document.querySelectorAll('.filter-chip[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', updateStatTilePressedStates);
  });
  document.getElementById('clear-filters').addEventListener('click', updateStatTilePressedStates);
  // Initial sync
  updateStatTilePressedStates();

  // Target-company dropdown
  window.toggleTargetDropdown = function () {
    var dd = document.getElementById('target-dropdown');
    var was = dd.classList.toggle('open');
    dd.querySelector('.filter-chip').setAttribute('aria-expanded', was ? 'true' : 'false');
  };
  document.querySelectorAll('input[data-target-company]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var slug = inp.dataset.targetCompany;
      if (inp.checked) selectedTargets.add(slug);
      else selectedTargets.delete(slug);
      document.getElementById('target-selected-count').textContent = selectedTargets.size;
      var trigger = document.querySelector('#target-dropdown .filter-chip');
      trigger.setAttribute('aria-pressed', selectedTargets.size > 0 ? 'true' : 'false');
      applyFilters();
    });
  });
  // Close target dropdown on outside click
  document.addEventListener('click', function (e) {
    var dd = document.getElementById('target-dropdown');
    if (dd && !dd.contains(e.target)) {
      dd.classList.remove('open');
      dd.querySelector('.filter-chip').setAttribute('aria-expanded', 'false');
    }
    var sd = document.getElementById('sort-dropdown');
    if (sd && !sd.contains(e.target)) {
      sd.classList.remove('open');
      sd.querySelector('.sort-dropdown-trigger').setAttribute('aria-expanded', 'false');
    }
  });

  // Sort dropdown
  window.toggleSortDropdown = function () {
    var dd = document.getElementById('sort-dropdown');
    var was = dd.classList.toggle('open');
    dd.querySelector('.sort-dropdown-trigger').setAttribute('aria-expanded', was ? 'true' : 'false');
  };
  window.setSort = function (mode, label) {
    activeSort = mode;
    document.getElementById('sort-label').textContent = label;
    document.querySelectorAll('.sort-dropdown-option').forEach(function (o) {
      o.classList.toggle('active', o.dataset.sort === mode);
    });
    document.getElementById('sort-dropdown').classList.remove('open');
    applyFilters();
  };

  // Search input
  document.getElementById('contacts-search').addEventListener('input', function (e) {
    activeQuery = e.target.value;
    applyFilters();
  });

  // Toggle stubs
  document.getElementById('toggle-stubs').addEventListener('click', function () {
    showAllStubs = !showAllStubs;
    var btn = document.getElementById('toggle-stubs');
    btn.setAttribute('aria-pressed', showAllStubs ? 'true' : 'false');
    btn.textContent = showAllStubs
      ? 'Hide stubs (' + (allCards.length - ${totalT2 + totalT3}) + ' hidden when off)'
      : 'Show all (${totalT1} stubs hidden)';
    btn.classList.toggle('active', showAllStubs);
    applyFilters();
  });

  // ── Card-internal handlers ──────────────────────────────────────
  window.focusById = function (id) {
    var el = document.getElementById('contact-card-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('contact-card-flash');
    setTimeout(function () { el.classList.remove('contact-card-flash'); }, 1600);
  };
  // ── BRAVO followup Item 6 / AA-7 — styled confirmation modal ───────
  // Replaces native window.confirm() with a focus-trapped <dialog>-style
  // modal that lives alongside the shortcuts-modal pattern.
  function ensureEnrichModal() {
    if (document.getElementById('enrich-confirm-bd')) return;
    var bd = document.createElement('div');
    bd.id = 'enrich-confirm-bd';
    bd.className = 'enrich-modal-backdrop';
    bd.setAttribute('aria-hidden', 'true');
    bd.setAttribute('role', 'dialog');
    bd.setAttribute('aria-modal', 'true');
    bd.setAttribute('aria-labelledby', 'enrich-modal-title');
    bd.setAttribute('aria-describedby', 'enrich-modal-body');
    bd.innerHTML = [
      '<div class="enrich-modal" role="document">',
      '<h2 id="enrich-modal-title">Confirm enrichment</h2>',
      '<p id="enrich-modal-body" class="enrich-modal-body"></p>',
      '<div class="enrich-modal-actions">',
      '<button type="button" class="enrich-modal-cancel" id="enrich-modal-cancel">Cancel</button>',
      '<button type="button" class="enrich-modal-confirm" id="enrich-modal-confirm">Queue enrichment</button>',
      '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(bd);
  }
  function openEnrichModal(opts) {
    return new Promise(function (resolve) {
      ensureEnrichModal();
      var bd = document.getElementById('enrich-confirm-bd');
      var body = document.getElementById('enrich-modal-body');
      var confirmBtn = document.getElementById('enrich-modal-confirm');
      var cancelBtn = document.getElementById('enrich-modal-cancel');
      body.textContent = opts.message || 'Confirm action?';
      confirmBtn.textContent = opts.confirmLabel || 'Confirm';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      // Focus trap — capture last-focused element for restore.
      var lastFocus = document.activeElement;
      function close(result) {
        bd.classList.remove('visible');
        bd.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', keyHandler);
        bd.removeEventListener('click', backdropClick);
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        if (lastFocus && typeof lastFocus.focus === 'function') {
          try { lastFocus.focus(); } catch (_) {}
        }
        resolve(result);
      }
      function onConfirm() { close(true); }
      function onCancel() { close(false); }
      function keyHandler(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
        if (e.key === 'Tab') {
          // Focus trap between cancel + confirm
          var focusables = [cancelBtn, confirmBtn];
          var idx = focusables.indexOf(document.activeElement);
          if (idx === -1) { focusables[0].focus(); e.preventDefault(); return; }
          var nextIdx = e.shiftKey ? (idx === 0 ? focusables.length - 1 : idx - 1)
                                   : (idx === focusables.length - 1 ? 0 : idx + 1);
          focusables[nextIdx].focus();
          e.preventDefault();
        }
        if (e.key === 'Enter' && document.activeElement === confirmBtn) {
          e.preventDefault();
          close(true);
        }
      }
      function backdropClick(e) { if (e.target === bd) close(false); }
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', keyHandler);
      bd.addEventListener('click', backdropClick);
      bd.classList.add('visible');
      bd.setAttribute('aria-hidden', 'false');
      // Initial focus on Cancel (safer default per WAI-ARIA APG dialog pattern)
      setTimeout(function () { cancelBtn.focus(); }, 0);
    });
  }
  window.openEnrichModal = openEnrichModal;

  window.enrichNow = function (id) {
    openEnrichModal({
      message: 'Queue this contact for LLM enrichment? Approximate cost is $0.50 per contact. The contact will be processed in the next batch (~10 min).',
      confirmLabel: 'Queue enrichment',
      cancelLabel: 'Cancel'
    }).then(function (ok) {
      if (!ok) return;
      fetch('/api/refresh-cache', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ cache: 'contact_enrichment', key: id, priority: 'user-triggered' })
      })
        .then(function (r) { return r.ok ? alert('Queued. Reload after ~10 min.') : alert('Failed; check dashboard-server logs.'); })
        .catch(function (e) { alert('Network error: ' + e.message); });
    });
  };
  window.scrapePhoto = function (id, linkedinUrl) {
    if (!linkedinUrl) { alert('No LinkedIn URL.'); return; }
    fetch('/api/scrape-photo', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id: id, linkedin_url: linkedinUrl })
    })
      .then(function (r) { return r.ok ? alert('Photo scrape queued.') : alert('Failed.'); })
      .catch(function (e) { alert('Network error: ' + e.message); });
  };
  window.revealEmail = function (btn, addr) {
    if (!btn.dataset.revealed) {
      var label = document.createElement('div');
      label.style.fontSize = '11px';
      label.style.color = 'var(--text-3)';
      label.style.marginTop = '4px';
      label.textContent = addr + ' — click again to compose';
      btn.parentNode.appendChild(label);
      btn.dataset.revealed = '1';
      setTimeout(function () {
        delete btn.dataset.revealed;
        if (label.parentNode) label.parentNode.removeChild(label);
      }, 6000);
    } else {
      window.open('https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(addr), '_blank', 'noopener,noreferrer');
      delete btn.dataset.revealed;
    }
  };

  // ── BRAVO followup Item 7 / AA-3 — J/K card navigation ──────────────
  // j = focus next visible card; k = focus previous; Enter on a focused card
  // = open the first action button (LinkedIn / email). Bails on form-field
  // focus so it doesn't interfere with the search input.
  function getVisibleCards() {
    return Array.from(document.querySelectorAll('.contact-card'))
      .filter(function (el) {
        if (el.style.display === 'none') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
  }
  function focusCard(card) {
    if (!card) return;
    document.querySelectorAll('.contact-card.contact-card-jk-active').forEach(function (c) {
      c.classList.remove('contact-card-jk-active');
    });
    card.classList.add('contact-card-jk-active');
    card.focus({ preventScroll: false });
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Aria-live announcement
    var ann = document.getElementById('_shortcut-announcer');
    if (ann) {
      var name = card.getAttribute('aria-label') || 'card';
      ann.textContent = 'Focused ' + name;
    }
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t) return;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'k') {
      var cards = getVisibleCards();
      if (cards.length === 0) return;
      var active = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('contact-card')
        ? document.activeElement
        : null;
      var idx = active ? cards.indexOf(active) : -1;
      var next;
      if (e.key === 'j') {
        next = idx === -1 ? cards[0] : cards[Math.min(cards.length - 1, idx + 1)];
      } else {
        next = idx === -1 ? cards[cards.length - 1] : cards[Math.max(0, idx - 1)];
      }
      e.preventDefault();
      focusCard(next);
    }
    if (e.key === 'Enter' && t.classList && t.classList.contains('contact-card')) {
      // Open the first non-disabled action button on the focused card.
      var act = t.querySelector('.contact-card-actions a.contact-act, .contact-card-actions button.contact-act:not(.contact-act-disabled)');
      if (act) {
        e.preventDefault();
        act.click();
      }
    }
  });

  // Initial render
  applyFilters();
}

/* ════════════════════════════════════════════════════════════════════
 * 2026-05-20 — P0.1 dual-corpus refactor (Phase 2 — the deferred PR).
 *
 * Replaces the prior freshness-only IIFE. Now the orchestrator BOTH
 * fetches /data/contacts-annotated.json AND renders the cards client-
 * side, lifting the initial bake from contacts.html. localStorage
 * cache (1h TTL keyed by generated_at fingerprint) makes warm load
 * paint near-instantly; cold load shows skeletons while fetching.
 *
 * After render, initContactsPage() binds all filter/sort/J-K handlers
 * to the freshly-rendered cards. The guard inside initContactsPage()
 * prevents double-init if both cache hit and fetch fire.
 * ════════════════════════════════════════════════════════════════════ */
(function () {
  var CACHE_KEY = 'contacts-cache-v2';
  var CACHE_TTL_MS = 60 * 60 * 1000; // 1h
  var BAKED_AT = window.__CONTACTS_BAKED_AT__ || '';
  var grid = document.getElementById('grid');
  var freshness = document.getElementById('contacts-freshness');

  function fmtAge(iso) {
    if (!iso) return 'unknown';
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    return Math.round(ms / 86400000) + 'd ago';
  }
  function paintFreshness(label, state) {
    if (!freshness) return;
    freshness.textContent = label;
    freshness.dataset.state = state || 'live';
  }
  function updateTilesFromAnnotatedStats(stats) {
    var tiles = {
      all: document.querySelector('[data-stat-filter="all"] strong'),
      signal: document.querySelector('[data-stat-filter="signal"] strong'),
      warm: document.querySelector('[data-stat-filter="warm-apply-now"] strong'),
      outreach: document.querySelector('[data-stat-filter="outreach"] strong'),
    };
    if (!stats) return;
    if (tiles.all && stats.total != null) tiles.all.textContent = String(stats.total);
    if (tiles.signal && (stats.tier2 != null || stats.tier3 != null)) {
      tiles.signal.textContent = String((stats.tier2 || 0) + (stats.tier3 || 0));
    }
    if (tiles.warm && stats.warm_to_apply_now != null) tiles.warm.textContent = String(stats.warm_to_apply_now);
    if (tiles.outreach && stats.in_outreach != null) tiles.outreach.textContent = String(stats.in_outreach);
  }

  // 1. Try cache (warm load)
  var cached = null;
  try {
    var raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.fetchedAt && (Date.now() - parsed.fetchedAt) < CACHE_TTL_MS) {
        cached = parsed;
      }
    }
  } catch (e) { /* corrupt cache → ignore */ }

  if (cached && cached.contacts && cached.contacts.length) {
    _renderAllCards(cached.contacts);
    if (cached.stats) updateTilesFromAnnotatedStats(cached.stats);
    paintFreshness('Cached · ' + cached.contacts.length + ' contacts · refreshing…', 'live');
    initContactsPage();
  }

  // 2. Always fetch live — refresh cache, surface drift
  fetch('/data/contacts-annotated.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (payload) {
      var contacts = (payload && payload.contacts) || [];
      var stats = (payload && payload.stats) || {};
      var fingerprint = contacts.length + ':' + (payload.generated_at || '');
      var hadCache = !!(cached && cached.contacts);
      var changed = !hadCache || cached.fingerprint !== fingerprint;

      if (!hadCache) {
        // Cold load — render + init now
        _renderAllCards(contacts);
        updateTilesFromAnnotatedStats(stats);
        initContactsPage();
        paintFreshness('Live · ' + contacts.length + ' contacts · refreshed ' + fmtAge(new Date().toISOString()), 'live');
      } else if (changed) {
        // Warm load with drift — show a notice instead of silently re-rendering
        paintFreshness('Live data updated · refresh the page to see ' + contacts.length + ' contacts', 'stale');
      } else {
        paintFreshness('Live · ' + contacts.length + ' contacts · cache current', 'live');
      }

      // Cache for next visit
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          fetchedAt: Date.now(),
          fingerprint: fingerprint,
          contacts: contacts,
          stats: stats,
        }));
      } catch (e) {
        // Quota exceeded — keep stats only as a fallback
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({
            fetchedAt: Date.now(),
            fingerprint: fingerprint,
            stats: stats,
          }));
        } catch (_) { /* still over → silent */ }
      }
    })
    .catch(function (err) {
      if (!cached || !cached.contacts || !cached.contacts.length) {
        // No cache fallback and fetch failed → render empty-state into the grid
        if (grid) {
          grid.innerHTML = '<div class="result-empty"><strong>Failed to load contacts.</strong><div class="muted-text" style="margin-top:6px">' + _esBC(err.message || 'fetch failed') + '</div><div class="muted-text" style="margin-top:6px">Refresh the page to retry.</div></div>';
          grid.setAttribute('data-render-state', 'error');
        }
      }
      paintFreshness('Live fetch failed · ' + (err.message || 'unknown') + (cached ? ' · showing cache' : ''), 'stale');
    });
})();
</script>
`;

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

const out = renderDashboardShell({
  pageId: 'contacts',
  title: 'Network',
  headExtra: `<style>${pageCSS}</style>`,
  mainHTML: mainHTML,
  scriptExtra: pageJS,
});

const outPath = join(REPO_ROOT, 'dashboard/contacts.html');
writeFileSync(outPath, out);
console.log(`[build-contacts-page] wrote ${outPath} (${out.length.toLocaleString()} bytes, ${annotated.length} cards, ${totalT1} stubs hidden by default)`);
