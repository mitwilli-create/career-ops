#!/usr/bin/env bash
# Install career-ops git hooks into the local .git/hooks/ directory.
#
# Hooks managed by this installer:
#   - pre-commit  → WARN-mode ledger-enforcer (see scripts/git-hooks/pre-commit
#                   + .claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md
#                   § Step 6)
#
# This installer is idempotent — running it twice does no harm. It preserves
# any existing hook by renaming to .bak before overwriting (one-level backup).
#
# Usage:
#   bash scripts/install-git-hooks.sh
#
# Verification after install:
#   ls -l .git/hooks/pre-commit         # symlink or copy + +x
#   node scripts/ledger-enforcer.mjs --help

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "install-git-hooks: not inside a git repo" >&2
  exit 1
fi

# Resolve actual hooks dir (worktrees have hooks under the main .git dir).
HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks)"
if [ -z "$HOOKS_DIR" ] || [ ! -d "$HOOKS_DIR" ]; then
  echo "install-git-hooks: could not resolve hooks dir (got: $HOOKS_DIR)" >&2
  exit 1
fi

TEMPLATES_DIR="$REPO_ROOT/scripts/git-hooks"
if [ ! -d "$TEMPLATES_DIR" ]; then
  echo "install-git-hooks: templates dir missing at $TEMPLATES_DIR" >&2
  exit 1
fi

install_one() {
  local name="$1"
  local src="$TEMPLATES_DIR/$name"
  local dst="$HOOKS_DIR/$name"
  if [ ! -f "$src" ]; then
    echo "install-git-hooks: no template for $name (looked at $src)" >&2
    return 1
  fi
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    echo "install-git-hooks: backing up existing $name to $dst.bak"
    cp -p "$dst" "$dst.bak"
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "install-git-hooks: installed $name → $dst"
}

install_one pre-commit

echo ""
echo "Hooks installed. Verify with: node scripts/ledger-enforcer.mjs --help"
echo "To uninstall a hook, simply: rm $HOOKS_DIR/<hook-name>"
