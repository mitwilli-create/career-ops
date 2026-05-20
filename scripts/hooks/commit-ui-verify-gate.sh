#!/usr/bin/env bash
# scripts/hooks/commit-ui-verify-gate.sh
#
# PreToolUse hook for Bash commands that look like `git commit`. Blocks the
# commit when UI-affecting files are staged AND the commit message lacks a
# screenshot/audit reference. Override flag: include `[skip-ui-verify]`
# anywhere in the message.
#
# Established 2026-05-20 (P2.18 of resolution-pass) — upgrades the existing
# PostToolUse reminder (ui-edit-verify-reminder.sh) to a hard gate at the
# commit boundary. See CLAUDE.md / AGENTS.md "UI-Change Verification" for
# the rule + the 2026-05-19 role-column-collapse incident that drove it.
#
# Exit codes:
#   0   allow
#   2   block (non-zero → harness reports to user)
#
# Input on stdin is JSON: { "tool_name": "Bash", "tool_input": { "command": "...", ... } }

set -euo pipefail

REPO="/Users/mitchellwilliams/Documents/career-ops"
cd "$REPO" || exit 0  # If we can't even cd to the repo, don't block.

# Read JSON tool input from stdin.
input="$(cat 2>/dev/null || echo '{}')"

# Extract the command string via python3 (jq not guaranteed in launchd path).
command_str="$(printf '%s' "$input" | /usr/bin/env python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print((d.get('tool_input') or {}).get('command', ''))
except Exception:
  print('')
" 2>/dev/null)"

# Only fire on git commit commands. Skip otherwise.
case "$command_str" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# Skip if the commit uses --no-verify (user already opted out).
if echo "$command_str" | grep -qE -- '--no-verify'; then
  exit 0
fi

# Skip if the user passed the override token in the message.
if echo "$command_str" | grep -q '\[skip-ui-verify\]'; then
  exit 0
fi

# Get staged files WITH status codes so we can distinguish add/modify/rename
# (which can change rendering) from delete (which cannot — the file is just
# removed from the index, on-disk content and the running build are untouched).
#
# `git diff --cached --name-status` output shapes:
#   A\tpath              — added
#   M\tpath              — modified
#   T\tpath              — type changed
#   D\tpath              — deleted   ← skip; index-only removal can't change render
#   R{score}\told\tnew   — renamed   ← check the NEW path (treated as modify)
#   C{score}\tsrc\tdst   — copied    ← check the destination
#
# Test cases (see .claude/audit/hook-patch-deletion-skip-*/notes.md):
#   1. `git rm --cached dashboard/contacts.html && git commit`        → SKIP (deletion only)
#   2. `Edit dashboard/contacts.html && git add && git commit`        → BLOCK (modification)
#   3. Mixed: edit one UI file + rm --cached another UI file          → BLOCK (M wins)
staged_status="$(git -C "$REPO" diff --cached --name-status 2>/dev/null || true)"
if [ -z "$staged_status" ]; then
  exit 0
fi

# Extract destination paths only for statuses that can change rendering.
staged_render_paths=$(echo "$staged_status" | awk -F'\t' '
  $1 == "A" || $1 == "M" || $1 == "T" { print $2 }
  $1 ~ /^R/ || $1 ~ /^C/ { print $3 }
')

if [ -z "$staged_render_paths" ]; then
  # Only deletions (or non-render-affecting statuses) staged. Allow.
  exit 0
fi

# UI-affecting file patterns. Matches CLAUDE.md / AGENTS.md "UI-Change
# Verification" trigger list:
#   - scripts/build-dashboard.mjs / dashboard-server.mjs
#   - anything under dashboard/
#   - *.html / *.css
#   - render-time lib/*.mjs files (the ones that produce DOM)
#   - templates/*.mjml (heartbeat email render path)
ui_affecting=$(echo "$staged_render_paths" | grep -E '^(scripts/build-dashboard\.mjs|scripts/build-contacts-page\.mjs|dashboard-server\.mjs|dashboard/|.*\.html$|.*\.css$|templates/.*\.mjml$|lib/dashboard-shell\.mjs|lib/.*-renderer\.mjs)' || true)

if [ -z "$ui_affecting" ]; then
  # No UI-affecting files staged with add/modify/rename status — allow.
  exit 0
fi

# UI files staged. Now check: does the command reference .claude/audit/?
# This catches:
#   * inline `Screenshots: .claude/audit/...` lines (the convention)
#   * HEREDOC commit messages (which embed the audit path in the body)
if echo "$command_str" | grep -qE '\.claude/audit/'; then
  exit 0
fi

# BLOCK.
{
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════════╗"
  echo "║  COMMIT BLOCKED — UI-affecting files staged without audit reference  ║"
  echo "╚══════════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Staged UI-affecting files:"
  echo "$ui_affecting" | sed 's/^/  - /'
  echo ""
  echo "Required: a .claude/audit/<task>-<date>/ path referenced in the commit"
  echo "message (typically as 'Screenshots: .claude/audit/...')."
  echo ""
  echo "Why: CLAUDE.md UI-Change Verification rule. The 2026-05-19 role-column-"
  echo "collapse incident shipped three CSS fixes that 'looked right in source'"
  echo "but rendered as 0-width columns. Chrome MCP screenshots at two widths"
  echo "are the ship gate."
  echo ""
  echo "Fixes:"
  echo "  1. Take Chrome MCP screenshots at 1440×900 + 375×812"
  echo "  2. Save to .claude/audit/<task>-<date>/notes.md (or similar)"
  echo "  3. Reference that path in the commit message"
  echo ""
  echo "Emergency bypass:"
  echo "  Include [skip-ui-verify] in the commit message OR pass --no-verify."
  echo "  Document why in the commit body."
} >&2

exit 2
