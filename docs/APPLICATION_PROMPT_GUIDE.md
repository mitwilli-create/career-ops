# Application Materials Prompt Guide
### Mitchell Williams · Claude Sonnet 4.6 · career-ops
#### Revised: 2026-05-06 — Integrated Grok community intelligence (Reddit/X/Blind/HN, Mar–May 2026)

> **Reusable for every role in the Apply Now queue.**
> Run phases in the order shown. This order is not arbitrary — it reflects what community data says about where callback rates actually come from.

---

## The Brutal Reality First

From 700+ real candidate reports (Reddit r/cscareerquestions, r/jobsearchhacks, Blind Anthropic/OpenAI megathreads, X threads, Mar–May 2026):

| Channel | Approx. callback rate |
|---|---|
| Cold application, generic materials | ~2–4% |
| Cold application, highly tailored materials | ~8–12% |
| **Referral or warm intro** | **~20–30% (5× cold)** |
| Referral + company-specific 1-pager/prototype | ~35–45% |
| Public "audition" artifact (GitHub/demo) + outreach | High, anecdotal but consistent |

**What this means for how you run this guide:**
- Phases 0 and 0.5 (referral sourcing and audition artifact) are your highest-leverage moves
- Application materials (Phases 1–4) are still required — but they're what backs up the referral, not the primary bet
- 40–80% of applications are AI-generated in 2026; recruiters at Anthropic/OpenAI say they spot slop in under 20 seconds; the 70–80% human rewrite rule is non-negotiable

---

## Contents

