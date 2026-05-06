# Application Materials Prompt Guide
### Mitchell Williams · Claude Sonnet 4.6 · career-ops

> **Reusable for every role in the Apply Now queue.**
> Run phases in order. Human-edit every output before submitting — your voice is the only differentiator that 40–80% of AI-generated applications cannot replicate.

---

## Contents

- [Quick Start](#quick-start)
- [Mitchell's Context Block](#mitchells-context-block) ← paste this once per session
- [Phase 0 — Job Intelligence](#phase-0--job-intelligence)
- [Phase 1 — CV Tailoring](#phase-1--cv-tailoring)
- [Phase 2 — Cover Letter](#phase-2--cover-letter)
- [Phase 3 — Application Form Fields](#phase-3--application-form-fields)
- [Phase 4 — ATS Optimization Pass](#phase-4--ats-optimization-pass)
- [Phase 5 — Recruiter / Hiring Manager Outreach](#phase-5--recruiter--hiring-manager-outreach)
- [Phase 6 — Pre-Submit Quality Check](#phase-6--pre-submit-quality-check)
- [Grok Community Intelligence Prompt](#grok-community-intelligence-prompt)

---

## Quick Start

```
1. Open a fresh Claude Sonnet 4.6 conversation (claude.ai or terminal)
2. Copy-paste the [Mitchell's Context Block] below — this loads your full profile
3. Paste the JD — run Phase 0 first, always
4. Run only the phases that apply (not every role needs a cover letter)
5. Human-edit every output before submitting
6. For essay / open-text fields: draft → cut 40% → read aloud → submit
```

**The 6-second rule:** A hiring manager spends ~6 seconds on first scan.
Your above-the-fold line — title, summary, first bullet — must earn the next 60 seconds.
Every phase in this guide optimizes for that handoff.

---

## Mitchell's Context Block

> **Paste this at the start of every fresh Claude session before running any phase.**
> It replaces the need to re-explain yourself every time.

```
You are working as an expert application strategist for Mitchell Williams.
Here is everything you need to know about him. Reference this throughout our session.

─── IDENTITY ───
Name: Mitchell Williams
Location: Seattle, WA (open to relocation globally)
Email: mitwilli@gmail.com | LinkedIn: linkedin.com/in/mitwilli
GitHub: github.com/mitwilli-create | Portfolio: thestorytellermitch.com

─── CURRENT ROLE ───
Internal Communications Lead + Program Manager
Google — Office of Cross-Google Engineering (xGE)
June 2024 – present

Audience: ~1,000 senior technical ICs at Principal / Distinguished / Fellow tiers.
This is Google's senior engineering leadership cohort — the top 1-2% of technical staff.

─── THREE DEPLOYED PRODUCTION AI AGENTS (not demos, not prototypes) ───

1. Communications Triage Agent (Google xGE)
   Architecture: 3-prompt (triage → revise → escalate) + conditional KB loading
   Result: ~160 operational hours/year recaptured at >90% classification accuracy
   Audience served: ~1,000 senior Google engineers
   Status: Production, deployed

2. Executive RAG Pipeline / Voice DNA (Google xGE)
   Architecture: VP-level "digital twin" — curated Voice DNA corpus + Kill List
   of rejected drafts that teach the agent risk tolerance and rhetorical pace
   Result: 90% reduction in drafting latency; 99% stylistic fidelity
   Status: Production, deployed

3. Voice OS (personal corpus)
   Architecture: 1.08M-word personal corpus (Gmail 2007–2026, Instagram, Facebook,
   LinkedIn, iMessage) analyzed for voice signatures, banned phrases, AI-detection risks
   Result: 6-axis voice scoring + AI-detection risk surface
   Status: Production, personal deployment

─── DIFFERENTIATORS (what most candidates cannot claim) ───
• "Comms × Builder hybrid" — VP-caliber writer AND production AI system builder.
  Most comms people can't build. Most builders can't write for the C-suite.
• Voice DNA / Kill List — coined methodology, Mitchell's own IP.
  Training an agent on what to REJECT is as important as what to accept.
• Regulatory/litigation-grade communication discipline — worked under Scientology's
  "attack the attacker" litigation posture (HuffPost Live), active $500M presidential
  lawsuit (Fusion/Univision), human rights activists from Egypt and Russia.
  This is not typical. It means: no sloppy language, no ambiguity under pressure.
• Broadcast-to-AI bridge — the same operating instincts that made live broadcast
  production work (no buffer, no rewind) transfer directly to agentic AI pipelines
  (no edit window, consequence-bearing output).

─── PROOF POINTS WITH METRICS ───
• Comms Triage Agent: ~160 ops hrs/yr recaptured at >90% classification accuracy
• Executive RAG: 90% drafting latency reduction, 99% stylistic fidelity for VP comms
• Mentorship Platform: 90% admin reduction (3.5 hrs → 20 min/match), 300%+ capacity scaling
• Remote-work pivot (Q1 2020): 9,000 machines + 9,500 hotspots provisioned in one week
• Day One overhaul: 75,000+ new hires, 88% autonomous hardware provisioning within 24 hrs
• AJ+ viral campaign: 50M+ views, 40K+ comments
• career-ops fork: Agentic pipeline with zero-token portal scanning, unattended launchd schedule

─── TARGET ROLE ARCHETYPES ───
Primary (A2): AI Solutions Architect, Forward Deployed Engineer, Applied AI Engineer,
AI Enablement Lead, AI Program Manager, AI Technical Program Manager
Secondary (B): Developer Education Lead, Developer Advocate, Communications Lead
at AI-native companies

─── COMPENSATION TARGET ───
$140K–$240K total comp. Walk-away floor: $110K (remote/international).
Seattle floor: $120K.

─── VOICE CONSTRAINTS (always apply) ───
• Lead with the point. Never bury the lede.
• Short sentences. Action verbs. No passive voice.
• Specific warmth — personal, not corporate.
• Contractions in casual contexts (emails, outreach). Avoid in formal materials.
• Banned phrases: "passionate about", "leverage", "synergy", "results-driven",
  "thought leader", "innovative", "detail-oriented", "team player", "go-getter",
  "I am excited to", "I would love to", "best-in-class", "move the needle",
  "at the end of the day", "circle back", "deep dive", "value add"
• 350-word maximum on professional emails
• Every draft must survive a 40% cut without losing what makes it Mitchell's

The above is your operating context. You will refer to it throughout this session.
Confirm you've received it with: "Context loaded. Ready for [Phase X]."
```

---

## Phase 0 — Job Intelligence

> **Run this first. Always. Before touching any materials.**
> The goal: decode what the role is actually asking for, not what the JD says.

### Prompt 0A — Deep JD Decode

```
Context is loaded above.

I am about to apply to this role. Before I touch any materials, I need you
to decode the JD like a senior hiring manager who wrote it.

[PASTE FULL JOB DESCRIPTION HERE]

Return a structured analysis:

1. THE REAL ROLE (1 sentence)
   Strip the marketing copy. What is this person actually doing day-to-day?

2. THE THREE THINGS THAT WILL WIN THIS APPLICATION
   Ranked. What matters most to whoever wrote this JD?

3. THE SUBTEXT (what they didn't say but implicitly require)
   What signals in the JD reveal unstated priorities?

4. MY BEST ANGLE
   Given my profile (context block above), what is the single strongest
   argument for why I'm the right hire? What story should run through
   every piece of material I submit?

5. MY GAPS
   What does this JD require that I don't clearly demonstrate?
   For each gap, suggest a bridge or mitigation framing.

6. KILLER KEYWORDS
   Exact phrases from the JD that must appear in my CV and cover letter
   to pass ATS and resonate with a human reader. List 10–15.

7. THEIR PAIN
   What problem is this company trying to solve by filling this role?
   Frame it in one sentence — this becomes the opening of my cover letter.

8. RED FLAGS OR OPEN QUESTIONS
   Anything I should clarify before applying, or watch for in the process.
```

### Prompt 0B — Recruiter Scan Simulation

> Run this after 0A. Forces Claude to think from the screener's perspective.

```
Context is loaded. I've decoded the JD above.

Now act as a senior technical recruiter at [COMPANY NAME] who receives
400+ applications per role and spends 6–8 seconds on initial scan.

Given my profile and the JD, answer:

1. PASS or FAIL — does my profile survive the 6-second scan? Why?
2. What is the single line on my CV that earns the next 30 seconds of attention?
3. What would make a recruiter at this company stop and email me today?
4. What would cause an ATS or first-pass screener to filter me out — and how do I fix it?
5. What does a recruiter at [COMPANY NAME] specifically care about that most
   candidates miss?
```

---

## Phase 1 — CV Tailoring

> **Your CV is not one document. It is a starting point that changes for every role.**
> The goal: make the first 1/3 of the page look like it was written for this specific JD.

### Prompt 1A — Role-Specific Bullet Rewrites

```
Context is loaded. JD decoded (Phase 0 output above).

I need to tailor my CV bullets for this specific role.

Here is my current experience section:
[PASTE YOUR CURRENT CV BULLETS FOR THE 2-3 MOST RELEVANT ROLES]

For each bullet, do the following:
1. Score it 1–5 for relevance to THIS role (1 = barely relevant, 5 = exact match)
2. Rewrite every bullet scoring 4–5 to maximize impact for this specific JD
3. For bullets scoring 1–3: either suggest a replacement from my proof points
   (above in context) or recommend dropping it for this application

Rewrite rules:
• Lead with the outcome/impact, not the action
• Embed killer keywords naturally (from Phase 0 analysis)
• Keep all metrics — never remove a number
• Maximum 2 lines per bullet
• Active voice, strong verbs
• Do not start two consecutive bullets with the same verb
```

### Prompt 1B — Summary / Headline Rewrite

```
Context is loaded.

Rewrite my professional summary for this role.

My current summary: [PASTE CURRENT SUMMARY]
Target role: [ROLE TITLE] at [COMPANY]
The real role (from Phase 0): [PASTE PHASE 0 OUTPUT — "THE REAL ROLE"]
Their pain (from Phase 0): [PASTE]
My best angle (from Phase 0): [PASTE]

Rules:
• 3–4 sentences maximum
• Open with my most credible signal for THIS role (not my entire career history)
• Second sentence: the comms × builder hybrid angle — name the overlap
• Third sentence: one specific metric that proves the claim
• Fourth sentence (optional): trajectory / what I'm optimizing for now
• Zero banned phrases (see context block)
• Sounds like a person wrote it, not a template
```

### Prompt 1C — Three-Version Comparison

> Use this when you're uncertain which angle to lead with.

```
Context is loaded.

Generate THREE versions of my CV summary for [ROLE] at [COMPANY].
Each version emphasizes a different angle:

Version A — BUILDER ANGLE
Lead with my three deployed production AI agents. Frame everything through
the lens of someone who ships systems, not just communicates about them.

Version B — SCALE ANGLE
Lead with the audience (1,000 senior Google engineers — top 1-2% of technical staff
globally). Frame everything through the lens of someone who operates at engineering leadership scale.

Version C — HYBRID ANGLE
Lead with the rarity of the comms × builder combination. Frame everything
through the lens: "you're hiring one person who does what usually requires two."

After all three, tell me: which version best fits THIS specific role and why?
```

---

## Phase 2 — Cover Letter

> **Only write a cover letter if the application explicitly asks for one, or if
> you're applying to a top-priority role where differentiation matters most.**
> Most ATS systems don't parse cover letters — spend time on the letter only when
> a human will read it first.

### Prompt 2A — Cover Letter Draft

```
Context is loaded. JD decoded (Phase 0).

Write a cover letter for [ROLE] at [COMPANY].

STRUCTURAL RULES (non-negotiable):
• Open with THEIR situation/pain — not "I am applying for..." and not
  your accomplishments. Make the first sentence about what they need.
• Paragraph 1 (2–3 sentences): Name their pain. Signal you understand
  the problem they're solving by hiring for this role.
• Paragraph 2 (3–4 sentences): Your single strongest proof point for this
  specific role. One story. Specific numbers. Real outcomes.
• Paragraph 3 (2–3 sentences): The comms × builder hybrid angle —
  what you bring that a single-discipline hire cannot.
• Closing (1–2 sentences): Clear, direct ask. No "I hope to hear from you."
  Something like: "I'd like to talk about [specific aspect of the role]."

VOICE RULES:
• 300 words maximum (shorter is better — leave them wanting more)
• Zero banned phrases (see context block)
• No adjectives without evidence ("strong communicator" → always a specific example)
• One sentence per paragraph that a recruiter could quote to justify advancing me
• Read it aloud test: if it sounds like a brochure, rewrite it

After the draft, write:
— WHAT WORKS: 2 things that are strong
— WHAT TO WATCH: 1 thing I should human-edit before sending
— CUT VERSION: A 150-word version for applications with character limits
```

### Prompt 2B — Cover Letter Roast

> Run this AFTER 2A. Forces an honest second opinion.

```
Act as a brutally honest senior hiring manager who has reviewed 10,000+
cover letters and rejects 90% in under 30 seconds.

Here is my cover letter draft: [PASTE DRAFT]

Tell me:
1. What is the first sentence? Is it about me or them? If it's about me, rewrite it.
2. What is the single most credible sentence in this letter?
3. What sentence would cause you to stop reading? Remove it.
4. Does this letter say something no other candidate could say? If not, what's missing?
5. Overall verdict: ADVANCE, BORDERLINE, or REJECT — and the specific reason.
```

---

## Phase 3 — Application Form Fields

> **The hardest part.** Most AI-assisted applications fail here because candidates
> paste generic output into essay boxes. These fields are where voice, specificity,
> and differentiation separate you from the 80% who used the same prompts.
>
> **Rule:** Never paste AI output directly into an essay field.
> Use these prompts to surface your raw material, then write the final answer yourself.

### Prompt 3A — "Why [Company]?" Field

```
Context is loaded. I am applying to [COMPANY] for [ROLE].

This application has a "Why [Company]?" or "Why do you want to work here?" field.
Character limit: [X characters / words / leave blank if none]

DO NOT write the answer for me yet. Instead:

1. COMPANY SIGNAL ANALYSIS
   Based on what you know about [COMPANY], what are the 2–3 most credible
   reasons someone with my profile would genuinely want to work there?
   (Exclude generic answers like "great culture" or "innovative products.")
   
2. MY HONEST HOOK
   Given my profile, what is my single most authentic reason? What does
   [COMPANY] have that I specifically need for my trajectory?
   
3. PROOF OF RESEARCH
   What should I reference to show I've done real homework on [COMPANY]?
   (Specific product, recent launch, team, published essay, technical approach.)

4. DRAFT SCAFFOLD
   Write a 3-sentence scaffold that I will fill in with my own voice:
   — Sentence 1: The specific thing about [COMPANY] that no generic answer mentions
   — Sentence 2: How my work connects to that specific thing
   — Sentence 3: What I want to contribute / build / learn

I will take this scaffold and write the final answer in my own words.
```

### Prompt 3B — "Tell Me About Yourself" / Open Intro Field

```
Context is loaded. This application has an open intro field:
"[PASTE THE EXACT FIELD PROMPT]"
Character/word limit: [X]

Build me a structured brief I can use to write this myself:

1. WHAT THEY'RE REALLY ASKING
   Decode this question. What does [COMPANY] actually want to learn from it?

2. THE HOOK (first sentence)
   Give me 3 options for the opening sentence. Each should be:
   — Specific to my actual experience (not generic)
   — Relevant to THIS role
   — Surprising or counterintuitive enough to earn the next sentence

3. THE CORE ARGUMENT (middle)
   What is the one-sentence argument that makes me the right hire?
   This should reference the comms × builder hybrid without using those exact words.

4. THE PROOF POINT (evidence)
   Which single proof point from my profile (context block) best supports
   the core argument for THIS specific role?

5. THE CLOSE (what I want)
   One sentence on why this role, at this company, now.

I will use this structure to write the final answer in my own voice.
```

### Prompt 3C — "Describe a Challenge You Overcame" / Behavioral Field

```
Context is loaded. This application has a behavioral question:
"[PASTE THE EXACT QUESTION]"
Character/word limit: [X]

Using the SOAR framework (Situation / Obstacle / Action / Result):

1. SELECT THE BEST STORY
   From my proof points and experience, which story best answers this specific
   behavioral question? Give me 2–3 candidates ranked by fit.

2. BUILD THE SOAR SCAFFOLD for the top story:
   — Situation: [the context, in 1 sentence]
   — Obstacle: [the specific challenge, in 1 sentence — what made it hard?]
   — Action: [what I specifically did — use "I", not "we"]
   — Result: [the metric, the outcome, the before/after]

3. VOICE NOTES
   What would make this answer sound like a person wrote it, not an AI?
   What specific detail should I add that only someone who was there would know?

4. LENGTH CHECK
   Given the [X] limit, which elements should I expand vs. compress?

I will write the final answer using this scaffold.
```

### Prompt 3D — Technical / Portfolio Question Field

```
Context is loaded. This application asks:
"[PASTE THE EXACT QUESTION — e.g., 'Describe a technical system you built']"
Character/word limit: [X]

I want to answer this using one of my three deployed production AI agents
(Comms Triage Agent, Executive RAG Pipeline, or Voice OS).

1. WHICH AGENT TO FEATURE
   Given this specific question and this role, which of my three agents
   is the strongest answer? Why?

2. TECHNICAL DEPTH CALIBRATION
   Based on the role's JD and company type, what level of technical depth
   should I use? (1 = non-technical audience / 5 = technical hiring panel)

3. THE ARCHITECTURE BEAT
   For the selected agent, what is the clearest 1–2 sentence description
   of the architecture that sounds technically credible without being
   inaccessible?

4. THE IMPACT BEAT
   What is the most impressive single metric from that agent?

5. THE "WHY IT MATTERS" BEAT
   How does this agent directly connect to what [COMPANY] is building?

I will write the final answer using these beats in my own voice.
```

---

## Phase 4 — ATS Optimization Pass

> **Modern ATS doesn't just match keywords — it analyzes context.**
> The goal: natural keyword integration that reads well to humans AND scores well
> to the algorithm.

### Prompt 4A — Keyword Gap Analysis

```
Context is loaded. Here is my tailored CV draft for [ROLE] at [COMPANY]:
[PASTE TAILORED CV DRAFT]

Here is the full JD:
[PASTE JD]

Run a keyword gap analysis:

1. MISSING KEYWORDS
   List every significant keyword, skill, or phrase from the JD that does
   NOT appear in my CV. Flag these as: CRITICAL (must add), IMPORTANT (should add), OPTIONAL.

2. CONTEXT MISMATCHES
   Are there keywords I've used but in a context that wouldn't score well?
   (e.g., I use "AI" 12 times but never in the context the JD uses it)

3. NATURAL INSERTION POINTS
   For each CRITICAL keyword: where exactly in my CV should it appear,
   and what's the most natural way to include it without stuffing?

4. TITLE / HEADLINE ALIGNMENT
   Does my current title/headline contain the role title or a close variant?
   ATS frequently matches on title proximity. If not, suggest a fix.

5. FINAL VERDICT
   On a scale of 1–10, how well would this CV score in an ATS for this role?
   What are the top 3 changes that would move the score most?
```

---

## Phase 5 — Recruiter / Hiring Manager Outreach

> **Outreach is not a formality — it is the highest-leverage activity in the process.**
> A well-timed message to the right person bypasses the ATS entirely.
> The goal: one specific sentence they can forward to get you a conversation.

### Prompt 5A — LinkedIn Connection + Message

```
Context is loaded.

I want to send a LinkedIn connection request + short message to [NAME],
[TITLE] at [COMPANY]. I am applying for [ROLE].

CONTEXT I HAVE ON THIS PERSON:
[Paste any relevant info: their recent posts, what they've written, their background, mutual connections]

Write a LinkedIn message following these rules:
• 300 characters maximum (LinkedIn connection note limit)
• Opens with something specific to THEM — not "I saw you work at [Company]"
• References one specific thing from their content/background that is genuinely relevant
• One clear sentence on why I'm reaching out
• No ask for a job — the ask is for a conversation or perspective
• Ends with a specific, easy-to-answer question

Then write a FOLLOW-UP message (if they accept but don't reply within 5 days):
• 150 characters maximum
• Surfaces my single strongest signal for their team
• Gentle, not desperate
```

### Prompt 5B — Cold Email to Hiring Manager

```
Context is loaded.

I want to send a cold email to [NAME], [TITLE] at [COMPANY].
I have applied / I am about to apply for [ROLE].

EMAIL RULES:
• Subject line: specific, not generic — reference something real about [COMPANY] or their work
• 200 words maximum (hiring managers delete long emails)
• Paragraph 1 (2 sentences): What I noticed about their team / product / a specific thing
  they shipped or wrote that is relevant
• Paragraph 2 (2–3 sentences): My single strongest proof point for this team.
  One metric. One system. Real.
• Paragraph 3 (1–2 sentences): The ask — specific and low-friction
  (15-min call, not "I'd love to connect and explore opportunities")
• Zero banned phrases

Also write 3 subject line options. For each, explain why it would or wouldn't
get opened in an inbox that receives 200 emails/day.
```

---

## Phase 6 — Pre-Submit Quality Check

> **Run before every submission. Non-negotiable.**

### Prompt 6A — The Full Package Review

```
Context is loaded. Here is my complete application package for [ROLE] at [COMPANY]:

CV (tailored): [PASTE]
Cover letter (if applicable): [PASTE]
Application form answers (if applicable): [PASTE]

Run the following checks:

1. VOICE INTEGRITY
   Does this sound like one person wrote all of it? Or does it shift register
   between sections? Flag any sentence that sounds like it came from a different writer.
   Check against my voice constraints (banned phrases, active voice, short sentences).

2. AI DETECTION RISK
   Flag any sentence that reads as AI-generated to a sophisticated reader.
   Look for: hedging language, passive constructions, vague superlatives,
   over-structured parallel lists, phrases that are grammatically perfect but
   say nothing specific.

3. DIFFERENTIATOR CHECK
   Does my "comms × builder hybrid" angle come through clearly?
   Can a recruiter state my key differentiator in one sentence after reading this?

4. ABOVE-THE-FOLD CHECK
   What does a recruiter see in the first 6 seconds?
   (Name, title, first bullet, summary headline.) Is it immediately clear
   why I'm right for THIS role?

5. CONSISTENCY CHECK
   Are all names, titles, dates, and metrics consistent across all documents?
   Any claims I can't back up in an interview?

6. THE COMPRESSION TEST
   Cut this cover letter / summary by 40%. What survives?
   If the cuts make it stronger, the original was too long.

Verdict: READY TO SUBMIT / NEEDS REVISION + specific changes to make.
```

### Prompt 6B — Interview Anticipation

> Optional but high-value for top-priority roles.

```
Context is loaded. I am submitting my application to [COMPANY] for [ROLE].

Based on the JD and my profile, generate:

1. THE THREE QUESTIONS THEY WILL DEFINITELY ASK
   Specific to this role and this company. Not generic behavioral questions.

2. MY BEST ANSWER TO EACH
   Use the SOAR scaffold. One proof point per question.
   Flag if I need to prepare additional material (portfolio link, specific metric, etc.)

3. THE QUESTION I AM MOST LIKELY TO FUMBLE
   What's the hardest question for me given my profile gaps (Phase 0 analysis)?
   Draft a strong-but-honest answer that acknowledges the gap and pivots
   to the bridge.

4. MY CLOSING QUESTION
   What is the one question I should ask the interviewer that signals
   I understand the real problem they're trying to solve?
```

---

## Grok Community Intelligence Prompt

> **Paste this into Grok (x.ai) to surface the most current community intelligence
> on job searching, AI application tools, and recruiter behavior in real-time.**
> Grok's access to X (Twitter), Reddit, Blind, and real-time discussion threads
> surfaces knowledge that is weeks ahead of any published article.

```
I want a comprehensive real-time intelligence report on AI-assisted job searching
in 2026, sourced specifically from community discussion threads — Reddit, X/Twitter,
Blind, Glassdoor, Hacker News, Indie Hackers, and any other active forums where
job seekers and AI builders share what's actually working.

I am a candidate with this profile:
- Currently: Internal Communications Lead + AI Program Manager at Google (xGE)
- 3 production-deployed AI agents (autonomous comms triage, executive RAG, corpus analysis)
- Target roles: AI Solutions Architect, Forward Deployed Engineer, AI Enablement Lead,
  AI Program Manager at AI-native companies
- Comp target: $140K–$240K TC
- Background: comms × builder hybrid — VP-level writer who ships production AI systems

I want you to search and synthesize:

THREAD 1 — What is ACTUALLY working right now for job seekers applying to AI-native
companies (Anthropic, OpenAI, Mistral, ElevenLabs, Cohere, etc.)? What do candidates
say caused them to get recruiter responses or interviews? Surface specific tactics,
not generic advice.

THREAD 2 — What resume / CV formats, lengths, and content choices are causing real
candidates to pass or fail ATS + recruiter screens in 2026? What's changed in the
last 6 months? Pull from r/cscareerquestions, r/jobsearchhacks, Blind, and any
relevant X threads.

THREAD 3 — What are AI builders, developers, and technical job seekers sharing about
using Claude, GPT, or other LLMs to create standout application materials? What
specific prompt techniques, workflows, or tools are getting results vs. what is
getting filtered out as AI slop?

THREAD 4 — What do recruiters and hiring managers at AI-native companies post or
complain about regarding candidate quality, application volume, or screening?
What insider signals are available from people who work inside the hiring funnel?

THREAD 5 — For candidates with strong non-traditional backgrounds (not CS/ML PhDs)
pivoting into AI roles: what specific positioning, framing, or proof points are
helping people make that transition? What are the successful candidates leading with?

THREAD 6 — What is the current state of AI-detection in hiring? Are companies
screening for AI-generated applications? What have candidates reported about this?

For each thread: cite the source, date, and poster (or "anonymous" for Blind/Glassdoor).
Weight recent posts (last 30–60 days) more heavily than older ones.
Do NOT summarize into platitudes — pull the specific tactics, exact language,
and real examples that candidates are reporting worked.

After all six threads, synthesize into:
TOP 5 HIGHEST-LEVERAGE TACTICS for my specific profile right now.
Each tactic should have: what to do, why it works, and one example from the threads.
```

---

## System Evaluation Notes

> **What career-ops does well for application materials (leverage these):**
> - `modes/pdf.md` generates tailored CVs from your proof point bank — use it before Phase 1
> - `modes/oferta.md` scores roles and surfaces gaps before you apply — run it before Phase 0
> - `modes/apply.md` handles live application form filling with voice constraints active
> - `article-digest.md` contains your full STAR proof point bank — reference it for Phase 3C
> - `corpus/voice-profile.md` contains your 6 voice signatures + banned phrase list

> **What this guide adds that career-ops doesn't cover:**
> - The job intelligence decode (Phase 0) optimized for human psychology, not just scoring
> - The three-version A/B comparison for CV angles (Phase 1C)
> - The essay field scaffolding that gives you raw material to write yourself (Phase 3)
> - The full pre-submit quality check including AI-detection scan (Phase 6)
> - The Grok community intelligence prompt for real-time tactics

---

*Guide version: 2026-05-06 | Built for career-ops by Claude Sonnet 4.6*
*Reusable for any role in the Apply Now queue. Update Mitchell's Context Block if profile changes.*
