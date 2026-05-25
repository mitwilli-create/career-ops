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
#   scripts/safe-gh-pr.sh --auto-merge-after-ci --title "..." --body "..."  # v2 (2026-05-25)
#
# The wrapper:
#   1. Refuses if the gh CLI is not installed.
#   2. Refuses if no `gh repo set-default` has been run (defensive — should be
#      mitwilli-create/career-ops on every clone).
#   3. Refuses if the gh default is santifer/career-ops.
#   4. Forces `--repo mitwilli-create/career-ops` on every invocation.
#   5. v2: optional --auto-merge-after-ci flag — after the PR is created,
#      runs `gh pr merge --auto --squash` so CI green auto-merges the PR.
#      Callers must do their own sensitive-path gating BEFORE passing this
#      flag (see lib/bug-resolver/draft-pr.mjs for the canonical check).
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

# v2 (2026-05-25): pluck --auto-merge-after-ci out of the args before
# forwarding everything else to `gh pr create`. The flag is wrapper-private —
# gh itself doesn't understand it.
AUTO_MERGE_AFTER_CI=0
FILTERED_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--auto-merge-after-ci" ]; then
    AUTO_MERGE_AFTER_CI=1
  else
    FILTERED_ARGS+=("$arg")
  fi
done

# Forward all args + force --repo mitwilli-create/career-ops.
# If the caller already passed --repo, gh will surface a duplicate-flag error
# (good — visible failure beats silent wrong-target).
echo "[safe-gh-pr] gh pr create --repo $SAFE_REPO ${FILTERED_ARGS[*]+${FILTERED_ARGS[*]}}" >&2

if [ "$AUTO_MERGE_AFTER_CI" = "0" ]; then
  # Legacy path: just exec gh pr create, no auto-merge follow-up.
  exec gh pr create --repo "$SAFE_REPO" "${FILTERED_ARGS[@]}"
fi

# v2 auto-merge path: capture gh's output so we can extract the PR URL,
# then chain into `gh pr merge --auto --squash`. Cannot use exec here —
# we need control flow to survive past the create call.
#
# Note: `gh pr create` writes the URL to stdout. We tee it back to our own
# stdout so callers (lib/bug-resolver/draft-pr.mjs) can still parse it the
# same way as the legacy path.
gh_create_out=$(gh pr create --repo "$SAFE_REPO" "${FILTERED_ARGS[@]}")
gh_create_exit=$?
echo "$gh_create_out"

if [ "$gh_create_exit" != "0" ]; then
  echo "[safe-gh-pr] gh pr create failed with exit $gh_create_exit; skipping auto-merge" >&2
  exit "$gh_create_exit"
fi

pr_url=$(echo "$gh_create_out" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
if [ -z "$pr_url" ]; then
  echo "[safe-gh-pr] WARN: --auto-merge-after-ci set but could not parse PR URL from gh output; PR stays DRAFT-only" >&2
  exit 0
fi

echo "[safe-gh-pr] enabling auto-merge on $pr_url" >&2
# --squash is the project's standard merge style. --auto waits for required
# status checks (CI green) before actually merging — gh blocks the merge
# until then, so this is safe to fire-and-forget.
gh pr merge "$pr_url" --auto --squash --repo "$SAFE_REPO"
