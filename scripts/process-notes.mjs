#!/usr/bin/env node
/**
 * 1:1 meeting notes intake system for Mitchell's career history.
 *
 * Reads a raw notes file, uses Claude to extract structured project updates,
 * manager feedback, career signals, and new proof points, then writes:
 *   - data/career-history/YYYY-MM-DD-1on1.md   (structured session record)
 *   - data/career-history/projects-log.md        (rolling append, all sessions)
 *
 * Usage:
 *   node scripts/process-notes.mjs                        # auto-picks oldest inbox file
 *   node scripts/process-notes.mjs path/to/notes.txt      # explicit file
 *   node scripts/process-notes.mjs --date=2026-05-06      # override date stamp
 *   node scripts/process-notes.mjs --dry-run              # print output, don't write
 *
 * Drop raw notes in: data/career-history/inbox/
 * Processed files move to: data/career-history/processed/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const INBOX_DIR  = join(ROOT, 'data/career-history/inbox');
const PROCESSED_DIR = join(ROOT, 'data/career-history/processed');
const HISTORY_DIR = join(ROOT, 'data/career-history');
const LOG_PATH = join(HISTORY_DIR, 'projects-log.md');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateArg = args.find(a => a.startsWith('--date='));
const fileArg = args.find(a => !a.startsWith('--'));

for (const d of [INBOX_DIR, PROCESSED_DIR, HISTORY_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ─── Pick source file ────────────────────────────────────────────────────────

function pickInboxFile() {
  const files = readdirSync(INBOX_DIR)
    .filter(f => !f.startsWith('.') && f.match(/\.(txt|md|rtf|log)$/i));
  if (files.length === 0) {
    console.error('No files found in data/career-history/inbox/');
    console.error('Drop your notes file there, then re-run.');
    process.exit(1);
  }
  files.sort();
  return join(INBOX_DIR, files[0]);
}

const sourcePath = fileArg ? fileArg : pickInboxFile();
if (!existsSync(sourcePath)) {
  console.error(`File not found: ${sourcePath}`);
  process.exit(1);
}

const rawNotes = readFileSync(sourcePath, 'utf-8');
console.log(`Processing: ${sourcePath} (${rawNotes.length} chars)`);

// ─── Infer meeting date ───────────────────────────────────────────────────────

function inferDate(filePath, raw) {
  if (dateArg) return dateArg.split('=')[1];
  // Try YYYY-MM-DD in filename
  const nameMatch = basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  if (nameMatch) return nameMatch[1];
  // Try date patterns in the first 500 chars of content
  const head = raw.slice(0, 500);
  const contentMatch = head.match(/\b(20\d{2}[-\/]\d{2}[-\/]\d{2})\b/);
  if (contentMatch) return contentMatch[1].replace(/\//g, '-');
  // Fallback to today
  return new Date().toISOString().slice(0, 10);
}

const meetingDate = inferDate(sourcePath, rawNotes);
console.log(`Meeting date: ${meetingDate}`);

// ─── Claude extraction prompt ─────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured career history data from raw 1:1 meeting notes.

The person is Mitchell Williams — Internal Communications Lead and Program Manager at Google xGE. He manages several AI and program initiatives for ~1,000 senior technical engineers (Principal/Distinguished/Fellow tiers). He is also actively job searching for AI-native roles and needs his career history kept sharp and metrics-rich.

MEETING DATE: ${meetingDate}

RAW NOTES:
---
${rawNotes}
---

Extract the following into structured markdown. Be specific — pull exact numbers, quotes, project names, timelines, and signals verbatim from the notes where available. Infer nothing; only capture what is actually present.

Output EXACTLY this format (preserve all section headers):

## Projects & Updates

For each project or initiative mentioned, write:

### [Project Name]
- **Status:** [current state in one phrase]
- **This week:** [what moved, what shipped, what changed]
- **Metrics / proof points:** [any numbers, percentages, counts, time savings — if none, omit this line]
- **Blockers:** [anything stuck — if none, omit this line]
- **Next steps:** [what's planned — if none, omit this line]
- **Manager signal:** [anything the manager said about this project specifically — if none, omit]

## Manager Feedback

### Praise / Recognition
[Bullet list of explicit or implied positive feedback. If none clearly stated, write "None recorded."]

### Coaching / Redirection
[Bullet list of constructive feedback, course-corrections, or areas to develop. If none, write "None recorded."]

### Concerns / Watch Items
[Bullet list of anything flagged as a risk or problem. If none, write "None recorded."]

## Career Signals

[Bullet list of anything that reveals trajectory — mentions of promotion, visibility opportunities, new scope, strategic assignments, org changes, succession hints, or performance indicators. If none, write "None recorded."]

## New Proof Points (CV-ready)

[Bullet list of any metric, achievement, or impact statement that could be added to the CV or apply packs. Format each as a tight, quantified bullet. If none emerge from these notes, write "None this session."]

## Action Items

| Owner | Item | Due |
|-------|------|-----|
[One row per action item. Use "Mitchell" or "Manager" as owner. If no due date, write "—".]

## Manager Quotes

[Direct quotes or close paraphrases from the manager. If none, write "None recorded."]

Be terse. Do not editorialize. Do not add context beyond what is in the notes. Output only the structured markdown above — no preamble, no closing remarks.`;

// ─── Run Claude ───────────────────────────────────────────────────────────────

console.log('Extracting with Claude…');
const result = spawnSync('claude', ['-p', '--output-format=text'], {
  input: EXTRACTION_PROMPT,
  encoding: 'utf-8',
  cwd: ROOT,
  maxBuffer: 8 * 1024 * 1024,
  timeout: 120_000,
});

if (result.status !== 0) {
  console.error('Claude extraction failed:');
  console.error(result.stderr || '(no stderr)');
  process.exit(1);
}

const extracted = (result.stdout || '').trim();
if (!extracted) {
  console.error('Claude returned empty output.');
  process.exit(1);
}

// ─── Build session document ───────────────────────────────────────────────────

const sessionDoc = `# 1:1 Notes — ${meetingDate}

> **Source file:** ${basename(sourcePath)}
> **Processed:** ${new Date().toISOString().slice(0, 16)} UTC

${extracted}

---
*Generated by \`scripts/process-notes.mjs\`*
`;

// ─── Build projects-log entry ─────────────────────────────────────────────────

// Pull a short summary: project names + any proof points for the rolling log
function extractProjectNames(md) {
  const matches = [...md.matchAll(/^### (.+)$/gm)];
  return matches.map(m => m[1].trim()).filter(n =>
    !['Praise / Recognition', 'Coaching / Redirection', 'Concerns / Watch Items'].includes(n)
  );
}

function extractProofPoints(md) {
  const section = md.match(/## New Proof Points[\s\S]*?(?=##|$)/);
  if (!section) return [];
  return (section[0].split('\n').filter(l => l.startsWith('- ')).slice(0, 5));
}

const projectNames = extractProjectNames(extracted);
const proofPoints = extractProofPoints(extracted);

const logEntry = `
---

## ${meetingDate}

**Projects touched:** ${projectNames.length > 0 ? projectNames.join(' · ') : 'See full record'}

${proofPoints.length > 0 ? `**New proof points:**\n${proofPoints.join('\n')}` : ''}

→ Full record: [${meetingDate}-1on1.md](${meetingDate}-1on1.md)
`.trimStart();

// ─── Initialize projects-log if missing ──────────────────────────────────────

function initProjectsLog() {
  const header = `# Projects Log — Running Career History

A rolling record of weekly project updates, manager feedback, and proof points
extracted from 1:1 meeting notes. Each entry links to the full structured record.

Generated by \`scripts/process-notes.mjs\`.
`;
  writeFileSync(LOG_PATH, header);
}

// ─── Write outputs ────────────────────────────────────────────────────────────

const sessionPath = join(HISTORY_DIR, `${meetingDate}-1on1.md`);

if (DRY_RUN) {
  console.log('\n=== SESSION DOCUMENT ===\n');
  console.log(sessionDoc);
  console.log('\n=== PROJECTS LOG ENTRY ===\n');
  console.log(logEntry);
  console.log('\n[Dry run — no files written]');
  process.exit(0);
}

writeFileSync(sessionPath, sessionDoc);
console.log(`Written: ${sessionPath}`);

if (!existsSync(LOG_PATH)) initProjectsLog();
appendFileSync(LOG_PATH, '\n' + logEntry);
console.log(`Appended to: ${LOG_PATH}`);

// Move source to processed/
const destPath = join(PROCESSED_DIR, basename(sourcePath));
renameSync(sourcePath, destPath);
console.log(`Moved source: ${destPath}`);

console.log('\nDone. Review the session record before using proof points in apply packs.');
