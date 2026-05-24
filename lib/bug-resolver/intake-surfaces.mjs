// lib/bug-resolver/intake-surfaces.mjs
//
// Bug-filing surface readers. One reader per intake mechanism. Each returns
// Array<RawBugEntry>. The mapper orchestrator (scripts/agents/bug-intake-mapper.mjs)
// dedups across surfaces by source_hash + assigns stable bug IDs.
//
// RawBugEntry shape:
//   {
//     source_surface: string,         // relative path | "github://..." | "transcript:..." | "memory:..."
//     source_hash: string,            // "sha256:<12hex>" for change detection + dedup
//     title: string,                  // short human-readable title
//     first_seen_iso: string,         // ISO 8601 with PT offset (-07:00)
//     severity: 'CRIT'|'HIGH'|'MED'|'LOW',
//     bug_class: string|null,         // optional link to bug-class catalog pattern
//     summary: string,                // PII-scrubbed ≤120-char summary
//     is_sensitive_source: boolean,   // true → summary is placeholder, never raw content
//   }
//
// Spec: data/bug-resolver-plan.md § 1.1 (intake surface inventory) + § 1.2 (ledger schema).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { hashCite, summarizeCite, isSensitivePath } from '../leak-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const HOME = homedir();
const DATA_DIR = join(REPO_ROOT, 'data');
const AUDIT_DIR = join(REPO_ROOT, '.claude/audit');
const PROJECT_TRANSCRIPTS_DIR = join(HOME, '.claude/projects/-Users-mitchellwilliams-Documents-career-ops');
const PROJECT_MEMORY_DIR = join(PROJECT_TRANSCRIPTS_DIR, 'memory');
const LAUNCHD_LOG_DIR = join(HOME, 'Library/Logs/career-ops');
const DASHBOARD_LOG_DIR = join(DATA_DIR, 'logs');

// ─── PT helpers (UTC-7 for Mitchell's TZ) ───────────────────────────────────
function ptIsoFromMtime(mtimeMs) {
  return new Date(mtimeMs - 7 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
}

function ptIsoNow() {
  return ptIsoFromMtime(Date.now());
}

// ─── Markdown parsing helpers ───────────────────────────────────────────────
function firstH1(content) {
  const m = String(content).match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 200) : null;
}

function parseField(content, fieldName, defaultVal = null) {
  const re = new RegExp('^\\*\\*' + fieldName + ':\\*\\*\\s*(.+?)$', 'mi');
  const m = String(content).match(re);
  return m ? m[1].trim() : defaultVal;
}

function inferSeverity(content, defaultSev = 'MED') {
  const explicit = parseField(content, 'Severity');
  if (explicit) {
    const u = explicit.toUpperCase();
    if (u.includes('CRIT')) return 'CRIT';
    if (u.includes('HIGH')) return 'HIGH';
    if (u.includes('MED')) return 'MED';
    if (u.includes('LOW')) return 'LOW';
  }
  const head = String(content).slice(0, 500).toUpperCase();
  if (/\bCRIT(?:ICAL)?\b|\bFATAL\b|\bBLOCKER\b/.test(head)) return 'CRIT';
  if (/\bHIGH\b|\bSEVERE\b/.test(head)) return 'HIGH';
  if (/\bMED(?:IUM)?\b/.test(head)) return 'MED';
  if (/\bLOW\b|\bMINOR\b|\bTRIVIAL\b/.test(head)) return 'LOW';
  return defaultSev;
}

function inferBugClass(content) {
  const m = String(content).match(/Bug class:?\s*`?([a-z][-a-z]+[a-z])`?/i);
  return m ? m[1].toLowerCase() : null;
}

function rel(absPath) {
  const r = relative(REPO_ROOT, absPath);
  return r && !r.startsWith('..') ? r : absPath;
}

// Build a standard entry from a markdown file + content. Use forceSensitive
// to mark a path as sensitive even when isSensitivePath() returns false
// (e.g., for audit-doc paths whose CONTENT is sensitive but PATH is not).
function makeEntry({ surfaceAbs, content, defaultSev = 'MED', titleFallback = null, firstSeenIso = null, forceSensitive = false }) {
  const surface = rel(surfaceAbs);
  const isSensitive = forceSensitive || isSensitivePath(surfaceAbs);
  return {
    source_surface: surface,
    source_hash: hashCite(content),
    title: firstH1(content) || titleFallback || basename(surfaceAbs),
    first_seen_iso: firstSeenIso || (existsSync(surfaceAbs) ? ptIsoFromMtime(statSync(surfaceAbs).mtimeMs) : ptIsoNow()),
    severity: inferSeverity(content, defaultSev),
    bug_class: inferBugClass(content),
    summary: isSensitive ? '<sensitive source — hash_only>' : summarizeCite(content, 120),
    is_sensitive_source: isSensitive,
  };
}

