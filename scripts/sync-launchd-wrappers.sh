#!/bin/bash
# scripts/sync-launchd-wrappers.sh
#
# Copies the version-tracked launchd wrapper scripts from scripts/launchd/
# into the live ~/.local/career-ops-wrappers/ runtime location that the
# plists actually point at.
#
# Why this exists:
#   macOS Tahoe (and 26.x) TCC blocks /bin/bash spawned by launchd from
#   exec'ing scripts under ~/Documents/. So the live wrapper scripts must
#   live OUTSIDE the repo (in ~/.local/career-ops-wrappers/) — but we still
#   want the repo to be the spec / source of truth for version tracking.
#   Empirically verified 2026-05-25: live path = repo → exit 126; live
#   path = .local/ → exit 0.
#
# Usage:
#   bash scripts/sync-launchd-wrappers.sh           # default sync (no plist reload)
#   bash scripts/sync-launchd-wrappers.sh --reload  # sync + bootout/bootstrap each wrapper plist
#   bash scripts/sync-launchd-wrappers.sh --check   # diff repo vs .local/, exit 1 on drift
#
# Idempotent. Safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${REPO_DIR}/scripts/launchd"
LIVE_DIR="${HOME}/.local/career-ops-wrappers"
PLIST_LIVE_DIR="${HOME}/Library/LaunchAgents"

# List of wrapper scripts to sync. Add more as new wrappers ship.
WRAPPERS=(
  "dashboard-server-nohup.sh"
)

mode="${1:-sync}"

if [[ "$mode" == "--check" ]]; then
  drift=0
  for w in "${WRAPPERS[@]}"; do
    if ! diff -q "${SRC_DIR}/${w}" "${LIVE_DIR}/${w}" >/dev/null 2>&1; then
      echo "DRIFT: ${w} differs between repo and ${LIVE_DIR}/"
      drift=1
    else
      echo "OK:    ${w}"
    fi
  done
  exit $drift
fi

mkdir -p "${LIVE_DIR}"

for w in "${WRAPPERS[@]}"; do
  src="${SRC_DIR}/${w}"
  dst="${LIVE_DIR}/${w}"
  if [[ ! -f "$src" ]]; then
    echo "skip: ${src} not found"
    continue
  fi
  if diff -q "$src" "$dst" >/dev/null 2>&1; then
    echo "OK:    ${w} (already in sync)"
    continue
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "✓ synced: ${w} → ${dst}"
done

if [[ "$mode" == "--reload" ]]; then
  echo ""
  echo "=== Reloading wrapper plists ==="
  for w in "${WRAPPERS[@]}"; do
    # Convention: wrapper-script <name>-nohup.sh pairs with plist
    # com.mitchell.career-ops.<base>-nohup-wrapper.plist.
    base="${w%-nohup.sh}"
    label="com.mitchell.career-ops.${base}-nohup-wrapper"
    plist="${PLIST_LIVE_DIR}/${label}.plist"
    if [[ ! -f "$plist" ]]; then
      echo "skip: no plist at ${plist}"
      continue
    fi
    launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "✓ reloaded: ${label}"
  done
fi
