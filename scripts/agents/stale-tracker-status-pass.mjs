#!/usr/bin/env node
/**
 * scripts/agents/stale-tracker-status-pass.mjs
 *
 * Guarded, reversible "stale-data" pass over data/applications.md.
 *
 * Born from Mitchell's 2026-06-08 weekly calibration proposal: every tracking
 * row older than 30 days gets an automated status pass — closed roles purged,
 * below-floor roles discarded, keeper roles refreshed. That proposal is
 * DESTRUCTIVE (auto-purge + auto-discard), so it was deliberately NOT
 * implemented during the 2026-06-08 ingest. This script is the reversible-by-
 * design version.
 *
 * ── Classification (only for rows that are (a) confidently parseable,
 *    (b) older than the stale threshold, AND (c) in an in-scope status) ──
 *
 *   1. PURGE   — posting is CLOSED (liveness=expired). Archive the row
 *                verbatim to data/applications-archive/ + flip status to
 *                Discarded with an audit note. NEVER hard-deletes the row from
 *                applications.md (referential integrity: report links + num
 *                spaces). The archive file + audit JSONL are the audit trail.
 *   2. DISCARD — score < 4.0 AND posting still live AND stale. Flip status to
 *                Discarded with an audit note. Gated by an override allowlist
 *                (data/triage-overrides.json, gate='stale-status-pass').
 *   3. REFRESH — keeper (score ≥ 4.0) AND live AND stale. Routes to
 *                scripts/agents/intel-refresh.mjs --row <QUEUE-num>, respecting
 *                its 3-day cache TTL. ~$35/row at full refresh, so this is
 *                OPT-IN even under --apply (requires --refresh-keepers) and
 *                capped (--max-refresh / STALE_REFRESH_MAX_ROWS).
 *
 * ── Safety guarantees ──
 *   • DRY-RUN BY DEFAULT. No flag ⇒ mutates nothing; prints would-purge /
 *     would-discard / would-refresh counts + per-row reasons; writes a report.
 *   • --apply REFUSES unless STALE_STATUS_PASS_ENABLED=true (phased-rollout
 *     kill switch, default off; mirrors DISCARD_GATE_ENABLED precedent).
 *   • Before ANY mutation, snapshots the whole tracker to
 *     data/applications-archive/applications-md-snapshot-<TS>.md (one-line
 *     rollback = copy it back). cv.md "archive pre-edit state first" discipline,
 *     applied to the tracker.
 *   • Unparseable rows (corrupted/column-swapped, e.g. the historical row 2721)
 *     are NEVER touched — strict num+date+status parse, fail-safe to skip.
 *   • `uncertain` liveness NEVER purges — only a hard `expired` does.
 *   • In-scope statuses default to Evaluated ONLY. Applied/Responded/Interview/
 *     Offer are live processes; Rejected/Discarded are terminal. The pass does
 *     not auto-discard anything you're actively pursuing.
 *
 * ── Two-num-space caveat (AGENTS.md) ──
 *   applications.md num and apply-now-queue.json num are independent spaces for
 *   the same logical roles. intel-refresh --row resolves the QUEUE space first,
 *   so passing an applications.md num could refresh a DIFFERENT role. Keeper
 *   refresh therefore maps each keeper to its queue num by company+role match
 *   and only refreshes keepers with a clean mapping; the rest are reported for
 *   manual review.
 *
 * CLI:
 *   node scripts/agents/stale-tracker-status-pass.mjs                # dry-run (safe)
 *   node scripts/agents/stale-tracker-status-pass.mjs --skip-liveness # fast dry-run, no purges
 *   STALE_STATUS_PASS_ENABLED=true node scripts/agents/stale-tracker-status-pass.mjs --apply
 *   STALE_STATUS_PASS_ENABLED=true node ... --apply --refresh-keepers --max-refresh 3
 *
 * Flags:
 *   --apply            Perform purge + discard mutations (requires env gate).
 *   --refresh-keepers  Also spawn intel-refresh for mapped keepers (needs --apply).
 *   --skip-liveness    Skip the Playwright liveness sweep (no purges; faster).
 *   --stale-days N     Override the 30-day threshold (env STALE_DAYS).
 *   --max-refresh N    Cap keeper refreshes (default 3 / env STALE_REFRESH_MAX_ROWS).
 *   --limit N          Cap rows processed (testing).
 *   --json             Machine-readable result to stdout (suppresses pretty summary).
 *   --tracker PATH / --overrides PATH / --queue PATH / --archive-dir PATH
 *                      Path overrides (testing / non-default layouts).
 *   --help
 *
 * Cross-fork-leak hardening: the written report carries
 * classification: "[PERSONAL — DO NOT PUBLISH]" frontmatter. All inputs/outputs
 * are gitignored personal data.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);

// ── Tunables ────────────────────────────────────────────────────────────────
export const SCORE_FLOOR = 4.0;                 // <4.0 ⇒ discard (matches batch/triage-prompt threshold)
export const STALE_DAYS_DEFAULT = 30;           // >30d ⇒ stale
export const COST_PER_KEEPER_USD = 35;          // intel-refresh full 7-slot estimate (AGENTS.md)
export const IN_SCOPE_STATUSES = new Set(['evaluated']); // ONLY Evaluated rows are subject to the pass

// Canonical status alias map — mirrors templates/states.yml. Kept inline so the
// classifier has zero YAML-parse dependency on a file that may be edited.
const STATUS_ALIASES = Object.freeze({
  evaluated: 'evaluated', evaluada: 'evaluated',
  applied: 'applied', aplicado: 'applied', enviada: 'applied', aplicada: 'applied', sent: 'applied',
  responded: 'responded', respondido: 'responded',
  interview: 'interview', entrevista: 'interview',
  offer: 'offer', oferta: 'offer',
  rejected: 'rejected', rechazado: 'rejected', rechazada: 'rejected',
  discarded: 'discarded', skip: 'discarded', no_aplicar: 'discarded', monitor: 'discarded',
});

// ── Pure helpers (exported for hermetic unit tests) ──────────────────────────

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function normKey(company, role) {
  return `${slugify(company)}::${slugify(role)}`;
}

export function normalizeStatus(raw) {
  const k = String(raw || '').toLowerCase().replace(/[*_`]/g, '').trim();
  return STATUS_ALIASES[k] || k;
}

/** Whole days between an ISO YYYY-MM-DD date and a reference epoch-ms (UTC). null if unparseable. */
export function computeAgeDays(dateStr, todayMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.floor((todayMs - then) / 86400000);
}

