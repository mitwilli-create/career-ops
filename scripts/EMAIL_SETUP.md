# Email-alert ingestion setup

`scan-email.mjs` reads Gmail messages forwarded to a specific label and pulls
job-posting URLs out of them. This covers the platforms the zero-token
scanner can't reach: **LinkedIn, BuiltIn, Wellfound (AngelList), Otta**.

The script is dependency-light (just `imapflow` + the same title-filter and
dedup as `scan.mjs`) and writes to the same `data/pipeline.md`.

## One-time Gmail setup

1. **Verify your Gmail App Password is in `~/.career-ops-secrets`.**
   The same password used by `heartbeat.mjs` works for IMAP. Confirm that
   `GMAIL_USER=` and `GMAIL_APP_PASSWORD=` are both present.

2. **Labels are pre-created** by `scripts/create-gmail-labels.mjs` (run during
   initial setup). The three labels are:
   - `career-ops` (parent)
   - `career-ops/alerts` (the inbox `scan-email.mjs` reads)
   - `career-ops/processed` (reserved for future use — moves processed messages out of `alerts`)

   If you need to recreate them, run: `node scripts/create-gmail-labels.mjs`.

3. **Import the 20 pre-built Gmail filters** covering all supported platforms:
   - Gmail UI → Settings (gear icon) → "See all settings" → "Filters and Blocked Addresses" tab.
   - Scroll to bottom → "Import filters" button.
   - Upload [scripts/gmail-filters.xml](gmail-filters.xml).
   - On the next page, check "Apply new filters to existing emails" (so backfill works) and click "Create filters".

   The XML imports filters covering: **mainstream** (LinkedIn / Indeed / Glassdoor / ZipRecruiter), **AI / startup** (BuiltIn / Wellfound / Otta), **niche comms / editorial / journalism / content** (Mediabistro / WorkingInContent / PRSA / Ragan / IABC / JournalismJobs / MarketingHire / Communications Network / Idealist), and **gig / freelance** (Upwork / Fiverr / Contra / Freelancer). All route to `career-ops/alerts` and archive out of inbox.

4. **Enable email alerts on each platform** (the only step that needs a logged-in browser):

   | Tier | Platform | Where to enable |
   |---|---|---|
   | **Mainstream** | LinkedIn | Saved searches → Daily alerts. Add 5-7 searches mixing role + location filters. |
   | | Indeed | "My Jobs" → Set up email alerts on saved searches. |
   | | Glassdoor | Job alerts (now via Indeed merger; same flow as Indeed). |
   | | ZipRecruiter | Profile → Job alert preferences. |
   | **AI / startup** | BuiltIn | Saved search → email alerts on. |
   | | Wellfound (AngelList) | Profile → "Email me about new matching roles". |
   | | Otta | Preferences → email frequency. |
   | **Comms / editorial / journalism / content (your strongest fit)** | Mediabistro | Account → Job alerts (specify "Communications Manager", "Editorial Lead", "Content Strategist"). |
   | | WorkingInContent | Newsletter signup with role filters. |
   | | PRSA Job Center | Free job-alert subscription (no membership needed for alerts). |
   | | Ragan Talent Hub | Newsletter signup. |
   | | IABC Job Centre | Job-alert subscription. |
   | | JournalismJobs | Email job-alert form. |
   | | MarketingHire | Job alert signup. |
   | | Communications Network | Newsletter (jobs section auto-included). |
   | | Idealist | Email alerts for nonprofit/social-impact comms. |
   | **Gig / freelance** (for AI side-work pipeline) | Upwork | Saved searches → email alerts. Filter for "n8n", "AI agent", "automation", "AI workflow". |
   | | Fiverr | Buyer requests → daily digest. |
   | | Contra | Profile preferences → project alerts. |
   | | Freelancer.com | Saved bid alerts. |

   **Recommended saved-search keywords** (apply these on each platform):
   - **Tier B (your natural fit):** "Communications Manager AI", "Communications Lead", "Content Strategist AI", "Developer Education", "Engineering Editorial Lead", "Editorial Lead AI", "AI Content Strategy"
   - **Tier A2 (your stretch):** "AI Solutions Architect", "Forward Deployed Engineer", "Applied AI Engineer", "AI Enablement Lead", "AI Program Manager", "Technical Program Manager AI"
   - **Gig keywords:** "n8n", "AI agent builder", "AI automation", "Claude integration", "agentic workflow", "AI consultant"

## Run the scanner

```bash
# Dry-run first to see what URLs get extracted from existing unread alerts
node scan-email.mjs --dry-run

# Real run: writes new URLs to pipeline.md, marks messages read
node scan-email.mjs

# Keep messages unread (useful while debugging)
node scan-email.mjs --keep-unread

# Use a different label
node scan-email.mjs --label=career-ops/inbound
```

The scanner only reads **unread** messages and marks them read on success. So
running it twice in a row processes new messages only.

## How URL extraction works

The scanner does NOT try to parse each platform's HTML email layout
(those break frequently). Instead it:

1. Pulls every `<a href>` and bare URL out of the message body.
2. Filters to URLs matching known job-board patterns
   (`linkedin.com/jobs/view/{id}`, `builtin*.com/job/...`,
   `wellfound.com/jobs/...`, `otta.com/jobs/...`, etc.).
3. Canonicalizes LinkedIn URLs (strips tracking params; same job seen via
   multiple alerts dedupes correctly).
4. Extracts the role title from the anchor text near each URL.
5. Applies the same `title_filter` from `portals.yml` that `scan.mjs` uses.
6. Dedupes against `scan-history.tsv`, `pipeline.md`, and
   `applications.md`.

This stays robust as platforms tweak their email layouts — the URL
patterns rarely change.

## Adding a new platform

Edit `JOB_URL_PATTERNS` near the top of `scan-email.mjs`. Add a regex that
matches the platform's job-detail URL. Example for "Hired":

```js
/hired\.com\/jobs\/[\w-]+/i,
```

If the platform uses a tracking redirect (e.g. `email.platform.com/c/...`),
either decode it in `decodeUrl()` or add the redirect host to
`JOB_URL_PATTERNS` and let `canonicalize()` normalize after the redirect
resolves (you may need to add a fetch + Location-header step).

## Scheduling unattended

Once you've verified `scan-email.mjs` works against real alerts, wire it
into launchd alongside `scan.mjs`:

1. Add a new plist `com.mitchell.career-ops.email.plist` (mirror
   `com.mitchell.career-ops.scan.plist`) — pick a non-conflicting hour
   (e.g. `Hour=4` to land after the 02:00 scan + 03:00 batch).
2. Add the corresponding wrapper if your launchd setup uses one.
3. Bootstrap: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitchell.career-ops.email.plist`.

Recommend running it manually for at least one cycle before scheduling —
a malformed Gmail filter or unexpected alert format can produce noise that
clogs `pipeline.md`.

## Troubleshooting

- **"Label not found"** — Gmail creates labels lazily. Send yourself a
  test message and apply the label manually first; the IMAP folder will
  appear afterward.
- **"Authentication failed"** — App Passwords are tied to the specific
  Google account that generated them. Re-issue at
  https://myaccount.google.com/apppasswords if you've recently changed
  your password or 2FA settings.
- **Messages keep getting re-processed** — confirm `--keep-unread` isn't
  set. Without it, the script flags each message `\Seen` after extraction.
- **Pipeline filling up with off-target roles** — tighten the `title_filter`
  in `portals.yml` (especially the catch-all `"AI"` line, which over-matches
  on aggregator alerts) or add platform-specific subject filters in Gmail
  to narrow what gets labelled.
