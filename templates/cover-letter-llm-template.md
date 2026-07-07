# Cover Letter LLM Template: Mitchell Williams
**Version:** 1.2, 2026-07-06 (resume-mirror alignment; 1.1 was the 2026-06-12 no-em-dash hardening)
**Prompt lives in:** `scripts/build-apply-packs.mjs` → `buildCoverLetter()`
**Voice reference:** `data/voice-reference-brief.md`
**Resume architecture + forward assets:** `data/resume-mirror-spec-2026-07-06.md` (or the newest `resume-mirror-spec-*.md`). The letter draws on the same forward assets the tailored CV leads with (exec-comms digital twin ~70% review-cycle cut, comms-triage design targets, MEJ, xGE Connects, voice-os, tax-verification-agent) and honors the same exclusions.
**Gold-standard example:** See the GOLD-STANDARD REFERENCE block in `scripts/build-apply-packs.mjs` (the `buildCoverLetter` function).

**Hard exclusions (spec § Exclusions, enforced by the grounding tollbooth):**
- No comms-triage continuity claims: never "ran through my leave", "100% operational continuity", "the team relied on it in my absence", "zero degradation". Corrected framing: "documented end-to-end and handed off with a full operator runbook".
- The triage numbers are DESIGN TARGETS: "designed to auto-handle ~60% of inbound (est.)" / "projected to recapture ~160 operational hours/year (est.)". Achieved-result framing ("auto-handled", "recaptured") fails the build. "~55% Low-Touch" is retired.
- MEJ keeps "designed to" framing (targets, not measured outcomes).
- No em dashes anywhere (see Block 2). En dashes in date ranges stay.

---

## Block 1: Framing Frame (2-3 sentences)

**Purpose:** Establish the company-specific problem Mitchell is solving. Not an introduction. Not enthusiasm. A precise diagnosis.

**Shape:** `The challenge of [X] is one I've spent [timeframe] solving: [what that means operationally].`

**Anti-patterns:**
- ❌ "I am excited to apply for..."
- ❌ "With my background in AI and communications..."
- ❌ Any sentence starting with "I" as the first word
- ❌ Company flattery ("I've long admired...")

**What changes per role:** The specific tension (AI comms integrity vs. agent deployment vs. editorial scale vs. developer enablement). The timeframe. The operational meaning.

**What stays fixed:** The diagnostic framing. The historical authority. The absence of hedging.

---

## Block 2: Signature Move (3-4 sentences)

**Purpose:** Prove the claim in Block 1 with the highest-value proof point. Narrative, not bullets. Every sentence has a metric or a named artifact.

**Shape:** `At [company], [what he built], [metric]. [What that architecture required]. [How it maps to their need].`

**No-em-dash rule:** NEVER use an em dash (the "—" character); it reads as AI-generated (feedback_no_em_dashes_in_materials, 2026-06-11). Expand a claim operationally with a colon or comma instead: `[claim]: [what that means]`.

**Anti-patterns:**
- ❌ Bullet list of matches (reads like a scraped eval report)
- ❌ Any metric not in the canonical list in `data/voice-reference-brief.md`
- ❌ "I believe my experience aligns with..."
- ❌ Two consecutive sentences starting with "I"

**What changes per role:** Which proof point leads (exec-comms digital twin ~70% review-cycle cut vs. triage agent design targets vs. MEJ vs. xGE Connects vs. AJ+ talent pipeline vs. The Stream launch vs. Fusion breaking news production). Which metric is most relevant. Pick the proof point that maps to the JD's #1 requirement, the same requirement the tailored CV's FIT FOR / HIGHLIGHTS section leads with.

**What stays fixed:** The narrative arc. The colon/comma expansion rhythm (never em dashes). The metric precision.

---

## Block 3: Human Differentiator (1-2 sentences)

**Purpose:** The thing most candidates can't say. Journalism + AI production in the same body of work. Make it about their blind spot, not his résumé.

**Shape:** `Before [current role], [historical credential], [specific institutional name + award if relevant]. [What that era built that directly applies now].`

**Anti-patterns:**
- ❌ "My unique background combines journalism and AI"
- ❌ Generic: "I bring cross-functional experience"
- ❌ Listing all prior employers (save that for Block 2 if relevant)

**What changes per role:** Which historical credential is most relevant (The Stream for social-first AI; Fusion/CNN for live crisis comms; AJ+ for global scale + editorial discipline; HuffPost Live for real-time engagement systems).

**What stays fixed:** The framing that journalism and AI are not two separate eras. They're a continuous system-building practice.

---

## Block 4: Conversational Asymmetry CTA (2-3 sentences)

**Purpose:** Lower the cost to engage by offering something specific. Not a request. An exchange.

**Shape:** `If [role condition], I can walk through [named artifact], or send a short write-up of it. [One sentence on why that artifact is directly relevant to their current phase].`

**No-time-box rule:** NEVER offer a duration ("15 minutes", "20 minutes", "a quick call for N minutes"). Offer the artifact or a walkthrough, never a meeting slot (feedback_outreach_drafting_bar). The grounding gate fails the build on any "N minutes ... walk through / chat / call" leak.

**Anti-patterns:**
- ❌ "Please don't hesitate to reach out"
- ❌ "I'd love to connect"
- ❌ "I look forward to hearing from you"
- ❌ Any generic CTA
- ❌ Asking for the job; offer the artifact

**What changes per role:** The named artifact (Voice DNA banned-phrase checklist design for editorial roles; career-ops repo architecture for FDE/SA roles; AJ+ talent pipeline pattern for enablement roles; Fusion breaking news infrastructure for live-ops roles).

**What stays fixed:** No time box (never "N minutes"): offer the artifact, not a meeting slot. The condition framing ("If the role is still open"). The offer of tangible value.

---

## Critic Pass Checklist (run after generation)

Before the file is written, the system runs a second LLM call checking:
- [ ] banned-phrase checklist violations → hard rewrite
- [ ] Fabricated metrics → remove or replace with canonical
- [ ] Comms-triage continuity claims or achieved-result framing of the ~60% / ~160-hr design targets → hard rewrite to "designed to … (est.)" framing
- [ ] Weak opening (starts with "I") → restructure
- [ ] Word count > 340 → cut one Block 2 sentence
- [ ] Fabrication guard flag → append `<!-- FABRICATION FLAGS -->` block

After the critic, the deterministic grounding tollbooth (`lib/grounding-guard.mjs`, `checkContinuity: true`) halts the row PARTIAL on any surviving retired metric, continuity claim, achieved-framing triage metric, em dash, time-boxed ask, or target-company product claim.

The critic does NOT change the structure. Only the language.

---

## Tuning Notes

**If outputs are too generic:** Add more company-specific context to the user prompt. The system prompt is fixed; the user prompt is what changes the output.

**If voice sounds AI-flat:** Add 1-2 more examples from `interview-prep/story-bank.md` to the user prompt as "additional proof points."

**If word count keeps running long:** Lower `max_tokens` in the generation call to 1,000 and add an explicit `"Return exactly 300-320 words."` instruction.

**If the critic over-edits:** Reduce the critic prompt's scope. Start by only enforcing the banned-phrase checklist, not the word count.
