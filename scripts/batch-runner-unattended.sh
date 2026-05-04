#!/usr/bin/env bash
# batch-runner-unattended.sh — launchd-friendly wrapper for overnight batch.
# Runs at 03:00 PT via com.mitchell.career-ops.batch.plist.
# Reads ~/.career-ops-secrets, applies a 60-min watchdog timeout,
# logs to data/logs/batch-{date}.log, exits clean even on partial failure.
set -uo pipefail

PROJECT_DIR="/Users/mitchellwilliams/Documents/career-ops"
SECRETS_FILE="$HOME/.career-ops-secrets"
NODE_DIR="/Users/mitchellwilliams/.nvm/versions/node/v24.14.0/bin"
LOG_DIR="$PROJECT_DIR/data/logs"
DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/batch-${DATE}.log"
TIMEOUT_SECONDS=${BATCH_TIMEOUT_SECONDS:-3600}
PARALLEL=${BATCH_PARALLEL:-2}

mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

echo "=== batch-runner-unattended starting $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
cd "$PROJECT_DIR" || { echo "FATAL: cd to $PROJECT_DIR failed"; exit 1; }

# Load secrets (Gmail SMTP, optional XAI_API_KEY)
if [[ -f "$SECRETS_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
  echo "Loaded secrets from $SECRETS_FILE"
else
  echo "WARN: $SECRETS_FILE missing — proceeding without env injection"
fi

# Ensure node + claude in PATH (claude lives alongside node in nvm)
export PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "PATH: $PATH"
echo "claude: $(command -v claude || echo MISSING)"
echo "node: $(command -v node || echo MISSING)"

if [[ ! -f "$PROJECT_DIR/batch/batch-input.tsv" ]]; then
  echo "No batch-input.tsv — nothing to evaluate. Exiting clean."
  echo "=== batch-runner-unattended completed $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit 0
fi

# Watchdog: kill batch-runner if it exceeds TIMEOUT_SECONDS
echo "--- Running batch-runner.sh (parallel=$PARALLEL, timeout=${TIMEOUT_SECONDS}s) ---"
bash "$PROJECT_DIR/batch/batch-runner.sh" --parallel "$PARALLEL" &
RUNNER_PID=$!
( sleep "$TIMEOUT_SECONDS"; if kill -0 "$RUNNER_PID" 2>/dev/null; then
    echo "TIMEOUT: killing batch-runner PID $RUNNER_PID after ${TIMEOUT_SECONDS}s"
    kill -TERM "$RUNNER_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  fi ) &
WATCHDOG_PID=$!

wait "$RUNNER_PID"
RUNNER_EXIT=$?
kill -TERM "$WATCHDOG_PID" 2>/dev/null || true
echo "batch-runner.sh exit code: $RUNNER_EXIT"

echo "=== batch-runner-unattended completed $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""
exit 0
