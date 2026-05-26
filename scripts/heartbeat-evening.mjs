#!/usr/bin/env node
/**
 * Evening system-health digest. Companion to scripts/heartbeat.mjs.
 * Fires at 18:00 PT Mon–Fri via com.mitchell.career-ops.heartbeat-evening.
 *
 * Surfaces system state Mitchell already knows lives on the dashboard,
 * but does not need to chase down before 09:01 PT action-conversion work.
 *
 * Phase B (2026-05-19) — created as part of the morning/evening split.
 * Council vote: MODIFY (4/4) → one adjustment applied: WHAT'S NEW OVERNIGHT
 * moved to morning per council-ledger.md § Section Assignment Decisions.
 *
 * Reads same .env / secrets / corpus as scripts/heartbeat.mjs.
 * Subject pattern: "Ops digest: <one-line state summary> — <date>"
 * Archive: data/heartbeat-archive/heartbeat-evening-<date>.html
 *
 * Evening sections (final, post-council):
 *   SYSTEM STATUS · ACTIVITY SNAPSHOT · PIPELINE FUNNEL ·
 *   RUNWAY ALERT (persistent, mid-digest) · ERRORS / WARNINGS ·
 *   ACTION REQUIRED (suppressed on no-error days) ·
 *   REJECTED PATTERN OF WEEK (Fridays only)
 *
 * Hang-prevention: all fetch calls use AbortSignal.timeout; child_process
 * calls include timeout:; body reads use the safe-fetch pattern inline.
 * Follows the 9 mandatory rules in feedback_hang_prevention_patterns.md.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import dotenv from 'dotenv';

// F1b fix (2026-05-21): load .env BEFORE any consumer of HEARTBEAT_DESIGN.
// Matches the fix in scripts/heartbeat.mjs — both scripts now read .env so
// launchd-fired runs see the same env as Mitchell's shell-fired previews.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

import nodemailer from 'nodemailer';
import { marked } from 'marked';
import mjml2html from 'mjml';
import { buildSummary as buildOutreachSummary, listContacts as listOutreachContacts } from '../lib/outreach-tracker.mjs';
// renderRunwayAlert dropped from import 2026-05-25 — runway model retired.
import { renderSystemBanner, renderDiscardPatternSection } from '../lib/heartbeat-system-banner.mjs';
// ARCH.42 (2026-05-21) — typography role helpers (Q1 evening rollout).
// Currently used only by sectionLabel below; expand to h2/h3/th regex
// replacements only after Friday morning eval confirms the plumbing.
import { TYPE_ROLES, styleString } from '../lib/typography-roles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Design tokens (Phase E2 dark-first, 2026-05-19) ────────────────────────
// Same source-of-truth as heartbeat.mjs. Phase E2 closes the Phase C
// deferral and ships dark-first body per the 7/7 universal real-council
// ratification of Decision A (.claude/audit/email-review/
// council-divergence-analysis.md finding-014).
const TOKENS = JSON.parse(readFileSync(
  new URL('../lib/heartbeat-tokens.json', import.meta.url),
  'utf-8'
));

const ROOT = process.cwd();
const args = process.argv.slice(2);
const dateArg = args.find(a => a.startsWith('--date='));
const SEND    = args.includes('--send');
const TEST    = args.includes('--test');
const PREVIEW = args.includes('--preview');
const TARGET_DATE = dateArg
  ? dateArg.split('=')[1]
  : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// ── HEARTBEAT_EVENING_ENABLED gate (Phase D, 2026-05-19) ───────────────────
// Lets Mitchell kill the evening email without uninstalling the launchd plist.
// Set HEARTBEAT_EVENING_ENABLED=false in .env to disable. Default when unset: enabled (true).
// --preview still works even when the gate is closed (preview is read-only, not a send action).
const EVENING_ENABLED = (process.env.HEARTBEAT_EVENING_ENABLED || 'true').toLowerCase() !== 'false';
if (!EVENING_ENABLED && (SEND || TEST)) {
  console.log('[heartbeat-evening] HEARTBEAT_EVENING_ENABLED=false — skipping send.');
  process.exit(0);
}

// ── Secrets loader ─────────────────────────────────────────────────────────
function loadSecrets() {
  const path = join(homedir(), '.career-ops-secrets');
  if (!existsSync(path)) throw new Error(`Secrets file missing: ${path}`);
  const out = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  for (const k of ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'HEARTBEAT_TO']) {
    if (!out[k]) throw new Error(`Missing key in secrets: ${k}`);
  }
  return out;
}

// ── Brand constants (Phase E2 dark-first, 2026-05-19) ──────────────────────
// Mirrors heartbeat.mjs's dark BRAND, plus an evening-specific slate-blue
// hero literal so morning and evening are visually distinguishable in
// Gmail's threaded inbox view.
//
// Phase E2 closes the Phase C deferral. Real-council ratified 7/7 universal
// in Phase E1 (see council-divergence-analysis.md finding-014). The body
// default is dark (#06070d); the @media (prefers-color-scheme: light) overlay
// in templates/heartbeat.mjml flips on light-opt-in clients.
//
// BRAND.green / .greenFg semantics preserved across the inversion —
// .green = #4ade80 (matrix-green on dark), .greenFg = #86efac (link/accent).
const _emailDark = TOKENS.email.dark;
const _colorDark = TOKENS.color.dark;
const BRAND = {
  bg:          _emailDark.body_bg,                    // #06070d
  surface:     _emailDark.panel_bg,                   // #11131c
  surface2:    _emailDark.panel_strong_bg,            // #181b27
  border:      _emailDark.border,                     // #232737
  text:        _colorDark.text.t1,                    // #fafafa
  text2:       _emailDark.body_color,                 // #e4e4e7
  text3:       _emailDark.muted_color,                // #b8b8c0
  text4:       _emailDark.chrome_color,               // #9a9aa6
  green:       _emailDark.accent_deep,                // #4ade80 — matrix-green on dark
  greenFg:     _emailDark.accent,                     // #86efac — high-contrast green-fg
  greenBg:     _emailDark.accent_bg,                  // rgba(22,163,74,0.12)
  greenBorder: _emailDark.accent_border,              // rgba(22,163,74,0.30)
  blue:        _colorDark.semantic.info,              // #94a3b8
  blueBg:      _emailDark.info_bg,                    // rgba(100,116,139,0.22)
  amber:       _colorDark.semantic.warning,           // #c2a571
  amberBg:     _emailDark.warning_bg,                 // rgba(168,123,72,0.22)
  red:         _emailDark.danger_fg,                  // #fca5a5
  redBg:       _emailDark.danger_bg,                  // rgba(220,38,38,0.18)
  // Evening-specific slate-blue hero so morning (solid green at 09:00 PT)
  // and evening (slate-blue at 18:00 PT) are visually distinguishable in
  // Gmail thread view. #5a76a6 reads as mid-slate on dark body.
  eveningHero: '#5a76a6',
};

// Dashboard public URL (same env resolution as heartbeat.mjs)
const _secrets = (() => { try { return loadSecrets(); } catch { return {}; } })();
const DASHBOARD_PUBLIC_URL = (() => {
  return (process.env.DASHBOARD_PUBLIC_URL || _secrets.DASHBOARD_PUBLIC_URL || 'http://localhost:7777').replace(/\/$/, '');
})();

// ── escapeForMjml: same as heartbeat.mjs ──────────────────────────────────
function escapeForMjml(s) {
  return String(s == null ? '' : s)
    .replace(/{{/g, '&#123;&#123;')
    .replace(/}}/g, '&#125;&#125;');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── MJML template — reuse the same heartbeat.mjml but with evening overrides ─
// The hero gradient is replaced inline by swapping {{heroColor}} in the template
// interpolation. We can't swap the MJML file's background-color declaratively
// at runtime without a full template replacement, so we load the morning template
// and patch the hero color string before compilation.
let _mjmlTemplateRaw = null;
function getEveningMjmlTemplate() {
  if (_mjmlTemplateRaw) return _mjmlTemplateRaw;
  const templatePath = join(__dirname, '../templates/heartbeat.mjml');
  let tmpl = readFileSync(templatePath, 'utf-8');
  // Swap morning green hero (#16a34a) for evening slate-blue (#5a76a6)
  // so the two emails are visually distinguishable in Gmail thread view.
  tmpl = tmpl.replace(/background-color="#16a34a"/g, `background-color="${BRAND.eveningHero}"`);
  // Update footer time label from "09:00 PT" to "18:00 PT"
  tmpl = tmpl.replace(/· 09:00 PT/g, '· 18:00 PT');
  _mjmlTemplateRaw = tmpl;
  return _mjmlTemplateRaw;
}

// ── renderContentHtml: same inline-style pipeline as heartbeat.mjs ─────────
function renderContentHtml(markdownBody) {
  marked.setOptions({ gfm: true, breaks: false });
  const inner = marked.parse(markdownBody);
  let styled = inner
    .replace(/<table>/g, `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="card" style="border-collapse:separate;border-spacing:0;width:100%;margin:10px 0 14px;font-size:13px;border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;background:${BRAND.surface}">`)
    .replace(/<thead>/g, `<thead style="background:${BRAND.surface2}">`)
    .replace(/<th>/g, `<th class="text-muted border" style="text-align:left;padding:8px 10px;border-bottom:1px solid ${BRAND.border};font-weight:700;color:${BRAND.text3};font-size:10px;text-transform:uppercase;letter-spacing:0.07em">`)
    .replace(/<td>/g, `<td class="border" style="padding:8px 10px;border-bottom:1px solid ${BRAND.surface2};vertical-align:top;color:${BRAND.text2};font-size:13px">`)
    .replace(/<blockquote>/g, `<blockquote class="card" style="margin:12px 0;padding:10px 14px;border-left:3px solid ${BRAND.green};background:${BRAND.greenBg};color:${BRAND.text};border-radius:0 8px 8px 0;font-size:13px;line-height:1.5">`)
    .replace(/<h1>/g, `<h1 class="text-strong accent" style="font-size:22px;margin:0 0 6px;color:${BRAND.greenFg};font-weight:700;letter-spacing:-0.01em">`)
    // Phase C Decision C — H2 = 16px / 700 / -0.3px ls / no UPPERCASE / no border-left.
    .replace(/<h2>/g, `<h2 class="text-strong" style="font-size:16px;margin:22px 0 10px;color:${BRAND.text};font-weight:700;letter-spacing:-0.3px;line-height:1.3">`)
    // Phase C Decision C — H3 = demoted console-style; evening uses slate-blue accent border.
    .replace(/<h3>/g, `<h3 class="text-strong" style="font-size:13px;margin:16px 0 8px;color:${BRAND.text3};font-weight:700;border-left:3px solid ${BRAND.eveningHero};padding-left:10px;letter-spacing:0.04em;text-transform:uppercase;line-height:1.3">`)
    .replace(/<a /g, `<a class="accent" style="color:${BRAND.eveningHero};text-decoration:underline;text-underline-offset:2px;font-weight:500" `)
    .replace(/<code>/g, `<code style="background:${BRAND.surface2};padding:1px 5px;border-radius:4px;font-family:'JetBrains Mono','SF Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:${BRAND.eveningHero}">`)
    .replace(/<ul>/g, `<ul style="margin:6px 0 10px;padding-left:20px;color:${BRAND.text2}">`)
    .replace(/<ol>/g, `<ol style="margin:6px 0 10px;padding-left:20px;color:${BRAND.text2}">`)
    .replace(/<li>/g, '<li style="margin:3px 0;line-height:1.5">')
    .replace(/<hr>/g, `<hr style="border:none;height:1px;background:linear-gradient(90deg,transparent 0%,${BRAND.border} 50%,transparent 100%);margin:18px 0">`);

  // Status badges
  styled = styled.replace(/<strong>(Offer|Interview|Responded|Applied|Evaluated|Rejected|Discarded|SKIP)<\/strong>/g, (m, status) => {
    const palette = {
      Offer:     [BRAND.amberBg,  BRAND.amber],
      Interview: [BRAND.greenBg,  BRAND.greenFg],
      Responded: [BRAND.blueBg,   BRAND.blue],
      Applied:   [BRAND.blueBg,   BRAND.blue],
      Evaluated: [BRAND.surface2, BRAND.text3],
      Rejected:  [BRAND.redBg,    BRAND.red],
      Discarded: [BRAND.surface2, BRAND.text4],
      SKIP:      [BRAND.surface2, BRAND.text4],
    };
    const [bg, fg] = palette[status] || ['#f1f5f9', '#475569'];
    return `<span style="display:inline-block;background:${bg};color:${fg};padding:2px 8px;border-radius:999px;font-weight:600;font-size:12px">${status}</span>`;
  });

  return styled;
}

// ── Section label helper ───────────────────────────────────────────────────
// ARCH.42 Q1 evening rollout (2026-05-21): migrated to TYPE_ROLES.sectionLabel
// + styleString. Currently dead code (no callers in heartbeat-evening.mjs);
// the migration validates the plumbing for Friday's morning sectionLabel
// rollout in scripts/heartbeat.mjs (which has 8 callers).
//
// Behavioral delta vs the prior inline style: fontFamily order swaps Inter
// from 3rd → 1st in the stack (canonical sans), and an explicit
// line-height:1.3 is added (was implicit ~1.5 from MJML body). Both render
// byte-identical in the evening pipeline because sectionLabel has zero
// callers; Friday morning rollout is where the visible delta first appears.
function sectionLabel(text) {
  const style = styleString(TYPE_ROLES.sectionLabel, {
    color: BRAND.text4,
    margin: '14px 0 3px',
  });
  return `<div style="${style}">${text}</div>`;
}

// ── Runway model — RETIRED 2026-05-25 ─────────────────────────────────────
// computeRunwayDensityForEvening + renderEveningRunwayAlert (+ their morning
// counterparts in heartbeat.mjs and heartbeat-dispatch.mjs) deleted together
// alongside the markdown "## Runway Alert" section + the dispatch composer's
// runway widget + the runway KPI tile. Restore from git history if the model
// returns. See AGENTS.md § stale-coupling-after-primitive-removal.

// ── grokStatus (shared helper — same as heartbeat.mjs) ────────────────────
function grokStatus(date) {
  const spendLog = join(ROOT, 'data/grok-spend.log');
  if (!existsSync(spendLog)) return { spent: 0, queries: 0 };
  const lines = readFileSync(spendLog, 'utf-8').split('\n').filter(l => l.startsWith(date));
  const queries = lines.length;
  const spent = lines.reduce((sum, l) => {
    const cost = parseFloat(l.split('\t')[2] || 0);
    return sum + (isNaN(cost) ? 0 : cost);
  }, 0);
  return { spent, queries };
}

function fileModifiedRecently(path, hoursAgo = 8) {
  if (!existsSync(path)) return false;
  const cutoff = Date.now() - hoursAgo * 3600 * 1000;
  return statSync(path).mtime.getTime() >= cutoff;
}

function countPipelinePending(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

function countTriageRows(path) {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  return Math.max(0, lines.length - 1);
}

function countApplicationsRows(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf-8').split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l)).length;
}

function countScanHistoryRows(path) {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  return Math.max(0, lines.length - 1);
}

function countReports(date) {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return 0;
  return readdirSync(reportsDir).filter(f => f.includes(date) && f.endsWith('.md')).length;
}

function parseApplicationsTracker(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    const num = cells[1]; const date = cells[2]; const company = cells[3];
    const role = cells[4]; const scoreStr = cells[5]; const status = cells[6];
    const scoreMatch = scoreStr.match(/(\d+(?:\.\d+)?)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    rows.push({ num: parseInt(num, 10), date, company, role, score, status });
  }
  return rows;
}

function getStatusBreakdown(rows) {
  const buckets = {};
  for (const r of rows) {
    const key = (r.status || 'Unknown').trim();
    if (!buckets[key]) buckets[key] = { count: 0, rows: [] };
    buckets[key].count++;
    buckets[key].rows.push(r);
  }
  for (const k of Object.keys(buckets)) {
    buckets[k].rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return buckets;
}

const STATUS_DISPLAY_ORDER = ['Offer', 'Interview', 'Responded', 'Applied', 'Evaluated', 'Rejected', 'Discarded', 'SKIP'];
const STATUS_GLYPH = {
  Offer: '🏆', Interview: '💬', Responded: '📨', Applied: '📤',
  Evaluated: '🔎', Rejected: '🚫', Discarded: '🗑', SKIP: '⏭',
};

function getInflowStats(date) {
  const logPath = join(ROOT, `data/logs/scan-${date}.log`);
  const stats = {
    portalNew: 0, portalScanned: 0,
    rssNew: 0, rssScanned: 0,
    emailNew: 0, emailMessages: 0, emailUrls: 0,
    triageCandidates: 0, triageWritten: false,
  };
  if (!existsSync(logPath)) return stats;
  const log = readFileSync(logPath, 'utf-8');
  const portalNewMatch = log.match(/--- scan\.mjs ---[\s\S]*?New offers added:\s+(\d+)/);
  if (portalNewMatch) stats.portalNew = parseInt(portalNewMatch[1], 10);
  const portalScannedMatch = log.match(/Companies scanned:\s+(\d+)/);
  if (portalScannedMatch) stats.portalScanned = parseInt(portalScannedMatch[1], 10);
  const rssNewMatch = log.match(/--- scan-rss\.mjs ---[\s\S]*?New offers added:\s+(\d+)/);
  if (rssNewMatch) stats.rssNew = parseInt(rssNewMatch[1], 10);
  const rssScannedMatch = log.match(/Feeds scanned:\s+(\d+)/);
  if (rssScannedMatch) stats.rssScanned = parseInt(rssScannedMatch[1], 10);
  const emailMessagesMatch = log.match(/Found (\d+) unread messages under label/);
  if (emailMessagesMatch) stats.emailMessages = parseInt(emailMessagesMatch[1], 10);
  const emailUrlsMatch = log.match(/--- scan-email\.mjs ---[\s\S]*?URLs extracted:\s+(\d+)/);
  if (emailUrlsMatch) stats.emailUrls = parseInt(emailUrlsMatch[1], 10);
  const emailNewMatch = log.match(/--- scan-email\.mjs ---[\s\S]*?New offers added:\s+(\d+)/);
  if (emailNewMatch) stats.emailNew = parseInt(emailNewMatch[1], 10);
  const triageMatch = log.match(/--- triage-pipeline\.mjs ---[\s\S]*?Wrote\s+(\d+)\s+candidates/);
  if (triageMatch) { stats.triageCandidates = parseInt(triageMatch[1], 10); stats.triageWritten = true; }
  return stats;
}

// ── diff against yesterday's evening archive ───────────────────────────────
// Reads the prior evening archive to surface what changed since last night's digest.
function readPriorEveningArchiveSummary() {
  try {
    const y = new Date(TARGET_DATE + 'T12:00:00');
    y.setDate(y.getDate() - 1);
    const yDateStr = y.toISOString().slice(0, 10);
    const yPath = join(ROOT, `data/heartbeat-archive/heartbeat-evening-${yDateStr}.html`);
    if (!existsSync(yPath)) return null;
    const text = readFileSync(yPath, 'utf-8');
    // Extract tracked count from prior evening
    const trackedMatch = text.match(/Total tracked overall.*?(\d+)/);
    const applyNowMatch = text.match(/Apply-Now Queue.*?(\d+)/);
    return {
      trackedCount: trackedMatch ? parseInt(trackedMatch[1], 10) : null,
      applyNowCount: applyNowMatch ? parseInt(applyNowMatch[1], 10) : null,
      date: yDateStr,
    };
  } catch { return null; }
}

// ── Generate the evening markdown body ────────────────────────────────────
async function generateEveningMarkdownBody() {
  const lines = [];
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push('');

  const trackerRows       = parseApplicationsTracker(join(ROOT, 'data/applications.md'));
  const buckets           = getStatusBreakdown(trackerRows);
  const inflow            = getInflowStats(TARGET_DATE);
  const reportsToday      = countReports(TARGET_DATE);
  const applicationsRows  = countApplicationsRows(join(ROOT, 'data/applications.md'));
  const pipelinePending   = countPipelinePending(join(ROOT, 'data/pipeline.md'));
  const triageRows        = countTriageRows(join(ROOT, 'data/triage-batch.tsv'));
  const triageModified    = fileModifiedRecently(join(ROOT, 'data/triage-batch.tsv'));
  const scanRows          = countScanHistoryRows(join(ROOT, 'data/scan-history.tsv'));
  const scanRanToday      = fileModifiedRecently(join(ROOT, `data/logs/scan-${TARGET_DATE}.log`), 12);
  const grok              = grokStatus(TARGET_DATE);
  const APPLY_NOW_FLOOR   = 4.0;
  const applyNowCount     = trackerRows.filter(r => r.score >= APPLY_NOW_FLOOR && new Set(['Evaluated','Responded']).has(r.status)).length;

  // Prior evening diff (what changed since last night)
  const priorEvening = readPriorEveningArchiveSummary();
  const trackedDelta = priorEvening && priorEvening.trackedCount != null
    ? applicationsRows - priorEvening.trackedCount : null;

  // ── SECTION 1: SYSTEM STATUS ────────────────────────────────────────────
  lines.push('## System Status');
  lines.push('');
  lines.push('| Component | Status | Detail |');
  lines.push('|-----------|--------|--------|');
  lines.push(`| Portal scan (\`scan.mjs\`) | ${scanRanToday ? '✅ ran today' : '❌ did not run'} | ${scanRows} URLs tracked all-time |`);
  lines.push(`| Triage refresh | ${triageModified ? '✅ refreshed today' : '❌ stale'} | ${triageRows} candidates queued |`);
  lines.push(`| Pipeline depth | ${pipelinePending > 0 ? '✅' : '⚠️'} ${pipelinePending} pending | feeds tomorrow's batch |`);
  lines.push(`| Batch eval | ${reportsToday > 0 ? `✅ ${reportsToday} reports` : '❌ 0 reports'} | A–G evaluations written today |`);
  lines.push(`| Tracker | ✅ ${applicationsRows} rows${trackedDelta !== null ? ` (+${trackedDelta} vs yesterday)` : ''} | every role ever evaluated |`);
  lines.push(`| Grok #1 (social-intel) | ${grok.queries > 0 ? '✅ active' : '⏸ idle'} | $${grok.spent.toFixed(2)} / $5.00 daily cap · ${grok.queries} queries |`);
  lines.push(`| Voice calibration | ${existsSync(join(ROOT, 'writing-samples/voice-reference.md')) ? '✅ active' : '⚠️ not configured'} | writing-samples/voice-reference.md |`);
  lines.push(`| Errors today | ${existsSync(join(ROOT, 'data/errors.log')) && readFileSync(join(ROOT, 'data/errors.log'), 'utf-8').includes(TARGET_DATE) ? '⚠️ see below' : '✅ clean'} | data/errors.log |`);
  lines.push(`| Quota schedule | ✅ 08:05 PT | batch fires after Claude Max reset |`);

  // Tier 5 feature summary (full table for evening — not the one-liner)
  const tierFeatures = (() => {
    const burstActive = !!process.env.MONTHLY_BUDGET_USD_BURST
      && parseFloat(process.env.MONTHLY_BUDGET_USD_BURST) > 0;
    const fts = [
      { label: 'Per-run cost caps', active: true, detail: `Run Batch $${process.env.PER_RUN_CAP_RUN_BATCH_USD || '25'} · Process All $${process.env.PER_RUN_CAP_PROCESS_ALL_USD || '250'} · Monthly $${process.env.MONTHLY_BUDGET_USD || '500'}` },
      { label: 'Time-to-Offer scoring',       active: existsSync(join(ROOT, 'lib/tto-estimator.mjs')),    detail: 'Runway-aware triage weight' },
      { label: 'Company-toxicity flagging',   active: existsSync(join(ROOT, 'lib/toxicity-scorer.mjs')),  detail: 'Flag-for-review composite' },
      { label: 'Pipeline-density alert',      active: existsSync(join(ROOT, 'dashboard-server.mjs')),      detail: 'Runway health verdict' },
      { label: 'Corpus auto-edit + git',      active: existsSync(join(ROOT, 'scripts/agent-commit.mjs')), detail: 'cv.md / profile edits — git audit trail' },
      { label: 'Council-of-models',           active: existsSync(join(ROOT, 'lib/council.mjs')),           detail: '7-model parallel research' },
    ];
    if (burstActive) fts.push({ label: 'Burst mode', active: true, detail: `+$${process.env.MONTHLY_BUDGET_USD_BURST} until ${process.env.MONTHLY_BUDGET_BURST_UNTIL || 'not set'}` });
    return fts;
  })();
  const activeCount = tierFeatures.filter(f => f.active).length;
  lines.push('');
  lines.push(`**Tier 5 features: ${activeCount}/${tierFeatures.length} active**`);
  lines.push('');
  lines.push('| Feature | State | Detail |');
  lines.push('|---------|-------|--------|');
  for (const f of tierFeatures) {
    lines.push(`| ${f.label} | ${f.active ? '✅ on' : '○ off'} | ${f.detail} |`);
  }
  lines.push('');

  // ── SECTION 2: ACTIVITY SNAPSHOT ────────────────────────────────────────
  lines.push('## Activity Snapshot');
  lines.push('');
  lines.push('| Status | Count | Most recent (top 3) |');
  lines.push('|--------|------:|---------------------|');
  for (const status of STATUS_DISPLAY_ORDER) {
    const bucket = buckets[status];
    if (!bucket) continue;
    const samples = bucket.rows.slice(0, 3).map(r => `#${r.num} ${r.company}`);
    lines.push(`| ${STATUS_GLYPH[status] || '•'} **${status}** | ${bucket.count} | ${samples.join(', ') || '—'} |`);
  }
  for (const k of Object.keys(buckets)) {
    if (!STATUS_DISPLAY_ORDER.includes(k)) {
      lines.push(`| ❓ **${k}** | ${buckets[k].count} | _non-canonical_ |`);
    }
  }
  lines.push('');

  // ── SECTION 3: PIPELINE FUNNEL ──────────────────────────────────────────
  const totalNewToday = inflow.portalNew + inflow.rssNew + inflow.emailNew;
  lines.push('## Pipeline Funnel — today');
  lines.push('');
  lines.push('| Stage | Today | Notes |');
  lines.push('|-------|------:|-------|');
  lines.push(`| 🌐 From company portals (\`scan.mjs\`) | ${inflow.portalNew} new | ${inflow.portalScanned} portals polled |`);
  lines.push(`| 📡 From RSS / JSON feeds (\`scan-rss.mjs\`) | ${inflow.rssNew} new | ${inflow.rssScanned} feeds polled |`);
  lines.push(`| 📧 **From newsletter alerts (\`scan-email.mjs\`)** | **${inflow.emailNew} new** | ${inflow.emailMessages} unread alert emails → ${inflow.emailUrls} URLs extracted |`);
  lines.push(`| ➕ Total ingested today | **${totalNewToday}** | merged into \`data/pipeline.md\` |`);
  lines.push(`| 🎯 Triaged for evaluation | ${inflow.triageCandidates || '—'} | top candidates picked for next batch |`);
  lines.push(`| ⚙️ Evaluated today | ${reportsToday} | A–G reports written to \`reports/\` |`);
  lines.push(`| ✅ In Apply-Now Queue | ${applyNowCount} | scored ≥ ${APPLY_NOW_FLOOR.toFixed(1)}, status Evaluated/Responded |`);
  lines.push(`| 📚 Total tracked overall | ${applicationsRows} | every role the system has ever evaluated |`);
  lines.push('');
  if (inflow.emailMessages === 0 && inflow.emailNew === 0) {
    lines.push('> ⚠️ **No email job alerts received today.** Run `node scripts/find-unfiltered-alerts.mjs --apply` to fix missing Gmail filters.');
    lines.push('');
  }

  // ── SECTION 4: RUNWAY ALERT — RETIRED 2026-05-25 ───────────────────────
  // Runway model removed system-wide; the mid-digest runway block + density
  // compute + escalation labels are gone with it. Apply-now queue + outreach
  // section above already carry the evening's status without the runway
  // framing. See AGENTS.md § stale-coupling-after-primitive-removal.

  // ── SECTION 5: ACTION REQUIRED → ERRORS / WARNINGS ──────────────────────
  // Phase E2 finding-003 (council-divergence-analysis.md) — invert positions
  // 5 and 6 so the intervention (action) precedes the raw error stream
  // (diagnosis). This is the standard a11y pattern (action before diagnosis)
  // and prevents the EF "freeze on red text" reaction. ACTION REQUIRED is
  // only rendered when relevant (errors exist). Both blocks have explicit
  // quiet-state copy when nothing's wrong.
  const errorLog = join(ROOT, 'data/errors.log');
  let todaysErrors = [];
  if (existsSync(errorLog)) {
    todaysErrors = readFileSync(errorLog, 'utf-8').split('\n').filter(l => l.includes(TARGET_DATE));
  }
  if (todaysErrors.length === 0) {
    lines.push('## Errors / Warnings');
    lines.push('');
    lines.push('_No errors · system running unattended._');
    lines.push('');
  } else {
    // ACTION REQUIRED first (intervention precedes diagnosis)
    lines.push('## Action Required');
    lines.push('');
    lines.push('- [ ] Review the errors below before acting on the queue.');
    lines.push('');
    // Then ERRORS / WARNINGS (the raw diagnostic stream)
    lines.push('## Errors / Warnings');
    lines.push('');
    lines.push('```');
    todaysErrors.slice(-20).forEach(e => lines.push(e));
    lines.push('```');
    lines.push('');
  }

  // ── SECTION 6: REJECTED PATTERN OF WEEK (Fridays only) ──────────────────
  const _targetDateLocal = new Date(TARGET_DATE + 'T12:00:00');
  const _isFriday = _targetDateLocal.getDay() === 5;
  let renderedRejectedPattern = false;
  if (_isFriday) {
    try {
      const discardMd = renderDiscardPatternSection({ format: 'markdown', days: 7 });
      if (discardMd) {
        for (const line of discardMd.split('\n')) lines.push(line);
        lines.push('');
        renderedRejectedPattern = true;
      }
    } catch (e) {
      console.warn(`[heartbeat-evening] discard pattern section unavailable: ${e.message}`);
    }
  }

  // ── SECTION 7: Calm closer (Mon-Thu + weekends, non-Friday only) ────────
  // Phase E2 finding-004 (council-divergence-analysis.md) — Mon-Thu the
  // REJECTED PATTERN section doesn't render, so without this line the
  // email closes on ERRORS or ACTION REQUIRED pressure 4-of-5 weekdays.
  // The closer appears in the muted chrome color so it reads as a system
  // outro, not as content.
  if (!renderedRejectedPattern) {
    lines.push(`_— end of digest · all systems running unattended ·_`);
    lines.push('');
  }

  // ── SECTION 8: v2 auto-fix activity (PR #6 of 10, 2026-05-25) ───────────
  // Reads data/v2-fix-log.jsonl (written by lib/v2-fix-log.mjs, PR #7).
  // Gracefully returns empty section if the file is absent (pre-PR-#7).
  // Surfaces freeze state from lib/v2-thrash-counter.mjs (PR #5).
  {
    let v2Lines = [];
    try {
      // Lazy imports so this section fails gracefully before PR #5 / #7 land.
      const { isV2Frozen, getActiveFreeze } = await import('../lib/v2-thrash-counter.mjs').catch(() => ({}));
      const { readLast24hEntries } = await import('../lib/v2-fix-log.mjs').catch(() => ({}));

      const frozen = typeof isV2Frozen === 'function' ? isV2Frozen() : false;
      const freeze = frozen && typeof getActiveFreeze === 'function' ? getActiveFreeze() : null;
      const entries = typeof readLast24hEntries === 'function' ? readLast24hEntries() : [];

      if (frozen && freeze) {
        // CRIT banner at top of section — visible immediately.
        v2Lines.push('> ⚠️ **v2 auto-fix FROZEN** until ' + freeze.frozen_until + ' due to thrash (3+ auto-reverts in 24h)');
        v2Lines.push('');
      }

      v2Lines.push('## 🛠️ v2 Auto-Fix Activity');
      v2Lines.push('');

      if (entries.length === 0) {
        const { autoRevertsLast24h } = await import('../lib/v2-thrash-counter.mjs').catch(() => ({}));
        const silentAlarm = typeof autoRevertsLast24h === 'function' && autoRevertsLast24h().length === 0;
        if (silentAlarm) {
          v2Lines.push('_v2 + regression-guard quiet today (7d MED suspiciously-quiet alarm active)_');
        } else {
          v2Lines.push('_No v2 auto-fix activity in the last 24h._');
        }
        v2Lines.push('');
      } else {
        v2Lines.push('| PR | Detector | Severity | Outcome | Cost | Files | TTR |');
        v2Lines.push('|-----|----------|----------|---------|-----:|-------|-----|');
        for (const e of entries) {
          const stateGlyph = { DRAFT: '📝', MERGED: '✅', VERIFIED: '✓', REVERTED: '✗' }[e.pr_state] || '?';
          const verifyGlyph = e.verification?.overall === 'PASS' ? '✓ PASSED' : e.verification?.overall === 'FAIL' ? '✗ FAILED (auto-reverted)' : '—';
          const costStr = typeof e.cost_usd === 'number' ? '$' + e.cost_usd.toFixed(2) : '—';
          const ttrStr = typeof e.time_to_resolution_ms === 'number' ? Math.round(e.time_to_resolution_ms / 60000) + 'm' : '—';
          const filesStr = Array.isArray(e.files_changed) && e.files_changed.length > 0
            ? e.files_changed.slice(0, 3).join(', ') + (e.files_changed.length > 3 ? ' +' + (e.files_changed.length - 3) : '')
            : '—';
          const prLink = e.pr_url ? '[PR](' + e.pr_url + ')' : '—';
          v2Lines.push(`| ${prLink} ${stateGlyph} | ${e.detector || '—'} | ${e.detector_severity || '—'} | ${verifyGlyph} | ${costStr} | ${filesStr} | ${ttrStr} |`);
        }
        v2Lines.push('');

        // Aggregate: total cost + fix count.
        const totalCost = entries.reduce((s, e) => s + (typeof e.cost_usd === 'number' ? e.cost_usd : 0), 0);
        const passCount = entries.filter(e => e.verification?.overall === 'PASS').length;
        const failCount = entries.filter(e => e.verification?.overall === 'FAIL').length;
        v2Lines.push(`_${entries.length} fix${entries.length === 1 ? '' : 'es'} · ${passCount} verified · ${failCount} auto-reverted · $${totalCost.toFixed(2)} total_`);
        v2Lines.push('');
      }
    } catch (err) {
      // Non-fatal — log to console, emit quiet placeholder in email.
      console.warn('[heartbeat-evening] v2 auto-fix section error:', err.message);
      v2Lines = ['## 🛠️ v2 Auto-Fix Activity', '', '_v2 recap unavailable (see console)._', ''];
    }
    for (const l of v2Lines) lines.push(l);
  }

  lines.push('---');
  lines.push('');
  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch { commitSha = 'unknown'; }
  lines.push(`*heartbeat-evening.mjs · 18:00 PT · v.${commitSha} · [dashboard →](${DASHBOARD_PUBLIC_URL}/)*`);

  // Build meta for subject line — runway segment retired 2026-05-25 alongside
  // the runway-model removal; subject now reads {features · tracked · errors?}.
  const systemHealthSummary = (() => {
    const tierFeatureCount = tierFeatures.filter(f => f.active).length;
    const errorsFlag = todaysErrors.length > 0 ? ` · ${todaysErrors.length} error${todaysErrors.length === 1 ? '' : 's'}` : '';
    return `${tierFeatureCount}/${tierFeatures.length} features · ${applicationsRows} tracked${errorsFlag}`;
  })();

  return {
    body: lines.join('\n'),
    meta: {
      date: TARGET_DATE,
      systemHealthSummary,
      applyNowCount,
      applicationsRows,
      reportsToday,
      todaysErrorCount: todaysErrors.length,
    },
  };
}

// ── Render the evening HTML email ─────────────────────────────────────────
async function renderEveningHtmlEmail(markdownBody, meta = {}) {
  const date        = meta.date || TARGET_DATE;
  const dashboardUrl= `${DASHBOARD_PUBLIC_URL}/`;

  // Render evening-specific HTML sections for the action + context slots.
  // Evening email uses the morning template's slots but with different content:
  //   actionSectionsHtml → evening summary banner (not a CTA card)
  //   contextSectionsHtml → runway alert panel (HTML version)
  //   tpgmHeartbeatSectionHtml → empty (TPgM is morning-only, Monday)
  //   contentHtml → the main evening markdown body

  // System banner — full feature list (not the one-liner)
  let systemBannerHtml = '';
  try {
    const tierFeatures = (() => {
      const fts = [
        { label: 'Per-run cost caps', active: true, detail: `Run Batch $${process.env.PER_RUN_CAP_RUN_BATCH_USD || '25'} · Monthly $${process.env.MONTHLY_BUDGET_USD || '500'}` },
        { label: 'Time-to-Offer scoring',     active: existsSync(join(ROOT, 'lib/tto-estimator.mjs')) },
        { label: 'Company-toxicity flagging', active: existsSync(join(ROOT, 'lib/toxicity-scorer.mjs')) },
        { label: 'Pipeline-density alert',    active: existsSync(join(ROOT, 'dashboard-server.mjs')) },
        { label: 'Corpus auto-edit + git',    active: existsSync(join(ROOT, 'scripts/agent-commit.mjs')) },
        { label: 'Council-of-models',         active: existsSync(join(ROOT, 'lib/council.mjs')) },
      ];
      return fts;
    })();
    const activeCount = tierFeatures.filter(f => f.active).length;
    const featureRows = tierFeatures.map(f =>
      `<div style="display:flex;gap:8px;align-items:baseline;padding:2px 0;font-size:12px">
         <span style="color:${f.active ? BRAND.greenFg : BRAND.text4};font-weight:700">${f.active ? '✓' : '○'}</span>
         <span style="color:${f.active ? BRAND.text : BRAND.text4}">${escapeHtml(f.label)}</span>
       </div>`
    ).join('');
    systemBannerHtml = `
<div class="system-banner" style="margin:8px 0 14px;padding:12px 14px;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
  <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.eveningHero};margin-bottom:8px">Tier 5 — ${activeCount}/${tierFeatures.length} active · <a href="${dashboardUrl}?focus=system-status" style="color:${BRAND.eveningHero};text-decoration:none">full details →</a></div>
  ${featureRows}
</div>`.trim();
  } catch { /* non-fatal */ }

  // Discard pattern section (HTML) — always in evening when data exists
  let discardSectionHtml = '';
  const _isFriday = new Date(TARGET_DATE + 'T12:00:00').getDay() === 5;
  if (_isFriday) {
    try { discardSectionHtml = renderDiscardPatternSection({ format: 'html', days: 7 }) || ''; } catch { /* non-fatal */ }
  }

  // Evening summary banner (goes into actionSectionsHtml slot)
  const actionSectionsHtml = systemBannerHtml;

  const contextSectionsHtml = '';

  const contentHtml = renderContentHtml(markdownBody);

  // KPI tiles — evening variant: Evaluated today / Apply-Now Queue / Total Tracked
  const kpiQueueCount    = String(meta.applyNowCount    || 0);
  const kpiEvaluatedToday= String(meta.reportsToday     || 0);
  const kpiTrackedCount  = String(meta.applicationsRows || 0);

  // Preheader for evening email
  const preheaderText = meta.systemHealthSummary || 'System health digest — ' + date;

  let tmpl = getEveningMjmlTemplate();
  tmpl = tmpl
    .replace(/{{date}}/g,                    escapeForMjml('Evening · ' + date))
    .replace(/{{dashboardUrl}}/g,             escapeForMjml(dashboardUrl))
    .replace(/{{preheaderText}}/g,            escapeForMjml(preheaderText))
    .replace(/{{actionSectionsHtml}}/g,       actionSectionsHtml)
    .replace(/{{tpgmHeartbeatSectionHtml}}/g, '')
    .replace(/{{kpiQueueCount}}/g,            kpiQueueCount)
    .replace(/{{kpiEvaluatedToday}}/g,        kpiEvaluatedToday)
    .replace(/{{kpiTrackedCount}}/g,          kpiTrackedCount)
    .replace(/{{contextSectionsHtml}}/g,      contextSectionsHtml)
    .replace(/{{contentHtml}}/g,              contentHtml);

  const result = await mjml2html(tmpl, { validationLevel: 'soft', minify: false });
  if (result.errors && result.errors.length > 0) {
    for (const e of result.errors) {
      console.warn(`[heartbeat-evening/mjml] ${e.formattedMessage || e.message || JSON.stringify(e)}`);
    }
  }
  return result.html || '';
}