- [Live Role Targets Right Now](#live-role-targets-right-now)
- [Mitchell's Context Block](#mitchells-context-block) ← paste once per session
- [Phase 0 — Referral Activation (do this first)](#phase-0--referral-activation)
- [Phase 0.5 — Audition Artifact](#phase-05--audition-artifact)
- [Phase 1 — Job Intelligence Decode](#phase-1--job-intelligence-decode)
- [Phase 2 — CV Tailoring](#phase-2--cv-tailoring)
- [Phase 3 — Cover Letter](#phase-3--cover-letter)
- [Phase 4 — Application Form Fields](#phase-4--application-form-fields)
- [Phase 5 — ATS + Format Checklist](#phase-5--ats--format-checklist)
- [Phase 6 — 1-Pager / HM Outreach](#phase-6--1-pager--hm-outreach)
- [Phase 7 — Pre-Submit Quality Check](#phase-7--pre-submit-quality-check)
- [Phase 8 — Interview Defense Prep](#phase-8--interview-defense-prep)
- [Grok Prompt Template](#grok-prompt-template)

---

## Live Role Targets Right Now

> Community intelligence (Blind megathreads + company career pages, April–May 2026)
> flags these as active, near-exact profile matches for Mitchell's comms × builder hybrid.
> Apply within 48 hours of posting — early applicants bypass initial AI-screen volume.

| Company | Role | Why it fits | Apply channel |
|---|---|---|---|
| **Anthropic** | Internal Communications Manager (Policy) | Comms + judgment + AI-native = exact match | careers.anthropic.com directly |
| **Anthropic** | Communications Lead (Claude Code) | Developer-adjacent comms; builder fluency required | careers.anthropic.com directly |
| **Anthropic** | Engineering Editorial Lead | Editorial at AI-scale; broadcast → agent pipeline bridge | careers.anthropic.com directly |
| **OpenAI** | Executive Communications Manager | VP-comms + production AI = rare combination | openai.com/careers |
| **OpenAI** | AI Enablement Lead | Stakeholder translation + shipped systems | openai.com/careers |
| **Any AI-native** | Forward Deployed Engineer | Comms triage agent is the proof point | Company career page first |

**Timing rule:** Apply within 48 hours of posting. Company career page is primary. Google for Jobs surfaces different listings than LinkedIn (~10% app-to-interview rate vs. LinkedIn's lower signal-to-noise). Use LinkedIn's 1-hour filter (`f_TPR=r3600` parameter) to surface freshest postings.

---

## Mitchell's Context Block

> **Paste this at the start of every fresh Claude session.** One paste, zero re-explaining.

```
You are working as an expert application strategist for Mitchell Williams.
Reference this context throughout our entire session.

─── IDENTITY ───
Name: Mitchell Williams
Location: Seattle, WA (open to relocation globally — location is never a hard blocker)
Email: mitwilli@gmail.com | LinkedIn: linkedin.com/in/mitwilli
GitHub: github.com/mitwilli-create | Portfolio: thestorytellermitch.com

─── CURRENT ROLE ───
Internal Communications Lead + Program Manager
Google — Office of Cross-Google Engineering (xGE) | June 2024 – present
Audience: ~1,000 senior technical ICs at Principal / Distinguished / Fellow tiers —
Google's top 1–2% of technical staff globally.

─── THREE DEPLOYED PRODUCTION AI AGENTS ───
These are not prototypes. Not demos. Production systems.

1. COMMUNICATIONS TRIAGE AGENT (Google xGE)
   Architecture: 3-prompt (triage → revise → escalate) + conditional KB loading
   Audience: ~1,000 senior Google engineers
   Impact: ~160 operational hours/year recaptured | >90% classification accuracy
   Status: Production, deployed

2. EXECUTIVE RAG PIPELINE / VOICE DNA (Google xGE)
   Architecture: VP-level "digital twin" — curated Voice DNA corpus + Kill List
   of rejected drafts that teach the agent risk tolerance and rhetorical pace
   Impact: 90% reduction in drafting latency | 99% stylistic fidelity for VP comms
   Status: Production, deployed

3. VOICE OS (personal corpus)
   Architecture: 1.08M-word corpus (Gmail 2007–2026, Instagram, Facebook,
   LinkedIn, iMessage) → voice signatures + AI-detection risk surface
   Impact: 6-axis voice scoring system
   Status: Production, personal deployment

─── THE DIFFERENTIATOR — say this out loud ───
"I don't just communicate about AI. I build the agents that make communication
10× more effective — and I've done it in production, at Google's senior engineering
leadership scale."

Most comms people cannot build. Most builders cannot write for the C-suite.
Mitchell is the rare candidate who does both, with measurable production proof.

─── ADDITIONAL PROOF POINTS WITH METRICS ───
• Mentorship Platform: 90% admin reduction (3.5 hrs → 20 min/match), 300%+ capacity scaling
• Q1 2020 remote-work pivot: 9,000 machines + 9,500 hotspots in one week
• Day One overhaul: 75,000+ new hires; 88% autonomous hardware provisioning in 24 hrs
• AJ+ viral campaign: 50M+ views, 40K+ comments
• career-ops fork: Agentic pipeline with zero-token portal scanning, unattended schedule

─── FRAMING LANGUAGE THAT LANDS (use these, not paraphrases) ───
• "VP-level writer who ships production AI systems"
• "I translate complex AI systems into stakeholder action — and I build the systems doing the translating"
• "Comms × builder hybrid — one hire who does what usually requires two"
• "Voice DNA / Kill List methodology" (coined; Mitchell's IP)
• "Live-broadcast-grade operating discipline" (the no-edit-window analogy to agentic pipelines)

─── TARGET ROLE ARCHETYPES ───
Primary (A2): AI Solutions Architect, Forward Deployed Engineer, Applied AI Engineer,
AI Enablement Lead, AI Program Manager, AI Technical Program Manager
Secondary (B): Developer Education Lead, Developer Advocate, Communications Lead,
Engineering Editorial Lead at AI-native companies

─── COMPENSATION ───
Target: $140K–$240K TC | Walk-away floor: $110K (remote/int'l) | Seattle floor: $120K

─── VOICE CONSTRAINTS (always active — no exceptions) ───
Hard rules:
• Lead with the point — never bury the lede
• Short sentences. Active voice. Strong verbs.
• 350-word max on professional emails; 300-word max on cover letters
• Every draft must survive a 40% cut without losing what makes it Mitchell's
• No adjectives without evidence ("strong communicator" → always a specific example)
• 70–80% human rewrite of any AI draft — add personal anecdotes, ownership language, messy real-world details

Banned phrases (non-negotiable): "passionate about", "leverage", "synergy",
"results-driven", "thought leader", "innovative", "detail-oriented", "team player",
"go-getter", "I am excited to", "I would love to", "best-in-class", "move the needle",
"at the end of the day", "circle back", "deep dive", "value add", "I am writing to",
"dynamic", "cutting-edge", "game-changer", "hit the ground running"

Context loaded. Ready for [Phase X].
```

---

## Phase 0 — Referral Activation

> **Do this before submitting anything. Referrals deliver 5× the callback rate of cold apps.**
> The goal: identify who you know (or who you know who knows someone) at the target company,
> and activate that connection before or the same day as applying.

### Step 0A — Network Map (do this yourself, then prompt Claude)

For each target company:
1. Search LinkedIn: `[Company Name] + "Google" OR "xGE" OR "Internal Communications" OR "Program Manager"` — find 1st and 2nd-degree connections
2. Check X/Twitter: who at this company posts about AI, comms, or enablement?
3. Check your Google network: any colleagues who moved to this company?

### Prompt 0A — Referral Outreach Strategy

```
Context is loaded.

I want to get a referral at [COMPANY] for [ROLE]. I've identified these potential
connections:
[List what you found: Name, title, connection degree, any context on them]

For each connection, write:
1. The right channel (LinkedIn note, email, X DM, shared Slack, mutual intro)
2. A specific reason to contact them (not "I saw you work at [Company]")
3. A draft message — 100 words maximum:
   • Opens with something specific to them or their work
   • One sentence on my profile signal (agents + Google xGE — specific)
   • A clear, low-friction ask ("Would you be open to sharing any context
     on what the team is working on?" — not "Can you refer me?")
   • Zero banned phrases

If I have no direct connections at [COMPANY], identify:
• Recently promoted employees I could cold-approach with a specific value offer
• Any Google alumni who've moved there (use your training data)
• What online communities (Slack, Discord, X, HN threads) might have employees from this team
```

---

## Phase 0.5 — Audition Artifact

> **The highest-leverage outreach is a working artifact, not just words about yourself.**
> Community data (X @noahbkuhn May 2026, career-ops thread @heygurisingh Apr 2026):
> candidates who built a company-specific demo or 1-pager got responses where cold applications failed.

There are two artifact types. Use whichever fits the role.

### Option A — Company-Specific 1-Pager

A single page (PDF or Notion) that shows:
1. **Their problem** — one specific comms/enablement/AI pain you've observed at their company (from public posts, release notes, docs, job descriptions)
2. **Your solution** — how one of your three production agents could address it, adapted to their context
3. **The evidence** — the metric from your deployment that proves you've solved an analogous problem

### Option B — Mini Working Prototype

A public GitHub repo or Loom recording of a small agent/tool adapted to their domain. Does not need to be production-ready. Needs to show judgment and architectural thinking.

### Prompt 0B — 1-Pager Strategy

```
Context is loaded.

I want to build a company-specific 1-pager for [COMPANY] targeting [ROLE].

Here is what I know about their current work / pain points:
[Paste: recent product announcements, blog posts, job description language,
public statements about comms/AI challenges]

Design the 1-pager structure:
1. THEIR PROBLEM — Write 2–3 sentences framing a specific comms, enablement, or
   operational AI pain at [COMPANY] that I've identified from public signals.
   Make it specific enough that a reader thinks "they've done their homework."

2. THE ANALOGOUS PROOF — Which of my 3 production agents best maps to this problem?
   Write the 2-sentence connection: "At Google xGE, I faced a similar challenge.
   Here's what I built and what happened."

3. MY PROPOSED APPROACH — In 3 bullet points, how would I adapt my agent/methodology
   to their specific context? Keep it directional, not exhaustive.

4. THE ASK — One sentence. Specific and low-friction.
   ("15 minutes to discuss how this maps to what your team is building.")

Format: Fits on one page. Can be pasted into a Notion page or exported as PDF.
Zero banned phrases. Reads like someone who has shipped, not someone who is pitching.
```

---

## Phase 1 — Job Intelligence Decode

> **Run this before touching materials.** Decode the actual ask behind the JD.

### Prompt 1A — Deep JD Decode

```
Context is loaded.

[PASTE FULL JOB DESCRIPTION HERE]

Decode this JD as a senior hiring manager who wrote it. Return:

1. THE REAL ROLE (1 sentence)
   Strip marketing copy. What is this person doing day-to-day?

2. THE THREE THINGS THAT WIN THIS APPLICATION
   Ranked by weight. What does the hiring manager care about most?

3. SUBTEXT (what they didn't say but implicitly require)
   Read between the lines. What unstated signals are in the JD?

4. MY BEST ANGLE
   Given my profile above, what is my single strongest argument for this role?
   Name the differentiator: comms × builder, or scale of audience, or
   production proof — whichever fits this specific role best.

5. MY GAPS + BRIDGES
   What does this JD require that I don't clearly demonstrate?
   For each gap: suggest a bridge framing or proof-point substitution.

6. KILLER KEYWORDS (10–15)
   Exact phrases that must appear naturally in my materials to pass ATS
   and resonate with a human reader.

7. THEIR PAIN (1 sentence)
   The problem this company is solving by hiring for this role.
   This becomes the first sentence of my cover letter.

8. CULTURE SIGNALS
   What does the language of this JD tell me about what this team actually values?
   How do I mirror that in my materials without sounding like I just copied their vocabulary?

9. ANTHROPIC-SPECIFIC (if applicable)
   Anthropic culture-fit questions to prepare for:
   — "How would you communicate a model capability limitation to executives?"
   — "Describe a time you made a complex technical tradeoff accessible to non-technical stakeholders"
   — "How do you think about mission alignment in your day-to-day work?"
```

### Prompt 1B — 6-Second Recruiter Scan

```
Context is loaded. JD decoded above.

Act as a senior recruiter at [COMPANY] who receives 400+ applications per role
and makes a pass/fail decision in 6–8 seconds on first scan.

1. PASS or FAIL — does my profile survive first scan for this role?
   Be specific about what earns the pass or triggers the fail.

2. ABOVE-THE-FOLD CHECK — what does a recruiter see in 6 seconds?
   (Title, summary headline, first bullet.) Is it immediately clear why I'm right for THIS role?

3. THE ONE LINE — what single line in my CV earns the next 30 seconds?

4. THE KILL SHOT — what would cause a recruiter to stop and email me today?
   What is the most unusual and credible signal in my profile for this company?

5. FILTER RISK — what might cause an ATS or first-pass screener to filter me out?
   Specific fix for each risk.
```

---

## Phase 2 — CV Tailoring

> **Format rules (from ATS failure data, Reddit r/jobsearchhacks April 2026):**
> - Single-column layout. No tables, graphics, multi-columns, or color headers.
> - Standard fonts: Arial or Calibri, 10–11pt.
> - Reverse-chronological.
> - 1 page preferred; 2 pages only if every bullet adds signal.
> - Submit both .docx AND clean PDF — higher parse success reported.
> - **Put "Production AI Systems Shipped" or equivalent section IMMEDIATELY after summary.**
>   Recruiter scan lands there first. Lead with the agents.

### Prompt 2A — Role-Specific Bullet Rewrites

```
Context is loaded. JD decoded (Phase 1).

Here is my current experience section:
[PASTE YOUR CURRENT CV BULLETS FOR THE 2–3 MOST RELEVANT ROLES]

For each bullet:
1. Score 1–5 for relevance to THIS role (1 = barely relevant, 5 = exact match)
2. Rewrite every bullet scoring 4–5 using CAR format:
   Challenge (or Context) → Action (what I specifically did) → Result (metric)
3. For bullets scoring 1–3: suggest a replacement from my proof points,
   or recommend dropping for this application

Rewrite rules:
• CAR format — lead with the outcome, not the task
• Embed killer keywords naturally (from Phase 1 decode)
• Keep all metrics — never remove a number; add one if missing
• Maximum 2 lines per bullet — ruthless compression
• Active voice, strong verbs — no "was responsible for", no "helped with"
• Do not start two consecutive bullets with the same verb
• Every bullet must be defensible in an interview — no vague claims
```

### Prompt 2B — Production AI Systems Section

> This section leads your CV above all other experience.

```
Context is loaded.

Write a "Production AI Systems" section for my CV targeting [ROLE] at [COMPANY].
This section appears immediately after my summary, before my work history.

Format: 3 entries, one per agent. Each entry:
• Name + one-line description of the system
• Architecture beat (1 sentence — what it does technically, calibrated to [ROLE]'s
  technical depth requirement)
• Impact beat (1 metric — the most impressive number)
• Scale beat (audience or scope — "serving ~1,000 Google Principal/Distinguished/Fellow engineers")

After the section, write: "PLACEMENT NOTE — where on the page does this section create
the most impact for this specific role?" Give me the layout logic.
```

### Prompt 2C — Three-Angle Summary Comparison

```
Context is loaded.

Write THREE versions of my CV summary for [ROLE] at [COMPANY]:

VERSION A — BUILDER LEAD
Open with the three production agents. Make the first sentence about
what I've shipped, not who I am.

VERSION B — SCALE LEAD
Open with the audience: ~1,000 senior Google engineers at Principal/Distinguished/Fellow tier.
Frame everything through the lens of operating at engineering leadership scale.

VERSION C — HYBRID LEAD
Open with the rarity of the comms × builder combination.
First sentence: no other candidate can say what I'm about to say.

After all three: which version best fits THIS specific role? Why?
Which version would cause a recruiter at [COMPANY] to stop and read the next paragraph?
```

---

## Phase 3 — Cover Letter

> **Write only when the role explicitly requests one, or for top-priority targets.**
> Most ATS systems don't parse cover letters — spend time on it only when a human reads it first.
> The goal: make them want to call you before they finish the first paragraph.

### Prompt 3A — Cover Letter Draft

```
Context is loaded. JD decoded (Phase 1).

Write a cover letter for [ROLE] at [COMPANY].

STRUCTURAL RULES:
• PARAGRAPH 1 — Open with THEIR situation. Not "I am applying for..."
  First sentence is about their pain or a specific thing they're building.
  Signal you understand what they need before you say anything about yourself.
• PARAGRAPH 2 — One proof point. Not a summary of your career.
  The single strongest story for this specific role. One metric. One system. Real.
• PARAGRAPH 3 — The comms × builder hybrid angle.
  What you bring that a single-discipline hire cannot.
  Use the framing: "I don't just communicate about AI — I build the agents
  that make communication 10× more effective." Adapt as needed.
• CLOSING — Specific and direct. Not "I hope to hear from you."
  Reference something specific about [COMPANY] or the team's current work.

VOICE RULES:
• 300 words maximum — shorter is better
• Zero banned phrases
• No adjectives without evidence
• Reads like a person wrote it — messy real-world details, first-person ownership,
  specific decisions ("I decided to..." not "the team decided to...")
• Human-rewrite this draft 70–80% before sending — add your actual voice

After draft, output:
— WHAT WORKS: 2 strongest lines
— WHAT TO WATCH: 1 thing to human-edit
— CUT VERSION: 150-word version for character-limited fields
```

### Prompt 3B — The Roast

```
Act as a brutally honest senior hiring manager who rejects 90% of cover letters
in under 30 seconds and has seen every template on the internet.

Cover letter: [PASTE DRAFT]

Tell me:
1. Is the first sentence about them or me? If it's about me, rewrite it.
2. What is the most credible sentence? Mark it.
3. What sentence would cause you to stop reading? Remove it.
4. Does this say something no other candidate could say? If not, what's missing?
5. Verdict: ADVANCE / BORDERLINE / REJECT — and the exact reason in one sentence.
```

---

## Phase 4 — Application Form Fields

> **Essay fields are where AI slop fails hardest and where your voice wins.**
> Rule: these prompts generate raw material for you to write from — not paste-ready output.
> Every essay answer must be written in your own words, using your own details.

### Prompt 4A — "Why [Company]?" Field

```
Context is loaded. Applying to [COMPANY] for [ROLE].
Character/word limit: [X]

DO NOT write my answer. Surface the raw material:

1. COMPANY SIGNAL ANALYSIS
   What are the 2–3 most credible, non-generic reasons someone with my profile
   would genuinely want to work at [COMPANY]?
   (Exclude: "great culture", "innovative products", "market leader".)

2. MY AUTHENTIC HOOK
   What does [COMPANY] specifically have that I need for my trajectory?
   What can I learn or build there that I cannot do at Google xGE?

3. PROOF OF RESEARCH
   What specific thing should I reference — product, publication, approach,
   person, philosophy — that signals I've done real homework?

4. MISSION ALIGNMENT (for Anthropic)
   How does my work on the comms triage agent and executive RAG pipeline
   directly connect to [COMPANY]'s mission? Frame this as belief + evidence,
   not aspiration.

5. SCAFFOLD (3 sentences I will rewrite in my voice):
   — S1: The specific thing about [COMPANY] no generic answer mentions
   — S2: How my production work connects to that specific thing
   — S3: What I want to build or contribute

I will write the final answer from this scaffold.
```

### Prompt 4B — "Tell Me About Yourself" / Open Intro

```
Context is loaded.
Field prompt: "[PASTE EXACT QUESTION TEXT]"
Character/word limit: [X]

Build the scaffold:

1. WHAT THEY'RE REALLY ASKING
   Decode this question. What does [COMPANY] actually want to learn?

2. THREE OPENING LINE OPTIONS
   Each option should be:
   — Specific to my actual experience (not generic)
   — Relevant to this role
   — Surprising enough to earn the next sentence

3. THE CORE ARGUMENT (1 sentence)
   My single strongest claim for this role, without using banned framing.
   Reference the comms × builder hybrid without those exact words.

4. THE PROOF POINT
   Which one agent or metric best supports the core argument for THIS role?

5. THE CLOSE
   One honest sentence on why this role, this company, now.
   Must connect to something specific about [COMPANY], not just my goals.

I will write the final answer from this scaffold.
```

### Prompt 4C — Behavioral Question ("Describe a Challenge...")

```
Context is loaded.
Question: "[PASTE EXACT QUESTION]"
Character/word limit: [X]

Using the CAR framework (Challenge → Action → Result):

1. SELECT THE BEST STORY
   From my proof points and experience, which story best answers this question?
   Give me 2–3 candidates, ranked by fit to this specific question.

2. BUILD THE CAR SCAFFOLD for the top story:
   — Challenge: what made this hard? (1 sentence — be specific about the obstacle)
   — Action: what did I specifically do? ("I" not "we" — own the decision)
   — Result: the metric + the before/after

3. THE MESSY DETAIL
   What specific detail should I add that only someone who was there would know?
   This is what passes the "real story" test that AI slop fails.

4. DEFENSE PREP
   If an interviewer says "tell me more about the Challenge" — what is the
   honest, specific follow-up answer I need ready?

I will write the final answer from this scaffold.
```

### Prompt 4D — Technical / Portfolio Question

```
Context is loaded.
Question: "[PASTE EXACT QUESTION — e.g., 'Describe a technical system you built']"
Character/word limit: [X]

1. WHICH AGENT TO FEATURE
   Given this question and this role, which of my three agents is the strongest answer?

2. TECHNICAL DEPTH CALIBRATION
   Based on the role's JD, what depth level? (1 = comms/exec audience, 5 = technical panel)
   Adjust the architecture explanation accordingly.

3. FOUR BEATS to write from:
   — Architecture beat (1–2 sentences, calibrated to depth level above)
   — Impact beat (the single most impressive metric)
   — Decision beat (one key design choice I made and why — shows judgment)
   — Connection beat (how this maps to what [COMPANY] is building)

I will write the final answer from these beats.
```

---

## Phase 5 — ATS + Format Checklist

> Run this on your final CV draft before submission.

### Prompt 5A — Keyword Gap Analysis

```
Context is loaded.

CV draft: [PASTE]
JD: [PASTE]

Run keyword gap analysis:

1. MISSING KEYWORDS — list significant JD terms not in my CV:
   Flag each as CRITICAL / IMPORTANT / OPTIONAL

2. CONTEXT MISMATCHES — keywords I've used but in wrong context?

3. NATURAL INSERTION POINTS — for each CRITICAL keyword:
   Where exactly, and what's the most natural insertion?

4. TITLE ALIGNMENT — does my title/headline contain the role title or close variant?
   ATS matches on title proximity. If not, fix it.

5. FORMAT RISKS — flag anything that would cause parsing failures:
   (tables, graphics, columns, non-standard headers, unusual fonts)

6. VERDICT — ATS score 1–10 for this role. Top 3 changes for highest score lift.
```

**Format checklist (apply before every submission):**
```
□ Single-column layout — no tables, graphics, or multi-column sections
□ Standard font: Arial or Calibri, 10–11pt
□ Standard headings: Experience, Skills, Projects (not custom labels)
□ "Production AI Systems" section immediately after summary
□ All metrics present — every bullet has a number
□ Title/headline contains the target role title or close variant
□ Saved as both .docx AND clean PDF
□ File names: Mitchell_Williams_[Role]_[Company].pdf
□ No headers/footers with contact info (some ATS parsers fail these)
```

---

## Phase 6 — 1-Pager / HM Outreach

> **Outreach + 1-pager is the highest-ROI activity in the process.**
> A well-targeted message to the right person bypasses ATS entirely.
> Send this before or the same day as applying — not after.

### Prompt 6A — LinkedIn Message (connection note)

```
Context is loaded.

Sending a LinkedIn connection note to [NAME], [TITLE] at [COMPANY].
Applying for: [ROLE]
Context I have on them: [paste anything — recent posts, their background, shared connections]

Write a connection note (300 characters maximum):
• Opens with something specific to THEM — not "I saw you work at [Company]"
• References one specific thing from their public work or background
• One sentence on why I'm reaching out
• No ask for a job — the ask is a conversation or their perspective
• Ends with a specific, easy-to-answer question

Then write a FOLLOW-UP (if they accept but don't reply within 5 days):
• 150 characters maximum
• My single strongest signal for their team
• Warm, not desperate
```

### Prompt 6B — Cold Email to Hiring Manager

```
Context is loaded.

Sending a cold email to [NAME], [TITLE] at [COMPANY].
Applied / about to apply for: [ROLE]

EMAIL RULES:
• Subject line: specific — reference something real about [COMPANY] or their work
• 200 words maximum
• P1 (2 sentences): What I noticed about their team / product / a specific signal
• P2 (2–3 sentences): My single strongest proof point for their team — one agent, one metric
• P3 (1–2 sentences): Low-friction ask (15-min call, not "explore opportunities")
• Zero banned phrases

Output:
— The email draft
— 3 subject line options with rationale for each
— The attach/no-attach decision: should I attach the 1-pager? (Phase 0.5)
```

---

## Phase 7 — Pre-Submit Quality Check

> **Non-negotiable before every submission.**

### Prompt 7A — Full Package Review

```
Context is loaded.

CV (tailored): [PASTE]
Cover letter (if applicable): [PASTE]
Application form answers (if applicable): [PASTE]

Run all checks:

1. VOICE INTEGRITY
   Does this sound like one person wrote all of it?
   Flag any sentence that shifts register or sounds like a different writer.
   Check all banned phrases.

2. AI SLOP DETECTION
   Flag sentences a sophisticated reader would identify as unedited AI output.
   Signals: hedging language, passive constructions, vague superlatives,
   over-structured parallel lists, grammatically perfect but content-empty phrases,
   em-dashes used as stylistic filler, repetitive sentence structure.

3. DIFFERENTIATOR CHECK
   Can a recruiter state my key differentiator in one sentence after reading this?
   Does the comms × builder angle come through clearly?

4. ABOVE-THE-FOLD CHECK
   What does a recruiter see in 6 seconds?
   Is it immediately clear why I'm right for THIS role?

5. DEFENSE READINESS
   For every metric and every specific claim: can I defend this live in an interview?
   Flag any claim that might prompt a probe I'm not ready for.

6. COMPRESSION TEST
   Cut this cover letter / summary by 40%. What survives?
   If it's stronger after cuts, the original was too long.

7. CONSISTENCY CHECK
   Names, titles, dates, metrics consistent across all documents?

VERDICT: READY TO SUBMIT / NEEDS REVISION + specific changes.
```

---

## Phase 8 — Interview Defense Prep

> **Community data is clear: the interview is the real filter.**
> Recruiters at Anthropic/OpenAI probe immediately on bullets.
> Candidates who can't elaborate on "their" work get rejected on the spot.
> Run this before every first interview, not after you get the call.

### Prompt 8A — Anticipate + Prep

```
Context is loaded. I am interviewing at [COMPANY] for [ROLE].

1. THE THREE QUESTIONS THEY WILL DEFINITELY ASK
   Specific to this role, this company, and my profile — not generic behavioral questions.
   Include at least one Anthropic-specific culture question if applicable:
   • "How would you communicate a model capability limitation to executives?"
   • "Describe a time you made a complex technical tradeoff accessible to non-technical stakeholders"
   • "How do you think about mission alignment in your day-to-day work?"

2. MY BEST ANSWER TO EACH
   CAR scaffold. One proof point per question. Flag any metric I need to have exact.

3. THE HARDEST QUESTION FOR MY PROFILE
   Given my gaps (Phase 1 analysis): what's the question I'm most likely to fumble?
   Draft a strong, honest answer that acknowledges the gap and pivots to the bridge.
   No bluffing — interviewers probe depth.

4. THE BULLET DEFENSE DRILL
   Pick the 3 most impressive bullets on my tailored CV.
   For each: write the likely follow-up question + my 60-second spoken answer.
   This should sound like a person talking, not a resume.

5. MY CLOSING QUESTION
   One question I ask the interviewer that signals I understand the real
   problem they're trying to solve — not the JD, the actual problem.
```

### Prompt 8B — Messy Story Extraction

> The detail that separates human stories from AI output.

```
Context is loaded. I am preparing for a behavioral interview at [COMPANY].

For each of my three production agents, extract the "messy detail" —
the specific decision, constraint, trade-off, or unexpected problem
that only someone who built it would know.

For each agent:
1. WHAT ALMOST WENT WRONG (or did go wrong and required a pivot)
2. THE DECISION I MADE that isn't in the polished story
3. WHAT I WOULD DO DIFFERENTLY NOW — and why
4. THE ONE TECHNICAL DETAIL that proves I understand what I built at a deep level

These details make the difference between an answer that sounds coached
and an answer that lands as credible. Prep them. Know them cold.
```

---

## Grok Prompt Template

> **Paste this into Grok (x.ai) for real-time community intelligence before applying
> to any new company or role type.** Grok's access to X, Blind, Reddit, and HN surfaces
> tactics that are weeks ahead of any published article or guide.

```
I want a real-time intelligence report on job searching at [COMPANY] and/or
AI-native companies in [current month/year], sourced from community discussion threads.

Search and synthesize from: Reddit r/cscareerquestions, r/jobsearchhacks, r/ClaudeAI,
r/recruitinghell; X/Twitter (especially AI builders and job-seekers); Blind megathreads
for [COMPANY]; Hacker News "Who's Hiring" threads and discussion; Glassdoor reviews;
Indie Hackers. Weight posts from the last 60 days most heavily.

My profile:
- Current: Internal Communications Lead + AI Program Manager at Google (xGE)
- 3 production-deployed AI agents (comms triage, executive RAG, corpus analysis)
- Background: comms × builder hybrid — VP-level writer who ships production AI systems
- Target roles: AI Solutions Architect, Forward Deployed Engineer, AI Enablement Lead,
  Communications Lead, Engineering Editorial Lead at AI-native companies
- TC target: $140K–$240K

Find and report verbatim from community posts (cite source + date + user):

THREAD 1 — What is ACTUALLY working right now for candidates applying to [COMPANY]?
What specifically caused someone to get a recruiter response or interview invitation?
Pull exact tactics, not summaries.

THREAD 2 — What does the interview process at [COMPANY] actually look like in 2026?
What questions do they ask? What signals do interviewers look for? What trips candidates up?

THREAD 3 — What are candidates with non-traditional backgrounds (comms, media, program
management → AI roles) doing that works or fails at AI-native companies right now?

THREAD 4 — What are recruiters or hiring managers at AI-native companies currently
complaining about? What specific patterns in applications are getting candidates filtered?

THREAD 5 — What specific AI-assisted application workflows are candidates reporting
as effective vs. getting them filtered as AI slop?

Do NOT generalize. Pull specific tactics, exact language, and reported outcomes.
Cite source, date, and poster (or "anonymous" for Blind/Glassdoor) for every data point.

After all threads:
TOP 3 ACTIONS I should take THIS WEEK for my specific profile and target role.
Each action: what to do, why it works based on the thread data, one specific example.
```

---

## System Integration Notes

> **How this guide connects to career-ops internals:**

| career-ops tool | What it does | When to use it |
|---|---|---|
| `/career-ops oferta` | Scores the role; surfaces gaps | Before Phase 1 — don't spend time on a 3.5/5 role |
| `/career-ops pdf` | Generates tailored CV from proof bank | Use as Phase 2 starting draft |
| `/career-ops apply` | Live form filling with voice constraints | Use for Phase 4 with this guide's scaffolds |
| `article-digest.md` | Full STAR proof point bank | Pull from this for Phase 4C/4D scaffolds |
| `corpus/voice-profile.md` | 6 voice signatures + banned phrases | Always active; check Phase 7 against it |
| `modes/_profile.md §5` | REQUIRES-HUMAN-REWRITE flag | If triggered: use Phase 4 scaffolds, write yourself |

> **What this guide adds that career-ops doesn't cover:**
> - Referral activation strategy (Phase 0) — the 5× multiplier
> - Audition artifact / 1-pager methodology (Phase 0.5)
> - Three-angle CV comparison (Phase 2C)
> - Essay field scaffolding that surfaces raw material for human writing (Phase 4)
> - Interview defense prep and "messy story" extraction (Phase 8)
> - ATS format checklist based on 2026 community failure data (Phase 5)
> - The brutal reality table that reorders your effort priorities

---

*Guide version: 2026-05-06 · Integrated Grok community intelligence (Reddit/X/Blind/HN, Mar–May 2026)*
*Reusable for any role in the Apply Now queue. Update Mitchell's Context Block when profile changes.*
