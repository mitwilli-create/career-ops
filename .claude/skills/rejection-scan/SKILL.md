---
name: rejection-scan
description: Scan Mitchell's Gmail for new job-application rejections, record them to the rejection ledger, and apply the rejection gate so no JD he's already been rejected from gets surfaced or ranked. AUTO-FIRES (do not wait to be asked) whenever Mitchell asks to provide new JDs, rank/score JDs, suggest roles, or decide where to spend his job-search effort. Also invokable directly as /rejection-scan.
---

# Rejection scan + gate

**Auto-trigger:** before answering ANY request to surface new JDs, rank/score JDs, recommend roles, or allocate job-search effort, run this scan FIRST and apply its output. Never present a ranked or suggested list that contains a role Mitchell has already been rejected from. Born 2026-06-26 from a real near-miss incident.

## Procedure
1. **Live Gmail sweep** — Gmail MCP `search_threads`. Run the queries printed by `node scripts/rejection-scan.mjs --queries`. Triage:
   - **Rejection** = recruiter/ATS email whose body decides NOT to move forward ("decided not to move forward", "other candidates", "position has been filled", "regret to inform", "different direction", "Application feedback").
   - **NOT a rejection** (do not record): application *confirmations* ("thank you for applying", "we received your application"), interview invites / next-steps, recruiter outreach, and any layoff/offboarding notice from a CURRENT employer.
2. **Record** each NEW rejection:
   `node scripts/rejection-scan.mjs --add --company "X" --role "Y" --date YYYY-MM-DD --function <comms|editorial|devrel|program-manager|product-marketing|product-manager|solutions> --source gmail`
   (dedupes automatically against the ledger).
3. **Load the gate:** `node scripts/rejection-scan.mjs --json` for the full exclusion set, or `--check "Company" "Role"` for a single candidate.
4. **Apply to the ranking** by verdict:
   - **EXCLUDE** — exact (company+role) already rejected → drop it; never surface.
   - **SUPPRESS** — same company + same function within the 90-day cooldown (same org/recruiter just passed) → keep it off the active list; mention once with context only if directly relevant.
   - **ALLOW + ANNOTATE** — a different function at a rejecting company, or cooldown expired → keep it, but surface the prior rejection so the call is informed.
   - **CLEAR** — no prior rejection → normal.
5. **Show your work:** put a one-line "rejection gate ran" note in the deliverable (e.g., "Rejection gate ran; suppressed roles excluded").

## Sources of truth
- `data/rejections.jsonl` — append-only ledger (canonical).
- `data/applications.md` rows with status `Rejected` — also honored (merged, deduped).

## Tone (tone-safe)
Rejections are forward-looking signal about fit and gatekeepers, never failure. Record company/role/date and move on — do not re-read or dwell on rejection-email bodies. Never flag fixable "errors" in already-submitted materials.
