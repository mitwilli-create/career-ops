#!/usr/bin/env bash
# post-batch-complete.sh — runs after the full pipeline batch finishes.
# Triggered by the watcher process; do NOT call directly while batch is running.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$PROJECT_DIR/data/logs/post-batch-complete.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

cd "$PROJECT_DIR"
log "=== post-batch-complete starting ==="

# 1 — Sync [x] checkboxes in pipeline.md
log "Marking evaluated items in pipeline.md..."
node scripts/mark-pipeline-evaluated.mjs 2>&1 | tee -a "$LOG"

# 2 — Verify pipeline integrity
log "Running pipeline verification..."
node verify-pipeline.mjs 2>&1 | tee -a "$LOG"

# 3 — Dedup tracker (catch any dupes from parallel workers)
log "Deduplicating tracker..."
node dedup-tracker.mjs 2>&1 | tee -a "$LOG"

# 4 — Pattern analysis
log "Running pattern analysis..."
node analyze-patterns.mjs 2>&1 | tee -a "$LOG"

# 5 — Follow-up cadence
log "Running follow-up cadence..."
node followup-cadence.mjs 2>&1 | tee -a "$LOG"

# 6 — Recompute dashboard stats and patch index.html
log "Updating dashboard stats..."
node - <<'EOF' 2>&1 | tee -a "$LOG"
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

const root = process.cwd();
const pipeline = readFileSync(path.join(root, 'data/pipeline.md'), 'utf8');
const pending = (pipeline.match(/^- \[ \]/gm) || []).length;

const apps = readFileSync(path.join(root, 'data/applications.md'), 'utf8');
const rows = apps.split('\n').filter(l => /^\|/.test(l) && !/^[\|:\s\-]+$/.test(l) && !l.includes('# |'));
const dataRows = rows.slice(1); // skip header

const totalEvals = dataRows.filter(r => r.includes('Evaluated') || r.includes('Applied') || r.includes('Interview') || r.includes('Offer') || r.includes('SKIP') || r.includes('Discarded') || r.includes('Rejected')).length;

const applyNow = dataRows.filter(r => {
  const scoreMatch = r.match(/\|\s*([\d.]+)\/5/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
  return score >= 4.0 && (r.includes('Evaluated') || r.includes('Applied') || r.includes('Interview'));
}).length;

const applied = dataRows.filter(r => r.includes('Applied') || r.includes('Interview') || r.includes('Offer')).length;

const scanHistory = readFileSync(path.join(root, 'data/scan-history.tsv'), 'utf8');
const scanned = scanHistory.split('\n').filter(l => l.trim() && !l.startsWith('url')).length;

const companies = new Set();
dataRows.forEach(r => {
  const parts = r.split('|').map(p => p.trim());
  if (parts[3]) companies.add(parts[3]);
});

console.log(`Stats: applyNow=${applyNow} totalEvals=${totalEvals} applied=${applied} pending=${pending} companies=${companies.size} scanned=${scanned}`);

const dashPath = path.join(root, 'dashboard/index.html');
let html = readFileSync(dashPath, 'utf8');

// Replace the 6 stat-value entries in order: applyNow, totalEvals, applied, pending, companies, scanned
let count = 0;
html = html.replace(/<div class="stat-value">(\d+)<\/div>/g, (match) => {
  count++;
  switch (count) {
    case 1: return `<div class="stat-value">${applyNow}</div>`;
    case 2: return `<div class="stat-value">${totalEvals}</div>`;
    case 3: return `<div class="stat-value">${applied}</div>`;
    case 4: return `<div class="stat-value">${pending}</div>`;
    case 5: return `<div class="stat-value">${companies.size}</div>`;
    case 6: return `<div class="stat-value">${scanned}</div>`;
    default: return match;
  }
});

writeFileSync(dashPath, html);
console.log(`Dashboard updated: pending=${pending}, totalEvals=${totalEvals}, applyNow=${applyNow}`);
EOF

# 7 — Commit everything (gitignore exempts personal data, but scripts/logs are fair game)
log "Committing batch artifacts..."
git -C "$PROJECT_DIR" add scripts/mark-pipeline-evaluated.mjs scripts/post-batch-complete.sh scripts/launchd/ 2>/dev/null || true
git -C "$PROJECT_DIR" diff --cached --quiet || \
  git -C "$PROJECT_DIR" commit -m "post-batch: mark-pipeline-evaluated + post-batch-complete scripts

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" 2>&1 | tee -a "$LOG" || true

# 8 — Send heartbeat email
log "Sending heartbeat email..."
cd "$PROJECT_DIR"
node scripts/heartbeat.mjs --send 2>&1 | tee -a "$LOG"

log "=== post-batch-complete finished ==="