// Glob within DATA_DIR by basename pattern (no deep walking). Pattern uses *
// as a wildcard; everything else is literal.
function globData(pattern) {
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter(name => re.test(name))
    .map(name => join(DATA_DIR, name))
    .filter(p => { try { return statSync(p).isFile(); } catch { return false; } });
}

// ─── Reader 1: Manual filings (bug-reports/ + *postmortem*.md + dir-based) ──
export function readManualFilings() {
  const entries = [];

  // 1a: data/bug-reports/*.md
  const bugReportsDir = join(DATA_DIR, 'bug-reports');
  if (existsSync(bugReportsDir)) {
    for (const name of readdirSync(bugReportsDir)) {
      if (!name.endsWith('.md')) continue;
      const path = join(bugReportsDir, name);
      try {
        const content = readFileSync(path, 'utf-8');
        const filedDate = parseField(content, 'Filed');
        const filedIso = filedDate
          ? `${filedDate.split(' ')[0]}T00:00:00-07:00`
          : null;
        entries.push(makeEntry({
          surfaceAbs: path,
          content,
          defaultSev: 'MED',
          firstSeenIso: filedIso,
        }));
      } catch { /* skip unreadable */ }
    }
  }

  // 1b: data/*postmortem*.md (top-level, excludes hang-postmortems which have their own reader)
  for (const path of globData('*postmortem*.md')) {
    if (/hang-postmortem/.test(path)) continue; // handled by readHangPostmortems
    try {
      const content = readFileSync(path, 'utf-8');
      entries.push(makeEntry({
        surfaceAbs: path,
        content,
        defaultSev: 'HIGH',
      }));
    } catch { /* skip */ }
  }

  // 1c: data/<dir>/postmortem.md (e.g., process-all-postmortem-2026-05-19/postmortem.md)
  if (existsSync(DATA_DIR)) {
    for (const name of readdirSync(DATA_DIR)) {
      const dirPath = join(DATA_DIR, name);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        if (!/postmortem/i.test(name)) continue;
        const inner = join(dirPath, 'postmortem.md');
        if (existsSync(inner)) {
          const content = readFileSync(inner, 'utf-8');
          entries.push(makeEntry({
            surfaceAbs: inner,
            content,
            defaultSev: 'HIGH',
            titleFallback: `Postmortem: ${name}`,
          }));
        }
      } catch { /* skip */ }
    }
  }

  return entries;
}

