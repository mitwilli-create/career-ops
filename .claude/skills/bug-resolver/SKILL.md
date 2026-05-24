---
name: bug-resolver
description: Walk data/bug-ledger.jsonl by severity priority, run each bug through the 7-phase multi-vendor pipeline (audit Gemini → research Gemini → adjudicate Grok-4 → action_plan Grok-4 → implement GPT-5 → verify Gemini → harden Gemini), open DRAFT PRs for resolved bugs via scripts/safe-gh-pr.sh. Never auto-merges. Slash-command wrapper around `scripts/agents/bug-resolver.mjs`. Default Mon/Thu 02:00 PT scheduled (loaded-but-DISABLED day-1 awaiting Test 1 review). Caps — $150/day · $30/bug · 5 bugs/run. Quality-first per Mitchell's locked Q>C>S priority (offloads Claude Code + Perplexity load). Cross-fork-leak hardening — every external API prompt passes through assertNoInlineQuotesFromSensitivePaths(); sensitive sources auto-route to NEEDS_HUMAN. Triggers when Mitchell types /bug-resolver, says "process the bug ledger," "fix open bugs," "run the bug resolver," "what's in the bug queue," "resolve next bug," "fire bug-resolver on bug-XXXX-NN-NN-NNN," or any phrasing that wants the resolver fired manually instead of waiting for the Mon/Thu launchd run. Heavy work runs in the agent subprocess so the main session context stays clean. Output: per-bug decision doc at `data/bug-resolver-reports/<DATE>/<bug-id>.md` + ledger status update + DRAFT PR (when audit/adjudicate/verify all PROCEED) + hardening suggestions appended to `data/bug-resolver-pending-hardening.md` for manual brain-catalog application.
user_invocable: true
args: mode
argument-hint: "[default | --dry-run | --bug <id> | --max-bugs N | --cap-override $USD] (default: full run with default caps)"
---

# bug-resolver — 7-phase multi-vendor bug-resolution pipeline

## Purpose

