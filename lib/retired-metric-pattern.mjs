/**
 * lib/retired-metric-pattern.mjs
 *
 * SINGLE SOURCE OF TRUTH for the "retired-metric fabrication leak" detector.
 *
 * `PAT` is a grep -E (ERE) alternation of every HARDENED-CV-SPEC-2026-05-30
 * retired metric + post-hardening banned phrasing: stylistic/voice fidelity,
 * >90% / &gt;90% / "better than" 90% accuracy, drafting-latency cuts (both word
 * orders), 3.5h mentorship times, 348 / 300%+ / 93% CSAT, top 0.5%, L8+ / L8–L10
 * Google-internal levels, 180K headcount, and the banned "kill list" branding.
 * `EXCL` is the disclosure-note allowlist so "…dropped" / "No retired metrics:
 * <list>" / "corrected or dropped" / "Metric-hardened" record lines never
 * false-flag as a live claim.
 *
 * WHY THIS FILE EXISTS: the pattern was hand-copied into
 * scripts/scrub-fabrications.mjs + scripts/verify-dashboard-real-2026-05-31.mjs +
 * scripts/verify-overnight-2026-05-31.mjs and DRIFTED — the two verifiers lacked
 * the 2026-06-11 (180K) and 2026-06-14 (HTML-entity &gt;, "better than", bare
 * "accuracy", drafting-latency word-order, voice-fidelity, 3.5h prose, L8+,
 * kill-list) hardening, so three verifiers could DISAGREE on what counts as a
 * leak. Bug class: contract-drift-across-layers / stale-coupling
 * (docs/BUG-CLASSES.md). The invariant test
 * tests/retired-metric-pattern-single-source.test.mjs asserts this module is the
 * ONLY place `const PAT` / `const EXCL` is defined under scripts/ + lib/.
 *
 * USAGE CONTRACT: both are consumed as grep ERE STRINGS interpolated into
 * `grep -nE "${PAT}" | grep -vE "${EXCL}"`. The escaping (\\. -> literal dot,
 * \\+ -> literal plus, literal spaces, the en-dash range in L8[–-]L10) is
 * grep-ERE escaping and MUST be preserved verbatim. The alternation also compiles
 * as a JS RegExp (`new RegExp(PAT)`), which the single-source test verifies.
 *
 * $0 — no LLM, no network, no personal data. Safe in CI.
 */
// 2026-07-06 extension (resume-mirror-spec exclusions): comms-triage CONTINUITY
// claims ("100% operational continuity", agent ran through the extended leave,
// team relied on it in absence, zero degradation in classification) + the
// retired "~55% Low-Touch" share. These have NO grammar-safe auto-rewrite
// (sentence subjects vary), so they fail loud in scrub-fabrications.mjs and
// get hand-fixed; the parenthetical "(~55% Low-Touch)" form auto-deletes there.
export const PAT = '99% stylistic fidelity|stylistic[- ]fidelity|99% fidelity|99% voice fidelity|(>|&gt;|greater than|over|better than)? ?90% (classification|accuracy)|(cut|cutting|reduced) drafting latency( by)? 90 ?(%|percent)|substantial (reduction in drafting|drafting[- ]latency)|90% (reduction in )?(admin|administrative|drafting|latency)|3\\.5[ -]?(hours?|hrs?)|300%\\+ (active|capacity|scaling|deployment)|348 (attendees|senior eng|senior tech|of them)|93% CSAT|9,000 machines and 9,500|top 0\\.5%|(three|3) (shipped |deployed |distinct |production-grade )?production (AI|LLM) (agents|systems|builds|artifacts|deployments|surfaces)|(three|3) production (AI voice |AI |LLM |voice )?agents|1,000 senior|180(,?000|K)[ -]?(person|people|employee|eng|engineering|Google|workforce)|L8\\+|L8[–-]L10|[Kk]ill[ -][Ll]ist|100% operational continuity|zero degradation in classification|relied on (it|the agent) [^.]{0,30}absence|(ran|running|operated|kept running)[^.]{0,60}(through|during)[^.]{0,40}extended leave|55% Low[- ]Touch';
export const EXCL = 'quarantine|zzz-polish|unsupported|dropped|Metric-hardened|corrected or dropped|No retired metrics';
