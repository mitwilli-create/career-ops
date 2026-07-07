#!/usr/bin/env bash
# scripts/safe-dashboard-deploy.sh
#
# Canonical entrypoint for swapping dashboard/index.html on the live server.
# Refuses to proceed if any gate fails. Each gate has a clear exit code so
# callers can branch and so the failure mode is unambiguous in CI/automation.
#
# Usage:
#   bash scripts/safe-dashboard-deploy.sh                       # build from cwd, deploy to ~/Documents/career-ops/dashboard/
#   bash scripts/safe-dashboard-deploy.sh /path/to/worktree     # build from worktree
#   SKIP_CANARY=1 bash scripts/safe-dashboard-deploy.sh         # skip Playwright canary (faster, less safe)
#   SKIP_MARKER_CHECK=1 bash scripts/safe-dashboard-deploy.sh   # skip window.__ marker preservation check
#
# Exit codes:
#   0  Clean deploy.
#   2  Source worktree HEAD is BEHIND origin/main — backward-merge cp aborted.
#   3  Required data files missing (symlinks evaporated, etc.).
#   4  Build failed (compile error) OR file disappeared mid-build OR existing
#      inline-<script> syntax lint failed (lint-built-html-js.mjs).
#   5  Inline-<script> AST walker found unresolved identifier reference
#      (lint-browser-context-refs.mjs).
#   6  Backtick-in-comment lint failed (lint-backtick-in-comment.mjs).
#   7  Load-bearing window.__ data marker missing from new HTML
#      (override with SKIP_MARKER_CHECK=1).
#   8  launchctl bootout/bootstrap cycle failed; server not responding.
#   9  Headless canary found JS errors in served HTML
#      (override with SKIP_CANARY=1).
#
# Hook reference: this script is referenced by name in .git/hooks/pre-commit
# (the dashboard/index.html guard). Renaming this script requires updating the
# hook regex.

set -euo pipefail

# --- args + paths ---
SOURCE_WORKTREE="${1:-$(pwd)}"
SKIP_CANARY="${SKIP_CANARY:-0}"
SKIP_MARKER_CHECK="${SKIP_MARKER_CHECK:-0}"
LIVE_DIR="$HOME/Documents/career-ops/dashboard"
LIVE_HTML="$LIVE_DIR/index.html"
BACKUP_HTML="$LIVE_DIR/index.html.pre-deploy.$(date +%s)"

# Normalize SOURCE_WORKTREE to an absolute path.
SOURCE_WORKTREE=$(cd "$SOURCE_WORKTREE" 2>/dev/null && pwd || echo "$SOURCE_WORKTREE")

if [ ! -d "$SOURCE_WORKTREE" ]; then
  echo "✗ safe-deploy: source worktree does not exist: $SOURCE_WORKTREE"
  exit 1
fi
if [ ! -f "$SOURCE_WORKTREE/scripts/build-dashboard.mjs" ]; then
  echo "✗ safe-deploy: build-dashboard.mjs not found in $SOURCE_WORKTREE"
  exit 1
fi

echo "── safe-dashboard-deploy ──"
echo "  source:    $SOURCE_WORKTREE"
echo "  live:      $LIVE_HTML"
echo "  skip-canary: $SKIP_CANARY"
echo ""

cd "$SOURCE_WORKTREE"

# --- Gate 1: source HEAD at or ahead of origin/main ---
echo "Gate 1/6: source HEAD ≥ origin/main"
git fetch origin main --quiet 2>/dev/null || echo "  WARN: git fetch failed; cannot verify worktree freshness"
SRC_SHA=$(git rev-parse HEAD)
MAIN_SHA=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -z "$MAIN_SHA" ]; then
  echo "  WARN: origin/main not resolvable; gate 1 skipped (offline or no origin)"
elif ! git merge-base --is-ancestor "$MAIN_SHA" HEAD 2>/dev/null; then
  echo "✗ ABORT [exit 2]: source worktree HEAD is BEHIND origin/main"
  echo "    HEAD:        $SRC_SHA"
  echo "    origin/main: $MAIN_SHA"
  echo "    Rebuild from a worktree that includes the missing main commits:"
  echo "      git pull origin main"
  echo "    OR rebase: git rebase origin/main"
  echo "  Bug class: stale-worktree-cp-backward-merge"
  echo "  See AGENTS.md § Bug class: stale-worktree-cp-backward-merge"
  exit 2
fi
echo "  ✓ HEAD $SRC_SHA includes origin/main"

