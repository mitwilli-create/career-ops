# Weekly Calibration Ingest — paste-and-send template

**How to use (weekly, ~2 min):**
1. On the dashboard sidebar, click **Copy prompt** on the Weekly Calibration card → paste into Gemini → answer the questions.
2. Copy Gemini's final `# Career-Ops Calibration Response — YYYY-MM-DD` block.
3. Copy this whole file, paste that block where marked below, and send it to Claude in the career-ops session.
4. Claude actions every section into the right file and shows you a **diff to approve before anything commits**.

This replaces the dashboard "Update Drawer" path, which only ingests one-line career wins and cannot parse the 7-section calibration response.

---

>>> PASTE GEMINI OUTPUT BETWEEN THE MARKERS, THEN SEND >>>

```
=== CALIBRATION RESPONSE START ===

(paste the full "# Career-Ops Calibration Response — YYYY-MM-DD" block here)

=== CALIBRATION RESPONSE END ===
```

---

## Claude: execute the Weekly Calibration Ingest

You are actioning Mitchell's weekly Gemini calibration response (pasted above). Apply each section per the routing below. **Make NO git commit until you show a unified diff and Mitchell approves.** Honor repo rules throughout: `cv.md` archive-before-edit ritual (copy to `data/cv-archives/cv-<DATE>-<Nw>.md` first, then re-render + verify 2-page hold + 0 leak artifacts); **no em dashes** in any prose you write; **no banned words** ("kill" → "banned-phrase checklist"); status/notes edits to `data/applications.md` go via direct Edit (NEVER add new rows there — new roles go through a TSV + `merge-tracker.mjs`).

| Section | Verbs | Action |
|---|---|---|
| **1. Open evaluations** | APPLY / DISCARD / HOLD | APPLY → add note `APPLY (calibration <DATE>): <reason>` to the row + confirm it's apply-now eligible, and list it for an apply-pack build. DISCARD → set status `Discarded` + reason note. HOLD → add note `HOLD until <trigger>`. |
| **2. Compensation refresh** | $base / $TC / source / date, or SKIP | Update the row's comp note in `data/applications.md` AND the matching `data/hm-intel/<slug>.json` comp field; stamp the source + date. SKIP → leave untouched, note "comp defer — intel refresh". |
| **3. Skills vs CV** | ADD / LEARN / IGNORE | ADD → archive `cv.md`, add the proof point, re-render + verify. LEARN → append to `data/python-sprint.md` (or the learning log) with the target ship date. IGNORE → record in `modes/_profile.md` so the skill-gap detector stops surfacing it. |
| **4. Hiring-manager sign-off** | CONFIRM / REPLACE / DROP | CONFIRM → mark the contact validated in `data/hm-intel/<slug>.json`. REPLACE → swap the lead contact (name + title) in that file. DROP → set the role status `Discarded` + reason. |
| **5. Pipeline + headspace** | free text | Append to the most recent `data/career-calibration-*.md` (or create this week's) as the running context brief. |
| **6. What surprised you** | free text | Log to `modes/_profile.md` under "Calibration signals". Do NOT silently change scoring code — surface a recommendation for any weight/archetype shift. |
| **7. Anything else** | open mic | Triage into concrete actions: do the safe ones, `spawn_task` the larger ones, list exactly what you did vs. parked. |

**Finally:** mark the week answered so the dashboard nag clears — set `last_prompt_answered` to the response date in `data/calibration-state.json` (or `POST /api/calibration/answered`). Then give a wins-first recap: what changed, what's queued for apply-pack, what was parked.

---

*Source of truth for the question generator: `scripts/weekly-calibration-prompt.mjs`. Regenerate the weekly prompt manually with `node scripts/weekly-calibration-prompt.mjs`.*