/**
 * Line-aware tracker parser. Mirrors lib/parse-applications.mjs (the canonical
 * read-only parser) but adds: line index + raw line (needed for in-place
 * mutation), STRICT num/date/score parsing (needed to refuse acting on
 * corrupted rows), and a `malformed` flag.
 *
 * Returns rows with: { lineIndex, raw, malformed, num, date, dateOk, company,
 * role, scoreRaw, score, scoreKnown, status, reportPath, notes }.
 */
export function parseTrackerLines(text) {
  const lines = String(text || '').split('\n');
  const rows = [];
  const SEP = /^[|\s\-:]+$/;
  const HDR = /\|\s*#\s*\|/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (SEP.test(line)) continue;
    if (HDR.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    // A well-formed data row splits to >= 11 cells: ['', num, date, company, role, score, status, pdf, report, notes, ''].
    if (cells.length < 10) { rows.push({ lineIndex: i, raw: line, malformed: true, cells }); continue; }
    const numStr = cells[1] || '';
    const date = cells[2] || '';
    const company = cells[3] || '';
    const role = cells[4] || '';
    const scoreStr = cells[5] || '';
    const status = cells[6] || '';
    const reportCell = cells[8] || '';
    const notes = cells[9] || '';
    if (!company) continue;
    const numMatch = numStr.match(/^(\d+)$/);                 // STRICT: digits only
    const num = numMatch ? parseInt(numMatch[1], 10) : null;
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);          // STRICT: ISO date only
    const scoreMatch = scoreStr.match(/^(\d+(?:\.\d+)?)\s*\/\s*5$/) || scoreStr.match(/^(\d+(?:\.\d+)?)$/);
    const scoreKnown = !!scoreMatch;
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;
    const reportMatch = reportCell.match(/\(([^)]+)\)/);
    const reportPath = reportMatch ? reportMatch[1] : '';
    rows.push({
      lineIndex: i, raw: line, malformed: false, cells,
      num, date, dateOk, company, role, scoreRaw: scoreStr, score, scoreKnown,
      status, reportPath, notes,
    });
  }
  return rows;
}

