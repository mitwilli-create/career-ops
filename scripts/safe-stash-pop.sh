#!/usr/bin/env bash
# scripts/safe-stash-pop.sh — `git stash pop` wrapper that refuses to apply
# a stash if the current branch differs from the stash's origin branch.
#
# Why this exists (closes bug-2026-05-25-043):
#   git stash records the branch the stash was taken from in the stash
#   header ("WIP on <branch>" or "On <branch>"). After a concurrent-instance
#   session, the shared working tree's branch may have moved between
#   stash-push and stash-pop. Popping onto the wrong branch silently
#   merges the WIP into unrelated state and produces a confusing diff
#   the operator has to untangle by hand.
#
#   This wrapper extracts the origin branch from `git stash show <ref>`,
#   compares it against the current branch, and refuses on mismatch
#   unless explicit --force is passed. On match (or --force), it delegates
#   to `git stash pop <ref>`.
#
# Usage:
#   scripts/safe-stash-pop.sh                       # pops stash@{0} after branch check
#   scripts/safe-stash-pop.sh stash@{2}             # pops a specific stash
#   scripts/safe-stash-pop.sh --force               # bypass check, pop stash@{0}
#   scripts/safe-stash-pop.sh --force stash@{3}     # bypass check, pop specific stash
#   scripts/safe-stash-pop.sh --check               # check stash@{0} only, exit 1 on mismatch
#
# Exit codes:
#   0 = pop succeeded (or --check passed)
#   1 = branch mismatch refused (run with --force to override)
#   2 = no stash or invalid ref
#   3 = pop succeeded but had conflicts (git pop reported them)

set -uo pipefail

FORCE=0
CHECK_ONLY=0
STASH_REF=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    stash@*) STASH_REF="$arg" ;;
    *)
      echo "[safe-stash-pop] unknown arg: $arg" >&2
      echo "[safe-stash-pop] usage: $0 [--force] [--check] [stash@{N}]" >&2
      exit 2
      ;;
  esac
done

STASH_REF="${STASH_REF:-stash@{0}}"

if ! git stash show "$STASH_REF" >/dev/null 2>&1; then
  echo "[safe-stash-pop] no such stash: $STASH_REF" >&2
  exit 2
fi

# Extract origin branch from stash header. Format examples:
#   "stash@{0}: On main: hotfix WIP"
#   "stash@{0}: WIP on feat/foo: a1b2c3d initial commit"
#   "stash@{0}: On feat/bar: my-tag-name some description"
STASH_LINE=$(git stash list | grep -F "$STASH_REF:" | head -1)
if [ -z "$STASH_LINE" ]; then
  echo "[safe-stash-pop] could not read stash header for $STASH_REF" >&2
  exit 2
fi

# Capture "On <branch>" or "WIP on <branch>" — branch ends at the next ":".
STASH_BRANCH=$(echo "$STASH_LINE" | sed -nE 's/^stash@\{[0-9]+\}: (WIP )?[Oo]n ([^:]+):.*$/\2/p')
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ -z "$STASH_BRANCH" ] || [ -z "$CURRENT_BRANCH" ]; then
  echo "[safe-stash-pop] could not parse branch context" >&2
  echo "[safe-stash-pop]   stash header: $STASH_LINE" >&2
  echo "[safe-stash-pop]   current HEAD: $(git rev-parse HEAD 2>/dev/null)" >&2
  exit 2
fi

echo "[safe-stash-pop] stash branch: $STASH_BRANCH"
echo "[safe-stash-pop] current branch: $CURRENT_BRANCH"

if [ "$STASH_BRANCH" != "$CURRENT_BRANCH" ] && [ "$FORCE" != "1" ]; then
  echo "" >&2
  echo "╔════════════════════════════════════════════════════════════════════╗" >&2
  echo "║  REFUSING — branch mismatch                                        ║" >&2
  echo "║  Stash was taken on: $STASH_BRANCH" >&2
  echo "║  Current HEAD:       $CURRENT_BRANCH" >&2
  echo "║                                                                    ║" >&2
  echo "║  Options:                                                          ║" >&2
  echo "║    1. Switch to the stash's origin branch + retry:                 ║" >&2
  echo "║         git checkout '$STASH_BRANCH'                                " >&2
  echo "║         scripts/safe-stash-pop.sh $STASH_REF                       ║" >&2
  echo "║    2. Force the pop anyway (knowing it merges into current state): ║" >&2
  echo "║         scripts/safe-stash-pop.sh --force $STASH_REF               ║" >&2
  echo "╚════════════════════════════════════════════════════════════════════╝" >&2
  exit 1
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo "[safe-stash-pop] branch match — pop would be safe (--check, no action taken)"
  exit 0
fi

if [ "$STASH_BRANCH" != "$CURRENT_BRANCH" ] && [ "$FORCE" = "1" ]; then
  echo "[safe-stash-pop] WARNING: --force overriding branch-mismatch check"
fi

echo "[safe-stash-pop] popping $STASH_REF onto $CURRENT_BRANCH..."
if git stash pop "$STASH_REF"; then
  echo "[safe-stash-pop] pop succeeded"
  exit 0
else
  rc=$?
  echo "[safe-stash-pop] pop reported conflicts or errors (git exit $rc)" >&2
  echo "[safe-stash-pop]   resolve conflicts, then 'git stash drop $STASH_REF' once you're satisfied" >&2
  exit 3
fi