# --- Gate 2 (pre-build): required data files present ---
echo ""
echo "Gate 2/6: required data files (pre-build)"
REQUIRED=(data/applications.md data/apply-now-queue.json reports cv.md article-digest.md)
for f in "${REQUIRED[@]}"; do
  if [ ! -e "$SOURCE_WORKTREE/$f" ]; then
    echo "✗ ABORT [exit 3]: required file missing: $f"
    echo "  In a worktree? Symlink the data dir:"
    echo "    ln -sfn ~/Documents/career-ops/data $SOURCE_WORKTREE/data"
    echo "    ln -sfn ~/Documents/career-ops/reports $SOURCE_WORKTREE/reports"
    echo "    ln -sfn ~/Documents/career-ops/cv.md $SOURCE_WORKTREE/cv.md"
    echo "    ln -sfn ~/Documents/career-ops/article-digest.md $SOURCE_WORKTREE/article-digest.md"
    exit 3
  fi
done
echo "  ✓ all ${#REQUIRED[@]} required files present"

# --- Build ---
echo ""
echo "Build: node scripts/build-dashboard.mjs"
if ! node "$SOURCE_WORKTREE/scripts/build-dashboard.mjs" 2>&1 | sed 's/^/  | /'; then
  echo "✗ ABORT [exit 4]: build failed"
  exit 4
fi

# Re-verify data symlinks survived the build (the contacts-page builder
# occasionally deletes + recreates its target dir; if the symlink target is
# the dir itself, the symlink can become dangling).
echo ""
echo "Gate 2b/6: required data files (post-build, symlink-survival)"
for f in "${REQUIRED[@]}"; do
  if [ ! -e "$SOURCE_WORKTREE/$f" ]; then
    echo "✗ ABORT [exit 4]: file disappeared mid-build: $f"
    echo "  The build step clobbered the symlink. Re-link and retry:"
    echo "    ln -sfn ~/Documents/career-ops/data $SOURCE_WORKTREE/data"
    exit 4
  fi
done
echo "  ✓ all ${#REQUIRED[@]} required files survived build"

# --- Gate 3: extended inline-<script> AST walker ---
echo ""
echo "Gate 3/6: inline-<script> syntax + reference integrity"
# First, run the existing syntax lint (catches outer-template-unescape SyntaxErrors).
if [ -f "$SOURCE_WORKTREE/scripts/lint-built-html-js.mjs" ]; then
  if ! node "$SOURCE_WORKTREE/scripts/lint-built-html-js.mjs" 2>&1 | sed 's/^/  | /'; then
    echo "✗ ABORT [exit 4]: lint-built-html-js failed (inline-<script> SyntaxError)"
    exit 4
  fi
  echo "  ✓ syntax clean"
else
  echo "  WARN: scripts/lint-built-html-js.mjs not present; skipping syntax lint"
fi
# Then, the new AST reference-resolution walker.
if ! node "$SOURCE_WORKTREE/scripts/lint-browser-context-refs.mjs" "$SOURCE_WORKTREE/dashboard/index.html" 2>&1 | sed 's/^/  | /'; then
  echo "✗ ABORT [exit 5]: lint-browser-context-refs failed"
  echo "  Bug class: client-side-reference-to-server-side-import"
  exit 5
fi
echo "  ✓ references resolve"

# --- Gate 4: backtick-in-comment lint ---
echo ""
echo "Gate 4/6: backtick-in-comment lint on source"
if ! node "$SOURCE_WORKTREE/scripts/lint-backtick-in-comment.mjs" "$SOURCE_WORKTREE/scripts/build-dashboard.mjs" 2>&1 | sed 's/^/  | /'; then
  echo "✗ ABORT [exit 6]: lint-backtick-in-comment failed"
  echo "  Bug class: outer-template-unescape § Backtick-in-comment variant"
  exit 6
fi
echo "  ✓ no stray backticks in comments"

# --- Gate 5: regression-marker diff vs currently-served HTML ---
echo ""
echo "Gate 5/6: window.__ marker preservation"
if [ -f "$LIVE_HTML" ] && [ "$SKIP_MARKER_CHECK" != "1" ]; then
  NEW=$(grep -oE "window\.__[A-Z_]+" "$SOURCE_WORKTREE/dashboard/index.html" | sort -u || true)
  OLD=$(grep -oE "window\.__[A-Z_]+" "$LIVE_HTML" | sort -u || true)
  LOST=$(comm -23 <(echo "$OLD") <(echo "$NEW") || true)
  if [ -n "$LOST" ] && [ "$LOST" != "" ]; then
    echo "✗ ABORT [exit 7]: deploy would remove load-bearing data markers from served HTML:"
    echo "$LOST" | sed 's/^/    /'
    echo "  Override with SKIP_MARKER_CHECK=1 if intentional (e.g. removing a deprecated panel)."
    exit 7
  fi
  N_MARKERS=$(echo "$NEW" | grep -c . || true)
  echo "  ✓ all ${N_MARKERS} window.__ markers from live HTML preserved in new build"
