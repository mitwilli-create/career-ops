# Eval generator — handoff guide (2026-05-20)

Career-ops's eval generator turns a JD URL into a tracker-ready evaluation
report (score, archetype, A-F blocks, decision). This doc names the moving
pieces, the call graph, and the gotchas that take new contributors longest
to find. Read it before adding a new provider, changing a scoring weight,
or threading a new field through the consensus reducer.

## 30-second mental model

```
   JD URL
     │
     ▼
   fetchJD ─── Playwright + coverage gate
     │                                      ─── JD_SCRAPE_FAILED ⇒ queue + skip
     ▼
   gatherIntel ── 6 parallel intel sources
     │                                      ─── JD dead ⇒ skip
     ▼
   runCouncil ── Sonnet + Opus + Gemini fan-out → consensus reducer
     │                                      ─── all 3 failed ⇒ skip
     ▼
   validateCitations ── claim spans → existing files
     │
     ▼
   tracker TSV + Markdown report
```

Each arrow is a real function. Each diamond is a real fail-fast gate.
Nothing chains through the LLMs unless the gate passes — saves $0.06+
per gate-trip.

## File map

| File | Role | Key exports |
|---|---|---|
| `scripts/phase3b-evaluator.mjs` | Orchestrator. Reads survivors, calls the libs in order, writes TSV + report. | `evaluateSurvivor()` (private), `main()` |
| `lib/eval-intel-gather.mjs` | Step 1 (`fetchJD`) + Step 2 (`gatherIntel`). Fans out 6 intel sources in parallel. | `fetchJD`, `gatherIntel` |
| `lib/jd-coverage-check.mjs` | Coverage gate for the JD scrape. Pure heuristics, no I/O. | `scoreJDCoverage` |
| `lib/browser-pool.mjs` | Playwright surface used by `fetchJD` Path B. Pool-managed across calls. | `renderPage` |
| `lib/eval-council.mjs` | Step 3. Fans out the same intel pack to N providers, then runs the consensus reducer. | `runCouncil` |
| `lib/council.mjs` + `lib/council-dispatch.mjs` | Lower-level multi-provider plumbing (not eval-specific). | `dispatchCouncil`, etc. |
| `lib/eval-citation-validator.mjs` | Step 4. Walks the eval text for `[cv.md:L42]` style spans and verifies each. | `validateCitations` |
| `scripts/jd-rescrape-nightly.mjs` | Out-of-band recovery for FAIL scrapes. Reads + drains `data/jd-rescrape-queue.json`. Audit trail in `data/jd-scrape-audit/`. | (script, not lib) |
| `data/jd-rescrape-queue.json` | Durable queue of URLs that returned FAIL verdict in `fetchJD`. Written by phase3b-evaluator; drained by jd-rescrape-nightly. | (data, not code) |
| `data/jd-scrape-audit/<YYYY-MM-DD>-<host>.jsonl` | Append-only audit of every nightly rescrape attempt. README in same dir. | (data, not code) |

## Step 1 — `fetchJD(url)`

Defined in `lib/eval-intel-gather.mjs:131` (exported as of P1.11, 2026-05-20).
Three-layer scrape pipeline:

1. **Plain fetch** — static-HTML hosts. Skipped for SPA-allowlisted hosts
   (`SPA_HOST_PATTERNS` + LinkedIn `/jobs/`).
2. **Coverage scoring** — `scoreJDCoverage()` returns `GOOD` / `WEAK` / `FAIL`
   based on canonical section detection + shell-pattern grep. Pure heuristics;
   no LLM.
3. **Playwright render** — if coverage is not GOOD or host is SPA-allowlisted,
   fall through to `lib/browser-pool.mjs:renderPage(url)`.

Returns a flat object with `scrape_method`, `raw_char_count`, `coverage_score`,
`coverage_verdict`, `coverage_reason`, `sections_found`, `prose_word_count`,
`alive`, `status`, `source_url`, `text` (truncated to STATIC_TEXT_CAP=18K
for fetch, RENDERED_TEXT_CAP=30K for Playwright).

**FAIL verdict** ⇒ `error: 'JD_SCRAPE_FAILED'` + `alive: false`. Caller MUST
treat this as terminal — no council call. `phase3b-evaluator.mjs:232-258`
catches this and writes to `data/jd-rescrape-queue.json`.

**Gotcha:** the `scrape_method` strings tell you exactly which path ran —
`fetch`, `fetch+playwright`, `playwright`, `playwright(fail)`,
`fetch+playwright(fail)`. Use these strings in debug logs and audit
dashboards; they're stable.

## Step 2 — `gatherIntel({ url, company, role, gates })`

Defined in `lib/eval-intel-gather.mjs:400`. Fans out 6 intel sources in
`Promise.all` — JD fetch (already done step 1), cross-surface check, Grok,
comp reconciliation, network signal, plus two sync steps (outcome priors
from `applications.md`, proof points from `cv.md` + `article-digest.md`).

Returns the `intelPack` object the council prompt template consumes. Pack
shape documented at the top of the file (lines 17-29).

**Gates:** `skipGrok` and `skipNetwork` flags exist for tests / cost
control. Default is all sources on.

## Step 3 — `runCouncil({ intelPack, providers })`