/**
 * Classify ONE in-scope, stale, parseable row. Pure — all I/O injected via ctx.
 * ctx: { livenessMap:Map<url,{result,reason}>, overrideSet:Set<number>,
 *        queueIndex:Map<normKey,queueNum>, ageDays:number }
 * row may carry row.url (extracted from the report) for the liveness lookup.
 */
export function classifyRow(row, ctx = {}) {
  const { livenessMap, overrideSet, queueIndex, ageDays } = ctx;
  if (overrideSet && overrideSet.has(Number(row.num))) {
    return { bucket: 'override', action: 'noop', reason: 'override allowlist (gate=stale-status-pass)' };
  }
  const url = row.url || null;
  const live = url && livenessMap ? livenessMap.get(url) : null;
  const liveness = live?.result || 'unknown';
  if (liveness === 'expired') {
    return {
      bucket: 'purge', action: 'purge', liveness, url,
      reason: `posting closed (liveness=expired${live?.reason ? `: ${live.reason}` : ''})`,
    };
  }
  if (!row.scoreKnown) {
    return { bucket: 'score-unknown', action: 'noop', liveness, url, reason: 'score not machine-readable — surfaced for human review' };
  }
  if (row.score < SCORE_FLOOR) {
    return { bucket: 'discard', action: 'discard', liveness, url, reason: `score ${row.score} < ${SCORE_FLOOR} & stale ${ageDays}d` };
  }
  const queueNum = queueIndex ? (queueIndex.get(normKey(row.company, row.role)) || null) : null;
  if (queueNum) {
    return { bucket: 'refresh', action: 'refresh', liveness, url, queueNum, reason: `keeper ${row.score} ≥ ${SCORE_FLOOR}, stale ${ageDays}d → intel-refresh --row ${queueNum}` };
  }
  return { bucket: 'refresh-unmapped', action: 'noop', liveness, url, reason: `keeper ${row.score} ≥ ${SCORE_FLOOR} but not in apply-now queue — intel-refresh N/A, manual review` };
}

/** Full per-row bucketing: eligibility → freshness → scope → classify. Pure. */
export function buildClassification(row, ctx = {}) {
  const staleDays = ctx.staleDays ?? STALE_DAYS_DEFAULT;
  if (row.malformed || row.num == null || !row.dateOk || !row.company || !row.role || !row.status) {
    return { bucket: 'skip-unparseable', action: 'noop', reason: 'row not confidently parseable (num/date/company/role/status)' };
  }
  const ageDays = computeAgeDays(row.date, ctx.todayMs ?? Date.now());
  if (ageDays == null) return { bucket: 'skip-unparseable', action: 'noop', reason: 'bad date' };
  const statusId = normalizeStatus(row.status);
  if (ageDays <= staleDays) return { bucket: 'fresh', action: 'noop', ageDays, statusId, reason: `age ${ageDays}d ≤ ${staleDays}d` };
  if (!IN_SCOPE_STATUSES.has(statusId)) {
    return { bucket: 'out-of-scope', action: 'noop', ageDays, statusId, reason: `status '${statusId}' not in scope (only: ${[...IN_SCOPE_STATUSES].join(', ')})` };
  }
  return { ...classifyRow(row, { ...ctx, ageDays }), ageDays, statusId };
}

// ── I/O helpers ──────────────────────────────────────────────────────────────

function readJsonSafe(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; } catch { return null; }
}

function resolvePath(p) { return isAbsolute(p) ? p : join(ROOT, p); }

function extractUrlFromReport(reportPath) {
  if (!reportPath) return null;
  const abs = resolvePath(reportPath);
  if (!existsSync(abs)) return null;
  try {
    const txt = readFileSync(abs, 'utf-8');
    const m = txt.match(/\*\*URL:\*\*\s*(\S+)/i) || txt.match(/^URL:\s*(\S+)/im);
    if (!m) return null;
    const url = m[1].replace(/[)>\].,]+$/, '');
    return /^https?:\/\//i.test(url) ? url : null;
  } catch { return null; }
}

