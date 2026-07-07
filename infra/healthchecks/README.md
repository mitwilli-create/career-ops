# Self-hosted Healthchecks — dead-man heartbeats for scheduled jobs

Convergence blueprint **Phase 0** (`data/agentic-surface-audit-2026-07-06/convergence-blueprint.md`).
Adjudicated decision (dealbreaker-final-20260706-111713.md, Impasse B): **keep
launchd** as the scheduler, add **self-hosted** Healthchecks dead-man heartbeats
to every scheduled job, retire the polling hang-watchdog later (Phase 4), do
**NOT** adopt PM2 (process manager ≠ scheduler; AGPL-3.0).

## How it works

Every run-to-completion scheduled launchd job routes through one of two wrappers,
and both ping this instance with the job's exit status:

| Wrapper | Jobs | Pings |
|---|---|---|
| `scripts/launchd-wrapper.mjs` (Node, in-repo) | 49 plists rewritten 2026-07-07 (`--max-retries=0` = behavior-preserving) | `/<slug>/start` on start, `/<slug>/<exit-code>` on completion |
| `~/.local/career-ops-wrappers/cron-run.sh` (bash, TCC-safe deploy of `scripts/wrappers/cron-run.sh`) | delta-ats-watch · delta-full-recalibration · gamma-truth-audit · network-database-build · network-enrich-batch | `/<label>/<exit-code>` at every exit path (cadence skips ping 0) |

Slug pings carry `?create=1`, so checks **auto-provision on first ping** — zero
per-job setup. A job that stops running simply stops pinging, and Healthchecks
flags the missed schedule. Tune per-check period/grace in the UI afterwards
(defaults are 1 day period / 1 hour grace).

**Fail-open invariant:** `HEARTBEAT_PING_BASE` unset → every ping is a silent
no-op; server down → warn + continue. A heartbeat problem can NEVER affect a
job or the exit code launchd sees.

## Deliberately NOT wrapped (14 plists)

- **Persistent daemons** (ping-on-exit is meaningless; monitor via HTTP checks
  instead): `cloudflared`, `cloudflared-staging`, `dashboard-server`,
  `chrome-debugging`, `telegram-bot` (if present).
- **Daemon restart shims** (`*-nohup-wrapper` ×3): a "completion" ping on a
  process that backgrounds a daemon and exits would read as a healthy daemon.
- **`alignment-watcher`** (WatchPaths-triggered, no period — a period-based
  dead-man check would false-alarm whenever the watched files don't change).
- **cron-run.sh jobs** (×5): ping via the bash wrapper itself (see table).
- **`prewarm-top-n`** (detached-work job): its command backgrounds the real
  work (`nohup … &`, `AbandonProcessGroup=true`), so a completion ping would
  fire when the parent shell exits — a false green with a meaningless
  runtime. Intentional design (PR #236); foreground conversion is a Phase 4
  candidate.

## Bring-up

```bash
bash scripts/deploy/setup-healthchecks.sh
```

Requires Docker Desktop or OrbStack. Image is **exact-pinned**
(`healthchecks/healthchecks:v4.2`, official image, BSD-3-Clause) per the
locked convergence rule — never floating tags, never `pip install`.
Binds `127.0.0.1` only; SQLite volume; registration closed. Nothing leaves
the machine (the reason self-hosted won over the SaaS: ping timing metadata
stays local).

## Config

One env var, documented in `.env.example`:

```
HEARTBEAT_PING_BASE=http://127.0.0.1:8787/ping/<project-ping-key>
```

Lives in the repo `.env` (gitignored). Both wrappers read process env first,
then fall back to parsing the repo `.env` (launchd jobs don't inherit shell env).

**`HC_SECRET_KEY`** (container-side Django secret, referenced by
`docker-compose.yml` as `${HC_SECRET_KEY:?…}`) is NOT a repo/.env variable:
`scripts/deploy/setup-healthchecks.sh` generates it once via
`openssl rand -hex 32` into `infra/healthchecks/.env.hc` (gitignored,
chmod 600) and compose reads it via `--env-file .env.hc`. Never set it
globally or copy it into the repo `.env`.

## Rollback

Remove/comment `HEARTBEAT_PING_BASE` in `.env` — all pings become no-ops
instantly (no plist or code changes needed). The plist rewrite itself is also
independently reversible: pre-rewrite backups at `scripts/launchd-archive/*.bak`
(gitignored, on-disk) or `git revert` of the Phase 0 PR.

## Relationship to fleet-watchdog (PR #407)

`scripts/fleet-watchdog.mjs` is a **pull**-style daily grader (reads launchd
state + logs, emails a report). Heartbeats are **push**-style dead-man signals
with per-run granularity. They compose: the watchdog catches config-level rot
(unloaded plists, wrong interpreter), heartbeats catch silent per-run failures
within minutes-to-hours instead of at the next daily grade. The POLLING
hang-watchdog (`scripts/agents/hang-watchdog.mjs`) is the component slated for
retirement — in Phase 4, per the blueprint, once heartbeats + engine timeouts
cover its cases. It stays running through Phase 0.
