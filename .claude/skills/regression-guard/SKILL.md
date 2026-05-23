---
name: regression-guard
description: Run aggressive regression detection across 8 types (code / UI / data / pipeline / behavioral / closure / memory / performance) over the career-ops repo + Claude session transcripts + memory dirs + brain docs + Council OS KB + Second Brain. Slash-command wrapper around `scripts/agents/regression-guard.mjs`. Default daily 06:00 PT scheduled run. Alert-only + decision-doc output (no auto-action without explicit env-flip). Mitchell's locked decisions — $20/day cap, NO hard per-call sub-cap, SOFT $5/call WARN. Cross-fork-leak hardening — hash_only citations + `[PERSONAL — DO NOT PUBLISH]` frontmatter + build-time assertion. 5-vector self-regression defense (canary suite, baseline expiry, spend cap, silent-period alarm, auto-action ledger). Hybrid long-context routing — Gemini 3.1 Pro ingest with Sonnet 4.6 fallback on 5xx/timeout. Triggers when Mitchell types /regression-guard, says "run regression detection," "check for regressions," "audit for drift," "what regressed today," "scan for invariant violations," "did anything quietly break," "forensic root-cause for this session," or any phrasing that calls for the regression scanner manually instead of waiting for the 06:00 PT scheduled run. Heavy work runs in the agent subprocess so the main session context stays clean. Output: `.claude/audit/<YYYY-MM-DD>/regression-report-<YYYY-MM-DD>.md` + `data/dashboard-panels/regression-guard.json` (Dashboard "Regression alerts" panel reader).
user_invocable: true
args: mode
argument-hint: "[scheduled | seed-baselines | deep <session-id> | smoke | canary-only | dashboard] (default: scheduled)"
---

# regression-guard — aggressive regression-detection agent

## Purpose

career-ops accretes state across many parallel sessions, autonomous overnight hauls, and subagent runs. Drift sneaks in: a closure invariant gets re-violated by a fix-elsewhere edit, a memory rule stops firing, a data file silently loses rows, a pipeline phase regresses without anyone noticing. This agent fires daily at 06:00 PT to catch that drift WHILE it's still cheap to revert.

Built from the dealbreaker-adjudicated spec at:
- `~/.claude/agents/runs/dealbreaker-final-20260523-132911-regression-agent-delta.md`
- `~/.claude/agents/runs/researcher-delta-2026-05-23-regression-agent.md`
- `~/.claude/agents/runs/researcher-report-2026-05-23-regression-agent.md`

Mitchell's locked decisions (override the dealbreaker $10/$3 numbers):
- `REGRESSION_GUARD_DAILY_USD=20` (was $10 in dealbreaker)
- **No hard per-call sub-cap** (dealbreaker proposed $3 — removed)
- `REGRESSION_GUARD_PER_CALL_WARN_USD=5` SOFT warning only — does NOT block
- Day-1 launchd plist LOADED but **DISABLED** awaiting trial-run review

## Modes

| Mode | What it does | Spend |
|---|---|---|
| `scheduled` (default) | Daily 06:00 PT run. Reads baselines, fires 8 detectors, writes decision doc. | $0-3 typical |
| `seed-baselines` | First run / re-anchor. Seeds baselines from current state. Trial cap $10. | $0-10 |
| `deep <session-id>` | Forensic root-cause on a single session-id or `YYYY-MM-DD` range. Uses Gemini 3.1 Pro ingest + Sonnet 4.6 synthesis + Opus 4.7 adversarial verdict. | $1-3 per call |
| `smoke` | Smoke test. No real LLM calls; mocks Gemini→Sonnet fallback + cost WARN. | $0 |
| `canary-only` | Run only the canary self-test loop. Used by hang-watchdog hooks. | $0 |
| `dashboard` | Refresh `data/dashboard-panels/regression-guard.json` without running detection. | $0 |

## Triggers

