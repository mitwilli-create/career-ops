#!/usr/bin/env node
/**
 * tests/cooldown-context.test.mjs
 *
 * Fixture tests for lib/cooldown-context.mjs (PR-05 of the apply-now UX
 * overhaul, 2026-05-25). Validates the cross-reference logic between
 * hm-intel/<slug>.json + network-database.json for the cooldown banner
 * warm-contact replacement text.
 *
 * Required cases (per worker-PR-05 brief):
 *   T1 — Exact email match → "Override available: …"
 *   T2 — No recruiters in hm-intel → "No active recruiter touch…"
 *   T3 — hm-intel doesn't exist (file missing) → graceful no-match path
 *   T4 — Name-only fuzzy match → text with "(verify)" suffix
 *   T5 — network-database.json missing → "(check unavailable)" text, no crash
 *
 * Plus internal-API invariants for the exported _internal helpers
 * (Sorensen-Dice, canonicalize-LinkedIn, normalize-email, last-touched-at).
 *
 * No live API calls — pure deterministic.
 *
 * Usage:  node tests/cooldown-context.test.mjs
 * Exit:   0 on pass; 1 on any failure.
 */

import { resolveCooldownContext, _internal } from '../lib/cooldown-context.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = join(
  tmpdir(),
  'cooldown-context-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
);
mkdirSync(join(TMP_ROOT, 'data', 'hm-intel'), { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { console.log('✓ ' + name); pass++; }
  else {
    console.error('✗ ' + name);
    if (detail !== undefined) {
      try { console.error('  detail:', JSON.stringify(detail, null, 2)); }
      catch { console.error('  detail:', String(detail)); }
    }
    fail++;
    failures.push({ name, detail });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// _internal helpers — invariants
// ─────────────────────────────────────────────────────────────────────────

{
  // normalizeName + bigrams sanity
  check('IN1 normalizeName lowercases + strips punctuation',
    _internal.normalizeName('Pedram Navid!') === 'pedram navid');
  check('IN2 normalizeName handles non-string',
    _internal.normalizeName(null) === '' && _internal.normalizeName(undefined) === '');

  // sorensenDice — identity = 1, very-different ≈ 0
  check('IN3 sorensenDice identity = 1',
    _internal.sorensenDice('Pedram Navid', 'Pedram Navid') === 1);
  const lowSim = _internal.sorensenDice('Pedram Navid', 'Alex Albert');
  check('IN4 sorensenDice low-similarity < 0.3', lowSim < 0.3, { lowSim });
  // Near-match — "Sasha de Marigny" vs "Sasha deMarigny"
  const nearSim = _internal.sorensenDice('Sasha de Marigny', 'Sasha deMarigny');
  check('IN5 sorensenDice near-match ≥ 0.85', nearSim >= 0.85, { nearSim });

  // canonicalLinkedin
  check('IN6 canonicalLinkedin strips protocol + trailing slash',
    _internal.canonicalLinkedin('https://www.linkedin.com/in/pedramnavid/') === 'linkedin.com/in/pedramnavid');
  check('IN7 canonicalLinkedin strips query + hash',
    _internal.canonicalLinkedin('https://linkedin.com/in/foo?utm=bar#section') === 'linkedin.com/in/foo');
  check('IN8 canonicalLinkedin empty input returns empty',
    _internal.canonicalLinkedin('') === '' && _internal.canonicalLinkedin(null) === '');

  // normalizeEmail
  check('IN9 normalizeEmail lowercases + trims',
    _internal.normalizeEmail('  Foo@BAR.com  ') === 'foo@bar.com');

  // personEmails — handles both string + object shapes
  const p = {
    emails: {
      professional: [
        { email: 'A@B.com', source: 'hunter' },
        { email: 'c@d.com' },
      ],
      personal: ['e@f.com'],
    },
  };
  const emails = _internal.personEmails(p);
  check('IN10 personEmails extracts + lowercases all emails',
    emails.includes('a@b.com') && emails.includes('c@d.com') && emails.includes('e@f.com'),
    emails);

  // lastTouchedAt priority order
  check('IN11 lastTouchedAt prefers linkedin_last_engaged_at',
    _internal.lastTouchedAt({
      engagement: { linkedin_last_engaged_at: '2026-05-20T00:00:00Z', x_last_engaged_at: '2025-01-01' },
      connected_on: '2024-01-01',
    }) === '2026-05-20');
  check('IN12 lastTouchedAt falls back to connected_on',
    _internal.lastTouchedAt({ engagement: {}, connected_on: '2026-05-14' }) === '2026-05-14');
  check('IN13 lastTouchedAt returns null when nothing present',
    _internal.lastTouchedAt({ engagement: {} }) === null);

  // scorePair priority — email > linkedin > name > none
  const contact = {
    name: 'Pedram Navid',
    linkedin_url: 'https://www.linkedin.com/in/pedramnavid/',
    professional_email: 'pedram@anthropic.com',
  };
  const personEmail = { full_name: 'Different Name', emails: { professional: [{ email: 'pedram@anthropic.com' }] } };
  check('IN14 scorePair email wins',
    _internal.scorePair(contact, personEmail).match_type === 'email');
  const personLinkedin = { full_name: 'Different Name', linkedin_url: 'https://linkedin.com/in/pedramnavid' };
  check('IN15 scorePair linkedin matches',
    _internal.scorePair(contact, personLinkedin).match_type === 'linkedin');
  const personName = { full_name: 'Pedram Navid' };
  check('IN16 scorePair name matches when above threshold',
    _internal.scorePair(contact, personName).match_type === 'name');
  const personNone = { full_name: 'Completely Unrelated Person' };
  check('IN17 scorePair none when nothing matches',
    _internal.scorePair(contact, personNone).match_type === 'none');

  // composeReplacement
  check('IN18 composeReplacement null → no-touch text',
    _internal.composeReplacement(null) === 'No active recruiter touch in network — apply via portal.');
  check('IN19 composeReplacement name-match adds (verify)',
    _internal.composeReplacement({ name: 'Foo Bar', company: 'Acme', last_touched_at: '2026-05-14', match_type: 'name' })
      === 'Override available: Foo Bar at Acme — last touched 2026-05-14 (verify)');
  check('IN20 composeReplacement email-match no (verify)',
    _internal.composeReplacement({ name: 'Foo Bar', company: 'Acme', last_touched_at: '2026-05-14', match_type: 'email' })
      === 'Override available: Foo Bar at Acme — last touched 2026-05-14.');
}

// ─────────────────────────────────────────────────────────────────────────
// T1 — Exact email match → "Override available: …"
// ─────────────────────────────────────────────────────────────────────────

{
  const hmIntel = {
    hiring_managers: [
      { name: 'Pedram Navid', professional_email: 'pedram@anthropic.com', linkedin_url: 'https://linkedin.com/in/pedramnavid/' },
    ],
    recruiters: [],
  };
  const networkDb = {
    people: [
      {
        full_name: 'Pedram Navid',
        current_company: 'Anthropic',
        linkedin_url: 'https://linkedin.com/in/pedramnavid',
        emails: { professional: [{ email: 'pedram@anthropic.com', source: 'hunter' }], personal: [] },
        engagement: { linkedin_last_engaged_at: '2026-05-20T12:00:00Z' },
        connected_on: '2025-01-15',
      },
    ],
  };
  const r = resolveCooldownContext(
    { slug: 'anthropic-test', company: 'Anthropic' },
    { hmIntelInline: hmIntel, networkDbInline: networkDb },
  );
  check('T1 exact email match → warm_contact present', r.warm_contact !== null, r);
  check('T1 warm_contact.match_type=email',
    r.warm_contact && r.warm_contact.match_type === 'email', r.warm_contact);
  check('T1 replacement_text starts with "Override available: Pedram Navid"',
    typeof r.replacement_text === 'string' && r.replacement_text.startsWith('Override available: Pedram Navid'),
    r.replacement_text);
  check('T1 replacement_text includes last touched 2026-05-20',
    r.replacement_text.includes('last touched 2026-05-20'), r.replacement_text);
  check('T1 replacement_text NOT include (verify) for email-match',
    !r.replacement_text.includes('(verify)'), r.replacement_text);
}

// ─────────────────────────────────────────────────────────────────────────
// T2 — No recruiters in hm-intel → "No active recruiter touch…"
// ─────────────────────────────────────────────────────────────────────────

{
  const hmIntel = { hiring_managers: [], recruiters: [] };
  const networkDb = { people: [] };
  const r = resolveCooldownContext(
    { slug: 'no-contacts-test', company: 'TestCo' },
    { hmIntelInline: hmIntel, networkDbInline: networkDb },
  );
  check('T2 empty contacts → warm_contact null', r.warm_contact === null, r);
  check('T2 replacement_text = no-touch standard',
    r.replacement_text === 'No active recruiter touch in network — apply via portal.',
    r.replacement_text);
}

// ─────────────────────────────────────────────────────────────────────────
// T3 — hm-intel doesn't exist (file missing) → graceful no-match path
// ─────────────────────────────────────────────────────────────────────────

{
  // Use TMP_ROOT, which is a clean dir with NO data/hm-intel/<slug>.json
  const r = resolveCooldownContext(
    { slug: 'absent-slug-' + Math.random().toString(36).slice(2, 8), company: 'Whatever' },
    { rootDir: TMP_ROOT },
  );
  check('T3 missing hm-intel file → warm_contact null', r.warm_contact === null, r);
  check('T3 missing hm-intel file → replacement_text is no-touch standard',
    r.replacement_text === 'No active recruiter touch in network — apply via portal.',
    r.replacement_text);
  check('T3 debug.error = hm-intel-missing',
    r.debug && r.debug.error === 'hm-intel-missing', r.debug);
}

// ─────────────────────────────────────────────────────────────────────────
// T4 — Name-only fuzzy match → text with "(verify)" suffix
// ─────────────────────────────────────────────────────────────────────────

{
  const hmIntel = {
    hiring_managers: [
      {
        name: 'Pedram Navid',
        // No email + no linkedin_url → only name match available
        professional_email: null,
        linkedin_url: null,
      },
    ],
    recruiters: [],
  };
  const networkDb = {
    people: [
      {
        full_name: 'Pedram Navid', // exact-name match → similarity 1.0
        current_company: 'Anthropic',
        linkedin_url: null,
        emails: { professional: [], personal: [] },
        engagement: {},
        connected_on: '2025-08-10',
      },
    ],
  };
  const r = resolveCooldownContext(
    { slug: 'fuzzy-test', company: 'Anthropic' },
    { hmIntelInline: hmIntel, networkDbInline: networkDb },
  );
  check('T4 name-only match → warm_contact present', r.warm_contact !== null, r);
  check('T4 warm_contact.match_type=name',
    r.warm_contact && r.warm_contact.match_type === 'name', r.warm_contact);
  check('T4 replacement_text ends with (verify)',
    r.replacement_text.endsWith('(verify)'), r.replacement_text);
  check('T4 replacement_text mentions last touched 2025-08-10',
    r.replacement_text.includes('2025-08-10'), r.replacement_text);
}

// ─────────────────────────────────────────────────────────────────────────
// T5 — network-database.json missing → "(check unavailable)" text, no crash
// ─────────────────────────────────────────────────────────────────────────

{
  // Write a hm-intel file but DO NOT write network-database.json
  const slug = 't5-slug-' + Math.random().toString(36).slice(2, 8);
  const intelPath = join(TMP_ROOT, 'data', 'hm-intel', `${slug}.json`);
  writeFileSync(intelPath, JSON.stringify({
    hiring_managers: [{ name: 'Some Person', professional_email: 'x@y.com' }],
    recruiters: [],
  }));
  const r = resolveCooldownContext(
    { slug, company: 'TestCo' },
    { rootDir: TMP_ROOT },
  );
  check('T5 missing network-db → warm_contact null', r.warm_contact === null, r);
  check('T5 replacement_text = "(check unavailable)" variant',
    typeof r.replacement_text === 'string' && r.replacement_text.includes('(check unavailable)'),
    r.replacement_text);
  check('T5 debug.error = network-db-missing',
    r.debug && r.debug.error === 'network-db-missing', r.debug);
}

// ─────────────────────────────────────────────────────────────────────────
// Bonus tests — additional edge cases worth locking in
// ─────────────────────────────────────────────────────────────────────────

{
  // B1 — row is invalid shape → fails gracefully
  const r = resolveCooldownContext(null);
  check('B1 null row → no crash + no-touch text',
    r.warm_contact === null && r.replacement_text === 'No active recruiter touch in network — apply via portal.',
    r);
  check('B1 debug.error = row-invalid',
    r.debug && r.debug.error === 'row-invalid', r.debug);
}

{
  // B2 — row missing slug → graceful
  const r = resolveCooldownContext({ company: 'X' });
  check('B2 row missing slug → no-touch text + debug.error=no-slug',
    r.warm_contact === null && r.debug?.error === 'no-slug',
    r);
}

{
  // B3 — linkedin match beats name-only when both possible
  const hmIntel = {
    hiring_managers: [
      {
        name: 'Pedram Navid',
        linkedin_url: 'https://www.linkedin.com/in/pedramnavid/',
        professional_email: null,
      },
    ],
    recruiters: [],
  };
  const networkDb = {
    people: [
      // Person A — name-only match candidate
      { full_name: 'Pedram Navid', current_company: 'OtherCo', linkedin_url: null, emails: {}, engagement: {} },
      // Person B — LinkedIn match (will beat name match)
      { full_name: 'Different Person Entirely', current_company: 'Anthropic', linkedin_url: 'https://linkedin.com/in/pedramnavid', emails: {}, engagement: {}, connected_on: '2026-05-22' },
    ],
  };
  const r = resolveCooldownContext(
    { slug: 'b3-test', company: 'Anthropic' },
    { hmIntelInline: hmIntel, networkDbInline: networkDb },
  );
  check('B3 LinkedIn match beats name-only match (priority)',
    r.warm_contact && r.warm_contact.match_type === 'linkedin', r.warm_contact);
  check('B3 LinkedIn-match replacement_text NOT include (verify)',
    !r.replacement_text.includes('(verify)'), r.replacement_text);
}

{
  // B4 — both hiring_managers + recruiters arrays processed
  const hmIntel = {
    hiring_managers: [{ name: 'No Match Here', professional_email: 'nope@x.com' }],
    recruiters: [{ name: 'Jane Recruiter', professional_email: 'jane@target.com' }],
  };
  const networkDb = {
    people: [
      { full_name: 'Jane Recruiter', current_company: 'TargetCo', linkedin_url: null, emails: { professional: [{ email: 'jane@target.com' }] }, engagement: {}, connected_on: '2026-05-01' },
    ],
  };
  const r = resolveCooldownContext(
    { slug: 'b4-test', company: 'TargetCo' },
    { hmIntelInline: hmIntel, networkDbInline: networkDb },
  );
  check('B4 recruiter match works (not just hiring_managers)',
    r.warm_contact && r.warm_contact.name === 'Jane Recruiter' && r.warm_contact.match_type === 'email',
    r.warm_contact);
}

// ─────────────────────────────────────────────────────────────────────────
// Cleanup + summary
// ─────────────────────────────────────────────────────────────────────────

try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' -', f.name);
  process.exit(1);
}
process.exit(0);