else
  echo "  (skipped: no existing live HTML or SKIP_MARKER_CHECK=1)"
fi

# --- Backup + swap ---
echo ""
echo "Swap: backup → cp → restart"
mkdir -p "$LIVE_DIR"
if [ -f "$LIVE_HTML" ]; then
  cp "$LIVE_HTML" "$BACKUP_HTML"
  echo "  ✓ backup written: $BACKUP_HTML"
fi
# When the deploy runs FROM the main repo, build-dashboard.mjs already wrote
# the HTML directly to $LIVE_HTML. `cp X X` errors "identical (not copied)"
# under `set -e` and aborts the deploy BEFORE the restart+canary (silent until
# 2026-06-02). `-ef` = same device+inode, so the self-copy is skipped only when
# source and live are literally the same file; cross-worktree deploys still cp.
if [ "$SOURCE_WORKTREE/dashboard/index.html" -ef "$LIVE_HTML" ]; then
  echo "  (build wrote in place: source path == live path — no self-copy needed)"
else
  cp "$SOURCE_WORKTREE/dashboard/index.html" "$LIVE_HTML"
fi
NEW_SIZE=$(wc -c < "$LIVE_HTML" | tr -d ' ')
echo "  ✓ swapped: $LIVE_HTML (${NEW_SIZE} bytes)"

# --- Restart server (Pattern F: bootout, kill orphans, bootstrap) ---
echo ""
echo "Restart: dashboard-server-nohup-wrapper"
USER_UID=$(id -u)
LABEL="com.mitchell.career-ops.dashboard-server-nohup-wrapper"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl bootout "gui/${USER_UID}/${LABEL}" 2>/dev/null || true
sleep 2
# Pattern F: nohup-wrapped processes detach from launchd; pkill the orphan.
pkill -9 -f dashboard-server.mjs 2>/dev/null || true
sleep 2
if [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/${USER_UID}" "$PLIST" 2>&1 | sed 's/^/  | /' || true
  sleep 5
else
  echo "  WARN: plist not found at $PLIST; cannot bootstrap"
fi

# Verify server up; retry once with a longer wait. This is a LOCAL post-restart
# check of the server this script just bootstrapped, so localhost is the correct
# default; DASHBOARD_LOCAL_URL overrides for non-standard ports.
DASH_LOCAL="${DASHBOARD_LOCAL_URL:-http://localhost:3097}"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${DASH_LOCAL}/" || echo "000")
if [ "$HTTP" != "200" ]; then
  echo "  WARN: server HTTP $HTTP after bootstrap; retrying after 5s..."
  sleep 5
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${DASH_LOCAL}/" || echo "000")
fi
if [ "$HTTP" != "200" ]; then
  echo "✗ ABORT [exit 8]: dashboard server not responding after restart (HTTP $HTTP)"
  echo "  Backup at: $BACKUP_HTML"
  echo "  Manual rollback:"
  echo "    cp $BACKUP_HTML $LIVE_HTML"
  echo "    pkill -9 -f dashboard-server.mjs"
  echo "    launchctl bootstrap gui/${USER_UID} $PLIST"
  exit 8
fi
SERVER_PID=$(pgrep -f dashboard-server.mjs | head -1 || echo "?")
echo "  ✓ server HTTP 200 (PID $SERVER_PID)"

# --- Gate 6: headless canary ---
echo ""
echo "Gate 6/6: headless canary (Playwright)"
if [ "$SKIP_CANARY" = "1" ]; then
  echo "  (skipped: SKIP_CANARY=1)"
else
  if ! node "$SOURCE_WORKTREE/scripts/dashboard-headless-canary.mjs" 2>&1 | sed 's/^/  | /'; then
    echo "✗ ABORT [exit 9]: headless canary found JS errors in served HTML"
    echo "  Backup at: $BACKUP_HTML"
    echo "  Recommended rollback:"
    echo "    cp $BACKUP_HTML $LIVE_HTML"
    echo "    pkill -9 -f dashboard-server.mjs"
    echo "    launchctl bootstrap gui/${USER_UID} $PLIST"
    exit 9
  fi
fi

# --- success ---
echo ""
echo "✓ Deploy clean."
echo "  Source HEAD: $SRC_SHA"
echo "  Backup:      $BACKUP_HTML"
echo "  Server PID:  $SERVER_PID"
echo "  HTML size:   $NEW_SIZE bytes"
exit 0