Defined in `lib/eval-council.mjs:361`. Default providers list is
`['sonnet', 'opus', 'gemini']`; the `--providers` CLI flag overrides.

For each provider, builds the same prompt + intel-pack, calls the API,
extracts the JSON head block. The consensus reducer (`lib/eval-council.mjs`,
search for "Consensus reducer"):

- **HIGH** confidence: all 3 scores within 0.4 of mean
- **MEDIUM**: 2 of 3 within 0.4 (drop the outlier)
- **LOW**: > 0.4 spread on 2-of-3 ⇒ `LOW_CONSENSUS` flag, human review

Cost estimate logged per provider (`COST_ESTIMATE` constant) — Sonnet
≈ $0.06, Opus ≈ $0.18, Gemini ≈ $0.04 per call.

**Gotcha:** if a provider returns no head block (JSON parse failure), it
counts as `nohead` in the per-provider diagnostic, NOT as a hard fail.
Only when ALL providers failed does `runCouncil` return null consensus.

## Step 4 — `validateCitations(evalText)`

Defined in `lib/eval-citation-validator.mjs:53`. Walks the eval text for
spans like `[cv.md:L42]`, `[article-digest.md:L8]`, `[priors:#1509]`. For
each:

1. Cited file exists
2. Cited line within bounds
3. Cited line non-blank (catches hallucinated whitespace lines)
4. For `[priors:#N]`, row exists in `applications.md`

Returns `{ ok, total_citations, valid_citations, broken_citations,
citations_by_source }`. Phase 3b writes this validator summary into the
report's Block A header.

## Failure paths

The orchestrator (`phase3b-evaluator.mjs`) gates on 4 conditions in order:

1. `intelPack.jd.error === 'JD_SCRAPE_FAILED'` → write to rescrape queue,
   skip council, return early.
2. `!intelPack.jd.alive` (dead JD) → skip council, return early.
3. `!council.consensus.final_score` (all providers failed) → log
   per-provider error tags, skip citation pass, return early.
4. Citation validator returning `ok: false` → emit warning in report,
   not fatal.

If you add a new gate, add it BEFORE step 3 (council) — the LLM call is
the expensive step. The whole gate ladder exists to spare that cost
when the inputs can't produce a good eval.

## Wiring a new provider

To add a fourth provider (e.g., a frontier model variant or Grok-4):

1. Add the provider name to the default list in `lib/eval-council.mjs`
   (search for `const PROVIDERS_DEFAULT`).
2. Add a `COST_ESTIMATE` entry.
3. Implement the `_callX()` function alongside the existing `_callSonnet`,
   `_callOpus`, `_callGemini`. Return `{ provider, text, head, error,
   skipped, latency_ms, tokens, cost_est }`.
4. Wire the call into the `Promise.all` block.
5. Update the consensus reducer if the head shape differs (e.g., a
   different score scale needs normalization first).
6. Cost ladder check: 4 providers × default 1.5K output = budget impact.
   Document the new floor in the per-call comment.

## Wiring a new audit field

To add (e.g.) `recruiter_email_count` to the eval output:

1. Compute it in `gatherIntel` and add to `intelPack` (intel-side; no LLM).
2. Pass through to the council prompt template (so the LLM can use it).
3. Surface in the report — either as a Block A bullet or in the TSV note.
4. If the field is durable, surface in `data/jd-scrape-audit/` too via
   the same per-attempt write path used in `jd-rescrape-nightly.mjs`.

## Common pitfalls

- **Calling fetchJD twice in one pack.** The browser-pool tolerates
  concurrent calls but Playwright contexts are slow to spin up.
  `gatherIntel` calls it once at line 405; everything downstream reads
  `intelPack.jd.text`. Don't re-call.
- **Truncating text after the council prompt is built.** `STATIC_TEXT_CAP`
  and `RENDERED_TEXT_CAP` truncate at `fetchJD` time. The council prompt
  receives whatever's in `intelPack.jd.text` — already truncated. If a
  council provider returns "I don't have enough JD context," the bug
  is one of those caps being too low, not a per-provider issue.
- **Citation spans referring to renamed files.** `cv.md` is the canonical
  source; if you rename it, also update `eval-citation-validator.mjs:53`
  + the council prompt's citation-format instruction. Two places.
- **Consensus reducer + 2-provider runs.** The reducer's HIGH/MEDIUM/LOW
  logic assumes N=3. If you run with `--providers sonnet,opus` (N=2),
  it still produces an answer but the confidence label may be
  misleading. Document the override in the report's Block A.
- **Phase3b-evaluator's TSV write.** It writes to
  `batch/tracker-additions/<num>-<slug>.tsv`, ONE LINE per eval. Don't
  bypass `merge-tracker.mjs` to write directly to `data/applications.md` —
  the merge script handles the column swap + dedup. Order of columns in
  the TSV ≠ order in applications.md.

## Cross-references

- `data/jd-scrape-audit/README.md` — audit-trail JSONL format (P1.11).
- `AGENTS.md` § "TSV Format for Tracker Additions" — TSV write contract.
- `AGENTS.md` § "Offer Verification" — manual + headless verification rules.
- `CLAUDE.md` § cv.md audit trail — invariant for cv.md edits + archives.
- `~/.claude/knowledge/brain/bug-class-catalog.md` § "outer-template-unescape"
  — relevant when adding HTML emit to the report writer.
