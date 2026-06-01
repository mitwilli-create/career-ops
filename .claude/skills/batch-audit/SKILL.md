---
name: batch-audit
description: Diagnostic audit of Run Batch + Process All — 5 dimensions: batch success rate, Process All completion rate, audit log review, apply-now queue state, daily quota usage. Trigger when Mitchell types /batch-audit, says "audit the batch pipeline", "audit Process All", "is the batch error rate high", "is Process All actually completing", "audit cost drift in batch", "did the latest batch fail silently", or wants a $0 diagnostic before tuning the batch runner. Slash-command wrapper for `scripts/agents/batch-audit.mjs`. Diagnostic only — does NOT cancel, resume, or kickstart any batch. Default cost ~$0.05-0.15. `--dry-run` is $0. Cross-fork-leak hardening — `[PERSONAL — DO NOT PUBLISH]` frontmatter.
---

# /batch-audit

Diagnose Run Batch + Process All pipeline health: batch success rate, Process All completion vs cancel rate, cost drift, queue drain. Reads `batch/batches-api-state.json` + `data/pipeline-process-state.json` + `data/process-all-audit.jsonl` + `data/apply-now-queue.json` + `batch/daily-quota.json`.

## When to invoke

- "Is the batch error rate high?"
- "Did the latest Process All actually complete?"
- "What's the cost drift on recent runs?"
- "Is the apply-now queue draining?"
- "Am I close to my daily quota?"
- After tuning vendor params (e.g., removing deprecated `temperature` per the 2026-05-27 incident) — verify the change held.

## Dimensions

| # | Dimension | Verdict logic |
|---|---|---|
| D1 | **Batch success rate** — last-10 batches in `batches-api-state.json` | PASS if ≥90% per-request success |
| D2 | **Process All runs** — last 5 jobs in `pipeline-process-state.json` | PASS if all completed |
| D3 | **Audit log** — recent entries in `process-all-audit.jsonl` (>$250 spawns) | INFO (informational) |
| D4 | **Apply-now state** — ranked rows + pending pipeline | PASS if ranked>0 and pending<1000 |
| D5 | **Daily quota** — % of today's cap used | PASS if <75% |

## Usage

```
/batch-audit                  # $0.05-0.15
/batch-audit --dry-run        # $0
/batch-audit --council        # +7-model ~$20-40
```

Direct CLI: `node scripts/agents/batch-audit.mjs [--dry-run | --council]`

## Output

`.claude/audit/<DATE>/batch-audit-<DATE>.md`

## Related

- `/career-ops-health` — production-health check (Process All completion is part of it)
- AGENTS.md § `vendor-deprecation-100-percent-error-with-no-mark` (the 2026-05-27 incident that motivated D1)
