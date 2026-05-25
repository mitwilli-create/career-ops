---
name: career-ops-health
description: Run the comprehensive career-ops production health agent across 6 check categories (deploy validation, data freshness, OAuth + credentials, third-party API quotas, scheduled-job heartbeats, cost drift) with Sonnet 4.6 cross-category synthesis. Slash-command wrapper around `scripts/agents/career-ops-health.mjs`. Closes the gap between `/system-maintainer` (SRE hygiene) and `regression-guard` (code/data drift) by checking the live production-health surface — "is the system actually serving Mitchell right now." Default daily 06:30 PT scheduled run + invoked from Phase 9 of /deploy-verify. Locked decisions — $20/day cap (2x = $40 on deploy invocations), Sonnet 4.6 synthesis, continue-degraded on agent failure, cross-fork-leak hardening with hash_only citations + `[PERSONAL — DO NOT PUBLISH]` frontmatter. Triggers when Mitchell types /career-ops-health, says "check system health," "run the health agent," "is everything working," "show me the health panel," "audit OAuth tokens," "check API quotas," "what's drifting in production," or any phrasing that wants the live production-health surface interrogated. Heavy work runs in the agent subprocess so the main session context stays clean. Output: `.claude/audit/<DATE>/career-ops-health-<DATE>.md` + `data/dashboard-panels/career-ops-health.json` (dashboard "System health" panel reader).
user_invocable: true
args: mode
argument-hint: "[scheduled | deploy-invoke | smoke | dashboard-only | dry-run | --category <name>] (default: scheduled)"
---

# career-ops-health — comprehensive production health agent

## Purpose

`/system-maintainer` covers SRE hygiene (plist health, /tmp cleanup, orphan sweep, security scan). `regression-guard` covers code/data drift across 8 types. NEITHER covers the production-health surface — the "is the system actually serving Mitchell right now" question.

This agent closes that gap. Six check categories, one synthesis pass.

Born 2026-05-25 via the `/anthropic-skills:prompt-optimizer` interview chain.
Authoritative design doc: `data/agent-spec-career-ops-health-2026-05-25.md`.

## Check categories

| # | Category | What it checks |
|---|---|---|
| 1 | **Deploy validation** | Endpoint latency at dashboard.careers-ops.com, dashboard build size + freshness, recent error rate from launchd logs |
| 2 | **Data freshness** | apply-now-queue, applications.md, contacts, heartbeat archive, dashboard panel JSONs, score cache TTLs |
| 3 | **OAuth + credentials** | Required env vars present, LinkedIn cookie freshness, Drive refresh token, MCP connection health |
| 4 | **Third-party quotas** | Anthropic / Gemini / GPTZero / bug-resolver / regression-guard daily spend vs locked caps |
| 5 | **Scheduled heartbeats** | launchctl list count, exit codes, flapping detection, log volume (crash loop / retry storm signature) |
| 6 | **Cost drift** | Total daily LLM spend across all ledgers; banded GREEN / YELLOW / ORANGE / RED |

Plus a **synthesis pass** (Sonnet 4.6) that cross-correlates findings into 0-5 narratives — e.g., "endpoint latency spike + heartbeat flap + log error rate up 3x = likely cascading failure."

## Modes

| Mode | What it does | Spend | When |
|---|---|---|---|
| `scheduled` (default) | Full 6-category run + synthesis | $2-5 | daily 06:30 PT |
| `deploy-invoke` | Same as scheduled + `--budget 40` (2x default) | $2-5 | Phase 9 of /deploy-verify |
| `smoke` | Deterministic checks only, no LLM calls | $0 | CI / smoke testing |
| `dashboard-only` | Print last panel state, no new scan | $0 | dashboard rebuild |
| `dry-run` | Run all checks, print summary, don't write files | $0 | first-run validation |
| `--category <name>` | Run only one category | varies | targeted debug |

## Triggers

- `/career-ops-health` (any phrasing) — slash command
- "check system health" / "run the health agent"
- "is everything working" / "show me the health panel"
- "audit OAuth tokens" / "check API quotas"
- "what's drifting in production" / "any quotas approaching limit"
- After major sprints or before shipping a large refactor
- Phase 9 of /deploy-verify invokes automatically with `--deploy-invoke`

## Example invocations

```
/career-ops-health                              # default: scheduled
/career-ops-health scheduled                    # explicit
/career-ops-health dry-run                      # first-run validation, no spend
/career-ops-health smoke                        # deterministic only
/career-ops-health --category cost_drift        # just the spend check
/career-ops-health deploy-invoke                # 2x budget, used by /deploy-verify
```

## Inputs / outputs / constraints

**Inputs:**
- `~/Documents/career-ops/` (repo state — dashboard build, panels, ledgers)
- `~/Library/Logs/career-ops/*.err` (last-hour tail for error rate)
- `https://dashboard.careers-ops.com/` (latency + HTTP status check)
- `launchctl list` (plist load + exit-code state)
- `.env` (existence checks only — never prints values)

**Outputs:**
- `.claude/audit/<DATE>/career-ops-health-<DATE>.md` (decision doc; `[PERSONAL — DO NOT PUBLISH]` frontmatter)
- `data/dashboard-panels/career-ops-health.json` (panel reader for dashboard "System health" widget)
- `data/career-ops-health-spend.jsonl` (append-only cost ledger)
- `~/Library/Logs/career-ops/career-ops-health.{out,err}` (launchd logs)

**Constraints — CRITICAL:**

- **Cross-fork-leak defense (Pattern E)**: decision-doc citations from sensitive paths are HASH-ONLY by default. Build-time `assertNoInlineQuotesFromSensitivePaths()` THROWS if any inline quote leaks. Frontmatter `classification: "[PERSONAL — DO NOT PUBLISH]"`.

