---
name: task-audit
description: Review prior Claude Code sessions to find user asks that were not addressed, subtasks abandoned mid-flight, or commitments made but never followed through. Reads transcripts at `~/.claude/projects/<encoded>/*.jsonl`, extracts each user ask, compares to what Claude actually shipped, surfaces the gaps. Standalone agent (NOT a wrapper around regression-guard). Output: `.claude/audit/<DATE>/task-audit-<DATE>.md` (findings report) + `.claude/audit/<DATE>/task-audit-followups-<DATE>.md` (ready-to-paste continuation prompts for each unaddressed ask). Cross-fork-leak hardening — hash_only citations + `[PERSONAL — DO NOT PUBLISH]` frontmatter. Default scope `--last 5` sessions. Daily cap $20. Trigger when Mitchell types /task-audit, says "what did I miss this week," "audit my last sessions for incomplete work," "find dropped asks," "what fell through," or any phrasing that wants a retrospective sweep over recent sessions for unfinished work.
user_invocable: true
args: mode
argument-hint: "[--last N | --session <uuid> | --since YYYY-MM-DD --until YYYY-MM-DD] [--budget USD] [--dry-run] [--skip-followups]"
---

# task-audit — find asks that didn't ship

## Purpose

Across many sessions, asks slip through: a user adds a third item to a request and Claude only does the first two; a subtask gets deferred to "follow-up" and never picked up; Claude says "I'll also fix X" mid-response and X is the last thing mentioned. Each individual session looks fine at the time. The gaps only surface when you re-read the transcript.

This skill walks recent session transcripts, lists every user ask, and asks Sonnet 4.6 whether each one was actually addressed by the time the session ended. Output is a findings report + ready-to-paste continuation prompts so you can re-fire any genuinely-dropped ask without composing it from scratch.

## Modes

| Mode | What it does | Spend |
|---|---|---|
| `--last N` (default `--last 5`) | Audit N most-recently-touched sessions. | ~$0.50–$2/session |
| `--session <uuid>` | Audit one session by UUID. | ~$0.50 |
| `--sessions <u1,u2,...>` | Audit explicit UUID list. | scales linearly |
| `--since YYYY-MM-DD --until YYYY-MM-DD` | Audit sessions whose mtime falls in window. | scales with count |
| `--dry-run` | Walk transcripts + emit skeleton report, no LLM calls. | $0 |
| `--skip-followups` | Skip the continuation-prompt generation step. | -$0.10/session |

## Triggers

- `/task-audit` (default `--last 5`)
- "what did I miss this week"
- "audit my last sessions for incomplete work"
- "what fell through" / "find dropped asks"
- "review my last 3 sessions and tell me what didn't ship"
- After a long sprint, before closing a project, when picking up cold

## Inputs / outputs / constraints

**Inputs:**
- `~/.claude/projects/<encoded-path>/*.jsonl` — session transcripts (gitignored personal data)

**Outputs:**
- `.claude/audit/<YYYY-MM-DD>/task-audit-<YYYY-MM-DD>.md` — findings report (`[PERSONAL — DO NOT PUBLISH]` frontmatter)
- `.claude/audit/<YYYY-MM-DD>/task-audit-followups-<YYYY-MM-DD>.md` — ready-to-paste continuation prompts per unaddressed ask
- `data/task-audit-spend.jsonl` — append-only cost ledger

**Constraints — CRITICAL:**

- **Cross-fork-leak defense (Pattern E)**: session transcripts are HIGH-sensitivity. Citations in the decision doc are hash_only (sha256:12-hex of the session UUID + ask content). The report references "session #<hash> · ask #<hash>" — NEVER the raw UUID or ask content verbatim. Build-time guard via `assertNoInlineQuotesFromSensitivePaths()` (shared with regression-guard) fails the render if any inline quote leaks. Frontmatter is `classification: "[PERSONAL — DO NOT PUBLISH]"`.

- **The follow-up prompts file is gitignored by inclusion under `.claude/audit/`** (already-gitignored prefix). It DOES contain the user's original ask in plain text — that's its job, you're meant to paste it back into a new session. Don't share the file.

- **Daily cap $20** (`TASK_AUDIT_DAILY_USD`). Hard-stop on breach. SOFT per-call WARN at $5 (`TASK_AUDIT_PER_CALL_WARN_USD`).

- **NEVER edits any source file.** Read-only over transcripts; write-only to its own audit dir + spend ledger.

- **Sonnet 4.6 for adjudication.** Single model, no council fan-out (cheap operation, no adversarial-disagreement value at this size).

## Example invocations

```
/task-audit                                    # default: --last 5
/task-audit --last 3                           # narrower window
/task-audit --session 493329bb-ac59-4c58-8ec2-bb23e9a398b4
/task-audit --since 2026-05-26 --until 2026-05-28
/task-audit --dry-run                          # skeleton only, $0
/task-audit --budget 5                         # tighter cap for this run
/task-audit --skip-followups                   # report only, no prompts
```

## Output shape

### Report (`task-audit-<DATE>.md`)

```
---
classification: "[PERSONAL — DO NOT PUBLISH]"
generated_at: 2026-05-28T...
scope: --last 5
sessions_scanned: 5
asks_extracted: 47
addressed: 38
unaddressed: 9
spend_usd: 1.24
---

## TL;DR

9 of 47 asks unaddressed across 5 sessions. Highest-confidence gaps:
- session #<hash> ask #<hash> — "...short paraphrase..."
- ...

## Findings

| # | Session | Ask (paraphrase, ≤80 chars) | Confidence | Suggested followup |
|---|---|---|---|---|
| 1 | #<hash> | "..." | H | See followups doc § F1 |
| ... |

## Wins (asks Claude shipped completely)

- ...

## Sessions scanned

| UUID hash | mtime | asks | addressed | unaddressed |
|---|---|---|---|---|
| #<hash> | 2026-05-28T... | 12 | 10 | 2 |
| ... |
```

### Followups (`task-audit-followups-<DATE>.md`)

```
# Continuation prompts for unaddressed asks

## F1 — session #<hash> ask #<hash>

**Original ask (paste-ready):**

> {verbatim user content}

**Suggested framing:**

> In session #<hash> on <date> I asked the above. Looking back, the
> part about <X> didn't ship. Pick up there, with the context that
> {summary of what DID ship in that session}.

---

## F2 — ...
```

## How this skill differs from existing tooling

- `regression-guard` — runs 8 detectors over code + transcripts for DRIFT (closure invariants, structural regression). task-audit asks one question: "did each user ask get addressed?" No detector framework, no baselines, no canary suite.
- `system-maintainer` — SRE hygiene (plists, /tmp, orphans). Different layer.
- `omega-steward` — proposes IMPROVEMENTS to agents. task-audit surfaces gaps in past EXECUTION, not future design.

## Anti-sycophancy reminders (inline)

- If 0 unaddressed asks found, say "0 unaddressed across N asks — clean cycle." Don't pad with "great work this week."
- If Sonnet returns LOW confidence on most asks, surface that explicitly — the adjudicator is uncertain, the user should treat the report as suggestive not definitive.
- If the daily cap exhausts mid-scope, say "CAP EXHAUSTED at $20 — N of M sessions audited." Don't apologize, don't paper over.

## Rollback / kill switch

```bash
# No plist (user-invoked only) — kill switch is just don't run it.
# To purge ledger if needed:
rm -f data/task-audit-spend.jsonl
# To wipe today's report:
rm -f .claude/audit/$(date +%Y-%m-%d)/task-audit-*.md
```
