#!/bin/bash
# dashboard-server-nohup.sh
#
# Boot-time + 5-min-tick wrapper that `nohup`s the dashboard-server out-of-band
# from launchd. Workaround for the macOS Tahoe (15.x) launchd KeepAlive=true
# regression where the spawned process exits with code 78 (EX_CONFIG) within
# milliseconds, before Node.js can even print to stdout. Pattern documented in
# ~/.claude/knowledge/brain/bug-class-catalog.md § Pattern F (launchd-keepalive-tahoe).
#
# Pairs with com.mitchell.career-ops.dashboard-server-nohup-wrapper.plist
# (RunAtLoad=true, KeepAlive=false, StartInterval=300). The wrapper plist fires
# this script at boot/login + every 5 minutes; this script `nohup`s
# dashboard-server.mjs into a detached session, then exits 0. The 5-minute
# interval is the recovery cadence if the daemon ever dies.
#
# Idempotent: if a dashboard-server.mjs process is already listening on :3097,
# this script no-ops and exits 0.
#
# Remove this wrapper plist + script when Apple patches the launchd KeepAlive
# bug and a clean `launchctl bootstrap` on the canonical dashboard-server plist
# (com.mitchell.career-ops.dashboard-server.plist) works again. Document the
# patched macOS version when that happens.
#
# Spec vs. runtime — IMPORTANT:
#   This file (in the repo) is the SPEC / source of truth.
#   The live runtime copy lives at ~/.local/career-ops-wrappers/dashboard-server-nohup.sh
#   and is what the launchd plist actually exec's. Required because macOS Tahoe
#   TCC blocks /bin/bash spawned by launchd from exec'ing scripts under ~/Documents/.
#   Empirically verified 2026-05-25: plist path = repo → exit 126 "Operation not
#   permitted"; plist path = .local/ → exit 0, listener spawned normally.
#
#   After editing this file, sync to the runtime location:
#     bash scripts/sync-launchd-wrappers.sh           # copy repo → .local/
#     bash scripts/sync-launchd-wrappers.sh --reload  # also bootout/bootstrap the wrapper plist
#     bash scripts/sync-launchd-wrappers.sh --check   # diff repo vs .local/, exit 1 on drift

set -u

PORT=3097
NODE_BIN="/Users/mitchellwilliams/.nvm/versions/node/v24.14.0/bin/node"
REPO="/Users/mitchellwilliams/Documents/career-ops"
SERVER_MJS="${REPO}/dashboard-server.mjs"
# Log dir MUST live outside ~/Documents/ — macOS Tahoe TCC blocks /bin/bash
# spawned by launchd from opening file handles under Documents (exit 78).
# Fixed 2026-05-22 (Phase 6.5-CAD-1) — see .claude/audit/plist-fix-2026-05-22/.
LOG_DIR="/Users/mitchellwilliams/Library/Logs/career-ops"
LOG_OUT="${LOG_DIR}/dashboard-server-nohup.out"
LOG_ERR="${LOG_DIR}/dashboard-server-nohup.err"

mkdir -p "$LOG_DIR"

# Idempotency check: is anything listening on :3097? lsof on the actual TCP
# listener is the canonical signal — a stale pgrep-able process that's not
# binding the port is not "already running" for our purposes (closes
# bug-2026-05-25-100).
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(date -Iseconds) dashboard-server :${PORT} listener already present, no-op" >> "$LOG_OUT"
  exit 0
fi

# Zombie-reap guard (2026-05-25 — closes bug-2026-05-25-041): if we got past
# the lsof check, NO process is listening on $PORT. BUT a stale dashboard-
# server.mjs process may still match pgrep (e.g., OOM-killed mid-listener,
# port-binding-failed startup, segfault during accept loop). Without this
# guard, the new nohup spawn would coexist with the zombie — duplicate
# process accumulation across the 5-minute wrapper plist interval.
# Strategy: SIGTERM any matching pgrep'd process, wait 1s for OS cleanup,
# then proceed to spawn. SIGKILL escalation is intentionally absent — if
# SIGTERM doesn't take effect in 1s, the new spawn may collide with the
# stale process, which is no worse than the pre-guard behavior.
if /usr/bin/pgrep -f "dashboard-server.mjs --port=${PORT}" >/dev/null 2>&1; then
  echo "$(date -Iseconds) zombie dashboard-server.mjs detected (pgrep matched, lsof did not) — sending SIGTERM" >> "$LOG_OUT"
  /usr/bin/pkill -TERM -f "dashboard-server.mjs --port=${PORT}" 2>/dev/null || true
  sleep 1
fi

cd "$REPO" || exit 1

# Spawn detached via nohup. The `</dev/null` keeps stdin from holding the wrapper.
nohup "$NODE_BIN" "$SERVER_MJS" --port="$PORT" \
  >> "$LOG_OUT" 2>> "$LOG_ERR" </dev/null &

disown 2>/dev/null || true
echo "$(date -Iseconds) dashboard-server spawned via nohup (PID $!)" >> "$LOG_OUT"
exit 0
