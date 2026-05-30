#!/usr/bin/env bash
# scripts/deploy/install-wrappers.sh
#
# Deploys the launchd bash wrappers from this repo into ~/.local/career-ops-wrappers/.
# Required ANY time scripts/wrappers/*.sh changes OR on a fresh clone.
#
# Why this exists (Tahoe TCC):
#   macOS Tahoe (25.x) launchd TCC profile blocks EXECUTING bash scripts
#   located under ~/Documents/, even with chmod +x. Symptom: exit 126 +
#   "Operation not permitted" in the plist's StandardErrorPath. The five
#   career-ops plists that use scripts/wrappers/cron-run.sh point at
#   ~/.local/career-ops-wrappers/cron-run.sh instead. This script keeps
#   that deployed copy in sync with the repo source.
#
#   The companion wrappers dashboard-server-nohup.sh + cloudflared-nohup.sh
#   already live at ~/.local/career-ops-wrappers/ from an earlier deploy
#   and use the same pattern.
#
# Usage:
#   bash scripts/deploy/install-wrappers.sh
#
# Idempotent — safe to re-run any time. Validates each copy via diff after
# install. Exits non-zero if any copy fails verification.
#
# See AGENTS.md § Bug class: tahoe-tcc-blocks-launchd-exec-from-documents

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$REPO_ROOT/scripts/wrappers"
DST_DIR="$HOME/.local/career-ops-wrappers"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: source wrappers dir not found at $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DST_DIR"

# Wrappers to deploy. Add to this list if a new launchd-spawned bash wrapper
# is created under scripts/wrappers/.
#
# Note: scripts/launchd/dashboard-server-nohup.sh + cloudflared-nohup.sh are
# legacy in-repo sources for already-deployed wrappers. This script does NOT
# manage them — the deployed copies at ~/.local/career-ops-wrappers/ are
# the canonical versions, edited in place. Consolidate them under
# scripts/wrappers/ when next touched.
WRAPPERS=(
  "cron-run.sh"
  "cloudflared-staging-nohup.sh"
)

failures=0
for w in "${WRAPPERS[@]}"; do
  src="$SRC_DIR/$w"
  dst="$DST_DIR/$w"

  if [[ ! -f "$src" ]]; then
    echo "  ✗ missing source: $src" >&2
    failures=$((failures + 1))
    continue
  fi

  # Copy + chmod +x. Then patch REPO to hardcoded path (since the deployed
  # wrapper lives outside the repo, $(cd $(dirname $0)/../..) would resolve
  # to ~/.local/ — wrong). Hardcoding REPO is intentional for the deployed
  # copy. The source at scripts/wrappers/ keeps the dynamic resolution for
  # any in-repo CLI invocation.
  cp "$src" "$dst"
  chmod +x "$dst"

  if [[ "$w" == "cron-run.sh" ]]; then
    # POSIX-portable in-place sed (BSD/macOS compatible)
    sed -i.bak 's|^REPO="\$(cd .*$|REPO="'"$REPO_ROOT"'"  # hardcoded by scripts/deploy/install-wrappers.sh — see AGENTS.md tahoe-tcc bug class|' "$dst"
    rm -f "$dst.bak"
  fi

  # Verify the deployed file is non-trivially different from the source
  # ONLY by virtue of REPO being hardcoded. If any OTHER lines differ, flag.
  src_normalized=$(grep -v '^REPO=' "$src")
  dst_normalized=$(grep -v '^REPO=' "$dst")
  if [[ "$src_normalized" != "$dst_normalized" ]] && [[ "$w" == "cron-run.sh" ]]; then
    echo "  ✗ $w: copy differs from source beyond REPO hardcoding"
    failures=$((failures + 1))
  elif [[ "$src_normalized" != "$dst_normalized" ]]; then
    # Non-cron-run wrappers don't get REPO patched; copy must be exact
    echo "  ✗ $w: copy differs from source"
    failures=$((failures + 1))
  else
    echo "  ✓ $w deployed → $dst"
  fi
done

if [[ $failures -gt 0 ]]; then
  echo ""
  echo "ERROR: $failures wrapper(s) failed to deploy or verify" >&2
  exit 1
fi

echo ""
echo "All wrappers deployed to $DST_DIR"
echo ""
echo "Next steps:"
echo "  1. Verify launchd can execute them:"
echo "       launchctl kickstart -k gui/\$(id -u)/com.mitchell.career-ops.network-database-build"
echo "  2. Check exit code (should be 0):"
echo "       launchctl print gui/\$(id -u)/com.mitchell.career-ops.network-database-build | grep 'last exit'"
echo "  3. If exit 126 or 'Operation not permitted' → debug per AGENTS.md tahoe-tcc bug class"