- `/regression-guard` (any phrasing) — slash command
- "run regression detection" / "check for regressions"
- "audit for drift" / "scan for invariant violations"
- "what regressed today" / "did anything quietly break"
- "forensic root-cause for this session" → invokes `--deep`
- After major refactors, before shipping a sprint, after merging large PRs

## Example invocations

```
/regression-guard                             # default: --scheduled
/regression-guard scheduled                   # explicit
/regression-guard seed-baselines              # day-0 / re-anchor
/regression-guard deep <session-uuid>         # forensic, single session
/regression-guard smoke                       # smoke test
/regression-guard canary-only                 # canary check only
/regression-guard dashboard                   # refresh panel JSON
```

## Inputs / outputs / constraints

**Inputs:**
- `~/Documents/career-ops/` (the repo + audit dirs)
- `~/.claude/projects/<encoded>/` (session transcripts — gitignored personal)
- `~/.claude/projects/<encoded>/memory/` (memory files — gitignored personal)
- `~/.claude/knowledge/brain/` (brain docs)
- `~/Documents/council-os/` (Council OS KB)
- `~/Documents/career-ops/data/second-brain-extracted/second brain/` (Second Brain — gitignored, HIGH sensitivity)

**Outputs:**
- `.claude/audit/<YYYY-MM-DD>/regression-report-<YYYY-MM-DD>.md` (decision doc; `[PERSONAL — DO NOT PUBLISH]` frontmatter)
- `data/dashboard-panels/regression-guard.json` (panel reader for Dashboard "Regression alerts")
- `data/regression-guard-spend.jsonl` (append-only cost ledger)
- `data/regression-baselines/<type>.json` (per-type baselines with `set_at` / `expires_at`)
- `data/regression-auto-actions.jsonl` (append-only ledger; unused at default, ships day-1 plumbing)
- `data/logs/regression-guard-<DATE>.log` (operational log)

**Constraints — CRITICAL:**

- **Cross-fork-leak defense (Pattern E)**: decision-doc citations from `~/.claude/projects/`, `data/second-brain-extracted/`, `cv.md`, `data/applications.md`, `data/hm-intel/`, `data/apply-pack[s]/` are HASH-ONLY by default. Build-time `assertNoInlineQuotesFromSensitivePaths()` THROWS if any inline quote leaks. Frontmatter is `classification: "[PERSONAL — DO NOT PUBLISH]"`.

- **Alert-only default**: `REGRESSION_GUARD_AUTO_ACTION=false`. Wider scope (8 types + cross-OS scan + Sonnet floor) means wider false-positive surface — locked conservative. To flip: `launchctl setenv REGRESSION_GUARD_AUTO_ACTION true` (then re-run Opus's 5-question dialogue script first per dealbreaker-final § Mitchell's next concrete step).

