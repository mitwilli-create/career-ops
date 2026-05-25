# Worker dispatch preamble — STANDARD TEMPLATE

**Embed this preamble at the TOP of every worker brief, BEFORE the worker-specific deliverables.** Updated 2026-05-25 from the Wave 4B postmortem.

This preamble exists because several silent-failure modes recur across worker dispatches in `career-ops`:

- Branch-name collision against a prior session's leftover branch ([[feedback_worker_branch_collision_redispatch]])
- Output JSONL not flushing during 15-25 min work, leading orchestrator to false-diagnose worker as dead ([[feedback_background_agent_observability_vs_liveness]])
- Worker dies between push + PR-creation, leaving "pushed-but-no-PR" orphan ([[feedback_worker_pushed_no_pr_completion]])
- Worker `cd`'s out of its isolated worktree into main repo, landing commits on a sibling branch (AGENTS.md § Bug class: concurrent-cd-prefix-orphan)

The preamble below makes the worker robust against all four.

---

## Pre-flight (FIRST STEP, no exceptions)

Before doing any other work, run the dispatch preflight against your target branch:

```bash
bash scripts/safe-worker-dispatch-preflight.sh <your-target-branch>
```

Exit-code semantics:
- `0` → CLEAN. Proceed with worktree creation + work.
- `1` → COLLISION. READ the preflight report carefully. DO NOT auto-recreate, auto-delete, or auto-salvage.
   - Return early with status `NEEDS_OPERATOR_REVIEW`
   - Paste the full preflight stderr output in your final summary
   - Surface the decision tree (a-e) the script printed
   - The orchestrator decides: salvage existing work, discard + retry, or pick a different branch name
- `2` → USAGE ERROR. Fix the invocation, retry.

## Worker liveness signals

You may run for 15-25 min wall-clock without observable progress in your harness `.output` JSONL file. That's expected — the JSONL transcript buffers, the harness's completion notification is the canonical "done" signal.

To support orchestrator + human observability without relying on JSONL flush:

1. Emit explicit NDJSON heartbeats to stderr at every phase boundary:
   ```js
   process.stderr.write(JSON.stringify({
     t: new Date().toISOString(),
     phase: 'commit-pushed',
     branch: '<your-branch>',
   }) + '\n');
   ```

2. Commit incrementally — orchestrators can verify your worktree's git state (`git -C <worktree> status`) without waiting for JSONL flush.

3. Push to remote as soon as you have a coherent commit — orchestrators can verify branch state via `git ls-remote origin "refs/heads/<branch>"`.

## Completion contract — FIVE STEPS, ALL REQUIRED

Your work is "done" ONLY when ALL five pass in order:

1. **Implementation complete** — all deliverables in the brief landed
2. **`git commit` succeeded** — with a clean commit message documenting deliverables
3. **`git push` succeeded** — to `origin <branch>` on the fork
4. **PR opened** — via `bash scripts/safe-gh-pr.sh --title "..." --body-file <body> --base main --head <branch> --auto-merge-after-ci`. Returns a PR URL.
5. **PR verified** — `gh pr view <num> --repo mitwilli-create/career-ops --json state` confirms the PR exists

DO NOT exit success after step 3. Workers that hit weekly-limit or auth-timeout between step 3 and step 4 produce "pushed-but-no-PR" orphans that Mitchell never sees. If you hit a failure between step 3 and step 4:

- Return status `NEEDS_OPERATOR_REVIEW`
- Include in your summary: branch name, commit SHA, push timestamp, the failure mode that prevented PR creation
- The orchestrator opens the PR manually for you

## Cleanup discipline — STAY IN YOUR WORKTREE

Your worktree (`isolation: "worktree"`) is isolated. STAY THERE.

- DO NOT `cd ~/Documents/career-ops` — the main repo may be checked out on a sibling instance's branch. `cd` prefixes silently move you out of isolation, landing commits on whatever sibling branch is currently checked out.
- DO NOT `cd ~/Documents/career-ops/.claude/worktrees/<other-agent-worktree>` either — same risk.
- Use absolute paths for any file ops: `Read ~/Documents/career-ops/.claude/worktrees/<your-id>/foo.mjs` not `Read .claude/worktrees/<your-id>/foo.mjs`.
- If you need a gitignored file from main (`cv.md`, `data/hm-intel/*.json`, `apply-pack/*`): symlink it into your worktree at start, `ln -sfn <main-repo>/<path> <your-worktree>/<path>`. Never `cd` to read it.

## Standard exit shape

Return a structured summary at completion. Under 300 words narrative.

```yaml
status: MERGED | BLOCKED | NEEDS_OPERATOR_REVIEW | NEEDS_HANDOFF
pr_url: https://github.com/mitwilli-create/career-ops/pull/<N>
pr_number: <N>
squash_sha: <40-char>
merge_state: auto-merge-enabled-awaiting-CI | merged | conflict | failed | preflight-collision
smoke_results: [{name, pass/fail, evidence}]
chrome_screenshot_paths: [<absolute-paths>]
cost_actual: <USD>
deferrals: [<strings>]
needs_human: [<strings>]
```

For `NEEDS_OPERATOR_REVIEW`, include the preflight report verbatim under `needs_human`.

## Drift guidance (carry forward verbatim if you spawn sub-handoff)

Push hard on the active task — but recognize drift early. If you notice ANY of: re-reading files you should remember, forgetting decisions, contradicting earlier output, wrong paths in tool calls, losing the thread on multi-step plans, declining synthesis quality, increased hedging, repeating yourself, or "I don't remember exactly" — STOP at the next safe checkpoint, surface what's done, return status `NEEDS_HANDOFF` with a self-perpetuating drift block in your handoff prompt.

The threshold is the smallest percentage. Mitchell prefers a chain of sharp instances over one degraded session.