function loadOverrideSet(overridesPath) {
  const raw = readJsonSafe(overridesPath);
  const arr = Array.isArray(raw?.overrides) ? raw.overrides : [];
  const set = new Set();
  for (const o of arr) {
    if (!o || (o.status != null && o.status !== 'active')) continue;
    if (o.gate === 'stale-status-pass' && o.rowNum != null) set.add(Number(o.rowNum));
  }
  return set;
}

function loadQueueIndex(queuePath) {
  const q = readJsonSafe(queuePath);
  const map = new Map();
  for (const r of (q?.ranked || [])) {
    if (r?.company && r?.role && r?.num != null) map.set(normKey(r.company, r.role), String(r.num));
  }
  return map;
}

/**
 * Liveness sweep by reusing check-liveness.mjs (Playwright). Captures stdout
 * regardless of exit code — check-liveness exits 1 whenever ANY URL is
 * expired/uncertain, which is DATA not failure. Conflating that non-zero exit
 * with a spawn failure is the documented `findings-exit-code-conflated-with-
 * spawn-failure` bug class; we explicitly avoid it.
 */
function runLivenessSweep(urls) {
  const map = new Map();
  if (!urls.length) return { map, ok: true, note: 'no urls' };
  const tmp = join(ROOT, `.stale-liveness-urls.${process.pid}.${Date.now()}.txt`);
  try {
    writeFileSync(tmp, urls.join('\n') + '\n');
    const res = spawnSync('node', ['check-liveness.mjs', '--file', tmp], {
      cwd: ROOT, encoding: 'utf-8', timeout: urls.length * 20000 + 30000,
    });
    const out = res.stdout || '';
    let current = null;
    for (const line of out.split('\n')) {
      const m = line.match(/\b(active|expired|uncertain)\b\s+(https?:\/\/\S+)/);
      if (m) { current = m[2]; map.set(current, { result: m[1], reason: '' }); continue; }
      // reason lines are indented + follow the result line
      if (current && /^\s+\S/.test(line) && map.has(current)) {
        const e = map.get(current); if (!e.reason) e.reason = line.trim();
      }
    }
    const ok = map.size > 0 || urls.length === 0;
    const note = res.error ? `check-liveness spawn error: ${res.error.message}` : (map.size === 0 ? 'check-liveness produced no parseable output (Playwright unavailable?) — all liveness UNKNOWN' : `${map.size}/${urls.length} resolved`);
    return { map, ok, note };
  } catch (err) {
    return { map, ok: false, note: `liveness sweep failed: ${err.message}` };
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* */ }
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    apply: false, refreshKeepers: false, skipLiveness: false, json: false, help: false,
    staleDays: Number(process.env.STALE_DAYS || STALE_DAYS_DEFAULT),
    maxRefresh: Number(process.env.STALE_REFRESH_MAX_ROWS || 3),
    limit: Infinity,
    tracker: join(ROOT, 'data', 'applications.md'),
    overrides: join(ROOT, 'data', 'triage-overrides.json'),
    queue: join(ROOT, 'data', 'apply-now-queue.json'),
    archiveDir: join(ROOT, 'data', 'applications-archive'),
    auditJsonl: join(ROOT, 'data', 'stale-tracker-audit.jsonl'),
    reportDir: join(ROOT, '.claude', 'audit', TODAY),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--apply') out.apply = true;
    else if (a === '--refresh-keepers') out.refreshKeepers = true;
    else if (a === '--skip-liveness') out.skipLiveness = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--stale-days') out.staleDays = Number(next());
    else if (a === '--max-refresh') out.maxRefresh = Number(next());
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--tracker') out.tracker = resolvePath(next());
    else if (a === '--overrides') out.overrides = resolvePath(next());
    else if (a === '--queue') out.queue = resolvePath(next());
    else if (a === '--archive-dir') out.archiveDir = resolvePath(next());
    else if (a === '--audit-jsonl') out.auditJsonl = resolvePath(next());
    else if (a === '--report-dir') out.reportDir = resolvePath(next());
  }
  if (!Number.isFinite(out.staleDays) || out.staleDays < 0) out.staleDays = STALE_DAYS_DEFAULT;
  out.maxRefresh = Math.max(0, Math.min(50, Number.isFinite(out.maxRefresh) ? out.maxRefresh : 3));
  return out;
}

