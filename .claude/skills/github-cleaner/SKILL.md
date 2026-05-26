---
name: github-cleaner
description: Audit + self-implement cleanup of ANY of Mitchell's GitHub repos + profile through an aggressive hiring-manager + recruiter lens. Phase 2 research uses per-model briefs across 16 verticals × 7 source platforms (Reddit / X / Blind / Glassdoor / Indeed / LinkedIn / company spokespersons), leveraging each LLM's unique grounding — Grok-4 for live X recruiter chatter, Perplexity sonar-deep-research for cross-platform citation synthesis, sonar-reasoning-pro for Reddit reasoning, OpenAI GPT-5 for AI forum + conference culture norms, Gemini-3.1-pro Deep Research Max for Google Search-grounded JD diffs + analyst takes, Opus-4-7 for synthesis, then the dealbreaker agent for per-claim confidence tiering. Knowledge-base layer remembers past audits + implementations, so nightly cached-rubric runs cost $0.50–3 (down from $3–12). Voice corpus + GPTZero + Originality + Pangram gate every artifact before it ships. Cross-fork-safe (PRs only via scripts/safe-gh-pr.sh; never pushes to santifer upstream; never force-pushes; never deletes repos). Council research is cached 30 days (monthly cron + --force-research refresh, ~$30–60/refresh). Triggers when Mitchell types /github-cleaner, says "clean up my github", "audit and ship my github cleanup", "make my github recruiter-ready", "polish my pinned repos", "tighten my repos before applying", or any phrasing that wants implementation. Default scope: ALL Mitchell's repos + profile; use --repo / --repos / --cwd-repo / --repo-filter to narrow.
user_invocable: true
args: query
argument-hint: "--dry-run  OR  --apply  OR  --apply --force-research  OR  --apply --repo <slug>  OR  --apply --repos r1,r2  OR  --apply --cwd-repo  OR  --apply --pre-apply 048-anthropic-comms-lead"
---

# /github-cleaner — Audit + self-implement GitHub hiring readiness

Mitchell invoked `/github-cleaner` with these args:

$ARGUMENTS

## What this skill does

Audits every in-scope repo + Mitchell's profile against a hiring-lens rubric (derived monthly via the full council-of-models + dealbreaker), then SELF-IMPLEMENTS the recommendations:

| Surface | What gets changed |
|---|---|
| Repo READMEs | Rewritten when audit flags REWRITE-README; voice + detector gated |
| Repo descriptions | One-line, ≤350 chars, set via `gh repo edit --description` |
| Repo topics | Added/removed via `gh repo edit --add-topic` |
| Repo archives | `gh repo archive` for abandoned-looking repos (reversible) |
| docs/ files | `architecture.md`, `getting-started.md`, `CONTRIBUTING.md` when missing |
| Case studies | `docs/case-studies/<project>.md` for shipped work |
| Profile README | `mitwilli-create/mitwilli-create` rewritten |
| Pinned repos | Ordered list of 6 set via GraphQL |
| Bio | One-paragraph rewrite via `gh api -X PATCH user -f bio="..."` |

Every artifact passes through:
1. Voice match against `writing-samples/voice-reference.md` + Mitchell's broader corpus (target ≥80 stylometric similarity)
2. GPTZero + Originality + Pangram (target each <60% AI-likely, signal_quality not USELESS)
3. Claim-grounding check — every metric must trace to `cv.md` / `article-digest.md` / repo state

Artifacts that fail the gate after 3 remediation cycles → saved to `data/github-cleaner/<TS>/drafts/`, surfaced in the report, never shipped.

## Trigger modes

