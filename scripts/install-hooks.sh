#!/usr/bin/env bash
# scripts/install-hooks.sh — install git hooks for career-ops.
#
# Copies tracked hook scripts from scripts/hooks/ into .git/hooks/
# so every developer/agent in this repo gets the same safety gates.
#
# Usage:
#   bash scripts/install-hooks.sh
#
# Re-run after cloning or after adding new hooks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_SRC="$SCRIPT_DIR/hooks"
# Worktree-safe: in a linked worktree .git is a FILE and hooks live under the
# shared git dir — resolve via git itself (as install-git-hooks.sh does).
GIT_HOOKS="$(cd "$REPO_ROOT" && git rev-parse --git-path hooks 2>/dev/null || echo "$REPO_ROOT/.git/hooks")"
# --git-path can return a relative path; anchor it to the repo root.
case "$GIT_HOOKS" in
  /*) ;;
  *) GIT_HOOKS="$REPO_ROOT/$GIT_HOOKS" ;;
esac

if [[ ! -d "$GIT_HOOKS" ]]; then
  mkdir -p "$GIT_HOOKS" 2>/dev/null || {
    echo "ERROR: $GIT_HOOKS not found and could not be created — are you in a git repo?" >&2
    exit 1
  }
fi

if [[ ! -d "$HOOKS_SRC" ]]; then
  echo "ERROR: $HOOKS_SRC not found — nothing to install." >&2
  exit 1
fi

installed=0
for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  dest="$GIT_HOOKS/$name"
  cp "$hook" "$dest"
  chmod +x "$dest"
  echo "  installed: $dest"
  ((installed++)) || true
done

echo ""
echo "Done — $installed hook(s) installed to $GIT_HOOKS"
echo "Hooks in scripts/hooks/ are tracked in git; this script syncs them."
