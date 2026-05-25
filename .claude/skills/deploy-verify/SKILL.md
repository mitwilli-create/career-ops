---
name: deploy-verify
description: Run the canonical 9-phase deploy procedure that ships work safely to every surface — pre-push regression-guard + bug-resolver QA gate, code deploy + service restart, post-deploy hard-reboot re-verification, documentation propagation, end-to-end smoke test, and final /system-maintainer + /career-ops-health invocations. Slash-command wrapper around the inline prompt at `data/deploy-verify-prompt-2026-05-25.md`. Built from the 2026-05-25 prompt-optimizer interview chain with 13 locked decisions — halt on CRIT, aggressive auto-merge of CI-green DRAFT PRs that don't touch personal data, hard bootout for service restart, gitignored deployment-report, 2x cost caps for critical deploys (~$360 max), terminal-only alerts, AGENTS.md + MEMORY.md enshrinement. Triggers when Mitchell types /deploy-verify, says "deploy this," "deploy + verify," "ship + verify," "run the full deploy procedure," "push + reboot + test," "verify the deploy held," or any phrasing that calls for the canonical end-to-end deploy flow instead of an ad-hoc push. The whole flow typically takes 30-90 min wall-clock (regression-guard ~15-25 min, bug-resolver ~10-40 min, system-maintainer ~5-15 min, career-ops-health ~2-5 min, plus deploy + bootstrap + verification time). Output: `data/deployment-report-<YYYY-MM-DD-HHMM>.md` (gitignored) + per-phase decision docs from the invoked agents.
user_invocable: true
args: optional-scope
argument-hint: "(no args = full procedure) OR '--branch <name>' OR '--skip-phase <n>'"
---

# deploy-verify — canonical 9-phase deploy procedure

## Purpose

A large sprint shipped. Code is committed, acceptance criteria are claimed met. BUT — running services may still hold old code in memory, new launchd jobs may not be loaded, embedding indexes may not be built, caches may be stale, documentation may lag the implementation, regressions may have crept in unnoticed, open bugs may not be resolved, and the dashboard.careers-ops.com surface may not yet reflect any of it.

This skill closes every one of those gaps via the canonical 9-phase deploy procedure built from the 2026-05-25 `/anthropic-skills:prompt-optimizer` interview chain.

The full procedure lives at: **`data/deploy-verify-prompt-2026-05-25.md`**.

This skill is the slash-command wrapper that invokes it.

## The 9 phases

| Phase | What it does | Spend |
|---|---|---|
| 0 | Read CLAUDE.md / AGENTS.md / bug-class catalog / latest audit doc | $0 |
| 1 | Inventory: code changes / new plists / new deps / new env vars / new infra / build artifacts / doc drift / open PRs / external surfaces | $0 |
| 2 | Verify the build live (Chrome MCP screenshots, endpoint requests, scheduled-job triggers) | $0 |
| 3 | **Pre-push QA gate**: regression-guard ($40 cap) + bug-resolver ($300 cap) — HALT on CRIT, auto-merge CI-green DRAFT PRs except personal-data paths | $0-340 |
| 4 | Deploy: install deps, run migrations, merge PRs to fork main, restart services via kickstart-k, bootstrap new plists | $0 |
| 5 | Bootstrap new infrastructure (background sweeps, recalibration jobs, metric aggregators, embedding indexes) | $0-10 |
| 6 | **Post-deploy reboot + re-verify**: hard bootout/bootstrap every service, refresh caches, re-run regression-guard against LIVE state | $0-40 |
| 7 | Propagate documentation + memory (CLAUDE.md / AGENTS.md / README.md / MEMORY.md updates) | $0 |
| 8 | Smoke test the end-to-end user journey via Chrome MCP at dashboard.careers-ops.com | $0 |
| 9 | **System health check**: /system-maintainer --all + /career-ops-health --deploy-invoke ($40 budget) | $2-40 |
|   | **Worst-case total** | **~$430** |
|   | **Typical total** | **~$10-50** |

## Triggers

- `/deploy-verify` — any phrasing
- "deploy this" / "deploy + verify" / "ship + verify"
- "run the full deploy procedure"
- "push + reboot + test"
- "verify the deploy held"
- After a sprint of 5+ commits, before any production-affecting push
- When unsure whether a deploy actually landed correctly

## Example invocations

```
/deploy-verify                         # full procedure on current branch
/deploy-verify --branch feat/foo       # explicit branch (default: current HEAD)
/deploy-verify --skip-phase 7          # skip doc propagation (e.g. if already done)
/deploy-verify --skip-phase 3          # DANGEROUS — skips the pre-push QA gate; use only when regression-guard + bug-resolver were run manually within the last hour
```

## Locked decisions baked into this skill

From the 2026-05-25 prompt-optimizer interview chain:

