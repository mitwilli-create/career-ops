#!/usr/bin/env bash
# scripts/deploy/setup-healthchecks.sh — bring up the self-hosted Healthchecks
# instance for career-ops dead-man job heartbeats (convergence Phase 0).
#
# What it does:
#   1. Verifies Docker is available (Docker Desktop or OrbStack).
#   2. Generates infra/healthchecks/.env.hc with a random SECRET_KEY (once).
#   3. docker compose up -d with the exact-pinned official image.
#   4. Waits for HTTP 200 on http://127.0.0.1:8787.
#   5. Prompts createsuperuser (first run only) + prints the manual steps to
#      copy the project ping key into the repo .env as HEARTBEAT_PING_BASE.
#
# Idempotent — safe to re-run. Never touches the repo .env itself (the
# operator pastes HEARTBEAT_PING_BASE deliberately; warn-before-config).
#
# STATUS NOTE (2026-07-07): authored while Docker was NOT installed on this
# machine, so steps 3-5 are untested here. Step 5's manage.py invocation
# follows the official image docs; if the exec path differs on the pinned
# image, use the manual fallback printed at the end.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_DIR="$HERE/infra/healthchecks"
ENV_HC="$COMPOSE_DIR/.env.hc"
URL="http://127.0.0.1:8787"

# 1. Docker present?
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found. Install Docker Desktop or OrbStack (brew install --cask orbstack)," >&2
  echo "then re-run: bash scripts/deploy/setup-healthchecks.sh" >&2
  exit 2
fi

# 2. Secret key (generated once, gitignored)
if [[ ! -f "$ENV_HC" ]]; then
  # openssl (always present on macOS) — no tr|head pipeline, which under
  # `set -o pipefail` can kill the whole script via SIGPIPE when head
  # closes the pipe early (Qodo finding, PR #408).
  SECRET="$(openssl rand -hex 32)"
  printf 'HC_SECRET_KEY=%s\n' "$SECRET" > "$ENV_HC"
  chmod 600 "$ENV_HC"
  echo "✓ generated $ENV_HC"
else
  echo "✓ $ENV_HC already exists (kept)"
fi

# 3. Up
( cd "$COMPOSE_DIR" && docker compose --env-file .env.hc up -d )

# 4. Wait for HTTP 200 (max ~90s)
echo -n "waiting for $URL "
DEADLINE=$(( $(date +%s) + 90 ))
until curl -fsS -o /dev/null "$URL" 2>/dev/null; do
  if (( $(date +%s) > DEADLINE )); then
    echo ""
    echo "ERROR: $URL not responding within 90s — check: docker compose -f $COMPOSE_DIR/docker-compose.yml logs" >&2
    exit 3
  fi
  echo -n "."
  sleep 3
done
echo " up."

# 5. First-run account + ping key instructions
cat <<EOF

Next steps (first run only):
  1. Create the (only) account:
       docker compose --project-directory "$COMPOSE_DIR" exec healthchecks /opt/healthchecks/manage.py createsuperuser
     (fallback if that path 404s: docker exec -it career-ops-healthchecks python manage.py createsuperuser)
  2. Open $URL — log in — Settings → Project → copy the PING KEY.
  3. Add to the repo .env (NOT .env.example):
       HEARTBEAT_PING_BASE=$URL/ping/<ping-key>
  4. Redeploy the bash wrapper so cron-run.sh jobs ping too:
       bash scripts/deploy/install-wrappers.sh
  5. Verify one ping end-to-end (\$0, deterministic job):
       launchctl kickstart -k gui/\$(id -u)/com.mitchell.career-ops.builder-log
     then check $URL — a 'builder-log' check should auto-appear (?create=1).

Exit gate for Phase 0: every scheduled job green for 3 consecutive days.
EOF
