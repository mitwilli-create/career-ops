#!/usr/bin/env bash
# scan-unattended.sh — launchd-friendly wrapper for nightly portal scan + triage.
# Runs at 02:00 PT via com.mitchell.career-ops.scan.plist.
# Logs to data/logs/scan-{date}.log and exits clean even on partial failure.
set -uo pipefail

PROJECT_DIR="/Users/mitchellwilliams/Documents/career-ops"
NODE_BIN="/Users/mitchellwilliams/.nvm/versions/node/v24.14.0/bin/node"
LOG_DIR="$PROJECT_DIR/data/logs"
DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/scan-${DATE}.log"

mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

echo "=== scan-unattended starting $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
cd "$PROJECT_DIR" || { echo "FATAL: cd to $PROJECT_DIR failed"; exit 1; }

echo "--- Running scan.mjs ---"
"$NODE_BIN" scan.mjs
SCAN_EXIT=$?
echo "scan.mjs exit code: $SCAN_EXIT"

echo "--- Running triage-pipeline.mjs ---"
"$NODE_BIN" scripts/triage-pipeline.mjs --limit=30
TRIAGE_EXIT=$?
echo "triage-pipeline.mjs exit code: $TRIAGE_EXIT"

echo "=== scan-unattended completed $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""
exit 0
