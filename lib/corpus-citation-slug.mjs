/**
 * lib/corpus-citation-slug.mjs — the ONE citation-slug derivation for corpus
 * dump artifacts (data/{corp-eng,xge-comms}-artifacts/_canonical/).
 *
 * citation_slug = the <topic> token of the naming convention
 *   <org>_<YYYY-MM>_<topic-slug>_<kind>.<ext>
 * taken VERBATIM from the filename — a pure function of the conventional name,
 * with no Drive-artifact prefix stripping. `outline-design-video` stays
 * `outline-design-video`.
 *
 * Contract (bug class: slug-truncation-contract-drift-writer-verifier-reader):
 *   - WRITER  scripts/agents/corpus-sidecar-gen.mjs embeds this slug in every
 *     sidecar's `citation_slug:` / `citation_marker:` frontmatter and uses it
 *     to seed `drive_link:` from data/corpus-drive-links.json.
 *   - READER  scripts/agents/corpus-librarian.mjs --citations derives the same
 *     slug per citeable item to build citation markers and resolve links.
 *   Both surfaces MUST import this function. Before 2026-07-10 the librarian
 *   re-derived the slug through proposeName(), whose raw-Drive-name cleanup
 *   stripped an `outline-` topic prefix — 4 slugs diverged from their sidecars
 *   (writer `outline-design-video` vs reader `design-video`) and link lookups
 *   only resolved via a strip-and-retry hack. data/corpus-drive-links.json is
 *   keyed on THIS form.
 *
 * A `<name>.sidecar.md` twin yields the same slug as its source artifact
 * (`.sidecar.md` is a compound suffix, stripped before the peels), and a
 * numeric dedup kind suffix (`_doc-2.docx`) peels with the kind token.
 */

import { basename, extname } from 'node:path';

const SIDECAR_SUFFIX = '.sidecar.md';

// The source-artifact extensions the sidecar writer walks (corpus-sidecar-gen
// DOC_EXTS + TEXT_EXTS). Used ONLY to normalize a hand-made sidecar name that
// kept its source extension (`my_topic.md.sidecar.md`) back to the artifact's
// stem — the writer itself names twins `<stem>.sidecar.md` with the source
// extension already stripped. Restricted to this vocabulary so a dotted stem
// (`foo v2.5_doc`) is never mistaken for an extension and mangled.
const SOURCE_EXT_RE = /\.(?:md|txt|srt|docx|doc|pdf)$/i;

// The ONE date vocabulary of the naming convention: YYYY | YYYY-MM | YYYY-qN
// (the 0000 unknown-date sentinel matches the bare-YYYY arm; months are
// constrained to 01-12, matching what proposeName derives — census
// 2026-07-10: the only month token on disk is 09). Exported so the
// librarian's NAMING_RE / proposeName build from the same source instead of
// re-inlining it — extending the vocabulary in one place updates every
// consumer.
export const CORPUS_DATE_RE_SRC = String.raw`\d{4}(?:-(?:0[1-9]|1[0-2])|-q[1-4])?`;

// Conventional stem shape: <org>_<date>_<topic>_<kind>, where <kind> is the
// last underscore field (incl. `-N` dedup suffixes). The greedy `(.+)`
// captures everything between the date and the LAST underscore —
// byte-identical to the historical writer's two-replace peel for every
// conventional name (census 2026-07-10: 666/666 dump files, 0 diffs).
const CONVENTIONAL_STEM_RE = new RegExp(`^[^_]+_${CORPUS_DATE_RE_SRC}_(.+)_[^_]+$`);

/**
 * Derive the citation slug from an artifact (or sidecar) filename or path.
 * Conventional names (`<org>_<date>_<topic>_<kind>.<ext>`) yield the topic
 * VERBATIM; any stem that does not match the whole conventional shape falls
 * back to the extensionless stem unchanged — a partial peel of a
 * non-conventional name (`my_topic.md` → `my`) would be a junk slug, so
 * nothing is stripped unless the full shape matches.
 */
export function citationSlug(name) {
  const file = basename(name);
  const stem = file.toLowerCase().endsWith(SIDECAR_SUFFIX)
    ? file.slice(0, -SIDECAR_SUFFIX.length).replace(SOURCE_EXT_RE, '')
    : basename(file, extname(file));
  const m = stem.match(CONVENTIONAL_STEM_RE);
  // The fallback deliberately preserves the stem's ORIGINAL case: it must
  // stay byte-identical to the frozen historical writer formula that all
  // existing sidecar frontmatter and corpus-drive-links.json keys were
  // written with (tests/corpus-citation-slug.test.mjs § 3). Conventional
  // topics are lowercase by construction (NAMING_RE), so case only arises
  // on non-conventional names — where changing it would orphan legacy keys.
  return m ? m[1] : stem;
}

/**
 * Resolve a slug against a corpus-drive-links map, bridging LEGACY keys.
 * Before 2026-07-10 the reader derived slugs through proposeName's
 * raw-Drive-name cleanup, which stripped an `outline-` topic prefix — a
 * links map written in that era (or restored from a pre-re-key backup) is
 * keyed on the stripped form. Try the canonical key first, then the legacy
 * stripped form, so neither map generation resolves to TBD.
 */
export function lookupDriveLink(links, slug) {
  if (!links || typeof links !== 'object') return null;
  // Own-property + string checks: the map is JSON-parsed but a slug like
  // `constructor` or `toString` would otherwise resolve to an inherited
  // built-in and corrupt the emitted metadata.
  const ownLink = (key) => {
    if (!Object.prototype.hasOwnProperty.call(links, key)) return null;
    const value = links[key];
    return typeof value === 'string' && value ? value : null;
  };
  const canonical = ownLink(slug);
  if (canonical) return canonical;
  const legacy = slug.replace(/^outline-/, '');
  return legacy !== slug ? ownLink(legacy) : null;
}

/**
 * The citation source label for a dump group/org. Both the sidecar writer
 * (org vocabulary: 'xge' | 'corp-eng') and the librarian (group vocabulary:
 * 'xge-comms' | 'corp-eng') must emit the same label — previously each
 * re-derived it with its own inline ternary, the same duplication class
 * that produced the slug drift.
 */
export function citationSource(org) {
  return String(org).startsWith('xge') ? 'xge-comms' : 'corp-eng';
}

/** The full citation marker both surfaces embed: `[<source>: <slug>]`. */
export function citationMarker(org, slug) {
  return `[${citationSource(org)}: ${slug}]`;
}
