/**
 * lib/cooldown-context.mjs
 *
 * Resolves the "warm-contact" replacement text for the cooldown banner on
 * apply-now rows. Cross-references the row's hm-intel JSON (hiring_managers +
 * recruiters) against data/network-database.json by email, LinkedIn URL, and
 * name-fuzzy match.
 *
 * Shipped 2026-05-25 by PR-05 of the apply-now UX overhaul. Per the strategy
 * doc at .claude/audit/apply-now-ux-audit-2026-05-25/strategy.md §6 R28-R30:
 * Mitchell explicitly answered Q3 with "auto cross-reference + replace text"
 * for cooldown banner copy. The hardcoded "Override if you have a recruiter
 * ask or internal referral" sentence is replaced with a grounded statement
 * naming the highest-confidence contact (when one exists) or honestly noting
 * the absence of warm coverage.
 *
 * Personal-data discipline: this module reads gitignored files
 * (data/hm-intel/<slug>.json, data/network-database.json) and renders strings
 * to local DOM only. The dashboard publishes only via the local-only
 * Cloudflare Tunnel; no cross-fork PR diff path exists for the rendered
 * replacement text.
 *
 * @module cooldown-context
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers — exported via _internal for test coverage
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize a name for fuzzy matching: lowercase, strip punctuation, collapse
 * whitespace. Used as the input to the Sorensen-Dice bigram comparison below.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build bigram set from a normalized name. Single-char names degrade
 * gracefully to a one-element set.
 *
 * @param {string} s
 * @returns {Set<string>}
 */