- **5-vector self-regression defense**:
  1. **Canary suite** — runs on every invocation. Tests 3 highest-leverage bug-class incidents (parallel-agent-collision, inline-payload-bloat, outer-template-unescape). On miss: `CANARY_FAIL_SHUT=true` disables non-canary findings + emits CRIT.
  2. **Baseline expiry** — 30 days. Expired baselines refuse to compare; re-anchor via `--seed-baselines`.
  3. **Daily spend cap** — `$20` (Mitchell's locked override of $10). Hard-stop CRIT at cap. NO hard per-call sub-cap. SOFT $5/call WARN.
  4. **Silent-period alarm** — per-type threshold (7d for high-volume types 1/6/7, 14d for low-volume 4/5/8). Surfaces MED finding when type goes silent.
  5. **Auto-action ledger** — `data/regression-auto-actions.jsonl` append-only with rule-version stamp + 1/24h hard rate limit. Disabled at default — plumbing only.

- **Hybrid long-context routing (load-bearing per dealbreaker)**:
  - **Ingest** (`>200k` tokens): Gemini 3.1 Pro Preview with documented "high" NIAH at 1M.
  - **Fallback on Gemini 5xx OR timeout**: Sonnet 4.6 ingest. Both routes invoked via `geminiIngestWithFallback()`. Fallback rate > 10%/7d is itself a finding worth surfacing.
  - **Synthesis** (decision-doc text): Sonnet 4.6. Higher Tyler Folkman UX-rubric score than Opus at 40% lower cost.
  - **`--deep` adversarial verdict**: Opus 4.7. Reserved for hardest cases; separate `DEEP_BUDGET_USD=$20/month` cap.

- **Transcript baseline behind feature flag**: `REGRESSION_GUARD_TRANSCRIPT_BASELINE_ENABLED=false` for first 30 days. Collects stats but doesn't fire Type 5 findings. Mitchell reviews after 30d → flip the flag.

- **NEVER modifies cv.md / modes/_profile.md / config/profile.yml / article-digest.md**. These are gold-standard personal-authored files.

- **NEVER auto-pushes a PR or revert**. Even with `AUTO_ACTION=true`, the agent opens a `propose-fix-PR` for Mitchell to review/merge.

## Anti-hallucination reminders (inline)

- Report raw counts: `3 findings, 0 CRIT, 1 HIGH, 2 MED`. Never "all healthy ✓" unless count is 0.
- Every finding has `file:line` citation. Findings without a citable source are dropped, not surfaced as low-confidence soup.
- Baseline expiry is hard-block — the agent refuses to compare against a >30d baseline. Re-anchor first.
- Hallucination-risk: when Gemini ingest fires AND fallback fires, the doc notes both paths. Don't claim Gemini said something Sonnet actually synthesized.

## Anti-sycophancy reminders (inline)

- If 0 findings, say "0 findings — system green this cycle" + check silent-period alarm. Don't bury behind "comprehensive scan complete."
- If canary degrades, say "CANARY DEGRADED — detection pipeline is suspect, do NOT trust today's findings." Don't soften.
- If the daily cap exhausts, say "CAP EXHAUSTED at $20 — no further runs today." Don't apologize.

## Scheduled run

`scripts/launchd/com.mitchell.career-ops.regression-guard.plist` runs `--scheduled` daily at **06:00 PT**.

**Day-1: plist is loaded-but-DISABLED.** Mitchell flips it on after reviewing the trial decision-doc:

```bash
launchctl enable gui/$(id -u)/com.mitchell.career-ops.regression-guard
```

Kill switch (no unload required):

```bash
launchctl setenv REGRESSION_GUARD_ENABLED false
```

Full rollback runbook (if the agent misbehaves):

```bash
# 1. Immediately disable
launchctl setenv REGRESSION_GUARD_ENABLED false

# 2. Disable scheduled trigger
launchctl disable gui/$(id -u)/com.mitchell.career-ops.regression-guard

# 3. Reset state
rm -f data/regression-guard-state.json data/regression-guard-spend.jsonl

# 4. Archive (don't delete) bad reports
mv .claude/audit/$(date +%Y-%m-%d)/regression-report-*.md \
   .claude/audit/$(date +%Y-%m-%d)/regression-report-ROLLED-BACK-$(date +%H%M).md
```

## How this skill differs from existing tooling

- `system-maintainer` — covers SRE infrastructure (launchd, /tmp, orphans); regression-guard covers REGRESSIONS specifically. Different time signature.
- `omega-steward` — proposes improvements; regression-guard surfaces drift. HIGH/CRIT findings from regression-guard FLOW INTO omega-steward Phase 4 via `ingestRegressionGuardFindings()`.
- `hang-watchdog` — runtime hang detection on processes; regression-guard is offline diff against baselines.
- `data-truth-audit` — verifies dashboard metric accuracy; regression-guard verifies overall repo + transcript-level drift.
- `email-review` — daily heartbeat-email review; regression-guard is broader (8 types, cross-OS, transcript ingestion).