function printUsage() {
  console.log(`stale-tracker-status-pass — guarded, reversible stale-row pass over applications.md

DRY-RUN BY DEFAULT (mutates nothing). --apply is gated by STALE_STATUS_PASS_ENABLED=true.

Usage:
  node scripts/agents/stale-tracker-status-pass.mjs                 # dry-run (safe)
  node scripts/agents/stale-tracker-status-pass.mjs --skip-liveness # fast dry-run (no purges)
  STALE_STATUS_PASS_ENABLED=true node ... --apply                   # purge + discard (no keeper spend)
  STALE_STATUS_PASS_ENABLED=true node ... --apply --refresh-keepers # also refresh keepers (~$${COST_PER_KEEPER_USD}/row)

Flags: --refresh-keepers --skip-liveness --stale-days N --max-refresh N --limit N --json
       --tracker/--overrides/--queue/--archive-dir/--audit-jsonl/--report-dir PATH
Report: ${join('.claude', 'audit', TODAY)}/stale-tracker-status-pass-${TODAY}.md`);
}

function pad(n) { return String(n).padStart(2, '0'); }
function tsStamp() { const d = new Date(); return `${TODAY}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

function buildAuditNote(cls) {
  const reason = String(cls.reason || '').replace(/\|/g, '/').replace(/[⟦⟧]/g, '');
  return `⟦stale-pass ${TODAY}: ${cls.action.toUpperCase()} — ${reason}⟧`;
}

/** Rewrite tracker lines, flipping status→Discarded + appending note for purge/discard targets. */
function applyTrackerMutations(trackerPath, targets) {
  const text = readFileSync(trackerPath, 'utf-8');
  const lines = text.split('\n');
  const byLine = new Map(targets.map((t) => [t.row.lineIndex, t]));
  let applied = 0;
  const skipped = [];
  for (let i = 0; i < lines.length; i++) {
    if (!byLine.has(i)) continue;
    const t = byLine.get(i);
    const cells = lines[i].split('|');
    // cells: ['', ' num ', ' date ', ' company ', ' role ', ' score ', ' status ', ' pdf ', ' report ', ' notes ', '']
    const numCell = (cells[1] || '').trim();
    if (cells.length < 11 || numCell !== String(t.row.num)) {
      skipped.push({ num: t.row.num, lineIndex: i, reason: `shape/num mismatch at apply time (cells=${cells.length}, numCell='${numCell}')` });
      continue;
    }
    cells[6] = ' Discarded ';
    const note = buildAuditNote(t.cls);
    const existing = (cells[9] || '').trim();
    cells[9] = ` ${existing ? `${existing} ${note}` : note} `;
    lines[i] = cells.join('|');
    applied++;
  }
  atomicWrite(trackerPath, lines.join('\n'));
  return { applied, skipped };
}

function spawnKeeperRefresh(queueNum) {
  const res = spawnSync('node', ['scripts/agents/intel-refresh.mjs', '--row', String(queueNum)], {
    cwd: ROOT, encoding: 'utf-8', timeout: 25 * 60 * 1000,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || '{}'); } catch { /* */ }
  const ok = res.status === 0 && parsed?.ok !== false;
  return { ok, exit: res.status, queueNum, summary: parsed, stderrTail: (res.stderr || '').split('\n').slice(-3).join(' ') };
}

function renderReport(ctx) {
  const { args, mode, totalRows, buckets, livenessNote } = ctx;
  const count = (b) => buckets[b]?.length || 0;
  const fmtRow = (r) => `| ${r.row.num} | ${r.row.date} | ${String(r.row.company).slice(0, 24)} | ${String(r.row.role).slice(0, 40)} | ${r.row.scoreRaw || 'n/a'} | ${r.cls.ageDays ?? '?'}d | ${r.cls.liveness || '—'} | ${String(r.cls.reason).replace(/\|/g, '/')} |`;
  const section = (title, b) => {
    const rows = buckets[b] || [];
    if (!rows.length) return `### ${title} — 0\n\n_none_\n`;
    return `### ${title} — ${rows.length}\n\n| # | Date | Company | Role | Score | Age | Liveness | Reason |\n|---|------|---------|------|-------|-----|----------|--------|\n${rows.map(fmtRow).join('\n')}\n`;
  };
  const estCost = count('refresh') * COST_PER_KEEPER_USD;
  return `---
classification: "[PERSONAL — DO NOT PUBLISH]"
agent: stale-tracker-status-pass
date: ${TODAY}
mode: ${mode}
stale_days: ${args.staleDays}
in_scope_statuses: ${[...IN_SCOPE_STATUSES].join(', ')}
---

# Stale-tracker status pass — ${mode === 'apply' ? 'APPLIED' : 'DRY RUN'} — ${TODAY}

Tracker: \`${args.tracker.replace(ROOT + '/', '')}\` (${totalRows} data rows)
Stale threshold: **>${args.staleDays}d** · In-scope statuses: **${[...IN_SCOPE_STATUSES].join(', ')}** · Liveness: ${args.skipLiveness ? 'SKIPPED' : livenessNote}

## Summary

| Bucket | Count |
|--------|-------|
| 🗑️  PURGE (closed → archive + Discarded) | **${count('purge')}** |
| ⬇️  DISCARD (score <${SCORE_FLOOR}, live, stale) | **${count('discard')}** |
| 🔄 REFRESH (keeper ≥${SCORE_FLOOR}, live, stale) | **${count('refresh')}** (est ~$${estCost}) |
| ⚠️  refresh-unmapped (keeper not in queue) | ${count('refresh-unmapped')} |
| ❔ score-unknown (n/a — human review) | ${count('score-unknown')} |
| 🔒 override (allowlisted, skipped) | ${count('override')} |
| 🚫 skip-unparseable (corrupted row) | ${count('skip-unparseable')} |
| ⏳ out-of-scope status (stale but not Evaluated) | ${count('out-of-scope')} |
| ✅ fresh (≤${args.staleDays}d) | ${count('fresh')} |

${mode === 'apply' ? '' : '> DRY RUN — nothing was changed. Re-run with `STALE_STATUS_PASS_ENABLED=true ... --apply` to act.\n'}
## Would purge / discard / refresh

${section('PURGE', 'purge')}
${section('DISCARD', 'discard')}
${section('REFRESH', 'refresh')}
${section('refresh-unmapped (keeper, no queue mapping)', 'refresh-unmapped')}
${section('score-unknown (surfaced for human review)', 'score-unknown')}
${section('out-of-scope (stale, non-Evaluated — untouched)', 'out-of-scope')}
${section('skip-unparseable (corrupted — never touched)', 'skip-unparseable')}

## Reversibility

- Pre-mutation snapshot: \`data/applications-archive/applications-md-snapshot-<TS>.md\` (rollback = copy back over applications.md).
- Purged rows archived verbatim: \`data/applications-archive/applications-archive-${TODAY}.md\`.
- Every action appended to: \`data/stale-tracker-audit.jsonl\` (prior status + score recorded → restorable).
- Keep a row out of the pass: add \`{ "rowNum": N, "gate": "stale-status-pass", "reason": "...", "status": "active" }\` to \`data/triage-overrides.json\`.
`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printUsage(); process.exit(0); }

  // Kill-switch gate (only matters for --apply; dry-run is always allowed)
  if (args.apply && process.env.STALE_STATUS_PASS_ENABLED !== 'true') {
    console.error('✋ REFUSING --apply: STALE_STATUS_PASS_ENABLED is not "true".');
    console.error('   This pass is DESTRUCTIVE (purge + discard). Enable it explicitly:');
    console.error('     STALE_STATUS_PASS_ENABLED=true node scripts/agents/stale-tracker-status-pass.mjs --apply');
    console.error('   Dry-run (the default, safe) needs no flag and no env var.');
    process.exit(3);
  }

  if (!existsSync(args.tracker)) {
    console.error(`Tracker not found: ${args.tracker}`);
    process.exit(2);
  }

  const allRows = parseTrackerLines(readFileSync(args.tracker, 'utf-8'));
  const dataRows = allRows.filter((r) => !(r.malformed && !r.cells?.some(Boolean)));
  const todayMs = Date.now();
  const overrideSet = loadOverrideSet(args.overrides);
  const queueIndex = loadQueueIndex(args.queue);

  // First pass: bucket without liveness, to find which stale in-scope rows need a URL probe.
  const prelim = [];
  let processed = 0;
  for (const row of dataRows) {
    if (processed >= args.limit) break;
    processed++;
    const cls0 = buildClassification(row, { todayMs, staleDays: args.staleDays, overrideSet, queueIndex, livenessMap: new Map() });
    prelim.push({ row, cls0 });
  }
  // Stale + in-scope + not-overridden rows are the only ones whose liveness matters.
  const needsLiveness = prelim.filter(({ cls0 }) => !['fresh', 'out-of-scope', 'skip-unparseable', 'override'].includes(cls0.bucket));
  for (const p of needsLiveness) p.row.url = extractUrlFromReport(p.row.reportPath);
  const urls = [...new Set(needsLiveness.map((p) => p.row.url).filter(Boolean))];

  let livenessMap = new Map();
  let livenessNote = 'not run';
  if (!args.skipLiveness && urls.length) {
    const sweep = runLivenessSweep(urls);
    livenessMap = sweep.map;
    livenessNote = sweep.note;
  } else if (args.skipLiveness) {
    livenessNote = 'skipped (--skip-liveness): no purges this run';
  } else {
    livenessNote = 'no candidate URLs';
  }

  // Final classification with liveness.
  const buckets = {};
  const results = [];
  for (const { row } of prelim) {
    const cls = buildClassification(row, { todayMs, staleDays: args.staleDays, overrideSet, queueIndex, livenessMap });
    (buckets[cls.bucket] ||= []).push({ row, cls });
    results.push({ row, cls });
  }

  const mode = args.apply ? 'apply' : 'dry-run';
  const reportMd = renderReport({ args, mode, totalRows: results.length, buckets, livenessNote });
  const reportPath = join(args.reportDir, `stale-tracker-status-pass-${TODAY}.md`);
  try { atomicWrite(reportPath, reportMd); } catch (e) { console.error(`WARN: report write failed: ${e.message}`); }

  const count = (b) => buckets[b]?.length || 0;
  const summary = {
    mode, tracker: args.tracker, stale_days: args.staleDays, total_rows: results.length,
    would_purge: count('purge'), would_discard: count('discard'), would_refresh: count('refresh'),
    refresh_unmapped: count('refresh-unmapped'), score_unknown: count('score-unknown'),
    override: count('override'), skip_unparseable: count('skip-unparseable'),
    out_of_scope: count('out-of-scope'), fresh: count('fresh'),
    est_refresh_cost_usd: count('refresh') * COST_PER_KEEPER_USD,
    liveness: livenessNote, report: reportPath, applied: null,
  };

  // ── APPLY ──────────────────────────────────────────────────────────────────
  if (args.apply) {
    const mutateTargets = results.filter((r) => r.cls.action === 'purge' || r.cls.action === 'discard');
    mkdirSync(args.archiveDir, { recursive: true });

    // 1) Full-file snapshot BEFORE any edit (cv.md discipline → tracker).
    const snapPath = join(args.archiveDir, `applications-md-snapshot-${tsStamp()}.md`);
    atomicWrite(snapPath, readFileSync(args.tracker, 'utf-8'));

    // 2) Archive purged rows verbatim.
    const purges = mutateTargets.filter((t) => t.cls.action === 'purge');
    if (purges.length) {
      const archiveFile = join(args.archiveDir, `applications-archive-${TODAY}.md`);
      const header = existsSync(archiveFile) ? '' : `# Applications archive — purged by stale-tracker-status-pass\n\nEach row was a CLOSED posting (liveness=expired) at purge time. Re-insert verbatim into data/applications.md to restore.\n\n`;
      const block = `\n## Purged ${tsStamp()}\n\n${purges.map((t) => t.row.raw).join('\n')}\n`;
      appendFileSync(archiveFile, header + block, 'utf-8');
    }

    // 3) Mutate the tracker (status→Discarded + audit note).
    const { applied: mutated, skipped: mutSkipped } = applyTrackerMutations(args.tracker, mutateTargets);

    // 4) Append-only audit JSONL for every action taken (prior state → restorable).
    const runId = `stale-${tsStamp()}-${process.pid}`;
    for (const t of mutateTargets) {
      appendFileSync(args.auditJsonl, JSON.stringify({
        ts: new Date().toISOString(), run_id: runId, action: t.cls.action,
        num: t.row.num, company: t.row.company, role: t.row.role,
        prior_status: t.row.status, new_status: 'Discarded',
        prior_score: t.row.score, score_known: t.row.scoreKnown, age_days: t.cls.ageDays,
        stale_days_threshold: args.staleDays, liveness: t.cls.liveness || 'unknown',
        report_path: t.row.reportPath || null, url: t.row.url || null,
        snapshot: snapPath, reason: t.cls.reason, applied: true,
      }) + '\n', 'utf-8');
    }

    // 5) Keeper refresh — OPT-IN, capped, queue-num-mapped only.
    const refreshTargets = (buckets.refresh || []);
    let refreshed = [];
    if (args.refreshKeepers && refreshTargets.length) {
      const toRun = refreshTargets.slice(0, args.maxRefresh);
      for (const t of toRun) {
        const r = spawnKeeperRefresh(t.cls.queueNum);
        refreshed.push({ num: t.row.num, queueNum: t.cls.queueNum, ok: r.ok, exit: r.exit });
        appendFileSync(args.auditJsonl, JSON.stringify({
          ts: new Date().toISOString(), run_id: runId, action: 'refresh',
          num: t.row.num, company: t.row.company, role: t.row.role, queue_num: t.cls.queueNum,
          ok: r.ok, exit: r.exit, reason: t.cls.reason, applied: true,
        }) + '\n', 'utf-8');
      }
      if (refreshTargets.length > args.maxRefresh) {
        console.error(`NOTE: ${refreshTargets.length - args.maxRefresh} keeper(s) deferred (--max-refresh=${args.maxRefresh}). Re-run to continue.`);
      }
    }

    summary.applied = {
      snapshot: snapPath, mutated, mut_skipped: mutSkipped, purged_archived: purges.length,
      refreshed, refresh_deferred: Math.max(0, refreshTargets.length - (args.refreshKeepers ? args.maxRefresh : 0)),
      keeper_refresh_ran: !!args.refreshKeepers,
    };
  }

  // ── Output ───────────────────────────────────────────────────────────────
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  const C = (b) => count(b);
  console.log(`\n  Stale-tracker status pass — ${mode === 'apply' ? 'APPLIED ✅' : 'DRY RUN (no mutations)'}`);
  console.log(`  Tracker: ${args.tracker.replace(ROOT + '/', '')} — ${results.length} data rows`);
  console.log(`  Stale: >${args.staleDays}d · In-scope: ${[...IN_SCOPE_STATUSES].join(', ')} · Liveness: ${args.skipLiveness ? 'SKIPPED' : livenessNote}`);
  console.log('  ' + '─'.repeat(60));
  console.log(`  🗑️  WOULD PURGE   (closed → archive + Discarded) : ${C('purge')}`);
  console.log(`  ⬇️  WOULD DISCARD (score <${SCORE_FLOOR}, live, stale)   : ${C('discard')}`);
  console.log(`  🔄 WOULD REFRESH (keeper ≥${SCORE_FLOOR}, live, stale)  : ${C('refresh')}  (est ~$${C('refresh') * COST_PER_KEEPER_USD})`);
  console.log('  ' + '─'.repeat(60));
  console.log(`  skipped → score-unknown: ${C('score-unknown')} · override: ${C('override')} · unparseable: ${C('skip-unparseable')} · refresh-unmapped: ${C('refresh-unmapped')}`);
  console.log(`  untouched → out-of-scope-status: ${C('out-of-scope')} · fresh(≤${args.staleDays}d): ${C('fresh')}`);
  if (args.apply) {
    console.log('  ' + '─'.repeat(60));
    console.log(`  APPLIED: ${summary.applied.mutated} rows flipped to Discarded · ${summary.applied.purged_archived} archived · snapshot: ${summary.applied.snapshot.replace(ROOT + '/', '')}`);
    if (summary.applied.keeper_refresh_ran) console.log(`  keepers refreshed: ${summary.applied.refreshed.filter((r) => r.ok).length}/${summary.applied.refreshed.length} (deferred: ${summary.applied.refresh_deferred})`);
    else if (C('refresh')) console.log(`  keepers NOT refreshed (re-run with --refresh-keepers to spend ~$${C('refresh') * COST_PER_KEEPER_USD})`);
  } else {
    console.log('\n  → Re-run with  STALE_STATUS_PASS_ENABLED=true ... --apply  to act (purge + discard).');
    console.log('  → Report:', reportPath.replace(ROOT + '/', ''));
  }
  console.log('');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((err) => { console.error(`FATAL: ${err.stack || err}`); process.exit(1); });
