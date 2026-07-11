#!/usr/bin/env node
/**
 * tests/corpus-citation-slug.test.mjs
 *
 * Locks the corpus citation-slug contract:
 *
 *     writer-slug (sidecar frontmatter)  ===  reader-slug (librarian --citations)
 *
 * for corpus dump artifacts under data/{corp-eng,xge-comms}-artifacts/_canonical/.
 * Both surfaces MUST derive the slug via lib/corpus-citation-slug.mjs::citationSlug.
 *
 * Canonical incident (2026-07-10): scripts/agents/corpus-sidecar-gen.mjs (writer)
 * derived `outline-design-video` from the filename topic, while
 * scripts/agents/corpus-librarian.mjs --citations (reader) re-derived the slug
 * through proposeName(), whose raw-Drive-name cleanup regex strips an OUTLINE
 * prefix — emitting `design-video`. 4 slugs diverged (8 files incl. sidecar
 * twins); data/corpus-drive-links.json lookups only resolved via a
 * strip-"outline-"-and-retry hack in the 2026-07-10 link-injection session.
 *
 * Canonical form: the filename's <topic> token VERBATIM (the writer's form) —
 * a pure function of the conventional name <org>_<date>_<topic>_<kind>.<ext>.
 * data/corpus-drive-links.json was re-keyed to this form on 2026-07-10.
 *
 * Bug class: slug-truncation-contract-drift-writer-verifier-reader
 * (docs/BUG-CLASSES.md).
 *
 * Pure / deterministic — no LLM, no network, no dependence on the gitignored
 * dump trees (CI-safe). Usage: node tests/corpus-citation-slug.test.mjs
 * Exit: 0 on pass, 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { citationSlug, citationSource, citationMarker, lookupDriveLink, CORPUS_DATE_RE_SRC } from '../lib/corpus-citation-slug.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ── 1. The 2026-07-10 incident fixtures: outline- topic prefix survives ─────
// Artifact and its .sidecar.md twin MUST share the same slug, and the slug
// MUST keep the `outline-` prefix (the pre-fix librarian stripped it).
const INCIDENT = [
  'outline-design-video',
  'outline-draft-noogler-gte-techstop-orientation',
  'outline-leadership-video',
  'outline-project-program-and-product-management',
];
for (const topic of INCIDENT) {
  const artifact = `corp-eng_0000_${topic}_script.docx`;
  const sidecar = `corp-eng_0000_${topic}_script.sidecar.md`;
  check(`artifact slug verbatim: ${topic}`, citationSlug(artifact) === topic, `got ${citationSlug(artifact)}`);
  check(`sidecar twin shares slug: ${topic}`, citationSlug(sidecar) === topic, `got ${citationSlug(sidecar)}`);
}

// ── 2. General derivation fixtures ──────────────────────────────────────────
const CASES = [
  // conventional names: <org>_<date>_<topic>_<kind>.<ext> → topic verbatim
  ['xge_2025-11_exec-comms-constitution_agent-kb.md', 'exec-comms-constitution'],
  ['corp-eng_2024-06_noogler-credential-setup_guidance.pdf', 'noogler-credential-setup'],
  ['corp-eng_2026-q1_roi-framework_framework.docx', 'roi-framework'],
  // numeric dedup suffix on the kind token peels with the kind
  ['corp-eng_0000_remote-onboarding_doc-2.docx', 'remote-onboarding'],
  // full paths are accepted (basename applied internally)
  ['data/corp-eng-artifacts/_canonical/scripts/corp-eng_0000_outline-design-video_script.docx', 'outline-design-video'],
  // non-conventional names fall back to the extensionless stem UNCHANGED —
  // the shape gate refuses partial peels (`my_topic.md` must never become `my`)
  ['README.md', 'README'],
  ['my_topic.md', 'my_topic'],
  ['notes_only.txt', 'notes_only'],
  ['org_not-a-date_topic_doc.md', 'org_not-a-date_topic_doc'],
  // hand-made sidecar that kept its source extension still twins its artifact
  ['my_topic.md.sidecar.md', 'my_topic'],
  // ...but a dotted stem is never mistaken for an extension (twin parity:
  // `foo v2.5_doc.docx` also derives `foo v2.5_doc`)
  ['foo v2.5_doc.sidecar.md', 'foo v2.5_doc'],
];
for (const [name, want] of CASES) {
  check(`citationSlug(${name}) === ${want}`, citationSlug(name) === want, `got ${citationSlug(name)}`);
}

// ── 3. Frozen writer formula: byte-equal to the historical sidecar-gen ──────
// ~229 existing sidecars carry frontmatter written with this exact formula.
// If citationSlug ever diverges from it on a CONVENTIONAL name, every
// already-written citation_slug (and every data/corpus-drive-links.json key)
// is silently orphaned. Non-conventional names are deliberately excluded:
// there the shape-gated helper returns the stem where the frozen formula
// produced a junk partial peel (census 2026-07-10: the only real-tree
// divergences are .DS_Store junk, which is never citeable).
import { basename, extname } from 'node:path';
const frozenWriterFormula = (name) =>
  basename(name, extname(name)).replace(/^[^_]+_[^_]+_/, '').replace(/_[^_]+$/, '') ||
  basename(name, extname(name));
const FROZEN_PROBES = [
  ...INCIDENT.map(t => `corp-eng_0000_${t}_script.docx`),
  'xge_2025-11_exec-comms-constitution_agent-kb.md',
  'corp-eng_2024-06_noogler-credential-setup_guidance.pdf',
  'corp-eng_0000_remote-onboarding_doc-2.docx',
  'corp-eng_2026-q1_roi-framework_framework.docx',
];
for (const name of FROZEN_PROBES) {
  check(`frozen-writer equivalence: ${name}`,
    citationSlug(name) === frozenWriterFormula(name),
    `helper=${citationSlug(name)} frozen=${frozenWriterFormula(name)}`);
}

// ── 4. Pre-fix reader formula DIVERGES on the incident fixture ──────────────
// Regression guard: the librarian's old derivation (proposeName's Drive-artifact
// cleanup) strips a leading OUTLINE token. If someone "simplifies" citationSlug
// back toward that shape, this assert catches it.
const preFixOutlineStrip = (topic) =>
  topic.replace(/^(SCRIPT|OUTLINE|SUMMARY)_?/i, '').replace(/^-+/, '');
check('pre-fix reader formula diverges on outline- fixture (guard is meaningful)',
  preFixOutlineStrip('outline-design-video') === 'design-video' &&
  citationSlug('corp-eng_0000_outline-design-video_script.docx') !== 'design-video');

// ── 5. Source wiring: both surfaces import the ONE shared helper ────────────
const sidecarGenSrc = readFileSync(join(ROOT, 'scripts/agents/corpus-sidecar-gen.mjs'), 'utf8');
const librarianSrc = readFileSync(join(ROOT, 'scripts/agents/corpus-librarian.mjs'), 'utf8');

check('corpus-sidecar-gen imports lib/corpus-citation-slug.mjs',
  /import\s*{[^}]*\bcitationSlug\b[^}]*}\s*from\s*'\.\.\/\.\.\/lib\/corpus-citation-slug\.mjs'/.test(sidecarGenSrc));
check('corpus-sidecar-gen has NO local citationSlug re-implementation',
  !/function\s+citationSlug\s*\(/.test(sidecarGenSrc));
// The writer must actually FEED the shared helper's output into the
// frontmatter it emits — an unused import, dead code, or a logging-only call
// would otherwise pass. Pin the exact production dataflow: the `slug`
// binding comes from citationSlug, and the emitted citation_slug /
// citation_marker / drive_link fields consume that binding.
check('corpus-sidecar-gen binds slug via the shared helper (`const slug = citationSlug(name)`)',
  /const slug = citationSlug\(name\)/.test(sidecarGenSrc));
check('corpus-sidecar-gen frontmatter emits citation_slug from that binding',
  /`citation_slug: \$\{slug\}`/.test(sidecarGenSrc));
check('corpus-sidecar-gen frontmatter emits citation_marker via the shared citationMarker(org, slug)',
  /`citation_marker: "\$\{citationMarker\(org, slug\)\}"`/.test(sidecarGenSrc));
check('corpus-sidecar-gen seeds drive_link via lookupDriveLink(driveLinks, slug)',
  /lookupDriveLink\(driveLinks, slug\)/.test(sidecarGenSrc));
check('corpus-librarian imports lib/corpus-citation-slug.mjs',
  /import\s*{[^}]*\bcitationSlug\b[^}]*}\s*from\s*'\.\.\/\.\.\/lib\/corpus-citation-slug\.mjs'/.test(librarianSrc));

// Scope the derivation asserts to the runCitations function body itself, so a
// future edit can't keep the import while deriving the citation slug some
// other way (an alias, a different helper, or a reintroduced proposeName
// call) and still pass. The region runs from the runCitations declaration to
// the next top-level function/section boundary.
const citationsRegion = (() => {
  const start = librarianSrc.indexOf('function runCitations');
  if (start < 0) return '';
  const rest = librarianSrc.slice(start);
  // region ends at the next top-level function declaration after runCitations
  const end = rest.slice(1).search(/\n(?:async )?function \w+\(/);
  return end >= 0 ? rest.slice(0, end + 1) : rest;
})();
check('runCitations region located in corpus-librarian source', citationsRegion.length > 0);
check('runCitations binds slug via the shared helper (`const slug = citationSlug(i.path)`)',
  /const slug = citationSlug\(i\.path\)/.test(citationsRegion));
check('runCitations emits citation_marker via the shared citationMarker(i.group, slug)',
  /citation_marker: citationMarker\(i\.group, slug\)/.test(citationsRegion));
check('runCitations resolves drive_link via lookupDriveLink(linkMap.links, slug)',
  /lookupDriveLink\(linkMap\.links, slug\)/.test(citationsRegion));
check('runCitations does NOT derive the slug via proposeName',
  !/\bproposeName\(/.test(citationsRegion));

// ── 6. Date-vocabulary single source ─────────────────────────────────────────
// NAMING_RE (naming audit) and citationSlug (citation derivation) must share
// ONE date vocabulary. The librarian builds its date arms from the exported
// CORPUS_DATE_RE_SRC; if either side re-inlines the pattern, they can drift.
const dateRe = new RegExp(`^(?:${CORPUS_DATE_RE_SRC})$`);
for (const good of ['0000', '2024', '2024-06', '2026-q1']) {
  check(`date vocabulary accepts ${good}`, dateRe.test(good));
}
for (const bad of ['24', '2024-q5', 'undated', '2026-00', '2026-13', '2026-99']) {
  check(`date vocabulary rejects ${bad}`, !dateRe.test(bad));
}
check('corpus-librarian builds NAMING_RE from the shared CORPUS_DATE_RE_SRC',
  /NAMING_RE = new RegExp\(\s*`[^`]*\$\{CORPUS_DATE_RE_SRC\}/.test(librarianSrc));
check('corpus-librarian imports CORPUS_DATE_RE_SRC from the shared lib',
  /import\s*{[^}]*\bCORPUS_DATE_RE_SRC\b[^}]*}\s*from\s*'\.\.\/\.\.\/lib\/corpus-citation-slug\.mjs'/.test(librarianSrc));

// ── 7. lookupDriveLink — legacy-key bridge fixtures ──────────────────────────
// Both generations of data/corpus-drive-links.json must resolve: the
// re-keyed canonical map AND a pre-2026-07-10 map still keyed on the
// stripped legacy form (e.g. restored from the pre-re-key backup). Pure
// fixtures — no user-layer data touched.
const CANON = 'outline-design-video';
const LEGACY = 'design-video';
const URL_A = 'https://docs.google.com/document/d/CANONICAL';
const URL_B = 'https://docs.google.com/document/d/LEGACY';
check('lookupDriveLink resolves the canonical key',
  lookupDriveLink({ [CANON]: URL_A }, CANON) === URL_A);
check('lookupDriveLink bridges a legacy stripped-key map',
  lookupDriveLink({ [LEGACY]: URL_B }, CANON) === URL_B);
check('lookupDriveLink prefers the canonical key when both exist',
  lookupDriveLink({ [CANON]: URL_A, [LEGACY]: URL_B }, CANON) === URL_A);
check('lookupDriveLink returns null when neither key exists',
  lookupDriveLink({}, CANON) === null);
check('lookupDriveLink does NOT bridge non-outline slugs',
  lookupDriveLink({ video: URL_B }, 'design-video') === null);
check('lookupDriveLink tolerates a missing map',
  lookupDriveLink(undefined, CANON) === null);
check('lookupDriveLink never resolves prototype-chain keys',
  lookupDriveLink({}, 'constructor') === null && lookupDriveLink({}, 'toString') === null);
check('lookupDriveLink rejects non-string map values',
  lookupDriveLink({ [CANON]: { nested: true } }, CANON) === null);

// ── 8. Shared citation source + marker (one derivation across vocabularies) ──
// The writer speaks org ('xge' | 'corp-eng'), the librarian speaks group
// ('xge-comms' | 'corp-eng') — both must land on the same label.
check("citationSource('xge') === 'xge-comms'", citationSource('xge') === 'xge-comms');
check("citationSource('xge-comms') === 'xge-comms'", citationSource('xge-comms') === 'xge-comms');
check("citationSource('corp-eng') === 'corp-eng'", citationSource('corp-eng') === 'corp-eng');
check('citationMarker agrees across both vocabularies',
  citationMarker('xge', CANON) === citationMarker('xge-comms', CANON) &&
  citationMarker('corp-eng', CANON) === `[corp-eng: ${CANON}]`);

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(failures === 0
  ? '\n🟢 corpus-citation-slug contract holds — writer and reader share one derivation'
  : `\n🔴 ${failures} corpus-citation-slug contract failure(s)`);
// Machine sentinel for test-all §33: only a run that reached the verdict line
// is a contract verdict — a syntax error / import crash never prints it, so
// the runner can distinguish drift from a broken child.
console.log(`CITATION_SLUG_CONTRACT_VERDICT: ${failures === 0 ? 'PASS' : 'FAIL'}`);
// exitCode (not process.exit) so piped stdout is flushed before termination —
// otherwise the verdict sentinel can be lost and test-all §33 misclassifies a
// real contract failure as a runner failure.
process.exitCode = failures === 0 ? 0 : 1;
