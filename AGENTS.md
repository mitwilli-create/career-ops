# Career-Ops -- AI Job Search Pipeline

> **Lane rules (Codex, read first):** `~/Documents/mission-control/WORKSPACE.md` defines the multi-agent lanes for this machine. Your lane here (Codex) is building; Claude Code reviews your output and owns orchestration/memory; CodeRabbit reviews commits and PRs automatically. Non-negotiable in this repo: the gitignored personal data (`cv.md`, `data/applications.md`, `data/hm-intel/`, `apply-pack/`, and everything else the Data Contract marks User Layer) must NEVER be committed, and cross-fork PRs use `safe-gh-pr.sh`, never bare `gh pr create`. Stage files explicitly; never `git add -A`.

## Origin

This system was built and used by [santifer](https://santifer.io) to evaluate 740+ job offers, generate 100+ tailored CVs, and land a Head of Applied AI role. The archetypes, scoring logic, negotiation scripts, and proof point structure all reflect his specific career search in AI/automation roles.

The portfolio that goes with this system is also open source: [cv-santiago](https://github.com/santifer/cv-santiago).

**It will work out of the box, but it's designed to be made yours.** If the archetypes don't match your career, the modes are in the wrong language, or the scoring doesn't fit your priorities -- just ask. You (AI Agent) can edit the user's files. The user says "change the archetypes to data engineering roles" and you do it. That's the whole point.

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/_shared.md`, `modes/oferta.md`, all other modes
- `AGENTS.md`, `CLAUDE.md`, `*.mjs` scripts, `dashboard/*`, `templates/*`, `batch/*`

**THE RULE: When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.** This ensures system updates don't overwrite their customizations.

## Decision-Maximization Policy (quality-first)

Mitchell's stated decision pattern: **"I almost always choose the most robust, quality, and costly option — despite time needed to complete or spend."**

When acting autonomously in this repo:
- Quality > speed > cost. No "MVP" shortcuts. No "sensible default" downgrades.
- Council fan-out: full lineup, no subsets — unless an explicit cost cap is in force.
- Researcher: engage Gemini Deep Research Max when applicable. `--no-skip-deep`.
- Cache TTLs: 3 days (not 7). Re-validate aggressively.
- Persona dialogue: 5+ rounds, adversarial sweep on convergence. Convergence-on-praise without dissent is a failure signal — restart with adversarial framing.
- Persist the rationale for any quality-vs-cost trade-off in the deliverable, so future runs can audit.

Established 2026-05-19 by ALPHA overnight instance per `data/overnight-haul-2026-05-19.md` Global Charter § Decision-Maximization Policy.

## Update Check

On the first message of each session, run the update checker silently:

```bash
node update-system.mjs check
```

Parse the JSON output:
- `{"status": "update-available", "local": "1.0.0", "remote": "1.1.0", "changelog": "..."}` → tell the user:
  > "career-ops update available (v{local} → v{remote}). Your data (CV, profile, tracker, reports) will NOT be touched. Want me to update?"
  If yes → run `node update-system.mjs apply`. If no → run `node update-system.mjs dismiss`.
- `{"status": "up-to-date"}` → say nothing
- `{"status": "dismissed"}` → say nothing
- `{"status": "offline"}` → say nothing
- `{"status": "no-remote-version"}` → say nothing (checker reached GitHub but neither VERSION nor the latest release tag parsed as semver — treat as a silent non-failure, same as offline)

The user can also say "check for updates" or "update career-ops" at any time to force a check.
To rollback: `node update-system.mjs rollback`

## What is career-ops

AI-powered, CLI-agnostic job search automation: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing. Runs on any AI coding CLI that follows the [open agent skill standard](https://agentskills.io) (Claude Code, Codex, Gemini, OpenCode, Qwen, Copilot, Kimi).

### Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and company config |
| `templates/cv-template.html` | HTML template for CVs |
| `templates/cv-template.tex` | LaTeX/Overleaf template for CVs |
| `generate-pdf.mjs` | Playwright: HTML to PDF |
| `generate-latex.mjs` | LaTeX CV validator + pdflatex compiler |
| `article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel reports |
| `analyze-patterns.mjs` | Pattern analysis script (JSON output) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON output) |
| `data/follow-ups.md` | Follow-up history tracker |
| `scan.mjs` | Zero-token portal scanner — hits Greenhouse/Ashby/Lever APIs directly, zero LLM cost |
| `check-liveness.mjs` | Job posting liveness checker |
| `liveness-core.mjs` | Shared liveness logic (expired signals win over generic Apply text) |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`). Blocks A-F + G (Posting Legitimacy). Header includes `**Legitimacy:** {tier}`. |
| `apply-pack/<slug>/` | **Canonical apply-pack tree.** Per-role tailored CV / cover letter / form fields / impact doc / references / referrals artifacts. ~44 packs on disk. Gitignored personal data — never committed. Legacy alias `data/apply-packs/<slug>/` was unified into this path by PR-01 (2026-05-25) — see `scripts/quarantine/apply-pack-path-unify.mjs`. |
| `apply-pack/<slug>/<artifact>.json` | **Schema-typed artifact source of truth (L6, 2026-05-26, PR #285).** JSON is the source of truth; `.md` is a rendered view. Dashboard reads `.json` first, falls back to `.md+marked` if absent. 7 artifacts per pack: `form-fields`, `cv-tailored`, `cover-letter`, `linkedin-dm`, `impact-doc`, `references`, `referrals`. Validated against `lib/schemas/<artifact>.schema.json` (JSON Schema Draft 2020-12, `additionalProperties:false`). |
| `lib/schemas/` | JSON Schema definitions for all 8 apply-pack artifact types: `_base-artifact.schema.json` + one per artifact. Used by `ajv` in all 7 agent scripts and in `scripts/backfill-apply-pack-json.mjs`. |
| `lib/write-apply-pack-artifact.mjs` | Shared helper used by all 7 agents: validates JSON against schema, writes `<artifact>.json`, renders `<artifact>.md` via a passed render function, returns `{ jsonPath, mdPath }`. |
| `scripts/backfill-apply-pack-json.mjs` | One-time backfill (also usable on-demand): reads `<artifact>.md`, dispatches to artifact-specific parser, validates, writes `<artifact>.json`. Flags: `--dry-run`, `--apply`, `--pack <slug>`, `--artifact <type>`. Parser failures logged to `.claude/audit/l6-backfill-2026-05-26/parser-failures.md` and skipped. |

#### Network database — architecture collapse note (retroactive, 2026-05-19 ZETA)

The 2026-05-19 overnight ZETA brief (see `data/overnight-coordination-2026-05-19.md` line 27) specified a 2-lib design splitting network-database concerns across `lib/network-database.mjs` (core store) and `lib/network-database-search.mjs` (search index). The landed state intentionally collapsed to 1 lib + 1 scripts file: `lib/network-database-search.mjs` (~20KB) holds both the store and search surface, and `scripts/build-network-database.mjs` (~26KB) acts as the aggregator that re-reads emails from CSV + `data/contacts-enriched.json` with confidence bands. No `lib/network-database.mjs` was ever created — the file appears in the ownership matrix but not on disk. The decision was undocumented in any ZETA handover entry (final entry at line 136 lists "2 lib" in the files-landed tally but does not name them or flag the collapse), so this note retroactively records the call. Functional workaround is in place — every caller (`scripts/agents/network-enricher.mjs`, `scripts/agents/network-emailer.mjs`, `dashboard-server.mjs` `/api/network/*` endpoints, `dashboard/network-database.{html,js}`) routes through `network-database-search.mjs` plus the aggregator script, and live verification on 2026-05-19 confirmed `/api/network/headline` 194/838 + `/api/network/search?q=anthropic` 45 hits in 43ms. Tagged GAP-RES-04 under the audit V2 closed 2026-05-24 as SCOPE-CHANGED-UNAUTH (Phase 3 day-19) — architecture diverged from spec without a documented decision; this paragraph closes the audit.

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

1. Does `cv.md` exist?
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `modes/_profile.md` exist (not just _profile.template.md)?
4. Does `portals.yml` exist (not just templates/portals.example.yml)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently. This is the user's customization file — it will never be overwritten by updates.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place. Guide the user step by step:

#### Step 1: CV (required)
If `cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste your LinkedIn URL and I'll extract the key info
> 3. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `cv.md` from whatever they provide. Make it clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml` with their answers. For archetypes and targeting narrative, store the user-specific mapping in `modes/_profile.md` or `config/profile.yml` rather than editing `modes/_shared.md`.

#### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with 45+ pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 5: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context. The more you know, the better your evaluations will be:

> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter. Think of it as onboarding a recruiter — the first week I need to learn about you, then I become invaluable."

Store any insights the user shares in `config/profile.yml` (under narrative), `modes/_profile.md`, or in `article-digest.md` if they share proof points. Do not put user-specific archetypes or framing into `modes/_shared.md`.

**After every evaluation, learn.** If the user says "this score is too high, I wouldn't apply here" or "you missed that I have experience in X", update your understanding in `modes/_profile.md`, `config/profile.yml`, or `article-digest.md`. The system should get smarter with every interaction without putting personalization into system-layer files.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a job URL to evaluate it
> - Run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) to search portals
> - Run `/career-ops` to see all commands
>
> Everything is customizable — just ask me to change anything.
>
> Tip: Having a personal portfolio dramatically improves your job search. If you don't have one yet, the author's portfolio is also open source: github.com/santifer/cv-santiago — feel free to fork it and make it yours."

Then suggest automation:
> "Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring `/career-ops scan` (or `/career-ops-scan` if using OpenCode). If those aren't available, suggest adding a cron job or remind them to run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) periodically.

### Personalization

This system is designed to be customized by YOU (AI Agent). When the user asks you to change archetypes, translate modes, adjust scoring, add companies, or modify negotiation scripts -- do it directly. You read the same files you use, so you know exactly what to edit.

**Common customization requests:**
- "Change the archetypes to [backend/frontend/data/devops] roles" → edit `modes/_profile.md` or `config/profile.yml`
- "Translate the modes to English" → edit all files in `modes/`
- "Add these companies to my portals" → edit `portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV template design" → edit `templates/cv-template.html`
- "Adjust the scoring weights" → edit `modes/_profile.md` for user-specific weighting, or edit `modes/_shared.md` and `batch/batch-prompt.md` only when changing the shared system defaults for everyone

### Language Modes

Default modes are in `modes/` (English). Additional language-specific modes are available:

- **German (DACH market):** `modes/de/` — native German translations with DACH-specific vocabulary (13. Monatsgehalt, Probezeit, Kündigungsfrist, AGG, Tarifvertrag, etc.). Includes `_shared.md`, `angebot.md` (evaluation), `bewerben.md` (apply), `pipeline.md`.
- **French (Francophone market):** `modes/fr/` — native French translations with France/Belgium/Switzerland/Luxembourg-specific vocabulary (CDI/CDD, convention collective SYNTEC, RTT, mutuelle, prévoyance, 13e mois, intéressement/participation, titres-restaurant, CSE, portage salarial, etc.). Includes `_shared.md`, `offre.md` (evaluation), `postuler.md` (apply), `pipeline.md`.
- **Japanese (Japan market):** `modes/ja/` — native Japanese translations with Japan-specific vocabulary (正社員, 業務委託, 賞与, 退職金, みなし残業, 年俸制, 36協定, 通勤手当, 住宅手当, etc.). Includes `_shared.md`, `kyujin.md` (evaluation), `oubo.md` (apply), `pipeline.md`.
- **Turkish (Turkey market):** `modes/tr/` — native Turkish translations with Turkey-specific vocabulary (SGK, kıdem tazminatı, ihbar süresi, brüt/net maaş, AGİ, BES, yemek kartı, yol yardımı, TÜFE zammı, etc.). Includes `_shared.md`, `is-ilani.md` (evaluation), `basvuru.md` (apply), `pipeline.md`.

**When to use German modes:** If the user is targeting German-language job postings, lives in DACH, or asks for German output. Either:
1. User says "use German modes" → read from `modes/de/` instead of `modes/`
2. User sets `language.modes_dir: modes/de` in `config/profile.yml` → always use German modes
3. You detect a German JD → suggest switching to German modes

**When to use French modes:** If the user is targeting French-language job postings, lives in France/Belgium/Switzerland/Luxembourg/Quebec, or asks for French output. Either:
1. User says "use French modes" → read from `modes/fr/` instead of `modes/`
2. User sets `language.modes_dir: modes/fr` in `config/profile.yml` → always use French modes
3. You detect a French JD → suggest switching to French modes

**When to use Japanese modes:** If the user is targeting Japanese-language job postings, lives in Japan, or asks for Japanese output. Either:
1. User says "use Japanese modes" → read from `modes/ja/` instead of `modes/`
2. User sets `language.modes_dir: modes/ja` in `config/profile.yml` → always use Japanese modes
3. You detect a Japanese JD → suggest switching to Japanese modes

**When to use Turkish modes:** If the user is targeting Turkish-language job postings, lives in Turkey, or asks for Turkish output. Either:
1. User says "use Turkish modes" → read from `modes/tr/` instead of `modes/`
2. User sets `language.modes_dir: modes/tr` in `config/profile.yml` → always use Turkish modes
3. You detect a Turkish JD → suggest switching to Turkish modes

**When NOT to:** If the user applies to English-language roles, even at French, German, Japanese, or Turkish companies, use the default English modes — *unless* the user has explicitly requested another mode in this conversation, or `language.modes_dir` is set in `config/profile.yml` (the explicit user preference always wins over JD-language detection).

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate offer | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or application cadence | `followup` |

### CV Source of Truth

- `cv.md` in project root is the canonical CV
- `article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** -- read them from these files at evaluation time

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and apply to roles where there is a genuine match -- not to spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, explicitly recommend against applying. The user's time and the recruiter's time are both valuable. Only proceed if the user has a specific reason to override the score.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Rejection Gate (added 2026-06-26)

Before any flow that **surfaces new JDs, ranks/scores JDs, suggests roles, or allocates job-search effort**, run the rejection gate FIRST and apply it. NEVER present a ranked or suggested list containing a role the user has already been rejected from. (Born 2026-06-26 from a real near-miss incident.)

- **Skill:** `/rejection-scan` (`.claude/skills/rejection-scan/SKILL.md`) -- auto-fires on the triggers above; also manually invokable.
- **Ledger (canonical):** `data/rejections.jsonl` (append-only) + rows with status `Rejected` in `data/applications.md`.
- **Helper:** `node scripts/rejection-scan.mjs` (summary) · `--json` (exclusion set) · `--check "Company" "Role"` (per-candidate verdict) · `--add --company X --role Y --date YYYY-MM-DD` (record one) · `--queries` (Gmail sweep queries).
- **Verdicts:** `EXCLUDE` exact (company+role) permanently · `SUPPRESS` same-company + same-function within the 90-day cooldown · `ALLOW + ANNOTATE` other roles at a rejecting company (surface the prior rejection) · `CLEAR` otherwise.
- The live Gmail sweep is Claude-MCP-driven (the script is the deterministic ledger+tracker reader). tone-safe: rejections are forward signal, never failure; a current-employer layoff/offboarding notice is NOT an application rejection.

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (headless mode):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---

## Background Agent Completion — Correct Pattern (added 2026-05-23)

**NEVER poll a file to detect background agent completion.** The harness sends a completion notification automatically via the Agent tool when a `run_in_background: true` call finishes. Polling a file that the agent was expected to write has no timeout and no fallback — if the file never arrives (error path, different output location, agent completed without writing it), the loop runs forever. The session appears alive but is deadlocked.

**Canonical incident:** 2026-05-23 `council-of-models` agent was spawned with `run_in_background: true`. The main session entered a shell polling loop waiting for `council-supplemental-20260523-204756.json`. The supplemental file path referenced a naming convention the agent used for that specific run; on different error paths the file never materialized. Session deadlocked; had to be detected and exited manually.

### Correct pattern — use the harness notification

```bash
# WRONG — do NOT do this. No timeout. No fallback. Deadlocks if file never arrives.
until [[ -f ~/.claude/agents/runs/council-supplemental-${TS}.json ]]; do sleep 20; done
```

Instead: spawn with `run_in_background: true`, then continue other work. The harness will notify you automatically when the agent completes. The agent's return value is available in the notification — read it directly, do not poll for a sidecar file.

### If a file handoff is unavoidable — mandatory timeout pattern

Some orchestration patterns genuinely need to wait for a file (e.g., a long-running background script that writes a JSON report). In those cases ONLY, use this pattern — NEVER the bare `until` loop:

```bash
# CORRECT — always add DEADLINE arithmetic + explicit fallback when file handoff is unavoidable.
SUPPLEMENTAL_FILE="${HOME}/.claude/agents/runs/council-supplemental-${TS}.json"
DEADLINE=$(( $(date +%s) + 600 ))   # 10-minute max

until [[ -f "$SUPPLEMENTAL_FILE" ]] || (( $(date +%s) > DEADLINE )); do
  sleep 20
done

if [[ ! -f "$SUPPLEMENTAL_FILE" ]]; then
  echo "WARNING: Supplemental file not written within 10 min — proceeding with partial data"
  # REQUIRED: define what "proceeding with partial data" means concretely for this task.
  # Do NOT leave this as a no-op. The fallback must produce a usable (if incomplete) result.
fi
```

**Rules for this pattern:**
1. `DEADLINE` is always set before the loop, never inside it.
2. 10 minutes is the default max. Shorter is better. Never open-ended.
3. The fallback branch MUST be concrete — not "echo and continue" into undefined state. Decide before you poll what "file not available" means for your synthesis step and implement that branch.
4. Log the timeout as a WARNING in any report or handover document so the next instance knows data may be partial.

### When to audit for this pattern

Scan any orchestration prompt you write for `until [[ -f` or `while [[ ! -f` before saving it. If you find a bare polling loop without a `DEADLINE` guard, rewrite it before proceeding. The same applies to continuation prompts and handoff documents passed to fresh instances — those instances will execute the polling pattern as written.

---

## UI-Change Verification -- MANDATORY (added 2026-05-19, hook-enforced)

**Every code change that can affect a visible UI surface MUST be verified live via Chrome MCP before being claimed done.** Applies to every agent, every subagent spawned by orchestrators, every overnight haul instance, every persona. No exceptions.

A PostToolUse hook in `.claude/settings.json` fires after every Edit / Write / MultiEdit on UI-affecting files (`build-dashboard.mjs`, `dashboard-server.mjs`, `dashboard/*`, `*.html`, `*.css`, render-time `lib/*.mjs`). The hook prints a reminder banner with the required verification sequence. The banner is NOT optional — action it.

**Required sequence after editing any UI-affecting file:**
1. `node scripts/build-dashboard.mjs`
2. `launchctl kickstart -k gui/$(id -u)/com.mitchell.career-ops.dashboard-server`
3. Chrome MCP: navigate to `https://dashboard.careers-ops.com/` (CF Access service token in `.env`) OR `https://staging-dashboard.careers-ops.com/` (Host-gated 2026-07-09 — send request header `X-Staging-Token: $STAGING_DASHBOARD_TOKEN` from `.env`; without it the origin returns 403, closing the old no-auth crawler exposure)
4. Screenshot at **two widths minimum**: 1440×900 AND ≤900px to catch responsive regressions
5. For table/layout CSS: also run `mcp__Claude_in_Chrome__javascript_tool` with `getBoundingClientRect()` + `getComputedStyle()` queries on the affected elements — DOM-level proof, not just declared CSS
6. Only THEN commit and report

**Agent report requirement:** every agent that ships a UI change MUST attach the Chrome MCP screenshot path(s) to its deliverable. Reports without screenshots are tagged NEEDS_HUMAN-AGAIN and re-queued.

**Why this rule exists:** the 2026-05-19 role-column-collapse incident. Three consecutive CSS fixes "looked right" in source but produced 0-width columns / vertical character wrap / silently-broken widgets in actual render. Only the fourth fix — Chrome-MCP-verified first — was correct. The lesson cost real user trust.

**Fallback if Chrome MCP is unavailable in headless / batch context** (staging is Host-gated as of 2026-07-09 — the token lives in `.env` and the gate fails closed, so an unset token returns 403):

```bash
# Load the token from .env so this works in a fresh shell:
export STAGING_DASHBOARD_TOKEN="$(grep -E '^STAGING_DASHBOARD_TOKEN=' .env | cut -d= -f2-)"
test -n "$STAGING_DASHBOARD_TOKEN" || { echo "STAGING_DASHBOARD_TOKEN unset" >&2; exit 1; }
set -o pipefail
curl --fail --show-error --max-time 15 -H "X-Staging-Token: $STAGING_DASHBOARD_TOKEN" \
  https://staging-dashboard.careers-ops.com/ | grep -F 'EXPECTED_PATTERN'
```

Replace the quoted `EXPECTED_PATTERN` with the marker you expect (keep it quoted so the shell does not read `<...>` as input redirection). `--fail` makes an HTTP error a non-zero exit and `pipefail` propagates it. Document the fallback explicitly in the agent report; do NOT skip verification silently.

---

## Storage-state + Gmail-client drift (Phase C+ requirement)

Phase C ships dark-first emails. More of the Gmail-inversion edge cases now get
hit because the default styling is dark. If you ever observe "the email looks
weird on iOS today," check two independent drift sources:

1. `data/linkedin-storage-state.json` — Playwright storage state for the
   Chrome MCP LinkedIn scraping. If this expires or rotates, dashboard-driven
   contact-enrichment flows may degrade silently. Refresh via
   `node scripts/scrape-contact-photo.mjs --setup-auth` (there is no
   standalone `scripts/setup-auth.mjs` — doc drift fixed 2026-07-08).

2. Gmail web client behavior — Google rolls dark-mode rendering changes
   independently of any code change. The `<meta name="color-scheme" content="light dark">`
   tag in templates/heartbeat.mjml is the contract that signals intentional
   dark styling, but Gmail's rollout cadence can still surprise. If a single
   day's email renders unexpectedly, take a Chrome MCP screenshot at
   1440×900 AND 375×812 of the staging preview, compare against the prior
   day's archive, and isolate whether the change is in the code or in
   Gmail's rendering.

---

## CI/CD and Quality

- **GitHub Actions** run on every PR: `test-all.mjs` (63+ checks), auto-labeler (risk-based: 🔴 core-architecture, ⚠️ agent-behavior, 📄 docs), welcome bot for first-time contributors
- **Branch protection** on `main`: status checks must pass before merge. No direct pushes to main (except admin bypass).
- **Dependabot** monitors npm, Go modules, and GitHub Actions for security updates
- **Contributing process**: issue first → discussion → PR with linked issue → CI passes → maintainer review → merge

### Env-var conventions

`.env.example` documents every project env var with rationale + safe default. Newly added 2026-05-20 for P0.6 + P0.7:

| Variable | Default | Purpose |
|---|---|---|
| `BATCH_CANCEL_TIMEOUT_MS` | `125000` | Graceful-cancel window for an in-flight batch before SIGKILL fires. Must be ≥ `lib/anthropic-batch-helper.mjs`'s `AbortSignal.timeout(120_000)`; 125s = 5s safety margin. |
| `BATCH_CANCEL_WARN_THRESHOLD_USD` | `10` | Spend amount above which the Cancel-batch button opens a single-confirm dialog. Below this, cancel is instant with disabled "Stopping…" button state. v2 work — see `data/decisions-pending-2026-05-20.md § P0.7 v2`. |
| `DASHBOARD_WEIGHT_WARN_BYTES` | `12582912` (12 MB) | P2.16 build-weight gate (2026-05-20) — soft warning ceiling for minified `dashboard/index.html`. Build prints `console.warn` over this but continues. Catches inline-payload-bloat regression (`~/.claude/knowledge/brain/bug-class-catalog.md § inline-payload-bloat`). |
| `DASHBOARD_WEIGHT_FAIL_BYTES` | `15728640` (15 MB) | Hard-fail ceiling for minified dashboard. Build exits non-zero over this. Bypass via `DASHBOARD_SKIP_WEIGHT_GATE=1` (emergency only). |
| `REGRESSION_GUARD_ENABLED` | `true` | Kill switch for the regression-guard agent. Set to `false` to no-op the daily 06:00 PT scheduled run. See `scripts/agents/regression-guard.mjs` + `.claude/skills/regression-guard/SKILL.md`. |
| `REGRESSION_GUARD_AUTO_ACTION` | `false` | Locked default per dealbreaker-final § Audit Item 4 — wider scope = wider FP surface. Flip via `launchctl setenv REGRESSION_GUARD_AUTO_ACTION true` ONLY after running Opus's 5-question dialogue script against yourself. |
| `REGRESSION_GUARD_DAILY_USD` | `20` | Daily spend cap on the regression-guard agent. **Mitchell's locked override** of the dealbreaker's $10 — Decision-Maximization Policy quality-first. Hard-stop CRIT on breach. |
| `REGRESSION_GUARD_PER_CALL_WARN_USD` | `5` | **SOFT warning only** — does NOT block. Mitchell's locked decision (removes the dealbreaker's $3 HARD per-call sub-cap). Logs `WARN: per-call cost exceeded $5 — review the run` + surfaces in decision doc. |
| `STRATEGY_CEILING_GROUNDED_MODE` | `1` | Rollback gate for the RAG-grounded popouts (`lib/ground-prompt.mjs` powers alignment / interview-likelihood / hm-chance / team-health drawer popouts). `1` = grounded (default). `0` = instant revert to v0 generic prompt shape — no code change, takes effect on next popout call. Locked decision #6 (popout-grounding /feedback 2026-05-23) — rollback via env-flag is the required safety lock. |
| `STRATEGY_CEILING_VOICE_CLASSIFIER` | `0` | Opt-in Q3 Layer-3 LLM voice classifier on cache writes. Default off so popouts don't pay the ~$0.005 Haiku classifier call without explicit consent. Flip to `1` to attach `_voice_score` telemetry to written strategy-ceiling cache entries (best-effort — classifier failures never block result). |
| `PERSONA_VERIFY_HAMILTON` | `true` | **Catalog-aware-personas Wave 2 (2026-05-28).** Kill switch for the Margaret Hamilton persona fan-in inside `/bug-resolver` verify phase. When `true` (default), Hamilton runs in parallel with Gemini Flash; conflict (Hamilton HIGH + Flash non-HOLD) escalates the bug to `NEEDS_HUMAN`. Set `false` to revert to single-voice Flash verify. See `lib/bug-resolver/pipeline.mjs` Phase 6 (Verify) + `lib/council-personas.mjs::margaret-hamilton`. |
| `PERSONA_OMEGA_REVIEW` | (unset = on) | **Catalog-aware-personas Wave 2 (2026-05-28).** Kill switch for the DHH/Howard/Hickey conditional review in `/omega-steward` Phase 4. When `false`, the persona pass is skipped entirely (no DHH critique of new-agent proposals, no Howard library-reuse pushback, no Hickey contract-drift advisory). Default behavior: on. See `lib/persona-omega-review.mjs`. |
| `VOICE_CORPUS_GROWER_ENABLED` | `true` | **Placeholder** (Pending-tools sprint 2026-05-24, item G14). Kill switch for the voice-corpus-grower agent. Script does NOT read this flag yet — reserved for future runtime hook. Effective kill switch today: `launchctl disable gui/$(id -u)/com.mitchell.career-ops.voice-corpus-grower`. Plist ships LOADED-BUT-DISABLED; enable after manual first-run review per `data/instance-g-pending-tools-plan-2026-05-24.md § G14`. |
| `POLISH_MAX_ROUNDS` | `6` | Per-artifact hard cap on TOTAL polish rounds across outer attempts. Added 2026-05-24 after the convergence-impossible-runaway incident (PID 45655, 82 min wall-clock, $8.27 spent on row #48, never converged). Previously `maxRounds=6` INNER × `outerRetries=3` = 18 effective rounds was possible. Now strictly capped at this number TOTAL. When the cap is hit before convergence, the artifact returns `abandoned: true, abandon_reason: 'max-rounds-exceeded'` and the loop exits. Safety clamp [1, 30]. Override via CLI `--max-rounds <N>` or `opts.maxRoundsPerArtifact`. |
| `POLISH_COST_WARN_USD` | `5` | Soft warning threshold. **Informational only as of 2026-05-25** (was force-abandon 2026-05-24; reverted per bug-2026-05-25-022 — the per-pack force-abandon was destroying every pack whose natural polish cost exceeded $5). Per-artifact (`lib/polish-loop.mjs`): NDJSON WARN line emitted to stderr every round after total artifact cost crosses this. Per-pack (`scripts/agents/apply-pack-polish.mjs`): emits ONE `cost-warn-threshold-crossed` progress event with `will_force_abandon_remaining: false`; remaining artifacts continue normally. Real runaway guards are `POLISH_MAX_ROUNDS=6` (per-artifact) + `POLISH_COST_CAP_USD=500` (per-pack). Override via CLI `--cost-warn-usd <N>` or `opts.costWarnUsd`. |
| `COUNCIL_ANTHROPIC_MONTHLY_CAP_USD` | `400` | **lib/council.mjs cost-distribution Part 2 (2026-05-25)**. Per-vendor monthly spend cap. Summed over trailing 30 days from `data/polish-cost-trace-*.json` filtered by `model.startsWith('anthropic:')`. If `(monthly_spend + estimated_call_cost) > cap`, callCouncil refuses with `COUNCIL_CAP_REACHED: vendor=anthropic month=$N cap=$C — set COUNCIL_ANTHROPIC_MONTHLY_CAP_USD higher if intentional`. Set to `0` to disable. Highest cap because anthropic is the implicit default vendor for `routeByArchetype` (Sonnet 4.6) + Opus 4.7 covers voice_match_writing / strategic_reasoning archetypes. |
| `COUNCIL_OPENAI_MONTHLY_CAP_USD` | `70` | Per-vendor monthly cap for `openai:*` models. Lower because OpenAI is rarely primary post-routing — most archetypes route to Anthropic / Google / Perplexity. Same semantics as above. |
| `COUNCIL_XAI_MONTHLY_CAP_USD` | `50` | Per-vendor monthly cap for `xai:*` models. Used by `realtime_x_twitter` archetype + explicit `models:` callers needing Grok-4. Same semantics as above. |
| `COUNCIL_PERPLEXITY_MONTHLY_CAP_USD` | `50` | Per-vendor monthly cap for `perplexity:*` models. Used by `long_form_research` + `deep_research_synthesis` archetypes. Same semantics as above. |
| `COUNCIL_GOOGLE_MONTHLY_CAP_USD` | `50` | Per-vendor monthly cap for `google:*` models. Used by `image_understanding` + `long_context_500k_plus` archetypes + Tier-0 Gemini Flash cascade. Same semantics as above. |
| `GEMINI_FREE_API_KEY` | unset | **Optional Tier-0 free-tier cascade** for the `conversational_chat` archetype. When set, the `google:gemini-2.5-flash` PROVIDERS slot tries this key first (free tier: 15 RPM / 1M TPM / 1500 RPD per Google AI Studio). On 429 or 403, falls through to the paid `GEMINI_API_KEY`. If both are unset, conversational_chat dispatch fails with a missing-env-key error. Get a free key at https://aistudio.google.com/apikey. |
| `PER_RUN_CAP_PROCESS_ALL_USD` | `1000` | Per-run cap for `/api/pipeline/process-all`. **Raised from $250 → $1000 on 2026-05-26** after the 3-tier modal made Tier 3 ($600+) a routine choice, not an edge case. Force-override (`force: true` from the modal's "Force-run anyway" checkbox) bypasses the cap; the audit log below records every spawn over the original $250 threshold regardless of force. Clamp range [0, $10K]. |
| `PROCESS_ALL_AUDIT_THRESHOLD_USD` | `250` | Append-only audit log threshold (2026-05-26). Every Process All spawn whose cost estimate exceeds this gets recorded to `data/process-all-audit.jsonl` with `{ts, jobId, tier_id, tier_name, cost_estimate_usd, cap_usd, force, send_email, companies_count, companies, eval_model, triage_model}`. Defaults to the pre-2026-05-26 cap value so every "non-trivial spend" run is reviewable after the fact, decoupled from where the active cap is set. Audit write failures never block the spawn (best-effort observability). |
| `PROCESS_ALL_MAX_BATCH_ROUNDS` | `30` | **Process All drain ceiling (2026-05-29)**. Bumped from 10 → 30 default; clamp range widened from [1, 20] → [1, 100]. Realized per-batch sizes cluster at 73-179 URLs (Anthropic Batches API behavior), so 10 rounds × ~100 avg = only ~1000 URLs theoretical drain, which can't drain a 3000-URL queue in one run. 30 rounds gives ~3000 URLs theoretical headroom. Cost-bounded by `PER_RUN_CAP_PROCESS_ALL_USD=$1000` + the wall-clock cap below. Override per-run via env. |
| `PROCESS_ALL_MAX_WALLCLOCK_MS` | `5400000` (90 min) | **Process All wall-clock cap (2026-05-29)**. Hard ceiling on total Process All wall-clock time. When exceeded mid-round, the orchestrator returns `aborted: 'wallclock-cap'` + writes a resume-state file so the next invocation can pick up. Clamped to `[10min, 6h]`. Secondary to `PER_RUN_CAP_PROCESS_ALL_USD` (dollar cap is the primary governor); wall-clock is a hung-process safeguard for cases where the dollar cap hasn't been reached but no progress is happening. |
| `PROCESS_ALL_MAX_DRAIN_CYCLES` | `12` | **Bounded drain controller (2026-06-02)**. Outer-loop ceiling on triage→batch cycles inside one Process All run. `main()` re-checks `countPendingPipeline()` after every cycle and chains another until the queue drains to 0 (`drained-to-zero`), a full cycle makes 0 progress (`no-progress` — residual is undrainable this run: dead postings / hard-disqualified / terminal-errored-or-expired batches / a triage skip-without-mark gap), or a governor trips (`max-cycles` / `wallclock-cap` / a `phaseBatch` self-abort). Clamp `[1, 50]`. This is the auto-verifying "chain batches until the queue reaches 0" loop — explicitly NOT uncapped-to-exactly-0: the no-progress + cycle + wall-clock guards prevent the 179-stuck-URL infinite-rebatch runaway (`convergence-impossible-runaway-without-cap`). Loop logic + every termination branch live in the unit-tested `lib/process-all-drain-controller.mjs` (test-all.mjs §17). Raise only to drain a very large (>~30k-after-30-inner-rounds) queue in a single run. |
| `PROCESS_ALL_DISABLE_RESUME` | unset (= resume enabled) | **Resume kill switch (2026-05-29)**. When `true`, the orchestrator skips reading `data/process-all-resume-state.json` even if present + within TTL. Use for emergency rollback if resume behavior is misbehaving (e.g. resuming into a fork of pipeline.md that has been edited). Same effect as passing `--restart` on the CLI. |
| `PROCESS_ALL_DISABLE_REPAIR_SWEEP` | unset (= sweep enabled) | **Batch-state-repair-sweep kill switch (2026-05-29)**. When `true`, the orchestrator skips the dead-batch sweep on start. Use for emergency rollback if the sweep is mis-marking URLs (it shouldn't — it only marks URLs from terminal-errored or terminal-expired batches, idempotent). |
| `TRIAGE_PROVIDER_PRIORITY` | `local,anthropic,gemini` | Standard-tier triage provider chain (Tier 1, no `--use-sonnet-jd`). Comma-separated list of provider slots; first one to return a parseable result wins, errors fall through to the next. Wired in `triage.mjs::quickScoreRouted`: `local` (Ollama llama3.2:3b), `anthropic` (Haiku), `gemini` (`gemini-3-flash-preview`), `xai` (`grok-4-fast-reasoning` via `lib/council.mjs::callCouncil`), `openai` (`gpt-5` via callCouncil). |
| `TRIAGE_PROVIDER_PRIORITY_PREMIUM` | `gemini,xai` | Premium-tier triage provider chain (Tier 2/3, with `--use-sonnet-jd`). **Raised from `gemini` (single-vendor) → `gemini,xai` on 2026-05-26** so a transient Gemini outage no longer hard-fails the whole pipeline with `Fatal error: All triage providers exhausted`. Mitchell's locked decision: no Anthropic in the premium chain (he's over the monthly cap). `xai` uses `xai:grok-4-fast-reasoning` (~$3/1M tokens blended). `openai` slot is wired but kept off the default chain because `gpt-5` blended is ~$20/1M, which would balloon spend ~6x if it became the primary fallback path. Opt in: `TRIAGE_PROVIDER_PRIORITY_PREMIUM=gemini,xai,openai`. To re-add Anthropic later: `=gemini,xai,anthropic`. |
| `DISCARD_GATE_ENABLED` | `false` | **Discard-aware pre-triage gate kill switch (2026-05-26)**. Three-tier filter that runs BEFORE any LLM call in `triage.mjs::quickScoreRouted`. Closes the auto-re-ingest loop on previously-discarded roles (canonical incident: one previously-discarded role auto-re-ingested and discarded 3x across 7 days). Default `false` for phased rollout per spec § 13 (`.claude/audit/discard-gate-spec-2026-05-26/notes.md`). When `false`, gate still writes audit entries (`bypassed='disabled'`) so the would-have-skipped rate can be measured pre-rollout. Set to `true` after reviewing first day of audit log. Verdicts: `skip-exact` (Tier 1 hit, $0), `skip-gpt5` (Tier 3 hit ≥0.80 confidence, ~$0.02), `advance-flagged` (per-URL prior_match injected into LLM prompt), `advance` (no signal). |
| `DISCARD_COOLDOWN_DAYS` | `90` | How many days of prior discards count for Tier 1 + Tier 2 matching. Older discards ignored in v1.0. Future enhancement: stale-but-distinct surfacing with `stale: true` flag (v1.1, spec § 12). |
| `DISCARD_GATE_GPT5_BUDGET_USD` | `5` | Daily spend cap on the Tier 3 GPT-5 adjudication call. Sums from `data/discard-gate-spend.jsonl`. On exhaustion within the day, fuzzy hits flow through as `advance-flagged` (with per-URL prior_match prompt injection) instead of escalating to GPT-5. Worst-case envelope at the $5/day cap covers ~50 GPT-5 calls; typical day is 4-15 calls ($0.04-$0.50). |
| `POLISH_PER_PACK_TIMEOUT_MS` | `1800000` (30 min) | **Process All polish-phase watchdog (2026-05-27)**. Hard wall-clock ceiling on each `apply-pack-polish.mjs` invocation spawned by `scripts/process-all-pipeline.mjs::phasePolish`. Without this, polish loops (POLISH_MAX_ROUNDS × 6 artifacts × ~3min/round = up to ~108min per pack × N packs) could hang the whole Process All run indefinitely; Mitchell would cancel because the UI looked stalled. On timeout the pack is marked failed + the loop moves to the next pack — the run continues. Clamped to `[5min, 4h]`. See bug-class `polish-no-timeout-causes-process-all-stall`. |
| `TASK_AUDIT_DAILY_USD` | `20` | **task-audit hard daily cap (2026-05-28)**. Standalone agent at `scripts/agents/task-audit.mjs`. Walks recent Claude session transcripts under `~/.claude/projects/<encoded>/`, extracts user asks, uses Sonnet 4.6 to judge whether each was addressed, writes findings report + ready-to-paste continuation prompts at `.claude/audit/<DATE>/task-audit-*.md`. Clamped to [$0, $50]. Override per-run via `--budget USD`. Skill: `/task-audit`. |
| `TASK_AUDIT_PER_CALL_WARN_USD` | `5` | task-audit SOFT per-call WARN threshold — logs but does NOT block. Mirrors the regression-guard locked decision (no hard per-call sub-cap, surface-only warning). |
| `TASK_AUDIT_REPO_ROOT` | `/home/user/career-ops` | Repo root used to derive the encoded transcript directory (`~/.claude/projects/<encoded>/`). Override only when running the agent against transcripts captured under a different project root (e.g., a worktree's encoded path). |
| `STALE_STATUS_PASS_ENABLED` | `false` | **stale-tracker-status-pass kill switch (2026-06-14)**. Guards the destructive `--apply` path of `scripts/agents/stale-tracker-status-pass.mjs` (the guarded, reversible build of the 2026-06-08 calibration "stale-data rule" proposal). When not exactly `"true"`, `--apply` refuses with exit 3 and mutates nothing; the default dry-run always works regardless. Phased-rollout default off, mirroring `DISCARD_GATE_ENABLED`. Flip per-run inline: `STALE_STATUS_PASS_ENABLED=true node scripts/agents/stale-tracker-status-pass.mjs --apply`. See bug-class `destructive-auto-mutation-without-reversible-guards`. |
| `STALE_DAYS` | `30` | Age threshold (days) above which an `applications.md` row is "stale" for the stale-tracker pass. `--stale-days N` overrides per run. Only `Evaluated` rows older than this are eligible for purge/discard/refresh classification. |
| `STALE_REFRESH_MAX_ROWS` | `3` | Cap on keeper refreshes (`intel-refresh --row`, ~$35/row) per `stale-tracker-status-pass --apply --refresh-keepers` run. Clamped `[0, 50]`. `--max-refresh N` overrides. Prevents an accidental multi-hundred-dollar refresh sweep; deferred keepers are reported and picked up on the next run. |
| `TRIAGE_QUOTA_SAVE_EVERY_N` | `10` | **iCloud EDEADLK hardening (2026-07-02)**. `triage.mjs::saveQuota` writes `batch/daily-quota.json` only every Nth call (plus a forced flush at end-of-run + on exit/SIGINT/SIGTERM) instead of after every URL. Reduces fileproviderd sync churn that caused the `Unknown system error -11` (EDEADLK) crash mid Process All. Min 1 (`=1` restores per-URL writes). Worst case on hard crash: last <N quota increments lost → slight quota under-count next run. All quota + hot TSV/pipeline writes also flow through the bounded-retry wrappers in `lib/icloud-safe-fs.mjs`. See docs/BUG-CLASSES.md § `icloud-fileprovider-edeadlk-on-hot-state-file`. |
| `BATCH_ONLY_PHASE_TIMEOUT_MS` | `7200000` (2h) | **Qodo B4 hardening (2026-07-06)**. Per-phase wall-clock watchdog on every child `scripts/batch-only-pipeline.mjs` spawns (batch-runner / merge-tracker / build-dashboard / heartbeat). Hung-process guard, not a pacing knob — on expiry the child gets SIGTERM then SIGKILL after 10s and the phase reports failure. Clamp `[10min, 6h]`. |
| `DRAWER_ENRICH_TIMEOUT_MS` | `1800000` (30 min) | **Qodo B4 hardening (2026-07-06)**. Watchdog ceiling for the detached enrichment spawns in `lib/drawer-auto-enrich.mjs`. On expiry the whole process group is killed and the slot lock is released, so a hung enrichment can no longer hold a drawer slot in "enriching" forever. Clamp `[1min, 2h]`. |
| `TEST_CHILD_TIMEOUT_MS` | `120000` (2 min) | **Dedup-tracker safe-default PR (2026-07-07, #393)**. Hang-watchdog ceiling for child test processes spawned by `test-all.mjs` sections and `tests/*.test.mjs` subprocess fixtures (e.g. `tests/dedup-keeper-selection.test.mjs` runs `dedup-tracker.mjs` against a temp fixture tree). Hung-process guard so a stalled child can never wedge CI — not a pacing knob. Clamp `[10s, 10min]` in test-all.mjs; fixture floor 5s (default 60s) in the test file. |
| `HEARTBEAT_PING_BASE` | unset (= heartbeats disabled) | **Convergence Phase 0 dead-man heartbeats (2026-07-07)**. Base ping URL of the SELF-HOSTED Healthchecks instance, shape `http://127.0.0.1:8787/ping/<project-ping-key>`. `scripts/launchd-wrapper.mjs` (49 rewritten plists) pings `/<slug>/start` + `/<slug>/<exit-code>`; the deployed `cron-run.sh` pings `/<label>/<exit-code>` at every exit path. `?create=1` auto-provisions checks on first ping. FAIL-OPEN invariant: unset → silent no-op; server down → launchd-wrapper warns to stderr + continues (pings race-capped at 2.5s start / 3s exit), while cron-run.sh pings are fully silenced by design (no warning surface — check Healthchecks itself for those 5 jobs); a heartbeat problem can never affect a job or its exit code. Setup: `bash scripts/deploy/setup-healthchecks.sh` + `infra/healthchecks/README.md`. Rollback: unset the var (instant, no code change). |
| `COUNCIL_CONNECTION_CLOSE` | unset (= off) | **Convergence Phase 0 (2026-07-07)**. Opt-in per-request `Connection: close` + `keepalive: false` on every provider fetch inside `lib/council.mjs` — replaces the `globalThis.fetch` monkey-patch the polish orchestrator applied since 2026-05-19 (7/7 adjudicated anti-pattern). `scripts/agents/apply-pack-polish.mjs` enables it at entry via `setConnectionCloseMode(true)` + sets this env for spawned children. All other council consumers: default off, byte-identical behavior. Retires when the LiteLLM gateway (Phase 2) owns connection lifecycle. See `lib/connection-close-fetch.mjs`. |
| `SCAN_LINKEDIN_SAVED_JOBS_ENABLED` | unset (= scheduled runs no-op) | **LinkedIn saved-jobs ingest kill switch (2026-07-08)**. Gates the daily 07:15 PT `com.mitchell.career-ops.scan-linkedin-saved-jobs` launchd job (`scripts/scan-linkedin-saved-jobs.mjs --apply --scheduled`). Scheduled runs proceed ONLY when the value is exactly `true`; anything else exits 0 with a `disabled_noop` telemetry event (a disabled job must not alarm). Manual runs (no `--scheduled` flag) ignore the switch entirely, so first-run review works before enablement. Phased-rollout default-off, mirroring `DISCARD_GATE_ENABLED`. $0/run — the scraper makes no LLM calls; triage spend happens downstream where it already does. |
| `SCAN_LINKEDIN_SAVED_JOBS_MAX_PAGES` | `5` | Pagination hard cap for the saved-jobs scrape (~10 jobs/page → ~50 jobs). CLI `--max-pages=N` overrides per run. Raise only if the saved list routinely exceeds 50 entries; each extra page is one more polite 2-4s LinkedIn page load. |
| `STAGING_DASHBOARD_TOKEN` | unset (= all staging refused) | **Staging Host-gate (2026-07-09)**. `dashboard-server.mjs` returns `403` for any request whose `Host` contains `staging` (both `staging-dashboard.*` via the CSP Worker and the raw `staging-origin.*` tunnel ingress — the two hostnames funnel through the same origin, so one gate closes both) unless it carries `X-Staging-Token: <this value>`. Closes the no-auth public exposure of the personal dashboard mirror (an LLM live-retrieval crawler, `sonar-deep-research`, was observed fetching a staging report page during the 2026-07-09 ICP council run). **Fail-closed**: the value must be non-empty; if unset, ALL staging traffic is refused. **Configure in two places** so staging UI-verification keeps working: (1) generate once with `openssl rand -hex 32`; (2) put it in the local `.env` as `STAGING_DASHBOARD_TOKEN=<value>` (read by `dashboard-server.mjs` + `scripts/dashboard-headless-canary.mjs`) AND, for the CI health-probe to get a true 200, add the same value as the GitHub repo secret `STAGING_DASHBOARD_TOKEN` (read by `.github/workflows/health-probe.yml`; without the secret the probe treats the fail-closed 403 as healthy). Prod (`dashboard.careers-ops.com`, CF Access) and `localhost:3097` are non-staging Hosts and unaffected. |

Pre-existing env vars also in `.env.example`: `GEMINI_API_KEY` / `GEMINI_MODEL`, `HEARTBEAT_EVENING_ENABLED`, `GPTZERO_API_KEY` / `ORIGINALITY_API_KEY` / `PANGRAM_API_KEY`, `HUNTER_API_KEY` (Hunter.io email-finder key, optional — `scripts/agents/network-emailer.mjs` falls back to pattern-permutation + DNS MX verification when unset).

Additional regression-guard env vars (full default-on-no-set list documented in `.env.example` + the agent's JSDoc header):
- `REGRESSION_GUARD_CANARY_FAIL_SHUT=true` — canary degradation disables non-canary findings
- `REGRESSION_GUARD_SILENT_PERIOD_DAYS_BY_TYPE=code:7,closure:7,memory:7,data:7,ui:7,pipeline:14,behavioral:14,performance:14`
- `REGRESSION_GUARD_BASELINE_EXPIRY_DAYS=30`
- `REGRESSION_GUARD_SELF_THROTTLE_THRESHOLD=8`
- `REGRESSION_GUARD_TRANSCRIPT_BASELINE_ENABLED=false` — feature flag, flip after 30d baseline-build run per dealbreaker § Audit Item 3
- `REGRESSION_GUARD_CROSS_SESSION_CADENCE=daily`
- `REGRESSION_GUARD_GEMINI_TIER=preview` — note GA migration may require code update
- `REGRESSION_GUARD_DEEP_BUDGET_USD=20` — separate budget for `--deep` forensic mode
- `REGRESSION_GUARD_AUTO_REBUILD_DASHBOARD=true` — L1 (2026-05-26): when `true`, regression-guard spawns `node scripts/build-dashboard.mjs` (detached) after every panel write in `--scheduled` + `--seed-baselines` modes. Closes the `stale-dashboard-after-panel-refresh` bug class. Flip to `false` via `launchctl setenv REGRESSION_GUARD_AUTO_REBUILD_DASHBOARD false` to disable.
- `DEPLOY_VERIFY_COMMIT_SHA` (unset by default) — L2 (2026-05-26): set by `/deploy-verify` Phase 6D before invoking `regression-guard --seed-baselines`. Threads through `scripts/agents/regression-guard/lib/baseline-store.mjs` into the written baseline JSON + `_provenance.jsonl` entry as `commit_sha`. Closes the `stale-regression-baseline-after-deploy` bug class via full provenance link.
- `DEPLOY_VERIFY_REPORT_PATH` (unset by default) — L2 (2026-05-26): paired with `DEPLOY_VERIFY_COMMIT_SHA`, this env var carries the deployment report path. Written into the baseline JSON + provenance entry as `deploy_report`. Same purpose as above.

**Bug-resolver env vars (2026-05-23):**

| Variable | Default | Purpose |
|---|---|---|
| `BUG_RESOLVER_ENABLED` | `true` | Kill switch — set false to no-op the Mon/Thu 02:00 PT plist run |
| `BUG_RESOLVER_DAILY_USD` | `150` | Daily spend ceiling across all bugs in a single run |
| `BUG_RESOLVER_PER_BUG_CAP` | `50` | Per-bug spend ceiling; pipeline aborts if a single bug exceeds this. **Bumped 30 → 50 on 2026-05-25** as part of the MAX QUALITY routing change — `gpt-5-5-pro` implement widens worst-case spend per bug. |
| `BUG_RESOLVER_MAX_BUGS_PER_RUN` | `5` | Max bugs per launchd run (sorted CRIT → HIGH → MED → LOW) |
| `BUG_RESOLVER_VENDOR_DISABLED_GEMINI` | `false` | **Family-level** kill — skip all Gemini phases on true (gemini-2.5-pro audit/research + gemini-3-flash verify/harden) |
| `BUG_RESOLVER_VENDOR_DISABLED_GROK4` | `false` | **Family-level** kill — skip all Grok phases on true (grok-4 adjudicate / action_plan) |
| `BUG_RESOLVER_VENDOR_DISABLED_GPT5` | `false` | **Family-level** kill — skip all GPT-5 phases on true (gpt-5-5-pro implement) |
| `BUG_RESOLVER_MODEL_DISABLED_<SLUG>` | unset | **Per-model** kill (added 2026-05-25) — disable ONE specific model while leaving siblings active. SLUG = model id with `.`/`-` mapped to `_`, uppercased. Recognized: `GEMINI_2_5_PRO`, `GEMINI_3_FLASH`, `GROK_4`, `GPT_5_5_PRO`. Auto circuit-breaker also operates per-model — a Flash blip does NOT disable Pro. |
| `BUG_RESOLVER_AUDIT_TIMEOUT_MS` | `900000` (15 min) | Per-phase timeout for the **audit** vendor call. Bumped 120s → 900s on 2026-05-25 after `bug-2026-05-25-033` (row-resolver regex audit) hit the 120s ceiling and returned NEEDS_HUMAN with no signal. Override via `launchctl setenv BUG_RESOLVER_AUDIT_TIMEOUT_MS NNNNNN`. |
| `BUG_RESOLVER_RESEARCH_TIMEOUT_MS` | `600000` (10 min) | Per-phase timeout for the **research** vendor call. Same drift-resilience rationale as audit. |
| `BUG_RESOLVER_ADJUDICATE_TIMEOUT_MS` | `60000` | Per-phase timeout for the **adjudicate** vendor call. Smaller token budget → tighter default. |
| `BUG_RESOLVER_ACTION_PLAN_TIMEOUT_MS` | `90000` | Per-phase timeout for the **action_plan** vendor call. |
| `BUG_RESOLVER_IMPLEMENT_TIMEOUT_MS` | `180000` (3 min) | Per-phase timeout for the **implement** vendor call (GPT-5.5-Pro code gen). |
| `BUG_RESOLVER_VERIFY_TIMEOUT_MS` | `45000` | Per-phase timeout for the **verify** vendor call (Gemini Flash — fast). |
| `BUG_RESOLVER_HARDEN_TIMEOUT_MS` | `60000` | Per-phase timeout for the **harden** vendor call (Gemini Flash — fast). |

**career-ops-health env vars (2026-05-25):**

| Variable | Default | Purpose |
|---|---|---|
| `CAREER_OPS_HEALTH_ENABLED` | `true` | Kill switch — set false to no-op the daily 06:30 PT plist run |
| `CAREER_OPS_HEALTH_DAILY_USD` | `20` | Daily spend ceiling. `/deploy-verify` auto-passes `--budget 40` (2x default per Q9 locked) when invoking via `--deploy-invoke` |
| `CAREER_OPS_HEALTH_MODEL` | `claude-sonnet-4-6` | Synthesis model. Override to `claude-opus-4-7` for harder cross-category correlation |
| `CAREER_OPS_HEALTH_VERBOSE` | unset | Set `1` to stream operational log to stderr (useful for first-run debug) |

**/deploy-verify env vars (2026-05-25):**

| Variable | Default | Purpose |
|---|---|---|
| `DEPLOY_VERIFY_REGRESSION_BUDGET_USD` | `40` | Phase 3A regression-guard budget override (2x default $20 per Q9) |
| `DEPLOY_VERIFY_BUG_RESOLVER_BUDGET_USD` | `300` | Phase 3B bug-resolver daily budget override (2x default $150 per Q9) |
| `DEPLOY_VERIFY_AUTO_MERGE_DRAFT_PRS` | `true` | Auto-merge bug-resolver DRAFT PRs that pass CI green AND don't touch sensitive paths (per Q2 locked). Set `false` to surface every PR for manual review |

**v2 autonomous-remediation pipeline env vars (2026-05-25):**

| Variable | Default | Purpose |
|---|---|---|
| `V2_BUDGET_USD` | `300` | Unified daily spend cap across all v2 pipeline components: regression-guard + bug-resolver + v2-verify-subset. Summed from `data/regression-guard-spend.jsonl` + `data/bug-resolver-spend.jsonl` + `data/v2-verify-spend.jsonl`. Hard-stop when cap is breached. Override at deploy time; otherwise accept the $300 default. Documented in `lib/v2-budget.mjs`. |

When adding a new env var: document in `.env.example` AND in this table AND in any agent README that consumes it.

### Regression-guard — Q1-Q5 follow-up sprint (2026-05-23)

Stacks on the v1.0 + v1.1 ship from earlier the same day. Closes 5 locked decisions from a /feedback interview.

**Q1 — Type-1 detector tune (`outer-template-unescape-suspect` + `outer-template-unescape-loose`)**

Day-0 trial fired 8 HIGH on the broad heuristic match against `scripts/build-dashboard.mjs` — turned out the matches were safe code (mostly regex literals inside `${}` interpolations where single-backslash IS correct JS). The Type-1 detector at `scripts/agents/regression-guard/detectors/type-01-code.mjs` now emits TWO finding subtypes:

| Subtype | Severity | Confidence | Notes |
|---|---|---|---|
| `outer-template-unescape-suspect` | HIGH | HIGH | Requires backtick delimiter + inline-JS context marker (`<script`, `function`, `const`, `var`, `let`, `=>`, `addEventListener`, `dangerouslySetInnerHTML`) within ~200 chars of the match |
| `outer-template-unescape-loose` | LOW | LOW | Old broad heuristic — any quote (`/[\`'"]/`) opener followed by `/\\[dsw]\+`. Kept for v2 calibration data only. LOW severity sorts to bottom of top-15. |

Smoke test #15 `q1-detector-tune-emits-both-subtypes` locks in the behavior against the live `scripts/build-dashboard.mjs` (strict ≤ 5 HIGH, loose ≥ 1 LOW — concrete day-0 count was strict=2, loose=6).

**Q3 — Plist weekly Mondays for 4-week calibration window**

`scripts/launchd/com.mitchell.career-ops.regression-guard.plist` updated 2026-05-23 to `<Weekday>1</Weekday>` (Mondays only) for the 4-week calibration window (2026-05-25 → 2026-06-22). After 4 clean Mondays, flip back to daily by removing the Weekday key.

**Flip-back command (run on 2026-06-22 after the calibration window):**

```bash
sed -i '' '/<key>Weekday<\/key>/,/<integer>1<\/integer>/d' \
  ~/Library/LaunchAgents/com.mitchell.career-ops.regression-guard.plist
launchctl unload ~/Library/LaunchAgents/com.mitchell.career-ops.regression-guard.plist
launchctl load   ~/Library/LaunchAgents/com.mitchell.career-ops.regression-guard.plist
```

**Q5 — Full lib module split per dealbreaker spec**

v1.0/v1.1 shipped as a single 2,228-LOC monolith with a "pragmatic structure deviation from spec literalness" documented in CLAUDE.md. Q5 closes that deviation by extracting the spec-required 20-file structure (actual delivered: 26 files for cleaner concerns):

```
scripts/lib/                                      shared modules (3)
├── closure-loader.mjs                            v1.2 stub — parses closure invariants
├── brain-loader.mjs                              v1.2 stub — parses brain-doc rules
└── regression-baselines.mjs                      shared baseline store API

scripts/agents/regression-guard/
├── input-sources.mjs                             declarative source registry (14 sources)
├── detectors/
│   ├── type-01-code.mjs                          Type 1 — code regression (Q1-tuned)
│   ├── type-02-ui.mjs                            Type 2 — UI structural drift
│   ├── type-03-data.mjs                          Type 3 — data integrity
│   ├── type-04-pipeline.mjs                      Type 4 — pipeline state shape
│   ├── type-05-behavioral.mjs                    Type 5 — transcript drift (flag-gated)
│   ├── type-06-closure.mjs                       Type 6 — closure invariants
│   ├── type-07-memory.mjs                        Type 7 — memory / brain-doc rules
│   └── type-08-performance.mjs                   Type 8 — perf log diff (day-1 stub)
└── lib/                                          agent-scoped lib (11 modules)
    ├── config.mjs                                paths + env-driven constants
    ├── log-spend.mjs                             log/heartbeat/recordSpend/checkDailyCap
    ├── citation-policy.mjs                       cross-fork-leak guard + hashCite/summarizeCite
    ├── baseline-store.mjs                        thin wrapper over scripts/lib/regression-baselines.mjs
    ├── state-store.mjs                           loadState/saveState
    ├── path-encoder.mjs                          encodeProjectPath
    ├── silent-period.mjs                         parseSilentPeriods
    ├── canary-suite.mjs                          runCanarySuite + CANARY_FIXTURES
    ├── sonnet-synthesis.mjs                      Sonnet 4.6 API client
    ├── gemini-ingest.mjs                         Gemini 3.1 Pro Preview + Sonnet fallback
    └── tier-router.mjs                           v1.2 stub — explicit T0-T5 dispatch

tests/regression-canaries/                        canary fixtures (3)
├── pattern-b-parallel-agent-fixture.mjs
├── pattern-c-inline-payload-bloat-fixture.mjs
└── closure-08-outer-template-fixture.mjs
```

The orchestrator `scripts/agents/regression-guard.mjs` is now ~1,442 LOC (down from 2,228) — owns mode dispatch, decision-doc renderers (`renderDecisionDoc` + `renderMultiDeepDoc`), v1.1 multi-session orchestration (`runDeepMultiSession` + `crossSessionSynthesize` + `enumerateSessions` + `deepSingleSession` + `buildDescriptor`), and the 23-test smoke suite.

**Import discipline:**

- All lib modules use explicit `.mjs` extensions on every import
- Detectors import from `../lib/...` only — NEVER from `regression-guard.mjs` (no cycles)
- Shared state (baselines, spend ledger) lives in lib modules — orchestrator + detectors both read from the same source of truth via direct module imports
- `config.mjs` is the single source of constants (REPO_ROOT, TODAY, env-driven knobs, paths)
- Backward-compat: `regression-guard.mjs` STILL exports the v1.0/v1.1 API surface via re-export, so existing importers (omega-steward Phase 4 hook etc.) don't break

**`gemini-ingest.mjs` fallback extension (A4 surfaced 2026-05-23):**

Live validation against the v1beta endpoint surfaced that `gemini-3-1-pro-preview` returns HTTP 404 (model not yet at v1beta GA). Pre-fix code only treated 5xx + timeout as fallback-eligible — 404 surfaced as a hard error. Fix: extended the fallback trigger pattern to also match 404-model-not-found responses. New `fallback_reason: 'gemini_model_not_found'`. Smoke #3c locks in the matcher. See `.claude/audit/regression-guard-tune-2026-05-23/deep-validation.md` for full live-validation results + spend ledger entries.

## Bug class catalog (project-specific)

63 project-specific bug-class entries documented verbatim in [docs/BUG-CLASSES.md](docs/BUG-CLASSES.md). Cross-project patterns live in `~/.claude/knowledge/brain/bug-class-catalog.md`. **Read the catalog file before touching any risky surface listed below.**

<details><summary>Full index (63 entries)</summary>

- [outer-template-unescape (`build-dashboard.mjs`)](docs/BUG-CLASSES.md#outer-template-unescape-build-dashboard-mjs)
- [client-side-dependency-bridge-gap (`build-dashboard.mjs` Node imports vs. inline `<script>` execution)](docs/BUG-CLASSES.md#client-side-dependency-bridge-gap-build-dashboard-mjs-node-imports-vs-inline-script-execution)
- [env-shadow-on-lazy-dotenv (dashboard-server.mjs)](docs/BUG-CLASSES.md#env-shadow-on-lazy-dotenv-dashboard-server-mjs)
- [swallowed-error-in-api-response-shape (dashboard-server endpoints)](docs/BUG-CLASSES.md#swallowed-error-in-api-response-shape-dashboard-server-endpoints)
- [missing-timeout-on-long-running-operation](docs/BUG-CLASSES.md#missing-timeout-on-long-running-operation)
- [subagent-overreach-cleanup + post-hoc-attribution-without-transcript-evidence](docs/BUG-CLASSES.md#subagent-overreach-cleanup-post-hoc-attribution-without-transcript-evidence)
- [stale-baseline-poisoning (regression-guard)](docs/BUG-CLASSES.md#stale-baseline-poisoning-regression-guard)
- [regression-guard-cross-fork-leak](docs/BUG-CLASSES.md#regression-guard-cross-fork-leak)
- [setup-node-cache-requires-lockfile](docs/BUG-CLASSES.md#setup-node-cache-requires-lockfile)
- [stale-premise-from-prior-triage](docs/BUG-CLASSES.md#stale-premise-from-prior-triage)
- [convergence-impossible-runaway-without-cap](docs/BUG-CLASSES.md#convergence-impossible-runaway-without-cap)
- [concurrent-cd-prefix-orphan (worktree → main-repo collision)](docs/BUG-CLASSES.md#concurrent-cd-prefix-orphan-worktree-main-repo-collision)
- [confidence-label-annotation-not-gating (worked example: surface evidence, don't gate)](docs/BUG-CLASSES.md#confidence-label-annotation-not-gating-worked-example-surface-evidence-dont-gate)
- [stale-coupling-after-primitive-removal](docs/BUG-CLASSES.md#stale-coupling-after-primitive-removal)
- [worker-branch-collision-on-redispatch (background subagent fails silently at startup)](docs/BUG-CLASSES.md#worker-branch-collision-on-redispatch-background-subagent-fails-silently-at-startup)
- [stale-worktree-work-rescue (don't destroy uncommitted work in a locked worktree)](docs/BUG-CLASSES.md#stale-worktree-work-rescue-dont-destroy-uncommitted-work-in-a-locked-worktree)
- [worker-pushed-but-no-pr-completion (shipped work invisible without PR)](docs/BUG-CLASSES.md#worker-pushed-but-no-pr-completion-shipped-work-invisible-without-pr)
- [pr-conflict-mirage-from-parallel-shipping](docs/BUG-CLASSES.md#pr-conflict-mirage-from-parallel-shipping)
- [jsonl-concurrent-write-collision (append-only ledger race condition)](docs/BUG-CLASSES.md#jsonl-concurrent-write-collision-append-only-ledger-race-condition)
- [critical-file-parallel-pr-overlap (structural conflict from concurrent feature workstreams)](docs/BUG-CLASSES.md#critical-file-parallel-pr-overlap-structural-conflict-from-concurrent-feature-workstreams)
- [bug-resolver-ai-predicted-shape-mismatch (canonical-shape required for ledger entries)](docs/BUG-CLASSES.md#bug-resolver-ai-predicted-shape-mismatch-canonical-shape-required-for-ledger-entries)
- [pipeline-scan-to-drawer-rendering-gap-detection (Pattern X2 enforcement tool, 2026-05-26)](docs/BUG-CLASSES.md#pipeline-scan-to-drawer-rendering-gap-detection-pattern-x2-enforcement-tool-2026-05-26)
- [contract-drift-across-layers (enum changes that miss a downstream consumer)](docs/BUG-CLASSES.md#contract-drift-across-layers-enum-changes-that-miss-a-downstream-consumer)
- [stale-dashboard-after-panel-refresh](docs/BUG-CLASSES.md#stale-dashboard-after-panel-refresh)
- [stale-regression-baseline-after-deploy](docs/BUG-CLASSES.md#stale-regression-baseline-after-deploy)
- [write-without-rebuild-propagation-gap](docs/BUG-CLASSES.md#write-without-rebuild-propagation-gap)
- [force-override-not-propagated-to-internal-guard](docs/BUG-CLASSES.md#force-override-not-propagated-to-internal-guard)
- [state-write-without-disk-write (intel-refresh.mjs slots_done drift)](docs/BUG-CLASSES.md#state-write-without-disk-write-intel-refresh-mjs-slots-done-drift)
- [git-tracked-runtime-state-restored-by-checkout](docs/BUG-CLASSES.md#bug-class-git-tracked-runtime-state-restored-by-checkout)
- [polish-no-timeout-causes-process-all-stall (RESOLVED VIA ARCHITECTURAL REMOVAL 2026-05-27)](docs/BUG-CLASSES.md#polish-no-timeout-causes-process-all-stall-resolved-via-architectural-removal-2026-05-27)
- [process-all-completion-not-surfaced](docs/BUG-CLASSES.md#process-all-completion-not-surfaced)
- [queue-counter-fluctuation-imperceptible-without-delta](docs/BUG-CLASSES.md#queue-counter-fluctuation-imperceptible-without-delta)
- [sentinel-string-treated-as-truthy-by-gating-predicate](docs/BUG-CLASSES.md#sentinel-string-treated-as-truthy-by-gating-predicate)
- [gh-search-repos-topics-field-unsupported](docs/BUG-CLASSES.md#gh-search-repos-topics-field-unsupported)
- [report-renderer-aesthetic-fork](docs/BUG-CLASSES.md#report-renderer-aesthetic-fork)
- [heartbeat-event-liveness-stale-source-url](docs/BUG-CLASSES.md#heartbeat-event-liveness-stale-source-url)
- [event-name-day-of-week-drift](docs/BUG-CLASSES.md#event-name-day-of-week-drift)
- [vendor-deprecation-100-percent-error-with-no-mark](docs/BUG-CLASSES.md#vendor-deprecation-100-percent-error-with-no-mark)
- [pipeline-mark-not-idempotent-on-terminal-error](docs/BUG-CLASSES.md#pipeline-mark-not-idempotent-on-terminal-error)
- [same-branch-name-squash-merge-content-collision](docs/BUG-CLASSES.md#same-branch-name-squash-merge-content-collision)
- [cross-surface-dedupe-regression](docs/BUG-CLASSES.md#cross-surface-dedupe-regression)
- [background-agent-file-polling-deadlock](docs/BUG-CLASSES.md#background-agent-file-polling-deadlock)
- [bash-and-chain-fragility (Pattern J)](docs/BUG-CLASSES.md#bash-and-chain-fragility-pattern-j)
- [linkedin-url-bypassed-canonicalizer-at-ingest](docs/BUG-CLASSES.md#linkedin-url-bypassed-canonicalizer-at-ingest)
- [llm-judge-soft-enforcement-of-hard-rules](docs/BUG-CLASSES.md#llm-judge-soft-enforcement-of-hard-rules)
- [stale-scrubber-rewrites-to-banned-forms (guard-rule recalibration lag)](docs/BUG-CLASSES.md#bug-class-stale-scrubber-rewrites-to-banned-forms-guard-rule-recalibration-lag)
- [fabricated-employer-in-generated-prose (deterministic employer gate, lib/employer-claims.mjs)](docs/BUG-CLASSES.md#bug-class-fabricated-employer-in-generated-prose)
- [findings-exit-code-conflated-with-spawn-failure (swallowed verification subprocess)](docs/BUG-CLASSES.md#bug-class-findings-exit-code-conflated-with-spawn-failure)
- [hardcoded-date-fixture-time-bomb (absolute fixture date crosses a staleness threshold as real time advances)](docs/BUG-CLASSES.md#bug-class-hardcoded-date-fixture-time-bomb)
- [judge-prompt-context-starvation-manufactures-defects (lossy prompt window read as writer defect)](docs/BUG-CLASSES.md#bug-class-judge-prompt-context-starvation-manufactures-defects)
- [refresh-verifier-blocks-expected-drift-without-consequence-aware-rubric](docs/BUG-CLASSES.md#bug-class-refresh-verifier-blocks-expected-drift-without-consequence-aware-rubric)
- [process-orchestrator-without-resumable-state](docs/BUG-CLASSES.md#process-orchestrator-without-resumable-state)
- [launchd-bash-wrapper-tahoe-tcc-block](docs/BUG-CLASSES.md#launchd-bash-wrapper-tahoe-tcc-block)
- [launchd-exit-1-misclassified-as-flapping-on-data-signals](docs/BUG-CLASSES.md#launchd-exit-1-misclassified-as-flapping-on-data-signals)
- [state-file-without-schema-enforcement](docs/BUG-CLASSES.md#state-file-without-schema-enforcement)
- [client-side-reference-to-server-side-import](docs/BUG-CLASSES.md#client-side-reference-to-server-side-import)
- [stale-worktree-cp-backward-merge](docs/BUG-CLASSES.md#stale-worktree-cp-backward-merge)
- [ad-hoc-cp-of-build-artifact](docs/BUG-CLASSES.md#ad-hoc-cp-of-build-artifact)
- [pipeline-ingest-format-drift](docs/BUG-CLASSES.md#pipeline-ingest-format-drift)
- [slug-truncation-contract-drift-writer-verifier-reader](docs/BUG-CLASSES.md#slug-truncation-contract-drift-writer-verifier-reader)
- [destructive-auto-mutation-without-reversible-guards](docs/BUG-CLASSES.md#destructive-auto-mutation-without-reversible-guards)
- [icloud-fileprovider-edeadlk-on-hot-state-file](docs/BUG-CLASSES.md#icloud-fileprovider-edeadlk-on-hot-state-file)
- [pricing-map-entry-without-dispatch-block (silent model drop in lib/council.mjs)](docs/BUG-CLASSES.md#pricing-map-entry-without-dispatch-block)

</details>
### Endpoints added in Closure 08 + 09 (2026-05-22)

Quick reference for new HTTP routes shipped this sprint. All on `dashboard-server.mjs`.

| Route | Method | Body / Query | Returns | Audit |
|---|---|---|---|---|
| `/api/batch/resume` | POST | `{ jobId }` | `{ ok, newJobId, originalJobId, rowsRequeued, resumeInputPath }` | `.claude/audit/closure-08-2026-05-22/notes-08.3-resume-button.md` |
| `/api/batch/cancelled-jobs` | GET | — | `{ ok, cancelled_jobs[] }` (last 7 days, 10 max) | same as above |
| `/api/apply-pack-zip` | GET | `?slug=<slug>` | streams `application/zip` of every pack artifact | `.claude/audit/closure-09-part-2-2026-05-22/notes.md` |

`/api/batch/status-detailed` (existing) was extended with two new top-level fields:
- `recent_cancelled_jobs[]` — drives the new "Cancelled jobs" section + Resume buttons in the batch-status modal
- `process_all_confidence` — `{ runs[], summary{} }` drives the new "Process All confidence" panel

### Endpoints added / updated in L6 schema-typed artifact migration (PR #285, 2026-05-26)

`/api/artifact` (pre-existing, `dashboard-server.mjs:7352`) now also serves `<artifact>.json` files alongside `.md` files. The Apply-Now modal (`_openApplyClipboardModal` in `scripts/build-dashboard.mjs:22619`) uses JSON-first fetch:

1. `GET /api/artifact-manifest?slug=<slug>` — checks if `form-fields.json` is listed
2. `GET /api/artifact?slug=<slug>&file=form-fields.json` — fetches schema-typed JSON (HTTP 200)
3. Falls back to `GET /api/artifact?slug=<slug>&file=form-fields.md` if JSON returns 404

**3-band section rendering** (when JSON is present):
- `risk_band: "warn"` → `⚠ review` chip (red, `#dc2626`) + red left border — rewrite required
- `risk_band: "asis"` → `✓ as-is` chip (green, `#16a34a`) + green left border — paste-ready
- `risk_band: "edit"` (default) → `✎ edit` chip (amber, `#d97706`) + amber left border — one swap needed
- `risk_band: null` → no chip, fallback `window._renderMd(body)` (legacy path, untouched)

Header subtitle changes from `"Staged form fields"` to `"JSON-typed form fields (L6)"` when JSON mode is active.

**No new endpoints added** — the L6 migration reuses `/api/artifact` and `/api/artifact-manifest`. All 7 agent scripts write `.json` + `.md` via `lib/write-apply-pack-artifact.mjs`.

### Endpoints added in Phase 5 pop-outs (Closure 4, 2026-05-23)

| Route | Method | Body / Query | Returns | Audit |
|---|---|---|---|---|
| `/api/team-health` | GET | `?slug=<company-slug>` or `?company=<name>` | `{ ok, slug, age_days, stale, data: <data/team-health/<slug>.json> }` | `.claude/audit/phase-5-pop-outs-2026-05-23/row-selection.md` |
| `/api/drill/percentage/:rowId/:key` | GET | path params (`:rowId` = row number, `:key` = metric e.g. `alignment`) | `{ ok, rowId, key, html, strategy }` — rendered strategy card HTML + raw result | `dashboard-server.mjs:7516` |

**⚠️ Path-param form only — query params return 404.** `/api/drill/percentage?row=48&metric=alignment` is NOT the route. The correct call for row 48 alignment is `/api/drill/percentage/48/alignment`. The route regex at `dashboard-server.mjs:7526` is `/^\/api\/drill\/percentage\/([^/]+)\/([^/]+)$/`. Both `:rowId` and `:key` are URI-decoded before use.

`/api/interview-likelihood` (existing from Closure 5.2, 2026-05-22) + `/api/hm-chance` (existing from Closure 5.3, 2026-05-22) are now consumed by the new full-modal pop-outs at `_openInterviewLikelihoodPopout` + `_openHmChancePopout` in `scripts/build-dashboard.mjs`. Both accept `?slug=<row-slug>` or `?row=<num>` (number-only resolves to the apply-pack dir name).

New client-side window globals exposed by `scripts/build-dashboard.mjs` (Phase 5 pop-outs):
- `window._openTeamHealthPopout(companySlug, companyName)` — opens full Team Health modal
- `window._openInterviewLikelihoodPopout(num, slug)` — opens Interview Likelihood modal
- `window._openHmChancePopout(num, slug)` — opens HM Chance modal (first section leads with `competitive_edges_first` per master prompt 12.16.12)
- `window._openIntelPopoutModal({kind, slug?, row?, company?, title})` — shared opener (the three thin wrappers above call this)
- `window._intelEsc(s)` — HTML-escape helper used by the body renderers

Chip click handler in `_drawerRenderIntelChips` routes `th`/`il`/`hc` chips to the full modal openers; the `hm` chip retains its existing inline popover (no full-modal counterpart added). The inline `_renderPop` / `_renderThPop` / `_renderIlPop` / `_renderHcPop` functions remain defined for backward compatibility but are no longer called on chip click.

### Popout grounding via lib/ground-prompt.mjs (2026-05-23)

`lib/ground-prompt.mjs` is the reusable RAG primitive that grounds the 4 drawer popouts in Mitchell's personality corpus + profile corpus. Replaces generic LLM output ("Choose 3 named frontier-lab targets") with role-grounded, corpus-cited analysis in Mitchell's voice (third-person analyst speaking TO Mitchell about him — never first-person Mitchell self-talk).

**API:**

```js
import { buildGroundedPrompt, checkVoicePurity, classifyVoicePurity } from './lib/ground-prompt.mjs';

const grounded = buildGroundedPrompt({
  task,         // 'alignment' | 'interview' | 'hm_chance' | 'team_health' | <custom>
  rowId, role, company, jdText, hmIntel,
  metricKey, currentValue,
  responseSchema,   // optional JSON schema text
  lean: false,      // optional — true to drop astrology/sensory/social-energy docs
});
// → { prompt, system, cacheStableContent: [personality, profile], cacheKey, metadata }

await callCouncil({
  prompt: grounded.prompt,
  systemPrompt: grounded.system,
  models: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5'],
  opts: {
    timeoutMs: 180000,
    cacheStableContent: grounded.cacheStableContent,    // ARRAY of 2 elements (3-breakpoint cache w/ system)
    cacheCaller: 'strategy-ceiling:' + metricKey,
  },
});
```

**4 popout coverage (locked decision #1):**

| Popout | Compute path | Grounding pattern |
|---|---|---|
| Alignment | `lib/strategy-ceiling.mjs::computeStrategyCeiling` via `dashboard-server.mjs::/api/drill/percentage` | Full lib refactor — `buildGroundedPrompt` replaces local `_buildPrompt`; model claude-sonnet-4-6 primary, gpt-5 fallback. |
| Interview likelihood | `scripts/agents/interview-likelihood.mjs::runCouncilResearch` | Minimal injection — `grounded.system` + personality cache block; multi-stage research + dealbreaker adjudication preserved. |
| HM chance | `scripts/agents/hm-chance.mjs::runCouncilResearch` | Same minimal-injection pattern as interview-likelihood. |
| Team health | `lib/team-health.mjs::synthesizeTeamHealth` | DEFERRED — synthesizer is a documented STUB (NOT_IMPLEMENTED); grounding lands in the Phase 5.1 follow-up that ships the real Chrome MCP scrape + Sonnet narrative agent. |

**Rollback:** `STRATEGY_CEILING_GROUNDED_MODE=0` returns the legacy non-grounded prompt shape — instant revert, no code change. Verified locked decision #6 (popout-grounding /feedback 2026-05-23).

**Voice purity:**
- Layer 2 (regex) — `checkVoicePurity(output)` runs cheap on every output; flags first-person leakage, tone-unsafe language, banned corporate vocab.
- Layer 3 (LLM) — `classifyVoicePurity(output, callCouncil)` runs ~$0.005 Haiku classifier on cache writes ONLY. Opt-in via `STRATEGY_CEILING_VOICE_CLASSIFIER=1`. Best-effort — classifier failures never block result.

**Cache breakpoints (Q2-locked, 3 breakpoints):**
- System prompt (analyst-to-Mitchell voice rules) — cached
- Personality corpus block (17 docs from `data/second-brain-extracted/second brain/`, less astrology/sensory/social-energy in lean mode) — cached
- Profile corpus block (cv.md + article-digest.md + modes/_profile.md + config/profile.yml) — cached
- Dynamic section (role + company + JD excerpt + HM intel) — NOT cached, varies per call

`lib/council.mjs::anthropicBuildBody` accepts `cacheStableContent` as either string (legacy) or array (new). Each array element becomes its own `cache_control: ephemeral` breakpoint on Anthropic adapters. Non-Anthropic adapters receive the joined content prepended to the prompt (full context, no cache benefit).

### Cooldown banner — auto-cross-reference (PR-05, 2026-05-25)

`lib/cooldown-context.mjs` cross-references each apply-now row's hm-intel contacts (`hiring_managers[]` + `recruiters[]`) against `data/network-database.json` to resolve a warm-contact replacement for the cooldown banner's "Override if you have a recruiter ask..." sentence. Per Mitchell's locked Q3 in `.claude/audit/apply-now-ux-audit-2026-05-25/strategy-adjudicated.md` §6 R28-R30.

**Match priority** (deterministic): email > linkedin > name-fuzzy (Sorensen-Dice bigram ≥ 0.85). Email match returns `Override available: <name> at <company> — last touched <YYYY-MM-DD>.`; name-only match appends `(verify)` so Mitchell knows to verify the resolution. Empty contacts → `No active recruiter touch in network — apply via portal.`. Missing network-database.json → `No active recruiter touch in network (check unavailable).` (distinguished failure mode).

**Called from** `scripts/build-dashboard.mjs` inside the cooldown branch of the throttle-status loop (around line 4197). Wrapped in try/catch — fail-open returns the neutral no-touch text rather than letting the resolver crash the dashboard build.

**Data sources read** (both gitignored personal data): `data/hm-intel/<company-slug>-<role-slug>.json` + `data/network-database.json`. Output rendered to local DOM only — dashboard publishes via local-only Cloudflare Tunnel + the resolver renders only the warm contact's name + company + last-touched date (no JD content, no email body, no inline contact quotes).

Tests: `tests/cooldown-context.test.mjs` (43 cases — T1 email match, T2 no-contacts path, T3 missing hm-intel file, T4 name-fuzzy `(verify)` suffix, T5 missing network-db `(check unavailable)` path, plus 20 internal-helper invariants + 4 bonus edge cases).

### Content ingest pipeline (PR-B, 2026-05-27)

The AM heartbeat now surfaces themed-weekday content (Mon=convos / Tue=events / Wed=articles / Thu=tips / Fri=digest, per Q3 locked) alongside always-present apply queue + reminders (per Q7 locked). Per Q10 locked, weekends ship no email.

**Architecture:**

- `scripts/agents/content-ingest.mjs` — orchestrator, cron-driven
- `lib/content-sources/{grok-x,perplexity-reddit,hn,github-trending}.mjs` — Tier 1 adapters
- `lib/themed-weekday.mjs` — picks today's theme + loads content
- `lib/reminders.mjs` — time-sensitive items (postings <48h, follow-ups due today, cooldowns breaking today)
- `scripts/launchd/com.mitchell.career-ops.content-ingest-daily.plist` — daily 03:00 PT
- `scripts/launchd/com.mitchell.career-ops.content-ingest-hourly-grok.plist` — every 6h (loaded-but-disabled)
- `data/dispatch/{convos,articles,reminders}.json` — ingest outputs + staged reminders

**Cost profile:** typical daily ingest ~$0.15–$0.40 (1 Perplexity reasoning + 1 Grok call + free HN/GitHub APIs). 6h Grok-only cron: ~$0.04–$0.08 per fire = ~$5–10/month if enabled.

**Tier 2 sources (deferred to PR-D):** lu.ma scrape, AI Tinkerers multi-chapter, Meetup (Microsoft Reactor + Galvanize), dev.to, Substack RSS (Lenny's / Latent Space / AI Tidbits), arxiv-sanity, LinkedIn AI posts, Blind, Discord (per-server bot bridges).

**Tier 3 (PR-C):** Thursday tips deep research via Gemini DRM across all mitwilli-create repos + multi-LLM dialogue rounds. Output to `data/dispatch/tips.json` consumed by Thursday's themed slot.

**Loaded-but-disabled day-1:** both plists ship LOADED but DISABLED. Bootstrap after reviewing first manual run via `launchctl bootstrap gui/$(id -u) <plist>` + `launchctl enable gui/$(id -u)/<label>`.

**Manual triggers:** `node scripts/agents/content-ingest.mjs --mode={daily,hourly} [--dry-run] [--source=<id>]`.

## Canonical Deploy Procedure (added 2026-05-25)

`/deploy-verify` is the **canonical end-to-end deploy procedure** for shipping any sprint of work to production. Use it instead of an ad-hoc `git push + restart + curl` sequence whenever a sprint touches dashboard rendering, scheduled jobs, agents, lib modules, or anything visible at `https://dashboard.careers-ops.com/`.

The skill wraps a 9-phase inline prompt at `data/deploy-verify-prompt-2026-05-25.md`. Phases:

1. Read CLAUDE.md / AGENTS.md / bug-class catalog / latest audit doc
2. Inventory: code changes / new plists / new deps / new env vars / new infra / build artifacts / doc drift / open PRs / external surfaces
3. Verify the build live (Chrome MCP screenshots, endpoint requests, scheduled-job triggers)
4. **Pre-push QA gate**: `/regression-guard` ($40 cap) + `/bug-resolver` ($300 cap) — HALT on CRIT; auto-merge CI-green DRAFT PRs except personal-data paths
5. Deploy: install deps, run migrations, merge PRs to fork main, restart services via `kickstart -k`, bootstrap new plists
6. Bootstrap new infrastructure (background sweeps, recalibration jobs, metric aggregators, embedding indexes)
7. **Post-deploy reboot + re-verify**: hard `launchctl bootout` + `launchctl bootstrap` every service, refresh caches, re-run regression-guard against LIVE state
8. Propagate documentation + memory (CLAUDE.md / AGENTS.md / README.md / MEMORY.md updates)
9. Smoke test the end-to-end user journey via Chrome MCP at dashboard.careers-ops.com + **system health check** (`/system-maintainer --all` + `/career-ops-health --deploy-invoke`)

Locked decisions from the 2026-05-25 interview chain (13 questions):

| # | Decision | Locked |
|---|---|---|
| Q1 | CRIT regression handling | Halt + surface for review |
| Q2 | DRAFT PR auto-merge policy | Auto-merge CI-green not touching personal data |
| Q3 | System health agent | `/system-maintainer` + new `/career-ops-health` (both run) |
| Q4 | New agent scope | Comprehensive production health (6 categories) |
| Q5 | New agent cadence | Daily 06:30 PT scheduled + on-deploy invoke |
| Q6 | Agent failure handling | Continue with degraded confidence |
| Q7 | Phase 7 restart depth | Hard bootout + bootstrap |
| Q8 | Deployment report path | `data/deployment-report-*.md` (gitignored) |
| Q9 | Cost cap policy | 2x defaults (~$360 max per deploy) |
| Q10 | Format | Both inline prompt + `/deploy-verify` skill |
| Q11 | Alerting | Terminal-only (no Telegram for v1.0) |
| Q12 | Doc enshrinement | AGENTS.md + MEMORY.md updates (this section is the result) |
| Q13 | New agent synthesis model | Sonnet 4.6 |

Source-of-truth files:
- Inline prompt: `data/deploy-verify-prompt-2026-05-25.md`
- Skill: `.claude/skills/deploy-verify/SKILL.md`
- Design doc: `data/agent-spec-career-ops-health-2026-05-25.md`
- New agent: `scripts/agents/career-ops-health.mjs`

**When to use `/deploy-verify` vs other deploy patterns:**
- ✓ Sprint of 5+ commits touching production surfaces — use `/deploy-verify`
- ✓ Any change to scheduled-job plists, agent code, or `dashboard-server.mjs` — use `/deploy-verify`
- ✓ Any change to `scripts/build-dashboard.mjs` that affects rendered HTML — use `/deploy-verify`
- ✗ Single-file doc commit — `git commit && git push` is fine, no deploy-verify
- ✗ Bug fix that already went through `/bug-resolver` end-to-end — that flow includes its own DRAFT PR + verification

## Community and Governance

- **Code of Conduct**: Contributor Covenant 2.1 with enforcement actions (see `CODE_OF_CONDUCT.md`)
- **Governance**: BDFL model with contributor ladder — Participant → Contributor → Triager → Reviewer → Maintainer (see `GOVERNANCE.md`)
- **Security**: private vulnerability reporting via email (see `SECURITY.md`)
- **Support**: help questions go to Discord/Discussions, not issues (see `SUPPORT.md`)
- **Discord**: https://discord.gg/8pRpHETxa4

## Scheduled vs. User-Initiated Scripts

The ~21-26 launchd plists in `scripts/launchd/` cover the unattended pipeline:
scan, batch, heartbeat, heartbeat-evening (Phase B, 2026-05-19), weekly-intel,
audit, company-pulse, signal-monitor, liveness-sweep, system-maintainer, etc. —
these run autonomously on a schedule.
(Exact count varies with overnight builds; run `node scripts/agents/system-maintainer.mjs --health`
for the current authoritative inventory + loaded/flapping status. As of 2026-05-19 the
worktree count is 40 — includes all overnight-build additions across the full PR chain.)

**Four scripts deliberately do NOT have launchd plists** and stay user-initiated:

| Script | Why user-initiated | How to invoke |
|---|---|---|
| `scripts/hm-gemini-backfill.mjs` | Each Gemini Deep Research interaction runs 20-60 min and Mitchell decides which roles deserve it. | CLI `--kickoff` then `--poll` later |
| `scripts/process-all-pipeline.mjs` | Wraps triage + batch + rebuild + heartbeat-email into one chain. Manual trigger is the safety gate — auto-scheduling would risk Process All firing while triage or batch was already running from its own schedule. | Sidebar 🚀 **Process All** button (which POSTs to `/api/pipeline/process-all`) |
| `scripts/scan-similar-companies.mjs` | ~$0.025/run (5 Perplexity sonar calls). Outputs personal pipeline data to `data/similar-companies-{DATE}.md` (gitignored). Run on-demand when expanding pipeline targets. | `node scripts/scan-similar-companies.mjs` (add `--dry-run` to preview, `--top N` to limit company sample) |
| `scripts/agents/stale-tracker-status-pass.mjs` | **Destructive** (auto-purge + auto-discard of stale `applications.md` rows, ~$35/keeper-refresh). Deliberately never scheduled so a human always reviews the would-purge / would-discard / would-refresh counts before anything fires. Dry-run-by-default + env-gated (`STALE_STATUS_PASS_ENABLED`). | `node scripts/agents/stale-tracker-status-pass.mjs` (dry-run, safe); `STALE_STATUS_PASS_ENABLED=true node scripts/agents/stale-tracker-status-pass.mjs --apply` to act (add `--refresh-keepers` to also refresh keepers) |

**Note (2026-05-25 doc-drift fix):** earlier versions of this table referenced `scripts/hiring-manager-research.mjs` as if it shipped. `git log --diff-filter=D` confirms the file was never in the repo — it was documented-but-unbuilt. The hm-intel slot is served by `scripts/agents/intel-refresh.mjs` which routes to `scripts/populate-hm-intel-mini.mjs` by default and supports a `--mode deep-council-7` flag that the dashboard's "Deep refresh" modal sets (the full-spec council fan-out runs through that path). See bug-class catalog § documented-but-unbuilt.

`scripts/heartbeat-evening.mjs` is **scheduled** (NOT user-initiated) — see the companion-script note below.

`scripts/agents/regression-guard.mjs` is **scheduled** (daily 06:00 PT) but shipped LOADED-BUT-DISABLED 2026-05-23 awaiting Mitchell's review of the day-0 trial run. Plist: `com.mitchell.career-ops.regression-guard.plist`. Enable AFTER reviewing the trial decision-doc via `launchctl enable gui/$(id -u)/com.mitchell.career-ops.regression-guard`. Kill switch: `launchctl setenv REGRESSION_GUARD_ENABLED false`. Spec: `~/.claude/agents/runs/dealbreaker-final-20260523-132911-regression-agent-delta.md`.

`scripts/scan-linkedin-saved-jobs.mjs` is **scheduled** (daily 07:15 PT) but ships LOADED-BUT-DISABLED (2026-07-08) awaiting Mitchell's review of the first manual `--apply` run. Plist: `com.mitchell.career-ops.scan-linkedin-saved-jobs.plist` (launchd-wrapper heartbeats included). Cost per run: $0 (Playwright scrape, no LLM). Scrapes LinkedIn Saved Jobs (`linkedin.com/my-items/saved-jobs/`) **CDP-first** (attaches to the daemon Chrome at 127.0.0.1:9222 via `lib/cdp-browser.mjs` — live-fire 2026-07-08 showed fresh headless storage-state sessions get invalidated by LinkedIn bot-detection within minutes; `data/linkedin-storage-state.json` remains the fallback), dedupes via `loadSeenUrls()` + `data/linkedin-saved-jobs-state.json`, appends new rows to `data/pipeline.md § Pendientes` — triage Phase 0a then canonicalizes LinkedIn → ATS URLs as usual. Exit codes: 0 success (incl. confirmed-empty + disabled no-op) · 2 auth/login wall (recover: log into LinkedIn in the daemon Chrome, `node scripts/launch-debug-chrome.mjs`; legacy fallback `node scripts/scrape-contact-photo.mjs --setup-auth`) · 3 parse failure / ambiguous zero cards (LinkedIn DOM change — silent-zero guard) · 4 Playwright env failure · 5 rejection gate unavailable (fail-closed — the mandatory Rejection Gate could not load its hardExclude set). Nothing registered in `data/fleet-watchdog-expected-exits.json` by design — every nonzero exit is actionable. First-run commands: `node scripts/scan-linkedin-saved-jobs.mjs --max-pages=2` (dry-run default) then `--apply --limit=10`. Enable AFTER review: set `SCAN_LINKEDIN_SAVED_JOBS_ENABLED=true` in `.env` + `launchctl enable gui/$(id -u)/com.mitchell.career-ops.scan-linkedin-saved-jobs`.

`scripts/agents/voice-corpus-grower.mjs` is **scheduled** (monthly, 1st of month at 04:00 PT) but shipped LOADED-BUT-DISABLED 2026-05-24 awaiting Mitchell's manual first-`--run` to seed the workflow + verify the proposal output. Plist: `com.mitchell.career-ops.voice-corpus-grower.plist`. Cost per run: $0 (deterministic file walk, no LLM calls). Script writes a NEEDS-APPROVAL omega-proposal to `data/voice-corpus-growth-{date}.md` — does NOT auto-edit `lib/voice-corpus.mjs` (Mitchell-only territory per the script docstring). First-run command: `node scripts/agents/voice-corpus-grower.mjs --run --limit 50`. Enable AFTER reviewing first proposal: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitchell.career-ops.voice-corpus-grower.plist && launchctl enable gui/$(id -u)/com.mitchell.career-ops.voice-corpus-grower`. Spec: `data/instance-g-pending-tools-plan-2026-05-24.md § G14`.

`scripts/agents/bug-resolver.mjs` is **scheduled** (Mon/Thu 02:00 PT) but shipped UNLOADED day-1 — load AFTER Test 1 + Part 4 (DRAFT-PR validation) pass. Plist: `com.mitchell.career-ops.bug-resolver.plist`. Load via `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitchell.career-ops.bug-resolver.plist`. Kill switch: `launchctl setenv BUG_RESOLVER_ENABLED false`. Phases (post 2026-05-25 MAX QUALITY routing): audit (Gemini 2.5 Pro) → research (Gemini 2.5 Pro) → adjudicate (Grok-4) → action_plan (Grok-4) → implement (GPT-5.5 Pro) → verify (Gemini 3 Flash) → harden (Gemini 3 Flash). Skill: `/bug-resolver`.

`scripts/agents/career-ops-health.mjs` is **scheduled** (daily 06:30 PT) and **ENABLED** as of 2026-05-25 (runs=1, last exit 0 per `launchctl print gui/$(id -u)/com.mitchell.career-ops.career-ops-health`). Earlier doc revisions said "LOADED-BUT-DISABLED day-1" — PR-01 (apply-now UX overhaul, 2026-05-25) reconciled the drift to the actual launchctl state per dealbreaker default ("state wins, doc gets updated"). Plist: `com.mitchell.career-ops.career-ops-health.plist`. Kill switch: `launchctl setenv CAREER_OPS_HEALTH_ENABLED false` (runtime) OR `launchctl disable gui/$(id -u)/com.mitchell.career-ops.career-ops-health` (persistent across reload). Six check categories: deploy validation, data freshness, OAuth + credentials, third-party quotas, scheduled-job heartbeats, cost drift. Plus a Sonnet 4.6 synthesis pass for cross-category narratives. Daily spend cap $20 (2x = $40 when invoked from `/deploy-verify` via `--deploy-invoke`). Skill: `/career-ops-health`. Born 2026-05-25 via the prompt-optimizer interview chain; design doc at `data/agent-spec-career-ops-health-2026-05-25.md`.

### v2 Autonomous-Remediation Pipeline (2026-05-25)

Shipped as 10 PRs (#201, #212, #203, #213, #205, #206, #207, #208, #214, #215) merged to main 2026-05-25. The pipeline closes the loop between regression detection and autonomous repair:

```
regression-guard (Mon Mondays 06:00 PT)
  └─→ lib/bug-resolver/regression-queue.mjs  (bridge — PR #201/#212)
        └─→ data/regression-bug-queue.jsonl
              └─→ bug-resolver.mjs (Mon/Thu 02:00 PT, also spawned immediately for CRIT/HIGH/MED)
                    └─→ DRAFT PR (auto-merge gate if CI green + non-sensitive)
                          └─→ v2-verify-subset.mjs (5-step post-merge verification)
                                └─→ v2-rollback.mjs (if verification fails, 3s safety window)
```

**Pipeline components** (all in `scripts/agents/` or `lib/`):

| Component | File | Purpose |
|---|---|---|
| Queue bridge | `lib/bug-resolver/regression-queue.mjs` | Routes rg-* entries to `data/regression-bug-queue.jsonl` |
| Unified queue | `lib/bug-resolver/unified-queue.mjs` | `loadUnifiedQueue()`, `updateUnifiedEntry()` across both queues |
| Auto-merge gate | `scripts/agents/bug-resolver.mjs` (PR #212) | CI-green + non-sensitive-path guard; LOW severity bridge |
| Daemon map | `scripts/lib/file-to-daemon-map.mjs` | Maps changed files → daemons needing restart |
| Verify runner | `scripts/agents/v2-verify-subset.mjs` | 5-step post-merge: daemon-restart, canary, dashboard-200, heartbeat-syntax, ui-verify |
| Rollback CLI | `scripts/agents/v2-rollback.mjs` | `--reason`, `--sha`, `--dry-run`; 3s safety window |
| Thrash counter | `lib/v2-thrash-counter.mjs` | `isV2Frozen()` — 3 auto-reverts in 24h triggers freeze; manual rollbacks excluded |
| Fix log | `lib/v2-fix-log.mjs` | Append-only JSONL at `data/v2-fix-log.jsonl`; schema includes `pr_state: DRAFT/MERGED/VERIFIED/REVERTED` |
| Unified budget | `lib/v2-budget.mjs` | `V2_BUDGET_USD` (default $300); sums spend across 3 JSONL files |
| Heartbeat recap | `scripts/heartbeat-evening.mjs` (PR #206) | Adds v2 pipeline status section to evening digest |
| E2E smoke tests | `.github/workflows/v2-e2e.yml` | Nightly Mon-Fri 03:30 UTC; mock mode by default ($0) |

**Freeze enforcement** (`scripts/agents/bug-resolver.mjs`, `scripts/agents/regression-guard.mjs`, PR #208): both agents check `isV2Frozen()` before any operation. Freeze status logged in decision docs. Manual unfreeze via `data/v2-freeze-override.json` only.

**Stacked-PR squash-merge lesson (2026-05-25 incident):** `gh pr merge N --squash --delete-branch` on a stacked PR deletes its branch, which auto-closes all downstream PRs whose base points to that branch. The correct procedure: (a) squash WITHOUT `--delete-branch` until ALL stacked PRs are merged, then clean up branches, OR (b) cherry-pick strategy — extract each PR's incremental commit and create new PRs from current main tip. Original PRs #202–#210 were salvaged via cherry-pick; see `data/deployment-inventory-2026-05-25-0322.md § 1H` for the final merged PR numbers.

### Heartbeat companion script (Phase B, 2026-05-19)

`scripts/heartbeat-evening.mjs` runs scheduled, NOT user-initiated. The plist
`com.mitchell.career-ops.heartbeat-evening.plist` fires at 18:00 PT Mon-Fri.
The HEARTBEAT_EVENING_ENABLED=true|false env flag in .env gates whether the
script sends — flip to false to kill the evening email without uninstalling
the plist. Default true post-ship.

The trigger matrix (16 surfaces) in the functionality inventory always reachable
via the dashboard sidebar buttons + row drawer CLI snippets — no plist needed.

## Recurring audits (decision-doc pattern)

A subset of recurring jobs produces a *decision doc* — a markdown report with a
force-ranked findings list, recommendations per finding, and a "Decisions
Required" block in copy-paste-back format. Mitchell reads the doc, fills in
each `DECISION_N=...`, and pastes back at the executor for the next iteration.

Active decision-doc jobs:

| Job | Plist | Cadence | Output | What gets decided |
|---|---|---|---|---|
| system-maintainer | `com.mitchell.career-ops.system-maintainer` | Daily 03:00 PT | `data/system-maintenance-decision-doc-<DATE>.md` | Unloaded plists (KEEP_DEFERRED / BOOTSTRAP_NOW / ARCHIVE_SOURCE), flapping plists, tracker dupes, /tmp leaks, security regressions, dashboard liveness |

The system-maintainer plist runs `--all`, which dispatches `--health → --cleanup
→ --review → --decision-doc` in order. The first three produce dated snapshot
files; `--decision-doc` consolidates them into the decision doc that's the
single artifact Mitchell needs to read.

To add a new decision-doc job, follow the system-maintainer pattern:

1. The agent's main run produces dated raw snapshots (status files) in `data/`.
2. A `--decision-doc` flag (or similar) post-processes the snapshots into a
   force-ranked decision doc. The renderer must include: TL;DR with severity
   tally, Wins section, Findings table (ranked CRITICAL → LOW), Decisions
   Required block with `DECISION_N=____` placeholders, and a Snapshot rollup.
3. The plist runs `--all --decision-doc` (or equivalent) on a launchd schedule.
4. Add a new row to this table.

The pattern is documented in `scripts/agents/system-maintainer.mjs:runDecisionDoc`
and `lib/system-health-snapshot.mjs` (the underlying snapshot library).

## Headless / Batch Mode

When spawning headless workers for batch processing, use the appropriate command for your CLI:

| CLI | Command |
|-----|---------|
| Claude Code | `claude -p "prompt"` |
| Gemini CLI | `gemini -p "prompt"` |
| Copilot CLI | `copilot -p "prompt"` |
| Codex | `codex exec "prompt"` |
| OpenCode | `opencode run "prompt"` |
| Qwen | `qwen -p "prompt"` |

## Stack and Conventions

- Node.js (mjs modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of evaluations, run `node merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT -- status BEFORE score):**
1. `num` -- sequential number (integer)
2. `date` -- YYYY-MM-DD
3. `company` -- short company name
4. `role` -- job title
5. `status` -- canonical status (e.g., `Evaluated`)
6. `score` -- format `X.X/5` (e.g., `4.2/5`)
7. `pdf` -- `✅` or `❌`
8. `report` -- markdown link `[num](reports/...)`
9. `notes` -- one-line summary

**Note:** In applications.md, score comes BEFORE status. The merge script handles this column swap automatically.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** -- Write TSV in `batch/tracker-additions/` and `merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF). Include `**Legitimacy:** {tier}` (see Block G in `modes/oferta.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node verify-pipeline.mjs`
6. Normalize statuses: `node normalize-statuses.mjs`
7. Dedup: `node dedup-tracker.mjs`

### Two num spaces: queue vs applications.md (DO NOT conflate)

`data/apply-now-queue.json:ranked[].num` and `data/applications.md` column 1 (`num`) are **two independent num assignments for the same logical roles**. They are NOT meant to align by integer.

- **Queue num** comes from `rebuild-apply-now-queue.mjs` — derived from eval-order + ranking. Example: queue assigns `num=2194` to "ExampleCo / Example Architect, Industries".
- **applications.md num** comes from a separate counter at row-insert time + may shift via dedupe. Example: applications.md has the same role at `num=2251` (with an earlier row marked DUPE-Discarded for the prior intake).
- **Reconciliation is by company+role fuzzy match**, not by num — `merge-tracker.mjs` correctly looks up the existing entry by company+role before inserting/updating, so a TSV with queue's num assignment may end up updating a row at applications.md's num.

**Common LLM misframing to avoid:**

> "These rows exist in `apply-now-queue.json:ranked` but not in `applications.md` (by num lookup) — they need to be added."

**Reality:** check whether the same company+role exists in applications.md under a different num first. If yes, the queue row is NOT an orphan — it's just a num-mismatch. Status may be Discarded, in which case the dashboard correctly hides it from apply-now.

**Diagnostic command:**

```bash
# For each row in apply-now-queue.json:ranked, find the applications.md entry by company+role
node -e "
const q = JSON.parse(require('fs').readFileSync('data/apply-now-queue.json','utf8'));
const a = require('fs').readFileSync('data/applications.md','utf8');
for (const r of q.ranked) {
  // Look up by company+role exact match (case-insensitive)
  const re = new RegExp('^\\\\\| \\\\d+ \\\\\| [^|]+\\\\\| ' + r.company + ' \\\\\| ' + r.role.replace(/[.*+?^()|[\\]]/g,'\\\\\$&'), 'mi');
  const m = a.match(re);
  console.log('Q#' + r.num.padEnd(5), 'A:' + (m ? 'FOUND' : 'MISSING'), r.company + ' / ' + r.role);
}
"
```

If a queue row's company+role is genuinely MISSING from applications.md, then write a TSV per § TSV Format above. If it's present but Discarded, the apply-now widget correctly hides it — no action needed.

**Merge-tracker fuzzy-match qualifier-aware (FIXED 2026-05-23):** The `roleFuzzyMatch` function at `merge-tracker.mjs:130` previously used Jaccard ratio ≥ 0.6 on tokenized roles, which collapsed "{base}, {qualifier}" variants like "Example Architect, Industries" vs "Example Architect, Commercial" into a single match (the shared base-token overlap crossed threshold). Fix: comma-qualifier guard — if either role has a comma, BOTH must have one AND the post-comma qualifier (case-insensitive, trimmed) must be exactly equal. Preserves no-comma fuzzy matches (Sr/Senior baseline tokens unaffected). Empirical case that triggered the fix: 2026-05-23 deployment, two qualifier-variant TSVs for the same base role both targeted one row; post-fix, the second variant correctly inserts as a new row.

**Implication of the fix:** variant-roles for the same company NO LONGER auto-dedupe via the matcher. If two TSVs are legitimately the same role written two ways, the second will INSERT (creating an apparent duplicate) instead of UPDATE. Use `node dedup-tracker.mjs` post-merge if needed, or write a tracker-additions/{num}.tsv with the existing num to force exact-num-match dedup (path 2 in the matcher).

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate, doesn't fit, or offer closed |

**SKIP state deprecated 2026-05-26 (PR #2 of the popout / discard / H-chip sweep).** SKIP and Discarded both meant "candidate decided not to apply" — the two-state distinction added cognitive load + UI surface area for no semantic gain. SKIP rows in applications.md were migrated in-place to Discarded; SKIP / no_aplicar / monitor remain as aliases on the discarded state so historical writers + downstream consumers continue to flow into Discarded cleanly. Eval prompts (`batch/batch-prompt.md`, `batch/triage-prompt.md`) updated to emit `Discarded` instead of `SKIP` for the "doesn't fit, don't apply" classification.

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