career-ops accretes bugs across many surfaces — manual filings, postmortems, hang-watchdog traces, regression-guard CRIT/HIGH findings, system-maintenance decision docs, log stderr, GitHub issues. Phase 1 (intake-mapper, shipped 2026-05-23) walks all 8 default surfaces weekly and consolidates them into `data/bug-ledger.jsonl`. Phase 2 (this agent) walks the ledger Mon/Thu, runs each bug through a 7-phase pipeline using 3 non-Anthropic / non-Perplexity vendors (deliberate offload from Mitchell's Claude Code + Perplexity workload), and opens DRAFT PRs for resolved bugs. Mitchell reviews + merges; the agent NEVER auto-merges.

Spec: `data/bug-resolver-plan.md` (full design, 4 validation phases, locked decisions from the 2026-05-23 interview).

## The 7 phases

| Phase | Vendor | Purpose |
|---|---|---|
| `audit` | Gemini 3.1 Pro | Re-read source, classify bug_class against catalog, re-validate severity, check semantic-dedup candidates |
| `research` | Gemini 3.1 Pro | Root-cause hypothesis + fix scope + known-fix references |
| `adjudicate` | Grok-4 | Independent verifier — different reasoning bias; can OVERTURN to NEEDS_HUMAN |
| `action_plan` | Grok-4 | Concrete code-change plan + test plan + rollback plan + PR title/body |
| `implement` | GPT-5 | Unified-diff patch (must pass `git apply --check`) |
| `verify` | Gemini Flash | Read PR diff + check forbidden paths + obvious-issue scan |
| `harden` | Gemini 3.1 Pro | Bug-class catalog suggestion (Mode A new pattern / Mode B case study); appended to pending-review file, never auto-applied |

## CLI

```bash
node scripts/agents/bug-resolver.mjs                       # full run, default caps
node scripts/agents/bug-resolver.mjs --dry-run             # pre-flight only, $0
node scripts/agents/bug-resolver.mjs --bug bug-2026-05-23-003  # single bug
node scripts/agents/bug-resolver.mjs --max-bugs 3          # override per-run cap
node scripts/agents/bug-resolver.mjs --cap-override 50     # raise per-bug cap (logged)
node scripts/agents/bug-resolver.mjs --help
```

## Caps + kill switches

| Cap | Default | Override |
|---|---|---|
| Daily spend | $150 | `BUG_RESOLVER_DAILY_USD=200` |
| Per-bug spend | $30 | `BUG_RESOLVER_PER_BUG_CAP=50` or `--cap-override 50` |
| Bugs per run | 5 | `BUG_RESOLVER_MAX_BUGS_PER_RUN=10` or `--max-bugs 10` |

Kill switches:
- **Global:** `launchctl setenv BUG_RESOLVER_ENABLED false`
- **Per-vendor:** `launchctl setenv BUG_RESOLVER_VENDOR_DISABLED_{GEMINI,GROK4,GPT5} true`
- **Plist unload:** `launchctl bootout gui/$(id -u)/com.mitchell.career-ops.bug-resolver`

Circuit-breaker: any vendor with 3 consecutive failures in one run gets auto-disabled for the rest of that run.

## Priority + scheduling

- **Priority order:** CRIT → HIGH → MED → LOW; within same severity, oldest first_seen first
- **Default cap:** 5 bugs/run × 2 runs/week (Mon/Thu) = 10 bugs/week
- **Backlog of 18 entries (as of 2026-05-23 Phase 1 backfill):** clears in ~2-3 weeks at default cadence

## Outputs

- **`data/bug-resolver-reports/<DATE>/<bug-id>.md`** — per-bug decision doc (gitignored). Contains audit summary, vendor log + costs, action plan, patch, verify result, hardening suggestion.
- **`data/bug-ledger.jsonl`** updates — status transitions (OPEN → IN_PROGRESS → DRAFT_PR | NEEDS_HUMAN | WONT_FIX), draft_pr_url, resolution_commit, vendor_log, total_cost_usd.
- **`data/bug-resolver-spend.jsonl`** — append-only per-call spend ledger (daily cap math reads from this).
- **`data/bug-resolver-pending-hardening.md`** — hardening-phase suggestions for Mitchell to manually apply to `~/.claude/knowledge/brain/bug-class-catalog.md`.
- **DRAFT PRs** on `mitwilli-create/career-ops` via `scripts/safe-gh-pr.sh` (forces `--repo` to fork; never upstream).

## Cross-fork-leak protection

- Every external API prompt passes through `assertNoInlineQuotesFromSensitivePaths()` (extracted to `lib/leak-guard.mjs` in Phase 1).
- Sensitive source bugs (`is_sensitive_source: true` — opt-in readers transcript-flags / memory-feedback) auto-route to `NEEDS_HUMAN` without entering the vendor pipeline.
- DRAFT PRs are created via `scripts/safe-gh-pr.sh` which forces `--repo mitwilli-create/career-ops`; can't accidentally PR to upstream santifer.

## Triggers

- `/bug-resolver` (any args) — slash command
- "process the bug ledger"
- "fix open bugs"
- "run the bug resolver"
- "what's in the bug queue"
- "resolve next bug"
- "fire bug-resolver on bug-XXXX-NN-NN-NNN"
- Or any phrasing that calls for the resolver manually instead of waiting for the Mon/Thu launchd run

## NOT for

- Single quick manual fixes — just edit + commit yourself
- Bugs you've already triaged and know exactly how to fix
- Anything urgent (the pipeline is ~5-10 min per bug × multiple bugs; not a hotpath)
- Bugs in files outside career-ops (the resolver assumes REPO_ROOT context)

## Validation phases (per data/bug-resolver-plan.md § Phase 4)

| Phase | Window | Pass criteria |
|---|---|---|
| Test 1 | 1 night | Up to 5 bugs reach DRAFT_PR; ledger uncorrupted; 0 leak-guard fires |
| Test 2 | 1 week | ≥80% DRAFT_PR; 0 cross-fork leaks; cost within projection |
| Test 3 | 2 weeks | ≥70% DRAFT PRs mergeable after human review; vendor-disagreement <30% |
| Launch | 1 month | ≥60% mergeable; monthly cost <$1,500; hardening docs land in catalog |
| Review | Monthly | Re-tune cadence + vendor mix + caps on actual data |

Day-1 readiness check before enabling scheduled runs: see `data/bug-resolver-plan.md` § Phase 2 — Day-1 readiness check.
