---
name: popout-bulk-regen
description: Fully-autonomous execution of #2 bulk popout regen + #3 rollback test + auto-merge of PR #229 + PR #237. Triggers when Mitchell types /popout-bulk-regen, says "ship the popout-action-completed-mode #2 + #3", "complete the popout refactor handoff", "finish the popout work", or any phrasing that wants the deferred bulk regen + verification + merge fired end-to-end without confirmation gates. Reusable when popout data goes stale + needs re-regeneration. Heavy work runs in this session (no subagent spawn) because Chrome MCP verification requires the foreground browser; LLM agent calls fan out in parallel via child processes.
---

# /popout-bulk-regen — autonomous bulk regen + verify + merge

Implements the 12-decision lock table from Mitchell's 2026-05-25 interview. Reads `data/handoff-popout-bulk-regen-verify-2026-05-25.md` as the canonical spec (source-of-truth); this SKILL is the thin entry point.

## What this skill does (in order)

1. **Pre-flight checks** — git state, branch, PR #229 + #237 health, idempotency on already-merged PRs, halt on weird drift
2. **Phase 1: Bulk popout regen** — aggressive parallel: 5 rows concurrent per agent, all 3 agents fanned out simultaneously (interview-likelihood + hm-chance + strategy-ceiling lazy via popouts)
3. **Phase 2: HM-intel deep refresh** — 10 rows × `intel-refresh --mode deep-council-7` in parallel (top-3 active + 3 missing-team-health + 4 truly-missing-hm-intel)
4. **Phase 3: Rollback smoke test** — `launchctl setenv POPOUT_DATA_FIRST_MODE 0` + bootout/bootstrap + Chrome MCP screenshot legacy popout + flip back. **HALTS auto-merge if rollback path broken.**
5. **Phase 4: Chrome MCP verification** — full 18×4=72 popouts at 1440×900. **HALTS auto-merge if ANY popout fails to render.**
6. **Phase 5: PR documentation** — adds verification report as PR comment AND updates PR body for both #229 + #237
7. **Phase 6: Auto-merge** — `gh pr merge 237 --squash --delete-branch` then `gh pr merge 229 --squash --delete-branch`, both via `scripts/safe-gh-pr.sh` pattern. Only fires if CI green + sensitive-paths-clean + Phase 3 + Phase 4 both passed.
8. **Phase 7: Final report + notifications** — writes `data/popout-execution-report-2026-05-25.md`, updates `data/popout-bulk-regen-status.json`, fires `osascript -e 'display notification'` at start + finish.

## Failure handling

- Per-row LLM failure (timeout / rate-limit / API error): **retry 2x with exponential backoff (5s, 30s), then skip + document**
- Popout render failure during Phase 4: **abort auto-merge, surface as NEEDS_HUMAN**
- Rollback path broken in Phase 3: **abort auto-merge, surface as NEEDS_HUMAN**
- PR state drift (closed-without-merge / unexpected commits / force-push): **halt + NEEDS_HUMAN**
- PR already merged when skill starts: **idempotent — skip merge, still run post-merge verification**

## Budget

- Total cap: **$730** (Mitchell-locked in 2026-05-25 interview)
- Breakdown: $130 bulk popout regen + $500 hm-intel deep + $30 misc + $70 buffer
- Per-agent caps enforced via `--max-cost-usd` flags
- Hard-stop: if `data/popout-bulk-regen-status.json::total_cost_usd >= 730`, halt + surface

## Usage

```
/popout-bulk-regen
```

That's it. The skill is fully self-contained. No args. No confirmation gates.

Run from `~/Documents/career-ops/`. Reads the canonical spec at `data/handoff-popout-bulk-regen-verify-2026-05-25.md`.

## Idempotency

Safe to re-run multiple times:
- Already-cached interview-likelihood / hm-chance rows (3-day TTL): skipped via `isCacheFresh()`
- Already-fresh hm-intel rows (3-day TTL): skipped
- Already-merged PRs: skipped, verification still runs against main
- Status JSON updated atomically per phase, recoverable from crash mid-flight

## Output artifacts

- `data/popout-execution-report-2026-05-25.md` — final markdown report (verification grid + spend + merge SHAs)
- `data/popout-bulk-regen-status.json` — phase-by-phase status, pollable any time
- `.claude/audit/popout-refactor-2026-05-25/full-verification-manifest.md` — 72-popout screenshot manifest
- PR comments on #229 + #237 with verification block
- macOS notifications at start + finish

## Reusability

This skill is reusable. When popout caches go stale next time (interview-likelihood TTL > 3 days, hm-intel TTL > 3 days, new apply-now rows added), fire `/popout-bulk-regen` again. The canonical spec at `data/handoff-popout-bulk-regen-verify-2026-05-25.md` is the source-of-truth — update it when scope changes; the skill auto-reads the latest version.