// ── Phase F-5 dispatch dispatch (2026-05-20) ────────────────────────────────
// HEARTBEAT_DESIGN=dispatch routes to the Vogue+Bloomberg editorial Dispatch
// module instead of the Phase E2 emission path. Anything else (including the
// flag being unset) keeps the existing Phase E2 path byte-identical.
async function renderDispatchEveningHtml(body, meta) {
  const { renderDispatchEvening } = await import('./heartbeat-dispatch.mjs');
  const trackerRows = parseApplicationsTracker(join(ROOT, 'data/applications.md'));
  const APPLY_NOW_FLOOR = 4.0;
  const applyNow = trackerRows
    .filter(r => r.score >= APPLY_NOW_FLOOR && new Set(['Evaluated','Responded']).has(r.status))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  return renderDispatchEvening({
    date: meta.date || TARGET_DATE,
    queueCount: meta.applyNowCount || applyNow.length,
    trackedCount: meta.applicationsRows || trackerRows.length,
    evaluatedToday: meta.reportsToday || 0,
    outreachDue: 0,
    // Runway state retired 2026-05-25 — dispatch composer no longer reads
    // runwayState / runwayAlert / density, and the values were coupled to
    // the removed runway model.
    newRoles: 0,
    todaysFocus: meta.todaysFocus || '',
    applyNow,
    whatsNew: [],
    todaysResult: meta.todaysResult || null,
    todaysMovements: meta.todaysMovements || [],
    errorCount: meta.todaysErrorCount || 0,
    systemStatus: meta.systemStatus || null,
    markdownBody: body,
  });
}

