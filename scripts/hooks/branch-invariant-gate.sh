#!/usr/bin/env bash
# scripts/hooks/branch-invariant-gate.sh
#
# PreToolUse / PostToolUse hook for Bash commands. Detects silent mid-session
# branch drift by capturing the working tree's git branch on every Bash
# invocation and comparing to the previous capture.
#
# Established 2026-05-23 after a parallel-process branch-swap incident:
# 5 commits landed on feat/regression-guard-agent, then the working tree was
# silently switched to a different branch by an unidentified external process
# (parallel Claude Code instance, manual git in another terminal, or hook
# side-effect). The drift wasn't detected until the deployment-audit pass
# ~3 hours later, by which point dashboard/index.html had been rebuilt from
# the wrong source and the on-disk state was inconsistent with what was
# pushed to origin.
#
# This hook closes that gap: every Bash invocation captures the branch
# before + after the command runs. If the branch changed and the command
# itself didn't contain a `git checkout|switch|worktree` pattern, the hook
# emits a stderr warning that surfaces to the user in tool output.
#
# Modes:
#   $1 = "pre"   — runs before the Bash command. Captures + compares.
#   $1 = "post"  — runs after the Bash command. Captures + compares again.
#
# The state file at /tmp/claude-branch-state-<session>.json holds the
# last-known branch. Falls back to /tmp/claude-branch-state-default.json
# if no session id is available.
#
# Exit codes:
#   0   always — never blocks the Bash call. The warning surfaces in stderr.
#       Blocking branch swaps would break legitimate `git checkout` calls.
#
# Input on stdin is JSON: { "tool_name": "Bash", "tool_input": { "command": "...", ... } }

set -euo pipefail

MODE="${1:-pre}"
REPO="/Users/mitchellwilliams/Documents/career-ops"
# Use session id if available, else a stable default. CLAUDE_SESSION_ID is
# set by some harness configurations; fall back gracefully.
SESSION_ID="${CLAUDE_SESSION_ID:-default}"
STATE_FILE="/tmp/claude-branch-state-${SESSION_ID}.json"

cd "$REPO" 2>/dev/null || exit 0  # not in repo → don't fire

# Read JSON tool input from stdin
input="$(cat 2>/dev/null || echo '{}')"

command_str="$(printf '%s' "$input" | /usr/bin/env python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print((d.get('tool_input') or {}).get('command', ''))
except Exception:
    print('')
" 2>/dev/null || echo '')"

# Current branch — if not a git repo or detached HEAD, skip gracefully
current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[ -z "$current_branch" ] && exit 0

# Worktree path (lets us distinguish drift WITHIN one worktree from a
# legitimate cd to another worktree's checkout). Each worktree has its own
# branch invariant.
worktree_path="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
state_key="$(printf '%s' "$worktree_path" | shasum -a 256 | cut -c1-12)"

read_stored() {
    [ ! -f "$STATE_FILE" ] && return 1
    /usr/bin/env python3 -c "
import json, sys
try:
    with open('$STATE_FILE') as f:
        d = json.load(f)
    entry = d.get('$state_key')
    if entry:
        print(entry.get('branch', ''))
    else:
        print('')
except Exception:
    print('')
" 2>/dev/null
}

write_stored() {
    /usr/bin/env python3 -c "
import json, os, sys
state_file = '$STATE_FILE'
key = '$state_key'
branch = '$current_branch'
worktree = '$worktree_path'
cmd = '''$(printf '%s' "$command_str" | head -c 200 | tr "'" '"')'''
mode = '$MODE'
d = {}
if os.path.exists(state_file):
    try:
        with open(state_file) as f:
            d = json.load(f)
    except Exception:
        d = {}
d[key] = {
    'branch': branch,
    'worktree': worktree,
    'last_command': cmd,
    'last_mode': mode,
    'last_seen': __import__('datetime').datetime.now().isoformat(),
}
try:
    with open(state_file, 'w') as f:
        json.dump(d, f)
except Exception:
    pass
" 2>/dev/null || true
}

stored_branch="$(read_stored || echo '')"

# If we have no stored branch yet, just initialize + exit
if [ -z "$stored_branch" ]; then
    write_stored
    exit 0
fi

# If the branch hasn't changed, just refresh the state + exit silently
if [ "$current_branch" = "$stored_branch" ]; then
    write_stored
    exit 0
fi

# Branch CHANGED. Was the change intentional (the command itself is a git
# branch-switch operation)?
is_intentional=false
case "$command_str" in
    *"git checkout"*|*"git switch"*|*"git worktree"*|*"git clone"*|*"git pull"*|*"git fetch"*|*"git rebase"*|*"git merge"*|*"git reset"*|*"git cherry-pick"*|*"git revert"*|*"git stash"*)
        is_intentional=true
        ;;
esac

if [ "$is_intentional" = "true" ]; then
    # Expected switch — just update state silently
    write_stored
    exit 0
fi

# UNEXPECTED branch change. Emit a warning to stderr and update state.
# Do NOT exit non-zero — this would block legitimate Bash calls. The
# warning surfaces in tool output for the user / Claude to see.
cat >&2 <<EOF

╔══════════════════════════════════════════════════════════════════════╗
║  ⚠ BRANCH-INVARIANT DRIFT DETECTED                                   ║
╚══════════════════════════════════════════════════════════════════════╝

  Working tree silently switched branches mid-session.

  Previous branch:  $stored_branch
  Current branch:   $current_branch
  Worktree:         $worktree_path
  Triggering tool:  Bash ($MODE)
  Command:          $(printf '%s' "$command_str" | head -c 120)$([ ${#command_str} -gt 120 ] && echo "...")

  This is the parallel-agent-collision bug class extended to git state.
  Likely causes:
    - Another Claude Code session operated on this repo in parallel
    - A manual git checkout in another terminal
    - A hook side-effect from a different tool invocation

  Action: verify you're on the expected branch BEFORE the next mutation.
  If this drift was intentional (e.g., you switched manually), no action
  is needed; the new branch is now recorded as the invariant.

  State file: $STATE_FILE
  Disable hook: edit .claude/settings.json or rename this script

EOF

write_stored
exit 0
