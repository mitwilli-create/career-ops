---
name: blind-repo-review
description: Zero-context hostile review of a GitHub repository — spawns five isolated blind reviewers (hiring-manager skim, senior-engineer saboteur, security/ops skeptic, cold-start user, README-claims auditor) who know nothing about the project or its owner and return a ranked list of questions, gaps, concerns, and bugs. Use when Mitchell asks "poke holes in my repo", "review my repo blind", "would a hiring manager get this repo", "harden my GitHub repo", "blind repo review", or types /blind-repo-review <repo>. Complements /github-readiness (signal research) and /blind-review (single-surface UX check) — this one attacks a whole repo the way an outside evaluator would.
user_invocable: true
metadata:
  type: audit
  origin: 2026-07-07 build (merge of blind-review + github-readiness postures; 7-model council consensus spec + dealbreaker adjudication — council-report-20260707-104757.md / dealbreaker-final-20260707-105526.md; persona mechanics extend the verified mhylle/claude-skills-collection adversarial-reviewer pattern)
---

# blind-repo-review — Let a stranger attack the repo before a hiring manager does

The failure mode this catches: **the repo owner cannot cold-read their own repo.** Mitchell already knows what every script does, why the README says what it says, and which directories matter. A hiring manager at an AI company has none of that — they land on the repo, form a judgment in minutes, and never tell you where they stalled. This skill manufactures that stranger, five times over, and makes them talk.

The entire value comes from **withholding context**, not from adding review rigor. The reviewing subagents must receive ONLY: (a) a path to a clean clone of the repo, (b) the public-facing GitHub metadata, and (c) their persona. They must NEVER receive: what the project is "supposed" to be, why it was built, Mitchell's identity or career corpus, session history, or hints about what to look for. If you catch yourself writing "check that the README explains X" into a reviewer prompt — stop; that leaks the answer.

## When to invoke

- "/blind-repo-review <owner/repo | repo-name | local path>"
- "poke holes in my repo" / "tear this repo apart" / "review my repo cold"
- "would a hiring manager understand this repo"
- "harden <repo> for hiring managers"
- Before pinning a repo, linking it from a resume/application, or sharing it with a recruiter