// ── Send the evening email ─────────────────────────────────────────────────
async function sendEveningEmail({ subject, body, meta }) {
  const secrets = loadSecrets();
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: secrets.GMAIL_USER, pass: secrets.GMAIL_APP_PASSWORD },
  });

  // Phase F-5 dispatch toggle — env-flag-conditional. Default keeps Phase E2 byte-identical.
  let html, dispatchSubject, dispatchAttachments;
  if (process.env.HEARTBEAT_DESIGN === 'dispatch') {
    const r = await renderDispatchEveningHtml(body, meta);
    html = r.html;
    dispatchSubject = r.subject;
    dispatchAttachments = r.attachments;
  } else {
    html = await renderEveningHtmlEmail(body, meta);
  }

  // Archive rendered HTML for overnight diff and email-review intake
  const archiveDir = join(ROOT, 'data/heartbeat-archive');
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `heartbeat-evening-${TARGET_DATE}.html`);
  writeFileSync(archivePath, html, 'utf8');
  console.log(`Archived evening email to ${archivePath}`);

  const info = await transporter.sendMail({
    from: secrets.GMAIL_USER,
    to: secrets.HEARTBEAT_TO,
    subject: dispatchSubject || subject,
    text: body,
    html,
    attachments: dispatchAttachments || undefined,
  });
  return { messageId: info.messageId };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (TEST) {
    const subject = `[career-ops] Evening digest SMTP test ${new Date().toISOString()}`;
    const body = `This is a test email from scripts/heartbeat-evening.mjs.\n\nDate: ${TARGET_DATE}\n`;
    const id = await sendEveningEmail({ subject, body, meta: {} });
    console.log(`Test email sent. Message-ID: ${id}`);
    return;
  }

  const { body, meta } = await generateEveningMarkdownBody();

  // Write the markdown body to disk (same convention as morning heartbeat.mjs)
  const mdPath = join(ROOT, `data/heartbeat-evening-${TARGET_DATE}.md`);
  writeFileSync(mdPath, body);
  console.log(`Wrote ${mdPath}`);

  if (PREVIEW) {
    // Phase F-5 dispatch toggle — preview also routes via env flag so the
    // preview path matches what would actually be sent.
    let html;
    if (process.env.HEARTBEAT_DESIGN === 'dispatch') {
      const r = await renderDispatchEveningHtml(body, meta);
      html = r.html;
      console.log(`Subject (dispatch): ${r.subject}  [source: ${r.subjectSource}]`);
    } else {
      html = await renderEveningHtmlEmail(body, meta);
    }
    const previewPath = process.env.HEARTBEAT_DESIGN === 'dispatch'
      ? '/tmp/dispatch-evening.html'
      : '/tmp/heartbeat-evening-preview.html';
    writeFileSync(previewPath, html);
    console.log(`Wrote ${previewPath} (${html.length} chars)`);

    // Phase E2 finding-009 — post-render lint hook. Gated by HEARTBEAT_LINT.
    if ((process.env.HEARTBEAT_LINT || 'on') !== 'off') {
      try {
        const { spawnSync } = await import('node:child_process');
        const r = spawnSync(
          process.execPath,
          [join(__dirname, 'lint-heartbeat-mjml.mjs'), '--file', previewPath],
          { stdio: 'inherit', timeout: 15000 }
        );
        if (r.status !== 0) {
          console.warn('[heartbeat-evening] post-render lint violations — see above. Not blocking preview.');
        }
      } catch (e) {
        console.warn(`[heartbeat-evening] lint hook failed: ${e.message}`);
      }
    }

    try {
      execSync(`open "${previewPath}"`, { stdio: 'ignore', timeout: 5000 });
      console.log('Opened in default browser');
    } catch { /* not on mac or open failed */ }
    return;
  }

  const subject = `Ops digest: ${meta.systemHealthSummary} — ${TARGET_DATE}`;
  console.log(`Subject: ${subject}`);

  if (SEND) {
    const id = await sendEveningEmail({ subject, body, meta });
    console.log(`Evening digest sent. Message-ID: ${id}`);
  } else {
    console.log('---');
    console.log(body);
  }
}

main().catch(err => {
  console.error('heartbeat-evening error:', err.message);
  process.exit(1);
});
