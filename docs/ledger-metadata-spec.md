# Ledger metadata block format

Spec for the YAML-fenced metadata blocks parsed by `lib/ledger-enforcer.mjs`.

Established 2026-05-25 as part of Step 6 of the pre-apply-check deepening project (`.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md`).

## Why this exists

`data/persistent-task-ledger.md` is a markdown document built for humans — narrative prose, tables, append-only history. Machines need a structured handle on the same data so the pre-commit hook + GitHub Actions check can answer questions like:

- "This PR touches `lib/pre-apply-orchestrator.mjs` — does any OPEN/NEEDS_CLOSURE entry track that path?"
- "This entry's `closure_artifacts` cites `data/foo.md` — does that file actually exist? (Catch the LEDGER-022/023/030 fabrication pattern where closure docs were referenced but never written.)"
- "This code_path was renamed last week — which ledger entries are now stale?"

The metadata block is the structured layer. It coexists with the narrative — the block lives inside an HTML comment so renderers + casual readers ignore it.

## Block syntax

A metadata block is an HTML comment whose opener is `<!-- ledger-meta`, body is YAML, closer is `-->`. The block can appear anywhere in the document; it is attributed to a LEDGER entry either by an explicit `id:` field inside the body (preferred) OR by positional proximity to the most recent `LEDGER-NNN` identifier.

Example (preferred form, explicit id):

```html
<!-- ledger-meta
id: LEDGER-026
status: NEEDS_CLOSURE
feature_tag: master-execution-part-3
code_paths:
  - scripts/build-dashboard.mjs
  - lib/polish-card-renderer.mjs
closure_artifacts:
  - data/master-resolution-2026-05-22.md
  - .claude/audit/master-execution-part-3-2026-05-23/index.md
-->
```

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | recommended | If present, overrides positional attribution. Format: `LEDGER-NNN` or `LEDGER-NNN-DONE` etc. |
| `status` | string | required | One of `NEEDS_CLOSURE`, `OPEN`, `IN_PROGRESS`, `BLOCKED`, `PERMANENT-OPEN`, `DONE`, `CLOSED`, `COMPLETED`, `SUPERSEDED` |
| `feature_tag` | string | optional | Short kebab-case label grouping related entries (e.g., `pre-apply-check-deepen`). Used for future reporting / filtering. Not load-bearing for enforcement. |
| `code_paths` | string[] | optional | Repo-relative paths the entry tracks. EXACT match — no glob, no prefix. If the entry's status is OPEN-family AND any of these paths appears in a commit's modified-files list, the enforcer fires. Empty array (or absent) = entry never triggers enforcement. |
| `closure_artifacts` | string[] | optional | Repo-relative paths the entry CITES as evidence (closure doc, audit report, decision doc). The enforcer checks each path against the filesystem at audit time; cited-but-missing paths are flagged as "fabrication pattern" violations. |

## Statuses that gate enforcement

The enforcer fires the modified-paths check only for entries whose status is one of:

```
NEEDS_CLOSURE  OPEN  IN_PROGRESS  BLOCKED  PERMANENT-OPEN
```

Entries with status `DONE`, `CLOSED`, `COMPLETED`, or `SUPERSEDED` are skipped: once an entry has closed, modifying its old `code_paths` is normal repo maintenance, not a closure regression. The stale-artifact + stale-code-path audits skip closed entries for the same reason.

## YAML subset

The parser is hand-rolled (zero deps); it supports a deliberate subset of YAML:

- `key: scalar` — string scalar
- `key:` followed by indented `  - item` lines — string array
- `key: [a, b]` — flow-style string array (tolerated but not used in our format)
- Lines starting with `#` are comments
- Strings can be quoted with `"..."` or `'...'`; quotes are stripped
- Nested objects, anchors, multi-line scalars (`|`, `>`), and other YAML features are NOT supported

Keep your blocks simple — scalar fields + arrays of paths.

## Multiple blocks per entry

If the same entry id appears in multiple metadata blocks, **the last block wins** for each field. This is intentional: as an entry moves from OPEN → IN_PROGRESS → DONE, append a fresh block at the bottom rather than editing the original (preserves the audit-trail append-only invariant the ledger itself enforces).

## Entries without metadata

Entries that exist in the ledger but have no metadata block are returned by the parser with `metadata_present: false`. The enforcer cannot fire on these — they are effectively invisible to the modified-paths check. This is by design: backfilling all 31+ entries in one go would be a high-risk batch operation. Start with 5; expand as new entries are added.

## Position guidance

Two viable patterns:

**Pattern A — per-entry inline.** Place the block immediately after the entry's prose / table row. Use the implicit positional attribution (no `id:` needed). Cleanest when an entry has its own section heading.

**Pattern B — collected at section end.** Place all blocks in a dedicated "## Per-entry metadata blocks" section at the document end. Use explicit `id:` in every block. Cleaner when entries live in a shared table (no natural insertion point per row).

The first 5 backfilled entries (2026-05-25) use Pattern B + explicit `id:` because LEDGER-022, -023, -030 are table rows in the "OPEN — operational hygiene" section. LEDGER-001 uses Pattern A because it has its own header.

## CI behavior summary

| Mode | Triggered by | Behavior on `code_paths` match |
|---|---|---|
| Local pre-commit hook | `git commit` | Prints WARN; commit proceeds (exit 0 from hook regardless) |
| GitHub Actions | every PR to `main` | Fails the `Ledger enforcer` check; posts a fix-command PR comment |

The local hook deliberately does NOT block; per dealbreaker-final § "Option C anti-fatigue design", a hard local block creates the `--no-verify` bypass reflex (Week 1 lint catches real issues → Week 2 first false-positive → Week 3 `--no-verify` is muscle memory → mechanism dies). The CI check is the hard backstop.

## Adding a new entry to the metadata system

1. Find or create the entry's row / section in `data/persistent-task-ledger.md`.
2. Decide: does this entry track specific files in the repo? If yes, list them in `code_paths`. If no (e.g., a meta-task with no code surface), leave `code_paths` absent.
3. Decide: does this entry have a closure doc / audit report that should exist when the entry closes? List in `closure_artifacts`.
4. Append a `<!-- ledger-meta ... -->` block in the "Per-entry metadata blocks" section at document-end, with explicit `id:`.
5. Run `node scripts/ledger-enforcer.mjs --audit` to verify the new entry parses + no stale paths are introduced.
6. Run `node scripts/ledger-enforcer.mjs --explain` to confirm the entry now appears in the open-list (if status is OPEN-family).

## Related

- `lib/ledger-enforcer.mjs` — core library
- `scripts/ledger-enforcer.mjs` — CLI wrapper (`--check-modified`, `--audit`, `--explain`)
- `tests/ledger-enforcer.test.mjs` — fixture tests
- `.github/workflows/ledger-check.yml` — CI consumer (BLOCK mode)
- `scripts/install-git-hooks.sh` — local hook installer (WARN mode)
- `.claude/agents/runs/dealbreaker-final-pre-apply-2026-05-24.md` § Step 6 — design rationale