- **Continue-degraded on category failure** (Q6 locked): if one of the 6 categories throws or times out, the agent logs it as a HIGH `category check threw` finding and continues with the other 5. Decision doc + panel still get written.

- **Daily spend cap** — `$20` default (`CAREER_OPS_HEALTH_DAILY_USD`), `$40` when invoked from `/deploy-verify` via `--deploy-invoke` (2x per Q9 locked). Hard-stop CRIT at cap. Soft WARN at 80%.

- **Hang-prevention contract** (per AGENTS.md § missing-timeout-on-long-running-operation):
  - All HTTP via `curl` with `--max-time 30`
  - `child_process` spawns get `timeout: 10_000`
  - NDJSON heartbeat to stderr at every check category
  - Total agent run hard-cap **10 minutes**

- **NEVER modifies** any source file. This agent is **read-only** with respect to the repo + the user's data. The only writes are: decision doc, dashboard panel, spend ledger, log file.

## Anti-hallucination reminders (inline)

- Report raw counts: `12 findings, 0 CRIT, 2 HIGH, 8 MED, 2 LOW`. Never "all healthy ✓" unless count is 0.
- Synthesis narratives MUST cite which categories' findings they correlate. Never invent a finding not present in the raw list.
- If Sonnet synthesis fails / times out / hits quota: report `synthesis skipped: <reason>` — never fabricate narratives.
- Endpoint latency claims include the actual ms value, not "fast" / "slow."

## Anti-sycophancy reminders (inline)

- If 0 findings: say "0 findings — production health green this cycle." Don't bury behind "comprehensive scan complete."
- If category fails: say "Category X FAILED — its checks did not run; results below are incomplete." Don't soften.
- If cost-drift hits RED band: say "RED BAND — total daily LLM spend exceeds $200." Don't soften to "elevated."
- If OAuth token expiring: say "X token N days old (typical expiry 30-45d) — refresh required." Don't say "may need to refresh soon."

## Scheduled run

`scripts/launchd/com.mitchell.career-ops.career-ops-health.plist` runs `--scheduled` daily at **06:30 PT** (30 min after regression-guard at 06:00 PT).

**Day-1: plist is loaded-but-DISABLED.** Mitchell flips it on after reviewing the first manual run:

```bash
# Step 1: validate via dry-run (no spend)
node scripts/agents/career-ops-health.mjs --dry-run

# Step 2: validate via real scheduled run (~$2-5)
node scripts/agents/career-ops-health.mjs --scheduled

# Step 3: review the decision doc
open .claude/audit/$(date +%Y-%m-%d)/career-ops-health-$(date +%Y-%m-%d).md

# Step 4: bootstrap + enable
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitchell.career-ops.career-ops-health.plist
launchctl enable gui/$(id -u)/com.mitchell.career-ops.career-ops-health
```

Kill switch (no unload required):

```bash
launchctl setenv CAREER_OPS_HEALTH_ENABLED false
```

Full rollback runbook:

```bash
# 1. Immediately disable
launchctl setenv CAREER_OPS_HEALTH_ENABLED false

# 2. Disable scheduled trigger
launchctl disable gui/$(id -u)/com.mitchell.career-ops.career-ops-health

# 3. Unload
launchctl bootout gui/$(id -u)/com.mitchell.career-ops.career-ops-health

# 4. Archive (don't delete) bad reports
mv .claude/audit/$(date +%Y-%m-%d)/career-ops-health-*.md \
   .claude/audit/$(date +%Y-%m-%d)/career-ops-health-ROLLED-BACK-$(date +%H%M).md
```

## How this skill differs from existing tooling

| Existing | Covers | This agent covers |
|---|---|---|
| `/system-maintainer` | SRE hygiene: plists, /tmp, orphans, security | Production health: latency, freshness, quotas, cost drift |
| `regression-guard` | Code/data DRIFT across 8 types | Production STATE — what's actually serving traffic now |
| `hang-watchdog` | Runtime hang detection on processes | Aggregate-level error rate, retry storms, log volume |
| `data-truth-audit` | Dashboard metric ACCURACY | Dashboard ENDPOINT health + panel freshness |
| `omega-steward` | Proposes ecosystem improvements | Detects current degradation requiring action now |

HIGH/CRIT findings here can be fed into omega-steward's Phase 4 hook in v1.1+ (currently regression-guard is the only source feeding that hook).

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `CAREER_OPS_HEALTH_ENABLED` | `true` | Kill switch |
| `CAREER_OPS_HEALTH_DAILY_USD` | `20` | Daily spend cap (2x = $40 via --deploy-invoke) |
| `CAREER_OPS_HEALTH_MODEL` | `claude-sonnet-4-6` | Synthesis model |
| `CAREER_OPS_HEALTH_VERBOSE` | unset | Set `1` to stream log to stderr |

## Cost profile

- Deterministic checks (categories 1-6): $0
- Sonnet 4.6 synthesis: ~$0.10-2 typical (10-30k input tokens, 0.5-2k output)
- Typical run: $0.10-2
- Worst case with full quota analysis: ~$5
- Hard cap: `$20` daily (or `$40` on --deploy-invoke)

## Locked decisions captured in this skill

From the 2026-05-25 prompt-optimizer interview chain (13 questions):

- Q3 → existing `/system-maintainer` + this new agent (both run)
- Q4 → Comprehensive scope (6 categories)
- Q5 → Daily 06:30 PT scheduled + on-deploy invoke
- Q6 → Continue with degraded confidence on agent failure
- Q9 → 2x cost caps for critical deploys
- Q13 → Sonnet 4.6 for synthesis
- Q14 → Full build + dry-run validate (this ship)

See `data/agent-spec-career-ops-health-2026-05-25.md` for the full decision table.
