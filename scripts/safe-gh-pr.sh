#!/usr/bin/env bash
# scripts/safe-gh-pr.sh — `gh pr create` wrapper that REFUSES to default to upstream.
#
# Why this exists:
#   The 2026-05-20 cross-fork leak (santifer/career-ops#703) happened because
#   `gh pr create` defaults to the upstream remote in a fork unless --repo is
#   passed. Nine personal-data files briefly surfaced in a PR against the
#   public upstream before being closed. The pre-push hook + gh repo default
#   together close that gap, but every CLI invocation should also pin --repo
#   explicitly as a second belt-and-suspenders layer.
#
# Usage:
#   scripts/safe-gh-pr.sh --title "..." --body "..."
#   scripts/safe-gh-pr.sh --title "..." --body-file body.md --draft
#
# The wrapper:
#   1. Refuses if the gh CLI is not installed.
#   2. Refuses if no `gh repo set-default` has been run (defensive — should be
#      mitwilli-create/career-ops on every clone).
#   3. Refuses if the gh default is santifer/career-ops.
#   4. Forces `--repo mitwilli-create/career-ops` on every invocation.
#
# Bypass (only in emergencies, document in commit message + tell Mitchell):
#   gh pr create --repo mitwilli-create/career-ops <args>     # call gh directly
#
# See AGENTS.md "PR safety" + .git/hooks/pre-push for the related gates.
set -euo pipefail

SAFE_REPO="mitwilli-create/career-ops"

if ! command -v gh >/dev/null 2>&1; then
  echo "[safe-gh-pr] ERROR: gh CLI not found in PATH." >&2
  echo "[safe-gh-pr]   Install via: brew install gh" >&2
  exit 1
fi

# What does gh think the default repo is for THIS clone? `gh repo set-default
# --view` prints the current default; absence means unset.
default_repo=""
if default_repo="$(gh repo set-default --view 2>/dev/null)"; then
  : # got it
else
  echo "[safe-gh-pr] ERROR: no gh default repo set for this clone." >&2
  echo "[safe-gh-pr]   Fix: gh repo set-default $SAFE_REPO" >&2
  echo "[safe-gh-pr]   Then re-run." >&2
  exit 1
fi

if echo "$default_repo" | grep -qiE 'santifer/career-ops'; then
  echo "" >&2
  echo "╔════════════════════════════════════════════════════════════════════╗" >&2
  echo "║  REFUSING — gh default is the SANTIFER upstream                    ║" >&2
  echo "║  Default: $default_repo" >&2
  echo "║  Fix:    gh repo set-default $SAFE_REPO" >&2
  echo "║  This wrapper exists BECAUSE of the 2026-05-20 cross-fork leak.    ║" >&2
  echo "╚════════════════════════════════════════════════════════════════════╝" >&2
  exit 1
fi

if ! echo "$default_repo" | grep -qiE "mitwilli-create/career-ops"; then
  echo "[safe-gh-pr] WARNING: gh default ($default_repo) is not the expected $SAFE_REPO." >&2
  echo "[safe-gh-pr]   Forcing --repo $SAFE_REPO anyway." >&2
fi

# Forward all args + force --repo mitwilli-create/career-ops.
# If the caller already passed --repo, gh will surface a duplicate-flag error
# (good — visible failure beats silent wrong-target).
echo "[safe-gh-pr] gh pr create --repo $SAFE_REPO $*" >&2
exec gh pr create --repo "$SAFE_REPO" "$@"
