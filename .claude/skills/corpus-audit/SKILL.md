---
name: corpus-audit
description: Phase 0-2 corpus-gap diagnostic — inventory Mitchell's career-corpus surfaces (cv.md, article-digest.md, modes/_profile.md, config/profile.yml, apply-pack/, writing-samples/, data/career-archive/, data/hm-intel/) and identify what's missing, stale, or under-leveraged by the scoring system. Trigger when Mitchell types /corpus-audit, says "audit my corpus", "what's missing from my career corpus", "are my writing samples enough", "do I have enough proof points", or wants a $0 diagnostic before running a heavier /eval-ux-audit. Slash-command wrapper for `scripts/agents/corpus-audit.mjs`. Diagnostic only — does NOT modify any corpus surface. Default cost ~$0.05-0.15 (Sonnet 4.6 narrative). `--dry-run` is $0 (inventory only, no synthesis). Cross-fork-leak hardening — `[PERSONAL — DO NOT PUBLISH]` frontmatter, no inline content from sensitive paths.
---

# /corpus-audit

Phase 0-2 of the broader `/eval-ux-audit`. Walks Mitchell's career-corpus surfaces and produces a structured gap inventory. Does **NOT** harvest external sources (GitHub / LinkedIn / Vimeo / storytellermitch.com) — that's `/eval-ux-audit`'s Phase 3. Does **NOT** modify anything.

## When to invoke

- "What gaps does my corpus have?"
- "Are my writing samples sufficient for voice calibration?"
- "What % of my apply-packs are complete?"
- "How many hm-intel files do I have?"
- Before kicking off a heavier `/eval-ux-audit` — `/corpus-audit` is the cheap diagnostic first.

## Dimensions audited

| # | Dimension | Verdict logic |
|---|---|---|
| D1 | **Core corpus** — cv.md, article-digest.md, modes/_profile.md, config/profile.yml, portals.yml, AGENTS.md, CLAUDE.md | PASS if all present and ≤30d stale |
| D2 | **Apply-pack inventory** — % packs with all 6 artifacts (cv-tailored, cover-letter, form-fields, impact-doc, references, referrals) | PASS if ≥75% complete |
| D3 | **Writing samples** — count of voice-calibration files in `writing-samples/` | PASS if ≥3 samples |
| D4 | **Career archive** — count of files in `data/career-archive/` (proof points + project briefs) | PASS if ≥5 |
| D5 | **hm-intel corpus** — count of `data/hm-intel/<slug>.json` files | PASS if ≥20 |

## Usage

```
/corpus-audit                  # $0.05-0.15 (synthesis)
/corpus-audit --dry-run        # $0
/corpus-audit --council        # +7-model adjudication ~$20-40
```

Direct CLI: `node scripts/agents/corpus-audit.mjs [--dry-run | --council]`

## Env knobs

| Var | Default | Purpose |
|---|---|---|
| `CORPUS_AUDIT_DAILY_USD` | `50` | Hard daily cap |
| `CORPUS_AUDIT_MODEL` | `anthropic:claude-sonnet-4-6` | Synthesis model |

## Output

`.claude/audit/<DATE>/corpus-audit-<DATE>.md` — `[PERSONAL — DO NOT PUBLISH]` frontmatter, 5-dimension verdict table, Sonnet 4.6 narrative, raw dimension JSON.

## Related

- `/eval-ux-audit` — full 7-phase evaluation including this audit as Phase 0
- `/pre-apply-audit` — pre-apply-check calibration
- `/polish-audit` — polish-loop calibration
