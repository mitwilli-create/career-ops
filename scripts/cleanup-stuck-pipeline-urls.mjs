#!/usr/bin/env node
// scripts/cleanup-stuck-pipeline-urls.mjs
//
// ONE-TIME CLEANUP (2026-05-27 PR fix/pipeline-dupe-drain).
//
// Why this exists:
//   Between roughly 2026-05-25 and 2026-05-27 every Anthropic batch erroring
//   with `temperature is deprecated for this model` left URLs stuck `[ ]` in
//   data/pipeline.md. Each Process All re-triage-advanced the same 179 URLs.
//   The temperature fix shipped in this same PR; this script clears the
//   backlog so the next Process All advances NEW work instead of re-batching
//   the stuck cohort.
//
// What it does (conservative):
//   For each `- [ ] URL | Company | Role[ | …]` line in data/pipeline.md,
//   parse Company + Role from the pipe-delimited metadata. If a fuzzy match
//   exists in data/applications.md (any row, any status), mark the pipeline
//   line `[x]` — it's already-tracked work, no need to re-batch.
//
//   URLs WITHOUT pipe metadata are left alone (can't confidently match).
//   URLs whose Company+Role is genuinely net-new to applications.md are
//   left alone (next Process All can pick them up cleanly).
//
// Defaults: --dry-run prints the proposed plan + counts. Pass --apply to
// commit the change. Idempotent — running twice is a no-op.
//
// Usage:
//   node scripts/cleanup-stuck-pipeline-urls.mjs               # dry-run
//   node scripts/cleanup-stuck-pipeline-urls.mjs --apply       # commit
//   node scripts/cleanup-stuck-pipeline-urls.mjs --verbose     # show every decision

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PIPELINE_FILE     = join(ROOT, 'data/pipeline.md');
const APPLICATIONS_FILE = join(ROOT, 'data/applications.md');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = true] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const APPLY   = ARGS.apply === true || ARGS.apply === 'true';
const VERBOSE = ARGS.verbose === true || ARGS.verbose === 'true';

// ── Fuzzy match helpers ──────────────────────────────────────────────
function normCompany(s) {
  return (s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[\s,.\-_()]+/g, ' ')
    .replace(/\b(inc|corp|llc|ltd|gmbh|labs|ai|the)\b/g, '')
    .trim();
}
function normRole(s) {
  return (s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[(),.\/\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function roleTokens(s) {
  return new Set(normRole(s).split(' ').filter(t => t.length > 2));
}
// Conservative match: company exact (normalised) AND role tokens overlap ≥ 60%
function isMatch(pipeCompany, pipeRole, appCompany, appRole) {
  if (normCompany(pipeCompany) !== normCompany(appCompany)) return false;
  const pTok = roleTokens(pipeRole);
  const aTok = roleTokens(appRole);
  if (pTok.size === 0 || aTok.size === 0) return false;
  let overlap = 0;
  for (const t of pTok) if (aTok.has(t)) overlap++;
  const ratio = overlap / Math.max(pTok.size, aTok.size);
  return ratio >= 0.6;
}

// ── Parse applications.md ────────────────────────────────────────────
function parseApplications(text) {
  const rows = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim());
    // Expected: ['', '#', 'Date', 'Company', 'Role', ...]
    if (cells.length < 5) continue;
    if (cells[1] === '#' || cells[1] === '') continue;
    const num = cells[1];
    const company = cells[3];
    const role = cells[4];
    if (!company || !role) continue;
    rows.push({ num, company, role });
  }
  return rows;
}

// ── Parse pipeline.md `[ ]` lines ────────────────────────────────────
const PIPELINE_LINE_RE = /^- \[ \] (\S+?)(?:\s+\|\s+([^|]+?)(?:\s+\|\s+([^|]+?))?(?:\s+\|\s+([^|]+?))?)?\s*$/;
function parseStuckLines(text) {
  const out = [];
  text.split('\n').forEach((line, idx) => {
    const m = PIPELINE_LINE_RE.exec(line);
    if (!m) return;
    const [, url, company, role] = m;
    out.push({ lineNo: idx + 1, raw: line, url, company: company?.trim() || null, role: role?.trim() || null });
  });
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────
function main() {
  const pipelineText     = readFileSync(PIPELINE_FILE, 'utf8');
  const applicationsText = readFileSync(APPLICATIONS_FILE, 'utf8');

  const stuck = parseStuckLines(pipelineText);
  const apps  = parseApplications(applicationsText);

  const matched = [];
  const noMeta  = [];
  const noMatch = [];

  for (const s of stuck) {
    if (!s.company || !s.role) { noMeta.push(s); continue; }
    const hit = apps.find(a => isMatch(s.company, s.role, a.company, a.role));
    if (hit) matched.push({ stuck: s, app: hit });
    else noMatch.push(s);
  }

  console.log(`Stuck \`[ ]\` URLs in data/pipeline.md: ${stuck.length}`);
  console.log(`  Matched (already in applications.md):     ${matched.length}`);
  console.log(`  Has metadata, no app match (truly new):   ${noMatch.length}`);
  console.log(`  No pipe metadata (skipped — can't match):  ${noMeta.length}`);

  if (VERBOSE) {
    console.log('\n── First 10 matches ──');
    for (const m of matched.slice(0, 10)) {
      console.log(`  Q: ${m.stuck.company} / ${m.stuck.role}`);
      console.log(`  A: #${m.app.num} ${m.app.company} / ${m.app.role}`);
      console.log('');
    }
    if (noMatch.length) {
      console.log('── First 10 net-new (left alone) ──');
      for (const n of noMatch.slice(0, 10)) {
        console.log(`  ${n.company} / ${n.role}`);
      }
    }
  }

  if (matched.length === 0) {
    console.log('\nNothing to mark. Exiting.');
    return;
  }

  // Apply: replace each matched line in-place.
  let updated = pipelineText;
  let actualChanges = 0;
  for (const m of matched) {
    const before = updated;
    // Use the raw line as the replace target to avoid clobbering similar URLs.
    const after = updated.replace(m.stuck.raw, m.stuck.raw.replace(/^- \[ \]/, '- [x]'));
    if (after !== before) {
      updated = after;
      actualChanges++;
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — would mark ${actualChanges} URLs as \`[x]\`. Pass --apply to commit.`);
    return;
  }

  if (actualChanges === 0) {
    console.log('\nNo changes after replace (already idempotent?).');
    return;
  }

  writeFileSync(PIPELINE_FILE, updated);
  console.log(`\n✅ Marked ${actualChanges} URLs as \`[x]\` in data/pipeline.md`);
}

main();
