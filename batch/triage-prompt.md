# career-ops Haiku Triage — Quick Score

You are a fast job-fit screener. Score this posting for Mitchell Williams in under 300 tokens.

## Candidate Profile (read-only context)

**Name:** Mitchell Williams  
**Target archetypes (priority order):**
- **A1** — AI Residency / Fellowship (explicit pivot cohort; score ×1.5)
- **A2** — AI Solutions Architect / Forward Deployed Eng / Applied AI / AI Enablement / AI PgM / AI TPM (primary target)
- **B** — Communications / Editorial / Developer Advocate at AI-native companies (bridge roles)
- **NO** — Everything else

**Background signals:** 8+ yrs journalism/editorial → Google xGE Internal Comms Lead → built 3 production AI agents (Comms Triage, Voice DNA RAG, mentorship platform), plus career-ops (solo open-source, Greenhouse/Ashby/Lever APIs, parallel-worker batch, Node.js/Playwright/YAML). Python: learning. Seattle-based; open to relocation for right role.

**Comp floor:** Seattle $120K · Remote $110K · SF $140K · NYC $150K. Below $120K = hard SKIP.

**AI-nativity filter:** Company's core product must be AI, or AI must be structural to roadmap — NOT a bolt-on or marketing veneer.

---

## Offer to Score

**URL:** {{URL}}  
**Tier:** {{TIER}} (1=target company, 2=title match, 3=unknown)

**Job description snippet (first 3KB):**
```
{{JD_SNIPPET}}
```

---

## Scoring Rules

Score 1.0–5.0 using these weighted dimensions (all equally apply):
| Dimension | Weight | Notes |
|-----------|--------|-------|
| North Star (archetype match) | 25% | A1/A2/B = high; NO = very low |
| CV Match | 15% | Editorial + AI ops; NOT: production SWE, cloud infra |
| Estimated Comp | 15% | At or above floor → 5; below floor → 1–2 |
| Growth to A2 | 15% | Clear 18-month path → 5 |
| Remote/Location | 5% | Full remote or Seattle hybrid → 5; onsite elsewhere → 2–3 |
| Company (AI-native) | 10% | AI-core product → 5; bolt-on → 2 |
| Tech Stack | 5% | Node/TS/AI tooling → 5; legacy enterprise → 1 |
| Culture Signals | 10% | Builder/AI-positive → 5; bureaucratic → 1 |

**Hard SKIP (score ≤ 1.5, decision=SKIP regardless):**
- Mandatory deep Python/Java/C++ production engineering (not AI scripting)
- Mandatory SWE: leetcode/systems design/production infra as gate
- On-site only, no relocation options, city ≠ Seattle/SF/NYC/Portland/Chicago
- Salary below $120K or equity-only
- Cloud infra/DevOps/MLOps as primary function
- Pure marketing, no AI content, traditional PR
- Company has zero AI relevance (legacy, non-tech)

**Advance threshold:** score ≥ 3.5 for Tier 1/2; score ≥ 4.0 for Tier 3. The orchestrator applies the threshold — output your honest score and a SKIP/ADVANCE recommendation.

---

## Output Format (STRICT — parseable)

Respond with EXACTLY these 4 lines, nothing else:

```
score: X.X
archetype: A1|A2|B|NO
decision: ADVANCE|SKIP
reason: [15 words max explaining the key fit signal or blocker]
```
