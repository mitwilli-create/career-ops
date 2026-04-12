# /run — Maintainer Briefing for career-ops

Quick triage of the repo. Run this when you have a few minutes to check what needs attention.

## What it does

Scans open PRs, issues, and recent activity. Returns a prioritized briefing with alerts for sensitive changes.

## Steps

### 1. Gather data

Run these in parallel:

```bash
# Open PRs with merge status
gh pr list --repo santifer/career-ops --state open --json number,title,author,mergeable,createdAt,labels

# Open issues
gh issue list --repo santifer/career-ops --state open --json number,title,labels,comments,createdAt

# Repo stats
gh api repos/santifer/career-ops -q '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count}'

# Recent activity (last 3 days)
gh api repos/santifer/career-ops/events --jq '.[0:20] | .[] | "\(.type) @\(.actor.login) \(.created_at[0:10])"'
```

### 2. Check each PR for sensitive files

For every open PR, run:

```bash
gh pr diff {number} --repo santifer/career-ops --name-only
```

Flag PRs that touch ANY of these sensitive files:

| File | Risk level | Why |
|---|---|---|
| `CLAUDE.md` | 🔴 CRITICAL | Controls agent behavior |
| `modes/_shared.md` | 🔴 CRITICAL | Controls scoring system |
| `DATA_CONTRACT.md` | 🔴 CRITICAL | Defines system/user boundary |
| `modes/*.md` (any mode) | 🟡 HIGH | Changes agent instructions |
| `generate-pdf.mjs` | 🟡 HIGH | PDF generation pipeline |
| `scan.mjs` | 🟡 HIGH | Portal scanner |
| `update-system.mjs` | 🟡 HIGH | System update logic |
| `test-all.mjs` | 🟡 HIGH | Test suite integrity |
| `.claude/skills/**` | 🟡 HIGH | Skill routing |
| `batch/batch-runner.sh` | 🟡 HIGH | Batch execution |
| `package.json` | 🟡 HIGH | Dependencies |
| `.github/**` | 🟢 LOW | CI/templates |
| `docs/**` | 🟢 LOW | Documentation |
| `README*.md` | 🟢 LOW | READMEs |
| `dashboard/**` | 🟢 LOW | Go TUI (isolated) |

### 3. Detect red flags

For each PR, check:

- **PR farming:** Same author with 5+ open PRs → flag
- **No issue linked:** Feature PR without "Fixes #" or "Closes #" → flag
- **Personal data:** Run `gh pr diff {num}` and grep for email patterns, phone numbers, real names
- **New dependencies:** Check if diff touches `package.json` with new entries
- **First-time contributor:** Check if author has previous merged PRs

### 4. Categorize and present

Output format:

```markdown
## /run — career-ops briefing ({date})

**Stats:** {stars} ⭐ | {forks} forks | {watchers} watchers | {open_prs} PRs | {open_issues} issues

---

### 🔴 ALERTS (review immediately)
PRs touching sensitive files or with red flags. Show file list + risk.

### ✅ Ready to merge (tests pass, low risk)
PRs that only touch docs, translations, or low-risk files. No sensitive files.

### 🟡 Needs code review
PRs that touch code but not critical files. Need your review.

### ⏸️ Waiting on contributor
PRs with conflicts, requested changes, or stale (>7 days no activity).

### 📋 New issues (last 3 days)
New issues worth reading. Separate bugs from feature requests.

### 💡 Quick wins
Issues labeled "bug" that look easy to fix, or PRs that are 1-file changes.

---
*Run `/run` again anytime. Briefing takes ~30 seconds.*
```

### 5. Rules

- Be concise — this is a briefing, not an essay
- Always show the file list for ALERT PRs
- Always mention if a contributor is first-time or repeat
- Always check if an issue referenced by a PR was actually discussed/approved
- Never auto-merge — only present information for the maintainer to decide
- Sort by priority: alerts first, then ready-to-merge, then the rest