// ─── Reader 2: Hang postmortems (auto-generated by hang-watchdog) ───────────
export function readHangPostmortems() {
  const entries = [];
  for (const path of globData('hang-postmortem-*.md')) {
    try {
      const content = readFileSync(path, 'utf-8');
      entries.push(makeEntry({
        surfaceAbs: path,
        content,
        defaultSev: 'MED',
      }));
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Reader 3: Regression-guard CRIT/HIGH findings ──────────────────────────
// .claude/audit/<DATE>/regression-report-<DATE>.md — one entry per report.
// Reports are sensitive (frontmatter: [PERSONAL — DO NOT PUBLISH]).
export function readRegressionGuardFindings() {
  const entries = [];
  if (!existsSync(AUDIT_DIR)) return entries;
  for (const dateDir of readdirSync(AUDIT_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
    const dateDirPath = join(AUDIT_DIR, dateDir);
    try {
      if (!statSync(dateDirPath).isDirectory()) continue;
      for (const name of readdirSync(dateDirPath)) {
        if (!/^regression-report-\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        const path = join(dateDirPath, name);
        const content = readFileSync(path, 'utf-8');
        const upper = content.toUpperCase();
        let sev = 'LOW';
        if (upper.includes('CRIT')) sev = 'CRIT';
        else if (upper.includes('HIGH')) sev = 'HIGH';
        else if (upper.includes('MED')) sev = 'MED';
        entries.push(makeEntry({
          surfaceAbs: path,
          content,
          defaultSev: sev,
          titleFallback: `Regression report ${dateDir}`,
          forceSensitive: true, // contents include hashed references to sensitive paths
        }));
      }
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Reader 4: System-maintenance decision-doc findings ─────────────────────
export function readSystemMaintenanceFindings() {
  const entries = [];
  for (const path of globData('system-maintenance-decision-doc-*.md')) {
    try {
      const content = readFileSync(path, 'utf-8');
      entries.push(makeEntry({
        surfaceAbs: path,
        content,
        defaultSev: 'HIGH',
        forceSensitive: true,
      }));
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Reader 5: Email-review findings ────────────────────────────────────────
export function readEmailReviewFindings() {
  const entries = [];
  for (const path of globData('email-review-*.md')) {
    try {
      const content = readFileSync(path, 'utf-8');
      entries.push(makeEntry({
        surfaceAbs: path,
        content,
        defaultSev: 'MED',
        forceSensitive: true,
      }));
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Reader 6: Log stderr errors (RECENT only — last 24h mtime) ─────────────
// Scans .err files modified in the last 24 hours for ERROR/FATAL/Uncaught
// patterns. Each distinct (normalized) error line becomes one entry.
// 24h window avoids re-importing historical noise on every Sunday run.
export function readLogStderrErrors() {
  const entries = [];
  const dirs = [LAUNCHD_LOG_DIR, DASHBOARD_LOG_DIR];
  const cutoffMs = Date.now() - 24 * 3600 * 1000;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.err')) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.mtimeMs < cutoffMs) continue; // skip files untouched in last 24h
        const content = readFileSync(path, 'utf-8');
        const errLines = [];
        const seen = new Set();
        for (const line of content.split('\n').reverse()) {
          if (!/FATAL|Uncaught|TypeError|SyntaxError|ReferenceError|Error:/.test(line)) continue;
          const norm = line.replace(/\d+/g, '#').slice(0, 200);
          if (seen.has(norm)) continue;
          seen.add(norm);
          errLines.push(line.trim());
          if (errLines.length >= 3) break; // cap per-file
        }
        for (const line of errLines) {
          entries.push({
            source_surface: rel(path),
            source_hash: hashCite(line),
            title: `Log error: ${line.slice(0, 80)}`,
            first_seen_iso: ptIsoFromMtime(st.mtimeMs),
            severity: /FATAL/i.test(line) ? 'HIGH' : 'MED',
            bug_class: null,
            summary: summarizeCite(line, 120),
            is_sensitive_source: false,
          });
        }
      } catch { /* skip */ }
    }
  }
  return entries;
}

// ─── Reader 7: Regression-guard dashboard panel (top_15) ────────────────────
export function readDashboardPanels() {
  const entries = [];
  const panelPath = join(DATA_DIR, 'dashboard-panels/regression-guard.json');
  if (!existsSync(panelPath)) return entries;
  try {
    const raw = readFileSync(panelPath, 'utf-8');
    const json = JSON.parse(raw);
    const top = Array.isArray(json.top_15) ? json.top_15 : [];
    const mtime = statSync(panelPath).mtimeMs;
    for (const finding of top) {
      if (!finding || typeof finding !== 'object') continue;
      const title = String(finding.title || finding.summary || finding.id || '(untitled finding)');
      const sev = String(finding.severity || 'MED').toUpperCase();
      entries.push({
        source_surface: 'data/dashboard-panels/regression-guard.json',
        source_hash: hashCite(JSON.stringify(finding)),
        title: `RG panel: ${title.slice(0, 150)}`,
        first_seen_iso: ptIsoFromMtime(mtime),
        severity: ['CRIT','HIGH','MED','LOW'].includes(sev) ? sev : 'MED',
        bug_class: finding.bug_class || finding.type || null,
        summary: summarizeCite(title, 120),
        is_sensitive_source: false,
      });
    }
  } catch { /* skip */ }
  return entries;
}

// ─── Reader 8: GitHub issues (open + labeled 'bug' or title contains 'bug') ─
export function readGitHubIssues() {
  const entries = [];
  try {
    const out = execSync(
      "gh issue list --repo mitwilli-create/career-ops --state open " +
      "--json number,title,labels,createdAt,body --limit 50",
      { encoding: 'utf-8', timeout: 30_000 }
    );
    const issues = JSON.parse(out);
    for (const iss of issues) {
      const labels = (iss.labels || []).map(l => l.name);
      const isBug = labels.includes('bug') || /bug/i.test(iss.title);
      if (!isBug) continue;
      const severity =
        labels.includes('P0') ? 'CRIT' :
        labels.includes('P1') ? 'HIGH' :
        labels.includes('P2') ? 'MED' : 'LOW';
      entries.push({
        source_surface: `github://mitwilli-create/career-ops/issues/${iss.number}`,
        source_hash: hashCite(`gh:${iss.number}:${iss.title}`),
        title: iss.title,
        first_seen_iso: iss.createdAt || ptIsoNow(),
        severity,
        bug_class: null,
        summary: summarizeCite(iss.body || iss.title, 120),
        is_sensitive_source: false,
      });
    }
  } catch {
    // gh CLI not installed / auth missing / network — skip silently.
    // The mapper's report will note "github-issues: skipped (0 entries)".
  }
  return entries;
}

// ─── Reader 9: Transcript bug-flag heuristic (HASH-ONLY, sensitive) ─────────
// Scans recent Claude session transcripts for SPECIFIC failure phrases.
// NEVER includes raw content — count + hash only. Source path matches
// SENSITIVE_PATH_PATTERNS so cross-fork-leak guard applies.
//
// Heuristic is TIGHT by design: low-volume single-word matches ("bug", "fails")
// occur naturally in coding discourse. Only sustained failure-phrase patterns
// indicate Mitchell actually flagged a bug in conversation.
//
// Tuning notes: 14-day window + 25+ hits + specific failure phrases catches
// real bug-flag sessions while filtering normal coding discussion. Raise
// threshold if false-positive rate stays high; lower window if real flags
// are missed.
export function readTranscriptBugFlags() {
  const entries = [];
  if (!existsSync(PROJECT_TRANSCRIPTS_DIR)) return entries;
  const cutoffMs = Date.now() - 14 * 86400 * 1000; // 14-day window
  // Restrictive — specific failure phrases, not bare keywords.
  const triggerRe = /\b(doesn'?t work|isn'?t working|is broken|not working|got an error|throws an error|threw an error|silent(?:ly)? fail(?:s|ed|ing)|crashes?|silently broke|regression(?:ed)?|borked)\b/gi;
  for (const name of readdirSync(PROJECT_TRANSCRIPTS_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(PROJECT_TRANSCRIPTS_DIR, name);
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoffMs) continue;
      const raw = readFileSync(path, 'utf-8');
      const matches = (raw.match(triggerRe) || []).length;
      if (matches < 25) continue; // very high bar; reduce if real flags missed
      entries.push({
        source_surface: `transcript:${name}`,
        source_hash: hashCite(raw),
        title: `Transcript bug-flag heuristic: ${matches} failure phrases in ${name.slice(0, 40)}`,
        first_seen_iso: ptIsoFromMtime(st.mtimeMs),
        severity: 'LOW',
        bug_class: 'transcript-flag-heuristic',
        summary: `<transcript hash-only — ${matches} explicit failure-phrase matches>`,
        is_sensitive_source: true,
      });
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Reader 10: Memory bug-feedback files (sensitive) ───────────────────────
export function readMemoryFeedbackBugs() {
  const entries = [];
  if (!existsSync(PROJECT_MEMORY_DIR)) return entries;
  for (const name of readdirSync(PROJECT_MEMORY_DIR)) {
    if (!/^(feedback|project)_.*(bug|leak|hang|regression).*\.md$/i.test(name)) continue;
    if (name === 'MEMORY.md') continue;
    const path = join(PROJECT_MEMORY_DIR, name);
    try {
      const content = readFileSync(path, 'utf-8');
      const st = statSync(path);
      entries.push({
        source_surface: `memory:${name}`,
        source_hash: hashCite(content),
        title: name.replace(/\.md$/, '').replace(/_/g, ' '),
        first_seen_iso: ptIsoFromMtime(st.mtimeMs),
        severity: 'MED',
        bug_class: 'memory-feedback-bug',
        summary: `<memory hash-only — sensitive path>`,
        is_sensitive_source: true,
      });
    } catch { /* skip */ }
  }
  return entries;
}

// ─── Registry ───────────────────────────────────────────────────────────────
//
// DEFAULT readers — high-signal, actionable bug surfaces. These run by default
// and feed the resolver pipeline directly.
//
// OPT-IN readers — lower-signal heuristic surfaces. transcript-flags catches
// sessions with sustained failure-phrase patterns (a "look-here" pointer, not
// an extractable bug instance). memory-feedback catches bug-class DOCS (rules
// for avoiding bugs), not bug instances. Both need separate human triage —
// they shouldn't enter the resolver pipeline blindly. Invoke explicitly via
// `--surface transcript-flags` or `--surface memory-feedback`.
//
// The mapper exposes both groups via ALL_READERS_INCLUDING_OPT_IN for the
// --surface flag, but iterates only DEFAULT_READERS on a no-flag run.
export const DEFAULT_READERS = [
  { name: 'manual-filings',     fn: readManualFilings },
  { name: 'hang-postmortems',   fn: readHangPostmortems },
  { name: 'regression-guard',   fn: readRegressionGuardFindings },
  { name: 'system-maintenance', fn: readSystemMaintenanceFindings },
  { name: 'email-review',       fn: readEmailReviewFindings },
  { name: 'log-stderr',         fn: readLogStderrErrors },
  { name: 'dashboard-panels',   fn: readDashboardPanels },
  { name: 'github-issues',      fn: readGitHubIssues },
];

export const OPT_IN_READERS = [
  { name: 'transcript-flags',   fn: readTranscriptBugFlags },
  { name: 'memory-feedback',    fn: readMemoryFeedbackBugs },
];

export const ALL_READERS_INCLUDING_OPT_IN = [...DEFAULT_READERS, ...OPT_IN_READERS];

// Back-compat alias — old name pointed to default set.
export const ALL_READERS = DEFAULT_READERS;