Optional argument `--profile`: instead of one repo, review the whole public profile landing experience (bio, profile README, pinned repos' names + descriptions + README first screens) as a 10-minute recruiter skim.

## Blindness contract (hard rules — read before every run)

1. Reviewer prompts contain the repo clone path, the public metadata file path, and the persona text below — nothing else. (One sanctioned exception: Persona C may additionally receive the Phase 0 step 6 secrets-scan output path — that file is derived purely from the public clone, so it adds no context a stranger couldn't produce.) No project purpose, no owner identity, no "recently changed" hints.
2. NEVER pass corpus files (`cv.md`, `config/profile.yml`, `article-digest.md`, `modes/_profile.md`, memory files) or their contents into any reviewer prompt. The reviewers evaluate the repo exactly as the public internet sees it.
3. The persona MAY know it is evaluating "as a hiring evaluator at an AI company would" — that is the lens, not leaked context. It may NOT know the owner is actively job-searching, what roles are targeted, or anything from this session.
4. This skill is read-only against GitHub. It never pushes, never opens PRs, never edits the target repo. Findings become a fix plan Mitchell executes.
5. Do not editorialize away a finding because YOU (the orchestrator) know the missing context. The next real stranger won't know it either. Every finding survives to the report.

## Workflow

### Phase 0 — Resolve target + snapshot public state

1. `cd ~/Documents/career-ops`; `TS=$(date +%Y%m%d-%H%M%S)`.
2. Set the work area: `SCRATCHPAD` = the session scratchpad directory listed in your system prompt; if none is listed, `SCRATCHPAD=$(mktemp -d -t blind-repo-review)`. Every temp path below lives under it.
3. Resolve the argument to `owner/repo` (bare names default to `mitwilli-create/<name>`; verify with `gh repo view`). A local path skips the clone but still counts as one target.
4. Clone fresh to the scratchpad (never review the working tree — it contains gitignored personal files a stranger would never see):
   ```bash
   git clone --depth 50 https://github.com/{owner}/{repo}.git "$SCRATCHPAD/blind-clone-{repo}"
   ```
5. Capture what the public web actually shows, to `"$SCRATCHPAD/blind-clone-{repo}-meta.md"`:
   ```bash
   gh api repos/{owner}/{repo} --jq '{name,description,topics,homepage,license:.license.spdx_id,stargazers_count,open_issues_count,pushed_at,default_branch,archived,fork}'
   gh api repos/{owner}/{repo}/commits --jq '.[0:15][] | {date:.commit.author.date, message:(.commit.message | split("\n")[0])}'
   gh api repos/{owner}/{repo}/releases --jq '.[0:3][] | {tag_name,published_at}' 2>/dev/null
   ```
   Include: does CI exist and is it passing (`gh api repos/{owner}/{repo}/actions/runs?per_page=5`), issue/PR counts, whether the description/topics/homepage fields are empty.
6. Deterministic secrets pre-pass (best-effort): if `gitleaks` or `trufflehog` is installed, run it against the clone and save output next to the meta file; hand the output path to Persona C as one of its inputs (the sanctioned exception in Blindness contract rule 1). If neither is installed, skip silently — Persona C hunts manually either way.

### Phase 1 — Fan out five blind reviewers (parallel, one message)

Spawn all five as parallel `Agent` calls (`subagent_type: "general-purpose"`). Each prompt is: the persona paragraph below + the two paths + the shared output schema. Nothing more. Keep prompts short — no methodology beyond the persona, no file lists beyond the paths.

**Shared output schema (append verbatim to each persona prompt):**
> Report every finding as: `[category: question | gap | concern | bug] [rubric: reproducibility | eval-rigor | code-taste | honesty | security | onboarding] [severity: blocker | major | minor] [location: file:line or surface]` — what you observed (quote it), the question a first-time evaluator is stuck on, and a concrete fix (specific copy, file, or code change — not "add more docs"). The rubric axes are how AI-lab evaluators actually judge repos: can I reproduce this (env, deps, seeds), is anything measured or just claimed, does the code show taste (structure, typing, tests), are results/claims reported honestly, is it hygienic (secrets, license, personal data), can a new engineer start. Do not filter findings for "probably fine." Do not soften. A finding you suppress is a finding the next evaluator hits. If something genuinely impresses you, note it in a short "signals that landed" list at the end — but findings come first. Your final message IS the deliverable: return the raw findings list, no preamble.

**Persona A — Hiring-manager skim (10 minutes, first impressions):**
> You are a hiring manager at an AI company screening an unfamiliar candidate's GitHub repository. You have 10 minutes and no context about the project or its author. Start where a browser lands: repo name, description, topics, README top-to-bottom, then skim the tree. You are deciding: does this person's work look real, competent, and finishable — or abandoned, generated, or padded? List everything that confuses you, everything that raises a doubt you can't resolve from the repo itself, and every question you would have to ask the candidate in an interview because the repo failed to answer it.

**Persona B — Senior engineer saboteur (60 minutes, code):**
> You are a senior software engineer doing a cold, adversarial technical read of an unfamiliar repository. No context about the project or author. Your posture is saboteur: actively look for ways this code breaks — inputs that crash it, states it mishandles, races, unhandled errors, tests that assert nothing. Read entry points, core modules, error handling, tests, dependency hygiene, dead code, TODO/FIXME debt, and naming consistency. Flag real or probable bugs with file:line. Flag anything that looks copy-pasted, generated-and-unreviewed, or abandoned mid-refactor. List the technical questions you'd grill the author with. You must surface at least one finding; if you genuinely believe the repo is clean at your lens, state exactly what you checked and why it passed.

**Persona C — Security & ops skeptic:**
> You are a security-minded reviewer cold-reading an unfamiliar repository. No context about the project or author. Hunt for: committed secrets or tokens (including in git history reachable in this clone), personal data that shouldn't be public, unsafe patterns (command injection, unvalidated input, permissive CORS, hardcoded URLs/credentials), dependency risk (unpinned, ancient, or abandoned deps), missing or misleading LICENSE, CI that doesn't actually gate anything, and .gitignore gaps. Every finding needs a file:line and severity honestly assessed — do not inflate.

**Persona D — Cold-start user (can I run this?):**
> You have just cloned an unfamiliar repository and want to run it. No context beyond the repo itself. Follow the README literally, top to bottom, as written. At every step, note where you stall: missing prerequisites, commands that assume unstated setup, env vars with no documented source, steps that fail or are out of order, features described but not findable, screenshots/links that are dead or stale. You may execute read-only inspection (list files, read code, `node --check`, `--help` flags) inside the clone, but do not install global tooling or hit external services that need credentials. Where you cannot verify, report what the README left you unable to determine.

**Persona E — README-claims auditor (quarantine, then falsify):**
> You are auditing an unfamiliar repository for claim-vs-reality drift. STEP 1 — do NOT read the README, docs/, wiki, or any marketing text yet. Inventory the repo from code alone: file tree, entry points, what the code actually does, what is tested, what is dead or stubbed, TODO/FIXME density. Write down what you believe this project IS, purely from code. STEP 2 — now read the README and docs as a set of falsifiable claims. For every claim (features, metrics, "production", "battle-tested", architecture descriptions), check it against your Step-1 inventory. Report every overclaim, every headline feature with no tests behind it, every described capability you cannot locate in code, and every code capability the README undersells or omits. The delta list IS your deliverable.

For `--profile` mode, run Persona A only, pointed at a metadata file you build from the profile surfaces (bio, profile README, pinned repos with descriptions + first 40 README lines each), with the same schema.

**Large repos (roughly >400 source files):** don't let Personas B and C degrade into shallow file-by-file skims — partition the tree into 2–4 coherent slices (by top-level directory) and spawn one B and one C agent per slice, then treat each slice's list as that persona's findings. Personas A, D, and E always run whole-repo (their lenses are about the repo as a single experience).

### Phase 2 — Merge, dedupe, rank (orchestrator — not blind)

1. Collect all five findings lists. Dedupe by location + substance. **Cross-persona escalation:** a finding independently flagged by ≥2 personas auto-escalates one severity level (minor→major→blocker) and notes both lenses — independent agreement from blind reviewers is the strongest signal this skill produces.
2. Rank by **how early in the evaluation a hiring manager hits it**, then severity: profile/README first-screen blockers → can't-run-it stalls → code-quality concerns → deep nits.
3. Sanity-pass only for factual errors (a reviewer misread a file), never for "they didn't know the context." If a finding is wrong because context is missing from the repo, that IS the finding.

### Phase 3 — Report + fix plan

Write `data/blind-repo-review/${TS}-{repo}-report.md`:

```markdown
# Blind Repo Review — {owner/repo}
**Run:** {date} · **Reviewers:** HM-skim / Sr-eng / Security / Cold-start / README-drift · **Clone:** depth-50 public clone

## Verdict: {SHIP | HARDEN-FIRST | NOT-READY}
{One paragraph: what a hiring manager most likely concludes in 10 minutes, stated plainly. SHIP = safe to pin/link today, only nits open. HARDEN-FIRST = solid core but P0 findings would cost real credibility — close them before sharing. NOT-READY = the repo currently hurts more than it helps as a hiring artifact.}

## Findings (ranked)
| # | Cat | Rubric | Sev | Location | Finding | Fix | Lens(es) |

## README-vs-reality delta
{Persona E's drift list — overclaims and undersells, each with the README quote and the code evidence.}

## Questions an interviewer would ask because the repo didn't answer them
{Numbered list — these become README/docs additions.}

## Signals that landed
{What impressed the blind reviewers — keep and amplify these.}

## Fix plan
### Before sharing this repo (P0) / This week (P1) / Nice-to-have (P2)
{Each: action, file, effort in minutes, which finding it closes.}
```

Report back to Mitchell: verdict paragraph, top 5 findings inline, report path, and the single next action (usually the P0 list). Findings are recommendations — nothing is auto-applied to the target repo. If Mitchell says "fix them," P0/P1 items in repos he owns can be executed in a follow-up, each verified before claiming done.

## Cost + runtime

5 parallel reviewer agents on one repo: typically 2–5 min wall-clock, low single-digit dollars at most. `--profile` mode is one agent. No council/dealbreaker at runtime — this skill is self-contained (the council pass was part of its build, not its loop).

## Anti-sycophancy + anti-hallucination

- Zero findings from a persona on a first pass is suspect — re-run that persona with "list everything, even trivial" before trusting the all-clear.
- Reviewer findings must cite what they actually read (file:line, quoted text). Discard findings with no citation as hallucination-risk, and say so in the report.
- The verdict paragraph states the likely hiring-manager conclusion honestly, including "this repo hurts more than it helps" if that's what the findings support. tone-safe framing: observation + reasoning about the repo, never judgment of Mitchell.