function bigrams(s) {
  const set = new Set();
  if (!s) return set;
  if (s.length === 1) { set.add(s); return set; }
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/**
 * Sorensen-Dice coefficient between two strings, 0..1. Uses character
 * bigrams after normalization. ≥ 0.85 is a confident match for full names.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function sorensenDice(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const g of ba) if (bb.has(g)) intersection++;
  return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Canonicalize a LinkedIn URL for exact comparison: strip protocol scheme,
 * lowercase host + path, drop trailing slash, drop the optional /pub/ prefix,
 * and drop a trailing ?...querystring.
 *
 * @param {string} url
 * @returns {string}
 */
function canonicalLinkedin(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, '');
  u = u.replace(/^www\./, '');
  u = u.split('?')[0];
  u = u.split('#')[0];
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * Normalize an email for exact comparison: trim, lowercase.
 *
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * Pick the most recent "last-touched" timestamp for a network-DB person.
 * Order: linkedin_last_engaged_at > x_last_engaged_at > connected_on > null.
 *
 * @param {object} person
 * @returns {string|null} ISO date YYYY-MM-DD or null
 */
function lastTouchedAt(person) {
  if (!person || typeof person !== 'object') return null;
  const e = person.engagement || {};
  const candidates = [
    e.linkedin_last_engaged_at,
    e.x_last_engaged_at,
    person.connected_on,
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  // Pick the latest by string sort (all are ISO-ish)
  candidates.sort((a, b) => String(b).localeCompare(String(a)));
  const top = String(candidates[0]);
  // Trim to YYYY-MM-DD if it looks like a full ISO
  const m = top.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : top;
}

/**
 * Collect all professional + personal emails from a network-DB person record.
 *
 * @param {object} person
 * @returns {string[]} normalized email list
 */
function personEmails(person) {
  const emails = person?.emails || {};
  const prof = Array.isArray(emails.professional) ? emails.professional : [];
  const pers = Array.isArray(emails.personal) ? emails.personal : [];
  return [...prof, ...pers]
    .map((e) => normalizeEmail(typeof e === 'string' ? e : e?.email))
    .filter(Boolean);
}

/**
 * Best-match scoring across one (hm-intel contact, network-DB person) pair.
 * Returns { match_type, confidence } where match_type ∈
 * {'email','linkedin','name','none'} in priority order.
 *
 * @param {object} contact   hm-intel hiring_managers[] or recruiters[] entry
 * @param {object} person    network-database.json people[] entry
 * @returns {{ match_type: string, confidence: number }}
 */
function scorePair(contact, person) {
  // a) exact email match — highest confidence
  const contactEmail = normalizeEmail(contact?.professional_email);
  if (contactEmail) {
    const pEmails = personEmails(person);
    if (pEmails.includes(contactEmail)) {
      return { match_type: 'email', confidence: 1.0 };
    }
  }
  // b) exact LinkedIn URL match
  const contactLi = canonicalLinkedin(contact?.linkedin_url);
  const personLi = canonicalLinkedin(person?.linkedin_url);
  if (contactLi && personLi && contactLi === personLi) {
    return { match_type: 'linkedin', confidence: 0.95 };
  }
  // c) name-fuzzy ≥ 0.85
  const contactName = contact?.name;
  const personName = person?.full_name;
  if (contactName && personName) {
    const score = sorensenDice(contactName, personName);
    if (score >= 0.85) {
      return { match_type: 'name', confidence: score };
    }
  }
  return { match_type: 'none', confidence: 0 };
}

/**
 * Compose the replacement text for the cooldown banner based on the best
 * match found (or absence of one). Per Mitchell's locked Q3 decision: the
 * sentence after "Cooldown until <date>" is rewritten — the prefix is
 * preserved by the caller (build-dashboard.mjs).
 *
 * @param {object|null} warmContact
 * @returns {string}
 */
function composeReplacement(warmContact) {
  if (!warmContact) {
    return 'No active recruiter touch in network — apply via portal.';
  }
  const name = warmContact.name || '(unnamed contact)';
  const company = warmContact.company || '';
  const last = warmContact.last_touched_at;
  const base = company
    ? `Override available: ${name} at ${company}`
    : `Override available: ${name}`;
  const dated = last ? `${base} — last touched ${last}` : base;
  // Append "(verify)" suffix for name-only matches (lower-confidence)
  if (warmContact.match_type === 'name') {
    return `${dated} (verify)`;
  }
  return `${dated}.`;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the warm-contact context for an apply-now row's cooldown banner.
 * Reads the row's hm-intel JSON + the network-database.json contacts file,
 * cross-references all hiring_managers + recruiters entries against every
 * person record, returns the highest-priority match (email > linkedin > name)
 * with composed replacement_text.
 *
 * Per CLAUDE.md cross-fork-leak rules: this function READS gitignored files
 * but RENDERS only the warm contact's name + company + last-touched date to
 * the returned replacement_text. The full hm-intel content + full
 * network-database.json content stay in memory and never escape the dashboard
 * render output.
 *
 * @param {object} row                  Apply-now row (must have .slug + .company)
 * @param {object} [options]
 * @param {string} [options.rootDir]    Repo root (default: process.cwd())
 * @param {string} [options.hmIntelPath] Override path to hm-intel/<slug>.json
 * @param {string} [options.networkDbPath] Override path to network-database.json
 * @param {object} [options.hmIntelInline] Pre-loaded hm-intel obj (skip disk)
 * @param {object} [options.networkDbInline] Pre-loaded network-db obj (skip disk)
 * @returns {{warm_contact: object|null, replacement_text: string, debug: object}}
 */
export function resolveCooldownContext(row, options = {}) {
  const debug = {
    hm_intel_loaded: false,
    network_db_loaded: false,
    hm_intel_contact_count: 0,
    network_db_person_count: 0,
    matches_considered: 0,
    best_match_type: 'none',
    error: null,
  };

  // 0) input shape check — fail-open with no-network-touch text
  if (!row || typeof row !== 'object') {
    return {
      warm_contact: null,
      replacement_text: composeReplacement(null),
      debug: { ...debug, error: 'row-invalid' },
    };
  }

  const root = options.rootDir || process.cwd();

  // 1) Load hm-intel JSON
  let hmIntel = options.hmIntelInline || null;
  if (!hmIntel) {
    const slug = (row.slug || '').toString();
    if (!slug) {
      // No slug → graceful no-match path
      return {
        warm_contact: null,
        replacement_text: composeReplacement(null),
        debug: { ...debug, error: 'no-slug' },
      };
    }
    const intelPath = options.hmIntelPath || join(root, 'data', 'hm-intel', `${slug}.json`);
    if (!existsSync(intelPath)) {
      // No intel file → graceful no-match path
      return {
        warm_contact: null,
        replacement_text: composeReplacement(null),
        debug: { ...debug, error: 'hm-intel-missing' },
      };
    }
    try {
      hmIntel = JSON.parse(readFileSync(intelPath, 'utf-8'));
      debug.hm_intel_loaded = true;
    } catch (e) {
      return {
        warm_contact: null,
        replacement_text: composeReplacement(null),
        debug: { ...debug, error: `hm-intel-parse-error: ${e.message}` },
      };
    }
  } else {
    debug.hm_intel_loaded = true;
  }

  // 2) Extract hm-intel contacts (hiring_managers + recruiters)
  const contacts = [
    ...(Array.isArray(hmIntel?.hiring_managers) ? hmIntel.hiring_managers : []),
    ...(Array.isArray(hmIntel?.recruiters) ? hmIntel.recruiters : []),
  ];
  debug.hm_intel_contact_count = contacts.length;
  if (contacts.length === 0) {
    return {
      warm_contact: null,
      replacement_text: composeReplacement(null),
      debug: { ...debug, error: 'no-contacts-in-hm-intel' },
    };
  }

  // 3) Load network database
  let networkDb = options.networkDbInline || null;
  if (!networkDb) {
    const dbPath = options.networkDbPath || join(root, 'data', 'network-database.json');
    if (!existsSync(dbPath)) {
      return {
        warm_contact: null,
        // Distinguish DB-missing failure from no-match
        replacement_text: 'No active recruiter touch in network (check unavailable).',
        debug: { ...debug, error: 'network-db-missing' },
      };
    }
    try {
      networkDb = JSON.parse(readFileSync(dbPath, 'utf-8'));
      debug.network_db_loaded = true;
    } catch (e) {
      return {
        warm_contact: null,
        replacement_text: 'No active recruiter touch in network (check unavailable).',
        debug: { ...debug, error: `network-db-parse-error: ${e.message}` },
      };
    }
  } else {
    debug.network_db_loaded = true;
  }

  const people = Array.isArray(networkDb?.people) ? networkDb.people : [];
  debug.network_db_person_count = people.length;

  // 4) Find best match across all contact × person pairs.
  // Priority order: email > linkedin > name. Within a tier, higher
  // confidence wins. Rank email=3, linkedin=2, name=1 so the comparison
  // can't be tripped by name-match returning confidence 1.0 (which would
  // otherwise tie/beat linkedin's 0.95 even though linkedin is the
  // structurally-stronger signal).
  const tierRank = (mt) => (mt === 'email' ? 3 : mt === 'linkedin' ? 2 : mt === 'name' ? 1 : 0);
  let best = null; // { contact, person, match_type, confidence }
  for (const contact of contacts) {
    for (const person of people) {
      debug.matches_considered++;
      const { match_type, confidence } = scorePair(contact, person);
      if (match_type === 'none') continue;
      const currTier = tierRank(match_type);
      const bestTier = best ? tierRank(best.match_type) : 0;
      const isBetter = !best
        || currTier > bestTier
        || (currTier === bestTier && confidence > best.confidence);
      if (isBetter) {
        best = { contact, person, match_type, confidence };
      }
      // Early exit on exact-email — can't beat the top tier with full confidence
      if (match_type === 'email') break;
    }
    if (best && best.match_type === 'email') break;
  }

  if (!best) {
    return {
      warm_contact: null,
      replacement_text: composeReplacement(null),
      debug,
    };
  }

  // 5) Build the warm_contact object + compose replacement text
  const warm_contact = {
    name: best.person.full_name || best.contact.name,
    company: best.person.current_company || row.company || '',
    last_touched_at: lastTouchedAt(best.person),
    match_type: best.match_type,
    confidence: best.confidence,
  };
  debug.best_match_type = best.match_type;

  return {
    warm_contact,
    replacement_text: composeReplacement(warm_contact),
    debug,
  };
}

// Exported for unit tests only — do NOT depend on these from other lib code.
export const _internal = {
  normalizeName,
  bigrams,
  sorensenDice,
  canonicalLinkedin,
  normalizeEmail,
  lastTouchedAt,
  personEmails,
  scorePair,
  composeReplacement,
};
