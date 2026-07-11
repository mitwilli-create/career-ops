@AGENTS.md
<!-- Add anything Claude Code specific that other agents don't need -->

## Dashboard — public URL (MANDATORY for all dashboard work)

**The dashboard is publicly reachable at https://dashboard.careers-ops.com/**
- Infrastructure: Cloudflare Tunnel → localhost:3097, served by launchd-managed `dashboard-server.mjs`
- Find the PID: `ps aux | grep dashboard-server`

**Rules that apply to every dashboard edit, optimization, build, or rebuild:**
1. All links, test instructions, and external references MUST point at `https://dashboard.careers-ops.com/` — NEVER `localhost:3097`
2. Verify changes by hitting the public URL, not localhost
3. Handoff notes, PR descriptions, and commit messages must reference the public URL

## UI-Change Verification — MANDATORY (added 2026-05-19, enforced via hook)

**Every code change that can affect a visible UI surface MUST be verified live via Chrome MCP before being claimed done.** No exceptions. Applies to every Claude instance, every model, every version, every agent, every skill, every overnight haul subagent.

**This rule is enforced by a PostToolUse hook in `.claude/settings.json`.** The hook prints a reminder banner after every Edit / Write / MultiEdit on UI-affecting files. Do NOT dismiss the banner — action it.

Triggers (any one is enough):
- Edits to `scripts/build-dashboard.mjs`, `dashboard-server.mjs`, anything under `dashboard/`, any `*.html` or `*.css` file
- Edits to render-time code in `lib/*.mjs` that produces DOM
- Build-script changes that produce visible output
- Any "fix" responding to a user-reported visual issue

Required verification steps after the edit, BEFORE claiming done or committing:
1. `node scripts/build-dashboard.mjs` (or whatever build step applies)
2. `launchctl kickstart -k gui/$(id -u)/com.mitchell.career-ops.dashboard-server`
3. Open Chrome MCP, navigate to `https://dashboard.careers-ops.com/` (CF Access service token in `.env`) OR `https://staging-dashboard.careers-ops.com/` (Host-gated 2026-07-09 — send header `X-Staging-Token: $STAGING_DASHBOARD_TOKEN` from `.env`; without it the origin returns 403, closing the old no-auth crawler exposure). This authenticated staging target is the sanctioned exception to the "point at the public prod URL" rule above — it is the same dashboard, and verifying against it (with the token) is explicitly allowed.
4. Screenshot at **two widths minimum**: full (1440×900) AND narrow (≤900px) to catch responsive regressions
5. If the change touched table/layout CSS, run `mcp__Claude_in_Chrome__javascript_tool` to inspect computed styles on affected elements — `getBoundingClientRect()` + `getComputedStyle()` proves the visible width/height, not just the declared CSS
6. Only THEN commit and report done

**The screenshot IS the proof.** "Looks correct in source" is not sufficient. The 2026-05-19 role-column-collapse incident: three CSS fixes shipped in a row, each "looked right" in source, each produced 0-width column / vertical character wrap / silently-broken widgets in actual render. Only the fourth attempt — verified via Chrome MCP first — was correct. The lesson cost real user trust.

If Chrome MCP is unavailable in your context, say so explicitly + fall back to the fail-closed command below (staging is Host-gated as of 2026-07-09 — token in `.env`; unset token returns 403):

```bash
# Load the token from .env so this works in a fresh shell:
export STAGING_DASHBOARD_TOKEN="$(grep -E '^STAGING_DASHBOARD_TOKEN=' .env | cut -d= -f2-)"
test -n "$STAGING_DASHBOARD_TOKEN" || { echo "STAGING_DASHBOARD_TOKEN unset" >&2; exit 1; }
set -o pipefail
curl --fail --show-error --max-time 15 -H "X-Staging-Token: $STAGING_DASHBOARD_TOKEN" \
  https://staging-dashboard.careers-ops.com/ | grep -F 'EXPECTED_PATTERN'
```

Replace the quoted `EXPECTED_PATTERN` with the marker you expect (keep it quoted so the shell does not read `<...>` as input redirection). Do NOT skip verification silently.

**For overnight autonomous runs:** each subagent's report MUST include the Chrome MCP screenshot path(s) for any UI change it shipped. Reports without screenshots are NEEDS_HUMAN-AGAIN.

## PR Review Loop — CodeRabbit (STANDING, added 2026-07-10)

**Every change ships as a PR (branch protection blocks direct pushes to main — standalone commits to main are not a path), and every PR goes through the CodeRabbit review loop, run by Claude autonomously, end to end. Do NOT ask Mitchell to review, fix, re-review, or merge — these steps are pre-authorized.** Mitchell's directive 2026-07-10: "stop asking me to do these things." Precedent: PR #419 ran 4 CodeRabbit rounds to a clean pass before merge.

