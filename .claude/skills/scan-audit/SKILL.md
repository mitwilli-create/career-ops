---
name: scan-audit
description: Diagnostic audit of the career-ops scanner pipeline — 5 dimensions: scanner plist health, pipeline-ingress staleness, portals.yml coverage, scan-history dedup rate, triage-advance queue depth. Trigger when Mitchell types /scan-audit, says "audit the scanners", "are scanners actually firing", "is the triage queue stalled", "what scanners are stale", "audit portals.yml coverage", or wants a $0 diagnostic before deciding which scanners to fix. Slash-command wrapper for `scripts/agents/scan-audit.mjs`. Diagnostic only — does NOT bootstrap or kickstart any plist. Default cost ~$0.05-0.15. `--dry-run` is $0. Cross-fork-leak hardening — `[PERSONAL — DO NOT PUBLISH]` frontmatter.
---

# /scan-audit

Diagnose scanner pipeline health: plists loaded? Recently fired? Triage queue draining? Portals.yml has enough coverage? Reads `scripts/launchd/com.mitchell.career-ops.scan-*.plist` + `data/pipeline-ingress-state.json` + `portals.yml` + `data/scan-history.tsv` + `batch/triage-advance.tsv`.

## When to invoke

- "Are scanners actually running?"
- "Is the triage queue stuck?"
- "How many companies does portals.yml cover?"
- "Which scanners haven't fired in 48h+?"
- After adding new portals or scanner plists — verify the pipeline picked them up.

## Dimensions

| # | Dimension | Verdict logic |
|---|---|---|
| D1 | **Scanner plists** — `scripts/launchd/com.mitchell.career-ops.scan-*.plist` count | PASS if ≥6 |
| D2 | **Pipeline ingress** — % of scanners with last-fire >48h ago in `data/pipeline-ingress-state.json` | PASS if ≤25% stale |
| D3 | **Portals coverage** — company entries in `portals.yml` | PASS if ≥20 |
| D4 | **Scan history** — entries in `data/scan-history.tsv` | PASS if ≥100 |
| D5 | **Triage advance queue** — pending count in `batch/triage-advance.tsv` | PASS if <500 |

## Usage

```
/scan-audit                  # $0.05-0.15
/scan-audit --dry-run        # $0
/scan-audit --council        # +7-model ~$20-40
```

Direct CLI: `node scripts/agents/scan-audit.mjs [--dry-run | --council]`

## Output

`.claude/audit/<DATE>/scan-audit-<DATE>.md`

## Related

- `/system-maintainer` — broader SRE hygiene (plist health is part of it)
- `/career-ops-health` — production-health check
