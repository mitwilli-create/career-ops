---
name: corpus-librarian
description: Run the corpus-librarian — a standing "librarian" for Mitchell's career corpus. Inventories every source item, audits the bindings between each item and its consumers (the coverage matrix that makes structural orphans visible), enforces file-naming conventions, resolves Google Drive citation links, flags optimization candidates (too-long / missing-tags / duplicate), and emits a ranked decision doc. Slash-command wrapper around `scripts/agents/corpus-librarian.mjs`. All mutations are dry-run + approval-gated + archive-first; nothing is committed or pushed. Triggers when Mitchell types /corpus-librarian, says "audit the corpus," "what's orphaned in my corpus," "run the corpus librarian," "build the coverage matrix," "which corpus files are loaded by nothing," "rename the artifact dumps," "is the corp-eng / xge stuff wired in," "find dark corpus items," or any phrasing that wants the source↔consumer bindings of his career corpus interrogated. Heavy work runs in the agent subprocess so the main session context stays clean.
user_invocable: true
args: mode
argument-hint: "[index | coverage | naming | citations | optimize | staleness | decision-doc | all | apply] (default: all)"
---

# corpus-librarian — librarian for Mitchell's career corpus

## Purpose

The career corpus is a **source consumed by many surfaces** — grounded popouts (`lib/ground-prompt.mjs`), story child-pages (`scripts/generate-story-pages.mjs`), apply-now content, batch eval Block C, the dashboard. But **no tool audits the bindings between a source item and its consumers.** Today grounding loads only a narrow slice (personality second-brain docs + `cv.md` / `article-digest.md` / `modes/_profile.md` / `config/profile.yml`). Everything else on disk — `corpus/roles`, `corpus/projects`, `writing-samples`, `data/portfolio`, and the two 2026-05-30 Google artifact dumps — is a **structural orphan**: present, loaded by nothing, surfaced nowhere.

The librarian's highest-leverage output is the **coverage matrix** that makes those orphans visible (reachability analysis: walk the consumers, and the items no consumer reaches are orphans). It also enforces naming, resolves Drive citations, flags optimization candidates, and emits a ranked decision doc.

## Modes