The loop:
1. Open the PR via `scripts/safe-gh-pr.sh` (never bare `gh pr create` — cross-fork safety).
2. Run a CodeRabbit review (the `/code-review` skill; CodeRabbit also auto-reviews PRs on open).
3. Fix every finding, or record a deliberate WONT-FIX with rationale in the PR thread and dismiss/resolve it there so it no longer counts as open.
4. Re-run the review. Repeat 3-4 until a round returns **0 unresolved findings** (documented WONT-FIXes are resolved, not open). **Bounded: max 6 rounds per PR** (`convergence-impossible-runaway-without-cap`). If the cap is hit, or the same finding survives 2 consecutive fix attempts, stop retrying and report the remaining blocker to Mitchell instead of looping.
5. Squash-merge once clean + CI green. Claude does the merge; do not hand it back.

**Fail closed:** the merge in step 5 requires a successfully COMPLETED review round with 0 unresolved findings that Claude can verify from the tool output. If the `/code-review` skill / CodeRabbit CLI is unavailable, the review errors out, or the result cannot be verified, do NOT merge — stop and report the blocker to Mitchell instead.

**Unconditional stop (no approval path):** personal User Layer data (`cv.md`, `data/applications.md`, `data/hm-intel/`, `apply-pack/`, anything the Data Contract marks User Layer) is NEVER staged, committed, or included in a PR — this is not something to ask about; it simply does not happen. Only stop and ask Mitchell for a decision when: (a) a finding requires a product decision only Mitchell can make, (b) an otherwise-permitted change is destructive or irreversible, or (c) CI is red for causes outside the PR. Independently stop and REPORT (no question pending, no merge) when the retry cap is reached, a finding survives 2 consecutive fix attempts, or review verification fails, as described above. Standing exemption: findings against `data/cv-archives/**` are documented false positives (frozen audit records — see § cv.md audit trail); never edit archives to satisfy a reviewer.

## cv.md audit trail (audit Item M, 2026-05-18)

`cv.md` is `.gitignore:2` — it is personal data that lives on disk only, NEVER tracked in git. The same applies to `data/applications.md`, `data/hm-intel/*.json`, `apply-pack/*`, and everything else listed in `.gitignore` for personal-data reasons.

**Expectation when an agent edits or trims `cv.md`:**

1. **Archive the pre-edit state first.** Before any trim or rewrite, copy the current `cv.md` to `data/cv-archives/cv-<YYYY-MM-DD>-<wordcount>w.md`. The archive path is NOT gitignored, so the archive IS committable via `scripts/agent-commit.mjs`. The diff between the archive and the current `cv.md` is the audit trail.
2. **Commit the archive via `scripts/agent-commit.mjs`**, with a message that names the upcoming change (e.g., `"archive: snapshot cv.md @ 1289w pre-Item-D-role-header-trim"`).
3. **Edit `cv.md` directly** — do not try to commit it. The helper detects gitignored files and refuses (correct behavior).
4. **Add a SESSION NOTES entry** in this file capturing the word-count delta + rationale (e.g., `"trimmed 4 role headers to fit single-line at 10.5pt bold; was 1,289w, still 1,289w (header-only edits)"`).
5. **Verify the change** via the Typst renderer + `pdftotext -layout` invariants (2-page hold, ATS keyword presence, no `\@`/`\#`/`(see cv.md)` leaks).

**Why this matters:** `cv.md` is the canonical source for evaluations, tailored variants, and the master PDF. A silent trim can dilute ATS keyword density, break downstream scoring, or remove signal a future tailoring pass needs. The archive + diff trail makes every change reversible without git.

The same expectation applies to `data/applications.md` (the canonical tracker) — but applications.md edits go through `merge-tracker.mjs` for new rows and direct Edit-tool patches for status/notes updates. There is no archive expectation for tracker edits since the status flow is itself the audit trail.

**Review-standards exemption for `data/cv-archives/**` (2026-07-07).** Archive files are frozen point-in-time records, NOT generated prose. Banned-phrase / retired-metric compliance rules (human, Claude, or automated reviewers such as Qodo — e.g. rule 1671597, which itself is derived from this file) do NOT apply inside `data/cv-archives/`. Occurrences of the retired phrases enumerated by those rules are historical record inside an archive; flagging or editing them falsifies the audit trail. Treat any automated finding against a file matching `data/cv-archives/**` as a documented false positive (precedent: PR #385 scrub policy, PR #394 merge). This exemption is path-scoped: it does NOT weaken those rules anywhere else in the repo.

## Session Notes

Session notes are maintained privately and are not part of this public snapshot.
