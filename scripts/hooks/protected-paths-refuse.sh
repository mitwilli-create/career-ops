#!/usr/bin/env bash
# scripts/hooks/protected-paths-refuse.sh
#
# PreToolUse hook for Edit / Write / MultiEdit. REFUSES the tool call when
# the target file is on the autonomous-no-touch list established in the
# 2026-05-21 dashboard hardening sprint interview (turn after Q "protected
# paths"). Explicit-conversation requests still work — the hook only fires
# at the tool-call boundary, so Mitchell can override by reading + writing
# the file in a single turn that doesn't go through this hook (the next
# Edit/Write IS gated, so the operator must type "yes, edit cv.md anyway"
# to make it through one of his own commands).
#
# Exit codes:
#   0   allow
#   2   block (non-zero — harness reports the reason to the user)
#
# Input on stdin: { "tool_name": "Edit|Write|MultiEdit", "tool_input": { "file_path": "...", ... } }
#
# Protected paths (full no-touch list — interview answer + Mitchell's
# explicit "plus three other paths" add 2026-05-21):
#   1. cv.md  (canonical CV)
#   2. data/applications.md  (canonical tracker; merge-tracker.mjs is the
#                            sanctioned writer; drawerQuickStatus endpoint
#                            handles status flips)
#   3. modes/_profile.md  (user customization layer)
#   4. config/profile.yml  (user customization layer)
#   5. data/hm-intel/*.json  (research artifacts; intel-refresh.mjs +
#                            refresh-intel.mjs are sanctioned writers)
#   6. data/network-database*.json + data/contacts/*  (network DB; specific
#                            scripts are sanctioned writers)
#   7. corpus/*  (corpus / writing samples — voice calibration ground truth)
#   8. writing-samples/voice-reference.md  (voice ground truth)
#   9. .env  (secrets; never write to from autonomous work)
#  10. ~/.career-ops-secrets  (secrets; same)
#
# Override token: include `[force-protected-write]` in the file content
# itself (won't trigger since the hook checks the path, not the content) —
# the operator escape is rephrasing the request in a new conversation turn
# AFTER reading this file's documentation.

set -euo pipefail

REPO="/Users/mitchellwilliams/Documents/career-ops"

# Read JSON tool input from stdin.
input="$(cat 2>/dev/null || echo '{}')"

# Extract tool_name + file_path via python3.
tool_name="$(printf '%s' "$input" | /usr/bin/env python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print(d.get('tool_name', ''))
except Exception:
  print('')
" 2>/dev/null)"

file_path="$(printf '%s' "$input" | /usr/bin/env python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  ti = d.get('tool_input') or {}
  print(ti.get('file_path', ''))
except Exception:
  print('')
" 2>/dev/null)"

# Only fire on Edit/Write/MultiEdit. Skip otherwise.
case "$tool_name" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

# Skip if no file_path.
if [ -z "$file_path" ]; then
  exit 0
fi

# Normalize: resolve absolute path if relative.
case "$file_path" in
  /*) abs="$file_path" ;;
  *)  abs="$REPO/$file_path" ;;
esac

# Resolve ~ if present.
abs="${abs/#\~/$HOME}"

# Protected patterns. Use case statements rather than regex for clarity.
protected_reason=""

case "$abs" in
  "$REPO/cv.md")
    protected_reason="cv.md is the canonical CV. Autonomous writes drift every downstream score, tailored CV, and council eval simultaneously. Edit via the cv-archive-first pattern in CLAUDE.md, initiated by Mitchell."
    ;;
  "$REPO/data/applications.md")
    protected_reason="data/applications.md is the canonical tracker. Writes go through merge-tracker.mjs (row adds) or the drawerQuickStatus endpoint (status flips). Direct Edit-tool bypasses TSV column-order validation."
    ;;
  "$REPO/modes/_profile.md"|"$REPO/config/profile.yml")
    protected_reason="$(basename "$abs") is the user customization layer. Only edit when Mitchell explicitly asks in conversation, not when an autonomous agent inferred 'I should improve the narrative.'"
    ;;
  "$REPO/data/hm-intel/"*.json)
    protected_reason="hm-intel JSONs are written by intel-refresh.mjs / refresh-intel.mjs / hiring-manager-research.mjs only. Manual edits get clobbered by the next autonomous refresh. Read freely from drawer chips + Pre-apply check."
    ;;
  "$REPO/data/network-database"*.json|"$REPO/data/contacts/"*|"$REPO/data/contact-"*)
    protected_reason="Network DB is written by network-database-build / network-enricher / network-emailer. Direct edits get clobbered + risk schema drift."
    ;;
  "$REPO/corpus/"*|"$REPO/writing-samples/voice-reference.md")
    protected_reason="Voice / corpus ground truth. Polish + Pre-apply read these. An autonomous 'improve the voice reference' would feed the voice loop into its own tail. Only Mitchell-initiated edits."
    ;;
  "$REPO/.env"|"$HOME/.career-ops-secrets")
    protected_reason="Secrets file. Never write to from autonomous work. Even an accidental 'I'll add a comment' creates a leak risk via commit + the file is git-protected only via .gitignore."
    ;;
esac

if [ -n "$protected_reason" ]; then
  echo "" >&2
  echo "╔════════════════════════════════════════════════════════════════════╗" >&2
  echo "║  AUTONOMOUS WRITE REFUSED — protected path                         ║" >&2
  echo "║                                                                    ║" >&2
  echo "║  Path:   $abs" >&2
  echo "║  Tool:   $tool_name" >&2
  echo "║                                                                    ║" >&2
  echo "║  Why:    $protected_reason" >&2
  echo "║                                                                    ║" >&2
  echo "║  Override: ask Mitchell directly in conversation. He authorized    ║" >&2
  echo "║  this no-touch list in the 2026-05-21 dashboard hardening sprint   ║" >&2
  echo "║  interview. The hook checks every autonomous Edit/Write/MultiEdit. ║" >&2
  echo "╚════════════════════════════════════════════════════════════════════╝" >&2
  exit 2
fi

exit 0