| Mode | What it does | Output | Spend |
|---|---|---|---|
| `index` | Inventory every corpus item (path, type, archetype tags, words, size, mtime, naming compliance, needs-extraction). Builds on `lib/corpus-scanner.mjs`; dump dirs walked **metadata-only** (a 7 GB video would OOM a naive read). | `data/corpus-index.json` | $0 |
| `coverage` | **Two-layer binding audit** — structural (loaded by any consumer?) + surfaced (reaches a render surface?). Classifies each group `orphan` / `dark` / `bound`. Models `scripts/audit-field-binding.mjs`. | `data/corpus-coverage-matrix.json` | $0 |
| `naming` | Audit dump files vs `data/corpus-naming-conventions.json`; propose `current → proposed` renames (dry-run, images excluded). | `data/corpus-naming-proposals-<DATE>.json` | $0 |
| `citations` | Resolve Drive `webViewLink`s (graceful — `drive.file` scope can't see manual uploads; seeds `data/corpus-drive-links.json` fallback map); propose `[corp-eng: …]` / `[xge-comms: …]` citation injections into story-page footnotes. | `data/corpus-citation-proposals-<DATE>.json` | ~$0 |
| `optimize` | Flag too-long (>12K words), missing archetype tags (narrative corpus only), duplicate basenames (Drive copies). LLM split/merge pass gated behind `--execute --budget N`. | `data/corpus-optimize-findings-<DATE>.json` | capped |
| `staleness` | **Dated-snapshot SUPERSEDED-banner audit** (deterministic). Dated `data/*-YYYY-MM-DD*.md` snapshot docs (alignment/calibration/positioning/spec/prompt/playbook) >7d old that are NOT the newest of their series and lack a top-of-file `> **SUPERSEDED` banner → MED; ANY dated doc on a canonical surface (`data/linkedin-profile-canonical.md`) lacking the banner → HIGH regardless of age; dated `handover-*`/`council-input-*` >7d → LOW banner proposal. Active docs go in `data/corpus-staleness-exempt.json`. Banners are PROPOSED, never applied. Add `--check` to exit 2 on HIGH/MED (test mode; wired as test-all §32 via fixtures). Born from the 2026-07-10 LinkedIn tenure incident (unbannered `linkedin-alignment-2026-07-07.md`). | `data/corpus-staleness-findings-<DATE>.json` + `data/corpus-staleness-decision-doc-<DATE>.md` (only when findings exist) | $0 |
| `decision-doc` | Consolidate all findings into a ranked doc with `DECISION_N=____` placeholders. | `data/corpus-librarian-decision-doc-<DATE>.md` | $0 |
| `all` (default) | `index → coverage → naming → citations → optimize → staleness → decision-doc`. **Read-only — no mutations.** | all of the above | $0 |
| `apply` | Execute **APPROVED** `DECISION_N` changes. DANGEROUS, gated: dry-run unless `--execute`, archive-first, acts only on `=APPROVE` lines, never auto-runs the 90 GB dedup/raw-archive. | mutations + ledgers | gated |

## Usage

```bash
/corpus-librarian                 # = all (read-only sweep + decision doc)
/corpus-librarian coverage        # just the orphan-visibility matrix
/corpus-librarian naming          # rename proposals (dry-run)
/corpus-librarian apply           # dry-run preview of approved mutations
```

Direct CLI (what the skill wraps):
```bash
node scripts/agents/corpus-librarian.mjs --all
node scripts/agents/corpus-librarian.mjs --coverage --json
node scripts/agents/corpus-librarian.mjs --apply --execute   # only after DECISION_N=APPROVE
```

Flags: `--out <path>` (override decision-doc path) · `--execute` (with `--apply`, actually mutate) · `--budget <usd>` (optimize cap) · `--no-dumps` (skip the giant artifact dirs) · `--json` · `--check` (with `--staleness`: exit 2 on blocking findings).

Env: `CORPUS_LIBRARIAN_ROOT=<path>` — run against a different tree (e.g. the main repo from a worktree; gitignored `data/` only exists in the main tree).

## How to run it from the main session

1. Invoke `node scripts/agents/corpus-librarian.mjs <mode>` via Bash (it's fast — metadata-only, ~0.4s for `--all`).
2. Surface the coverage matrix + the decision doc path to Mitchell.
3. For `apply`: never run `--execute` without an explicit `DECISION_N=APPROVE` in the decision doc, and **never** mutate the four protected files (`cv.md`, `article-digest.md`, `modes/_profile.md`, `config/profile.yml`) — those are hook-protected and need Mitchell's explicit in-conversation consent.

## Gates (always in force)

- **Read-only by default.** Only `--apply --execute` mutates, and only on `=APPROVE` decisions.
- **Archive-before-write.** Renames + edits write a reversible ledger (`data/corpus-rename-ledger-<DATE>.jsonl`).
- **Gitignored personal data.** The corpus (`data/corp-eng-artifacts/`, `data/xge-comms-artifacts/`, `cv.md`, `apply-pack/*`, `data/hm-intel/*`) and every librarian output (`data/corpus-*`) are gitignored — **never commit, never push** (and never to santifer upstream).
- **Drive scope.** `drive.file` OAuth can't resolve manually-uploaded files → citations degrade to a `TBD` map Mitchell fills in. Never crash on a missing link.
- **No raw artifact bodies to external APIs.** `--optimize` passes only metadata/summaries, never Google-confidential artifact content.
- **UI changes** (if citation injection ever touches story-page HTML) require Chrome MCP screenshots at two widths before claiming done.

## Related

- Agent: `scripts/agents/corpus-librarian.mjs`
- Builds on: `lib/corpus-scanner.mjs` (ingest), `scripts/audit-field-binding.mjs` (binding-audit precedent), `lib/ground-prompt.mjs` (the grounded slice that defines the orphan gap), `scripts/generate-story-pages.mjs` + `lib/story-child-page.mjs` (citation-injection target)
- Decision-doc pattern mirrors `scripts/agents/system-maintainer.mjs`
- First-run artifact-intake decision doc: `data/corpus-librarian-artifact-intake-2026-05-30.md`
