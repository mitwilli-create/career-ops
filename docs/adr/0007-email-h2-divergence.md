# ADR-007 — Email H2 = 16px (intentionally smaller than dashboard H2 = 18px)

**Date:** 2026-05-19
**Status:** ACCEPTED
**Authors:** Phase E2 (real-council ratification of Phase C Decision C)
**Source:** `.claude/audit/email-review/council-divergence-analysis.md`
findings 011 + 012, ratified by Phase E1 real-council vote
**Related code:** `lib/heartbeat-tokens.json` (`typography.size.h2_email`),
`scripts/heartbeat.mjs` (`renderContentHtml` H2 emission, ~line 241),
`scripts/heartbeat-evening.mjs` (`renderContentHtml` H2 emission, ~line 168),
`templates/heartbeat.mjml`.

---

## Context

The career-ops dashboard and the daily heartbeat emails share a single
design-token system (`lib/heartbeat-tokens.json`). They are intentionally
visually-cohesive — at 1440×900, a user looking at the dashboard and a
recent heartbeat email side-by-side should perceive them as the same
product family.

The dashboard renders H2 section openers at **18px** (the
`typography.size.h2_dashboard_large` token). The natural design-system-parity
move is to render the email H2 at 18px as well.

However, the heartbeat email is read primarily on mobile clients:
- Gmail iOS (the dominant inbox, where Mitchell triages from his phone)
- Apple Mail iOS
- Gmail Web on mobile-rendering breakpoint

These clients run on WebKit (or share the same text-autosize heuristic).
WebKit's mobile text-autosize scales any font-size below ~17px upward by a
fudge factor that varies with viewport width and font-family — but never
scales sizes ≥ 17px. The net effect is that an 18px declared H2 renders
visually identically to a 17px declared H2 on mobile WebKit, but renders
larger relative to body text in the same client.

The dashboard does NOT hit this autosize path because it's a desktop-first
surface with explicit responsive breakpoints and is rendered with
`text-size-adjust: 100%` (or its equivalents per OS theme).

The Phase C council (simulated Sonnet-only) chose 16px for email H2 with
this trade-off in mind. The Phase E1 real-council (7 LLMs) confirmed:

- **Persona 3 (a11y typography): unanimous 7/7 APPROVE 16px.**
  WebKit autosize scales the body text up; a 16px H2 against a 14px
  body produces a ~1.4-1.5× visual size ratio on mobile, which is the
  WCAG-compliant heading-to-body delta. An 18px declared H2 would land
  at ~2× ratio on mobile, breaking the visual hierarchy by making the
  H2 dominate the card.
- **Persona 1 (email-rendering): unanimous 7/7 APPROVE 16px.**
- **Persona 2 (design-system): 2/7 REJECT, 3/7 MODIFY, 2/7 APPROVE.**
  The REJECT/MODIFY votes are about NAMING and ARCHITECTURE
  (h2_email vs h2_dashboard suffix-naming, want compiler-layer resolution),
  not about the rendered pixel value. The Persona-2 architectural concern
  is addressed by the `typography.role.*` semantic-layer roadmap
  (finding-008), not by reverting the pixel value.

Net: **6/7 ratify 16px. The 1/7 CONTEST (grok-4-x-search) is a
minority-of-1 design-system dissent that does not carry on rendering or
a11y grounds.**

---

## Decision

**`typography.size.h2_email = "16px"`. `typography.size.h2_dashboard_large = "18px"`.**

The two surfaces intentionally diverge by 2px in the declared H2 size.
This is NOT a bug, NOT a token drift, NOT something to "fix" in a future
cleanup pass. It is a deliberate calibration against mobile WebKit
autosize.

---

## Consequences

### Positive
- Heartbeat H2 reads as a proper section opener on mobile WebKit
  (Gmail iOS, Apple Mail iOS) without dominating the card.
- 16px declared maps to ~17-18px visual on mobile after autosize, so it
  STILL reads as larger than body text — the hierarchy is preserved.
- The dashboard's 18px H2 remains correct for desktop-first reading.

### Negative
- Tokens for the same semantic concept (section title) differ by surface,
  which is debt against design-system-parity (a hand-maintained 2px
  divergence). The Phase E1 council surfaced this as finding-008:
  introduce a `typography.role.*` semantic layer where roles resolve to
  `{size, weight, line-height, surface_override?}` tuples. The 16px-email
  vs 18px-dashboard divergence becomes a `role.section_title` with a
  `surface_override` for email — modeled, not hardcoded.
- Until the role.* layer lands, the `_note_h2_email` field in
  `lib/heartbeat-tokens.json` (added in Phase E2) is the primary
  mechanism to alert future maintainers to the intentional divergence
  at the point of editing.

### When to revisit
- **Apple/WebKit changes autosize behavior on mobile.** If iOS releases
  a WebKit update that changes the autosize threshold (or removes it
  entirely), the 16px-vs-18px calibration may need to be re-derived.
- **The role.* layer lands.** When finding-008 ships, this divergence
  is encoded in `role.section_title.surface_override` and this ADR
  becomes a historical reference rather than a live document.
- **A new client appears.** If Apple Mail / Gmail / Outlook ship a desktop
  client that hits mobile-WebKit-style autosize, the per-surface override
  may need to extend to include that client. Cover that case via the
  role.* layer when it lands; do not extend the suffix-naming hack.

---

## Implementation notes

- **`lib/heartbeat-tokens.json`** — `typography.size.h2_email` stays 16px.
  The `_note_h2_email` field flags the intentional divergence at the
  point of editing.
- **`scripts/heartbeat.mjs`** — `renderContentHtml` emits `<h2>` at
  `font-size:16px` (~line 241).
- **`scripts/heartbeat-evening.mjs`** — same emission (~line 168).
- **Visual regression check** — recommended: a screenshot regression
  via Playwright or Litmus at 375px + 600px in Gmail iOS, Apple Mail,
  and Outlook Web. The screenshot pair locks the 16px H2 against
  the 14px body so a future contributor can't silently revert via a
  `2026-08-30: switched email H2 to match dashboard 18px` commit
  without the regression catching it. Implementation deferred to a
  follow-on phase (not in Phase E2 scope).

---

## References

- `.claude/audit/email-review/council-divergence-analysis.md` finding 011 +
  012 (Phase E1 real-council ratification source).
- `.claude/audit/email-review/phase-c-council-ledger.md` (simulated council
  Decision C — first time 16px was chosen).
- `lib/heartbeat-tokens.json` — `typography.h2_email_spec` block
  (the full {font_size, font_weight, letter_spacing, etc.} spec).
- WebKit text-autosize source:
  https://www.webkit.org/blog/3074/text-rendering-on-the-web/
  (historical reference; behavior has evolved since 2014 but the
  ≥17px-no-scale heuristic still holds in 2025).