| Mode | When to use | Command | Cost/run |
|---|---|---|---|
| Dry-run audit | One-off, see what's wrong without touching anything | `/github-cleaner --dry-run` (default) | ~$0.50–3 |
| Live self-implement | Apply cleanup right now (uses cached rubric + KB) | `/github-cleaner --apply` | ~$0.50–12 (KB-gated) |
| Refresh rubric + apply | Council research stale or target roles changed | `/github-cleaner --apply --force-research` | ~$30–60 + $3–12 |
| Focus one repo | Audit a specific repo | `/github-cleaner --apply --repo mitwilli-create/career-ops` | ~$1–4 |
| Focus multiple repos | Audit a few repos | `/github-cleaner --apply --repos career-ops,storytellermitch` | ~$2–8 |
| Current dir repo | Use the current working dir's git remote | `/github-cleaner --apply --cwd-repo` | ~$1–4 |
| Regex filter | Audit repos matching a pattern | `/github-cleaner --apply --repo-filter '^ai-'` | scales |
| Pre-apply check | Before applying to a role — bias toward that archetype | `/github-cleaner --apply --pre-apply 048-anthropic-comms-lead` | ~$3–12 |
| Monthly cron | Auto via `com.mitchell.career-ops.github-cleaner.plist` (1st of month, 22:00 PT) | (launchd) | ~$30–60 + $3–12 |

## When Mitchell's phrasing fires this

- `/github-cleaner` (slash command)
- "clean up my github" / "tighten my github" / "ship the github cleanup"
- "make my github recruiter-ready" / "polish my pinned repos"
- "rewrite my repo READMEs" / "fix my profile README"
- "before I apply to X, make sure my github looks right" → `--pre-apply <slug>`
- "audit then implement" (vs `/github-readiness` which only audits)
- "the github cleaner" / "run the cleaner"

## Hard-gates (always on, no override flag exists for any of these)

1. PRs always via `scripts/safe-gh-pr.sh` — refuses cross-fork pushes to santifer upstream
2. Never force-push
3. Never delete a repo (archive is reversible; deletion is not)
4. Stop on detection of leaked secrets in pre-existing public commits
5. Stop on detection of personal data (cv.md, hm-intel JSONs, applications, salary figures) in pre-existing public commits
6. Voice + detector gates are mandatory — no `--skip-gates`

## Override gates (per-flag, never global)

| Action | Without flag | With flag |
|---|---|---|
| Make a private repo public | PROMPT + refuse | `--confirm-make-public <repo>` |
| Touch a repo with >50 stars | PROMPT + refuse | `--confirm-popular-repo <repo>` |
| Change primary email or location | PROMPT + refuse | `--confirm-identity-change` |

## Knowledge-base layer (2026-05-22)

Past runs are not thrown away. `lib/github-cleaner/kb.mjs` maintains an
append-only index at `data/github-cleaner/kb-index.json` that records:

- Per-repo audit-finding history (was it flagged before, was it shipped, did it stick)
- Per-repo implementation history (when was this artifact last touched)
- Past rubric snapshots (so the report's Trajectory section can show lens-drift over time)
- Per-model response patterns (which model's signals were directionally right)
- Detector + voice score calibration history (drift detection)

**The cleaner reads the KB on every run** — Phase 3 promotes recurring findings + suppresses already-shipped-and-verified ones; Phase 4 skips regeneration if a recommendation was implemented in the last 14 days AND the repo hasn't changed; Phase 5 refuses to re-open a PR merged in the last 30 days for the same artifact; Phase 6 writes a Trajectory section showing what's shifted.

Together with the 30-day council-rubric cache, the KB layer is why nightly cached-rubric runs cost $0.50–3 after the first week (down from $3–12 raw).

## Budget caps

| Cap | Default | Override |
|---|---|---|
| Per-run cap | $50 | `GITHUB_CLEANER_RUN_CAP_USD` in `.env`, or `--run-cap-usd N` |
| 30-day rolling cap | $250 | `GITHUB_CLEANER_MONTHLY_CAP_USD` in `.env`, or `--monthly-cap-usd N` |

If a phase would push the run-total over the per-run cap → cleaner stops + writes the partial report.
If at start the 30-day rolling sum is over the monthly cap → cleaner refuses + writes `data/github-cleaner-budget-blocked.md` so Mitchell can review.

Ledger: `data/github-cleaner/spend-ledger.json` (rolling 30-day).

## Inputs

- `cv.md`, `article-digest.md`, `config/profile.yml`, `modes/_profile.md` — Mitchell's content corpus + target roles
- `writing-samples/voice-reference.md` — voice baseline
- `data/github-cleaner/rubric-cache.json` — Phase 2 hiring-lens rubric (30-day TTL)
- gh CLI auth as `mitwilli-create` (verified at pre-flight)
- `.env` keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `GPTZERO_API_KEY`, `ORIGINALITY_API_KEY`, `PANGRAM_API_KEY`

## Outputs

Per run, under `data/github-cleaner/<TS>/`:
- `inventory.json` — Phase 1 GitHub snapshot
- `audit.md` + `audit.json` — Phase 3 findings + recommendations
- `artifacts/*.md` — Phase 4 artifacts that passed voice + detector gates
- `drafts/*.md` — Phase 4 artifacts that failed the gate (3 cycles) — for manual polish
- `implement-log.jsonl` — Phase 5 per-action log
- `screenshots/*.png` — Phase 6 Chrome MCP verification screenshots
- `report.md` — Phase 6 final report

Plus persistent state:
- `data/github-cleaner/rubric-cache.json` (30-day TTL)
- `data/github-cleaner/spend-ledger.json` (30-day rolling)
- `data/github-cleaner/state.json` (resumability)

## How to invoke

### One-off dry-run audit (default — audits ALL Mitchell's repos + profile)
```bash
node scripts/agents/github-cleaner.mjs --dry-run
```

### Live self-implement on ALL repos (cached rubric + KB-gated)
```bash
node scripts/agents/github-cleaner.mjs --apply
```

### Focus on ONE specific repo
```bash
node scripts/agents/github-cleaner.mjs --apply --repo mitwilli-create/career-ops
```

### Focus on multiple repos
```bash
node scripts/agents/github-cleaner.mjs --apply --repos career-ops,storytellermitch,cv-mitchell
```

### Use the current working directory's git remote
```bash
node scripts/agents/github-cleaner.mjs --apply --cwd-repo
```

### Filter repos by name regex
```bash
node scripts/agents/github-cleaner.mjs --apply --repo-filter '^ai-'
```

### Refresh the rubric first (full per-model brief research), then self-implement
```bash
node scripts/agents/github-cleaner.mjs --apply --force-research
```

### Pre-apply check (bias toward a specific role's archetype)
```bash
node scripts/agents/github-cleaner.mjs --apply --pre-apply 048-anthropic-comms-lead
```

### Override a hard-gate prompt (per-flag, never global)
```bash
node scripts/agents/github-cleaner.mjs --apply --confirm-make-public some-repo
node scripts/agents/github-cleaner.mjs --apply --confirm-popular-repo some-repo
```

## What this skill does NOT do

- It does NOT make pull requests against `santifer/career-ops` (upstream) — the safe-gh-pr.sh wrapper refuses
- It does NOT delete repos — only `gh repo archive` (reversible)
- It does NOT push without going through the voice + detector gate
- It does NOT replace `/github-readiness` — that skill is for pure-audit gap analysis. Use it when you only want the diagnosis. Use `/github-cleaner` when you want diagnosis + implementation.

## Related

- **Design doc:** `data/github-cleaner-design-2026-05-22.md`
- **Predecessor skill:** `/github-readiness` (audit-only)
- **Upstream council:** `lib/council.mjs` + `~/.claude/agents/council-of-models.md`
- **Detector layer:** `lib/ai-detection-gate.mjs` (GPTZero + Originality + Pangram)
- **Voice corpus:** `lib/voice-corpus.mjs`
- **Cross-fork safety:** `scripts/safe-gh-pr.sh`

## Status

**SKELETON** as of 2026-05-22. The orchestrator + lib stubs are wired up and pass `node --check`; the heavy work (council prompt, audit scoring, generation templates, voice-match algorithm, Phase 5 gh-call wiring, Phase 6 Chrome MCP screenshots) is stubbed with `NOT_IMPLEMENTED` errors pending the full build pass (~6-8 hours, planned as a subagent task).
