#!/usr/bin/env bash
# scripts/safe-worker-dispatch-preflight.sh — preflight check before dispatching
# a worker against a feature branch.
#
# Why this exists:
#   2026-05-25 Wave 4B incident — two PR workers died silently at startup
#   because their target branches already existed from a prior session's
#   failed dispatch. The locked worktrees held uncommitted work the
#   orchestrator nearly destroyed during recovery. This script prevents
#   the failure mode by checking + reporting before any worker dispatch.
#
# Usage:
#   bash scripts/safe-worker-dispatch-preflight.sh <branch-name>
#
# Exits:
#   0 — clean. Safe to dispatch a worker.
#   1 — collision detected. STDERR explains. See output for next action.
#   2 — usage error (missing arg or not in a git repo).
#
# What it checks:
#   (1) Local branch exists?
#   (2) Remote branch exists?
#   (3) Any worktree currently attached to the branch?
#   (4) If attached worktree exists: any uncommitted edits / untracked files / stashes?
#   (5) Branch ahead of origin/main with unmerged commits?
#   (6) Open OR merged PR matching this branch on the fork?
#
# Returns a structured human-readable report. NO DESTRUCTIVE OPERATIONS
# are performed by this script. Operator decides whether to delete the
# stale branch + worktree, salvage the work, or pick a new branch name.
#
# Related memory files:
#   ~/.claude/projects/.../memory/feedback_worker_branch_collision_redispatch.md
#   ~/.claude/projects/.../memory/feedback_stale_worktree_work_rescue.md
#   ~/.claude/projects/.../memory/feedback_worker_pushed_no_pr_completion.md

set -uo pipefail

BR="${1:-}"
if [ -z "$BR" ]; then
  echo "[preflight] usage: $0 <branch-name>" >&2
  echo "[preflight] example: $0 feat/apply-now-ux-pr09-staleness-banners-2026-05-25" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "[preflight] ERROR: not inside a git repo" >&2
  exit 2
fi
cd "$REPO_ROOT"

FORK_REPO="mitwilli-create/career-ops"

echo "[preflight] checking branch: $BR"
echo "[preflight] repo: $REPO_ROOT"
echo "[preflight] fork: $FORK_REPO"
echo ""

CLEAN=1
ISSUES=()

# (1) Local branch?
LOCAL_REF=$(git rev-parse "$BR" 2>/dev/null || echo "")
if [ -n "$LOCAL_REF" ]; then
  ISSUES+=("local-branch-exists:$LOCAL_REF")
  CLEAN=0
  echo "[preflight] ⚠ local branch exists: ${LOCAL_REF:0:8}"
  AHEAD=$(git log --oneline "origin/main..$BR" 2>/dev/null | wc -l | tr -d ' ')
  echo "  → $AHEAD local commits ahead of origin/main"
else
  echo "[preflight] ✓ local branch absent"
fi

# (2) Remote branch?
REMOTE_REF=$(git ls-remote origin "refs/heads/$BR" 2>/dev/null | awk '{print $1}')
if [ -n "$REMOTE_REF" ]; then
  ISSUES+=("remote-branch-exists:$REMOTE_REF")
  CLEAN=0
  echo "[preflight] ⚠ remote branch exists: ${REMOTE_REF:0:8}"
  git fetch origin "$BR" --quiet 2>/dev/null || true
  REMOTE_AHEAD=$(git log --oneline "origin/main..origin/$BR" 2>/dev/null | wc -l | tr -d ' ')
  echo "  → $REMOTE_AHEAD commits ahead of origin/main on remote"
else
  echo "[preflight] ✓ remote branch absent"
fi

# (3) Worktree attached?
WT_PATH=""
WT_PATH=$(git worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$BR" '
  /^worktree / { wt=$2 }
  $0=="branch " b { print wt; exit }
')

if [ -n "$WT_PATH" ]; then
  ISSUES+=("worktree-attached:$WT_PATH")
  CLEAN=0
  echo "[preflight] ⚠ worktree attached at: $WT_PATH"

  # (4) Uncommitted in worktree?
  if [ -d "$WT_PATH" ]; then
    DIRTY=$(git -C "$WT_PATH" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    STASHES=$(git -C "$WT_PATH" stash list 2>/dev/null | wc -l | tr -d ' ')
    UNTRACKED=$(git -C "$WT_PATH" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
    echo "  → dirty_files=$DIRTY untracked=$UNTRACKED stashes=$STASHES"

    if [ "$DIRTY" -gt 0 ] || [ "$UNTRACKED" -gt 0 ] || [ "$STASHES" -gt 0 ]; then
      ISSUES+=("worktree-dirty:dirty=$DIRTY,untracked=$UNTRACKED,stashes=$STASHES")
      echo "  → DIRTY — snapshot before any destructive op (see feedback_stale_worktree_work_rescue.md):"
      git -C "$WT_PATH" status --porcelain 2>/dev/null | head -10 | sed 's/^/    /'
      [ "$UNTRACKED" -gt 0 ] && {
        echo "  → untracked files:"
        git -C "$WT_PATH" ls-files --others --exclude-standard 2>/dev/null | head -5 | sed 's/^/    /'
      }
    fi
  else
    echo "  → worktree path missing on disk (git metadata inconsistent — may need `git worktree prune`)"
  fi
else
  echo "[preflight] ✓ no worktree attached to $BR"
fi

# (5/6) PRs for this branch?
if command -v gh >/dev/null 2>&1; then
  PR_COUNT=$(gh pr list --repo "$FORK_REPO" --state all --search "head:$BR" --json number 2>/dev/null | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "0")
  echo "[preflight] PRs for this branch: $PR_COUNT"
  if [ "$PR_COUNT" -gt 0 ]; then
    gh pr list --repo "$FORK_REPO" --state all --search "head:$BR" --json number,state,title 2>/dev/null | \
      python3 -c "
import sys, json
for pr in json.loads(sys.stdin.read()):
  print(f\"  → #{pr['number']} [{pr['state']}] {pr['title'][:80]}\")
" 2>/dev/null
  fi
fi

echo ""
if [ "$CLEAN" = "1" ]; then
  echo "[preflight] ✓ CLEAN — safe to dispatch worker against $BR"
  exit 0
fi

echo "[preflight] ✗ COLLISION — issues: ${ISSUES[*]}"
echo ""
echo "[preflight] NEXT-ACTION DECISION TREE:"
echo "  (a) Shipped work + PR exists → NOTHING TO DO. Worker is unneeded."
echo "  (b) Shipped work + NO PR → open PR manually:"
echo "        bash scripts/safe-gh-pr.sh --title \"<title>\" --body-file <body> \\"
echo "          --base main --head $BR --auto-merge-after-ci"
echo "  (c) Worktree dirty → SNAPSHOT first, then decide:"
echo "        SNAP=/tmp/${BR//\//-}-pre-cleanup-\$(date +%Y%m%d-%H%M%S)"
echo "        mkdir -p \"\$SNAP\""
echo "        git -C $WT_PATH diff > \"\$SNAP/diff.patch\""
echo "        git -C $WT_PATH log --oneline origin/main..HEAD > \"\$SNAP/unmerged.log\""
echo "  (d) Branch stale + clean + safe to delete:"
echo "        git worktree remove --force $WT_PATH    # if worktree attached"
echo "        git branch -D $BR"
echo "        git push origin --delete $BR             # if remote exists"
echo "  (e) Want a fresh worker → pick a different branch name (suffix -v2, -retry-<ts>)"
echo ""
exit 1