| # | Decision | Locked answer | Effect |
|---|---|---|---|
| Q1 | CRIT regression handling | Halt + surface for review | Phase 3A pauses on any CRIT, requires Mitchell sign-off |
| Q2 | DRAFT PR auto-merge policy | Auto-merge anything CI-green not touching personal data | Phase 3B merges code/config/script PRs inline; surfaces personal-data PRs |
| Q3 | System health agent | Existing /system-maintainer + new dedicated career-ops-health | Phase 9 runs both |
| Q4 | New agent scope | Comprehensive production health (6 categories) | career-ops-health checks deploy / freshness / OAuth / quotas / heartbeats / cost drift |
| Q5 | New agent cadence | Daily 06:30 PT scheduled + on-deploy invoke | Phase 9 invokes with `--deploy-invoke` flag |
| Q6 | Agent failure handling | Continue with degraded confidence | One agent crash doesn't halt the whole flow |
| Q7 | Phase 6 restart depth | Hard bootout + bootstrap | Not kickstart-k — clears in-memory state |
| Q8 | Deployment report path | `data/deployment-report-*.md` (gitignored) | Personal pipeline state stays out of git |
| Q9 | Cost cap policy | 2x defaults for critical deploys | $40 regression + $300 bug-resolver + $40 health = ~$380 max |
| Q10 | Format | Both inline prompt + this skill | This skill invokes the inline prompt |
| Q11 | Alerting | Terminal-only | No Telegram / Slack push for v1.0 |
| Q12 | Doc enshrinement | AGENTS.md + MEMORY.md updates | Phase 7 updates both |
| Q13 | New agent synthesis model | Sonnet 4.6 | career-ops-health uses claude-sonnet-4-6 |

Full decision rationale in `data/agent-spec-career-ops-health-2026-05-25.md`.

## STOP-AND-ASK rules

The skill pauses for Mitchell confirmation on:
- Phase 3A CRIT regression-guard findings (HALT, surface, require resolution path)
- Phase 3B DRAFT PRs touching sensitive paths (`cv.md`, `data/hm-intel/`, `data/apply-pack[s]/`, `data/second-brain-extracted/`, `data/applications.md`, `*.env`)
- Phase 4C: merging a PR with RED CI or PENDING status checks
- Phase 6C: post-deploy regressions absent in Phase 3C (deploy itself caused regression — propose rollback)
- Phase 9B: /system-maintainer recommendations affecting launchd state (loading/unloading plists, modifying schedules)
- Spending past locked caps without explicit override
- Cross-fork pushes (`scripts/safe-gh-pr.sh` should refuse; if it doesn't, stop)
- OAuth re-flows requiring user interaction
- CDN cache purges with downtime impact

The skill DOES NOT pause for:
- Reading files / running read-only commands
- Restarting non-production services
- Bootstrapping new launchd jobs
- Doc propagation commits
- Triggering scheduled jobs manually for seeding
- Building local indexes / caches
- Taking screenshots, tailing logs, running tests
- Running regression-guard / bug-resolver / career-ops-health / system-maintainer themselves
- Auto-merging CI-green DRAFT PRs that don't touch sensitive paths (per Q2)

## Failure handling

If any phase fails:
1. Capture the error (do NOT retry blindly)
2. Check against bug-class catalog patterns (`launchd-keepalive-tahoe`, `multi-agent-collision`, `missing-timeout-on-long-running-operation`, `convergence-impossible-runaway-without-cap`)
3. Known pattern → apply documented fix, retry once
4. Unknown → append to deployment report under "Failed deployments," continue remaining inventory items
5. Surface failed items prominently in the final report

Agent-specific failure (per Q6 locked):
- regression-guard times out / non-zero → fall back to last successful run's dashboard panel JSON; proceed with degraded confidence; flag in report
- bug-resolver fails on a specific bug → skip that bug, continue with the rest of the ledger
- system-maintainer fails → fall back to manual `launchctl list` + flapping check; flag in report
- career-ops-health fails → fall back to manual `curl https://dashboard.careers-ops.com/`; flag in report

## How this skill differs from related tooling

| Related skill | When to use it instead |
|---|---|
| `engineering:deploy-checklist` | Generic pre-deploy CI/feature-flag/rollback checklist; use for non-career-ops repos |
| `/system-maintainer` | Just want SRE hygiene snapshot, not a full deploy |
| `/regression-guard` | Just want regression detection, not the whole deploy gate |
| `/career-ops-health` | Just want production-health snapshot, not the whole deploy |
| `/bug-resolver` | Just want bug ledger processed, not the whole deploy |
| `/refresh-master` | Refresh dashboard caches without touching code |
| `verify` | Verify a single PR's change works (not a full deploy) |

`deploy-verify` is the END-TO-END procedure that invokes the right subset of all of the above.

## Output

- **Inline progress**: silent through phases 1-8, verbal Phase 9 summary
- **Final report**: `data/deployment-report-<YYYY-MM-DD-HHMM>.md` (gitignored) with:
  - Live and verified (Phase 2 + 8 acceptance criteria)
  - Pre-push QA gate (Phase 3 regression-guard + bug-resolver tallies)
  - Bootstrap runs (Phase 5)
  - Post-deploy re-verification (Phase 6)
  - Documentation propagation (Phase 7)
  - System health check (Phase 9)
  - Needs user action (consolidated)
  - Anything refused (STOP-rule hits)
  - Single next action

## Source of truth

- **Inline prompt**: `data/deploy-verify-prompt-2026-05-25.md` (the canonical 9-phase procedure)
- **Design doc**: `data/agent-spec-career-ops-health-2026-05-25.md` (decision rationale + agent spec)
- **Companion skills**: `/regression-guard`, `/bug-resolver`, `/career-ops-health`, `/system-maintainer`

When invoked, this skill reads the inline prompt verbatim and executes the 9-phase flow.
