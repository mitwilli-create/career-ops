---
name: hang-watchdog
description: Detect and triage hung career-ops processes. Scans every running node process under career-ops/, flags any with wall-time > 10min AND CPU < 1% AND no log activity > 5min as a hang suspect, captures a stack sample + lsof postmortem after 3 consecutive flags, optionally SIGTERM/SIGKILLs after 5 flags. Slash-command wrapper around `scripts/agents/hang-watchdog.mjs`. Default mode is REPORT-ONLY (no kill). Whitelists known daemons (telegram-bot, dashboard-server, signal-monitor, cloudflared) so they're never flagged. Triggers when Mitchell types /hang-watchdog, says "check for hung processes," "is anything stuck," "kill the hung agent," "what's hanging," or any phrasing that wants live process triage. Runs every 5 min via launchd in report-only mode; --auto-kill must be explicitly enabled before kill behavior is active.
user_invocable: true
args: mode
argument-hint: "[ | --auto-kill | --once] (default: --once report-only)"
---

# hang-watchdog — process-hang detector + postmortem

## Purpose

Career-ops agents sometimes hang indefinitely — usually because of:
- LLM API calls that don't honor AbortSignal cleanly
- Body-read stalls after fetch() (root cause of 2026-05-19 Phase H smoke hang)
- Child processes spawned without timeout
- MCP servers (especially PDF MCP) that die silently and don't notify the client

The hang signature is consistent:
- Process alive (event loop has a pending Promise)
- Low CPU (no actual work happening)
- No NDJSON / log activity in its dedicated log file

This skill scans for that signature on a 5-minute interval. By default it
only reports — Mitchell decides whether to kill. With `--auto-kill` (when
ready), it SIGTERMs after 5 consecutive flags.

## Modes

| Invocation | What it does | Side effects |
|---|---|---|
| `/hang-watchdog` | Single pass scan + report. Captures postmortem if a hang signature is hit on the 3rd consecutive flag. **No process kills.** | Writes `data/hang-postmortem-<date>-<pid>.md` if a hang is found. Updates `data/hang-watchdog-state.json`. |
| `/hang-watchdog --auto-kill` | Same as above + SIGTERMs (then SIGKILLs after 10s) any process that has been flagged ≥5 consecutive times. **EMERGENCY ONLY.** | Process termination. |
| `/hang-watchdog --once` | Single pass (same as default `/hang-watchdog`). Explicit form. | Same as default. |

## Thresholds (configurable)

| Flag | Default | Meaning |
|---|---|---|
| `--min-wall-min` | 10 | Min wall-clock minutes before considering a hang |
| `--max-cpu-pct` | 1.0 | Max CPU% to consider a hang (idle) |
| `--max-silent-min` | 5 | Max minutes since last log write |
| `--report-after` | 3 | Consecutive flags before postmortem captured |
| `--kill-after` | 5 | Consecutive flags before kill (only with `--auto-kill`) |

## Whitelist

These daemons are never flagged regardless of signature:
- `telegram-bot.mjs` — long-running poll
- `dashboard-server.mjs` — HTTP server
- `signal-monitor.mjs` — long-running listener
- `hang-watchdog.mjs` — recursion guard (won't flag itself)
- Anything matching `cloudflared` — tunnel daemon

## Self-defense

The watchdog itself follows every hang-prevention pattern from
`feedback_hang_prevention_patterns.md`:
- `spawnSync('ps', ..., { timeout: 10_000 })`
- `spawnSync('sample', ..., { timeout: 10_000 })`
- `spawnSync('lsof', ..., { timeout: 10_000 })`
- NDJSON heartbeat every 30s in continuous mode
- SIGTERM/SIGINT handlers clear all intervals
- No `await fetch()` calls — pure local execution

## Schedule

`com.mitchell.career-ops.hang-watchdog.plist` runs every 5 min (StartInterval=300)
in REPORT-ONLY mode. Mitchell must edit the plist to add `--auto-kill` when
he's ready to enable kills.

## What it writes

- `data/hang-watchdog-state.json` — per-PID consecutive flag count + history
- `data/hang-postmortem-<YYYY-MM-DD>-<pid>.md` — stack sample + lsof when a hang is captured
- `data/logs/hang-watchdog.{out,err}` — launchd logs (NDJSON heartbeats + pass-complete events)

## Outputs

| Event | When | Field |
|---|---|---|
| `start` | every invocation | thresholds + auto_kill mode |
| `heartbeat` | every 30s (continuous mode) | auto_kill_mode |
| `pass-complete` | end of each scan | `procs_scanned`, `flagged_count`, `pids_tracked` |
| `postmortem` | 3rd consecutive flag of a PID | `pid`, `flags`, `postmortem` (path) |
| `kill-attempt` | 5th flag if `--auto-kill` | `pid`, `flags`, `ok`, `error` |
| `shutdown` | end of `--once` mode | `reason` |
| `pass-error` / `fatal` | any pass error | `error` |

## Related

- `feedback_hang_prevention_patterns.md` — the rules every new agent must follow
- `data/hang-postmortem-2026-05-19-phase-H-smoke.md` — the incident that motivated this work
- `data/hang-patterns-2026-05-19.md` — codebase audit findings the patch sweep addressed
