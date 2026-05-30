---
name: eval-ux-audit
description: Light orchestrator for the evaluation UX audit — 5 statistical dimensions over `reports/`, `data/applications.md`, `modes/`, `portals.yml`, and `batch/triage-advance.tsv`. Trigger when Mitchell types /eval-ux-audit, says "audit my evaluation system", "is the scoring system selective enough", "is the corpus actually feeding evaluation", "audit how I evaluate roles", "is mode coverage adequate", or wants the diagnostic before scoping a deeper evaluation overhaul. Slash-command wrapper for `scripts/agents/eval-ux-audit.mjs`. Diagnostic only — does NOT modify scoring code, modes, or evaluation prompts. Default cost ~$0.05-0.15. `--dry-run` is $0. `--council` adds adjudication. `--full-pipeline` is reserved for v1.1 (full 7-phase Chrome MCP harvest + deploy-verify integration). Cross-fork-leak hardening — `[PERSONAL — DO NOT PUBLISH]` frontmatter.
---

# /eval-ux-audit

Lightweight diagnostic over Mitchell's evaluation system. Reads `reports/` + `data/applications.md` (gitignored personal data) + `modes/` + `portals.yml` + `batch/triage-advance.tsv` to surface whether the scoring system is calibrated, the corpus is actually feeding evaluations, and the role-discovery surface is producing real volume.

## When to invoke

- "Is the scoring system actually selective?"
- "Does my corpus (cv.md, article-digest.md, _profile.md) make it into eval reports?"
- "How many modes do I have? Are they covering all cases?"
- "Is portals.yml producing enough discovery volume?"
- Before scoping a heavier evaluation overhaul — this is the cheap diagnostic.

## Dimensions

| # | Dimension | Verdict logic |
|---|---|---|
| D1 | **Reports inventory** — count + % stale (>30d) in `reports/` | PASS if >100 total |
| D2 | **Scoring distribution** — N.N/5 score histogram from `applications.md` | PASS if strong + weak bands both populated (real selectivity) |
| D3 | **Corpus citation rate** — % of recent reports citing cv.md | PASS if ≥50% |
| D4 | **Modes inventory** — count in `modes/` + presence of `_profile.md` + `_shared.md` | PASS if ≥6 modes |
| D5 | **Role discovery surface** — `portals.yml` coverage + triage activity | PASS if portals≥20 + triage active |

## Usage

```
/eval-ux-audit                    # $0.05-0.15
/eval-ux-audit --dry-run          # $0
/eval-ux-audit --council          # +7-model adjudication ~$20-40
/eval-ux-audit --full-pipeline    # v1.1 reserved (currently aliases to --council)
```

Direct CLI: `node scripts/agents/eval-ux-audit.mjs [--dry-run | --council | --full-pipeline]`

## Output

`.claude/audit/<DATE>/eval-ux-audit-<DATE>.md`

## Future — `--full-pipeline` (v1.1)

Memory `project_eval_ux_audit_prompt.md` describes a 7-phase pipeline (corpus audit → Chrome MCP harvest of GitHub/LinkedIn/Vimeo/storytellermitch → 7-model council → dealbreaker → strategy approval gate → implementation → /deploy-verify). That version is reserved for v1.1; the current `--full-pipeline` alias to `--council` keeps the slash-discovery surface in place without committing to the heavier flow. Mitchell can wire the full pipeline by re-using `/corpus-audit` + `/researcher` + `/dealbreaker` + `/deploy-verify` invocations in sequence — the existing skill suite already covers each phase.

## Related

- `/corpus-audit` — Phase 0-2 (use first; cheaper)
- `/scan-audit`, `/batch-audit` — operational health
- `/pre-apply-audit`, `/polish-audit` — downstream pipelines
