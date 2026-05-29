---
name: apply-pack-interview
description: Walk Mitchell through a one-question-at-a-time guided revision of an apply-pack for a specific role. Reads his career corpus + the role's intel + the current apply-pack artifacts, has Sonnet 4.6 generate 5-8 targeted revision questions, then asks them one at a time, then writes revised artifacts back to disk. Use when Mitchell says "let's polish the apply-pack for X via interview," "walk me through revising the apply-pack for X one question at a time," "/apply-pack-interview SLUG," or any phrasing that wants conversational revision (as opposed to /apply-pack-polish which is autonomous).
---

# /apply-pack-interview

Theme 7 PR 3 (2026-05-29) skill that orchestrates an interview-driven revision of one role's apply-pack materials. Differs from `/apply-pack-polish` (autonomous, no Mitchell input mid-flight) by walking him through targeted questions one at a time, then applying his answers.

## When to invoke

- Mitchell explicitly types `/apply-pack-interview <role-slug>`
- He says "let's polish the apply-pack for X one question at a time"
- He says "interview me about the X apply-pack"
- He says "guided revision for the X application"
- He says "walk me through fixing the cover letter for X with questions"

NOT for: bulk autonomous revision (use `/apply-pack-polish`); single-shot LLM rewrite without his input (just edit directly).

## Workflow (3 phases)

### Phase 1 — Plan

Generate the revision question list. ONE LLM call (~$0.05-0.15, Sonnet 4.6).

```bash
node scripts/agents/apply-pack-interview.mjs --plan <role-slug>
```

This:
1. Scans the career corpus via `lib/corpus-scanner.mjs`
2. Reads the apply-pack directory at `apply-pack/<role-slug>/`
3. Looks up the role in `data/apply-now-queue.json` for fit_rationale / top_gap context (falls back to slug-only metadata if not found)
4. Asks Sonnet 4.6 to generate 5-8 targeted revision questions
5. Saves state to `data/apply-pack-interview-<slug>.json`
6. Prints each question with id + target artifact

### Phase 2 — Interview (Claude orchestrates)

Read the state file. For each unanswered question:
1. Surface the question to Mitchell conversationally (with the `why` + `example_answer` for context)
2. Wait for his answer (he may answer briefly OR ask clarifying questions OR skip)
3. Write his answer into `state.answers[q.id]` via the Edit tool on the state JSON
4. Move to the next question

**Important UX rules:**
- ONE question per turn. Never batch.
- If Mitchell asks a clarifying question, answer + re-pose the original
- If Mitchell skips ("skip"/"pass"/"n/a"), record an empty string in `answers[q.id]` and move on
- If Mitchell wants to revise an earlier answer, find that q.id + Edit the answer field
- Use `--status <slug>` between questions to confirm progress

### Phase 3 — Apply

After all (or enough) questions are answered, run:

```bash
node scripts/agents/apply-pack-interview.mjs --apply <role-slug>
```

This:
1. Reads the interview state
2. Groups answers by target artifact (cv-tailored, cover-letter, etc.)
3. For each artifact with at least one answer, calls Sonnet 4.6 to produce a revised version (~$0.05-0.15 per artifact)
4. Writes the revised content back to `apply-pack/<slug>/<artifact>.md`
5. Updates `state.apply_log` with per-artifact result

Use `--dry-run` to preview without writing or LLM-calling.

## State shape

`data/apply-pack-interview-<slug>.json`:

```json
{
  "role_slug": "string",
  "role": { "company": "...", "role": "...", "fit_rationale": "...", "top_gap": "..." },
  "generated_at": "ISO timestamp",
  "model_used": "claude-sonnet-4-6",
  "plan_cost_usd": 0.0625,
  "questions": [
    {
      "id": "lead-with",
      "artifact": "cover-letter",
      "question": "What was the single most quantifiable outcome of the Google TechStop role you'd want this hiring manager to remember?",
      "why": "Cover letter opens generically; lead-with-impact opening would differentiate against the field.",
      "example_answer": "Q1 2020 — provisioned 9K machines + 9.5K hotspots in one week during the remote-work shift, 80% efficiency gain on self-provisioning"
    }
  ],
  "answers": { "lead-with": "..." },
  "apply_log": [],
  "last_applied_at": "ISO",
  "total_apply_cost_usd": 0.0
}
```

## Cost profile

Per Theme 6's verified May 2026 pricing (Sonnet 4.6 $3/$15 per million):
- `--plan`: ~$0.05-0.15 per role
- `--apply`: ~$0.05-0.15 per touched artifact (typical pack has 3-5 artifacts to revise)
- Full cycle: ~$0.20-0.90 per role end-to-end

Cap-aware via Theme 6's audit-log helper. No special env vars needed.

## Gotchas

- **State file is gitignored** under `data/apply-pack-interview-*.json` — personal data
- **Apply-pack edits are destructive** — the `--apply` step overwrites the artifact file. Run `--dry-run` first if uncertain, or copy `apply-pack/<slug>/` aside before applying
- **Stale plan**: if Mitchell takes >24h between `--plan` and answering, the role's `apply-now-queue` ranking may have shifted. Re-running `--plan` is safe (overwrites state) but loses any answers already collected. Document mid-interview pauses in the state file via Edit
- **No retry on revision failure**: if `--apply` errors on one artifact, that artifact is marked in `apply_log` but others still process. Re-run `--apply` after fixing the underlying issue

## Dependencies

- `lib/corpus-scanner.mjs` (Theme 7 PR 1, #327)
- `scripts/agents/position-ranker.mjs` (Theme 7 PR 2, #328 — `loadRoles` export)
- `lib/council.mjs` (existing — callCouncil for the LLM calls)

## Related skills

- `/apply-pack-polish` — autonomous polish (no interview); use when Mitchell doesn't want to guide the revision
- `/researcher` — pure research, no apply-pack revision
- `/corpus-audit` — audits the corpus itself, not specific apply-packs

## Bucket B / DRAFT

Per Q4 — depends on `lib/council.mjs` (production surface, imported only). New files. Mitchell reviews + merges PR 3 last in the Theme 7 chain.
