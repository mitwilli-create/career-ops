#!/usr/bin/env node
// dashboard-server.mjs — serves dashboard/index.html + live API endpoints
// Usage: node dashboard-server.mjs [--port=3000]

import { createServer } from 'http';
import { readFileSync, existsSync, statSync, readdirSync, appendFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, watch as fsWatch } from 'fs';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { execSync as _execSync, spawn as _spawn, spawnSync as _spawnSync } from 'child_process';
import { homedir } from 'os';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { tierCostEstimates as _tierCostEstimates, resolveTier as _resolveTier } from './lib/process-all-tiers.mjs';
import { parseApplicationsFile } from './lib/parse-applications.mjs';
import { resolveRowToPackInput } from './lib/build-pack-stage-input.mjs';
import { statusKey, statusBadgeClass } from './lib/status-key.mjs';
import { getCachedUrl } from './lib/resolve-ats-url.mjs';
import {
  buildSummary as buildOutreachSummary,
  getContact as getOutreachContact,
  listContacts as listOutreachContacts,
  upsertContact as upsertOutreachContact,
  logTouch as logOutreachTouch,
  setStatus as setOutreachStatus,
  snoozeContact as snoozeOutreachContact,
  cancelContactStrategy as cancelOutreachStrategy,
  wakeContact as wakeOutreachContact,
  _resetCache as resetOutreachCache,
} from './lib/outreach-tracker.mjs';
import { estimateTTO } from './lib/tto-estimator.mjs';
import { scoreToxicity } from './lib/toxicity-scorer.mjs';
import { renderChildPageHTML } from './lib/child-page-template.mjs';
import { renderInlineDiff, renderSideBySideDiff } from './lib/diff-renderer.mjs';
// PR-E Phase 2 (2026-05-27) — disk-deriving status reader. Replaces direct
// state.json reads with derived-from-disk truth. See lib/intel-refresh-state.mjs.
import { getRefreshStatus as _intelGetRefreshStatus, getSlotNames as _intelGetSlotNames } from './lib/intel-refresh-state.mjs';
// Spec 5a (2026-05-29) — Anthropic batch in-flight detector. Surfaces the
// most-recent batch with processing>0 from batch/batches-api-state.json so
// the sidebar can render an "⏳ in-flight · Mm elapsed · next poll Ns" chip
// even when no orchestrator job is currently in batch phase. Closes the
// funnel-visibility gap where 60s polling + atomic progress updates made
// the sidebar feel "stuck" mid-batch.
import { detectInFlightBatchFromDisk } from './lib/in-flight-batch-detector.mjs';
// ZETA 2026-05-19 — network-database search + person lookups
import {
  searchNetwork as networkSearch,
  personById as networkPersonById,
  resolveWarmIntros as networkResolveWarmIntros,
  networkDatabaseHeadline,
  topByWarmPath as networkTopByWarmPath,
  loadDatabase as networkLoadDatabase,
} from './lib/network-database-search.mjs';
// ζ Run-Batch 2026-05-19 — unified warm-contact lookup for the Phase B
// per-company preview + future surfaces. Reads from network-graph.json
// when present, falls back to network-database.json. Returns
// _stale_warmth-flagged contacts so the per-company preview can render
// honest fresh-vs-stale counts.
import { findContactsAtCompany as networkFindContactsAtCompany } from './lib/network-graph.mjs';
import { guessCompany as _guessCompanyFromUrl } from './lib/ats-utils.mjs';
// P1-6 / P1-5 — SQLite job-run ledger + scraper health widget
import { initSchema as _ledgerInitSchema, lastFinishedRun, recentRuns } from './lib/job-runs-ledger.mjs';

// 2026-05-23 B4 — top-of-file dotenv with override:true.
//
// Architectural fix for the env-shadow bug class on launchd-spawned daemons
// (Mitchell's shell pre-sets credentials like ANTHROPIC_API_KEY="" — empty
// string, not unset — so lazy dotenv loads with override:false keep the empty
// value and endpoints return "API key not set" even though .env has the real
// key). Prior session verified no lib/* module reads API keys at module-init
// time, so this is safe to load once here.
//
// Reference: AGENTS.md § Bug class: env-shadow-on-lazy-dotenv
// Reference: data/handover-popout-grounding-2026-05-23.md § Step 14 (reapply)
import _dotenv from 'dotenv';
try {
  _dotenv.config({ path: new URL('.env', import.meta.url).pathname, override: true });
  const _CRITICAL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const _missing = _CRITICAL_KEYS.filter(k => !process.env[k] || !process.env[k].trim());
  if (_missing.length > 0) {
    console.error(`[dashboard-server] STARTUP WARNING: missing/empty critical API keys: ${_missing.join(', ')}`);
  }
} catch (e) {
  console.error(`[dashboard-server] STARTUP WARNING: dotenv load failed: ${e.message}`);
}

// Registry of tracked scheduler jobs with expected cadence.
//
// Originally a hardcoded 6-entry list of scrapers; expanded 2026-05-19 to
// auto-discover ALL scheduled jobs from scripts/launchd/com.mitchell.career-ops.*.plist
// so the chip strip reflects the full pipeline (33 jobs). Hardcoded entries
// in HARDCODED_TRACKED_JOBS still apply for jobs that don't have a plist
// (e.g., heartbeat-evening — fired by a wrapper, not directly by launchd).
const HARDCODED_TRACKED_JOBS = [
  // Jobs without a dedicated plist (fired by wrappers / other jobs).
  { name: 'heartbeat-evening', expected_cadence_minutes: 1440 },
];

// Plist labels that don't represent "scheduled jobs" (long-lived daemons,
// debug sessions, or pure delivery wrappers). Excluded from auto-discovery.
const _JRS_DAEMON_LABELS = new Set([
  'dashboard-server',
  'cloudflared',
  'cloudflared-staging',
  'cloudflared-staging-nohup-wrapper',
  'telegram-bot',
  'chrome-debugging',
  'dashboard-phase3',
]);

// Map plist label → in-script startRun() job_name when they differ. The
// chip strip uses the IN-SCRIPT name so it matches the ledger rows actually
// being written. Without this, the auto-discovered plist label would render
// a chip that nothing ever writes to (stuck on 'unknown' forever).
const _JRS_LABEL_ALIASES = {
  // scan plist invokes scripts/scan-unattended.mjs which calls
  // startRun('portal-scan') — main's reliability-foundation naming.
  'scan': 'portal-scan',
};

/**
 * Discover scheduled jobs from scripts/launchd/com.mitchell.career-ops.*.plist.
 * Returns [{ name, expected_cadence_minutes }, ...] merged with the hardcoded
 * fallback list (auto-discovery wins on name collision).
 *
 * Parse rules:
 *   StartInterval=N seconds       → N/60 minutes
 *   StartCalendarInterval daily   → 1440 (daily)
 *   StartCalendarInterval weekly  → 10080 (weekly)
 *   StartCalendarInterval array N → 1440/N (e.g., 4 entries → every 6h = 360 min)
 *   StartCalendarInterval Day+Mo  → 525600 (yearly, sparse)
 *
 * Cached for 5 min to avoid re-reading 40 plists on every endpoint hit.
 */
let _jrsTrackedJobsCache = null;
function _jrsDiscoverTrackedJobs() {
  if (_jrsTrackedJobsCache && Date.now() - _jrsTrackedJobsCache.ts < 5 * 60 * 1000) {
    return _jrsTrackedJobsCache.jobs;
  }
  const plistDir = join(ROOT, 'scripts', 'launchd');
  const merged = new Map();
  try {
    if (existsSync(plistDir)) {
      for (const file of readdirSync(plistDir)) {
        if (!file.endsWith('.plist')) continue;
        if (!file.startsWith('com.mitchell.career-ops.')) continue;
        const rawLabel = file.replace(/^com\.mitchell\.career-ops\./, '').replace(/\.plist$/, '');
        if (_JRS_DAEMON_LABELS.has(rawLabel)) continue;
        const label = _JRS_LABEL_ALIASES[rawLabel] || rawLabel;
        try {
          const xml = readFileSync(join(plistDir, file), 'utf-8');
          let cadenceMinutes = null;

          const intervalMatch = xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
          if (intervalMatch) {
            cadenceMinutes = Math.max(1, Math.round(Number(intervalMatch[1]) / 60));
          } else {
            const calMatch = xml.match(/<key>StartCalendarInterval<\/key>\s*((?:<array>[\s\S]*?<\/array>)|(?:<dict>[\s\S]*?<\/dict>))/);
            if (calMatch) {
              const firstDict = calMatch[1].match(/<dict>([\s\S]*?)<\/dict>/);
              const inner = firstDict ? firstDict[1] : '';
              const hasWeekday = /<key>Weekday<\/key>/.test(inner);
              const hasMonth = /<key>Month<\/key>/.test(inner);

              if (hasMonth) {
                cadenceMinutes = 525600;       // yearly
              } else if (hasWeekday) {
                cadenceMinutes = 10080;        // weekly
              } else {
                // Daily — possibly multiple fires per day. Compute the
                // minimum gap between sorted Hour values (with wraparound)
                // rather than 1440/N — handles uneven schedules like
                // scrape-frequent (06/10/14/18/22 → 4h cadence, not 4.8h).
                const hours = [];
                const dictRe = /<dict>([\s\S]*?)<\/dict>/g;
                let dm;
                while ((dm = dictRe.exec(calMatch[1])) !== null) {
                  const hm = dm[1].match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
                  if (hm) hours.push(Number(hm[1]));
                }
                if (hours.length >= 2) {
                  hours.sort((a, b) => a - b);
                  let minGap = 24;
                  for (let i = 1; i < hours.length; i++) {
                    minGap = Math.min(minGap, hours[i] - hours[i - 1]);
                  }
                  // wraparound: last → first across midnight
                  minGap = Math.min(minGap, 24 - hours[hours.length - 1] + hours[0]);
                  cadenceMinutes = Math.max(1, Math.round(minGap * 60));
                } else {
                  cadenceMinutes = 1440; // single daily fire
                }
              }
            }
          }

          if (cadenceMinutes != null) {
            merged.set(label, { name: label, expected_cadence_minutes: cadenceMinutes });
          }
        } catch { /* skip unparseable plists */ }
      }
    }
  } catch { /* plist dir missing — fall back to hardcoded list */ }

  // Hardcoded fallback wins for jobs not represented by a plist (e.g.
  // heartbeat-evening fired by a wrapper, not directly by launchd).
  for (const j of HARDCODED_TRACKED_JOBS) {
    if (!merged.has(j.name)) merged.set(j.name, j);
  }

  const jobs = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  _jrsTrackedJobsCache = { jobs, ts: Date.now() };
  return jobs;
}
// Expose as a function — call _trackedJobs() wherever the endpoint needs
// the live list. 5-min cache inside _jrsDiscoverTrackedJobs() keeps this cheap.
function _trackedJobs() { return _jrsDiscoverTrackedJobs(); }

// Initialise the SQLite schema eagerly so the DB exists even before any job
// has run (the dashboard widget renders 'unknown' for all jobs initially).
try { _ledgerInitSchema(); } catch (_) {}

// ── Application enrichment for outreach API ────────────────────────────────
// Join contact.linked_application_id → applications.md row so the dashboard
// can render "→ [#1511] OpenAI Onboarding FDE (4.65)" inline. Cached for 30s
// so 60s dashboard polls don't re-parse the 136-row tracker each time.
let _appsCache = { ts: 0, byNum: new Map() };

// 2026-05-18 — Structured parser for data/errors.log lines. Shape:
//   [ISO_TS] SEVERITY/SOURCE [id=N] [exit=N]: <free-form message>
// Falls through gracefully for ad-hoc errors that don't match.
function parseErrorLine(raw) {
  if (!raw) return { ts: '', severity: 'unknown', source: '', worker_id: null, exit_code: null, message: '', raw: '' };
  const out = { ts: '', severity: 'error', source: '', worker_id: null, exit_code: null, message: '', raw: raw.slice(0, 600) };
  const tsMatch = raw.match(/^\[([^\]]+)\]\s*/);
  let rest = raw;
  if (tsMatch) { out.ts = tsMatch[1]; rest = raw.slice(tsMatch[0].length); }
  const srcMatch = rest.match(/^([A-Z]+(?:\s+[A-Z]+)?)\s+/);
  if (srcMatch) {
    out.source = srcMatch[1];
    if (/FAIL|ERROR|FATAL/.test(out.source)) out.severity = 'error';
    else if (/WARN/.test(out.source)) out.severity = 'warning';
    else if (/INFO/.test(out.source)) out.severity = 'info';
    rest = rest.slice(srcMatch[0].length);
  }
  const idMatch = rest.match(/^id=(\d+)\s+/);
  if (idMatch) { out.worker_id = parseInt(idMatch[1], 10); rest = rest.slice(idMatch[0].length); }
  const exitMatch = rest.match(/^exit=(\d+)\s*:?\s*/);
  if (exitMatch) { out.exit_code = parseInt(exitMatch[1], 10); rest = rest.slice(exitMatch[0].length); }
  out.message = rest.replace(/^:\s*/, '').slice(0, 400).trim();
  return out;
}

function appsByNum() {
  if (Date.now() - _appsCache.ts < 30_000 && _appsCache.byNum.size) return _appsCache.byNum;
  const apps = parseApplicationsFile(join(ROOT, 'data/applications.md'));
  const byNum = new Map();
  for (const a of apps) byNum.set(String(a.num), a);
  _appsCache = { ts: Date.now(), byNum };
  return byNum;
}
function enrichContact(c) {
  if (!c?.linked_application_id) return c;
  const app = appsByNum().get(String(c.linked_application_id));
  if (!app) return c;
  return {
    ...c,
    linked_application: {
      num:     app.num,
      company: app.company,
      role:    app.role,
      score:   app.score,
      status:  app.status,
      report:  app.reportPath || null,
    },
  };
}
function enrichOutreachSummary(summary) {
  return {
    ...summary,
    due_today: (summary.due_today || []).map(enrichContact),
    breakup:   (summary.breakup   || []).map(enrichContact),
    referrals: (summary.referrals || []).map(enrichContact),
    snoozed:   (summary.snoozed   || []).map(enrichContact),
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// A1 (2026-05-21) — lifecycle-state default shape (all-false) for /api/lifecycle-state
// error fallbacks. Keeps the client renderer simple: it can always read the 4
// booleans without a null-check.
function emptyLifecycleStates() {
  return { pack_exists: false, drive_synced: false, polished: false, applied: false };
}

// 2026-05-18: respect PORT env var first (set by Claude Code preview harness),
// then fall back to --port= CLI arg, then default 3000. Lets the preview
// runner pick an available port while the launchd-managed instance keeps
// holding 3097.
const PORT = parseInt(
  process.env.PORT
  || process.argv.find(a => a.startsWith('--port='))?.split('=')[1]
  || '3000'
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// ── Report summary parser ──────────────────────────────────────

function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseReportSummary(reportPath) {
  const empty = { score: null, archetype: null, url: null, legitimacy: null, tldr: null, comp: null, location: null, topEdges: [], topGaps: [] };
  try {
    const abs = join(ROOT, reportPath);
    if (!existsSync(abs)) return empty;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');

    // Extract header fields
    const scoreMatch   = text.match(/\*\*Score:\*\*\s*([\d.]+)/);
    const archMatch    = text.match(/\*\*Archetype:\*\*\s*([^\n]+)/);
    const urlMatch     = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);
    const legitMatch   = text.match(/\*\*Legitimacy:\*\*\s*([^\n]+)/);

    // Comp: extract from Block A or Block D table rows
    let comp = null;
    const looksLikeComp = (s) => s && !/^\d+\/5\s*$/.test(s) && !/^(value|tier|score)$/i.test(s) &&
      /[\$€£]|\bK\b|\b(TC|base|comp|salary|total comp|OTE|range)\b/i.test(s);
    const labelRe = /^\s*\|\s*\*?\*?\s*(?:Comp(?:ensation)?|Listed Annual Salary|Salary|Posted base salary)\b[^|]*?\|/i;

    const extractCompFromBlock = (blockText) => {
      for (const l of blockText.split('\n')) {
        if (!labelRe.test(l)) continue;
        const cells = l.split('|').map(c => c.replace(/\*\*/g, '').trim()).filter(Boolean);
        for (let ci = 1; ci < cells.length; ci++) {
          if (looksLikeComp(cells[ci])) return cells[ci].slice(0, 120);
        }
      }
      return null;
    };

    const blockAStart = text.search(/^## A\)[^\n]*$/m);
    const blockAEnd   = text.indexOf('\n## ', blockAStart + 1);
    const blockA = blockAStart >= 0 ? text.slice(blockAStart, blockAEnd > 0 ? blockAEnd : blockAStart + 3000) : '';
    if (blockA) comp = extractCompFromBlock(blockA);

    // Fall back to Block D if Block A had no comp row
    if (!comp) {
      const blockDStart = text.search(/^## D\)[^\n]*$/m);
      const blockDEnd   = text.indexOf('\n## ', blockDStart + 1);
      const blockD = blockDStart >= 0 ? text.slice(blockDStart, blockDEnd > 0 ? blockDEnd : blockDStart + 3000) : '';
      if (blockD) comp = extractCompFromBlock(blockD);
    }

    // Location: extract from Block A "Location" / "Remote" / "Locations" row
    let location = null;
    if (blockA) {
      for (const l of blockA.split('\n')) {
        if (!/^\s*\|\s*\*?\*?\s*(?:Location|Remote|Locations?)\b/i.test(l)) continue;
        const cells = l.split('|').map(c => c.replace(/\*\*/g, '').trim()).filter(Boolean);
        if (cells.length > 1) { location = cells[1].slice(0, 200); break; }
      }
    }

    // TL;DR: text after first ## B) or TLDR or Final Recommendation heading
    let tldr = null;
    const tldrSectionIdx = lines.findIndex(l =>
      /^##\s+B\)/.test(l) || /tldr/i.test(l) || /final recommendation/i.test(l)
    );
    if (tldrSectionIdx >= 0) {
      const chunk = lines.slice(tldrSectionIdx + 1, tldrSectionIdx + 30).join(' ');
      const clean = stripMarkdown(chunk);
      tldr = clean.slice(0, 300) || null;
    }

    // Top edges: first 3 bullet lines after ## D)
    const edgeSectionIdx = lines.findIndex(l => /^##\s+D\b/.test(l));
    let topEdges = [];
    if (edgeSectionIdx >= 0) {
      let count = 0;
      for (let i = edgeSectionIdx + 1; i < lines.length && count < 3; i++) {
        const l = lines[i];
        if (/^##/.test(l)) break;
        if (/^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l)) {
          const clean = stripMarkdown(l).slice(0, 120);
          if (clean) { topEdges.push(clean); count++; }
        }
      }
    }

    // Top gaps: first 2 bullet lines after ## E) or ## Gap
    const gapSectionIdx = lines.findIndex(l => /^##\s+E\b/.test(l) || /^##.*gap/i.test(l));
    let topGaps = [];
    if (gapSectionIdx >= 0) {
      let count = 0;
      for (let i = gapSectionIdx + 1; i < lines.length && count < 2; i++) {
        const l = lines[i];
        if (/^##/.test(l)) break;
        if (/^[-*]\s+/.test(l) || /^\d+\.\s+/.test(l)) {
          const clean = stripMarkdown(l).slice(0, 100);
          if (clean) { topGaps.push(clean); count++; }
        }
      }
    }

    const rawUrl = urlMatch ? urlMatch[1].trim() : null;
    return {
      score:      scoreMatch  ? parseFloat(scoreMatch[1])       : null,
      archetype:  archMatch   ? archMatch[1].trim()              : null,
      url:        rawUrl      ? getCachedUrl(rawUrl, ROOT)       : null,
      legitimacy: legitMatch  ? legitMatch[1].trim()             : null,
      tldr,
      comp,
      location,
      topEdges,
      topGaps,
    };
  } catch (_) {
    return empty;
  }
}

// ── DELTA P1 — Editing Priority callout ────────────────────────────────────
// Maps a band-aware AI-detection result + signal-quality state into a
// single "Editing Priority" object the dashboard renders as a coloured
// chip + sentence list. Reads:
//   apiDet.band                              CRIT|HIGH|MED|CLEAR|null
//   apiDet.gptzero_signal_quality            GOOD|WEAK|USELESS|UNCALIBRATED
//   apiDet.originality_signal_quality        GOOD|WEAK|USELESS|UNCALIBRATED
//   apiDet.pangram_signal_quality            GOOD|WEAK|USELESS|UNCALIBRATED
//   apiDet.sentences[].generated_prob        per-sentence GPTZero score
//   apiDet.sentences[].highlight_for_ai      GPTZero's own highlight flag
//   apiDet.sentence_signals.highlighted_count
// Returns null if no detection ran.
function computeEditingPriority(apiDet, _result) {
  if (!apiDet || apiDet.error) return null;
  const band    = apiDet.band || null;
  const gz      = apiDet.gptzero_signal_quality     || 'UNCALIBRATED';
  const orig    = apiDet.originality_signal_quality || 'UNCALIBRATED';
  const pangram = apiDet.pangram_signal_quality     || 'UNCALIBRATED';

  // Priority logic:
  //   - HIGH/CRIT band AND any GOOD-signal detector → ACTION (block ship; rewrite)
  //   - HIGH/CRIT band AND no GOOD signal           → ADVISORY (detectors useless;
  //                                                   show highlights but don't block)
  //   - MED band                                    → REVIEW (light touch-up suggested)
  //   - CLEAR or null                               → NONE
  const anyGood = gz === 'GOOD' || orig === 'GOOD' || pangram === 'GOOD';
  let priority = 'NONE';
  let blocking = false;
  if (band === 'CRIT' || band === 'HIGH') {
    if (anyGood) { priority = 'ACTION'; blocking = true; }
    else         { priority = 'ADVISORY'; }
  } else if (band === 'MED') {
    priority = 'REVIEW';
  }

  // Top flagged sentences (cap at 5 to keep callout readable).
  const sentences = Array.isArray(apiDet.sentences) ? apiDet.sentences : [];
  const top_flagged = sentences
    .filter(s => typeof s?.generated_prob === 'number')
    .map(s => ({
      sentence: (s.sentence || '').slice(0, 300),
      generated_prob: Math.round((s.generated_prob || 0) * 1000) / 1000,
      highlight: !!s.highlight_for_ai,
    }))
    .sort((a, b) => b.generated_prob - a.generated_prob)
    .slice(0, 5);

  return {
    priority,            // 'ACTION' | 'ADVISORY' | 'REVIEW' | 'NONE'
    blocking,            // true if pack should not ship without rewrite
    band,                // CRIT/HIGH/MED/CLEAR/null
    gptzero_signal_quality:     gz,
    originality_signal_quality: orig,
    pangram_signal_quality:     pangram,
    flagged_sentence_count: apiDet.sentence_signals?.highlighted_count ?? top_flagged.length,
    top_flagged,
    advisory_note: priority === 'ADVISORY'
      ? 'All three detectors are calibrated USELESS against Mitchell\'s voice baseline — the high score is likely a false positive, not a signal to rewrite.'
      : null,
  };
}

// ── Shared parsers ─────────────────────────────────────────────

// parseApplications lives in lib/parse-applications.mjs (single source of
// truth — also used by build-dashboard.mjs). The rest of this file expects
// `r.report` for the report path, but the lib returns `reportPath`; we
// add `report` as an alias here so call sites stay unchanged.
function parseApplications() {
  return parseApplicationsFile(join(ROOT, 'data/applications.md'))
    .map(r => ({ ...r, report: r.reportPath || null }));
}

function parsePipeline() {
  const path = join(ROOT, 'data/pipeline.md');
  if (!existsSync(path)) return { tier1: 0, tier2: 0, tier3: 0, total: 0 };
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  let tier = 0, t1 = 0, t2 = 0, t3 = 0;
  for (const l of lines) {
    if (l.includes('Tier 1')) tier = 1;
    else if (l.includes('Tier 2')) tier = 2;
    else if (l.includes('Tier 3')) tier = 3;
    if (l.startsWith('- [ ]')) {
      if (tier === 1) t1++;
      else if (tier === 2) t2++;
      else if (tier === 3) t3++;
    }
  }
  return { tier1: t1, tier2: t2, tier3: t3, total: t1 + t2 + t3 };
}

// ── Pipeline preview + spawner for the "Run Batch" / "Process All" buttons ─
// Per-item cost ground truth comes from data/cost-log.tsv ($0.06/eval observed
// for the legacy triage-only path; Tier 5 enrichment economics are richer).
//
// Per-run caps were calibrated against the Tier 5 enrichment economics
// (per-company council intel + contact discovery + outreach drafts + apply-pack
// pre-gen on high-confidence items). The post-calibration ground truth:
//   - Run Batch (default top-5 items, Tier 5):   ~$15-25/run
//   - Process All (~100 items, Tier 5 amortized cache): ~$200-280/run
//   - Overnight auto-run (~5-10 Apply-Now items): ~$15-30/night
//   - Monthly steady-state target: $500/mo (calibration brief 2026-05-16)
//
// All caps overridable via env vars so power-user / interview-week bursts can
// raise the ceiling without code changes.
// ε 2026-05-19 — promoted 5 cost-preview ratios to env-var overrides so ops
// can tune them without code changes (e.g. when council pricing shifts or
// publish rate drifts season-over-season). Defaults preserved bit-for-bit
// to ensure no behavior change vs prior session. Env-var names follow the
// existing PER_RUN_CAP_* / COST_PER_*_USD convention.
//
// OMEGA-proposal-3 (approved 2026-05-19): unify env-var input validation.
// Bare parseFloat() lets a typo like PUBLISH_RATE_ESTIMATE="abc" propagate NaN
// through every downstream multiplication, breaking the cost-preview JSON +
// modal layout. clampEnvFloat/Int wraps parseFloat/parseInt with Number.isFinite
// + Math.min/Math.max, mirroring α's POLISH_* loader pattern. Standardized
// ranges: rates [0.0, 1.0], costs [0.0, 500.0], caps [0.0, 10_000.0],
// thresholds [0.0, 10.0]. On bad input (NaN or out-of-range), the default is
// used instead so the dashboard renders cleanly.
function clampEnvFloat(envVar, defaultValue, min, max) {
  const raw = parseFloat(process.env[envVar] ?? '');
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.min(Math.max(raw, min), max);
}
function clampEnvInt(envVar, defaultValue, min, max) {
  const raw = parseInt(process.env[envVar] ?? '', 10);
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.min(Math.max(raw, min), max);
}
const COST_PER_TRIAGE_HAIKU      = clampEnvFloat('COST_PER_TRIAGE_HAIKU_USD',      0.005, 0, 500);
const COST_PER_TRIAGE_SONNET_JD  = clampEnvFloat('COST_PER_TRIAGE_SONNET_JD_USD',  0.07,  0, 500);   // Tier 5 enriched triage per item
const COST_PER_BATCH_EVAL        = clampEnvFloat('COST_PER_BATCH_EVAL_USD',        0.060, 0, 500);
const COST_PER_COMPANY_COUNCIL   = clampEnvFloat('COST_PER_COMPANY_COUNCIL_USD',   2.00,  0, 500);   // council-of-models + dealbreaker per unique company
const COST_PER_APPLY_PACK_PREGEN = clampEnvFloat('COST_PER_APPLY_PACK_PREGEN_USD', 2.50,  0, 500);   // build-apply-packs.mjs per high-conf item
const ADVANCE_RATE_ESTIMATE       = clampEnvFloat('ADVANCE_RATE_ESTIMATE',        0.50,  0, 1);     // historical: 11–72%; 50% is conservative mid
const HIGH_CONFIDENCE_PREGEN_RATE = clampEnvFloat('HIGH_CONFIDENCE_PREGEN_RATE',  0.20,  0, 1);     // % of items hitting ≥4.5 + high-conf flag
const COMPANY_CACHE_HIT_RATE      = clampEnvFloat('COMPANY_CACHE_HIT_RATE',       0.50,  0, 1);     // % of unique companies already cached (30d TTL)

const PER_RUN_CAP_RUN_BATCH    = clampEnvFloat('PER_RUN_CAP_RUN_BATCH_USD',    25,  0, 10_000);
const PER_RUN_CAP_PROCESS_ALL  = clampEnvFloat('PER_RUN_CAP_PROCESS_ALL_USD',  1000, 0, 10_000);
// 2026-05-26 — Audit-log threshold. Every Process All spawn whose cost estimate
// exceeds this gets recorded to data/process-all-audit.jsonl. Defaults to $250
// (the pre-2026-05-26 cap) so the audit trail captures every "non-trivial spend"
// run regardless of whether the cap is currently $250, $1000, or env-overridden.
const PROCESS_ALL_AUDIT_THRESHOLD_USD = clampEnvFloat('PROCESS_ALL_AUDIT_THRESHOLD_USD', 250, 0, 10_000);
const PER_RUN_CAP_APPLY_PACK   = clampEnvFloat('PER_RUN_CAP_APPLY_PACK_USD',   5,   0, 10_000);
const DAILY_CAP_OVERNIGHT      = clampEnvFloat('DAILY_CAP_OVERNIGHT_USD',      20,  0, 10_000);
// Single-row apply-pack estimate (council pricing). build-apply-pack.mjs today
// only scaffolds stubs (~$0), but the prompt assumes it will eventually run
// the council + humanize-check passes — budget for that future state so the
// cap meaningfully gates power-user "regenerate everything" loops.
const COST_PER_APPLY_PACK_USD  = clampEnvFloat('COST_PER_APPLY_PACK_USD', 2.50, 0, 500);
// Decomposed agent enrichment costs (surfaced per-stage in the preview modal).
//
// γ GAMMA 2026-05-19 truth-audit (CORRECTED after self-review hallucination):
// Sources cited inline; cost-decomp modal renders provenance.
//
// COST_PER_RESEARCHER_CALL: $3.00 — `lib/hm-intel-research.mjs:335` sets
//   default `budgetUsd = 3` for the /researcher agent invocation per role.
//   This is the BUDGET CAP, not observed mean; researcher agent self-budgets
//   under this cap and may come in well below (data/cost-log.tsv N=2 observed
//   mean = $0.625 for researcher-mixed entries).
//   PRIOR HALLUCINATION (`$11.30 from scripts/agents/intel-refresh.mjs --slots
//   hm-intel COST_ESTIMATE`): the originally-cited script (`scripts/hiring-
//   manager-research.mjs`) never existed in the codebase. The reference was
//   generated, not read. The hm-intel slot is now served by
//   scripts/agents/intel-refresh.mjs. Corrected to real $3 budget cap. See
//   data/agent-hallucination-log.md entry 2026-05-19-γ-runbatch for details.
//   Confidence: MED (budget cap, not observed mean; observed mean from N=2
//   logged runs is $0.625 — actual cost likely $0.5-$3 per call).
const COST_PER_RESEARCHER_CALL   = clampEnvFloat('COST_PER_RESEARCHER_CALL_USD',  3.00, 0, 500);
// COST_PER_DEALBREAKER_CALL: $0.30 — observed mean of N=2 logged runs in
//   `data/cost-log.tsv` is $0.25 ($0.20 + $0.30). $0.30 kept as a +20% buffer
//   over observed mean; falls inside the small-N confidence band.
//   Confidence: MED (only 2 logged runs; widen to ±$0.10).
const COST_PER_DEALBREAKER_CALL  = clampEnvFloat('COST_PER_DEALBREAKER_CALL_USD', 0.30, 0, 500);
// γ GAMMA 2026-05-19 truth-audit + ε EPSILON env-override (merged):
// Defaults are calibrated to real data; env overrides honored for ops tuning.
//
// PUBLISH_RATE_ESTIMATE: 0.22 — `data/applications.md` shows 29 of 131 scored
//   rows at >=4.0 (22.1%). Prior 0.40 was a vibes estimate ~80% above real.
//   Confidence: HIGH (N=131, multi-month historical).
const PUBLISH_RATE_ESTIMATE      = clampEnvFloat('PUBLISH_RATE_ESTIMATE',      0.22, 0, 1);
// RESEARCHER_ENRICHMENT_RATE: 0.19 — `data/apply-now-queue.json` ranked has 21
//   roles; `data/hm-intel/*.json` (excluding _SCHEMA, _weights) has 17 cached
//   intel files (80.9% coverage). 4 of 21 uncached = 19.0% trigger rate.
//   Prior 0.30 over-estimated by ~58%. This rate WILL drift as queue churns;
//   re-calibrate when queue size changes by >50%.
//   Confidence: MED (N=21, single-day snapshot).
const RESEARCHER_ENRICHMENT_RATE = clampEnvFloat('RESEARCHER_ENRICHMENT_RATE', 0.19, 0, 1);
// THRESHOLD_FOR_PUBLISH: 4.0 — verified in `lib/funnel-completion.mjs:128`,
//   `lib/next-moves.mjs:121`, `lib/eval-council.mjs:144`. PASS — gated by real code.
const THRESHOLD_FOR_PUBLISH      = clampEnvFloat('THRESHOLD_FOR_PUBLISH',      4.0, 0, 10);
// α Run-Batch eval 2026-05-19 — polish stage costs (only surface when POLISH_PACK_ENABLED=1).
// Default of ~$12/pack is the post-bugfix calibrated typical. The earlier $60 figure was
// derived from cost-trace records produced before commit 8e83ffa, which had a per-1K-vs-per-1M
// units bug in MODEL_COST_RATES that inflated every Anthropic Opus + Sonnet cost by ~1000x.
// Recomputed against actual 2026-05-20 + 2026-05-22 traces (data/polish-cost-trace-corrected-*.json):
// full 6-artifact pack averages ~$10-15. The $500 cap from spec is the hard ceiling, not the mean.
// Bounded same as scripts/process-all-pipeline.mjs:phasePolish so dashboard preview stays
// in sync with the agent's actual behavior. See data/cost-trace-bug-postmortem-2026-05-22.md.
const _rawPolishCost = parseFloat(process.env.COST_PER_POLISH_PACK_USD || '12.00');
const COST_PER_POLISH_PACK_USD     = Number.isFinite(_rawPolishCost) && _rawPolishCost > 0 ? _rawPolishCost : 12;
const _rawPolishTopN = parseInt(process.env.POLISH_TOP_N_PER_RUN || '5', 10);
const POLISH_TOP_N_PER_RUN         = Number.isFinite(_rawPolishTopN) && _rawPolishTopN > 0 ? Math.min(_rawPolishTopN, 20) : 5;
const _rawPolishCap = parseFloat(process.env.POLISH_PER_PACK_COST_CAP_USD || '120.00');
const POLISH_PER_PACK_COST_CAP_USD = Number.isFinite(_rawPolishCap) && _rawPolishCap > 0 ? Math.min(Math.max(_rawPolishCap, 10), 500) : 120;
// γ GAMMA truth-audit metadata (rendered in modal as provenance).
const COST_CALIBRATION_PROVENANCE = {
  publish_rate: {
    value: PUBLISH_RATE_ESTIMATE,
    source: 'data/applications.md (29 of 131 scored rows ≥ 4.0)',
    confidence: 'HIGH',
    sample_size: 131,
    last_calibrated: '2026-05-19',
    confidence_band_pct: 5,    // ±5% absolute (N=131 → SE ≈ 3.6%)
  },
  researcher_cost: {
    value: COST_PER_RESEARCHER_CALL,
    source: 'lib/hm-intel-research.mjs:335 budgetUsd default (cost cap, not mean)',
    confidence: 'MED',
    sample_size: 2,             // N=2 observed runs in cost-log.tsv (researcher-mixed)
    observed_mean_usd: 0.625,   // mean of N=2 observed runs ($0.85 + $0.40)
    last_calibrated: '2026-05-19',
    confidence_band_pct: 100,   // ±100% — budget cap is upper bound; actual highly variable
    note: 'budget cap; actual cost likely $0.5-$3 per call. Corrected from hallucinated $11.30.',
  },
  dealbreaker_cost: {
    value: COST_PER_DEALBREAKER_CALL,
    source: 'data/cost-log.tsv (observed mean N=2, +20% buffer)',
    confidence: 'MED',
    sample_size: 2,
    last_calibrated: '2026-05-19',
    confidence_band_pct: 50,    // ±50% wide band (N=2 — very low statistical power)
  },
  researcher_enrichment_rate: {
    value: RESEARCHER_ENRICHMENT_RATE,
    source: 'data/apply-now-queue.json vs data/hm-intel/*.json (4 of 21 uncached)',
    confidence: 'MED',
    sample_size: 21,
    last_calibrated: '2026-05-19',
    confidence_band_pct: 30,    // ±30% — drifts with queue churn
  },
  publish_threshold: {
    value: THRESHOLD_FOR_PUBLISH,
    source: 'lib/funnel-completion.mjs:128 + lib/next-moves.mjs:121 + lib/eval-council.mjs:144',
    confidence: 'HIGH',
    sample_size: null,
    last_calibrated: '2026-05-19',
    confidence_band_pct: 0,     // ±0 — verified against code
  },
  company_cache_hit_rate: {
    value: 0.50,                // Note: actual is 1.00 today; preview keeps conservative 0.50
    source: 'data/company-intel-cache/ (10 of 10 queue companies cached, oldest 2d)',
    confidence: 'MED',
    sample_size: 10,
    last_calibrated: '2026-05-19',
    confidence_band_pct: 50,    // ±50% — TTL is 30d, churn unpredictable
    note: 'observed today=100%, kept conservative 50% to absorb cache expiry',
  },
  polish_typical_cost: {
    value: COST_PER_POLISH_PACK_USD,
    source: 'corrected polish-cost-trace records (2026-05-20 + 2026-05-22) post-bugfix-8e83ffa',
    confidence: 'MED',
    sample_size: 95,            // 88 + 7 records across 2 correctly-priced trace days
    last_calibrated: '2026-05-22',
    confidence_band_pct: 50,    // ±50% — observed $8-20 range across artifact mixes
    note: 'env-tunable via COST_PER_POLISH_PACK_USD; was $60 from inflated traces — see data/cost-trace-bug-postmortem-2026-05-22.md',
  },
  // δ DELTA Run-Batch 2026-05-19 — AI-detection cost provenance
  ai_detection_cost: {
    value: 0.02,                // per artifact, see COST_PER_AI_DETECTION_ARTIFACT
    source: 'lib/ai-detection-gate.mjs:36-38 (GPTZero $0.01 + Originality $0.01 per call, vendor-published rates)',
    confidence: 'HIGH',
    sample_size: 2,             // 2 vendors with documented per-call pricing
    last_calibrated: '2026-05-19',
    confidence_band_pct: 10,    // ±10% — Originality.ai pricing fluctuates by plan tier
    note: 'Retry multiplier 1.5× accounts for CLEAR/MED/HIGH/CRIT distribution; 5 artifacts/pack; opt-in rate 40% (set PACK_BUILD_OPT_IN_RATE=1.0 for worst-case)',
  },
};

// δ DELTA Run-Batch 2026-05-19 — AI-detection gate cost (per artifact).
// GPTZero + Originality.ai charge ~$0.01/call each → $0.02/artifact baseline.
// 5 artifacts per pack (cv-tailored, cover-letter, why-statement,
// linkedin-dm, form-fields) → $0.10/pack baseline. Retry stages can triple
// the call count → up to $0.30/pack worst-case. Detection cost ONLY fires
// when the user clicks "Build pack" on a published row's drawer — it is
// NOT invoked anywhere on the Process All / Run Batch publish path itself
// (per δ Run-Batch audit 2026-05-19). The preview surfaces this cost as a
// post-publish potential spend the user should know about.
const COST_PER_AI_DETECTION_ARTIFACT = clampEnvFloat('COST_PER_AI_DETECTION_ARTIFACT_USD', 0.02, 0, 500);
const AI_DETECTION_ARTIFACTS_PER_PACK = 5;
const AI_DETECTION_RETRY_MULTIPLIER   = 1.5;   // average across CLEAR / MED / HIGH / CRIT outcomes
const PACK_BUILD_OPT_IN_RATE          = clampEnvFloat('PACK_BUILD_OPT_IN_RATE', 0.40, 0, 1);
// Per-pack detection cost = artifacts × per-call × retry multiplier (~$0.15/pack)
// Multiplied by PACK_BUILD_OPT_IN_RATE (the % of published items the user
// actually generates a pack for) to avoid over-stating cost on packs the
// user never builds. Set PACK_BUILD_OPT_IN_RATE=1.0 to assume all published
// items get a build (worst-case).
const COST_PER_AI_DETECTION_PACK = COST_PER_AI_DETECTION_ARTIFACT
                                 * AI_DETECTION_ARTIFACTS_PER_PACK
                                 * AI_DETECTION_RETRY_MULTIPLIER;

function countPipelinePending() {
  const fp = join(ROOT, 'data/pipeline.md');
  if (!existsSync(fp)) return 0;
  return readFileSync(fp, 'utf-8').split('\n').filter(l => l.startsWith('- [ ]')).length;
}

function countTriageAdvanceQueued() {
  const fp = join(ROOT, 'batch/triage-advance.tsv');
  if (!existsSync(fp)) return 0;
  return Math.max(0, readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#')).length - 1);
}

function getMonthlyBudget() {
  // Calibration 2026-05-16: default raised from $50 to $500 to accommodate
  // Tier 5 nightly enrichment + manual Run Batch + occasional Process All.
  // Override via MONTHLY_BUDGET_USD env if running heavier or lighter.
  // OMEGA-proposal-3 (approved 2026-05-19): clamped to [0, 100_000] so a
  // typo (e.g. MONTHLY_BUDGET_USD="abc") doesn't propagate NaN through
  // headroom math + cap-warning copy.
  return clampEnvFloat('MONTHLY_BUDGET_USD', 500, 0, 100_000);
}

function getBurstBudget() {
  // Burst-mode for interview weeks: raise the ceiling temporarily, deduct
  // from next month's cap. Set MONTHLY_BUDGET_USD_BURST=1000 + MONTHLY_BUDGET_BURST_UNTIL=YYYY-MM-DD
  // to activate. Returns 0 if burst is disabled or expired.
  const burst = clampEnvFloat('MONTHLY_BUDGET_USD_BURST', 0, 0, 100_000);
  if (!burst) return 0;
  const until = process.env.MONTHLY_BUDGET_BURST_UNTIL;
  if (until && Date.now() > Date.parse(until)) return 0;
  return burst;
}

function getEffectiveMonthlyBudget() {
  return getMonthlyBudget() + getBurstBudget();
}

// ── Recruiter pipeline density (retired 2026-05-25) ──────────────────────
// `RUNWAY_WEEKS_DEFAULT`, `PIPELINE_HEALTH_THRESHOLDS`,
// `computeRecruiterPipelineDensity`, and `computeRunwayDetail` lived here
// previously. They were the compute behind the sidebar Runway widget +
// /api/recruiter-pipeline-density + /api/runway-detail. Both endpoints +
// their consumers (build-dashboard.mjs runway-detail modal, heartbeat
// runway-alert section) were retired across PR #222, PR #233, and the
// follow-up sweep. No replacement compute is shipped — the dashboard +
// heartbeat surfaces no longer lead with a runway-framed urgency signal.

// Classifies a free-text discard reason into a coarse tag for grouping.
// Lightweight keyword match; refine over time as patterns emerge.
function classifyDiscardReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (/(comp|salary|pay|equity|tc|total comp|base)/.test(r)) return 'comp';
  if (/(location|relocat|remote|on-site|hybrid|commute|city|metro)/.test(r))   return 'geography';
  if (/(culture|toxic|leadership|reorg|layoff|freez|burnout|attrition)/.test(r)) return 'culture';
  if (/(stack|tech|python|ml|skill|requirement|qualification|background)/.test(r)) return 'skill-gap';
  if (/(defense|weapons|surveillance|military|policing|gambling|tobacco|fossil)/.test(r)) return 'ethics';
  if (/(stage|series|funding|valuation|pre-ipo|public|growth)/.test(r))         return 'stage';
  if (/(velocity|slow|process|cycle|hiring freeze|silent|ghost)/.test(r))      return 'velocity';
  if (/(role|title|scope|level|seniority|ic|manager|ladder)/.test(r))          return 'role-shape';
  if (/(brand|mission|fit|interest|inspire|bored|excite)/.test(r))             return 'fit';
  return 'other';
}

// `computeRecruiterPipelineDensity` and `computeRunwayDetail` were
// retired here 2026-05-25 (see the comment block above for the audit
// trail). Net-removed ~270 LOC.

function getRolling30dSpend() {
  const fp = join(ROOT, 'data/cost-log.tsv');
  if (!existsSync(fp)) return 0;
  const cutoff = Date.now() - 30 * 86400000;
  let total = 0;
  const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('date\t')) continue;
    const cols = line.split('\t');
    // Two formats observed: long TSV (date, batch_id, requests, ... cost_usd, model) AND
    // short append (date, iso_ts, cost_usd, label). Detect by column count.
    let dateStr, cost;
    if (cols.length >= 9) {
      dateStr = cols[0]; cost = parseFloat(cols[7]);
    } else if (cols.length >= 4) {
      dateStr = cols[0]; cost = parseFloat(cols[2]);
    } else continue;
    if (!isFinite(cost)) continue;
    const t = Date.parse(dateStr);
    if (isNaN(t) || t < cutoff) continue;
    total += cost;
  }
  return total;
}

// P0.7 Q5 (2026-05-20 iter9) — sum cost-log spend incurred since a job's
// start ISO timestamp. Backs the cost-confirmation gate on /api/batch/cancel:
// the dashboard surfaces spend-so-far to the user before SIGTERM so they
// don't kill an expensive run by accident. Same TSV parsing rules as
// getRolling30dSpend (two observed column shapes).
function getSpendSinceIso(startedAtIso) {
  const fp = join(ROOT, 'data/cost-log.tsv');
  if (!existsSync(fp)) return 0;
  const cutoff = Date.parse(startedAtIso);
  if (!Number.isFinite(cutoff)) return 0;
  let total = 0;
  const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('date\t')) continue;
    const cols = line.split('\t');
    let dateStr, cost;
    if (cols.length >= 9) {
      dateStr = cols[0]; cost = parseFloat(cols[7]);
    } else if (cols.length >= 4) {
      // Short append rows carry ISO ts in col 1 — prefer it for finer-grain windows.
      dateStr = cols[1] || cols[0]; cost = parseFloat(cols[2]);
    } else continue;
    if (!isFinite(cost)) continue;
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t) || t < cutoff) continue;
    total += cost;
  }
  return total;
}

// 2026-05-27 — Most-recent completed Process All delta. Surfaced in the cost
// modal as "Last run drained 33 from pipeline (1968 → 1935)" so the queue
// counters show fluctuation across runs even when the absolute pending count
// only drops 1-2% per run (33 of 1968 = imperceptible without context).
// AGENTS.md bug-class: queue-counter-fluctuation-imperceptible-without-delta.
function _computeLastRunDelta() {
  try {
    const fp = join(ROOT, 'data/pipeline-process-state.json');
    if (!existsSync(fp)) return null;
    const ps = JSON.parse(readFileSync(fp, 'utf-8'));
    const jobs = Object.values(ps.jobs || {})
      .filter(j => j && j.type === 'process-all' && (j.status === 'completed' || j.status === 'completed_no_op' || j.status === 'cancelled'))
      .sort((a, b) => {
        const ta = Date.parse(a.finished_at || a.cancelled_at || a.updated_at || '') || 0;
        const tb = Date.parse(b.finished_at || b.cancelled_at || b.updated_at || '') || 0;
        return tb - ta;
      });
    if (jobs.length === 0) return null;
    const j = jobs[0];
    const pendingBefore = j.triage_pipeline_before || j.pending_before || 0;
    const pendingAfter = j.triage_pipeline_after != null ? j.triage_pipeline_after : (j.pending_after != null ? j.pending_after : pendingBefore);
    return {
      jobId: j.jobId,
      status: j.status,
      finished_at: j.finished_at || j.cancelled_at || j.updated_at,
      pipeline_before: pendingBefore,
      pipeline_after: pendingAfter,
      drained: Math.max(0, pendingBefore - pendingAfter),
      advanced: j.triage_advanced || 0,
      skipped: j.triage_skipped || 0,
      processed: j.triage_processed || j.processed || 0,
      batch_drained: j.batch_items_drained || 0,
      published: j.published_count || 0,
    };
  } catch (_) { return null; }
}

function buildPipelinePreview() {
  const pending = countPipelinePending();
  const queued  = countTriageAdvanceQueued();
  const monthlyBudget   = getMonthlyBudget();
  const burstBudget     = getBurstBudget();
  const effectiveBudget = monthlyBudget + burstBudget;
  const spent30d        = getRolling30dSpend();
  const headroom        = Math.max(0, effectiveBudget - spent30d);

  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }

  // ── Stage counts ──────────────────────────────────────────────────────────
  const batchEvalCount     = queued + Math.round(pending * ADVANCE_RATE_ESTIMATE);
  const publishCount       = batchEvalCount === 0 ? 0 : Math.round(batchEvalCount * PUBLISH_RATE_ESTIMATE);
  const queuedPublishCount = queued === 0 ? 0 : Math.round(queued * PUBLISH_RATE_ESTIMATE);

  // ── Stage costs ───────────────────────────────────────────────────────────
  const triageCost    = pending * COST_PER_TRIAGE_HAIKU;
  const processCost   = batchEvalCount * COST_PER_BATCH_EVAL;
  const rbProcessCost = queued * COST_PER_BATCH_EVAL;

  // ── Agent enrichment counts (council deduped by company; researcher/dealbreaker per role) ──
  const paUniqueCompanies  = publishCount === 0 ? 0 : Math.max(1, Math.round(publishCount * 0.60));
  const paCouncilCount     = Math.round(paUniqueCompanies * (1 - COMPANY_CACHE_HIT_RATE));
  const paResearcherCount  = Math.round(publishCount * RESEARCHER_ENRICHMENT_RATE);

  const rbUniqueCompanies  = queuedPublishCount === 0 ? 0 : Math.max(1, Math.round(queuedPublishCount * 0.60));
  const rbCouncilCount     = Math.round(rbUniqueCompanies * (1 - COMPANY_CACHE_HIT_RATE));
  const rbResearcherCount  = Math.round(queuedPublishCount * RESEARCHER_ENRICHMENT_RATE);

  // ── Agent enrichment costs ────────────────────────────────────────────────
  const paCouncilCost      = paCouncilCount * COST_PER_COMPANY_COUNCIL;
  const paResearcherCost   = paResearcherCount * COST_PER_RESEARCHER_CALL;
  const paDealBreakerCost  = paResearcherCount * COST_PER_DEALBREAKER_CALL;
  const paAgentTotal       = paCouncilCost + paResearcherCost + paDealBreakerCost;

  const rbCouncilCost      = rbCouncilCount * COST_PER_COMPANY_COUNCIL;
  const rbResearcherCost   = rbResearcherCount * COST_PER_RESEARCHER_CALL;
  const rbDealBreakerCost  = rbResearcherCount * COST_PER_DEALBREAKER_CALL;
  const rbAgentTotal       = rbCouncilCost + rbResearcherCost + rbDealBreakerCost;

  // α Run-Batch eval 2026-05-19 — polish stage cost (only when POLISH_PACK_ENABLED=1).
  // process-all-pipeline.mjs:phasePolish targets top-N Evaluated rows from the apply-now
  // queue (default 5). Each pack converges around $60 typical, $120 cap. The cap is what
  // we surface so the user sees the WORST-case figure before they confirm.
  const polishEnabled = String(process.env.POLISH_PACK_ENABLED || '').trim() === '1';
  const paPolishCount = polishEnabled ? POLISH_TOP_N_PER_RUN : 0;
  const paPolishCost  = paPolishCount * COST_PER_POLISH_PACK_USD;
  // Run Batch doesn't invoke polish today (polish is in process-all-pipeline.mjs only).
  const rbPolishCount = 0;
  const rbPolishCost  = 0;

  // ── δ DELTA Run-Batch 2026-05-19 — AI-detection (post-publish, opt-in) ──
  // Detection fires only when user clicks "Build pack" on a published row.
  // Cost: ~$0.10-0.30/pack (5 artifacts × $0.02 × 1.5× retry multiplier),
  // discounted by PACK_BUILD_OPT_IN_RATE since not every published row gets
  // a pack built. NOT invoked anywhere on the Process All / Run Batch publish
  // path itself (per δ Run-Batch audit 2026-05-19) — surfaced here so the
  // budget is honest about downstream spend the user will incur if they
  // build packs.
  const paDetectionPacks   = Math.round(publishCount * PACK_BUILD_OPT_IN_RATE);
  const paDetectionCost    = paDetectionPacks * COST_PER_AI_DETECTION_PACK;
  const rbDetectionPacks   = Math.round(queuedPublishCount * PACK_BUILD_OPT_IN_RATE);
  const rbDetectionCost    = rbDetectionPacks * COST_PER_AI_DETECTION_PACK;

  // 2026-05-27 — Hard separation. Process All / Run Batch totals = pipeline
  // drainage cost only (triage + batch). Per-pack enrichment (council /
  // researcher / dealbreaker / polish / pregen / detection) moves to a
  // separate `post_publish_opt_in` object — those costs fire ONLY when the
  // user clicks Build Pack / Polish on a row, not during Process All itself.
  // Per Mitchell's directive: polish + pregen are removed from these flows.
  const processAllCost = triageCost + processCost;
  const runBatchCost   = rbProcessCost;
  // Per-pack potential cost surfaced separately (clarity, not hidden):
  const postPublishPerRowMaxUsd = COST_PER_COMPANY_COUNCIL + COST_PER_RESEARCHER_CALL
                                + COST_PER_DEALBREAKER_CALL + COST_PER_APPLY_PACK_PREGEN
                                + COST_PER_POLISH_PACK_USD + COST_PER_AI_DETECTION_PACK;

  // ── Tier 5 estimates (post-Phase-3, upgrade planning) ────────────────────
  const tier5UniqueCompaniesEstimate = Math.max(1, Math.round(batchEvalCount * 0.60));
  const tier5CompaniesCouncilCost    = tier5UniqueCompaniesEstimate * COST_PER_COMPANY_COUNCIL * (1 - COMPANY_CACHE_HIT_RATE);
  const tier5TriageEnrichedCost      = batchEvalCount * COST_PER_TRIAGE_SONNET_JD;
  const tier5ApplyPackCost           = Math.round(batchEvalCount * HIGH_CONFIDENCE_PREGEN_RATE) * COST_PER_APPLY_PACK_PREGEN;
  const tier5ProcessAllCost          = tier5TriageEnrichedCost + tier5CompaniesCouncilCost + tier5ApplyPackCost;

  const tier5RunBatchUniqueCompanies = Math.max(1, Math.round(queued * 0.60));
  const tier5RunBatchCost = (queued * COST_PER_TRIAGE_SONNET_JD)
                          + (tier5RunBatchUniqueCompanies * COST_PER_COMPANY_COUNCIL * (1 - COMPANY_CACHE_HIT_RATE))
                          + (Math.round(queued * HIGH_CONFIDENCE_PREGEN_RATE) * COST_PER_APPLY_PACK_PREGEN);

  return {
    pending_pipeline:     pending,
    queued_for_batch:     queued,
    monthly_budget_usd:   monthlyBudget,
    burst_budget_usd:     burstBudget,
    effective_budget_usd: effectiveBudget,
    spent_30d_usd:        r2(spent30d),
    headroom_usd:         r2(headroom),
    per_run_caps: {
      run_batch_usd:    PER_RUN_CAP_RUN_BATCH,
      process_all_usd:  PER_RUN_CAP_PROCESS_ALL,
      overnight_usd:    DAILY_CAP_OVERNIGHT,
    },
    process_all: {
      // ── Decomposed stages ─────────────────────────────────────────────────
      stages: {
        triage: {
          count: pending, cost_usd: r3(triageCost),
          model: 'haiku', notes: 'JD enrichment; Sonnet ($0.07/item) if Tier 5',
        },
        sort: {
          count: pending, cost_usd: 0,
          model: 'deterministic', notes: 'rule-based ordering & dedup — $0',
        },
        process: {
          count: batchEvalCount, cost_usd: r2(processCost),
          model: 'sonnet-batch',
          notes: Math.round(ADVANCE_RATE_ESTIMATE * 100) + '% advance rate assumed',
        },
        evaluate: {
          count: batchEvalCount, cost_usd: 0,
          model: 'sonnet-eval', notes: 'rubric + preflight gates — included in process cost',
        },
        publish: {
          count: publishCount, cost_usd: 0,
          model: 'deterministic',
          notes: 'only if score ≥ ' + THRESHOLD_FOR_PUBLISH + ' — triggers agent enrichment',
          threshold_conditional: true,
        },
      },
      // 2026-05-27 — agent_enrichment field RETAINED for backward compat but
      // ZEROED. The post_publish_opt_in block at top level is the source of
      // truth for per-pack agent costs going forward. Renderers should prefer
      // the top-level field; this stub keeps legacy code paths from crashing.
      agent_enrichment: {
        council:     { count: 0, cost_usd: 0, model: 'see post_publish_opt_in', notes: 'manual-only (post-publish)' },
        researcher:  { count: 0, cost_usd: 0, model: 'see post_publish_opt_in', notes: 'manual-only (post-publish)' },
        dealbreaker: { count: 0, cost_usd: 0, model: 'see post_publish_opt_in', notes: 'manual-only (post-publish)' },
        polish:      { count: 0, cost_usd: 0, model: 'see post_publish_opt_in', notes: 'manual-only (row drawer)' },
      },
      // ── δ DELTA Run-Batch 2026-05-19 — AI-detection (post-publish, opt-in) ──
      // Fires only when user clicks "Build pack" on a row drawer.
      // NOT invoked anywhere on the Process All / Run Batch publish path itself
      // per δ Run-Batch audit 2026-05-19; surfaced here so the budget is honest
      // about downstream spend the user will incur if they build packs.
      ai_detection: {
        packs: paDetectionPacks,
        cost_usd: r2(paDetectionCost),
        cost_per_pack_usd: r2(COST_PER_AI_DETECTION_PACK),
        vendors: 'GPTZero + Originality.ai',
        notes: 'post-publish · user-triggered "Build pack" · '
             + Math.round(PACK_BUILD_OPT_IN_RATE * 100) + '% opt-in assumed · '
             + AI_DETECTION_ARTIFACTS_PER_PACK + ' artifacts/pack × $'
             + COST_PER_AI_DETECTION_ARTIFACT.toFixed(2) + ' × '
             + AI_DETECTION_RETRY_MULTIPLIER + '× retry',
        threshold_conditional: true,
      },
      total_cost_usd:        r2(processAllCost),
      total_with_caps:       r2(Math.min(processAllCost, PER_RUN_CAP_PROCESS_ALL)),
      threshold_for_publish: THRESHOLD_FOR_PUBLISH,
      polish_enabled:        polishEnabled,
      exceeds_per_run_cap:   processAllCost > PER_RUN_CAP_PROCESS_ALL,
      exceeds_budget:        (spent30d + processAllCost) > effectiveBudget,
      // ── Legacy fields (backward compat) ──────────────────────────────────
      triage_count:          pending,
      triage_cost_usd:       r3(triageCost),
      batch_eval_count:      batchEvalCount,
      batch_eval_cost_usd:   r2(processCost),
      assumed_advance_rate:  ADVANCE_RATE_ESTIMATE,
      recommended_cap_usd:   Math.ceil((spent30d + processAllCost) * 1.1),
      tier5_estimate: {
        unique_companies:           tier5UniqueCompaniesEstimate,
        triage_enriched_cost_usd:   r2(tier5TriageEnrichedCost),
        company_council_cost_usd:   r2(tier5CompaniesCouncilCost),
        apply_pack_pregen_cost_usd: r2(tier5ApplyPackCost),
        total_cost_usd:             r2(tier5ProcessAllCost),
        assumed_cache_hit_rate:     COMPANY_CACHE_HIT_RATE,
        exceeds_per_run_cap:        tier5ProcessAllCost > PER_RUN_CAP_PROCESS_ALL,
      },
      // 2026-05-20 — Three-tier picker (lib/process-all-tiers.mjs). New
      // canonical field; tier5_estimate above is kept for backwards-compat
      // with the legacy dashboard Tier-5 button.
      tier_estimates: (() => {
        try {
          // Read current apply-now-queue size for the auto-escalate cost
          // estimate. Falls back to estimating from batchEvalCount × 0.15
          // if the queue file isn't readable.
          let applyNowSize = Math.round(batchEvalCount * 0.15);
          try {
            const apqPath = join(ROOT, 'data/apply-now-queue.json');
            if (existsSync(apqPath)) {
              const apq = JSON.parse(readFileSync(apqPath, 'utf-8'));
              applyNowSize = (apq.ranked || []).filter(r => !r._dropped && (r.eval_score || r.score || 0) >= 4.0).length;
            }
          } catch (_) { /* fall through */ }
          // 2026-05-20 — Use the tier estimator's own defaults (advance 12%,
          // pregen-eligible 5%, polish-eligible 1.5%) rather than passing
          // dashboard-server.mjs's ADVANCE_RATE_ESTIMATE=0.50 which was set
          // for the legacy non-tier breakdown and produces wildly-inflated
          // tier totals (~$1800 vs the realistic ~$250). Tier estimator is
          // the source of truth.
          return _tierCostEstimates({
            pipelineSize:  pending,
            applyNowSize,
          });
        } catch (_) { return null; }
      })(),
    },
    run_batch: {
      // ── Decomposed stages (no triage for run_batch) ───────────────────────
      stages: {
        process: {
          count: queued, cost_usd: r2(rbProcessCost),
          model: 'sonnet-batch', notes: 'queued items — parallel Anthropic batch API',
        },
        evaluate: {
          count: queued, cost_usd: 0,
          model: 'sonnet-eval', notes: 'rubric + preflight gates — included in process cost',
        },
        publish: {
          count: queuedPublishCount, cost_usd: 0,
          model: 'deterministic',
          notes: 'only if score ≥ ' + THRESHOLD_FOR_PUBLISH,
          threshold_conditional: true,
        },
      },
      // ── Agent enrichment ──────────────────────────────────────────────────
      agent_enrichment: {
        council: {
          count: rbCouncilCount, cost_usd: r2(rbCouncilCost),
          model: '4-LLM consensus', cache_hit_rate: COMPANY_CACHE_HIT_RATE,
          notes: 'company intel — per unique company',
        },
        researcher: {
          count: rbResearcherCount, cost_usd: r2(rbResearcherCost),
          model: 'opus + 4 LLMs',
          notes: 'HM + comp intel — uncached roles only',
        },
        dealbreaker: {
          count: rbResearcherCount, cost_usd: r2(rbDealBreakerCost),
          model: 'sonnet adjudicator',
          notes: 'runs when researcher runs',
        },
      },
      // ── δ DELTA Run-Batch 2026-05-19 — AI-detection (post-publish, opt-in) ──
      ai_detection: {
        packs: rbDetectionPacks,
        cost_usd: r2(rbDetectionCost),
        cost_per_pack_usd: r2(COST_PER_AI_DETECTION_PACK),
        vendors: 'GPTZero + Originality.ai',
        notes: 'post-publish · user-triggered "Build pack" · '
             + Math.round(PACK_BUILD_OPT_IN_RATE * 100) + '% opt-in assumed · '
             + AI_DETECTION_ARTIFACTS_PER_PACK + ' artifacts/pack × $'
             + COST_PER_AI_DETECTION_ARTIFACT.toFixed(2) + ' × '
             + AI_DETECTION_RETRY_MULTIPLIER + '× retry',
        threshold_conditional: true,
      },
      total_cost_usd:        r2(runBatchCost),
      threshold_for_publish: THRESHOLD_FOR_PUBLISH,
      exceeds_budget:        (spent30d + runBatchCost) > effectiveBudget,
      exceeds_per_run_cap:   runBatchCost > PER_RUN_CAP_RUN_BATCH,
      // ── Legacy fields (backward compat) ──────────────────────────────────
      eval_count:            queued,
      tier5_estimate: {
        unique_companies:    tier5RunBatchUniqueCompanies,
        total_cost_usd:      r2(tier5RunBatchCost),
        exceeds_per_run_cap: tier5RunBatchCost > PER_RUN_CAP_RUN_BATCH,
      },
    },
    per_item_rates: {
      triage_haiku:          COST_PER_TRIAGE_HAIKU,
      triage_sonnet_jd:      COST_PER_TRIAGE_SONNET_JD,
      batch_sonnet:          COST_PER_BATCH_EVAL,
      company_council:       COST_PER_COMPANY_COUNCIL,
      researcher_per_role:   COST_PER_RESEARCHER_CALL,
      dealbreaker_per_run:   COST_PER_DEALBREAKER_CALL,
      apply_pack_pregen:     COST_PER_APPLY_PACK_PREGEN,
      // δ DELTA Run-Batch 2026-05-19 — detection economics
      ai_detection_per_artifact: COST_PER_AI_DETECTION_ARTIFACT,
      ai_detection_per_pack:     COST_PER_AI_DETECTION_PACK,
      ai_detection_artifacts_per_pack: AI_DETECTION_ARTIFACTS_PER_PACK,
      ai_detection_retry_multiplier:   AI_DETECTION_RETRY_MULTIPLIER,
      pack_build_opt_in_rate:    PACK_BUILD_OPT_IN_RATE,
      source:                'data/cost-log.tsv observed average + calibration brief 2026-05-16; ai_detection_* per lib/ai-detection-gate.mjs:36-38 (GPTZero $0.01 + Originality $0.01)',
    },
    // γ GAMMA 2026-05-19 — provenance metadata for every estimate constant.
    // Rendered in the cost-decomp modal as "calibrated from N runs · confidence ±X%"
    // so a numeric value never appears without a citation + confidence band.
    calibration_provenance: COST_CALIBRATION_PROVENANCE,
    // 2026-05-27 — most-recent completed Process All delta. Powers the
    // "Last run drained N from pipeline (X → Y)" chip in the modal so the
    // queue counters show visible fluctuation across runs.
    last_run_delta: _computeLastRunDelta(),
    // 2026-05-27 — Per-pack agent enrichment costs (council / researcher /
    // dealbreaker / polish / pregen / detection). Each fires ONLY when the
    // user clicks Build Pack or Polish on a row — NOT during Process All or
    // Run Batch. Renderers should treat this as informational ("here's what
    // you'd pay PER PACK if you build one"), not as part of the Process All
    // total. Costs shown are PER-INVOCATION; the modal's "Post-publish opt-in"
    // section multiplies them by expected pack-build count for context.
    post_publish_opt_in: {
      label: 'Post-publish opt-in (per pack, when you click Build Pack / Polish)',
      runs_when: 'User-initiated only — never during Process All or Run Batch.',
      council:     { per_invocation_usd: COST_PER_COMPANY_COUNCIL,     model: '4-LLM consensus',     notes: 'Company intel — fires when pack build hits an uncached company.' },
      researcher:  { per_invocation_usd: COST_PER_RESEARCHER_CALL,     model: 'opus + 4 LLMs',       notes: 'HM + comp intel — fires when pack build hits an uncached role.' },
      dealbreaker: { per_invocation_usd: COST_PER_DEALBREAKER_CALL,    model: 'sonnet adjudicator',  notes: 'Adjudicates researcher output — runs when researcher runs.' },
      pregen:      { per_invocation_usd: COST_PER_APPLY_PACK_PREGEN,   model: 'cv-tailor + agents',  notes: 'Apply-pack scaffolding (cv-tailored / cover-letter / form-fields / etc.).' },
      polish:      { per_invocation_usd: COST_PER_POLISH_PACK_USD,     per_pack_cap_usd: POLISH_PER_PACK_COST_CAP_USD, model: 'Haiku×3 + Sonnet + Opus + adversarial', notes: 'Per-artifact polish loop to ≥0.99 confidence. Manual-trigger via row-drawer Polish button or POST /api/polish.' },
      ai_detection:{ per_invocation_usd: COST_PER_AI_DETECTION_PACK,   model: 'GPTZero + Originality + Pangram', notes: 'Multi-detector ensemble run on each generated artifact.' },
      per_pack_max_usd: r2(postPublishPerRowMaxUsd),
    },
  };
}

function loadPipelineProcessState() {
  const fp = join(ROOT, 'data/pipeline-process-state.json');
  if (!existsSync(fp)) return { jobs: {} };
  try { return JSON.parse(readFileSync(fp, 'utf-8')); }
  catch { return { jobs: {} }; }
}

// 2026-05-27 — Live phase progress reader. Reads the job's log file and
// counts per-URL events (triage: `→ ADVANCE|SKIP|DEAD`; batch: `\d+/\d+
// complete`) so the toast + sidebar can show "X / Y · ETA Zm" instead of a
// static phase label that doesn't tick. Pure read — no state mutation, safe
// to call on every poll/SSE tick without coordinating with the running
// orchestrator. Returns null when no log file or no parsable progress.
// AGENTS.md bug-class: long-phase-no-liveness-signal-looks-like-stall.
// 2026-05-27 — Full-run ETA helper. Sums remaining-time estimates across all
// 4 Process All phases: triage (from live rate) + batch (item-count × per-row
// estimate) + merge (~30s) + rebuild (~30s) + email (~10s). Returns
// {total_seconds, total_label, phases[]} where phases is rendered as a hover
// tooltip breakdown. Returns null when no live_progress is available.
function _computeFullRunETA(job, livePhaseProgress) {
  if (!job || !job.phase) return null;
  const phase = job.phase;
  // Per-phase estimates. Tunable via env if needed.
  const BATCH_ESTIMATE_SECONDS_PER_ITEM = 3;   // ~3s/item (Anthropic batch processing rate)
  const BATCH_MIN_SECONDS = 300;                // 5 min minimum
  const MERGE_ESTIMATE_SECONDS = 30;
  const REBUILD_ESTIMATE_SECONDS = 30;
  const EMAIL_ESTIMATE_SECONDS = 10;
  // Default 12% advance rate (matches dashboard-server.mjs ADVANCE_RATE_ESTIMATE constant)
  const DEFAULT_ADVANCE_RATE = 0.12;
  const phases = [];

  // ── Triage ──────────────────────────────────────────────────────────────
  let triageRemaining = 0;
  let triageProcessedSoFar = 0;
  let pipelineSizeBefore = job.pending_before || job.triage_pipeline_before || 0;
  if (livePhaseProgress && livePhaseProgress.phase === 'triage' && livePhaseProgress.processed != null && livePhaseProgress.total) {
    triageProcessedSoFar = livePhaseProgress.processed;
    triageRemaining = livePhaseProgress.eta_seconds || 0;
  } else if (phase === 'triage' && pipelineSizeBefore > 0) {
    // Triage active but no rate yet — fallback to 1.4s/url conservative.
    triageRemaining = pipelineSizeBefore * 1.4;
  }
  // If we're PAST triage, remaining = 0 (we know what advanced)
  const phaseOrder = ['triage', 'batch', 'merge', 'rebuild', 'email', 'done'];
  const phaseIdx = phaseOrder.indexOf(phase);
  phases.push({
    name: 'triage',
    est_seconds: Math.max(0, Math.round(triageRemaining)),
    est_label: _fmtEtaLabel(triageRemaining),
    active: phase === 'triage',
    done: phaseIdx > phaseOrder.indexOf('triage'),
  });

  // ── Batch ───────────────────────────────────────────────────────────────
  // Estimate batch_eval_count: confirmed advances + expected advances in remaining triage
  let batchItemEstimate = 0;
  if (phase === 'batch' && livePhaseProgress?.total) {
    // We're IN batch — use the total batch size from live_progress (anthropic batch API count)
    const batchDone = livePhaseProgress.processed || 0;
    const batchTotal = livePhaseProgress.total;
    const batchRemaining = Math.max(0, batchTotal - batchDone);
    batchItemEstimate = batchRemaining;
  } else if (phase === 'triage') {
    // Predict batch size from current advance rate + remaining triage URLs
    const lp = livePhaseProgress;
    const advancesSoFar = lp?.advance_count || job.triage_advanced || 0;
    const remainingTriageUrls = lp?.total ? Math.max(0, lp.total - lp.processed) : 0;
    const observedAdvanceRate = (lp?.processed && lp.processed > 10)
      ? (advancesSoFar / lp.processed)
      : DEFAULT_ADVANCE_RATE;
    const additionalAdvances = Math.round(remainingTriageUrls * observedAdvanceRate);
    batchItemEstimate = advancesSoFar + additionalAdvances;
  }
  // Items already triaged + sent to batch (from prior runs) live in triage-advance.tsv;
  // adds those to batch estimate to account for accumulated queue. Read once.
  try {
    const taFp = join(ROOT, 'batch/triage-advance.tsv');
    if (existsSync(taFp)) {
      const queued = readFileSync(taFp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('url\t')).length;
      batchItemEstimate += queued;
    }
  } catch (_) {}
  const batchEst = Math.max(BATCH_MIN_SECONDS, batchItemEstimate * BATCH_ESTIMATE_SECONDS_PER_ITEM);
  phases.push({
    name: 'batch',
    est_seconds: phaseIdx > phaseOrder.indexOf('batch') ? 0 : Math.round(batchEst),
    est_label: phaseIdx > phaseOrder.indexOf('batch') ? '0s' : _fmtEtaLabel(batchEst),
    active: phase === 'batch',
    done: phaseIdx > phaseOrder.indexOf('batch'),
    item_estimate: batchItemEstimate,
  });

  // ── Merge / Rebuild / Email ─────────────────────────────────────────────
  for (const [name, est] of [['merge', MERGE_ESTIMATE_SECONDS], ['rebuild', REBUILD_ESTIMATE_SECONDS], ['email', EMAIL_ESTIMATE_SECONDS]]) {
    phases.push({
      name,
      est_seconds: phaseIdx > phaseOrder.indexOf(name) ? 0 : est,
      est_label: phaseIdx > phaseOrder.indexOf(name) ? '0s' : _fmtEtaLabel(est),
      active: phase === name,
      done: phaseIdx > phaseOrder.indexOf(name),
    });
  }

  const totalSeconds = phases.reduce((s, p) => s + (p.est_seconds || 0), 0);
  return {
    total_seconds: totalSeconds,
    total_label: _fmtEtaLabel(totalSeconds),
    phases,
  };
}

// 2026-05-27 — Format a duration (in seconds) as a compact label.
function _fmtEtaLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.round(seconds);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h + 'h ' + m + 'm';
}

// 2026-05-27 — Current batch progress for the "Last batch" chip auto-switch
// (per Q2). When the active Process All job is in batch phase, the
// _computeLivePhaseProgress returns batch-specific counts; surface them as
// a separate current_batch object so the legacy "Last batch" chip can
// auto-switch to live data.
function _computeCurrentBatchProgress(job, livePhaseProgress) {
  if (!job || job.phase !== 'batch') return null;
  if (!livePhaseProgress || livePhaseProgress.phase !== 'batch') return null;
  if (livePhaseProgress.processed == null || !livePhaseProgress.total) return null;
  return {
    completed: livePhaseProgress.processed,
    total: livePhaseProgress.total,
    elapsed_seconds: livePhaseProgress.phase_elapsed_sec || null,
    elapsed_label: livePhaseProgress.phase_elapsed_sec ? _fmtEtaLabel(livePhaseProgress.phase_elapsed_sec) : null,
    pct: livePhaseProgress.pct,
  };
}

// 2026-05-27 — Live counts that downstream widgets (Total Eval tile, Tracker
// chip, Pipeline Pending tile) can read from SSE without rebuilding the
// dashboard. All read fresh from disk on every tick — cheap (small files).
// new_publishes_since_run_start: rows in applications.md whose date >= job.started_at
// AND status ∈ {Evaluated, Applied, Responded, Interview, Offer} — these are
// the candidates that landed during the current Process All run.
function _computeLiveCounts(activeJob) {
  const counts = {
    applications_total: null,
    evaluations_total: null,
    applied_count: null,
    pipeline_pending: null,
    new_publishes_since_run_start: 0,
  };

  // applications.md row count + status breakdown
  try {
    const appsFp = join(ROOT, 'data/applications.md');
    if (existsSync(appsFp)) {
      const text = readFileSync(appsFp, 'utf-8');
      // Row format: | num | YYYY-MM-DD | Company | Role | score/5 | Status | ... |
      const rows = text.split('\n').filter(l => /^\|\s+\d+\s+\|/.test(l));
      counts.applications_total = rows.length;
      counts.evaluations_total = rows.length;
      let applied = 0;
      let newSinceRun = 0;
      const runStartedMs = activeJob?.started_at ? Date.parse(activeJob.started_at) : 0;
      for (const row of rows) {
        const cols = row.split('|').map(c => c.trim()).filter(Boolean);
        // cols: [num, date, company, role, score, status, ...]
        const date = cols[1];
        const status = cols[5] || '';
        if (/Applied|Responded|Interview|Offer/i.test(status)) applied++;
        // Count rows whose date >= run start (rough; applications.md dates are YYYY-MM-DD only)
        if (runStartedMs && date && /^\d{4}-\d{2}-\d{2}/.test(date)) {
          const rowMs = Date.parse(date) || 0;
          if (rowMs >= runStartedMs - 24 * 60 * 60 * 1000) newSinceRun++;
        }
      }
      counts.applied_count = applied;
      counts.new_publishes_since_run_start = newSinceRun;
    }
  } catch (_) {}

  // pipeline.md pending count
  try {
    const pipeFp = join(ROOT, 'data/pipeline.md');
    if (existsSync(pipeFp)) {
      counts.pipeline_pending = readFileSync(pipeFp, 'utf-8')
        .split('\n')
        .filter(l => l.startsWith('- [ ]'))
        .length;
    }
  } catch (_) {}

  // batch/triage-advance.tsv queued count — drives the sidebar Run Batch chip
  // (#pipeline-btn-batch-count) + Process All chip (#pipeline-btn-all-count =
  // pipeline_pending + triage_advance_count). Wired into _updateLiveCounts on
  // 2026-05-27 so the sidebar reflects state changes within the SSE tick
  // instead of waiting for a full dashboard rebuild.
  try {
    counts.triage_advance_count = countTriageAdvanceQueued();
  } catch (_) { counts.triage_advance_count = null; }

  return counts;
}

function _computeLivePhaseProgress(job) {
  if (!job || !job.log_path || !existsSync(job.log_path)) return null;
  const phase = job.phase || 'unknown';
  const phaseStartedAt = Date.parse(job.phase_started_at || job.started_at || '') || 0;
  const now = Date.now();
  const phaseElapsedSec = phaseStartedAt ? Math.max(1, Math.round((now - phaseStartedAt) / 1000)) : null;

  let raw;
  try { raw = readFileSync(job.log_path, 'utf-8'); } catch { return null; }
  if (!raw) return null;

  // Phase-specific parsers. Each returns { processed, total, current_target?, last_event_excerpt }
  // or null if the phase isn't currently producing per-URL events.
  let phaseProgress = null;

  if (phase === 'triage') {
    // triage.mjs emits `→ ADVANCE` / `→ SKIP` / `→ DEAD` once per URL.
    const advance = (raw.match(/→ ADVANCE/g) || []).length;
    const skip    = (raw.match(/→ SKIP/g) || []).length;
    const dead    = (raw.match(/→ DEAD/g) || []).length;
    const processed = advance + skip + dead;
    const total = job.pending_before || job.triage_pipeline_before || null;
    // Find the last `[T1|T2|T3] https://...` line for currently-processing context.
    const tMatches = raw.match(/\[T\d\] https?:\/\/[^\s…]+…?/g);
    const last_target = tMatches && tMatches.length ? tMatches[tMatches.length - 1] : null;
    phaseProgress = {
      phase: 'triage',
      processed,
      total,
      advance_count: advance,
      skip_count: skip,
      dead_count: dead,
      current_target: last_target,
    };
  } else if (phase === 'batch') {
    // batch-runner-batches.mjs polling output: `\d+/\d+ complete` (CR-overwritten).
    // Take the most recent line with that pattern.
    const lines = raw.split(/[\r\n]+/);
    let lastCompleteLine = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/\d+\/\d+\s+complete/i.test(lines[i])) { lastCompleteLine = lines[i]; break; }
    }
    if (lastCompleteLine) {
      const m = lastCompleteLine.match(/(\d+)\/(\d+)\s+complete/i);
      if (m) {
        phaseProgress = {
          phase: 'batch',
          processed: parseInt(m[1], 10),
          total: parseInt(m[2], 10),
          current_target: lastCompleteLine.trim().slice(0, 120),
        };
      }
    }
  } else if (phase === 'polish' || phase === 'pregen') {
    // Post-2026-05-27 these phases are removed from Process All. Kept here so a
    // legacy-pre-PR run's log still parses cleanly.
    phaseProgress = { phase, processed: null, total: null, current_target: null };
  }

  if (!phaseProgress || phaseProgress.processed == null || phaseProgress.total == null || phaseProgress.total <= 0) {
    return {
      phase,
      processed: null,
      total: null,
      rate_per_min: null,
      eta_seconds: null,
      eta_label: null,
      phase_elapsed_sec: phaseElapsedSec,
      current_target: phaseProgress?.current_target || null,
    };
  }

  const { processed, total } = phaseProgress;
  const ratePerSec = phaseElapsedSec ? (processed / phaseElapsedSec) : 0;
  const ratePerMin = ratePerSec * 60;
  const remaining = Math.max(0, total - processed);
  const etaSeconds = ratePerSec > 0 ? Math.round(remaining / ratePerSec) : null;
  let etaLabel = null;
  if (etaSeconds != null) {
    if (etaSeconds < 60)         etaLabel = etaSeconds + 's';
    else if (etaSeconds < 3600)  etaLabel = Math.round(etaSeconds / 60) + 'm';
    else                          etaLabel = Math.floor(etaSeconds / 3600) + 'h ' + Math.round((etaSeconds % 3600) / 60) + 'm';
  }
  return {
    phase,
    processed,
    total,
    rate_per_min: Math.round(ratePerMin * 10) / 10,
    eta_seconds: etaSeconds,
    eta_label: etaLabel,
    phase_elapsed_sec: phaseElapsedSec,
    current_target: phaseProgress.current_target,
    pct: Math.round((processed / total) * 100),
    advance_count: phaseProgress.advance_count,
    skip_count: phaseProgress.skip_count,
    dead_count: phaseProgress.dead_count,
  };
}

// ── Per-company preview for the Process All 2-phase modal ─────────
// Surfaces the per-company table the user inspects BEFORE confirming
// the orchestrator run. Each row carries enough signal for triage:
// score, TTO weeks, toxicity verdict, cache-hit, cost estimate.
// Reads:
//   - data/apply-now-queue.json (canonical Apply-Now ranking)
//   - data/company-intel-cache/{slug}/intel-*.json (cache-hit detection)
//   - data/excluded-companies.json (auto-trash list)
// Uses estimateTTO()/scoreToxicity() libs for the per-row metrics.
// Cost estimate per company uses the same Tier 5 economics as
// buildPipelinePreview() so the per-row totals reconcile.
function _slugifyCompanyForIntel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadExcludedCompanySlugs() {
  try {
    const fp = join(ROOT, 'data/excluded-companies.json');
    if (!existsSync(fp)) return new Set();
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    const slugs = new Set();
    for (const cat of Object.values(data?.categories || {})) {
      for (const c of (cat.companies || [])) slugs.add(_slugifyCompanyForIntel(c));
      for (const [primary, aliases] of Object.entries(cat.aliases || {})) {
        slugs.add(_slugifyCompanyForIntel(primary));
        for (const a of (aliases || [])) slugs.add(_slugifyCompanyForIntel(a));
      }
    }
    return slugs;
  } catch {
    return new Set();
  }
}

function loadApplyNowQueueRanked() {
  try {
    const fp = join(ROOT, 'data/apply-now-queue.json');
    if (!existsSync(fp)) return [];
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(data?.ranked) ? data.ranked : [];
  } catch {
    return [];
  }
}

function loadCompanyIntelCacheState(slug) {
  // Cache is considered a "hit" if a non-empty intel-YYYY-MM-DD.json
  // file exists in data/company-intel-cache/{slug}/ within the 30d TTL
  // window the orchestrator uses (matches scripts/process-all-council-intel.mjs).
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  try {
    const dir = join(ROOT, 'data/company-intel-cache', slug);
    if (!existsSync(dir)) return { hit: false, last_intel_date: null, age_days: null };
    const files = readdirSync(dir).filter(f => /^intel-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (!files.length) return { hit: false, last_intel_date: null, age_days: null };
    files.sort();
    const latest = files[files.length - 1];
    const m = latest.match(/intel-(\d{4}-\d{2}-\d{2})\.json$/);
    const date = m ? m[1] : null;
    const age = date ? Math.floor((Date.now() - Date.parse(date + 'T00:00:00Z')) / 86_400_000) : null;
    const fresh = age != null && age * 86_400_000 < TTL_MS;
    return { hit: fresh, last_intel_date: date, age_days: age };
  } catch {
    return { hit: false, last_intel_date: null, age_days: null };
  }
}

// 2026-05-19 (Mitchell feedback — cohesion fix #3): pipeline.md unchecked
// items are written as "- [ ] URL | Company | Role | Date". Extract company
// from the third pipe-separated field; fall back to URL guessing when the
// row is just "(from email)" or similar placeholder.
function _loadPipelineMdRows() {
  const fp = join(ROOT, 'data/pipeline.md');
  if (!existsSync(fp)) return [];
  const out = [];
  for (const line of readFileSync(fp, 'utf-8').split('\n')) {
    if (!line.startsWith('- [ ]')) continue;
    const body = line.slice(5).trim();
    const parts = body.split('|').map(s => s.trim());
    const url = parts[0] || '';
    let company = parts[1] || '';
    if (!company || company === '(from email)' || company === 'view') {
      try { company = _guessCompanyFromUrl(url) || 'Unknown'; }
      catch { company = 'Unknown'; }
    }
    const role = parts[2] || null;
    out.push({ url, company, role });
  }
  return out;
}

// triage-advance.tsv columns: url\ttier\tscore\tarchetype\treason. No company
// column — extract via ats-utils.guessCompany() the same way triage.mjs does.
function _loadTriageAdvanceRows() {
  const fp = join(ROOT, 'batch/triage-advance.tsv');
  if (!existsSync(fp)) return [];
  const out = [];
  const lines = readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
  // Skip header row (starts with "url\t")
  const startIdx = (lines[0] && lines[0].startsWith('url\t')) ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const url = cols[0];
    const score = parseFloat(cols[2]);
    const archetype = cols[3] || null;
    if (!url) continue;
    let company = 'Unknown';
    try { company = _guessCompanyFromUrl(url) || 'Unknown'; } catch {}
    out.push({ url, company, score: Number.isFinite(score) ? score : null, archetype });
  }
  return out;
}

function buildPerCompanyPipelinePreview() {
  // Group ALL pipeline items by unique company → one row per company across
  // three stages so the modal's company list reconciles with the 187-item
  // headline (Mitchell cohesion feedback 2026-05-19):
  //
  //   stage = 'evaluated' → already in apply-now-queue.json with eval_score
  //                         (the historical 10-company subset)
  //   stage = 'queued'    → in batch/triage-advance.tsv (waiting for batch eval)
  //   stage = 'pending'   → in data/pipeline.md `- [ ]` (waiting for triage)
  //
  // Companies appearing in multiple stages are merged (evaluated wins for
  // top_role_score; role_count aggregates across all sources).
  const ranked = loadApplyNowQueueRanked();
  const excluded = loadExcludedCompanySlugs();
  const byCompany = new Map();

  function upsert(slug, patch) {
    const prior = byCompany.get(slug);
    if (!prior) { byCompany.set(slug, patch); return; }
    // Merge: prefer existing stage if higher priority (evaluated > queued > pending)
    const stageRank = { evaluated: 3, queued: 2, pending: 1 };
    if ((stageRank[patch.stage] || 0) > (stageRank[prior.stage] || 0)) {
      prior.stage = patch.stage;
    }
    prior.role_count += patch.role_count || 1;
    if (patch.top_role_score != null && (prior.top_role_score == null || patch.top_role_score > prior.top_role_score)) {
      prior.top_role = patch.top_role || prior.top_role;
      prior.top_role_num = patch.top_role_num || prior.top_role_num;
      prior.top_role_score = patch.top_role_score;
    }
    if (!prior.top_role && patch.top_role) prior.top_role = patch.top_role;
  }

  // Stage 1: evaluated (apply-now-queue.json)
  for (const r of ranked) {
    if (!r?.company) continue;
    const slug = _slugifyCompanyForIntel(r.company);
    if (!slug) continue;
    const score = (typeof r.eval_score === 'number') ? r.eval_score : null;
    upsert(slug, {
      slug,
      company: r.company,
      top_role: r.role || null,
      top_role_num: r.num || null,
      top_role_score: score,
      role_count: 1,
      stage: 'evaluated',
    });
  }

  // Stage 2: queued for batch (batch/triage-advance.tsv)
  for (const r of _loadTriageAdvanceRows()) {
    if (!r.company || r.company === 'Unknown') continue;
    const slug = _slugifyCompanyForIntel(r.company);
    if (!slug) continue;
    upsert(slug, {
      slug,
      company: r.company,
      top_role: null,
      top_role_num: null,
      top_role_score: null,
      role_count: 1,
      stage: 'queued',
    });
  }

  // Stage 3: pending triage (pipeline.md `- [ ]`)
  for (const r of _loadPipelineMdRows()) {
    if (!r.company || r.company === 'Unknown') continue;
    const slug = _slugifyCompanyForIntel(r.company);
    if (!slug) continue;
    upsert(slug, {
      slug,
      company: r.company,
      top_role: r.role || null,
      top_role_num: null,
      top_role_score: null,
      role_count: 1,
      stage: 'pending',
    });
  }

  // Per-row enrichment: TTO + toxicity + cache state + cost estimate.
  // Each Tier-5 unique-company cost = council intel × (1 - cache_hit) +
  // (highscore-pack pre-gen if score ≥ 4.5).
  //
  // Bug fix 2026-05-17: toxicity was previously sourced from scoreToxicity(name)
  // which reads data/toxicity-signals/{slug}.json (almost always empty in
  // steady state). Real toxicity verdicts live in the cached intel files at
  // data/company-intel-cache/{slug}/intel-{date}.json under .toxicity_score
  // (populated by scripts/process-all-council-intel.mjs). New strategy: read
  // from cache first, fall back to scoreToxicity() only if no cache.
  //
  // ζ Run-Batch addition 2026-05-19: per-company network-leverage signal
  // for tier decisions. Returns { warm, fresh, stale, first_degree, source }
  // so a Phase B reader can decide "boost this company because there's a
  // warm intro path". Source is `network-graph.json` or `network-database.json`
  // — surfaced so the consumer can disclose freshness.
  const rows = [];
  for (const meta of byCompany.values()) {
    const ttoRaw = (() => { try { return estimateTTO(meta.company); } catch { return null; } })();
    const cache  = loadCompanyIntelCacheState(meta.slug);
    let tox = null;
    if (cache.hit && cache.last_intel_date) {
      try {
        const intelFp = join(ROOT, 'data/company-intel-cache', meta.slug, `intel-${cache.last_intel_date}.json`);
        if (existsSync(intelFp)) {
          const cached = JSON.parse(readFileSync(intelFp, 'utf-8'));
          tox = cached?.toxicity_score || null;
        }
      } catch { /* fall through to empty-signals score */ }
    }
    if (!tox) {
      tox = (() => { try { return scoreToxicity(meta.company); } catch { return null; } })();
    }
    const isExcluded = excluded.has(meta.slug);

    // ζ Run-Batch — fan out to the network lookup, count fresh-vs-stale.
    // findContactsAtCompany() reads from the unified network graph/db with
    // _stale_warmth flag set when connected_on > 18mo with no engagement.
    let netLev = { warm: 0, fresh: 0, stale: 0, first_degree: 0, source: 'none' };
    try {
      const contacts = networkFindContactsAtCompany(meta.slug) || [];
      const fresh = contacts.filter(c => !c._stale_warmth).length;
      const stale = contacts.length - fresh;
      const firstDegree = contacts.filter(c => !c._warm_via_target_name).length;
      netLev = {
        warm:         contacts.length,
        fresh,
        stale,
        first_degree: firstDegree,
        source:       contacts.length > 0 ? 'network-database.json' : 'none',
      };
    } catch { /* network signal optional — leave defaults */ }

    // Cost: zero if excluded (orchestrator auto-trashes), else council cost
    // (skipped on cache hit) + optional apply-pack pre-gen for high-score rows.
    let cost = 0;
    if (!isExcluded) {
      if (!cache.hit) cost += COST_PER_COMPANY_COUNCIL;
      if (meta.top_role_score != null && meta.top_role_score >= 4.5) cost += COST_PER_APPLY_PACK_PREGEN;
    }

    // Per OMEGA-proposal-2 (approved 2026-05-19): expose per-row AI-detection
    // potential cost as a SEPARATE field, NOT folded into cost_estimate_usd.
    // Rationale: cost_estimate_usd is "would-spend-now-during-Process-All".
    // Detection is "would-spend-LATER-if-user-clicks-Build-pack". Mixing them
    // misleads the confirm-modal hero. Surfaced as a sub-line on the hero so
    // the user sees both: "$15.00 + $0.60 detection (if 40% opt in)".
    const aiDetectionPotential = isExcluded
      ? 0
      : COST_PER_AI_DETECTION_PACK * PACK_BUILD_OPT_IN_RATE;

    rows.push({
      slug:             meta.slug,
      company:          meta.company,
      top_role:         meta.top_role,
      top_role_num:     meta.top_role_num,
      top_role_score:   meta.top_role_score,
      role_count:       meta.role_count,
      stage:            meta.stage || 'evaluated',
      tto_weeks:        ttoRaw?.weeks_estimate ?? null,
      tto_tier:         ttoRaw?.velocity_tier  ?? null,
      tto_confidence:   ttoRaw?.confidence     ?? null,
      toxicity_verdict: tox?.verdict           ?? null,
      toxicity_score:   tox?.score             ?? null,
      toxicity_emoji:   tox?.verdict_emoji     ?? null,
      // ζ Run-Batch network-leverage decomposition (honest fresh-vs-stale)
      network_warm_count:   netLev.warm,
      network_fresh_count:  netLev.fresh,
      network_stale_count:  netLev.stale,
      network_first_degree: netLev.first_degree,
      network_source:       netLev.source,
      cache_hit:        cache.hit,
      last_intel_date:  cache.last_intel_date,
      cache_age_days:   cache.age_days,
      excluded:         isExcluded,
      cost_estimate_usd: Math.round(cost * 100) / 100,
      ai_detection_potential_usd: Math.round(aiDetectionPotential * 100) / 100,
    });
  }

  // Sort: stage rank (evaluated > queued > pending), then score within stage,
  // then alphabetical. Excluded rows sink to the bottom regardless of stage.
  const stageRank = { evaluated: 3, queued: 2, pending: 1 };
  rows.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    const sA = stageRank[a.stage] || 0;
    const sB = stageRank[b.stage] || 0;
    if (sA !== sB) return sB - sA;
    const aS = a.top_role_score ?? -1;
    const bS = b.top_role_score ?? -1;
    if (aS !== bS) return bS - aS;
    return (a.company || '').localeCompare(b.company || '');
  });

  const totalCost = rows.reduce((s, r) => s + (r.cost_estimate_usd || 0), 0);
  const totalDetectionPotential = rows.reduce((s, r) => s + (r.ai_detection_potential_usd || 0), 0);
  // Stage counts so the UI can render group headers + sticky totals.
  const stageCounts = {
    evaluated: rows.filter(r => r.stage === 'evaluated').length,
    queued:    rows.filter(r => r.stage === 'queued').length,
    pending:   rows.filter(r => r.stage === 'pending').length,
  };
  return {
    companies:           rows,
    total_companies:     rows.length,
    actionable_count:    rows.filter(r => !r.excluded).length,
    excluded_count:      rows.filter(r =>  r.excluded).length,
    cache_hit_count:     rows.filter(r => r.cache_hit && !r.excluded).length,
    stage_counts:        stageCounts,
    total_cost_estimate_usd: Math.round(totalCost * 100) / 100,
    // Per OMEGA-proposal-2 (approved 2026-05-19): aggregate detection potential
    // + constants so the Phase A/B JS can compute scoped detection live.
    total_ai_detection_potential_usd: Math.round(totalDetectionPotential * 100) / 100,
    ai_detection_per_pack_usd: Math.round(COST_PER_AI_DETECTION_PACK * 100) / 100,
    pack_build_opt_in_rate: PACK_BUILD_OPT_IN_RATE,
    source:              'data/apply-now-queue.json + data/pipeline.md + batch/triage-advance.tsv + data/company-intel-cache/ + estimateTTO + scoreToxicity + data/network-database.json',
    schema_note:         'Per-company Tier-5 economics — council cost suppressed on cache hit; apply-pack pre-gen added for score≥4.5. ζ Run-Batch 2026-05-19 added network_{warm,fresh,stale,first_degree,source}_count with honest >18mo stale-warmth gate. OMEGA-proposal-2 2026-05-19 added ai_detection_potential_usd (post-publish, opt-in-gated) per row. Mitchell cohesion fix 2026-05-19 #3 added stage (evaluated/queued/pending) so the per-company table covers ALL 187 pipeline items, not just the apply-now subset.',
  };
}

function spawnProcessAll({ sendEmail, force, companies, tier }) {
  // Cap enforcement (calibration 2026-05-16): refuse to spawn if per-run cap
  // or monthly budget exceeded. `force: true` overrides — for the user-explicit
  // "I know what I'm doing, fire it anyway" path.
  //
  // 2026-05-26 — tier-id aware. The 3-tier modal (lib/process-all-tiers.mjs)
  // sends tier='1'|'2'|'3'. resolveTier() handles those + legacy 'normal'|'5'.
  // Each non-Tier-1 run reads its own cost estimate from preview.process_all
  // .tier_estimates[N] (which lib/process-all-tiers.mjs:tierCostEstimates produces).
  const tierObj   = _resolveTier(tier);
  const tierId    = tierObj.id;
  const tierLabel = `Tier ${tierId} · ${tierObj.name}`;
  // 2026-05-26 — compute cost UNCONDITIONALLY (out of the !force branch) so the
  // audit log below can record it on every spawn, not just non-forced ones.
  const preview = buildPipelinePreview();
  const tierEstimates = preview.process_all.tier_estimates;
  const costForCap = (tierEstimates && tierEstimates[tierId] && tierEstimates[tierId].total_cost_usd != null)
    ? tierEstimates[tierId].total_cost_usd
    : preview.process_all.total_cost_usd;
  if (!force) {
    if (costForCap > PER_RUN_CAP_PROCESS_ALL) {
      return {
        ok: false,
        error: `Process All (${tierLabel}) estimate $${costForCap.toFixed(2)} exceeds per-run cap $${PER_RUN_CAP_PROCESS_ALL}. Pass force:true to override, or raise PER_RUN_CAP_PROCESS_ALL_USD env.`,
        cap_exceeded: 'per_run',
        estimated_cost_usd: costForCap,
        cap_usd: PER_RUN_CAP_PROCESS_ALL,
        tier: String(tierId),
        tier_name: tierObj.name,
      };
    }
    if (preview.spent_30d_usd + costForCap > preview.effective_budget_usd) {
      return {
        ok: false,
        error: `Process All (${tierLabel}) would push 30d spend ($${preview.spent_30d_usd.toFixed(2)} + $${costForCap.toFixed(2)}) past effective monthly budget $${preview.effective_budget_usd}. Activate burst mode (MONTHLY_BUDGET_USD_BURST + MONTHLY_BUDGET_BURST_UNTIL) or pass force:true.`,
        cap_exceeded: 'monthly',
        estimated_cost_usd: costForCap,
        spent_30d_usd: preview.spent_30d_usd,
        effective_budget_usd: preview.effective_budget_usd,
        tier: String(tierId),
        tier_name: tierObj.name,
      };
    }
  }

  // Generate the job ID server-side so we can return it immediately to the UI
  const jobId = 'proc-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
  const logPath = `/tmp/process-all-${jobId}.log`;
  const args = [join(ROOT, 'scripts/process-all-pipeline.mjs'), `--job-id=${jobId}`];
  if (sendEmail) args.push('--send-email');
  if (force) args.push('--cap-override');
  // Always pass --tier=N explicitly so the orchestrator routes the correct
  // triage + eval models. Tier-1 is the orchestrator's default but being
  // explicit removes ambiguity and shows up in process listings.
  args.push(`--tier=${tierId}`);
  // Optional company subset (Task 2 — 2-phase modal). Pass through to the
  // orchestrator as a comma-separated list. Sanitized: only letters / digits /
  // hyphen / underscore / comma / space allowed so a malicious payload can't
  // inject extra args. Defense-in-depth — the orchestrator also slugifies.
  if (Array.isArray(companies) && companies.length) {
    const safe = companies
      .map(c => String(c || '').trim())
      .filter(c => c && /^[A-Za-z0-9 _.\-()]+$/.test(c))
      .slice(0, 200); // hard cap so a runaway client can't blow the arg list
    if (safe.length < companies.length) {
      console.warn(`[process-all] companies sanitization dropped ${companies.length - safe.length}/${companies.length} entries — check for unsupported characters`);
    }
    if (safe.length) args.push(`--companies=${safe.join(',')}`);
  }
  // 2026-05-26 — Audit log every Process All spawn whose cost estimate exceeds
  // PROCESS_ALL_AUDIT_THRESHOLD_USD (default $250). Append-only JSONL at
  // data/process-all-audit.jsonl. Records cost, tier, force flag, companies
  // scope so spend over the original cap is always reviewable after the fact.
  if (costForCap > PROCESS_ALL_AUDIT_THRESHOLD_USD) {
    try {
      const auditEntry = {
        ts: new Date().toISOString(),
        jobId,
        tier_id: tierId,
        tier_name: tierObj.name,
        cost_estimate_usd: Math.round(costForCap * 100) / 100,
        cap_usd: PER_RUN_CAP_PROCESS_ALL,
        force,
        send_email: !!sendEmail,
        companies_count: Array.isArray(companies) ? companies.length : null,
        companies: Array.isArray(companies) ? companies.slice(0, 50) : null,
        eval_model: tierObj.eval_model,
        triage_model: tierObj.triage_model,
      };
      appendFileSync(join(ROOT, 'data/process-all-audit.jsonl'), JSON.stringify(auditEntry) + '\n');
    } catch (auditErr) {
      // Audit log failure must NOT block the spawn — the run is what the user
      // asked for; the log is best-effort observability.
      console.warn(`[process-all] audit log write failed: ${auditErr.message}`);
    }
  }

  // P0.7 Q5 (2026-05-20 iter9): capture PID synchronously via the statically-
  // imported _spawn so /api/batch/cancel can SIGTERM the running child later.
  // Previously this used a dynamic import, which deferred PID availability and
  // left no way to track or interrupt the spawned process.
  let pid = null;
  try {
    const proc = _spawn('node', args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    pid = proc.pid;
    proc.unref();
    // Best-effort: when the child exits while the dashboard is still up,
    // record the exit code in state so /api/batch/cancel knows not to SIGKILL
    // a stale PID. The 'exit' handler will not fire if the dashboard restarts
    // first — that's a pre-existing limitation of detached children.
    proc.on('exit', (code) => {
      try {
        const s = loadPipelineProcessState();
        if (s.jobs[jobId] && (s.jobs[jobId].status === 'queued' || s.jobs[jobId].status === 'running')) {
          s.jobs[jobId].exit_code = code;
          if (s.jobs[jobId].status !== 'cancelled') {
            s.jobs[jobId].status = code === 0 ? 'completed' : 'failed';
            s.jobs[jobId].completed_at = new Date().toISOString();
          }
          writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(s, null, 2));
        }
      } catch (_) { /* state file unreadable — orchestrator owns the canonical status */ }
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // Initialize the state row optimistically — the orchestrator will overwrite
  const state = loadPipelineProcessState();
  state.jobs[jobId] = {
    jobId,
    type:        'process-all',
    status:      'queued',
    started_at:  new Date().toISOString(),
    send_email:  sendEmail,
    log_path:    logPath,
    pid,
  };
  try {
    if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2));
  } catch {}
  return { ok: true, jobId, log_path: logPath, status_url: `/api/pipeline/job-status?job_id=${jobId}` };
}

function spawnBatchOnly({ sendEmail, force }) {
  // Cap enforcement (calibration 2026-05-16): refuse to spawn if per-run cap
  // ($25 default) or monthly budget exceeded. `force: true` overrides.
  if (!force) {
    const preview = buildPipelinePreview();
    if (preview.run_batch.exceeds_per_run_cap) {
      return {
        ok: false,
        error: `Run Batch estimate $${preview.run_batch.total_cost_usd} exceeds per-run cap $${PER_RUN_CAP_RUN_BATCH}. Pass force:true to override, or raise PER_RUN_CAP_RUN_BATCH_USD env.`,
        cap_exceeded: 'per_run',
        estimated_cost_usd: preview.run_batch.total_cost_usd,
        cap_usd: PER_RUN_CAP_RUN_BATCH,
      };
    }
    if (preview.run_batch.exceeds_budget) {
      return {
        ok: false,
        error: `Run Batch would push 30d spend ($${preview.spent_30d_usd} + $${preview.run_batch.total_cost_usd}) past effective monthly budget $${preview.effective_budget_usd}. Activate burst mode or pass force:true.`,
        cap_exceeded: 'monthly',
        estimated_cost_usd: preview.run_batch.total_cost_usd,
        spent_30d_usd: preview.spent_30d_usd,
        effective_budget_usd: preview.effective_budget_usd,
      };
    }
  }

  const jobId = 'batch-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
  const logPath = `/tmp/batch-only-${jobId}.log`;
  const args = [join(ROOT, 'scripts/batch-only-pipeline.mjs'), `--job-id=${jobId}`];
  if (sendEmail) args.push('--send-email');
  if (force) args.push('--cap-override');
  // P0.7 Q5 (2026-05-20 iter9): capture PID synchronously so /api/batch/cancel
  // can interrupt this run. Same pattern as spawnPipelineProcessAll above.
  let pid = null;
  try {
    const proc = _spawn('node', args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    pid = proc.pid;
    proc.unref();
    proc.on('exit', (code) => {
      try {
        const s = loadPipelineProcessState();
        if (s.jobs[jobId] && (s.jobs[jobId].status === 'queued' || s.jobs[jobId].status === 'running')) {
          s.jobs[jobId].exit_code = code;
          if (s.jobs[jobId].status !== 'cancelled') {
            s.jobs[jobId].status = code === 0 ? 'completed' : 'failed';
            s.jobs[jobId].completed_at = new Date().toISOString();
          }
          writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(s, null, 2));
        }
      } catch (_) { /* state file unreadable — orchestrator owns the canonical status */ }
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // State row pre-written as 'queued'; batch-only-pipeline.mjs transitions it to 'running' → 'completed'/'failed'
  const state = loadPipelineProcessState();
  state.jobs[jobId] = {
    jobId,
    type:        'batch-only',
    status:      'queued',
    started_at:  new Date().toISOString(),
    send_email:  sendEmail,
    log_path:    logPath,
    pid,
  };
  try {
    if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2));
  } catch {}
  return { ok: true, jobId, log_path: logPath, status_url: `/api/pipeline/job-status?job_id=${jobId}` };
}

function parseBatch() {
  const statePath = join(ROOT, 'batch/batch-state.tsv');
  const inputPath = join(ROOT, 'batch/batch-input.tsv');
  const batch = { completed: 0, failed: 0, total: 0, runs: 0, recent: [] };

  if (existsSync(statePath)) {
    const lines = readFileSync(statePath, 'utf8').split('\n')
      .filter(l => l.trim() && !l.startsWith('id'));
    const startedAts = [];
    for (const l of lines) {
      const [id, url, status, started, completed, report] = l.split('\t');
      if (status === 'completed') {
        batch.completed++;
        batch.recent.push({ id, url, report, completed });
      }
      if (status === 'failed') batch.failed++;
      if (started) startedAts.push(started);
    }
    batch.recent = batch.recent.slice(-10).reverse();
    // Count distinct runs via 15-min gap heuristic on started_at (matches detailBatches).
    const GAP_MS = 15 * 60 * 1000;
    startedAts.sort();
    let prev = 0;
    for (const s of startedAts) {
      const ts = new Date(s).getTime();
      if (!batch.runs || (ts - prev) > GAP_MS) batch.runs++;
      prev = ts;
    }
  }
  if (existsSync(inputPath)) {
    batch.total = readFileSync(inputPath, 'utf8').split('\n')
      .filter(l => l.trim() && !l.startsWith('id')).length;
  }
  return batch;
}

function parseScanHistory() {
  const path = join(ROOT, 'data/scan-history.tsv');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('url'))
    .map(l => {
      const [url, first_seen, portal, title, company, status] = l.split('\t');
      return { url, first_seen, portal, title, company, status };
    });
}

// ── Summary stats (30s poll) ───────────────────────────────────

function computeStats() {
  const apps = parseApplications();
  const pipeline = parsePipeline();
  const batch = parseBatch();
  const scanned = parseScanHistory();

  const companies = new Set(apps.map(a => a.company));
  const applyNow = apps.filter(a =>
    a.score >= 4.0 && ['Evaluated','Applied','Interview','Offer'].includes(a.status)
  ).length;
  const applied = apps.filter(a => ['Applied','Interview','Offer'].includes(a.status)).length;

  return {
    applyNow,
    totalEvals: apps.length,
    applied,
    pipelinePending: pipeline.total,
    companies: companies.size,
    scanned: scanned.length,
    batch,
    lastUpdated: new Date().toISOString(),
  };
}

// ── Detail endpoints (on-demand) ───────────────────────────────

function detailApplyNow() {
  const apps = parseApplications();
  // β.1: filter out rows dismissed until midnight PT
  const dismissedMap = loadDismissed();
  const nowMs = Date.now();
  const rows = apps
    .filter(a => a.score >= 4.0 && ['Evaluated','Applied','Interview','Offer'].includes(a.status))
    .filter(a => {
      const until = dismissedMap[String(a.num)];
      return !until || new Date(until).getTime() <= nowMs; // include if not dismissed or expired
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 200)
    .map(r => ({ ...r, reportSummary: r.report ? parseReportSummary(r.report) : {} }));
  return { title: 'Apply-Now Queue (≥ 4.0)', rows };
}

function detailEvaluations() {
  const apps = parseApplications();
  const buckets = { '4.5+': 0, '4.0–4.4': 0, '3.5–3.9': 0, '3.0–3.4': 0, '<3.0': 0 };
  for (const a of apps) {
    if (a.score >= 4.5) buckets['4.5+']++;
    else if (a.score >= 4.0) buckets['4.0–4.4']++;
    else if (a.score >= 3.5) buckets['3.5–3.9']++;
    else if (a.score >= 3.0) buckets['3.0–3.4']++;
    else buckets['<3.0']++;
  }
  const allSorted = [...apps].sort((a, b) => b.num - a.num).slice(0, 200)
    .map(r => ({ ...r, reportSummary: r.report ? parseReportSummary(r.report) : {} }));
  const recent = allSorted.slice(0, 20);
  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  return { title: 'All Evaluations', buckets, byStatus, recent, rows: allSorted, total: apps.length };
}

function detailApplied() {
  const apps = parseApplications();
  const today = new Date();
  const rows = apps
    .filter(a => ['Applied','Interview','Offer','Responded'].includes(a.status))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(r => {
      const appDate = new Date(r.date);
      const daysSince = isNaN(appDate) ? null : Math.floor((today - appDate) / 86400000);
      return { ...r, daysSince };
    });
  return { title: 'Applied / In Process', rows };
}

function detailPending() {
  const batch = parseBatch();
  const pct = batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0;

  // Load discard log so we can flag URLs already discarded/rejected
  const discardLog = loadDiscardLog();
  const discardedUrls = new Set(discardLog.map(e => e.url).filter(Boolean));

  const pipelinePath = join(ROOT, 'data/pipeline.md');
  const items = [];
  const today = new Date();
  if (existsSync(pipelinePath)) {
    const content = readFileSync(pipelinePath, 'utf8');
    const lines = content.split('\n');
    let currentTier = null;
    for (const l of lines) {
      if (/Tier\s*1/i.test(l)) { currentTier = 'T1'; continue; }
      if (/Tier\s*2/i.test(l)) { currentTier = 'T2'; continue; }
      if (/Tier\s*3/i.test(l)) { currentTier = 'T3'; continue; }
      if (!l.startsWith('- [ ]') || items.length >= 500) continue;
      const rest = l.replace(/^- \[ \]\s*/, '').trim();
      const parts = rest.split('|').map(p => p.trim());
      const url      = parts[0] || '';
      const company  = parts[1] || '';
      const role     = parts[2] || '';
      const dateStr  = parts[3] || '';
      const platform = detectPlatform(url);
      const dateAdded = dateStr || null;
      let daysInQueue = null;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d)) daysInQueue = Math.max(0, Math.floor((today - d) / 86400000));
      }
      items.push({ platform, url, company, role, tier: currentTier, dateAdded, daysInQueue,
        alreadyDiscarded: discardedUrls.has(url) });
    }
  }

  // Group by platform
  const counts = {};
  for (const item of items) {
    counts[item.platform] = (counts[item.platform] || 0) + 1;
  }
  const PLATFORM_ORDER = ['LinkedIn', 'Greenhouse', 'Ashby', 'Lever', 'Workday', 'Amazon', 'iCIMS', 'Wellfound', 'HN / YC', 'Other'];
  const tiers = PLATFORM_ORDER
    .filter(p => counts[p])
    .map(p => ({ label: p, count: counts[p] }));

  return {
    title: 'Pipeline Pending',
    tiers,
    total: items.length,
    items,
    batch: { ...batch, pct },
  };
}

function detectPlatform(url) {
  if (!url) return 'Other';
  if (url.includes('linkedin.com'))         return 'LinkedIn';
  if (url.includes('ashbyhq.com'))          return 'Ashby';
  if (url.includes('greenhouse.io'))        return 'Greenhouse';
  if (url.includes('lever.co'))             return 'Lever';
  if (url.includes('myworkdayjobs.com'))    return 'Workday';
  if (url.includes('amazon.jobs') || url.includes('amazonjobs.com')) return 'Amazon';
  if (url.includes('icims.com'))            return 'iCIMS';
  if (url.includes('wellfound.com') || url.includes('angel.co')) return 'Wellfound';
  if (url.includes('ycombinator.com') || url.includes('news.ycombinator.com')) return 'HN / YC';
  return 'Other';
}

function detailCompanies() {
  // 1. Apps grouped by company
  const apps = parseApplications();
  const appByCompany = {};
  for (const a of apps) {
    if (!a.company) continue;
    if (!appByCompany[a.company]) appByCompany[a.company] = { evals: 0, applyNow: 0, totalScore: 0, bestScore: 0, bestRole: '', statuses: {} };
    const c = appByCompany[a.company];
    c.evals++;
    c.totalScore += a.score || 0;
    if ((a.score || 0) > c.bestScore) { c.bestScore = a.score || 0; c.bestRole = a.role || ''; }
    if ((a.score || 0) >= 4.0 && ['Evaluated','Applied','Interview','Offer','Responded'].includes(a.status)) c.applyNow++;
    c.statuses[a.status] = (c.statuses[a.status] || 0) + 1;
  }

  // 2. Scan history grouped by company (last_seen + roles count + first portal seen)
  const scans = parseScanHistory();
  const scanByCompany = {};
  for (const s of scans) {
    if (!s.company) continue;
    if (!scanByCompany[s.company]) scanByCompany[s.company] = { lastScanned: '', portal: '', count: 0 };
    const sc = scanByCompany[s.company];
    sc.count++;
    if ((s.first_seen || '') > sc.lastScanned) sc.lastScanned = s.first_seen || '';
    if (!sc.portal && s.portal) sc.portal = s.portal;
  }

  // 3. portals.yml — enabled tracked companies + portal type
  const portalByCompany = {};
  let trackedTotal = 0;
  try {
    const portalsPath = join(ROOT, 'portals.yml');
    if (existsSync(portalsPath)) {
      const cfg = yaml.load(readFileSync(portalsPath, 'utf8'));
      for (const tc of (cfg?.tracked_companies || [])) {
        if (tc.enabled === false) continue;
        trackedTotal++;
        const api = (tc.api || '') + ' ' + (tc.careers_url || '');
        let portal = '';
        if (api.includes('greenhouse')) portal = 'greenhouse';
        else if (api.includes('ashby')) portal = 'ashby';
        else if (api.includes('lever.co')) portal = 'lever';
        else if (api.includes('workday') || api.includes('myworkdayjobs')) portal = 'workday';
        else if (tc.careers_url) portal = 'web';
        if (tc.name) portalByCompany[tc.name] = portal;
      }
    }
  } catch (err) {
    console.error('[detailCompanies] portals.yml parse error:', err.message);
  }

  // 4. Merge: union of (portal companies, app companies, scan companies)
  const allNames = new Set([
    ...Object.keys(portalByCompany),
    ...Object.keys(appByCompany),
    ...Object.keys(scanByCompany),
  ]);

  const todayMs = Date.now();
  const rows = [];
  for (const name of allNames) {
    if (!name) continue;
    const a = appByCompany[name] || { evals: 0, applyNow: 0, totalScore: 0, bestScore: 0, bestRole: '' };
    const s = scanByCompany[name] || { lastScanned: '', portal: '', count: 0 };
    const portal = portalByCompany[name] || s.portal || '';
    const lastScanned = s.lastScanned || '';
    let daysSinceScan = null;
    if (lastScanned) {
      const ms = todayMs - new Date(lastScanned).getTime();
      if (!isNaN(ms)) daysSinceScan = Math.floor(ms / 86400000);
    }
    rows.push({
      company:       name,
      portal,
      evals:         a.evals,
      applyNow:      a.applyNow,
      lastScanned,
      daysSinceScan,
      rolesFound:    s.count,
      avgScore:      a.evals ? Math.round((a.totalScore / a.evals) * 10) / 10 : 0,
      bestScore:     a.bestScore,
      bestRole:      a.bestRole,
      tracked:       portalByCompany[name] !== undefined,
    });
  }
  rows.sort((x, y) =>
    (y.evals - x.evals) ||
    (y.applyNow - x.applyNow) ||
    (y.rolesFound - x.rolesFound) ||
    x.company.localeCompare(y.company)
  );

  // 5. Bucket counts
  const trackedNow = trackedTotal || rows.filter(r => r.tracked).length;
  const withEvals  = rows.filter(r => r.evals > 0).length;
  const inApplyNow = rows.filter(r => r.applyNow > 0).length;
  const inactive   = rows.filter(r => r.tracked && (r.daysSinceScan == null || r.daysSinceScan > 30)).length;

  return {
    title: 'Companies Tracked',
    buckets: {
      'Total tracked':    trackedNow,
      'With evals':       withEvals,
      'In Apply-Now':     inApplyNow,
      'Inactive (>30d)':  inactive,
    },
    rows,
    total: rows.length,
  };
}

// Group batch-state rows into runs using a gap heuristic on started_at.
// Two consecutive rows (sorted by started_at asc) belong to the same run when
// the gap between starts is ≤ BATCH_RUN_GAP_MIN minutes (default 15).
function detailBatches() {
  const statePath = join(ROOT, 'batch/batch-state.tsv');
  if (!existsSync(statePath)) return { title: 'Batch History', total: 0, batches: [] };

  // Score column in batch-state.tsv is unpopulated (`-`); reach into applications.md.
  const scoreByReportNum = {};
  for (const a of parseApplications()) {
    const n = parseInt(a.num, 10);
    if (!isNaN(n) && a.score) scoreByReportNum[String(n)] = a.score;
  }

  const GAP_MIN = parseInt(process.env.BATCH_RUN_GAP_MIN || '15', 10);
  const GAP_MS  = GAP_MIN * 60 * 1000;

  const rows = readFileSync(statePath, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('id'))
    .map(l => {
      const [id, url, status, started_at, completed_at, report_num, score, error, retries] = l.split('\t');
      return { id: parseInt(id) || 0, url: url || '', status: status || '', started_at: started_at || '', completed_at: completed_at || '', report_num: report_num || '', error: error !== '-' ? error : null, retries: parseInt(retries) || 0 };
    })
    .filter(r => r.started_at);

  rows.sort((a, b) => a.started_at.localeCompare(b.started_at));

  const groups = [];
  let prevStartMs = 0;
  for (const r of rows) {
    const ts = new Date(r.started_at).getTime();
    if (!groups.length || (ts - prevStartMs) > GAP_MS) groups.push({ rows: [] });
    groups[groups.length - 1].rows.push(r);
    prevStartMs = ts;
  }

  const batches = groups.map(g => {
    const startedAts   = g.rows.map(r => r.started_at).filter(Boolean).sort();
    const completedAts = g.rows.map(r => r.completed_at).filter(Boolean).sort();
    const startedAt    = startedAts[0] || null;
    const completedAt  = completedAts[completedAts.length - 1] || null;
    const durationMs   = (startedAt && completedAt) ? (new Date(completedAt) - new Date(startedAt)) : null;
    const completed = g.rows.filter(r => r.status === 'completed').length;
    const failed    = g.rows.filter(r => r.status === 'failed').length;
    const running   = g.rows.filter(r => r.status === 'running').length;
    const pending   = g.rows.filter(r => !['completed','failed','running'].includes(r.status)).length;

    const scores = g.rows
      .filter(r => r.status === 'completed' && r.report_num && r.report_num !== '-')
      .map(r => scoreByReportNum[String(parseInt(r.report_num, 10))])
      .filter(s => typeof s === 'number' && !isNaN(s) && s > 0);
    const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

    return {
      batch_id: startedAt,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      total: g.rows.length,
      completed, failed, running, pending,
      avgScore,
      reports: g.rows
        .filter(r => r.status === 'completed' && r.report_num && r.report_num !== '-')
        .map(r => ({ id: r.id, report_num: r.report_num, url: r.url, score: scoreByReportNum[String(parseInt(r.report_num, 10))] || null })),
    };
  });

  batches.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  return { title: 'Batch History', total: batches.length, batches: batches.slice(0, 10) };
}

function detailScanned() {
  const items = parseScanHistory();
  const total = items.length;
  const todayMs = Date.now();
  const dayMs = 86400000;

  // Bucket counts (24h / 7d / 30d / all-time)
  let last24h = 0, last7d = 0, last30d = 0;
  for (const i of items) {
    const t = new Date(i.first_seen || '').getTime();
    if (isNaN(t)) continue;
    const age = todayMs - t;
    if (age <= dayMs) last24h++;
    if (age <= 7 * dayMs) last7d++;
    if (age <= 30 * dayMs) last30d++;
  }

  // Daily counts for last 30 days (chronological asc, zero-fill missing dates)
  const byDate = {};
  for (const i of items) {
    const d = (i.first_seen || '').slice(0, 10);
    if (!d) continue;
    byDate[d] = (byDate[d] || 0) + 1;
  }
  const daily = [];
  const start = new Date(todayMs - 29 * dayMs);
  for (let i = 0; i < 30; i++) {
    const dt = new Date(start.getTime() + i * dayMs);
    const key = dt.toISOString().slice(0, 10);
    daily.push({ date: key, count: byDate[key] || 0 });
  }

  // Recent scan events: aggregate (date, company, portal) → new_roles_found
  const eventsMap = new Map();
  for (const i of items) {
    const date = (i.first_seen || '').slice(0, 10);
    if (!date) continue;
    const key = `${date}|${i.company || ''}|${i.portal || ''}`;
    if (!eventsMap.has(key)) {
      eventsMap.set(key, { timestamp: date, company: i.company || '', portal: i.portal || '', newRolesFound: 0, status: 'success' });
    }
    eventsMap.get(key).newRolesFound++;
  }
  const recent = [...eventsMap.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.company.localeCompare(b.company))
    .slice(0, 200);

  // Per-portal breakdown still useful for dashboard tooltips
  const byPortal = {};
  for (const i of items) {
    byPortal[i.portal || 'unknown'] = (byPortal[i.portal || 'unknown'] || 0) + 1;
  }

  return {
    title: 'URLs Scanned',
    total,
    buckets: {
      'Last 24h': last24h,
      'Last 7d':  last7d,
      'Last 30d': last30d,
      'All time': total,
    },
    daily,
    recent,
    byPortal,
  };
}

function batchLive() {
  const statePath = join(ROOT, 'batch/batch-state.tsv');
  const inputPath = join(ROOT, 'batch/batch-input.tsv');
  const triagePath = join(ROOT, 'batch/triage-advance.tsv');

  const stateRows = [];
  let total = 0;

  if (existsSync(statePath)) {
    const lines = readFileSync(statePath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('id'));
    for (const l of lines) {
      const [id, url, status, started_at, completed_at, report_num, score, error, retries] = l.split('\t');
      let company = 'Unknown';
      try {
        const h = new URL(url || '').hostname.replace(/^www\./, '');
        if ((url || '').includes('greenhouse.io')) company = 'Greenhouse';
        else if ((url || '').includes('ashbyhq.com')) company = 'Ashby';
        else if ((url || '').includes('lever.co')) company = 'Lever';
        else company = h.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } catch (_) {}
      stateRows.push({ id: parseInt(id) || 0, url: url || '', status: status || 'pending', started_at, completed_at, report_num, score: score !== '-' ? score : null, error: error !== '-' ? error : null, retries: parseInt(retries) || 0, company });
    }
  }

  if (existsSync(inputPath)) {
    total = readFileSync(inputPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('id')).length;
  }

  const completed = stateRows.filter(r => r.status === 'completed').length;
  const failed = stateRows.filter(r => r.status === 'failed').length;
  const running = stateRows.filter(r => r.status === 'running').length;
  const pending = total - completed - failed - running;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Triage advance queue
  const triageItems = [];
  if (existsSync(triagePath)) {
    const lines = readFileSync(triagePath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('url'));
    for (const l of lines) {
      const [url, tier, score, archetype, reason] = l.split('\t');
      triageItems.push({ url, tier, score, archetype, reason });
    }
  }

  // ζ Run-Batch 2026-05-19 — enrich each row with network-leverage signal
  // so the live sidebar can render "🤝 N fresh warm" badges DURING a batch
  // run (not only post-publish). findContactsAtCompany() is cached against
  // the network-graph/database mtime so calling per-row is cheap.
  // Skipped for generic ATS-host companies (Greenhouse/Ashby/Lever — the
  // URL didn't resolve to a real company name yet) since the lookup would
  // be meaningless.
  const ATS_HOSTS = new Set(['Greenhouse', 'Ashby', 'Lever']);
  for (const r of stateRows) {
    if (!r.company || ATS_HOSTS.has(r.company)) continue;
    try {
      const slug = String(r.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) continue;
      const contacts = networkFindContactsAtCompany(slug) || [];
      const fresh = contacts.filter(c => !c._stale_warmth).length;
      const stale = contacts.length - fresh;
      const firstDegree = contacts.filter(c => !c._warm_via_target_name).length;
      r.network_warm_count = contacts.length;
      r.network_fresh_count = fresh;
      r.network_stale_count = stale;
      r.network_first_degree = firstDegree;
    } catch { /* network signal optional — leave fields unset */ }
  }

  // Sort: running first, then completed by time desc, then failed, then pending
  const sorted = [
    ...stateRows.filter(r => r.status === 'running').sort((a, b) => (b.started_at || '').localeCompare(a.started_at || '')),
    ...stateRows.filter(r => r.status === 'completed').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')),
    ...stateRows.filter(r => r.status === 'failed'),
    ...stateRows.filter(r => !['running','completed','failed'].includes(r.status)),
  ];

  // ── Pipeline stage state (Process All decomposition) ─────────────────────
  // γ GAMMA 2026-05-19 truth-audit:
  //   - Renamed `activeJob` semantics: a finished job ≠ active job. Only emit
  //     `pipelineStages` for a TRULY active run (status='running') OR a
  //     fresh-terminal run (completed within last STAGE_STATE_FRESHNESS_MS).
  //     Prior code surfaced 6h-stale 'failed' jobs as the canonical state, which
  //     looked like a live run.
  //   - Annotate `staleness_seconds` so the renderer can grey-out / mute stale
  //     state and stop calling itself 'Live'.
  //   - Marker `pipeline_state_present: false` distinguishes
  //     "no state file" (honest 'no work') from "state present but stale"
  //     (was previously rendered identically — misleading).
  let pipelineStages = null;
  let pipelineStateMeta = { present: false, stale: false, staleness_seconds: null };
  const pipelineStatePath = join(ROOT, 'data/pipeline-process-state.json');
  const STAGE_STATE_FRESHNESS_MS = 5 * 60 * 1000; // 5 min — long enough for email phase, short enough to not surface 6h-old failed jobs
  if (existsSync(pipelineStatePath)) {
    pipelineStateMeta.present = true;
    try {
      const ps = JSON.parse(readFileSync(pipelineStatePath, 'utf-8'));
      const jobs = Object.values(ps.jobs || {}).sort((a, b) =>
        (b.started_at || '').localeCompare(a.started_at || ''));
      // Find a TRULY running job first. If none, find the most-recent terminal
      // job ONLY if it's fresh (<5min). Otherwise no stage state is emitted.
      const runningJob = jobs.find(j => j.status === 'running' && j.type !== 'batch-only');
      const recentNonBatch = jobs.find(j => j.type !== 'batch-only');
      const candidate = runningJob || recentNonBatch;
      let activeJob = null;
      if (candidate) {
        const updatedTs = Date.parse(candidate.updated_at || candidate.started_at || '') || 0;
        const ageMs = Date.now() - updatedTs;
        pipelineStateMeta.staleness_seconds = Math.round(ageMs / 1000);
        if (runningJob) {
          // Always surface a job marked status='running' — that's the canonical
          // active state. The stream/poll status indicator can warn if it's
          // been running > N min (job hung).
          activeJob = runningJob;
        } else if (ageMs <= STAGE_STATE_FRESHNESS_MS) {
          // Terminal job, still fresh — surface for the "just finished" UI moment.
          activeJob = candidate;
        } else {
          // Terminal + stale — DO NOT surface as if it were live. Mark state
          // stale so the renderer can de-emphasize.
          pipelineStateMeta.stale = true;
        }
      }
      if (activeJob) {
        const ph = activeJob.phase || '';
        // 2026-05-27 — live phase progress for the sidebar widget + top-bar
        // dispatch chip + bottom-right toast. Parses log file for per-URL
        // events; no orchestrator restart required. AGENTS.md bug-class:
        // long-phase-no-liveness-signal-looks-like-stall.
        const livePhaseProgress = _computeLivePhaseProgress(activeJob);
        // 2026-05-27 (PR-organic-wiring) — full-run ETA + per-phase breakdown
        // for hover tooltip. Sums all 4 phases. Updates every SSE tick.
        const fullRunETA = _computeFullRunETA(activeJob, livePhaseProgress);
        // Current batch progress (auto-switch from "Last batch" chip when
        // process-all is in batch phase). Returns null otherwise.
        const currentBatchProgress = _computeCurrentBatchProgress(activeJob, livePhaseProgress);
        // α Run-Batch eval 2026-05-19: phaseOrder now includes 'polish' and 'merge'.
        // process-all-pipeline.mjs emits phase='polish' (line 150) and phase='merge'
        // (line 186) between batch and rebuild — they were absent from this enum,
        // so phaseIdx returned -1 and the per-stage done/active bits silently broke
        // for the (~30-second to ~30-minute) window while those phases ran.
        const phaseOrder = ['triage', 'batch', 'polish', 'merge', 'rebuild', 'email', 'done'];
        const phaseIdx = phaseOrder.indexOf(ph);
        const phaseDone = (p) => phaseOrder.indexOf(p) >= 0 && phaseIdx > phaseOrder.indexOf(p);
        const isRunning = activeJob.status === 'running';
        const triageTotal = activeJob.pending_before || 0;
        const triageAdv   = activeJob.triage_advanced != null ? activeJob.triage_advanced : triageTotal;
        // γ GAMMA: published_count is currently never written by
        // process-all-pipeline.mjs (truth audit found NULL handling that
        // displays 0/0 = pending when the publish stage DID run). Best-effort
        // fallback: when phase is 'done' or 'email', derive published count
        // from the most recent apply-now-queue.json size minus prior size.
        // If we can't derive, render as 'completed' (✓) rather than 0/0.
        let publishedCount = activeJob.published_count;
        if (publishedCount == null && (ph === 'done' || ph === 'email' || phaseDone('rebuild'))) {
          publishedCount = null; // signal renderer: phase done, count unknown
        } else if (publishedCount == null) {
          publishedCount = 0;
        }
        pipelineStages = {
          job_id:        activeJob.jobId,
          status:        activeJob.status,
          current_phase: ph,
          updated_at:    activeJob.updated_at || null,
          staleness_seconds: pipelineStateMeta.staleness_seconds,
          stages: {
            triage:   { done: phaseDone('triage') || ph === 'done',
                        active: ph === 'triage' && isRunning,
                        completed: phaseDone('triage') || ph === 'done' ? triageAdv : 0,
                        total: triageTotal },
            sort:     { done: phaseDone('batch') || ph === 'done',
                        active: false,
                        completed: phaseDone('batch') || ph === 'done' ? triageAdv : 0,
                        total: triageAdv || triageTotal },
            process:  { done: phaseDone('rebuild') || ph === 'done',
                        active: ph === 'batch' && isRunning,
                        completed,
                        total },
            evaluate: { done: phaseDone('rebuild') || ph === 'done',
                        active: ph === 'batch' && isRunning,
                        completed,
                        total },
            // α Run-Batch eval 2026-05-19: polish stage gated by POLISH_PACK_ENABLED.
            // When the env is OFF the stage is skipped server-side (process-all-pipeline.mjs
            // line 146-149), so we never enter ph==='polish'. When ON, two sources of progress:
            //   1. activeJob.polish_progress.* — live counts during the loop (mid-phase)
            //   2. activeJob.phases.polish.{polished,failed} — final tally after phasePolish
            //      returns (only written at the end of main()).
            // Prefer live progress when present; fall back to final phases.polish.
            polish: (function() {
              const pp = activeJob.polish_progress;
              const finalPolish = activeJob.phases && activeJob.phases.polish;
              const polished = (pp && pp.polished) || (finalPolish && finalPolish.polished) || 0;
              const failed   = (pp && pp.failed)   || (finalPolish && finalPolish.failed)   || 0;
              const skipped  = (pp && pp.skipped)  || (finalPolish && finalPolish.skipped)  || 0;
              const total    = (pp && pp.total)    || (finalPolish && (finalPolish.polished + finalPolish.failed + (finalPolish.skipped || 0))) || 0;
              return {
                done:      phaseDone('polish') || ph === 'done',
                active:    ph === 'polish' && isRunning,
                completed: polished + skipped,
                total,
                gated:     true,
                failed,
              };
            })(),
            publish:  { done: ph === 'done' || ph === 'email',
                        active: false,
                        completed: publishedCount == null ? '✓' : publishedCount,
                        total: publishedCount == null ? '✓' : publishedCount,
                        count_unknown: publishedCount == null },
          },
          // 2026-05-27 — live per-URL progress for the currently-active phase.
          // Sidebar widget + dispatch chip + toast all read this.
          live_progress: livePhaseProgress,
          // 2026-05-27 (PR-organic-wiring) — full-run ETA across all 4 phases.
          // Toast title + sidebar title surface total_label prominently; hover
          // tooltip renders phases[] breakdown.
          full_eta: fullRunETA,
          // 2026-05-27 (PR-organic-wiring) — current batch progress, null
          // unless phase === 'batch'. mc-batch chip uses this to auto-switch
          // from "Last batch" to "⚡ Current batch X/Y · Zm in".
          current_batch: currentBatchProgress,
        };
      }
    } catch (_) {}
  }

  // 2026-05-27 — last_run_complete pushes a terminal "all done" / "cancelled"
  // signal through the SSE stream so the dashboard can fire a one-time toast
  // confirming Process All finished. Fires when the most recent non-batch-only
  // job is terminal (completed/cancelled/failed) AND within RUN_COMPLETE_FRESHNESS_MS.
  // The dashboard dedupes per-jobId via localStorage so the same toast doesn't
  // re-fire on reload. AGENTS.md bug-class: process-all-completion-not-surfaced.
  let last_run_complete = null;
  const RUN_COMPLETE_FRESHNESS_MS = 10 * 60 * 1000;
  if (existsSync(pipelineStatePath)) {
    try {
      const ps = JSON.parse(readFileSync(pipelineStatePath, 'utf-8'));
      const jobs = Object.values(ps.jobs || {})
        .filter(j => j && j.type === 'process-all')
        .sort((a, b) => {
          const ta = Date.parse(a.updated_at || a.started_at || '') || 0;
          const tb = Date.parse(b.updated_at || b.started_at || '') || 0;
          return tb - ta;
        });
      for (const j of jobs) {
        if (!j.status || (j.status !== 'completed' && j.status !== 'cancelled' && j.status !== 'failed')) continue;
        const finishedTs = Date.parse(j.finished_at || j.cancelled_at || j.failed_at || j.updated_at || '') || 0;
        if (!finishedTs) continue;
        const ageMs = Date.now() - finishedTs;
        if (ageMs > RUN_COMPLETE_FRESHNESS_MS) break;
        const startTs = Date.parse(j.started_at || '') || 0;
        const elapsedMs = Math.max(0, finishedTs - startTs);
        const elapsedMin = Math.floor(elapsedMs / 60000);
        const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
        const elapsedStr = `${elapsedMin}m ${elapsedSec}s`;
        const processed = j.processed != null ? j.processed : (j.triage_advanced || 0);
        const pendingBefore = j.pending_before || j.triage_pipeline_before || 0;
        const pendingAfter = j.pending_after != null ? j.pending_after : Math.max(0, pendingBefore - processed);
        const published = j.published_count != null ? j.published_count : 0;
        let summary;
        if (j.status === 'completed') {
          summary = `Processed ${processed} of ${pendingBefore} items in ${elapsedStr}. ${published} new ≥4.0 published.`;
        } else if (j.status === 'cancelled') {
          // 2026-05-27 — polish removed from orchestrator; summary stops referencing it.
          summary = `Cancelled after ${elapsedStr}. Triage ${j.triage_advanced || 0}/${j.triage_pipeline_before || 0} advanced · batch ${j.batch_items_drained || 0} drained.`;
        } else {
          summary = `Failed at phase '${j.failure_phase || j.phase || 'unknown'}' after ${elapsedStr}.${j.error ? ' ' + String(j.error).slice(0, 200) : ''}`;
        }
        last_run_complete = {
          jobId: j.jobId,
          type: j.type,
          status: j.status,
          tier: j.tier,
          finished_at: j.finished_at || j.cancelled_at || j.failed_at || j.updated_at,
          started_at: j.started_at,
          elapsed_str: elapsedStr,
          summary,
          processed,
          pending_before: pendingBefore,
          pending_after: pendingAfter,
          published_count: published,
        };
        break;
      }
    } catch (_) { /* leave null */ }
  }

  // Closure 08.4 (2026-05-22) — last_batch summary embedded in batchLive() so
  // the existing SSE stream pushes A7 chip updates without a separate poll.
  // Same logic as scripts/build-dashboard.mjs:loadLastBatchSummary() — keep
  // the two computations in lockstep.
  const last_batch = _computeLastBatchSummary(stateRows);

  // 2026-05-27 (PR-organic-wiring) — live counts that downstream widgets
  // (Total Eval tile, Tracker chip, Pipeline Pending tile, Apply-Now banner)
  // read on every SSE tick instead of waiting for the rebuild phase. The
  // active job is passed so new_publishes_since_run_start can filter rows
  // landed since job.started_at.
  let liveActiveJob = null;
  if (existsSync(pipelineStatePath)) {
    try {
      const ps = JSON.parse(readFileSync(pipelineStatePath, 'utf-8'));
      const running = Object.values(ps.jobs || {}).find(j => j && j.status === 'running');
      liveActiveJob = running || null;
    } catch (_) {}
  }
  const live_counts = _computeLiveCounts(liveActiveJob);

  // Spec 5a (2026-05-29) — in-flight Anthropic batch snapshot. Independent of
  // orchestrator state — surfaces even when no pipelineStages job is active
  // (e.g., batch left in flight after orchestrator phase advanced, or batch
  // submitted by a sibling instance). Returns null when nothing is in flight.
  // The client renderer uses this to render an amber "⏳ in-flight" chip
  // with elapsed time + next-poll countdown.
  let in_flight_batch = null;
  try { in_flight_batch = detectInFlightBatchFromDisk(ROOT); } catch (_) { /* never block SSE on detector */ }

  return {
    total, completed, failed, running, pending, pct,
    rows: sorted.slice(0, 500),
    triageItems: triageItems.slice(0, 200),
    pipelineStages,
    // γ GAMMA: stale-state marker so the renderer can mute / de-emphasize.
    pipelineStateMeta,
    last_batch,
    // 2026-05-27 — one-time terminal signal for Process All completion toast.
    // null when no fresh terminal run; else { jobId, status, summary, ... }.
    last_run_complete,
    // 2026-05-27 (PR-organic-wiring) — live counts for downstream widgets.
    // Read fresh from disk every tick. Cheap (small files).
    live_counts,
    // Spec 5a (2026-05-29) — in-flight Anthropic batch (null when none).
    // { batchId, processing, succeeded, errored, total, submitted_at,
    //   elapsed_ms, next_poll_in_ms, error_rate }
    in_flight_batch,
  };
}

// Closure 08.4 (2026-05-22) — extract the most-recent batch (15-min gap
// heuristic on started_at) from a list of stateRows parsed from
// batch/batch-state.tsv. Mirrors scripts/build-dashboard.mjs:loadLastBatchSummary
// so SSE pushes deliver the same shape the A7 chip reads at build time.
function _computeLastBatchSummary(stateRows) {
  if (!Array.isArray(stateRows) || stateRows.length === 0) return null;
  const recent = stateRows.slice(-600);
  const sorted = recent
    .filter(r => r.started_at)
    .sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
  if (sorted.length === 0) return null;

  // Walk back from the latest start; rows within 15min of the previous one
  // belong to the same batch (matches the build-time helper).
  let lastBatchRows = [sorted[sorted.length - 1]];
  for (let i = sorted.length - 2; i >= 0; i--) {
    const prev = lastBatchRows[lastBatchRows.length - 1];
    const cur = sorted[i];
    const gapMs = new Date(prev.started_at) - new Date(cur.started_at);
    if (gapMs > 15 * 60 * 1000) break;
    lastBatchRows.push(cur);
  }
  lastBatchRows.reverse();

  let lbCompleted = 0, lbFailed = 0, lbRunning = 0;
  for (const r of lastBatchRows) {
    if (r.status === 'completed') lbCompleted++;
    else if (r.status === 'failed') lbFailed++;
    else if (r.status === 'running') lbRunning++;
  }
  const lbStart = lastBatchRows.length ? lastBatchRows[0].started_at : null;
  const lbEnd   = lastBatchRows.length ? lastBatchRows[lastBatchRows.length - 1].completed_at || null : null;
  const lbDurationMs = (lbStart && lbEnd) ? Math.max(0, new Date(lbEnd) - new Date(lbStart)) : 0;
  const failedRate = (lbCompleted + lbFailed) > 0 ? (lbFailed / (lbCompleted + lbFailed)) : 0;
  return {
    completed:   lbCompleted,
    failed:      lbFailed,
    running:     lbRunning,
    total:       lastBatchRows.length,
    duration_ms: lbDurationMs,
    failed_rate: failedRate,
    started_at:  lbStart,
    ended_at:    lbEnd,
    state:       lbRunning > 0 ? 'running' : (lbFailed > 0 ? 'partial-fail' : 'completed'),
  };
}

// ── Sidebar batch popout (2026-05-17) ──────────────────────────
// Builds the detailed status feed for the clickable #sidebar-batch box.
// Reuses batchLive() for the current run summary, detailBatches() for the
// recent-runs grouping (15-min gap heuristic), data/cost-log.tsv for per-batch
// cost rows, and data/errors.log for batch-related failures.
// 2026-05-20 — Mitchell flagged dashboard load lag. /api/batch/status-detailed
// was the bottleneck (798ms vs <20ms for every other endpoint) because it
// re-parses 4,400-row cost-log.tsv + batch-state.tsv + errors.log + pipeline-
// process-state.json on every request. Cache for 5 seconds — well within
// the dashboard's 10s poll window, so the first poll-tick after a change
// still sees fresh data, but rapid-fire calls (first paint + 1s timestamp
// updates) reuse the cached payload.
let _batchStatusCache = null;
let _batchStatusCacheTs = 0;
const BATCH_STATUS_CACHE_MS = 5000;
function buildBatchStatusDetailed() {
  if (_batchStatusCache && (Date.now() - _batchStatusCacheTs) < BATCH_STATUS_CACHE_MS) {
    return _batchStatusCache;
  }
  const result = _buildBatchStatusDetailedUncached();
  _batchStatusCache = result;
  _batchStatusCacheTs = Date.now();
  return result;
}
// BRAVO followup 2026-05-20 — per-state item drill-in for the Batch
// Status modal. Reads batch/batch-state.tsv directly for the current
// run (latest started_at group, 15-min gap heuristic) and returns the
// matching rows. For pipeline_pending + batch_input, reads the source
// queues. Cap at 200 to keep payload tight; UI shows truncation note.
function buildBatchItemsForState(state) {
  const MAX_ROWS = 200;
  const ROOT_LOCAL = ROOT;

  // Parse batch-state.tsv into rows + group into "current run" (latest
  // gap-bounded cluster) plus map status → state-name.
  function parseBatchStateRows() {
    const fp = join(ROOT_LOCAL, 'batch/batch-state.tsv');
    if (!existsSync(fp)) return [];
    return readFileSync(fp, 'utf-8').split('\n')
      .filter(l => l.trim() && !l.startsWith('id\t'))
      .map(l => {
        const [id, url, status, started_at, completed_at, report_num, score, error, retries] = l.split('\t');
        return {
          id: parseInt(id, 10) || 0,
          url: url || '',
          status: status || '',
          started_at: started_at || '',
          completed_at: completed_at || '',
          report_num: report_num && report_num !== '-' ? report_num : null,
          score: score && score !== '-' ? parseFloat(score) : null,
          error: error && error !== '-' ? error : null,
          retries: parseInt(retries, 10) || 0,
        };
      });
  }

  function classifyError(msg) {
    if (!msg) return 'unknown';
    const s = String(msg).toLowerCase();
    if (s.includes('rate limit') || s.includes('rate_limit') || s.includes('429')) return 'rate-limit';
    if (s.includes('token') && (s.includes('limit') || s.includes('exceed') || s.includes('too large'))) return 'token-limit';
    if (s.includes('parse') || s.includes('json') || s.includes('schema')) return 'parse-error';
    if (s.includes('timeout') || s.includes('etimedout')) return 'timeout';
    if (s.includes('econnreset') || s.includes('econnrefused') || s.includes('network')) return 'network';
    if (s.includes('400') || s.includes('401') || s.includes('403')) return 'api-auth';
    if (s.includes('500') || s.includes('502') || s.includes('503') || s.includes('504')) return 'api-server';
    if (s.includes('exit=') && !s.includes('exit=0')) return 'worker-exit';
    return 'other';
  }

  // Helper: extract a company/role label from a JD URL — best-effort. Strips
  // protocol + greenhouse / lever / ashby host prefixes, returns a short
  // hostname + path tail for human scanning.
  function urlLabel(u) {
    if (!u) return '';
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.replace(/^www\./, '').replace(/^(jobs|boards|careers)\./, '');
      const tail = parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
      return host + (tail ? ('/' + tail) : '');
    } catch (_) { return u.slice(0, 80); }
  }

  // Map state to filter predicate over batch-state rows.
  let rows = parseBatchStateRows();
  // Filter to the current run (gap of >15 min from the LATEST started_at
  // partitions the cluster). This matches the detailBatches grouping.
  const GAP_MS = 15 * 60 * 1000;
  if (rows.length) {
    rows.sort((a, b) => a.started_at.localeCompare(b.started_at));
    const latestStart = rows[rows.length - 1].started_at ? Date.parse(rows[rows.length - 1].started_at) : 0;
    if (latestStart) {
      const cutoff = latestStart - GAP_MS;
      rows = rows.filter(r => r.started_at && Date.parse(r.started_at) >= cutoff);
    }
  }

  // For each state, derive the filtered + augmented list.
  if (state === 'completed') {
    const matching = rows.filter(r => r.status === 'completed');
    const items = matching.slice(0, MAX_ROWS).map(r => ({
      id: r.id,
      url: r.url,
      label: urlLabel(r.url),
      report_num: r.report_num,
      report_link: r.report_num ? ('/reports/' + r.report_num) : null,
      score: r.score,
      started_at: r.started_at,
      completed_at: r.completed_at,
    }));
    return { items, total: matching.length, truncated: matching.length > MAX_ROWS };
  }

  if (state === 'failed') {
    const matching = rows.filter(r => r.status === 'failed');
    // Cluster by category for the UI's grouping affordance.
    const categories = {};
    for (const r of matching) {
      const cat = classifyError(r.error);
      categories[cat] = (categories[cat] || 0) + 1;
    }
    const items = matching.slice(0, MAX_ROWS).map(r => ({
      id: r.id,
      url: r.url,
      label: urlLabel(r.url),
      error: r.error,
      error_category: classifyError(r.error),
      retries: r.retries,
      started_at: r.started_at,
    }));
    return { items, total: matching.length, truncated: matching.length > MAX_ROWS, error_categories: categories };
  }

  if (state === 'running') {
    const matching = rows.filter(r => r.status === 'running');
    const now = Date.now();
    const items = matching.slice(0, MAX_ROWS).map(r => {
      const elapsedMs = r.started_at ? (now - Date.parse(r.started_at)) : 0;
      return {
        id: r.id,
        url: r.url,
        label: urlLabel(r.url),
        started_at: r.started_at,
        elapsed_seconds: Math.max(0, Math.round(elapsedMs / 1000)),
      };
    });
    return { items, total: matching.length, truncated: matching.length > MAX_ROWS };
  }

  if (state === 'pending') {
    const matching = rows.filter(r => !['completed', 'failed', 'running'].includes(r.status));
    const items = matching.slice(0, MAX_ROWS).map((r, i) => ({
      id: r.id,
      url: r.url,
      label: urlLabel(r.url),
      position: i + 1,
      started_at: r.started_at || null,
    }));
    return { items, total: matching.length, truncated: matching.length > MAX_ROWS };
  }

  if (state === 'pipeline_pending') {
    // data/pipeline.md — count + list of pending row URLs.
    const fp = join(ROOT_LOCAL, 'data/pipeline.md');
    if (!existsSync(fp)) return { items: [], total: 0, truncated: false };
    const text = readFileSync(fp, 'utf-8');
    const urls = [];
    for (const ln of text.split('\n')) {
      const m = ln.match(/(https?:\/\/\S+)|local:(\S+)/);
      if (m) urls.push(m[1] || ('local:' + m[2]));
    }
    const items = urls.slice(0, MAX_ROWS).map((u, i) => ({
      position: i + 1,
      url: u,
      label: urlLabel(u),
    }));
    return { items, total: urls.length, truncated: urls.length > MAX_ROWS };
  }

  if (state === 'batch_input') {
    // batch/batch-input.tsv — pending items queued for the next batch run.
    const fp = join(ROOT_LOCAL, 'batch/batch-input.tsv');
    if (!existsSync(fp)) return { items: [], total: 0, truncated: false };
    try {
      if (!statSync(fp).isFile()) return { items: [], total: 0, truncated: false };
    } catch (_) { return { items: [], total: 0, truncated: false }; }
    const lines = readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('id'));
    const items = lines.slice(0, MAX_ROWS).map((l, i) => {
      const cols = l.split('\t');
      return {
        position: i + 1,
        id: cols[0] || null,
        url: cols[1] || '',
        label: urlLabel(cols[1] || ''),
      };
    });
    return { items, total: lines.length, truncated: lines.length > MAX_ROWS };
  }

  return { items: [], total: 0, truncated: false };
}

// P0.7 Q3 (2026-05-20 iter8) — Surface the actual stderr context for a
// failed batch row. The stored error in batch-state.tsv often hides the
// real root cause (e.g. a bash arithmetic bug at runner.sh:243 was
// surfacing as "API Error: 529 Overloaded" because the runner shell exited
// with code 1 before the API recorder could overwrite the field). The
// daily combined log is the ground truth — tail the chunk around the
// row's timestamps + extract the `--- Processing offer #ID` /
// `    ❌ Failed` / `STDERR:` triplet.
function buildBatchFailureDetail(rowId) {
  const ROOT_LOCAL = ROOT;
  const stateFp = join(ROOT_LOCAL, 'batch/batch-state.tsv');
  if (!existsSync(stateFp)) return { error: 'batch-state.tsv not found', row: null, log_lines: [] };
  const raw = readFileSync(stateFp, 'utf-8');
  const lines = raw.split('\n');
  const header = (lines[0] || '').split('\t');
  const idx = (name) => header.indexOf(name);
  let row = null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols[idx('id')] === String(rowId)) {
      row = {
        id:           cols[idx('id')] || '',
        url:          cols[idx('url')] || '',
        status:       cols[idx('status')] || '',
        started_at:   cols[idx('started_at')] || '',
        completed_at: cols[idx('completed_at')] || '',
        report_num:   cols[idx('report_num')] || '',
        score:        cols[idx('score')] || '',
        error:        cols[idx('error')] || '',
        retries:      cols[idx('retries')] || '',
      };
      break;
    }
  }
  if (!row) return { error: 'row not found in batch-state.tsv', row: null, log_lines: [] };

  // Derive the daily log file from started_at (UTC ISO). Fall back to today
  // if the row is missing a timestamp.
  const tsForLog = row.started_at || row.completed_at || new Date().toISOString();
  const datePart = tsForLog.slice(0, 10);  // YYYY-MM-DD
  const logFp = join(ROOT_LOCAL, 'data/logs', `batch-${datePart}.log`);
  let log_lines = [];
  let log_path_rel = `data/logs/batch-${datePart}.log`;
  let log_available = false;
  let real_stderr = null;
  let exit_code = null;
  if (existsSync(logFp)) {
    log_available = true;
    const logRaw = readFileSync(logFp, 'utf-8');
    const allLines = logRaw.split('\n');
    // Find the "--- Processing offer #<id>:" line(s). A row may have multiple
    // attempts (retries) — grab the LAST one's surrounding window since that's
    // the one that produced the final failure.
    const marker = `--- Processing offer #${row.id}:`;
    const hits = [];
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].startsWith(marker)) hits.push(i);
    }
    if (hits.length) {
      const start = hits[hits.length - 1];
      // Extract from the marker up through the next 6 lines or the next
      // "--- Processing offer #" line, whichever comes first. The fail/stderr
      // triplet usually lives within 4 lines of the marker.
      let end = Math.min(start + 8, allLines.length);
      for (let j = start + 1; j < end; j++) {
        if (allLines[j].startsWith('--- Processing offer #')) { end = j; break; }
      }
      log_lines = allLines.slice(start, end);
      // Pull structured fields from the slice.
      for (const ln of log_lines) {
        const stderrMatch = ln.match(/^STDERR:\s*(.+)$/);
        if (stderrMatch) real_stderr = stderrMatch[1];
        const exitMatch = ln.match(/exit code (\d+)/);
        if (exitMatch) exit_code = parseInt(exitMatch[1], 10);
      }
    }
  }

  // Compute duration_ms if both timestamps present.
  let duration_ms = null;
  if (row.started_at && row.completed_at) {
    const s = Date.parse(row.started_at);
    const e = Date.parse(row.completed_at);
    if (!Number.isNaN(s) && !Number.isNaN(e)) duration_ms = Math.max(0, e - s);
  }

  return {
    row,
    log_path: log_path_rel,
    log_available,
    log_lines,
    real_stderr,
    exit_code,
    duration_ms,
  };
}

function _buildBatchStatusDetailedUncached() {
  const live = batchLive();

  // ── Recent runs: enrich detailBatches() output with per-run cost ──
  // detailBatches groups batch-state.tsv rows into runs by 15-min gap. We
  // map cost-log.tsv rows (long format: date, batch_id, requests, ...) to
  // the closest run by started_at proximity. Fallback to short-format
  // per-item sum when long rows are unavailable.
  const det = (() => { try { return detailBatches(); } catch (_) { return { batches: [] }; } })();

  const costRows = [];
  const fpCost = join(ROOT, 'data/cost-log.tsv');
  if (existsSync(fpCost)) {
    const lines = readFileSync(fpCost, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('date\t')) continue;
      const cols = line.split('\t');
      let dateStr, ts, cost, label, model;
      if (cols.length >= 9) {
        dateStr = cols[0]; ts = cols[0]; cost = parseFloat(cols[7]); model = cols[8] || ''; label = `${cols[2] || '?'} items`;
      } else if (cols.length >= 4) {
        dateStr = cols[0]; ts = cols[1] || cols[0]; cost = parseFloat(cols[2]); model = ''; label = cols[3] || '';
      } else continue;
      if (!isFinite(cost)) continue;
      const t = Date.parse(ts);
      if (isNaN(t)) continue;
      costRows.push({ date: dateStr, ts, t, cost, model, label });
    }
  }
  const PROX_MS = 30 * 60 * 1000; // 30 min — generous to catch async cost-log writes

  const recent_runs = (det.batches || []).slice(0, 10).map(b => {
    const startMs = b.started_at ? Date.parse(b.started_at) : 0;
    let runCost = 0;
    if (startMs) {
      for (const r of costRows) {
        if (Math.abs(r.t - startMs) <= PROX_MS) runCost += r.cost;
      }
    }
    const durSec = (b.duration_ms && b.duration_ms > 0) ? Math.round(b.duration_ms / 1000) : null;
    const status = b.running > 0 ? 'running' : (b.failed > 0 && b.completed === 0 ? 'failed' : (b.failed > 0 ? 'partial' : 'completed'));
    return {
      batch_id:     b.batch_id,
      started_at:   b.started_at,
      completed_at: b.completed_at,
      duration_s:   durSec,
      cost_usd:     Math.round(runCost * 100) / 100,
      items_count:  b.total,
      completed:    b.completed,
      failed:       b.failed,
      running:      b.running,
      pending:      b.pending,
      avg_score:    b.avgScore,
      model:        (recent_runs_lookupModel(costRows, startMs)) || 'claude-sonnet-4-6',
      status,
    };
  });

  // ── Aggregate costs (today / rolling 30d) ──
  const now = Date.now();
  const dayMs = 86400000;
  let cost_today_usd = 0;
  let cost_30d_usd = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const r of costRows) {
    if (r.t >= now - 30 * dayMs) cost_30d_usd += r.cost;
    if (r.date === todayStr) cost_today_usd += r.cost;
  }

  // ── Queue depth: triage-advance / pipeline-pending / batch-input ──
  const queue_depth = {
    triage_advance:    countTriageAdvanceQueued(),
    pipeline_pending:  countPipelinePending(),
    batch_input:       (() => {
      // 2026-05-18: defend against EISDIR — earlier a batch-input.tsv-named
      // directory existed transiently, crashing the launchd-managed server
      // every request to /api/system-status. statSync isFile() check first.
      const fp = join(ROOT, 'batch/batch-input.tsv');
      if (!existsSync(fp)) return 0;
      try {
        if (!statSync(fp).isFile()) return 0;
        return readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('id')).length;
      } catch (_) { return 0; }
    })(),
  };

  // ── Recent batch-related failures from data/errors.log (last 5) ──
  // Filter: lines containing "WORKER FAIL" / "batch" / "BATCH" — these are
  // the failures that surface in the batch pipeline (worker subprocesses,
  // API failures, etc.). Skip anything that doesn't look batch-related.
  const most_recent_failures = [];
  const fpErrors = join(ROOT, 'data/errors.log');
  if (existsSync(fpErrors)) {
    const raw = readFileSync(fpErrors, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    // Walk from the end backwards
    for (let i = lines.length - 1; i >= 0 && most_recent_failures.length < 5; i--) {
      const ln = lines[i];
      if (!/(WORKER FAIL|batch|BATCH|Anthropic|Gemini|worker)/i.test(ln)) continue;
      // Format observed: [ISO_TS] WORKER FAIL id=N exit=N: <message>
      const m = ln.match(/^\[([^\]]+)\]\s+(.*)$/);
      if (m) {
        most_recent_failures.push({
          ts:    m[1],
          error: m[2].slice(0, 240),
        });
      } else {
        most_recent_failures.push({ ts: '', error: ln.slice(0, 240) });
      }
    }
  }

  // ── Running state: ETA estimate ──
  // ETA = running × average completed-run duration. Uses the median of the
  // last 5 runs (if available) for stability against outliers.
  let eta_seconds = null;
  if (live.running > 0) {
    const durs = recent_runs.filter(r => r.duration_s && r.completed > 0).map(r => Math.round(r.duration_s / Math.max(1, r.completed))).slice(0, 5).sort((a, b) => a - b);
    if (durs.length) {
      const median = durs[Math.floor(durs.length / 2)];
      eta_seconds = median * live.running;
    }
  }

  // ── 2026-05-20 — surface the currently-running Process All job so the
  // Batch Status modal stops looking frozen during the triage/rebuild/email
  // phases (when the batch sub-phase data legitimately doesn't change).
  let process_all_active = null;
  try {
    const stateFp = join(ROOT, 'data/pipeline-process-state.json');
    if (existsSync(stateFp)) {
      const state = JSON.parse(readFileSync(stateFp, 'utf-8'));
      // Pick the most recently-updated running process-all job (ignore batch-only).
      const candidates = Object.values(state.jobs || {})
        .filter(j => j.type === 'process-all' && j.status === 'running');
      candidates.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      const j = candidates[0];
      if (j) {
        const PHASES = [
          { key: 'triage',  label: 'Phase 1/4 — Triage',         pct: 20 },
          { key: 'batch',   label: 'Phase 2/4 — Batch eval',     pct: 50 },
          { key: 'rebuild', label: 'Phase 3/4 — Dashboard rebuild', pct: 85 },
          { key: 'email',   label: 'Phase 4/4 — Heartbeat email', pct: 95 },
        ];
        const currentIdx = Math.max(0, PHASES.findIndex(p => p.key === j.phase));
        const phasesOut = PHASES.map((p, i) => ({
          key: p.key,
          label: p.label,
          status: i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending',
          ok: !!(j.phases && j.phases[p.key] && j.phases[p.key].ok),
        }));
        // P0.7 Q5 (2026-05-20 iter9): include fields the Cancel UX needs.
        // cancellable=true means we have a PID we can SIGTERM. spend_so_far_usd
        // is gated against BATCH_CANCEL_WARN_THRESHOLD_USD on the client to
        // decide whether to show a confirm dialog before SIGTERM.
        const spendSoFar = j.started_at ? getSpendSinceIso(j.started_at) : 0;
        const warnUsd = parseFloat(process.env.BATCH_CANCEL_WARN_THRESHOLD_USD || '10');
        process_all_active = {
          job_id:           j.jobId,
          phase:            j.phase || 'queued',
          phase_label:      (PHASES.find(p => p.key === j.phase) || {}).label || 'Queued',
          phase_pct:        (PHASES.find(p => p.key === j.phase) || {}).pct || 5,
          started_at:       j.started_at,
          updated_at:       j.updated_at,
          phase_started_at: j.phase_started_at,
          pending_before:   j.pending_before,
          send_email:       j.send_email,
          phases:           phasesOut,
          log_path:         j.log_path,
          cancellable:      Number.isFinite(j.pid),
          pid:              j.pid || null,
          spend_so_far_usd: Math.round(spendSoFar * 100) / 100,
          warn_threshold_usd: warnUsd,
        };
      }
    }
  } catch (_) { /* state file unreadable — fall through with process_all_active=null */ }

  // 09 Part 6 (2026-05-22) — Process All confidence panel data. Last 5
  // Process All / batch-only runs with status + duration + completed
  // counts. Renders in a new modal section so Mitchell can see at a glance
  // whether the system is shipping cleanly.
  let process_all_confidence = { runs: [], summary: { total: 0, succeeded: 0, failed: 0, cancelled: 0, success_rate: null } };
  try {
    const stateFp3 = join(ROOT, 'data/pipeline-process-state.json');
    if (existsSync(stateFp3)) {
      const state = JSON.parse(readFileSync(stateFp3, 'utf-8'));
      const allRuns = Object.values(state.jobs || {})
        .filter(j => j && (j.type === 'process-all' || j.type === 'batch-only'))
        .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
        .slice(0, 5);
      const summary = { total: 0, succeeded: 0, failed: 0, cancelled: 0, running: 0 };
      const runs = [];
      for (const j of allRuns) {
        const startMs = j.started_at ? Date.parse(j.started_at) : null;
        const endMs = j.finished_at ? Date.parse(j.finished_at)
                    : j.completed_at ? Date.parse(j.completed_at)
                    : (j.status === 'running' ? Date.now() : null);
        const durMs = (startMs && endMs) ? Math.max(0, endMs - startMs) : null;
        runs.push({
          jobId: j.jobId,
          type: j.type || 'batch-only',
          status: j.status,
          started_at: j.started_at,
          finished_at: j.finished_at || j.completed_at || null,
          duration_ms: durMs,
          phase: j.phase || null,
          phases: j.phases || null,
          resumed_from: j.resumed_from || null,
        });
        summary.total++;
        if (j.status === 'completed') summary.succeeded++;
        else if (j.status === 'failed') summary.failed++;
        else if (j.status === 'cancelled') summary.cancelled++;
        else if (j.status === 'running') summary.running++;
      }
      const decisive = summary.succeeded + summary.failed + summary.cancelled;
      summary.success_rate = decisive > 0 ? Math.round((summary.succeeded / decisive) * 100) : null;
      process_all_confidence = { runs, summary };
    }
  } catch (_) { /* best-effort */ }

  // Closure 08.3 (2026-05-22) — surface recent cancelled jobs so the modal
  // can render a Resume button per cancelled job. Window: last 7 days.
  let recent_cancelled_jobs = [];
  try {
    const stateFp2 = join(ROOT, 'data/pipeline-process-state.json');
    if (existsSync(stateFp2)) {
      const state = JSON.parse(readFileSync(stateFp2, 'utf-8'));
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      recent_cancelled_jobs = Object.values(state.jobs || {})
        .filter(j => j && j.status === 'cancelled')
        .filter(j => {
          const ts = j.cancelled_at ? Date.parse(j.cancelled_at) : 0;
          return Number.isFinite(ts) && ts >= since;
        })
        .map(j => ({
          jobId:        j.jobId,
          type:         j.type || 'batch-only',
          started_at:   j.started_at,
          cancelled_at: j.cancelled_at,
          send_email:   !!j.send_email,
          resumed_from: j.resumed_from || null,
        }))
        .sort((a, b) => String(b.cancelled_at || '').localeCompare(String(a.cancelled_at || '')))
        .slice(0, 5);
    }
  } catch (_) { /* state file unreadable — empty list */ }

  return {
    ok: true,
    current_summary: {
      completed: live.completed,
      failed:    live.failed,
      running:   live.running,
      pending:   Math.max(0, live.pending),
      percent:   live.pct,
      total:     live.total,
      eta_seconds,
      model:     'claude-sonnet-4-6',  // current batch-runner-batches.mjs default
      // 2026-05-27 — `temperature` removed from this status block. The
      // batch-runner no longer sends a temperature param (Sonnet 4.6
      // deprecated it; see PR #308). Keeping the field would mislead
      // operators inspecting /api/batch/status-detailed and would re-encourage
      // the same regression in any future reimplementation copying from
      // this status shape.
    },
    process_all_active,
    recent_runs,
    queue_depth,
    cost_today_usd: Math.round(cost_today_usd * 100) / 100,
    cost_30d_usd:   Math.round(cost_30d_usd * 100) / 100,
    most_recent_failures,
    recent_cancelled_jobs,
    process_all_confidence,
    generated_at: new Date().toISOString(),
  };
}

// Find the cost-log model column closest to a given start timestamp.
// Returns null when no proximal row carries a model field.
function recent_runs_lookupModel(costRows, startMs) {
  if (!startMs) return null;
  const PROX_MS = 30 * 60 * 1000;
  for (const r of costRows) {
    if (Math.abs(r.t - startMs) <= PROX_MS && r.model) return r.model;
  }
  return null;
}

// ── Claim verification helpers ─────────────────────────────────

// Canonical report slug pattern per AGENTS.md: NNN-company-role-YYYY-MM-DD.md
// (or NNNN-* for high-id reports). Allows only [0-9a-z-] in the slug body.
// Disallows ".." traversal segments and absolute paths by construction.
// Defined here (above first use) so both buildVerifyPayload and saveEvidence
// reference the same source of truth.
const REPORT_SLUG_RE = /^\d{1,5}-[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.md$/;
const EVIDENCE_TEXT_MAX_CHARS = 50_000;

// ─── GAP-RES-14 (2026-05-24) — handoff/row dispatch prompt builders ──────────
// Both helpers emit self-contained Claude Code prompts that carry the global
// drift-guidance + EF rules forward so a fresh session can pick up cold.
// Returned text is what /api/handoffs/dispatch sends back; client writes it to
// clipboard via navigator.clipboard.writeText.
function _dispatchDriftFooter() {
  return [
    'DRIFT GUIDANCE (carry forward verbatim): if you notice ANY of —',
    're-reading files, forgetting decisions, contradicting earlier output,',
    'wrong paths in tool calls, losing the thread on multi-step plans,',
    'declining synthesis quality, increased hedging, repeating yourself, or',
    '"I don\'t remember exactly" — STOP at the next safe checkpoint, surface',
    'what is done, and produce a continuation prompt that includes this',
    'guidance verbatim. Mitchell prefers a chain of sharp instances over one',
    'degraded session.',
  ].join('\n');
}

function _dispatchHouseRules() {
  return [
    'House rules (Mitchell):',
    '- Quality > speed > cost (Decision-Maximization Policy)',
    '- EF EF rules: lead-with-next-action, single-thread, surface wins first',
    '- DISC DI: answer first, context after; no preamble, no menus',
    '- tone-safe framing: observation + reasoning, never judgment',
    '- Banned vocab: no leverage / synergy / deep-dive / ideate / circle-back',
    '- Verify before claiming done (Chrome MCP screenshot for UI changes)',
    '- NEVER push to santifer upstream; use ./scripts/safe-gh-pr.sh for PRs',
  ].join('\n');
}

function buildHandoffDispatchPrompt(envelope, file) {
  const sourceAgent = envelope.source_agent || 'unknown';
  const mode = envelope.mode || 'unknown';
  const ceiling = envelope.ceiling_usd != null ? `$${envelope.ceiling_usd}` : 'unset';
  const reportPath = envelope.report_path || '(not set)';
  const originalQ = (envelope.original_question || '').trim() || '(no original question recorded)';
  const auditItems = Array.isArray(envelope.audit_items) ? envelope.audit_items : [];
  const auditList = auditItems.length
    ? auditItems.slice(0, 20).map((item, i) => `${i + 1}. ${typeof item === 'string' ? item : JSON.stringify(item).slice(0, 200)}`).join('\n')
    : '(no audit items recorded)';
  return [
    `You are picking up a pending research-chain handoff: ${file}`,
    '',
    `Source agent: ${sourceAgent}`,
    `Mode: ${mode}`,
    `Spend ceiling: ${ceiling}`,
    `Original question:`,
    originalQ,
    '',
    'Source report:',
    reportPath,
    '',
    `Audit items (${auditItems.length} total${auditItems.length > 20 ? ', first 20 shown' : ''}):`,
    auditList,
    '',
    'Your job: load the source report, work through the audit items in priority order, and produce the next chain output (dealbreaker adjudication, implementer PR, or further research as the handoff envelope indicates).',
    '',
    'When done: update the handoff envelope status from "pending" to "resolved" with a one-line summary + result_path. Write a brief completion report to ~/Documents/career-ops/data/handoff-completion-<date>.md.',
    '',
    _dispatchHouseRules(),
    '',
    _dispatchDriftFooter(),
  ].join('\n');
}

function buildRowDispatchPrompt({ num, slug, company, role, focusHint }) {
  const identity = [
    num ? `Row #${num}` : null,
    company,
    role,
  ].filter(Boolean).join(' / ');
  const slugLine = slug ? `Slug: ${slug}` : '';
  const focusLine = focusHint || 'Polish or extend the apply-pack for this role; surface gaps; sync edits across artifacts.';
  return [
    `You are picking up apply-pack work for ${identity || '(no identity provided)'}.`,
    '',
    'Context to load:',
    '- Master CV: cv.md',
    slug ? `- Role intel: data/hm-intel/${slug}.json` : '- Role intel: data/hm-intel/<slug>.json',
    slug ? `- Apply pack: data/apply-pack/${slug}/` : '- Apply pack: data/apply-pack/<slug>/',
    '- Brain docs: ~/.claude/knowledge/brain/personality-*.md (tone-safe framing required)',
    '- Voice reference: ~/Documents/career-ops/writing-samples/voice-reference.md',
    '',
    slugLine,
    '',
    'Focus for this session:',
    focusLine,
    '',
    _dispatchHouseRules(),
    '',
    'When done: write a brief report to ~/Documents/career-ops/data/dispatch-reports/' + (slug || '<slug>') + '-' + new Date().toISOString().slice(0, 10) + '.md with what changed + what remains.',
    '',
    _dispatchDriftFooter(),
  ].join('\n');
}


function buildVerifyPayload(reportSlug) {
  // Path-traversal hardening (epsilon Ε.3 2026-05-19): reportSlug came from
  // the /api/verify/(.+\.md) capture group — the regex captures any path
  // up to .md including ../../etc/passwd.md. Validate against canonical
  // slug pattern + verify resolved path is inside reports/.
  if (typeof reportSlug !== 'string' || !REPORT_SLUG_RE.test(reportSlug)) {
    return null;
  }
  const reportsRoot = join(ROOT, 'reports') + '/';
  const reportPath = join(ROOT, 'reports', reportSlug);
  if (!reportPath.startsWith(reportsRoot)) {
    return null;
  }
  if (!existsSync(reportPath)) return null;
  const text = readFileSync(reportPath, 'utf8');
  const lines = text.split('\n');

  const titleMatch  = text.match(/^#\s+Evaluation:\s+(.+)/m);
  const scoreMatch  = text.match(/\*\*Score:\*\*\s*([\d.]+)/);
  const archMatch   = text.match(/\*\*Archetype:\*\*\s*([^\n]+)/);
  const urlMatch    = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/);

  // Split "Company — Role" from title
  let company = '', role = '';
  if (titleMatch) {
    const parts = titleMatch[1].split(/\s*[—–-]\s*/);
    company = parts[0]?.trim() || '';
    role    = parts.slice(1).join(' — ').trim() || '';
  }

  // Extract key claims from B (CV Match), C (Level/Strategy), D (Positioning/Edges)
  const extractSection = (headerRe, maxBullets = 5) => {
    const idx = lines.findIndex(l => headerRe.test(l));
    if (idx < 0) return [];
    const out = [];
    for (let i = idx + 1; i < lines.length && out.length < maxBullets; i++) {
      if (/^##/.test(lines[i])) break;
      const m = lines[i].match(/^[-*]\s+(.+)/);
      if (m) out.push(stripMarkdown(m[1]).slice(0, 160));
    }
    return out;
  };

  // Extract STAR-style bullets from Block C
  const extractStarStories = () => {
    const cIdx = lines.findIndex(l => /^##\s+C\b/.test(l));
    if (cIdx < 0) return [];
    const out = [];
    for (let i = cIdx + 1; i < lines.length && out.length < 4; i++) {
      if (/^##\s+[D-Z]/.test(lines[i])) break;
      const m = lines[i].match(/^[-*]\s+\*\*(.+?)\*\*\s*[—–:]\s*(.+)/);
      if (m) out.push({ label: m[1].trim(), detail: stripMarkdown(m[2]).slice(0, 200) });
    }
    return out;
  };

  // Extract "what to emphasize" from Block D/E/positioning
  const edges = extractSection(/^##\s+[DE]\b/, 5);
  const starStories = extractStarStories();
  const cvMatchClaims = extractSection(/^##\s+B\b/, 4);

  // Extract final recommendation text
  let finalRec = '';
  const finalIdx = lines.findIndex(l => /final recommendation/i.test(l));
  if (finalIdx >= 0) {
    finalRec = lines.slice(finalIdx + 1, finalIdx + 12)
      .map(l => stripMarkdown(l)).join(' ').slice(0, 400);
  }

  // Whether evidence block already exists
  const hasEvidence = text.includes('## H) Evidence & Verification');

  // Build research queries
  const grokQuery = `site:reddit.com OR site:linkedin.com OR site:teamblind.com OR site:levels.fyi ${company} "${role}" hiring interview culture 2024 2025`;
  const perplexityQuery = `What do hiring managers and recruiters at ${company} actually screen for when hiring a ${role}? What are the real day-to-day responsibilities and team culture signals from employee reviews and public interviews?`;
  const claudeQuery = `Research ${company}'s AI roadmap, recent product launches, and any public statements by their leadership about the ${role} function. Cross-reference with Glassdoor/Blind signals about interview difficulty and culture. Summarize what claims an applicant for this role should be able to substantiate.`;

  return {
    reportSlug,
    company,
    role,
    score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
    archetype: archMatch ? archMatch[1].trim() : null,
    url: urlMatch ? urlMatch[1].trim() : null,
    cvMatchClaims,
    starStories,
    edges,
    finalRec: finalRec.trim(),
    hasEvidence,
    queries: {
      grok:      { platform: 'Grok (social)', label: '🐦 Social signals', query: grokQuery },
      perplexity:{ platform: 'Perplexity Pro', label: '🔍 Deep research', query: perplexityQuery },
      claude:    { platform: 'Claude Research', label: '🤖 AI synthesis', query: claudeQuery },
    },
  };
}

function saveEvidence(reportSlug, evidenceText) {
  // Path-traversal hardening (epsilon Ε.3 2026-05-19): reportSlug came from
  // unsanitized POST body. Reject any slug that doesn't match the canonical
  // pattern, then defense-in-depth verify the resolved path is inside the
  // reports/ dir before any fs read/write.
  if (typeof reportSlug !== 'string' || !REPORT_SLUG_RE.test(reportSlug)) {
    return { ok: false, error: 'Invalid report slug' };
  }
  if (typeof evidenceText !== 'string') {
    return { ok: false, error: 'evidenceText must be a string' };
  }
  if (evidenceText.length > EVIDENCE_TEXT_MAX_CHARS) {
    return { ok: false, error: `evidenceText exceeds ${EVIDENCE_TEXT_MAX_CHARS}-char limit` };
  }
  const reportsRoot = join(ROOT, 'reports') + '/';
  const reportPath = join(ROOT, 'reports', reportSlug);
  if (!reportPath.startsWith(reportsRoot)) {
    return { ok: false, error: 'Resolved path escapes reports directory' };
  }
  if (!existsSync(reportPath)) return { ok: false, error: 'Report not found' };
  const text = readFileSync(reportPath, 'utf8');

  const block = `\n\n---\n\n## H) Evidence & Verification\n\n_Added ${new Date().toISOString().slice(0, 10)} via dashboard verify panel._\n\n${evidenceText.trim()}\n`;

  if (text.includes('## H) Evidence & Verification')) {
    // Replace existing block
    const updated = text.replace(/\n\n---\n\n## H\) Evidence & Verification[\s\S]*$/, block);
    writeFileSync(reportPath, updated);
  } else {
    appendFileSync(reportPath, block);
  }
  return { ok: true };
}

// ── Discard / rejection log ────────────────────────────────────
// Append-only log keyed by row num. Stored at data/discard-log.json.
// Written whenever a row transitions to Discarded, Rejected, or SKIP.
// Entries: { ts, num, company, role, status, reason, url }

const DISCARD_LOG_PATH = join(ROOT, 'data/discard-log.json');

function loadDiscardLog() {
  try {
    if (!existsSync(DISCARD_LOG_PATH)) return [];
    const raw = JSON.parse(readFileSync(DISCARD_LOG_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}

function appendDiscardEntry(entry) {
  const log = loadDiscardLog();
  log.push(entry);
  const tmp = DISCARD_LOG_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(log, null, 2));
  renameSync(tmp, DISCARD_LOG_PATH);
}

// ── Apply-Now dismiss persistence (β.1 — Discard vs Dismiss) ───────────────
// DISMISS: hides a row from the Apply-Now queue until midnight PT (local
// calendar day). Does NOT change the canonical status in applications.md.
// Persisted in data/apply-now-dismissed.json (gitignored).
// Format: { "<num>": "<ISO-8601 dismissed_until>" }
const DISMISS_PATH = join(ROOT, 'data/apply-now-dismissed.json');

function _nextMidnightPT() {
  // Returns an ISO-8601 string for the next midnight in America/Los_Angeles
  // (Pacific Time — PDT in summer, PST in winter). Uses toLocaleString with
  // the tz so it works regardless of the host machine's local timezone.
  const now = new Date();
  // Build today's date in PT by asking the locale formatter
  const ptDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
  // Midnight PT for tomorrow = today-in-PT + 1 day, 00:00 PT
  const [yyyy, mm, dd] = ptDateStr.split('-').map(Number);
  // Construct tomorrow midnight PT as a Date object
  const tomorrowMidnightPT = new Date(
    new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`).toLocaleString(
      'en-US', { timeZone: 'America/Los_Angeles' }
    ).replace(/\//g, '-') // not reliable; use the safe approach below
  );
  // Safe approach: add 24h to today's midnight PT
  // Today's midnight PT in UTC: find the UTC offset for PT right now
  const ptFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // Build midnight today PT as a UTC Date
  const parts = ptFormatter.formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const todayMidnightPTLocal = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`);
  // That Date object is interpreted as LOCAL time. We need it as UTC equivalent of PT midnight.
  // Simpler: just use fixed 8 or 7 hour offset as approximation (PDT=7, PST=8).
  // Most robust: add 24h to now and then zero the PT-local clock.
  const tomorrowNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowPTStr = tomorrowNow.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  // midnight of tomorrowPTStr in PT — expressed as UTC
  // Use the offset trick: 00:00 PT is UTC+7 (PDT) or UTC+8 (PST)
  const isPDT = (() => {
    // DST heuristic: check if the hour in PT at 00:00 UTC differs by 7 or 8
    const utcHour = new Date(`${tomorrowPTStr}T08:00:00Z`).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
    });
    return parseInt(utcHour, 10) === 1; // 08:00 UTC = 01:00 PDT (UTC-7) or 00:00 PST (UTC-8)
  })();
  const ptOffsetHours = isPDT ? 7 : 8;
  // midnight tomorrow PT = tomorrowPTStr at 00:00 = (tomorrowPTStr + ptOffsetHours hours) UTC
  const midnightUTC = new Date(`${tomorrowPTStr}T${String(ptOffsetHours).padStart(2,'0')}:00:00Z`);
  return midnightUTC.toISOString();
}

function loadDismissed() {
  try {
    if (!existsSync(DISMISS_PATH)) return {};
    return JSON.parse(readFileSync(DISMISS_PATH, 'utf8'));
  } catch { return {}; }
}

function saveDismissed(map) {
  // Prune expired entries (dismissed_until in the past) before saving
  const now = Date.now();
  const pruned = Object.fromEntries(
    Object.entries(map).filter(([, until]) => new Date(until).getTime() > now)
  );
  const tmp = DISMISS_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(pruned, null, 2));
  renameSync(tmp, DISMISS_PATH);
  return pruned;
}

function isDismissed(num) {
  const map = loadDismissed();
  const until = map[String(num)];
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

function dismissRow(num) {
  const map = loadDismissed();
  map[String(num)] = _nextMidnightPT();
  saveDismissed(map);
}

function undismissRow(num) {
  const map = loadDismissed();
  delete map[String(num)];
  saveDismissed(map);
}

function detailDiscarded() {
  const apps = parseApplications();
  const discardStatuses = new Set(['discarded', 'rejected', 'skip']);
  const log = loadDiscardLog();
  const reasonByNum = {};
  for (const e of log) if (e.num != null) reasonByNum[String(e.num)] = e.reason || '';

  const rows = apps
    .filter(a => discardStatuses.has((a.status || '').toLowerCase()))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .map(r => ({ ...r, reason: reasonByNum[String(r.num)] || '' }));

  return { title: 'Discarded & Rejected', total: rows.length, rows };
}

const DETAIL_FNS = {
  'apply-now':    detailApplyNow,
  'evaluations':  detailEvaluations,
  'applied':      detailApplied,
  'pending':      detailPending,
  'companies':    detailCompanies,
  'scanned':      detailScanned,
  'batches':      detailBatches,
  'discarded':    detailDiscarded,
};

// ── Status writeback ───────────────────────────────────────────

function loadCanonicalStatuses() {
  // Read labels from templates/states.yml. Falls back to the AGENTS.md
  // canonical list if states.yml is missing or malformed.
  const fallback = ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP'];
  try {
    const text = readFileSync(join(ROOT, 'templates/states.yml'), 'utf8');
    const doc = yaml.load(text);
    const labels = (doc?.states || [])
      .map(s => typeof s?.label === 'string' ? s.label.trim() : '')
      .filter(Boolean);
    return labels.length ? labels : fallback;
  } catch (_) {
    return fallback;
  }
}

const CANONICAL_STATUSES = loadCanonicalStatuses();

// 2026-05-26 — Coalesced dashboard rebuild trigger. Debounced 500ms so a
// bulk status change collapses to one rebuild. Best-effort: spawn failures
// log a warning but never block the caller. Closes the
// write-without-rebuild-propagation-gap bug class — before this helper,
// updateApplicationStatus correctly mutated data/applications.md +
// apply-now-queue.json but did NOT trigger dashboard rebuild, so the
// rendered HTML stayed stale until fswatch fired (60s debounce) or someone
// ran `node scripts/build-dashboard.mjs` manually. Mitchell's
// just-discarded rows kept appearing in Apply-Now until then.
let _rebuildDebounceTimer = null;
let _rebuildReasons = [];
function _scheduleDashboardRebuild(reason) {
  _rebuildReasons.push(reason);
  if (_rebuildDebounceTimer) clearTimeout(_rebuildDebounceTimer);
  _rebuildDebounceTimer = setTimeout(() => {
    const reasonsSnap = _rebuildReasons.slice(0, 5);
    const more = _rebuildReasons.length > 5 ? ` (+${_rebuildReasons.length - 5} more)` : '';
    _rebuildReasons = [];
    _rebuildDebounceTimer = null;
    try {
      const proc = _spawn('node', [join(ROOT, 'scripts/build-dashboard.mjs')], {
        cwd: ROOT,
        env: process.env,
        stdio: 'ignore',
        detached: true,
      });
      proc.unref();
      console.log(`[rebuild] dashboard rebuild triggered (pid=${proc.pid}) reasons=[${reasonsSnap.join(', ')}]${more}`);
    } catch (err) {
      console.warn(`[rebuild] dashboard rebuild trigger failed: ${err.message} — fswatch will catch this on next debounce`);
    }
  }, 500);
}

function updateApplicationStatus({ num, status, note }) {
  if (num === undefined || num === null || Number.isNaN(parseInt(num, 10))) {
    return { ok: false, code: 400, error: 'num is required and must be an integer' };
  }
  if (!status || typeof status !== 'string') {
    return { ok: false, code: 400, error: 'status is required (string)' };
  }
  // Case-insensitive match against canonical labels; reply with canonical casing
  const canonical = CANONICAL_STATUSES.find(s => s.toLowerCase() === status.trim().toLowerCase());
  if (!canonical) {
    return {
      ok: false, code: 400,
      error: `Invalid status "${status}". Must be one of: ${CANONICAL_STATUSES.join(', ')}`,
    };
  }

  const appsPath = join(ROOT, 'data/applications.md');
  if (!existsSync(appsPath)) {
    return { ok: false, code: 500, error: 'data/applications.md not found' };
  }

  const text = readFileSync(appsPath, 'utf8');
  const lines = text.split('\n');
  const targetNum = String(parseInt(num, 10));
  let updatedRow = null;
  let oldStatus = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.match(/^[\|\s\-:]+$/)) continue;
    if (line.includes('| # |')) continue;

    const cols = line.split('|').map(c => c.trim());
    // cols: [empty, num, date, company, role, score, status, pdf, report, notes, (empty)]
    if (cols.length < 10 || cols[1] !== targetNum) continue;

    oldStatus = cols[6];
    cols[6] = canonical;
    if (typeof note === 'string' && note.length) {
      // Sanitize: pipes break the markdown table
      cols[9] = note.replace(/\|/g, '\\|').slice(0, 600);
    }
    lines[i] = '| ' + cols.slice(1, 10).join(' | ') + ' |';

    const reportMatch = cols[8]?.match(/\[(\d+)\]\(([^)]+)\)/);
    updatedRow = {
      num: cols[1],
      date: cols[2],
      company: cols[3],
      role: cols[4],
      score: parseFloat(cols[5]) || 0,
      status: cols[6],
      pdf: cols[7],
      report: reportMatch ? reportMatch[2] : null,
      notes: cols[9] || '',
    };
    break;
  }

  if (!updatedRow) {
    // AGENTS.md rule: NEVER create new entries — update only.
    return { ok: false, code: 404, error: `Row #${targetNum} not found in applications.md (refusing to create)` };
  }

  // Atomic write: write to temp then rename
  const tmpPath = appsPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    writeFileSync(tmpPath, lines.join('\n'));
    renameSync(tmpPath, appsPath);
  } catch (err) {
    return { ok: false, code: 500, error: `Atomic write failed: ${err.message}` };
  }

  // Bust the 30s apps cache so /api/outreach immediately sees the new status
  // when it enriches contacts via linked_application_id → applications.md.
  _appsCache = { ts: 0, byNum: new Map() };

  // Auto-log status change to per-row activity (best-effort; never block status update)
  if (oldStatus && oldStatus !== canonical) {
    try {
      appendRowEvent(targetNum, {
        ts: new Date().toISOString(),
        type: 'status',
        text: `${oldStatus} → ${canonical}`,
      });
    } catch (_) {}
  }

  // Write to discard log when transitioning to a terminal negative status
  const discardStatuses = new Set(['discarded', 'rejected', 'skip']);
  let queueUpdated = false;
  if (discardStatuses.has(canonical.toLowerCase()) && updatedRow) {
    try {
      appendDiscardEntry({
        ts:      new Date().toISOString(),
        num:     updatedRow.num != null ? parseInt(updatedRow.num, 10) : null,
        company: updatedRow.company || '',
        role:    updatedRow.role    || '',
        status:  canonical,
        reason:  (typeof note === 'string' && note.trim()) ? note.trim() : '',
      });
    } catch (_) {}

    // Remove from apply-now-queue.json so all surfaces stay in sync
    try {
      const queuePath = join(ROOT, 'data/apply-now-queue.json');
      if (existsSync(queuePath)) {
        const queueRaw = JSON.parse(readFileSync(queuePath, 'utf8'));
        const before = (queueRaw.ranked || []).length;
        queueRaw.ranked = (queueRaw.ranked || []).filter(r => String(r.num) !== targetNum);
        if (queueRaw.ranked.length !== before) {
          queueRaw.ranked.forEach((r, i) => { r.rank = i + 1; });
          queueRaw.total_rows = queueRaw.ranked.length;
          if (!queueRaw.qa_cleanup) queueRaw.qa_cleanup = {};
          queueRaw.qa_cleanup.last_auto_remove = {
            ts: new Date().toISOString(), num: parseInt(targetNum, 10),
            company: updatedRow.company, reason: canonical,
          };
          const queueTmp = queuePath + '.tmp.' + process.pid + '.' + Date.now();
          writeFileSync(queueTmp, JSON.stringify(queueRaw, null, 2));
          renameSync(queueTmp, queuePath);
          queueUpdated = true;
        }
      }
    } catch (_) {}
  }

  // 2026-05-26 — Auto-trigger dashboard rebuild so the next page load
  // reflects the new status without waiting for fswatch (60s) or a manual
  // rebuild. Gated on actual status transition to avoid no-op spawns.
  if (oldStatus !== canonical) {
    _scheduleDashboardRebuild(`status:${targetNum}:${oldStatus}→${canonical}`);
  }

  return { ok: true, row: updatedRow, queueUpdated };
}

function updateApplicationStatusBulk({ nums, status }) {
  if (!Array.isArray(nums) || nums.length === 0) {
    return { ok: false, code: 400, error: 'nums is required (non-empty array of integers)' };
  }
  if (nums.length > 200) {
    return { ok: false, code: 400, error: `Too many rows in one request (${nums.length} > 200)` };
  }
  if (!status || typeof status !== 'string') {
    return { ok: false, code: 400, error: 'status is required (string)' };
  }
  const canonical = CANONICAL_STATUSES.find(s => s.toLowerCase() === status.trim().toLowerCase());
  if (!canonical) {
    return {
      ok: false, code: 400,
      error: `Invalid status "${status}". Must be one of: ${CANONICAL_STATUSES.join(', ')}`,
    };
  }

  const targets = new Set();
  for (const n of nums) {
    const parsed = parseInt(n, 10);
    if (Number.isNaN(parsed)) {
      return { ok: false, code: 400, error: `Invalid num "${n}" — must be integer` };
    }
    targets.add(String(parsed));
  }

  const appsPath = join(ROOT, 'data/applications.md');
  if (!existsSync(appsPath)) {
    return { ok: false, code: 500, error: 'data/applications.md not found' };
  }

  const text = readFileSync(appsPath, 'utf8');
  const lines = text.split('\n');
  const updated = [];
  const oldStatusByNum = {};
  const stillMissing = new Set(targets);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    if (line.match(/^[\|\s\-:]+$/)) continue;
    if (line.includes('| # |')) continue;

    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 10) continue;
    if (!targets.has(cols[1])) continue;

    oldStatusByNum[cols[1]] = cols[6];
    cols[6] = canonical;
    lines[i] = '| ' + cols.slice(1, 10).join(' | ') + ' |';

    const reportMatch = cols[8]?.match(/\[(\d+)\]\(([^)]+)\)/);
    updated.push({
      num: cols[1],
      date: cols[2],
      company: cols[3],
      role: cols[4],
      score: parseFloat(cols[5]) || 0,
      status: cols[6],
      pdf: cols[7],
      report: reportMatch ? reportMatch[2] : null,
      notes: cols[9] || '',
    });
    stillMissing.delete(cols[1]);
  }

  if (updated.length === 0) {
    return {
      ok: false, code: 404,
      error: `No matching rows found for: ${[...stillMissing].join(', ')}`,
    };
  }

  // Atomic write — single rename for the entire batch
  const tmpPath = appsPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    writeFileSync(tmpPath, lines.join('\n'));
    renameSync(tmpPath, appsPath);
  } catch (err) {
    return { ok: false, code: 500, error: `Atomic write failed: ${err.message}` };
  }

  // Bust the apps cache so /api/outreach sees the new status immediately.
  _appsCache = { ts: 0, byNum: new Map() };

  // Auto-log status change to per-row activity (best-effort; never block)
  const ts = new Date().toISOString();
  for (const row of updated) {
    const old = oldStatusByNum[row.num];
    if (old && old !== canonical) {
      try {
        appendRowEvent(row.num, { ts, type: 'status', text: `${old} → ${canonical}` });
      } catch (_) {}
    }
  }

  // 2026-05-26 — Trigger one rebuild for the whole bulk batch (debounced).
  if (updated.length > 0) {
    _scheduleDashboardRebuild(`bulk:${updated.length}rows→${canonical}`);
  }

  return {
    ok: true,
    updated,
    notFound: [...stillMissing],
  };
}

// ── Quick-add to pipeline (dashboard "Add role" modal) ─────────

const ATS_PATTERNS = [
  { id: 'greenhouse', test: /(?:job-boards|boards)\.greenhouse\.io/i },
  { id: 'ashby',      test: /jobs\.ashbyhq\.com/i },
  { id: 'lever',      test: /jobs\.lever\.co/i },
  { id: 'workday',    test: /myworkdayjobs\.com|workday/i },
  { id: 'linkedin',   test: /linkedin\.com\/jobs/i },
];

function detectAts(url) {
  for (const p of ATS_PATTERNS) if (p.test.test(url)) return p.id;
  return 'unknown';
}

function extractCompanyFromAts(parsedUrl, ats) {
  try {
    if (ats === 'greenhouse') {
      const m = parsedUrl.pathname.match(/^\/([^\/]+)\/jobs\//);
      if (m) return m[1];
    } else if (ats === 'ashby' || ats === 'lever') {
      const m = parsedUrl.pathname.match(/^\/([^\/]+)/);
      if (m) return m[1];
    } else if (ats === 'workday') {
      // {company}.wd1.myworkdayjobs.com or workday subdomain
      return parsedUrl.hostname.split('.')[0];
    }
    return parsedUrl.hostname.replace(/^www\./, '').split('.')[0];
  } catch (_) {
    return 'Unknown';
  }
}

function urlInScanHistory(url) {
  const path = join(ROOT, 'data/scan-history.tsv');
  if (!existsSync(path)) return false;
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('url\t')) continue;
    if (line.split('\t')[0] === url) return true;
  }
  return false;
}

function urlInPipeline(url) {
  const path = join(ROOT, 'data/pipeline.md');
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(url);
}

function addUrlToPipeline({ url, company, title, ats, date }) {
  const path = join(ROOT, 'data/pipeline.md');
  if (!existsSync(path)) return { ok: false, code: 500, error: 'data/pipeline.md not found' };

  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');

  // Insert at the top of "### Tier 2" so newest-first matches scan.mjs.
  // Skip at most one blank line that follows the header (preserve any
  // trailing blank line before "### Tier 3").
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+Tier 2\b/i.test(lines[i])) {
      insertIdx = i + 1;
      if (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
      break;
    }
  }
  if (insertIdx < 0) {
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push('### Tier 2 — Quick-add (manual)');
    lines.push('');
    insertIdx = lines.length;
  }

  const tag = ats && ats !== 'unknown' ? ' [' + ats + ']' : '';
  const safeCompany = (company || 'Unknown').replace(/\|/g, '/').slice(0, 80);
  const safeTitle   = ((title || '(pending triage)') + tag).replace(/\|/g, '/').slice(0, 200);
  const newLine = '- [ ] ' + url + ' | ' + safeCompany + ' | ' + safeTitle + ' | ' + date;
  lines.splice(insertIdx, 0, newLine);

  const tmp = path + '.tmp.' + process.pid + '.' + Date.now();
  try {
    writeFileSync(tmp, lines.join('\n'));
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, code: 500, error: 'Atomic write failed: ' + err.message };
  }
  return { ok: true, line: newLine };
}

function quickAddToPipeline(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return { ok: false, code: 400, error: 'url is required' };
  if (trimmed.length > 2048) return { ok: false, code: 400, error: 'URL too long' };

  let parsedUrl;
  try { parsedUrl = new URL(trimmed); }
  catch (_) { return { ok: false, code: 400, error: 'Not a valid URL — paste a full http(s) link.' }; }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, code: 400, error: 'URL must use http or https' };
  }

  // Normalize: drop fragment, keep query (some ATS slugs live there).
  const cleanUrl = parsedUrl.origin + parsedUrl.pathname + parsedUrl.search;

  if (urlInScanHistory(cleanUrl) || urlInPipeline(cleanUrl)) {
    return { ok: false, code: 200, duplicate: true, error: 'already in pipeline' };
  }

  const ats = detectAts(cleanUrl);
  const company = extractCompanyFromAts(parsedUrl, ats);
  const date = new Date().toISOString().slice(0, 10);

  const result = addUrlToPipeline({ url: cleanUrl, company, title: '(pending triage)', ats, date });
  if (!result.ok) return result;

  return { ok: true, ats, company, date, url: cleanUrl, line: result.line };
}

// ── Share-link tokens (24h read-only recruiter links) ─────────

const SHARE_TOKENS_PATH = join(ROOT, 'data/share-tokens.json');
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

function loadShareTokens() {
  try {
    if (!existsSync(SHARE_TOKENS_PATH)) return { tokens: [] };
    const raw = JSON.parse(readFileSync(SHARE_TOKENS_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.tokens)) return { tokens: [] };
    return raw;
  } catch (_) {
    return { tokens: [] };
  }
}

function saveShareTokens(data) {
  const dir = dirname(SHARE_TOKENS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = SHARE_TOKENS_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, SHARE_TOKENS_PATH);
}

function pruneExpired(data, now = Date.now()) {
  const before = data.tokens.length;
  data.tokens = data.tokens.filter(t => new Date(t.expires).getTime() > now);
  return { data, removed: before - data.tokens.length };
}

function lookupShareToken(token) {
  if (!token || typeof token !== 'string') return { status: 'missing' };
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return { status: 'invalid' };
  const data = loadShareTokens();
  const row = data.tokens.find(t => t.token === token);
  if (!row) return { status: 'invalid' };
  if (new Date(row.expires).getTime() <= Date.now()) return { status: 'expired', row };
  return { status: 'valid', row };
}

function createShareToken() {
  const token = randomBytes(16).toString('hex'); // 32 hex chars
  const created = new Date().toISOString();
  const expires = new Date(Date.now() + SHARE_TTL_MS).toISOString();
  const data = pruneExpired(loadShareTokens()).data;
  data.tokens.push({ token, created, expires });
  saveShareTokens(data);
  return { token, created, expires };
}

// ── Per-row notes & activity log ───────────────────────────────
// Append-only timestamped events keyed by row num. Stored at
// data/row-notes.json (gitignored). Two event types:
//   { ts, type: 'status', text: 'OldStatus → NewStatus' }
// Note: 2026-05-19 — type 'note' entries no longer written. The UI
// composer + /api/notes/* routes that produced them are gone. Existing
// 'note'-type entries in data/row-notes.json (from prior usage) remain
// readable. Atomic writes via tmp + rename.

const ROW_NOTES_PATH    = join(ROOT, 'data/row-notes.json');

function loadRowNotes() {
  try {
    if (!existsSync(ROW_NOTES_PATH)) return {};
    const raw = JSON.parse(readFileSync(ROW_NOTES_PATH, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (_) {
    return {};
  }
}

function saveRowNotes(data) {
  const dir = dirname(ROW_NOTES_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = ROW_NOTES_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, ROW_NOTES_PATH);
}

function appendRowEvent(num, entry) {
  // Internal — unconditionally append. Validation happens at the public
  // entry points (status-change call sites in /mark and bulk-mark handlers).
  const parsed = parseInt(num, 10);
  if (Number.isNaN(parsed)) return false;
  const key = String(parsed);
  const data = loadRowNotes();
  if (!Array.isArray(data[key])) data[key] = [];
  data[key].push(entry);
  try {
    saveRowNotes(data);
    return true;
  } catch (_) {
    return false;
  }
}

// appendRowNote() + getRowNotes() removed 2026-05-19 — were only called
// from the now-deleted /api/notes/add and GET /api/notes/:num routes.
// Status-change auto-logging via appendRowEvent() (above) is unaffected.

// ── /mark + report HTML renderer ──────────────────────────────

const CANONICAL_STATES = new Set([
  'Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP',
]);

function renderMarkPage(ctx) {
  const isOk = !!ctx.ok;
  const accent = isOk ? '#1a7f37' : '#cf222e';
  const tone   = isOk ? '#dafbe1' : '#ffebe9';
  const icon   = isOk ? '✅' : '⚠️';
  let body = `<h1 style="margin:0 0 12px;color:${accent}">${icon} ${isOk ? (ctx.idempotent ? 'Already marked' : 'Status updated') : 'Could not mark'}</h1>`;
  body += `<p style="font-size:15px;color:#1f2328">${ctx.message || ''}</p>`;
  if (isOk && ctx.role) body += `<p style="font-size:14px;color:#57606a">${ctx.role}</p>`;
  if (isOk && ctx.priorStatus && ctx.priorStatus !== ctx.status && !ctx.idempotent) {
    const undoUrl = `/mark?num=${ctx.num}&status=${encodeURIComponent(ctx.priorStatus)}&from=${encodeURIComponent(ctx.status)}`;
    body += `<p style="margin-top:18px"><a href="${undoUrl}" style="background:#fff;color:#cf222e;padding:8px 14px;border:1px solid #cf222e;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">↶ Undo (revert to ${ctx.priorStatus})</a></p>`;
  }
  body += `<p style="margin-top:22px"><a href="/dashboard/" style="color:#0969da;text-decoration:none;font-weight:500">← Back to dashboard</a></p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>career-ops · mark status</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f6f8fa;color:#1f2328;margin:0;padding:0;line-height:1.55"><main style="max-width:640px;margin:64px auto;padding:0 20px"><div style="background:#ffffff;border:1px solid #d0d7de;border-left:4px solid ${accent};border-radius:10px;padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.04)"><div style="display:inline-block;background:${tone};color:${accent};padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:14px">career-ops</div>${body}</div></main></body></html>`;
}

function handleMarkRequest(req, res) {
  const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
  const num    = parseInt(fullUrl.searchParams.get('num') || '', 10);
  const status = (fullUrl.searchParams.get('status') || 'Applied').trim();
  const previousStatus = (fullUrl.searchParams.get('from') || '').trim();

  const html = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };

  if (!Number.isFinite(num) || num < 1)
    return html(renderMarkPage({ ok: false, message: `Invalid row number: ${fullUrl.searchParams.get('num')}` }), 400);
  if (!CANONICAL_STATES.has(status))
    return html(renderMarkPage({ ok: false, message: `Invalid status "${status}". Allowed: ${[...CANONICAL_STATES].join(', ')}` }), 400);

  const appsPath = join(ROOT, 'data/applications.md');
  if (!existsSync(appsPath))
    return html(renderMarkPage({ ok: false, message: 'data/applications.md not found' }), 500);

  const lines = readFileSync(appsPath, 'utf-8').split('\n');
  let priorStatus = '', priorCompany = '', priorRole = '', lineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\|\s*(\d+)\s*\|/);
    if (m && parseInt(m[1], 10) === num) {
      lineIdx = i;
      const cells = lines[i].split('|').map(c => c.trim());
      priorCompany = cells[3] || ''; priorRole = cells[4] || ''; priorStatus = cells[6] || '';
      break;
    }
  }
  if (lineIdx === -1)
    return html(renderMarkPage({ ok: false, message: `Row #${num} not found in applications.md` }), 404);
  if (priorStatus === status)
    return html(renderMarkPage({ ok: true, idempotent: true, num, company: priorCompany, role: priorRole, status, priorStatus, message: `#${num} is already marked ${status} — no change needed.` }));

  const cells = lines[lineIdx].split('|');
  if (cells.length < 10)
    return html(renderMarkPage({ ok: false, message: `Row #${num} has unexpected column count (${cells.length}). Refusing to edit.` }), 500);

  const orig = cells[6];
  cells[6] = `${orig.match(/^\s*/)[0]}${status}${orig.match(/\s*$/)[0]}`;
  const today = new Date().toISOString().slice(0, 10);
  const noteOrig = cells[9] || '';
  cells[9] = `${noteOrig.match(/^\s*/)[0]}${noteOrig.trim()} · marked ${status} via heartbeat ${today}${noteOrig.match(/\s*$/)[0]}`;
  lines[lineIdx] = cells.join('|');
  writeFileSync(appsPath, lines.join('\n'));
  console.log(`  ✓ Marked #${num} ${priorCompany}: ${priorStatus} → ${status}`);
  return html(renderMarkPage({ ok: true, num, company: priorCompany, role: priorRole, status, priorStatus, message: `#${num} ${priorCompany} marked ${priorStatus} → ${status}.` }));
}

function renderMarkdownPage(mdContent, fileName) {
  // PR-X 2026-05-27 — dark-first rewrite to match dashboard aesthetic
  // (lib/heartbeat-tokens.json::color.dark.*). The old light-themed renderer
  // was the failure surface for the "connected living-breathing system"
  // contract — clicking a role's "Report" link from the heartbeat email
  // landed users on a light-themed Spanish-headered page that did not
  // belong to the dashboard. See AGENTS.md bug class
  // `report-renderer-aesthetic-fork`.
  marked.setOptions({ gfm: true, breaks: false });
  const restHtml = marked.parse(mdContent);
  // Dashboard dark tokens (hardcoded — markdown render is a static view):
  //   bg.app                 #06070d
  //   bg.panel               #11131c
  //   bg.panel_strong        #181b27
  //   border.default         #232737
  //   border.strong          #353a52
  //   text.t1                #fafafa  (display headings)
  //   text.t2                #e4e4e7  (body)
  //   text.t3                #b8b8c0  (secondary body, blockquote)
  //   text.t4                #9a9aa6  (subtle nav)
  //   brand.primary          #4ade80  (accent borders, h2 rule, links)
  //   link.default           #86efac  (anchors)
  //   link.hover             #bbf7d0
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${fileName} · career-ops</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>:root{color-scheme:dark}html,body{background:#06070d;color:#e4e4e7}body{font-family:'Inter','-apple-system',BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:920px;margin:32px auto;padding:0 24px;line-height:1.65;font-size:15px}.nav{font-size:12px;color:#9a9aa6;margin-bottom:18px;letter-spacing:0.02em;text-transform:uppercase;font-weight:600}.nav a{color:#86efac;text-decoration:none;border-bottom:1px solid rgba(74,222,128,0.30);padding-bottom:1px}.nav a:hover{color:#bbf7d0;border-bottom-color:#bbf7d0}.nav code{background:#11131c;color:#b8b8c0;padding:2px 8px;border-radius:4px;border:1px solid #232737;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11px;text-transform:none;letter-spacing:0}article{background:#11131c;padding:40px 48px;border-radius:12px;border:1px solid #232737;box-shadow:0 1px 0 rgba(255,255,255,0.02) inset}h1{font-family:'Fraunces',Georgia,serif;font-size:30px;font-weight:600;font-style:italic;margin:0 0 18px;color:#fafafa;line-height:1.2;letter-spacing:-0.01em}h2{font-family:'Fraunces',Georgia,serif;font-size:21px;font-weight:600;font-style:italic;margin:32px 0 12px;color:#fafafa;border-left:3px solid #4ade80;padding-left:14px;line-height:1.3}h3{font-family:'Inter',sans-serif;font-size:16px;font-weight:600;margin:24px 0 8px;color:#fafafa;letter-spacing:-0.005em}h4,h5,h6{font-family:'Inter',sans-serif;font-weight:600;color:#e4e4e7;margin:18px 0 6px}p{margin:12px 0;color:#e4e4e7}a{color:#86efac;text-decoration:none;border-bottom:1px solid rgba(74,222,128,0.30);transition:color 0.15s,border-color 0.15s}a:hover{color:#bbf7d0;border-bottom-color:#bbf7d0}strong,b{color:#fafafa;font-weight:600}em,i{color:#e4e4e7}code{background:#181b27;color:#bbf7d0;padding:2px 7px;border-radius:4px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;border:1px solid #232737}pre{background:#181b27;padding:16px 18px;border-radius:8px;overflow-x:auto;font-size:13px;border:1px solid #232737;line-height:1.55}pre code{background:transparent;border:0;padding:0;color:#e4e4e7}table{border-collapse:collapse;width:100%;margin:18px 0;font-size:14px;background:#0d0f17;border-radius:8px;overflow:hidden;border:1px solid #232737}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #232737;vertical-align:top;color:#e4e4e7}tr:last-child td{border-bottom:0}th{background:#181b27;font-weight:600;color:#fafafa;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;font-family:'Inter',sans-serif}blockquote{margin:18px 0;padding:14px 20px;border-left:3px solid #4ade80;background:#181b27;color:#b8b8c0;border-radius:0 8px 8px 0;font-family:'Fraunces',Georgia,serif;font-style:italic}blockquote p:first-child{margin-top:0}blockquote p:last-child{margin-bottom:0}hr{border:none;height:1px;background:#232737;margin:28px 0}ul,ol{padding-left:26px;color:#e4e4e7}li{margin:6px 0}li::marker{color:#9a9aa6}@media(max-width:640px){body{margin:18px auto;padding:0 16px}article{padding:24px 22px;border-radius:8px}h1{font-size:24px}h2{font-size:18px}}</style></head><body><div class="nav"><a href="https://dashboard.careers-ops.com/">← back to dashboard</a> · <code>${fileName}</code></div><article>${restHtml}</article></body></html>`;
}

// ── SSE batch-live stream (Tier A Item #2) ─────────────────────
// One persistent EventSource connection per client replaces the
// 2-second /api/batch-live polling loop (194 hits/session → 1).
// The server watches three source files for changes and pushes a
// fresh batchLive() snapshot to every subscribed client. A
// keepalive comment fires every 25s so proxies don't close the
// connection, and a server-side heartbeat re-emits even when no
// file changes occur so the client's readyState stays OPEN.

const _sseClients = new Set();  // Set<{ id, res }> of active SSE connections

function _sseSend(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    _sseClients.delete(client);
  }
}

function _sseBroadcast() {
  if (_sseClients.size === 0) return;
  let payload;
  try { payload = batchLive(); } catch (err) {
    payload = { error: err.message };
  }
  for (const client of _sseClients) {
    _sseSend(client, 'batch-live', payload);
  }
}

// Watch the three source files batchLive() reads.
// fs.watch fires on inode events; a 200ms debounce collapses bursts.
const _batchWatchPaths = ['batch/batch-state.tsv', 'batch/batch-input.tsv', 'batch/triage-advance.tsv'];
let _sseDebounceTimer = null;
function _sseScheduleBroadcast() {
  clearTimeout(_sseDebounceTimer);
  _sseDebounceTimer = setTimeout(_sseBroadcast, 200);
}

for (const rel of _batchWatchPaths) {
  const abs = join(ROOT, rel);
  // Watch with persistent:false so the watcher doesn't prevent exit.
  // If the file doesn't exist yet, watch the parent directory and
  // react to rename events (file creation counts as rename in fs.watch).
  try {
    if (existsSync(abs)) {
      fsWatch(abs, { persistent: false }, _sseScheduleBroadcast);
    } else {
      const parent = join(ROOT, 'batch');
      fsWatch(parent, { persistent: false }, (evt, fn) => {
        if (_batchWatchPaths.some(p => p.endsWith(fn || ''))) _sseScheduleBroadcast();
      });
    }
  } catch (_) { /* fs.watch unavailable (e.g. network FS) — SSE still works on interval */ }
}

// Fallback interval: push every 30s even without file-change events,
// so SSE clients never see stale state when fs.watch is unavailable.
// Hang-prevention Pattern 9 (2026-05-19): paired clearInterval in SIGTERM/SIGINT
// handlers below ensures launchd-managed restarts don't leak resources.
const _sseBroadcastInterval = setInterval(_sseBroadcast, 30_000);

// Keepalive comment every 25s to prevent proxy / CDN timeout disconnects.
const _sseKeepaliveInterval = setInterval(() => {
  for (const client of _sseClients) {
    try {
      client.res.write(': keepalive\n\n');
    } catch (_) {
      _sseClients.delete(client);
    }
  }
}, 25_000);

// Pattern 9: clear top-level SSE intervals on graceful shutdown so launchd
// restarts don't leak setInterval handles. Process-exit intervals are GC'd
// by the kernel; clearing them helps catch logic bugs during test runs.
function _clearSseIntervals() {
  try { clearInterval(_sseBroadcastInterval); } catch {}
  try { clearInterval(_sseKeepaliveInterval); } catch {}
}

// B3.3 (2026-05-20) — graceful shutdown. Without this, SIGTERM only cleared
// intervals; the HTTP server kept the event loop alive (still accepting new
// requests + holding open SSE streams). After launchd's graceful timeout it
// would escalate to SIGKILL → last_exit = -9 in `launchctl list`. With this
// handler, SIGTERM closes the HTTP listener, drains SSE clients, then exits 0
// — launchd reads 0 and treats the restart as healthy.
let _shuttingDown = false;
function _gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  process.stderr.write(`[dashboard-server] received ${signal} — graceful shutdown starting\n`);
  _clearSseIntervals();
  // End all SSE client streams so their open HTTP responses don't hold the
  // event loop alive past server.close().
  for (const client of _sseClients) {
    try { client.res.end(); } catch {}
  }
  _sseClients.clear();
  // Stop accepting new connections + wait for in-flight to finish.
  if (typeof server !== 'undefined' && server && server.close) {
    server.close((err) => {
      if (err) process.stderr.write(`[dashboard-server] server.close error: ${err.message}\n`);
      process.exit(0);
    });
    // Hard-exit safety net: if server.close() hangs (rare; usually due to a
    // long-running response), force-exit after 8s. launchd's graceful timeout
    // is 20s on macOS Tahoe, so 8s leaves headroom.
    setTimeout(() => {
      process.stderr.write('[dashboard-server] graceful timeout — forcing exit\n');
      process.exit(0);
    }, 8000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));

// ── HTTP server ────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
  const query = Object.fromEntries(new URLSearchParams(queryString));

  const json = (data, code = 200) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  };

  // /mark — heartbeat email "✅ Applied" one-click status flip
  if (url === '/mark') return handleMarkRequest(req, res);

  // /article-digest.md — 301 to the rendered .html. The source markdown lives
  // outside the dashboard tree (project root); the dashboard ships a Typst-
  // styled .html generated by scripts/build-article-digest.mjs. Mitchell
  // typed/bookmarked the .md path 2026-05-22 and got 404 — added this
  // redirect so any future stale link resolves cleanly.
  if (url === '/article-digest.md') {
    res.writeHead(301, { Location: '/article-digest.html', 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }

  // /reports/*.md — render markdown reports as styled HTML
  const reportHtmlMatch = url.match(/^\/reports\/(.+\.md)$/);
  if (reportHtmlMatch) {
    const reportPath = join(ROOT, 'reports', reportHtmlMatch[1]);
    if (!existsSync(reportPath)) { res.writeHead(404); res.end('Report not found'); return; }
    const md = readFileSync(reportPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderMarkdownPage(md, reportHtmlMatch[1]));
    return;
  }

  // Share-link endpoints
  if (url === '/api/share/create') {
    const { token, expires, created } = createShareToken();
    const host = req.headers.host || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const shareUrl = `${proto}://${host}/?share=${token}&demo=1`;
    return json({ token, expires, created, url: shareUrl });
  }
  if (url === '/api/share/verify') {
    const result = lookupShareToken(query.share || query.token);
    if (result.status === 'valid') return json({ valid: true, expires: result.row.expires });
    if (result.status === 'expired') return json({ valid: false, reason: 'expired', expires: result.row.expires }, 410);
    return json({ valid: false, reason: result.status }, 401);
  }

  if (url === '/api/stats') return json(computeStats());

  // Phase 6.3 follow-up (2026-05-22): /api/credentials — serves merged
  // credentials snapshot from lib/credentials.mjs. Drives the Anthropic chip
  // pop-out + Badges widget click handlers. Falls back to data/credentials/all.example.json
  // when the real all.json doesn't exist yet. Top-level request handler is
  // not async, so we use .then/.catch instead of await.
  if (url === '/api/credentials' && req.method === 'GET') {
    import('./lib/credentials.mjs')
      .then(mod => json(mod.snapshotForRender()))
      .catch(err => json({ available: false, error: String(err && err.message || err) }, 500));
    return;
  }

  // ── α ALPHA 2026-05-19: /api/contacts/stats — cheap live count for sidebar-contacts polling
  if (url === '/api/contacts/stats') {
    try {
      const path = join(ROOT, 'data', 'contacts-enriched.json');
      if (!existsSync(path)) return json({ total: 0, withEmail: 0, last_update: null });
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const entries = raw.entries || {};
      const ids = Object.keys(entries);
      let withEmail = 0;
      for (const id of ids) {
        const e = entries[id];
        if (e && (e.email_guess || e.email || (Array.isArray(e.emails) && e.emails.length))) withEmail++;
      }
      return json({ total: ids.length, withEmail, last_update: raw.last_run || raw.last_update || null });
    } catch (e) {
      return json({ total: 0, withEmail: 0, error: e.message }, 500);
    }
  }

  // ── Phase A.1 (2026-05-19): relationship-intelligence per-contact endpoints ──
  // GET /contact/:id → full server-side rendered detail page (lib/build-contact-detail-renderer.mjs)
  const contactDetailMatch = url.match(/^\/contact\/([a-z0-9-]+)$/i);
  if (contactDetailMatch && req.method === 'GET') {
    const id = contactDetailMatch[1];
    // Promise-chain import keeps the outer server callback non-async
    import('./lib/build-contact-detail-renderer.mjs').then(mod => {
      const { loadContactForDetail, renderContactDetailHtml } = mod;
      const c = loadContactForDetail(id);
      if (!c) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderContactDetailHtml(null));
      }
      const html = renderContactDetailHtml(c);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    return;
  }

  // GET /api/enrichment-queue → returns the build-time generated queue of
  // contacts awaiting an enrichment refresh. Closure 18 (2026-05-22).
  if (url === '/api/enrichment-queue' && req.method === 'GET') {
    try {
      const fp = join(ROOT, 'data', 'enrichment-queue.json');
      if (!existsSync(fp)) {
        return json({ _meta: { generated_at: null, total: 0 }, queue: [] });
      }
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      return json(data);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /api/enrichment-queue/process → reads pending entries from the
  // enrichment queue and appends each to data/refresh-master-queue.jsonl
  // so the next refresh-master tick picks them up. Caps at 10 per call to
  // avoid runaway spend. Marks entries as 'queued' in the queue file so
  // subsequent calls don't double-process. Closure 18 (2026-05-22).
  if (url === '/api/enrichment-queue/process' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const limit = Math.min(10, Math.max(1, parseInt(payload.limit, 10) || 10));
        const fp = join(ROOT, 'data', 'enrichment-queue.json');
        if (!existsSync(fp)) return json({ ok: false, error: 'enrichment-queue.json not found — run build-dashboard first' }, 404);
        const data = JSON.parse(readFileSync(fp, 'utf-8'));
        const pending = (data.queue || []).filter(q => q.status === 'pending');
        const toProcess = pending.slice(0, limit);
        const masterQueuePath = join(ROOT, 'data', 'refresh-master-queue.jsonl');
        const dispatched = [];
        for (const entry of toProcess) {
          const job_id = randomBytes(6).toString('hex');
          const rec = {
            job_id,
            cache: 'contact_enrichment',
            key: entry.contactId,
            priority: 'enrichment-queue',
            queued_at: new Date().toISOString(),
            source: 'enrichment-queue/process',
            reason: entry.reason,
          };
          appendFileSync(masterQueuePath, JSON.stringify(rec) + '\n');
          entry.status = 'queued';
          entry.dispatchedAt = new Date().toISOString();
          entry.jobId = job_id;
          dispatched.push({ contactId: entry.contactId, name: entry.name, job_id });
        }
        // Persist updated queue state so /api/enrichment-queue reflects dispatch
        writeFileSync(fp, JSON.stringify(data, null, 2));
        return json({
          ok: true,
          dispatched: dispatched.length,
          contacts: dispatched,
          remaining_pending: pending.length - dispatched.length,
          eta_minutes: 360,
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // POST /api/refresh-cache → body { cache, key, priority? }
  // Queues a single cache key for the next refresh-master tick with optional priority bump.
  if (url === '/api/refresh-cache' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cache = String(payload.cache || '').slice(0, 80);
        const key = String(payload.key || '').slice(0, 200);
        const priority = String(payload.priority || 'user-triggered').slice(0, 40);
        if (!cache || !key) return json({ ok: false, error: 'cache + key required' }, 400);
        const queuePath = join(ROOT, 'data', 'refresh-master-queue.jsonl');
        const job_id = randomBytes(6).toString('hex');
        const rec = { job_id, cache, key, priority, queued_at: new Date().toISOString(), source: 'dashboard-server' };
        appendFileSync(queuePath, JSON.stringify(rec) + '\n');
        return json({ ok: true, job_id, eta_minutes: 360 }); // next 6h tick
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // POST /api/scrape-photo → body { id, linkedin_url } → invokes scrape-contact-photo.mjs
  if (url === '/api/scrape-photo' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = String(payload.id || '').slice(0, 200);
        const linkedinUrl = String(payload.linkedin_url || '').slice(0, 400);
        if (!id || !linkedinUrl) return json({ ok: false, error: 'id + linkedin_url required' }, 400);
        // Append to scrape queue (consumed by scripts/scrape-contact-photo.mjs --queue-only mode)
        const queuePath = join(ROOT, 'data', 'contact-photo-queue.jsonl');
        const rec = { id, linkedin_url: linkedinUrl, queued_at: new Date().toISOString(), source: 'dashboard-server' };
        appendFileSync(queuePath, JSON.stringify(rec) + '\n');
        // Try to fire the script in the background (don't await)
        try {
          _spawn('node', [join(ROOT, 'scripts/scrape-contact-photo.mjs'), '--contact', id], {
            cwd: ROOT,
            detached: true,
            stdio: 'ignore',
          }).unref();
        } catch { /* spawn failure is non-fatal; queue is the durable record */ }
        return json({ ok: true, queued_at: rec.queued_at });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // POST /api/contact/:id/notes → body { text } → append to data/contact-notes/{id}.jsonl
  const contactNotesMatch = url.match(/^\/api\/contact\/([a-z0-9-]+)\/notes$/i);
  if (contactNotesMatch && req.method === 'POST') {
    const id = contactNotesMatch[1];
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const text = String(payload.text || '').slice(0, 8_000).trim();
        if (!text) return json({ ok: false, error: 'text required' }, 400);
        const dir = join(ROOT, 'data', 'contact-notes');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const path = join(dir, `${id}.jsonl`);
        const rec = { ts: new Date().toISOString(), text, source: 'dashboard-server' };
        appendFileSync(path, JSON.stringify(rec) + '\n');
        // Return updated notes list
        const raw = readFileSync(path, 'utf8');
        const notes = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return json({ ok: true, id, notes });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── Hiring-manager intel (from scripts/agents/intel-refresh.mjs --slots hm-intel) ─────
  // GET /api/hm-intel?slug=anthropic-comms-manager  → returns the JSON
  // synthesized by the 7-LLM council, or 404 if no intel exists yet.
  // The dashboard drawer fetches this lazily on row click.
  if (url === '/api/hm-intel') {
    const slug = String(query.slug || '').toLowerCase()
      .replace(/[^a-z0-9-]/g, '').slice(0, 120);
    if (!slug) return json({ ok: false, error: 'missing slug' }, 400);
    const fp = join(ROOT, 'data/hm-intel', `${slug}.json`);
    if (!existsSync(fp)) return json({ ok: false, error: 'no intel for slug', slug }, 404);
    try {
      const raw = readFileSync(fp, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(raw);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // GET /api/hm-intel/list → returns slugs that have intel files (for the
  // dashboard to know which rows have a 🔍 intel chip).
  if (url === '/api/hm-intel/list') {
    const dir = join(ROOT, 'data/hm-intel');
    if (!existsSync(dir)) return json({ slugs: [] });
    const slugs = readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => f.replace(/\.json$/, ''));
    return json({ slugs });
  }

  // ── Network database (ZETA 2026-05-19) ──────────────────────────────────
  // The popout + full-page surface that replaces the static "340 press
  // contacts" string. Backed by lib/network-database-search.mjs over
  // data/network-database.json (gitignored). `dashboard-server` itself
  // sits behind Cloudflare Access + service token; surfacing personal
  // emails here is protected by that, not by query-param secrets.

  // GET /api/network/search?q=&filters[degree]=1&page=1&pageSize=50&sort=relevance
  if (url === '/api/network/search') {
    try {
      const filters = {};
      for (const [k, v] of Object.entries(query)) {
        const m = k.match(/^filters\[(.+)\]$/);
        if (m) filters[m[1]] = v;
      }
      const r = networkSearch({
        query: query.q || '',
        filters,
        sort: query.sort || 'relevance',
        page: Number(query.page) || 1,
        pageSize: Number(query.pageSize) || 50,
      });
      return json(r);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /api/network/headline → headline counts + totals_by_target + last_run
  if (url === '/api/network/headline') {
    const h = networkDatabaseHeadline();
    if (!h) return json({ ok: false, error: 'database_not_built', last_run: null }, 404);
    return json({ ok: true, ...h });
  }

  // GET /api/network/preview → top-100 by warm_path_strength, pre-baked
  // shape suitable for first-paint of the popout.
  if (url === '/api/network/preview') {
    return json({ items: networkTopByWarmPath(100) });
  }

  // GET /api/network/person/:id → full record + resolved 2nd-degree paths
  const personMatch = url.match(/^\/api\/network\/person\/([a-z0-9-]+)$/i);
  if (personMatch && req.method === 'GET') {
    const id = personMatch[1];
    const p = networkPersonById(id);
    if (!p) return json({ ok: false, error: 'not_found', id }, 404);
    return json({ ok: true, person: networkResolveWarmIntros(p) });
  }

  // POST /api/network/person/:id/notes → write a free-text note
  // Stored in data/network-database-notes.json (gitignored). The aggregator
  // does NOT round-trip these back into the build; this is a thin overlay
  // so the popout can persist Mitchell's reminders without re-running build.
  if (personMatch && req.method === 'POST' && url.endsWith('/notes')) {
    // Path matched only if it ends with /notes (separate handler below)
  }
  const notesMatch = url.match(/^\/api\/network\/person\/([a-z0-9-]+)\/notes$/i);
  if (notesMatch && req.method === 'POST') {
    const id = notesMatch[1];
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const note = String(payload.note || '').slice(0, 5_000);
        const NOTES_PATH = join(ROOT, 'data/network-database-notes.json');
        const cur = existsSync(NOTES_PATH) ? JSON.parse(readFileSync(NOTES_PATH, 'utf-8') || '{}') : {};
        cur[id] = { note, updated_at: new Date().toISOString() };
        writeFileSync(NOTES_PATH, JSON.stringify(cur, null, 2));
        json({ ok: true, id, note });
      } catch (e) {
        json({ ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // POST /api/network/build → spawn a fresh aggregator run, return 202 + job_id
  if (url === '/api/network/build' && req.method === 'POST') {
    const jobId = randomBytes(6).toString('hex');
    const logsDir = join(ROOT, 'batch/logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `network-build-${jobId}.log`);
    try {
      const child = _spawn('node', [join(ROOT, 'scripts/build-network-database.mjs'), '--verbose'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
      });
      const out = (data) => appendFileSync(logPath, data);
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.unref();
      return json({ ok: true, jobId, log_path: logPath, status_url: `/api/network/build-status?job_id=${jobId}` }, 202);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /api/network/build-status?job_id=...
  if (url === '/api/network/build-status' && req.method === 'GET') {
    const jobId = String(query.job_id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    if (!jobId) return json({ ok: false, error: 'missing job_id' }, 400);
    const logPath = join(ROOT, 'batch/logs', `network-build-${jobId}.log`);
    if (!existsSync(logPath)) return json({ ok: true, jobId, status: 'pending', log: '' });
    const log = readFileSync(logPath, 'utf-8');
    const isDone = /\[zeta\]\s+per-target counts:/.test(log);
    return json({ ok: true, jobId, status: isDone ? 'completed' : 'running', log: log.slice(-4000) });
  }

  // POST /api/network/enrich/:id → kick off Z.3 enricher for one person
  const enrichMatch = url.match(/^\/api\/network\/enrich\/([a-z0-9-]+)$/i);
  if (enrichMatch && req.method === 'POST') {
    const id = enrichMatch[1];
    const jobId = randomBytes(6).toString('hex');
    const logsDir = join(ROOT, 'batch/logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `network-enrich-${jobId}.log`);
    try {
      const child = _spawn('node', [join(ROOT, 'scripts/agents/network-enricher.mjs'), '--person', id], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
      });
      const out = (data) => appendFileSync(logPath, data);
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.unref();
      return json({ ok: true, jobId, person_id: id, log_path: logPath, status_url: `/api/network/build-status?job_id=${jobId}` }, 202);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /api/network/find-email/:id → kick off Z.4 emailer for one person
  const emailMatch = url.match(/^\/api\/network\/find-email\/([a-z0-9-]+)$/i);
  if (emailMatch && req.method === 'POST') {
    const id = emailMatch[1];
    const jobId = randomBytes(6).toString('hex');
    const logsDir = join(ROOT, 'batch/logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, `network-email-${jobId}.log`);
    try {
      const child = _spawn('node', [join(ROOT, 'scripts/agents/network-emailer.mjs'), '--person', id], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
      });
      const out = (data) => appendFileSync(logPath, data);
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      child.unref();
      return json({ ok: true, jobId, person_id: id, log_path: logPath, status_url: `/api/network/build-status?job_id=${jobId}` }, 202);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /api/network/export?filters[...]=...&format=csv → CSV download of
  // the filtered set. Used by the full-page view's "Export CSV" button.
  if (url === '/api/network/export') {
    try {
      const filters = {};
      for (const [k, v] of Object.entries(query)) {
        const m = k.match(/^filters\[(.+)\]$/);
        if (m) filters[m[1]] = v;
      }
      const r = networkSearch({
        query: query.q || '',
        filters,
        sort: query.sort || 'relevance',
        page: 1,
        pageSize: 100_000, // cap by total count
      });
      const cols = ['full_name', 'current_company', 'current_role', 'linkedin_url', 'x_url', 'degree', 'warm_to', 'professional_emails', 'connected_on'];
      const rows = [cols.join(',')];
      const csvEscape = (s) => {
        const v = s == null ? '' : String(s);
        if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
        return v;
      };
      for (const p of r.hits) {
        const warmSlugs = (p.warm_to_target_companies || []).map(w => w.company_slug).join('|');
        const profEmails = (p.emails?.professional || []).map(e => `${e.email}:${e.confidence}`).join('|');
        rows.push([
          p.full_name, p.current_company, p.current_role,
          p.linkedin_url, p.x_url, p.degree,
          warmSlugs, profEmails, p.connected_on,
        ].map(csvEscape).join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="network-database-${new Date().toISOString().slice(0,10)}.csv"`,
        'Cache-Control': 'no-store',
      });
      return res.end(rows.join('\n'));
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /api/network/draft-intro → draft a LinkedIn DM in Mitchell's voice
  // (ζ needhuman-resolution 2026-05-19, Decision ζ.3)
  //
  // Body: { person_id: string, target_company: string, format?: "connection"|"dm" }
  //   person_id       — stable ID from network-database.json
  //   target_company  — company slug the person can warm-intro Mitchell to
  //   format          — "connection" (≤300 chars) | "dm" (default, post-connection)
  //
  // Voice: Mitchell's LinkedIn-DM register, calibrated from:
  //   - writing-samples/voice-reference.md (canonical exemplar rank=highest)
  //   - feedback_linkedin_outreach_voice.md (4 structural rules)
  //   - modes/contacto.md (3-sentence framework per contact type)
  //
  // Spawns scripts/agents/network-draft-intro.mjs (single Sonnet call, ~$0.003/call).
  // Returns synchronously by waiting for the child process to complete (≤10s timeout).
  if (url === '/api/network/draft-intro' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const personId     = String(payload.person_id     || '').replace(/[^a-z0-9-]/gi, '').slice(0, 120);
        const targetCompany = String(payload.target_company || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
        const format        = ['connection', 'dm'].includes(payload.format) ? payload.format : 'dm';

        if (!personId)      return json({ ok: false, error: 'person_id is required' }, 400);
        if (!targetCompany) return json({ ok: false, error: 'target_company is required' }, 400);

        // Validate person exists before spending an LLM call
        const person = networkPersonById(personId);
        if (!person) return json({ ok: false, error: `person not found: ${personId}` }, 404);

        const warmPath = (person.warm_to_target_companies || []).find(
          w => w.company_slug === targetCompany
        );
        if (!warmPath) return json({
          ok: false,
          error: `${person.full_name} has no warm path to ${targetCompany}`,
          warm_companies: (person.warm_to_target_companies || []).map(w => w.company_slug),
        }, 422);

        // Spawn the draft-intro agent and wait for it to complete synchronously
        // (short-lived Sonnet call — typically 2-5s). _spawnSync imported at top.
        const args = [
          join(ROOT, 'scripts/agents/network-draft-intro.mjs'),
          '--person', personId,
          '--target-company', targetCompany,
          '--format', format,
        ];
        const result = _spawnSync('node', args, {
          cwd: ROOT,
          env: process.env,
          timeout: 30_000, // 30s hard cap
          encoding: 'utf-8',
        });

        if (result.status !== 0 || result.error) {
          const errMsg = result.error?.message || result.stderr?.slice(0, 400) || 'unknown error';
          return json({ ok: false, error: errMsg }, 500);
        }

        let parsed;
        try {
          parsed = JSON.parse(result.stdout || '{}');
        } catch {
          return json({ ok: false, error: 'draft-intro agent returned invalid JSON', raw: result.stdout?.slice(0, 400) }, 500);
        }

        return json(parsed, parsed.ok ? 200 : 500);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // ── Pipeline processing — "Run Batch" + "Process All" buttons ───────────
  // Two flows the dashboard can trigger:
  //  • Run Batch       → batch-runner-batches.mjs run  (existing queue only)
  //  • Process All     → triage + batch + rebuild + optional email
  //
  // GET  /api/pipeline/preview        → counts + cost estimate + budget state
  // POST /api/pipeline/process-all    → kick off the chain
  // POST /api/batch/run               → kick off batch-only
  // GET  /api/pipeline/job-status     → poll a running job
  if (url === '/api/pipeline/preview') {
    return json(buildPipelinePreview());
  }
  // 2026-05-20 — Single-row re-eval triggered by the ↻ Re-score button on
  // a row's alignment bars. P1.12 wiring: dispatch to scripts/rescore-row.mjs
  // (resolves row → url + company + role + id from applications.md, then
  // delegates to phase3b-evaluator.mjs) as a detached child + returns
  // immediately. Logs to batch/logs/rescore-<row>-<ts>.log.
  if (url === '/api/eval/rescore' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const row = String(parsed.row || '').trim();
      if (!/^\d+$/.test(row)) return json({ ok: false, error: 'row must be a positive integer' }, 400);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = join(ROOT, 'batch/logs/rescore-' + row + '-' + ts + '.log');
      try {
        const { spawn } = await import('node:child_process');
        const { openSync, mkdirSync, existsSync } = await import('node:fs');
        const logDir = join(ROOT, 'batch/logs');
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        const child = spawn('node', [join(ROOT, 'scripts/rescore-row.mjs'), '--row', row], {
          cwd: ROOT,
          detached: true,
          stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
          env: { ...process.env, RESCORE_TRIGGER: 'dashboard-ui' },
        });
        child.unref();
        return json({ ok: true, row, job_id: 'rescore-' + row + '-' + ts, log_path: logPath.replace(ROOT + '/', '') });
      } catch (e) {
        return json({ ok: false, error: 'spawn failed: ' + e.message }, 500);
      }
    });
    return;
  }
  if (url === '/api/pipeline/per-company-preview') {
    // Task 2 (2026-05-16): per-company breakdown for the 2-phase Process All
    // modal. Returns one row per unique company in the Apply-Now queue with
    // score + TTO + toxicity + cache-hit + cost estimate so the user can
    // inspect / uncheck rows before confirming the orchestrator run.
    //
    // Anti-breakage env kill switch (calibration brief 2026-05-16): set
    // PROCESS_ALL_V2_PREVIEW_ENABLED=false to disable the new endpoint without
    // a code change. Client (scripts/build-dashboard.mjs) detects the 410 and
    // falls back to the existing single-phase v1 modal flow automatically.
    if (process.env.PROCESS_ALL_V2_PREVIEW_ENABLED === 'false') {
      return json({ ok: false, error: 'v2 preview disabled via PROCESS_ALL_V2_PREVIEW_ENABLED env', disabled: true }, 410);
    }
    return json(buildPerCompanyPipelinePreview());
  }
  if (url === '/api/pipeline/exclude-company' && req.method === 'POST') {
    // Task 2 — "Trash" action on the per-company preview table. Appends a
    // company slug to data/excluded-companies.json under the user-defined
    // "manual_exclusion" category so it auto-trashes on future scans.
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const company = String(parsed.company || '').trim();
      const rationale = String(parsed.rationale || '').trim();
      if (!company) return json({ ok: false, error: 'company required' }, 400);
      if (rationale.length > 500) return json({ ok: false, error: 'rationale too long (500 char max)' }, 400);
      const slug = _slugifyCompanyForIntel(company);
      if (!slug) return json({ ok: false, error: 'company slug empty after normalization' }, 400);
      const fp = join(ROOT, 'data/excluded-companies.json');
      let data;
      try {
        data = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf-8')) : { _schema_version: 1, categories: {} };
      } catch (e) {
        return json({ ok: false, error: 'failed to load excluded-companies.json: ' + e.message }, 500);
      }
      data.categories = data.categories || {};
      const cat = data.categories.manual_exclusion || (data.categories.manual_exclusion = {
        rationale: 'Companies manually trashed from the Process All preview modal. Auto-excluded on future scans until the user removes the slug.',
        companies: [],
        aliases: {},
        manual_entries: [],
      });
      cat.companies = Array.isArray(cat.companies) ? cat.companies : [];
      cat.manual_entries = Array.isArray(cat.manual_entries) ? cat.manual_entries : [];
      const alreadyHas = cat.companies.includes(slug);
      if (!alreadyHas) cat.companies.push(slug);
      cat.manual_entries.push({
        slug,
        company_label: company,
        rationale: rationale || '(no rationale provided)',
        added_at: new Date().toISOString(),
        source: 'process-all-modal',
      });
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        writeFileSync(fp, JSON.stringify(data, null, 2));
      } catch (e) {
        return json({ ok: false, error: 'failed to persist: ' + e.message }, 500);
      }
      return json({ ok: true, slug, idempotent: alreadyHas });
    });
    return;
  }
  if (url === '/api/pipeline/build-apply-pack' && req.method === 'POST') {
    // Task 2 — "Skip-to-apply-pack" action on the per-company preview table.
    // Spawns scripts/build-apply-pack.mjs for a single row so the user can
    // fast-track a high-confidence company into the apply-pack folder without
    // running the full orchestrator. Idempotent (build-apply-pack handles it).
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const row = parseInt(parsed.row, 10);
      if (!Number.isFinite(row) || row < 1) return json({ ok: false, error: 'row (int) required' }, 400);
      const jobId = 'pack-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
      const logPath = `/tmp/apply-pack-${jobId}.log`;
      try {
        import('child_process').then(({ spawn }) => {
          const proc = spawn('node', [join(ROOT, 'scripts/build-apply-pack.mjs'), `--row=${row}`], {
            cwd: ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          });
          proc.stdout?.on('data', c => { try { appendFileSync(logPath, c); } catch {} });
          proc.stderr?.on('data', c => { try { appendFileSync(logPath, '[stderr] ' + c); } catch {} });
          proc.unref();
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
      return json({ ok: true, row, jobId, log_path: logPath });
    });
    return;
  }
  // ── Drawer "Create Materials" — single-row apply-pack from the right-rail
  // POST /api/drawer/build-apply-pack
  //   Body: { rowNum: number, force?: boolean }
  //   Behavior:
  //     1) Verify the row exists in data/applications.md (via appsByNum cache)
  //     2) Detect existing apply-pack/{NNN}-*/ — return 409 with the path
  //        unless force:true
  //     3) Cost cap: PER_RUN_CAP_APPLY_PACK_USD ($5 default). If estimate
  //        exceeds the cap, return 402 unless force:true
  //     4) Spawn `node scripts/build-apply-pack.mjs --row=N [--force]` detached,
  //        stream stdout/stderr to /tmp/build-apply-pack-{jobId}.log
  //     5) Record a job row in data/pipeline-process-state.json so the existing
  //        /api/pipeline/job-status endpoint + the new
  //        /api/drawer/apply-pack-status alias can both poll it
  //
  // 2026-05-17 — switched from build-apply-pack.mjs (stub scaffold) to
  // build-apply-packs.mjs (canonical full builder: cover-letter via voice-
  // reference-brief.md + humanize-check gate, form-fields with AI-detection
  // flags, ATS keyword check, interview-prep, LinkedIn DMs, formatting
  // guide). Mitchell's mega-list 2026-05-17 explicitly asked for the full
  // artifact pipeline through voice corpus + checks + revisions on the
  // Create Materials drawer button.
  if (url === '/api/drawer/build-apply-pack' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const rowNum = parseInt(parsed.rowNum ?? parsed.row, 10);
      const force  = !!parsed.force;
      if (!Number.isFinite(rowNum) || rowNum < 1) {
        return json({ ok: false, error: 'rowNum (positive integer) required' }, 400);
      }

      // 1) Row must exist
      const app = appsByNum().get(String(rowNum));
      if (!app) {
        return json({ ok: false, error: `Row #${rowNum} not found in data/applications.md` }, 404);
      }

      // 2) Existing apply-pack detection — mirror the script's folder-naming
      //    convention: apply-pack/{NNN}-{slug}. We can't reproduce the exact
      //    slug without re-running slugify on the same fields, so we glob the
      //    parent dir for any folder starting with the 3-digit row prefix.
      const APPLY_PACK_ROOT = join(ROOT, 'apply-pack');
      const prefix = String(rowNum).padStart(3, '0') + '-';
      let existingDir = null;
      if (existsSync(APPLY_PACK_ROOT)) {
        try {
          for (const f of readdirSync(APPLY_PACK_ROOT)) {
            if (f.startsWith(prefix)) {
              const full = join(APPLY_PACK_ROOT, f);
              try {
                if (statSync(full).isDirectory()) { existingDir = full; break; }
              } catch {}
            }
          }
        } catch {}
      }
      if (existingDir && !force) {
        return json({
          ok: false,
          error: 'Apply-pack already exists; pass force:true to regenerate.',
          already_exists: true,
          existing_dir: existingDir.replace(ROOT + '/', ''),
        }, 409);
      }

      // 3) Cost cap
      const estimatedCost = COST_PER_APPLY_PACK_USD;
      if (estimatedCost > PER_RUN_CAP_APPLY_PACK && !force) {
        return json({
          ok: false,
          error: `Estimated $${estimatedCost.toFixed(2)} exceeds per-run cap $${PER_RUN_CAP_APPLY_PACK.toFixed(2)}. Pass force:true to override or raise PER_RUN_CAP_APPLY_PACK_USD.`,
          cap_exceeded: 'per_run',
          estimated_cost_usd: estimatedCost,
          cap_usd: PER_RUN_CAP_APPLY_PACK,
        }, 402);
      }

      // 4) Spawn the script
      const jobId = 'drawer-pack-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
      const logPath = `/tmp/build-apply-pack-${jobId}.log`;
      // Compute the expected output dir for the client toast/link. The script
      // uses `${pad3(row)}-${slugify(company + '-' + role)}`. We can replicate
      // slugify locally — it's a single regex pipeline (see build-apply-pack.mjs:47).
      const expectedSlug = (app.company + '-' + app.role)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
      const expectedDir = `apply-pack/${prefix}${expectedSlug}`;
      try {
        // 2026-05-17 — call the canonical full builder (plural) which writes
        // the full ~12-file pack including cover-letter w/ humanize gate,
        // form-fields w/ AI-detection flags, ATS check, interview-prep, etc.
        // The plural script uses --num=N (not --row=N).
        const scriptArgs = [join(ROOT, 'scripts/build-apply-packs.mjs'), `--num=${rowNum}`];
        if (force) scriptArgs.push('--force');
        import('child_process').then(({ spawn }) => {
          const proc = spawn('node', scriptArgs, {
            cwd: ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          });
          proc.stdout?.on('data', c => { try { appendFileSync(logPath, c); } catch {} });
          proc.stderr?.on('data', c => { try { appendFileSync(logPath, '[stderr] ' + c); } catch {} });
          proc.on('exit', (code) => {
            // Persist the terminal state so /api/pipeline/job-status returns
            // status=completed|failed after the process actually exits.
            try {
              const state = loadPipelineProcessState();
              if (state.jobs?.[jobId]) {
                state.jobs[jobId].status = code === 0 ? 'completed' : 'failed';
                state.jobs[jobId].exit_code = code;
                state.jobs[jobId].finished_at = new Date().toISOString();
                if (code !== 0) state.jobs[jobId].error = `build-apply-packs.mjs exited ${code}`;
                writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2));
              }
            } catch {}
            // E4 (2026-05-22): on successful CREATE, push consumer artifacts to
            // Drive originals/. Best-effort; failures log + continue.
            if (code === 0) {
              import('./lib/drive-sync.mjs').then(({ pushCreateOriginals, driveEnabled }) => {
                if (!driveEnabled()) return;
                const localDir = join(ROOT, expectedDir);
                if (!existsSync(localDir)) return;
                const slugBase = basename(localDir);
                pushCreateOriginals({ slug: slugBase, localDir })
                  .then(r => { try { appendFileSync(logPath, '\n[drive] pushCreateOriginals: ' + JSON.stringify(r) + '\n'); } catch {} })
                  .catch(e => { try { appendFileSync(logPath, '\n[drive] pushCreateOriginals failed: ' + (e?.message || e) + '\n'); } catch {} });
              }).catch(() => { /* drive-sync import failed; skip */ });
            }
          });
          proc.unref();
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }

      // 5) Record the job in pipeline-process-state.json so the existing
      //    /api/pipeline/job-status (and our new alias) can poll it.
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        const state = loadPipelineProcessState();
        state.jobs[jobId] = {
          jobId,
          type:         'drawer-apply-pack',
          status:       'running',
          started_at:   new Date().toISOString(),
          row_num:      rowNum,
          company:      app.company,
          role:         app.role,
          expected_dir: expectedDir,
          force:        force,
          log_path:     logPath,
        };
        writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2));
      } catch {}

      return json({
        ok: true,
        jobId,
        row_num: rowNum,
        log_path: logPath,
        expected_dir: expectedDir,
        company: app.company,
        role: app.role,
        force,
        estimated_cost_usd: estimatedCost,
        status_url: `/api/drawer/apply-pack-status?job_id=${jobId}`,
      });
    });
    return;
  }
  // GET /api/drawer/apply-pack-status?job_id=X
  //   Thin alias over /api/pipeline/job-status, kept under the drawer
  //   namespace so future drawer-specific fields (e.g. file_count, README
  //   ready-state) can be appended without touching the pipeline status path.
  if (url === '/api/drawer/apply-pack-status' && req.method === 'GET') {
    const jobId = String(query.job_id || '');
    if (!jobId) return json({ ok: false, error: 'missing job_id' }, 400);
    const state = loadPipelineProcessState();
    const job = state.jobs?.[jobId];
    if (!job) return json({ ok: false, error: 'job not found' }, 404);
    // Pull tail of log for the modal
    let tail = [];
    if (job.log_path && existsSync(job.log_path)) {
      try {
        const lines = readFileSync(job.log_path, 'utf-8').split('\n').filter(Boolean);
        tail = lines.slice(-20);
      } catch {}
    }
    // Detect README so the client can offer a deep link the moment the
    // script writes it (build-apply-pack.mjs writes README.md first).
    let readmeRel = null;
    if (job.expected_dir) {
      const readmeAbs = join(ROOT, job.expected_dir, 'README.md');
      if (existsSync(readmeAbs)) readmeRel = `${job.expected_dir}/README.md`;
    }
    return json({ ok: true, job, log_tail: tail, readme_rel: readmeRel });
  }

  // ── PR-03 (2026-05-25) — Drawer auto-enrich dispatch + SSE ───────────────
  // Generic auto-spawn endpoint that replaces 5 CRIT/HIGH CLI-instruction
  // leakage sites in the drawer with a single dispatch primitive.
  // Spec: .claude/audit/apply-now-ux-audit-2026-05-25/strategy.md §4 R13-R20
  // Lib: lib/drawer-auto-enrich.mjs
  //
  // POST body: { rowId, slot, confirmed_at?, slug? }
  // Returns:   { ok, job_id, eta_seconds, est_cost_usd, state, cache_path? }
  //
  // Feature flag: DRAWER_AUTO_ENRICH=false to no-op (returns 503).
  if (url === '/api/drawer/auto-enrich' && req.method === 'POST') {
    if (String(process.env.DRAWER_AUTO_ENRICH || 'true') === 'false') {
      return json({ ok: false, state: 'disabled', error: 'DRAWER_AUTO_ENRICH feature flag is off' }, 503);
    }
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 4 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

      const rowId = parsed.rowId ?? parsed.row;
      const slot = String(parsed.slot || '').trim();
      const confirmed_at = parsed.confirmed_at || null;
      const slug = parsed.slug ? String(parsed.slug).trim() : null;

      // env-shadow rule: lazy-loaded dotenv MUST use override:true per
      // env-shadow-on-lazy-dotenv bug class (AGENTS.md). The dispatcher
      // spawns subprocess agents that read process.env directly, so we
      // proactively reload .env so the spawned children inherit fresh values.
      try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: join(ROOT, '.env'), override: true });
      } catch { /* dotenv missing — fall through */ }

      try {
        // PR-08 (2026-05-25) — strategy-ceiling slot has its own per-row+day
        // cap to bound retry spend on chronic LLM outages. Check BEFORE
        // dispatching so we never burn the budget on a row that's exhausted.
        if (slot === 'strategy-ceiling') {
          try {
            const sc = await import('./lib/strategy-ceiling.mjs');
            // Use the cache-key from parsed.metric_key if passed (drawer renderer
            // knows it); otherwise fall back to the slot label.
            const metricKey = String(parsed.metric_key || 'strategy').slice(0, 80);
            // incrementRetryCount runs the pre-check internally; we mirror its
            // logic by importing _retryAvailability via the module's side-channel.
            // To avoid exporting private helpers, call incrementRetryCount AFTER
            // successful dispatch (so a 4xx doesn't burn a count). The pre-check
            // is via a dry-read of the counter file path. Simpler: call
            // incrementRetryCount and rely on its return to gate the dispatch.
            const after = sc.incrementRetryCount(metricKey, rowId);
            if (after.remaining < 0 || (after.used > after.cap)) {
              return json({
                ok: false,
                state: 'error',
                error: `Daily retry cap reached (${after.cap}/day for this row+metric). Resets at midnight PT.`,
                daily_cap_reached: true,
                retry_used: after.used,
                retry_cap: after.cap,
              }, 429);
            }
          } catch { /* best-effort — never block on counter failure */ }
        }
        const { dispatchAutoEnrich } = await import('./lib/drawer-auto-enrich.mjs');
        const result = await dispatchAutoEnrich({ rowId, slot, confirmed_at, slug });
        const statusCode = result.requires_confirmation ? 403
          : result.daily_cap_reached ? 429
          : result.ok ? 200
          : 400;
        return json(result, statusCode);
      } catch (err) {
        return json({ ok: false, state: 'error', error: err.message || String(err) }, 500);
      }
    });
    return;
  }

  // ── PR-03 (2026-05-25) — Drawer auto-enrich job-status SSE stream ────────
  // Endpoint: GET /api/drawer/jobs/:job_id/events
  // Streams:
  //   event: progress      — keepalive heartbeat every ≤30s
  //   event: cache_written — when target cache file is written (mtime > start)
  //   event: complete      — when job state transitions to complete
  //   event: error         — on job error
  //
  // Auto-closes on cache_written/complete/error, or after 5 min (per CLAUDE.md
  // hang-prevention rule + convergence-impossible-runaway prevention).
  const drawerJobsMatch = url.match(/^\/api\/drawer\/jobs\/([A-Za-z0-9._-]+)\/events$/);
  if (drawerJobsMatch) {
    const jobId = drawerJobsMatch[1];
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    (async () => {
      // Lazy import + initial state
      let jobState = null;
      try {
        const mod = await import('./lib/drawer-auto-enrich.mjs');
        jobState = mod.readJobState(jobId);
      } catch {}
      if (!jobState) {
        try { res.write('event: error\ndata: ' + JSON.stringify({ error: 'job not found', job_id: jobId }) + '\n\n'); } catch {}
        try { res.end(); } catch {}
        return;
      }

      const cachePath = jobState.cache_path || null;
      const startMtime = jobState.cache_mtime_at_start || 0;
      let closed = false;
      function safeWrite(s) {
        if (closed) return;
        try { res.write(s); } catch { closed = true; }
      }
      function safeClose() {
        if (closed) return;
        closed = true;
        try { res.end(); } catch {}
      }

      // Send initial snapshot
      safeWrite('event: progress\ndata: ' + JSON.stringify({
        job_id: jobId,
        state: jobState.state,
        eta_seconds: jobState.eta_seconds,
        slot: jobState.slot,
        rowId: jobState.rowId,
      }) + '\n\n');

      // Poll loop — checks job state + cache mtime every 5s, emits events.
      // 5min hard timeout per hang-prevention.
      const POLL_INTERVAL_MS = 5000;
      const MAX_LIFETIME_MS = 5 * 60 * 1000;
      const KEEPALIVE_INTERVAL_MS = 25000;
      const startedAt = Date.now();
      let lastKeepalive = startedAt;

      const poll = setInterval(async () => {
        if (closed) { clearInterval(poll); return; }
        // Hard timeout
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          safeWrite('event: error\ndata: ' + JSON.stringify({ error: 'event stream lifetime exceeded (5min)', job_id: jobId }) + '\n\n');
          clearInterval(poll);
          safeClose();
          return;
        }
        // Re-read job state
        let cur = null;
        try {
          const mod = await import('./lib/drawer-auto-enrich.mjs');
          cur = mod.readJobState(jobId);
        } catch {}
        if (!cur) {
          // Job state vanished — could be job-TTL expiry or write error
          safeWrite('event: error\ndata: ' + JSON.stringify({ error: 'job state lost', job_id: jobId }) + '\n\n');
          clearInterval(poll);
          safeClose();
          return;
        }
        // Check cache file mtime
        if (cachePath && existsSync(cachePath)) {
          try {
            const m = statSync(cachePath).mtimeMs;
            if (m > startMtime) {
              safeWrite('event: cache_written\ndata: ' + JSON.stringify({
                job_id: jobId,
                cache_path: cachePath.replace(ROOT + '/', ''),
                state: cur.state,
                slot: cur.slot,
                rowId: cur.rowId,
              }) + '\n\n');
              clearInterval(poll);
              safeClose();
              return;
            }
          } catch {}
        }
        // State transitions
        if (cur.state === 'complete') {
          safeWrite('event: complete\ndata: ' + JSON.stringify({ job_id: jobId, state: 'complete' }) + '\n\n');
          clearInterval(poll);
          safeClose();
          return;
        }
        if (cur.state === 'error') {
          safeWrite('event: error\ndata: ' + JSON.stringify({ job_id: jobId, error: cur.error || 'unknown error' }) + '\n\n');
          clearInterval(poll);
          safeClose();
          return;
        }
        // Keepalive
        if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
          safeWrite(': keepalive\n\n');
          lastKeepalive = Date.now();
        }
      }, POLL_INTERVAL_MS);

      req.on('close', () => { closed = true; clearInterval(poll); });
      req.on('error', () => { closed = true; clearInterval(poll); });
      // SIGTERM handler hook — when dashboard-server reloads, close all streams
      // gracefully. The keep-alive ensures the connection won't appear dead.
    })().catch((err) => {
      try { res.write('event: error\ndata: ' + JSON.stringify({ error: err?.message || String(err) }) + '\n\n'); } catch {}
      try { res.end(); } catch {}
    });
    return;
  }

  // GET /api/drawer/jobs/:job_id — one-shot state lookup (polling fallback)
  const drawerJobStateMatch = url.match(/^\/api\/drawer\/jobs\/([A-Za-z0-9._-]+)$/);
  if (drawerJobStateMatch && req.method === 'GET') {
    const jobId = drawerJobStateMatch[1];
    (async () => {
      try {
        const { readJobState } = await import('./lib/drawer-auto-enrich.mjs');
        const state = readJobState(jobId);
        if (!state) return json({ ok: false, error: 'job not found or expired', job_id: jobId }, 404);
        return json({ ok: true, job: state });
      } catch (err) {
        return json({ ok: false, error: err.message || String(err) }, 500);
      }
    })();
    return;
  }

  if (url === '/api/pipeline/defer-company' && req.method === 'POST') {
    // Task 2 — "Defer" action on the per-company preview table. Writes a row
    // to data/deferred-companies.jsonl (gitignored) so the next Process All
    // can skip the company. Not the same as exclude — deferred companies are
    // retried on the next manual review; excluded companies are permanent.
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const company = String(parsed.company || '').trim();
      if (!company) return json({ ok: false, error: 'company required' }, 400);
      const slug = _slugifyCompanyForIntel(company);
      const entry = {
        ts: new Date().toISOString(),
        slug,
        company_label: company,
        reason: String(parsed.reason || '').slice(0, 500),
        source: 'process-all-modal',
      };
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        appendFileSync(join(ROOT, 'data/deferred-companies.jsonl'), JSON.stringify(entry) + '\n');
      } catch (e) {
        return json({ ok: false, error: 'failed to persist: ' + e.message }, 500);
      }
      return json({ ok: true, slug });
    });
    return;
  }
  if (url === '/api/recruiter-pipeline-density' || url === '/api/runway-detail') {
    // Endpoints retired 2026-05-25 alongside the runway-coupling sweep.
    // The compute functions (`computeRecruiterPipelineDensity`,
    // `computeRunwayDetail`) and their consumers (sidebar widget, popout
    // modal, heartbeat banner) were removed across PR #222, PR #233, and
    // this follow-up sweep. Returns HTTP 410 Gone so any stale poller
    // visibly fails instead of silently getting an empty body.
    return json({ ok: false, error: 'endpoint retired 2026-05-25' }, 410);
  }
  if (url === '/api/discard-with-reason' && req.method === 'POST') {
    // Item #1 from 2026-05-16 incomplete-task review: capture WHY a row was
    // discarded so the next eval run can avoid the same anti-pattern. Reasons
    // append to data/discard-reasons.jsonl (gitignored — personal data).
    // Future: triage prompt enrichment consumes recent reasons + heartbeat
    // email surfaces a "rejected pattern of the week" section.
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const rowNum = parseInt(parsed.row_num, 10);
      const reason = String(parsed.reason || '').trim();
      const company = String(parsed.company || '').trim();
      const role    = String(parsed.role    || '').trim();
      if (!rowNum || !reason) return json({ ok: false, error: 'row_num and reason required' }, 400);
      if (reason.length > 1000) return json({ ok: false, error: 'reason too long (1000 char max)' }, 400);
      const entry = {
        ts: new Date().toISOString(),
        row_num: rowNum,
        company,
        role,
        reason,
        // Tags help the triage prompt group reasons over time
        tag: classifyDiscardReason(reason),
      };
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        appendFileSync(join(ROOT, 'data/discard-reasons.jsonl'), JSON.stringify(entry) + '\n');
      } catch (e) {
        return json({ ok: false, error: 'failed to persist: ' + e.message }, 500);
      }
      return json({ ok: true, entry });
    });
    return;
  }
  // ── POST /api/dismiss-row ────────────────────────────────────────────────
  // β.1: DISMISS a row from Apply-Now queue until midnight PT (day-only).
  // Does NOT change Status in applications.md. Reads/writes
  // data/apply-now-dismissed.json (gitignored). Expires at midnight PT.
  // Body: { num: <integer> }
  // DELETE /api/dismiss-row?num=<n>  — explicitly un-dismiss (optional)
  if (url === '/api/dismiss-row' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const rowNum = parseInt(parsed.num, 10);
      if (!rowNum) return json({ ok: false, error: 'num required (positive integer)' }, 400);
      dismissRow(rowNum);
      return json({ ok: true, num: rowNum, dismissed_until: loadDismissed()[String(rowNum)] });
    });
    return;
  }
  if (url.startsWith('/api/dismiss-row') && req.method === 'DELETE') {
    const numStr = new URLSearchParams(url.split('?')[1] || '').get('num');
    const rowNum = parseInt(numStr, 10);
    if (!rowNum) return json({ ok: false, error: 'num query param required' }, 400);
    undismissRow(rowNum);
    return json({ ok: true, num: rowNum, undismissed: true });
  }
  if (url === '/api/discard-reasons/recent') {
    // Surfaced by heartbeat + future triage prompt enrichment. Last 30 entries.
    const fp = join(ROOT, 'data/discard-reasons.jsonl');
    if (!existsSync(fp)) return json({ ok: true, entries: [] });
    try {
      const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      const recent = lines.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return json({ ok: true, entries: recent.reverse() });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }
  // ── POST /api/toxicity-override ─────────────────────────────────────────
  // Inventory item #4 (2026-05-18): records Mitchell's tradeoff override when
  // he wants to apply to a flagged company anyway. Append to
  // data/toxicity-overrides.jsonl (gitignored). Consumed by computeToxicityComposite
  // at next dashboard build; surfaces in the drill-in render.
  //
  // Hard rule: this endpoint NEVER auto-trashes or auto-applies — it only
  // records the override decision. Mitchell still hits Apply via the normal flow.
  if (url === '/api/toxicity-override' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const slug = String(parsed.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const reason = String(parsed.override_reason || '').trim();
      if (!slug)   return json({ ok: false, error: 'slug required' }, 400);
      if (!reason) return json({ ok: false, error: 'override_reason required' }, 400);
      if (reason.length > 1000) return json({ ok: false, error: 'reason too long (1000 char max)' }, 400);
      const entry = {
        ts: new Date().toISOString(),
        slug,
        override_reason: reason,
      };
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        appendFileSync(join(ROOT, 'data/toxicity-overrides.jsonl'), JSON.stringify(entry) + '\n');
      } catch (e) {
        return json({ ok: false, error: 'failed to persist: ' + e.message }, 500);
      }
      return json({ ok: true, entry });
    });
    return;
  }
  // ── GET /api/toxicity-override/list?slug=X ──────────────────────────────
  // Returns existing overrides for a given slug (useful for the heartbeat
  // and any future per-company override list view).
  if (url.startsWith('/api/toxicity-override/list') && req.method === 'GET') {
    try {
      const parsed = new URL('http://localhost' + url);
      const slug = (parsed.searchParams.get('slug') || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const fp = join(ROOT, 'data/toxicity-overrides.jsonl');
      if (!existsSync(fp)) return json({ ok: true, entries: [] });
      const lines = readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = slug ? entries.filter(e => e.slug === slug) : entries;
      return json({ ok: true, entries: filtered });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // ── POST /api/queue-research ────────────────────────────────────────────
  // Queues a researcher-agent run by writing data/company-research-queue/{slug}.json.
  // Picked up by scripts/company-research-worker.mjs (cron). Sections supported:
  // 'all', 'toxicity', 'comp-range', 'reviews', 'social-signals', 'ipo-funding',
  // 'funding-cycles'. Repeated POSTs for the same slug merge into one queue file
  // with section history so we don't lose a request between cron ticks.
  if (url === '/api/queue-research' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const slug = String(parsed.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const section = String(parsed.section || 'all').toLowerCase().replace(/[^a-z0-9-]+/g, '');
      const ts = parsed.ts || new Date().toISOString();
      if (!slug)    return json({ ok: false, error: 'slug required' }, 400);
      if (!section) return json({ ok: false, error: 'section required' }, 400);
      const queueDir = join(ROOT, 'data/company-research-queue');
      try {
        if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });
        const fp = join(queueDir, slug + '.json');
        let existing = { slug, sections: [], created_at: ts, updated_at: ts };
        if (existsSync(fp)) {
          try { existing = JSON.parse(readFileSync(fp, 'utf-8')); } catch (_) {}
        }
        existing.sections = existing.sections || [];
        existing.sections.push({ section, ts });
        existing.updated_at = ts;
        existing.slug = slug;
        writeFileSync(fp, JSON.stringify(existing, null, 2));
        return json({ ok: true, slug, section, queue_file: 'data/company-research-queue/' + slug + '.json' });
      } catch (e) {
        return json({ ok: false, error: 'queue write failed: ' + e.message }, 500);
      }
    });
    return;
  }

  // ── GET /api/liveness?url=...&row=N ────────────────────────────────────
  // Liveness Phase 2 (2026-05-18, inventory item from strategy doc).
  // Realtime probe used by the drawer-open hook. 6h cache keyed by URL so
  // repeated drawer opens don't hammer ATS hosts. Reuses lib/liveness.mjs.
  //
  // Phase 3 (2026-05-22) — added `auto_remove_recommended` to every return
  // payload. True ONLY when:
  //   - the posting is verifiably not alive AND
  //   - the tracker row's current status is 'Evaluated' (so a Discarded
  //     auto-flip is safe — wouldn't trample on Applied/Interview/Offer rows)
  // The client uses this hint to gate the refuse-banner display.
  // `row` query param is optional but recommended; without it the server
  // falls back to matching the URL against liveness-state.json's row map.
  if (url.startsWith('/api/liveness') && req.method === 'GET') {
    (async () => {
      try {
        // `url` is path-only (stripped at line 4194); read params from the
        // pre-parsed `query` object created at line 4196. The earlier code
        // tried `new URL('http://localhost' + url)` which always had empty
        // searchParams since url=/api/liveness with no query string.
        const target = String(query.url || '');
        const rowQ = String(query.row || '');
        if (!target) return json({ ok: false, error: 'url param required' }, 400);

        // Helper: compute auto_remove_recommended given the liveness outcome
        // and the tracker row (if resolvable). The row's current status is the
        // authoritative gate — auto-remove ONLY suggested for Evaluated rows.
        const computeAutoRemove = (alive, rowNum) => {
          if (alive) return false;
          if (!rowNum) return false;
          try {
            const apps = parseApplicationsFile(join(ROOT, 'data/applications.md'));
            const r = apps.find((a) => String(a.num) === String(rowNum));
            if (!r) return false;
            return r.status === 'Evaluated';
          } catch (_e) { return false; }
        };

        // 1) Check the overnight sweep's sidecar (most authoritative)
        const statePath = join(ROOT, 'data/liveness-state.json');
        if (existsSync(statePath)) {
          try {
            const state = JSON.parse(readFileSync(statePath, 'utf-8'));
            for (const [num, row] of Object.entries(state.rows || {})) {
              if (row && row.url === target) {
                const alive = row.status === 'active';
                return json({
                  ok: true,
                  alive,
                  status: row.status,
                  reason: row.reason || '',
                  lastChecked: row.lastChecked,
                  source: 'overnight-sweep',
                  row_num: num,
                  auto_remove_recommended: computeAutoRemove(alive, rowQ || num),
                });
              }
            }
          } catch (e) { _d25Log('[liveness] state read failed: ' + e.message); }
        }

        // 2) Check the 6h request cache
        const cachePath = join(ROOT, 'data/liveness-cache.json');
        let cache = {};
        if (existsSync(cachePath)) {
          try { cache = JSON.parse(readFileSync(cachePath, 'utf-8')); } catch {}
        }
        const cacheKey = target;
        const cacheEntry = cache[cacheKey];
        const SIX_HOURS = 6 * 60 * 60 * 1000;
        if (cacheEntry && (Date.now() - cacheEntry.ts) < SIX_HOURS) {
          const alive = cacheEntry.status === 'active';
          return json({
            ok: true,
            alive,
            status: cacheEntry.status,
            reason: cacheEntry.reason,
            lastChecked: new Date(cacheEntry.ts).toISOString(),
            source: 'cache',
            auto_remove_recommended: computeAutoRemove(alive, rowQ),
          });
        }

        // 3) Live probe via lib/liveness.mjs
        const { verifyApplyNowLink } = await import(join(ROOT, 'lib/liveness.mjs'));
        const result = await verifyApplyNowLink(target);
        const status = result.result;
        const alive = status === 'active';

        // Update the 6h cache
        cache[cacheKey] = { status, reason: result.reason, ts: Date.now() };
        try {
          writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        } catch (e) { _d25Log('[liveness] cache write failed: ' + e.message); }

        return json({
          ok: true,
          alive,
          status,
          reason: result.reason,
          lastChecked: new Date().toISOString(),
          source: 'live-probe',
          auto_remove_recommended: computeAutoRemove(alive, rowQ),
        });
      } catch (e) {
        _d25Log('[liveness] ' + e.message);
        return json({ ok: false, error: e.message }, 500);
      }
    })();
    return;
  }
  if (url === '/api/pipeline/process-all' && req.method === 'POST') {
    let body = '';
    let total = 0;
    // Larger ceiling so the optional `companies` payload (Task 2 modal selection)
    // doesn't get truncated for typical Apply-Now lists.
    req.on('data', c => { total += c.length; if (total > 32 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      // ε 2026-05-19 — STRICT input validation. Previously accepted any
      // truthy `confirm` value (e.g. `{"confirm":42}` would SPAWN A REAL
      // $142 PIPELINE — repro'd in eval). Now: confirm MUST be the boolean
      // true. sendEmail/force MUST be boolean (or omitted). companies MUST
      // be an array of strings (or omitted). Reject anything else cleanly
      // with 400 — never let a malformed payload trigger a real spawn.
      const validateProcessAllPayload = (p) => {
        if (p === null || typeof p !== 'object' || Array.isArray(p)) {
          return 'body must be a JSON object';
        }
        if (p.confirm !== true) return 'confirm must be boolean true';
        if (p.sendEmail !== undefined && typeof p.sendEmail !== 'boolean') return 'sendEmail must be boolean';
        if (p.force !== undefined && typeof p.force !== 'boolean') return 'force must be boolean';
        // Quality tier — 3-tier modal sends '1' | '2' | '3' (lib/process-all-tiers.mjs).
        // Legacy values 'normal' (default) + '5' (Tier-5 button via confirmTier5Run) preserved.
        // resolveTier() in lib/process-all-tiers.mjs accepts all of these and routes them.
        if (p.tier !== undefined) {
          const VALID_TIERS = ['normal', '1', '2', '3', '5', 1, 2, 3, 5];
          if (!VALID_TIERS.includes(p.tier)) {
            return 'tier must be one of: "normal", "1", "2", "3", "5"';
          }
        }
        if (p.companies !== undefined) {
          if (!Array.isArray(p.companies)) return 'companies must be an array of strings';
          if (p.companies.length > 200) return 'companies cap is 200 entries';
          for (const c of p.companies) {
            if (typeof c !== 'string') return 'companies must be an array of strings';
            if (c.length > 200) return 'each company label cap is 200 chars';
            // ε 2026-05-19 self-review — reject empty / whitespace-only strings
            // so the UI knows immediately that an empty selection is invalid,
            // rather than silently passing an empty filter to the orchestrator.
            if (c.trim() === '') return 'company labels cannot be empty or whitespace-only';
          }
        }
        return null;
      };
      const validationError = validateProcessAllPayload(parsed);
      if (validationError) return json({ ok: false, error: validationError }, 400);
      // `force: true` overrides per-run / monthly caps (user explicitly accepted)
      // `companies` (optional) — Task 2 — comma-list of company labels passed
      // through to the orchestrator's --companies flag for subset runs.
      const result = spawnProcessAll({
        sendEmail: parsed.sendEmail === true,
        force:     parsed.force === true,
        companies: Array.isArray(parsed.companies) ? parsed.companies : null,
        tier:      String(parsed.tier || 'normal'),
      });
      // 402 (Payment Required) for cap-exceeded refusals so UI can distinguish from generic errors
      const statusCode = result.ok ? 200 : (result.cap_exceeded ? 402 : 400);
      return json(result, statusCode);
    });
    return;
  }
  // Phase E3 (2026-05-19) — CV re-render endpoint. Backs Phase A · A7's
  // "Re-render CV →" badge/button in the daily heartbeat email. POSTs to
  // this endpoint invoke scripts/render-cv-typst.mjs with a 60s timeout
  // (hang-prevention compliant per AGENTS.md) and return the rendered
  // PDF path. The output filename includes today's date so re-running
  // refreshes the master CV without clobbering historical snapshots.
  // No request body is required — the endpoint always renders cv.md to
  // output/cv-mitchell-williams-master-<YYYY-MM-DD>.pdf.
  if (url === '/api/cv/render' && req.method === 'POST') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const outPath = `output/cv-mitchell-williams-master-${today}.pdf`;
      const cmd = `node scripts/render-cv-typst.mjs --input cv.md --output ${outPath}`;
      const result = _execSync(cmd, { encoding: 'utf-8', timeout: 60_000, cwd: ROOT });
      return json({
        ok: true,
        path: outPath,
        url: `/output/cv-mitchell-williams-master-${today}.pdf`,
        stdout_tail: result.split('\n').slice(-10).join('\n'),
      });
    } catch (err) {
      return json({
        ok: false,
        error: err.message,
        stderr_tail: (err.stderr || '').toString().split('\n').slice(-10).join('\n'),
      }, 500);
    }
  }
  if (url === '/api/batch/run' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      // ε 2026-05-19 — STRICT input validation (mirror /api/pipeline/process-all).
      // confirm must be boolean true; sendEmail/force must be boolean if present.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json({ ok: false, error: 'body must be a JSON object' }, 400);
      }
      if (parsed.confirm !== true) return json({ ok: false, error: 'confirm must be boolean true' }, 400);
      if (parsed.sendEmail !== undefined && typeof parsed.sendEmail !== 'boolean') {
        return json({ ok: false, error: 'sendEmail must be boolean' }, 400);
      }
      if (parsed.force !== undefined && typeof parsed.force !== 'boolean') {
        return json({ ok: false, error: 'force must be boolean' }, 400);
      }
      const result = spawnBatchOnly({ sendEmail: parsed.sendEmail === true, force: parsed.force === true });
      const statusCode = result.ok ? 200 : (result.cap_exceeded ? 402 : 400);
      return json(result, statusCode);
    });
    return;
  }
  if (url === '/api/pipeline/job-status') {
    const jobId = String(query.job_id || '');
    if (!jobId) return json({ ok: false, error: 'missing job_id' }, 400);
    const state = loadPipelineProcessState();
    const job = state.jobs?.[jobId];
    if (!job) return json({ ok: false, error: 'job not found' }, 404);
    // Pull the last 20 log lines so the modal can show progress
    let tail = [];
    if (job.log_path && existsSync(job.log_path)) {
      try {
        const lines = readFileSync(job.log_path, 'utf-8').split('\n').filter(Boolean);
        tail = lines.slice(-20);
      } catch {}
    }
    // 2026-05-27 — Live phase progress: count per-URL events in the log so
    // the toast can show "X / Y triaged · ETA Zm" instead of a static
    // "Phase 1/4 — Triage" with no internal motion. Source-of-truth for
    // liveness during long phases. AGENTS.md bug-class: long-phase-no-
    // liveness-signal-looks-like-stall.
    const live_progress = _computeLivePhaseProgress(job);
    // 2026-05-27 (PR-organic-wiring) — Full-run ETA + per-phase breakdown
    // for the toast title + hover tooltip.
    const full_eta = _computeFullRunETA(job, live_progress);
    // Attach full_eta to job so the client's _updatePipelineToast can read
    // it without a separate API call.
    const enriched = { ...job, full_eta };
    return json({ ok: true, job: enriched, log_tail: tail, live_progress, full_eta });
  }

  // 2026-05-26 — Job-log full-content endpoint backing the "see log" hyperlink
  // in the failed-toast (build-dashboard.mjs ~28730 → window._openJobLogModal).
  // Returns the orchestrator log content with a 256KB tail cap. Two formats:
  //   ?format=text → JSON { ok, job_id, log_size, log_content }
  //   ?format=html → text/html chunk (styled <pre>) for direct innerHTML
  // Path-traversal is impossible: log_path comes from state file (not user
  // input), jobId is regex-validated, and content is _esc'd before HTML emit.
  if (url === '/api/pipeline/job-log') {
    const jobId = String(query.job_id || '');
    const format = String(query.format || 'text');
    if (!jobId) return json({ ok: false, error: 'missing job_id' }, 400);
    if (!/^[a-z0-9-]+$/i.test(jobId)) return json({ ok: false, error: 'invalid job_id format' }, 400);
    const state = loadPipelineProcessState();
    const job = state.jobs?.[jobId];
    if (!job) return json({ ok: false, error: 'job not found' }, 404);
    if (!job.log_path) return json({ ok: false, error: 'job has no log_path recorded' }, 404);
    if (!existsSync(job.log_path)) return json({ ok: false, error: 'log file no longer exists (was in /tmp, may have been cleaned)' }, 404);
    const MAX = 256 * 1024;
    try {
      const stat = statSync(job.log_path);
      const raw = readFileSync(job.log_path, 'utf-8');
      const truncated = raw.length > MAX;
      const content = truncated ? '... (truncated; showing last 256KB) ...\n' + raw.slice(-MAX) : raw;
      if (format === 'html') {
        const safe = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;line-height:1.4;color:#dbe4ff;background:#0d1117;padding:16px;margin:0;border-radius:0;max-height:560px;overflow:auto">' + safe + '</pre>');
      }
      return json({ ok: true, job_id: jobId, log_size: stat.size, truncated, log_content: content });
    } catch (err) {
      return json({ ok: false, error: 'log read failed: ' + err.message }, 500);
    }
  }

  // 2026-05-19 Mitchell feedback — persistent progress bar across sessions.
  // Returns the most-recent active job (status in 'queued' or 'running') so
  // any browser session can detect an in-flight Process All / Run Batch and
  // restore the progress toast on page load. Returns 404 when no job is
  // currently in-flight so the client knows to skip the toast.
  if (url === '/api/pipeline/active-job') {
    const state = loadPipelineProcessState();
    const jobs = Object.values(state.jobs || {});
    const active = jobs
      .filter(j => j && (j.status === 'running' || j.status === 'queued'))
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    if (active.length === 0) return json({ ok: true, active: false });
    const job = active[0];
    let tail = [];
    if (job.log_path && existsSync(job.log_path)) {
      try {
        const lines = readFileSync(job.log_path, 'utf-8').split('\n').filter(Boolean);
        tail = lines.slice(-20);
      } catch {}
    }
    return json({ ok: true, active: true, job, log_tail: tail });
  }

  // 2026-05-20 — user-editable dashboard preferences. Backed by
  // data/dashboard-settings.json (file-of-record, cross-device) and
  // shadowed by localStorage 'careerOps.settings' (per-browser overrides).
  // Schema: { outreach: { global_intensity, warm_intensity,
  // cold_intensity, suppression[] } }.
  // (The legacy `show_runway_widget` toggle was removed from the schema
  // 2026-05-25 alongside the runway-coupling sweep; any stale value in
  // an existing settings file is harmless and may be left in place.)
  if (url === '/api/settings' && req.method === 'GET') {
    const fp = join(ROOT, 'data', 'dashboard-settings.json');
    if (!existsSync(fp)) return json({ ok: true, settings: {} });
    try { return json({ ok: true, settings: JSON.parse(readFileSync(fp, 'utf-8')) }); }
    catch (err) { return json({ ok: false, error: err.message }, 500); }
  }
  if (url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50_000) req.connection.destroy(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body || '{}');
        const fp = join(ROOT, 'data', 'dashboard-settings.json');
        const current = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf-8')) : {};
        // Shallow merge top-level; deep-merge `outreach` so partial updates work.
        const merged = { ...current, ...incoming };
        if (incoming.outreach || current.outreach) {
          merged.outreach = { ...(current.outreach || {}), ...(incoming.outreach || {}) };
        }
        merged.schema_version = merged.schema_version || 1;
        writeFileSync(fp, JSON.stringify(merged, null, 2));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, settings: merged }));
      } catch (err) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 2026-05-19 Mitchell instrumentation — pipeline health endpoint reads
  // the most-recent pipeline-health.json (written every 5 min by
  // scripts/agents/pipeline-health-check.mjs). Dashboard's "System healthy"
  // chip polls this. Returns the file as-is + a freshness flag.
  if (url === '/api/pipeline/health-status') {
    const fp = join(ROOT, 'data', 'pipeline-health.json');
    if (!existsSync(fp)) {
      // PR-08 (2026-05-25): drop the CLI-hint from the user-facing error.
      // The scheduled launchd job (`com.mitchell.career-ops.pipeline-health-check`)
      // runs every 5 minutes; if the dashboard hits this on a fresh boot, the
      // user just needs to wait. No CLI invocation expected from Mitchell.
      return json({ ok: false, present: false, error: 'Pipeline health check has not run yet. It runs automatically every 5 min — try again shortly.' }, 200);
    }
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      const checkedAt = data.checked_at ? Date.parse(data.checked_at) : 0;
      const ageMs = Date.now() - checkedAt;
      const stale = ageMs > (15 * 60 * 1000);  // healthy report > 15 min is stale
      return json({
        ok: true,
        present: true,
        stale,
        age_seconds: Math.round(ageMs / 1000),
        ...data,
      });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // Phase 7.1 (2026-05-22): /api/pipeline/flow-state — aggregates the 5
  // canonical pipeline stages (Scan / Triage / Process / Eval / Publish)
  // for the new Pipeline modal. Reads data/pipeline-process-state.json,
  // data/pipeline-ingress-state.json, and batch/triage-advance.tsv into
  // a single per-stage descriptor.
  if (url === '/api/pipeline/flow-state' && req.method === 'GET') {
    try {
      const stages = [];
      // Helper — last-modified ms of a file (or null)
      function fileMtime(rel) {
        try {
          const fp = join(ROOT, rel);
          if (!existsSync(fp)) return null;
          return Math.floor(statSync(fp).mtimeMs);
        } catch (_) { return null; }
      }
      function tryReadJson(rel) {
        try {
          const fp = join(ROOT, rel);
          if (!existsSync(fp)) return null;
          return JSON.parse(readFileSync(fp, 'utf-8'));
        } catch (_) { return null; }
      }
      // Locate the most recent process-all job for per-phase status
      const procState = tryReadJson('data/pipeline-process-state.json') || { jobs: {} };
      const jobIds = Object.keys(procState.jobs || {});
      let latestJob = null;
      let latestStart = 0;
      for (const id of jobIds) {
        const j = procState.jobs[id];
        const t = j && j.started_at ? Date.parse(j.started_at) : 0;
        if (t > latestStart) { latestStart = t; latestJob = j; }
      }
      const phases = (latestJob && latestJob.phases) || {};
      // Stage 1 — Scan (ingress monitor)
      const ingress = tryReadJson('data/pipeline-ingress-state.json');
      const ingressMtime = fileMtime('data/pipeline-ingress-state.json');
      stages.push({
        key: 'scan',
        label: 'Scan',
        count: (ingress && ingress.summary && ingress.summary.total_scanned) || (ingress && Array.isArray(ingress.scanners) ? ingress.scanners.length : 0),
        last_run_ms: ingressMtime,
        status: ingress ? 'idle' : 'unknown',
        note: ingress && ingress.summary && ingress.summary.note ? ingress.summary.note : null,
      });
      // Stage 2 — Triage (batch/triage-advance.tsv depth)
      let triageBacklog = 0;
      try {
        const tsv = join(ROOT, 'batch', 'triage-advance.tsv');
        if (existsSync(tsv)) {
          const lines = readFileSync(tsv, 'utf-8').split('\n').filter(l => l.trim());
          triageBacklog = Math.max(0, lines.length - 1); // header
        }
      } catch (_) { /* leave 0 */ }
      const triageAdvanced = (phases.triage && (phases.triage.advanced || 0)) || 0;
      stages.push({
        key: 'triage',
        label: 'Triage',
        count: triageBacklog,
        last_run_ms: latestStart || null,
        status: phases.triage ? (phases.triage.ok ? 'success' : 'failed') : 'idle',
        note: triageAdvanced ? (triageAdvanced + ' advanced in latest run') : null,
      });
      // Stage 3 — Process (batch phase)
      stages.push({
        key: 'process',
        label: 'Process',
        count: latestJob && latestJob.pending_before != null ? latestJob.pending_before : 0,
        last_run_ms: latestStart || null,
        status: phases.batch ? (phases.batch.ok ? 'success' : 'failed') : 'idle',
        note: latestJob && latestJob.processed != null ? (latestJob.processed + ' processed') : null,
      });
      // Stage 4 — Eval (polish + pregen)
      const polishOk = phases.polish && phases.polish.ok;
      const pregenOk = phases.pregen && phases.pregen.ok;
      const evalStatus = (polishOk && pregenOk) ? 'success' : (phases.polish || phases.pregen) ? 'partial' : 'idle';
      const pregenCount = (phases.pregen && phases.pregen.generated) || 0;
      stages.push({
        key: 'eval',
        label: 'Eval',
        count: pregenCount,
        last_run_ms: latestStart || null,
        status: evalStatus,
        note: phases.polish && phases.polish.skipped ? 'polish skipped' : null,
      });
      // Stage 5 — Publish (merge + rebuild + email)
      const publishOk = phases.merge && phases.merge.ok && phases.rebuild && phases.rebuild.ok;
      const emailOk = phases.email && phases.email.ok;
      const publishStatus = publishOk ? (emailOk || (phases.email && phases.email.skipped) ? 'success' : 'partial') : (phases.merge || phases.rebuild) ? 'partial' : 'idle';
      stages.push({
        key: 'publish',
        label: 'Publish',
        count: latestJob && latestJob.published_count != null ? latestJob.published_count : 0,
        last_run_ms: latestStart || null,
        status: publishStatus,
        note: phases.email && phases.email.skipped ? 'email skipped' : null,
      });
      return json({
        ok: true,
        latest_job_id: latestJob && latestJob.jobId ? latestJob.jobId : null,
        latest_job_status: latestJob && latestJob.status ? latestJob.status : null,
        latest_job_started_at: latestJob && latestJob.started_at ? latestJob.started_at : null,
        stages,
      });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  }

  // ── Outreach API ────────────────────────────────────────────────────────
  // Powers the Outreach Pulse section + per-contact intel drawer.
  // resetOutreachCache() ensures every GET reads fresh state (writes come
  // from log-touch.mjs running in a different process).
  if (url === '/api/outreach') {
    resetOutreachCache();
    return json(enrichOutreachSummary(buildOutreachSummary()));
  }
  if (url === '/api/outreach/all') {
    resetOutreachCache();
    const contacts = listOutreachContacts().map(c => enrichContact(c));
    return json({ contacts });
  }
  const outreachContactMatch = url.match(/^\/api\/outreach\/contact\/(.+)$/);
  if (outreachContactMatch && req.method === 'GET') {
    resetOutreachCache();
    const id = decodeURIComponent(outreachContactMatch[1]);
    const c = getOutreachContact(id);
    if (!c) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    return json(enrichContact(c));
  }
  if (url === '/api/outreach/touch' && req.method === 'POST') {
    let body = ''; let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.contact_id || !p.channel) throw new Error('contact_id and channel required');
        upsertOutreachContact({
          contact_id:            p.contact_id,
          name:                  p.name,
          company:               p.company,
          title_at_send:         p.title,
          contact_type:          p.contact_type || 'recruiter',
          degree:                p.degree || 1,
          linked_application_id: p.linked_application_id,
          tier:                  p.tier || 'B',
        });
        const c = logOutreachTouch(p.contact_id, {
          channel:     p.channel,
          template_id: p.template_id || null,
          summary:     p.summary || '',
          outbound:    p.outbound !== false,
          ts:          p.ts || null,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contact: c }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  if (url === '/api/outreach/status' && req.method === 'POST') {
    let body = ''; let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.contact_id || !p.status) throw new Error('contact_id and status required');
        const c = setOutreachStatus(p.contact_id, p.status);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contact: c }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  // POST /api/outreach/snooze — body: { contact_id, until_iso, note? }
  // Snoozed contacts are excluded from due_today/breakup/referrals until
  // until_iso passes. resetOutreachCache() ensures the next /api/outreach
  // call sees fresh state.
  if (url === '/api/outreach/snooze' && req.method === 'POST') {
    let body = ''; let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.contact_id || !p.until_iso) throw new Error('contact_id and until_iso required');
        if (!getOutreachContact(p.contact_id)) throw new Error(`contact not found: ${p.contact_id}`);
        const c = snoozeOutreachContact(p.contact_id, p.until_iso, p.note || '');
        resetOutreachCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contact: enrichContact(c) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  // POST /api/outreach/cancel-strategy — body: { contact_id, reason? }
  // Marks the current next_action as cancelled. Contact stays in the
  // tracker; the next recommender pass writes a fresh next_action.
  if (url === '/api/outreach/cancel-strategy' && req.method === 'POST') {
    let body = ''; let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.contact_id) throw new Error('contact_id required');
        if (!getOutreachContact(p.contact_id)) throw new Error(`contact not found: ${p.contact_id}`);
        const c = cancelOutreachStrategy(p.contact_id, p.reason || '');
        resetOutreachCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contact: enrichContact(c) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  // POST /api/outreach/wake — body: { contact_id }
  // Clears snoozed_until so the contact reappears on the next refresh.
  if (url === '/api/outreach/wake' && req.method === 'POST') {
    let body = ''; let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!p.contact_id) throw new Error('contact_id required');
        if (!getOutreachContact(p.contact_id)) throw new Error(`contact not found: ${p.contact_id}`);
        const c = wakeOutreachContact(p.contact_id);
        resetOutreachCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, contact: enrichContact(c) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (url === '/api/batch-live') {
    try { return json(batchLive()); }
    catch (err) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: err.message })); return; }
  }

  // ── SSE stream endpoint (Tier A Item #2, 2026-05-17) ───────────
  // EventSource clients connect here and receive server-push events
  // whenever batch/batch-state.tsv, batch-input.tsv, or
  // triage-advance.tsv change (debounced 200ms). Falls back to a
  // 30s interval push when fs.watch is unavailable.
  if (url === '/api/batch-live-stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',   // disable nginx buffering when proxied
    });
    // Flush headers immediately so the browser sees the event-stream MIME type.
    res.flushHeaders?.();

    const client = { id: Math.random().toString(36).slice(2), res };
    _sseClients.add(client);

    // Send initial snapshot immediately on connect so the client renders
    // current state without waiting for the next file-change event.
    try {
      res.write(`event: batch-live\ndata: ${JSON.stringify(batchLive())}\n\n`);
    } catch (_) {}

    // Clean up when the connection closes.
    req.on('close', () => { _sseClients.delete(client); });
    req.on('error', () => { _sseClients.delete(client); });
    return;  // keep connection open — do NOT call res.end()
  }

  // ── Fix 2 (draft-sync-sse): per-row draft artifact SSE stream ──────────────
  // Endpoint: GET /api/draft-updates-stream/{rowId}
  // Fires a "draft-update" event whenever a file in the row's apply-pack
  // directory (data/apply-packs/{N}-{slug}/ or data/applications/{N}-{slug}/)
  // changes. The drawer subscribes when opened; EventSource is closed on close.
  const draftStreamMatch = url.match(/^\/api\/draft-updates-stream\/(\d+)$/);
  if (draftStreamMatch) {
    const rowNum = draftStreamMatch[1];
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Resolve the apply-pack directory for this row number.
    function _draftDir(num) {
      const apDir = join(ROOT, 'data', 'apply-packs');
      const appDir = join(ROOT, 'data', 'applications');
      for (const base of [apDir, appDir]) {
        if (!existsSync(base)) continue;
        try {
          const entries = readdirSync(base);
          const match = entries.find(e => e.startsWith(num + '-') || e.startsWith(num.padStart(3,'0') + '-'));
          if (match) return join(base, match);
        } catch (_) {}
      }
      return null;
    }

    const dir = _draftDir(rowNum);
    let _draftWatcher = null;
    let _draftDebounce = null;

    function _sendDraftUpdate() {
      // Send list of artifact filenames in the directory as the update payload
      let files = [];
      if (dir && existsSync(dir)) {
        try { files = readdirSync(dir).filter(f => !f.startsWith('.')); } catch (_) {}
      }
      try {
        res.write(`event: draft-update\ndata: ${JSON.stringify({ rowNum, dir: dir || null, files })}\n\n`);
      } catch (_) {}
    }

    // Send initial snapshot
    _sendDraftUpdate();

    if (dir && existsSync(dir)) {
      try {
        _draftWatcher = fsWatch(dir, { persistent: false, recursive: true }, () => {
          clearTimeout(_draftDebounce);
          _draftDebounce = setTimeout(_sendDraftUpdate, 300);
        });
      } catch (_) { /* fs.watch unavailable */ }
    }

    // Keepalive every 25s
    const _draftKeepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(_draftKeepalive); }
    }, 25_000);

    req.on('close', () => {
      clearInterval(_draftKeepalive);
      clearTimeout(_draftDebounce);
      try { _draftWatcher?.close(); } catch (_) {}
    });
    req.on('error', () => {
      clearInterval(_draftKeepalive);
      clearTimeout(_draftDebounce);
      try { _draftWatcher?.close(); } catch (_) {}
    });
    return;  // keep connection open
  }

  // ── Sidebar batch popout: detailed live status feed (2026-05-17) ──
  // Powers the clickable #sidebar-batch box → modal with real-time detail.
  // Composes batchLive() summary + detailBatches() recent-runs grouping +
  // cost-log totals + queue depth + recent batch-related failures.
  if (url === '/api/batch/status-detailed') {
    try { return json(buildBatchStatusDetailed()); }
    catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
  }

  // BRAVO followup 2026-05-20 — per-state batch-item drill-in for the
  // Batch Status modal. ?state= one of: completed | failed | running |
  // pending | pipeline_pending | batch_input. Returns per-item rows for
  // the matching state — used by the modal's click-to-drill side panel.
  // Caps result at 200 rows; the UI surfaces a "showing N of M" footer
  // when truncated.
  if (url.startsWith('/api/batch/items')) {
    try {
      // `url` is stripped of the query string at handler entry (line 4194),
      // so `new URL(url, 'http://localhost').searchParams` is always empty.
      // Use the already-parsed `query` object from line 4196 instead.
      const state = String(query.state || 'failed').toLowerCase();
      const items = buildBatchItemsForState(state);
      return json({ ok: true, state: state, items: items.items, total: items.total, truncated: items.truncated, error_categories: items.error_categories || null });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
  }

  // P0.7 Q3 (2026-05-20 iter8) — Per-row failure-detail tail. ?id=<batch_id>
  // returns the batch-state row + a snippet of the daily batch log surrounding
  // the row's started_at/completed_at window so users can see the ACTUAL
  // root cause (e.g., STDERR lines) rather than just the structured error
  // field, which often lags the real failure mode (e.g. records a 529 message
  // when the runner shell already exited with code 1 from a bash arithmetic
  // bug). Logs at data/logs/batch-YYYY-MM-DD.log (combined stdout+stderr).
  if (url === '/api/batch/failure-detail') {
    try {
      const rowId = String(query.id || '').trim();
      if (!rowId) return json({ ok: false, error: 'missing id query param' });
      const detail = buildBatchFailureDetail(rowId);
      return json({ ok: true, ...detail });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
  }

  // P0.7 Q5 (2026-05-20 iter9) — cancel an in-flight batch / process-all job.
  // Mirrors the alpha cancel pattern at line ~7259 but reads PID from the
  // persistent pipeline-process-state.json instead of an in-memory map.
  //   body: { jobId } (or query ?job_id=<id>)
  //   returns: { ok, jobId, signalSent, exitState, sigkill_at_ms }
  //   env: BATCH_CANCEL_TIMEOUT_MS (default 125000ms) — SIGTERM→SIGKILL window
  if (url === '/api/batch/cancel' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
      const jobId = String(parsed.jobId || parsed.job_id || query.job_id || query.id || '').trim();
      if (!jobId) return json({ ok: false, error: 'jobId required' }, 400);

      const state = loadPipelineProcessState();
      const job = state.jobs?.[jobId];
      if (!job) return json({ ok: false, error: 'job not found' }, 404);
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return json({ ok: true, jobId, signalSent: null, exitState: 'already-finished', status: job.status });
      }
      const pid = job.pid;
      if (!Number.isFinite(pid)) {
        return json({
          ok: false,
          error: 'job has no pid — state file predates iter9 PID capture or process spawned before this dashboard-server restart',
        }, 409);
      }

      let signalSent = null;
      let exitState  = 'cancel-requested';
      try {
        process.kill(pid, 'SIGTERM');
        signalSent = 'SIGTERM';
      } catch (e) {
        if (e.code === 'ESRCH') {
          // Process gone already — mark state cancelled so the UI clears.
          job.status = 'cancelled';
          job.cancelled_at = new Date().toISOString();
          job.cancel_note = 'process was already gone (ESRCH)';
          try { writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2)); } catch (_) {}
          return json({ ok: true, jobId, signalSent: null, exitState: 'process-already-gone' });
        }
        return json({ ok: false, error: 'SIGTERM failed: ' + (e?.message || 'unknown') }, 500);
      }

      // Mark cancelled in state immediately so the UI no longer shows running.
      // proc.on('exit') in the spawners respects status='cancelled' and won't
      // overwrite it with completed/failed.
      job.status = 'cancelled';
      job.cancelled_at = new Date().toISOString();
      try { writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(state, null, 2)); } catch (_) {}

      // Schedule SIGKILL fallback after BATCH_CANCEL_TIMEOUT_MS.
      const timeoutMs = parseInt(process.env.BATCH_CANCEL_TIMEOUT_MS || '125000', 10);
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone — fine */ }
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 125000);

      return json({ ok: true, jobId, signalSent, exitState, sigkill_at_ms: timeoutMs });
    });
    return;
  }

  // Closure 08.3 (2026-05-22) — Resume a cancelled batch job. Reads the
  // cancelled job's incomplete rows from batch/batch-state.tsv, looks up
  // their full row data in batch/batch-input.tsv, writes an audit
  // resume-input file at batch/batch-input-resume-<originalJobId>.tsv,
  // appends any URLs not currently queued back into batch/triage-advance.tsv,
  // then spawns a NEW batch-only-pipeline job. The new job's state-file
  // entry is annotated with `resumed_from: <originalJobId>`.
  //   body: { jobId }
  //   returns: { ok, newJobId, originalJobId, rowsRequeued, resumeInputPath }
  if (url === '/api/batch/resume' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 4 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
      const originalJobId = String(parsed.jobId || parsed.job_id || query.job_id || '').trim();
      if (!originalJobId) return json({ ok: false, error: 'jobId required' }, 400);

      const state = loadPipelineProcessState();
      const job = state.jobs?.[originalJobId];
      if (!job) return json({ ok: false, error: 'job not found' }, 404);
      if (job.status !== 'cancelled') {
        return json({ ok: false, error: 'only cancelled jobs are resumable; job is in status: ' + job.status }, 409);
      }

      // Identify rows belonging to this job that are NOT completed. The
      // batch-state.tsv lacks an explicit jobId column — we identify by
      // started_at falling within the job's lifecycle window
      // (job.started_at ≤ row.started_at ≤ job.cancelled_at OR row has no
      // completed_at if status=running).
      const stateFp = join(ROOT, 'batch/batch-state.tsv');
      const inputFp = join(ROOT, 'batch/batch-input.tsv');
      const triageFp = join(ROOT, 'batch/triage-advance.tsv');

      if (!existsSync(stateFp)) {
        return json({ ok: false, error: 'batch-state.tsv not found — no batch run state to resume from' }, 409);
      }

      const jobStartMs = job.started_at ? Date.parse(job.started_at) : 0;
      const jobCancelledMs = job.cancelled_at ? Date.parse(job.cancelled_at) : Date.now();
      // Use a 30-min look-back from cancelled_at as a generous floor for the
      // job's lifecycle window. Same gap heuristic as detailBatches() uses.
      const lookbackMs = 30 * 60 * 1000;
      const windowStartMs = Math.max(0, jobStartMs - 1000) || (jobCancelledMs - lookbackMs);

      const incomplete = [];
      try {
        const rows = readFileSync(stateFp, 'utf8').split('\n')
          .filter(l => l.trim() && !l.startsWith('id\t'));
        for (const ln of rows) {
          const [id, rowUrl, status, started_at] = ln.split('\t');
          if (status === 'completed') continue;
          if (!started_at) continue;
          const ts = Date.parse(started_at);
          if (!Number.isFinite(ts)) continue;
          if (ts >= windowStartMs && ts <= jobCancelledMs + lookbackMs) {
            incomplete.push({ id: id.trim(), url: (rowUrl || '').trim(), status: (status || '').trim() });
          }
        }
      } catch (err) {
        return json({ ok: false, error: 'failed to parse batch-state.tsv: ' + err.message }, 500);
      }

      // Look up notes/source from batch-input.tsv for the audit resume-input file.
      const inputByUrl = new Map();
      if (existsSync(inputFp)) {
        try {
          const lines = readFileSync(inputFp, 'utf8').split('\n')
            .filter(l => l.trim() && !l.startsWith('id\t'));
          for (const ln of lines) {
            const parts = ln.split('\t');
            const id = (parts[0] || '').trim();
            const inUrl = (parts[1] || '').trim();
            const source = (parts[2] || 'resume').trim();
            const notes = (parts[3] || '').trim();
            if (inUrl) inputByUrl.set(inUrl, { id, url: inUrl, source, notes });
          }
        } catch (_) { /* best-effort */ }
      }

      // Write the audit resume-input file.
      const resumeFp = join(ROOT, `batch/batch-input-resume-${originalJobId}.tsv`);
      const resumeRows = ['id\turl\tsource\tnotes'];
      for (const r of incomplete) {
        const inputRow = inputByUrl.get(r.url) || { id: r.id, url: r.url, source: 'resume', notes: 'resumed-from-' + originalJobId };
        resumeRows.push(`${inputRow.id}\t${inputRow.url}\t${inputRow.source}\t${inputRow.notes}`);
      }
      try {
        writeFileSync(resumeFp, resumeRows.join('\n') + '\n');
      } catch (err) {
        return json({ ok: false, error: 'failed to write resume-input file: ' + err.message }, 500);
      }

      // Re-inject URLs into triage-advance.tsv (the batch runner's input queue).
      // The runner reads url, tier, score, archetype, reason. We don't have
      // the original tier/score/archetype from batch-state.tsv, so use
      // placeholders that flag the row as a resume.
      const triageHeader = 'url\ttier\tscore\tarchetype\treason';
      const existingTriage = new Set();
      let existingTriageContent = '';
      if (existsSync(triageFp)) {
        existingTriageContent = readFileSync(triageFp, 'utf8');
        const triageLines = existingTriageContent.split('\n')
          .filter(l => l.trim() && !l.startsWith('url\t'));
        for (const ln of triageLines) {
          const url = (ln.split('\t')[0] || '').trim();
          if (url) existingTriage.add(url);
        }
      }
      const newTriageLines = [];
      let appended = 0;
      for (const r of incomplete) {
        if (!r.url || existingTriage.has(r.url)) continue;
        newTriageLines.push(`${r.url}\t?\t?\tresume\tresumed from cancelled job ${originalJobId}`);
        appended++;
      }
      if (newTriageLines.length) {
        try {
          let combined = existingTriageContent;
          if (!combined.includes('url\ttier\tscore\tarchetype\treason')) {
            combined = triageHeader + '\n' + combined;
          }
          if (combined && !combined.endsWith('\n')) combined += '\n';
          combined += newTriageLines.join('\n') + '\n';
          writeFileSync(triageFp, combined);
        } catch (err) {
          return json({ ok: false, error: 'failed to append to triage-advance.tsv: ' + err.message }, 500);
        }
      }

      // Spawn a new batch-only-pipeline job. Reuse spawnBatchOnly so we
      // don't duplicate cap-enforcement / state-init logic. Force=true
      // is appropriate since the user explicitly clicked Resume.
      const spawnResult = spawnBatchOnly({
        sendEmail: !!job.send_email,
        force: true,
      });
      if (!spawnResult.ok) {
        return json({ ok: false, error: 'failed to spawn resume batch: ' + spawnResult.error }, 500);
      }

      // Annotate the new job with resumed_from.
      try {
        const post = loadPipelineProcessState();
        if (post.jobs[spawnResult.jobId]) {
          post.jobs[spawnResult.jobId].resumed_from = originalJobId;
          post.jobs[spawnResult.jobId].resume_rows_requeued = incomplete.length;
          writeFileSync(join(ROOT, 'data/pipeline-process-state.json'), JSON.stringify(post, null, 2));
        }
      } catch (_) { /* annotation is best-effort */ }

      return json({
        ok:                  true,
        newJobId:            spawnResult.jobId,
        originalJobId,
        rowsRequeued:        incomplete.length,
        rowsAppendedToQueue: appended,
        resumeInputPath:     `batch/batch-input-resume-${originalJobId}.tsv`,
        statusUrl:           spawnResult.status_url,
      });
    });
    return;
  }

  // Closure 08.3 (2026-05-22) — List recent cancelled jobs for the
  // batch-status modal so the UI can render Resume buttons.
  //   returns: { ok, cancelled_jobs: [{ jobId, type, cancelled_at, ... }] }
  if (url === '/api/batch/cancelled-jobs') {
    try {
      const state = loadPipelineProcessState();
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
      const cancelled = Object.values(state.jobs || {})
        .filter(j => j.status === 'cancelled')
        .filter(j => {
          const ts = j.cancelled_at ? Date.parse(j.cancelled_at) : 0;
          return Number.isFinite(ts) && ts >= since;
        })
        .map(j => ({
          jobId:        j.jobId,
          type:         j.type || 'batch-only',
          started_at:   j.started_at,
          cancelled_at: j.cancelled_at,
          send_email:   !!j.send_email,
          cancel_note:  j.cancel_note || null,
        }))
        .sort((a, b) => String(b.cancelled_at || '').localeCompare(String(a.cancelled_at || '')))
        .slice(0, 10);
      return json({ ok: true, cancelled_jobs: cancelled });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // GET /api/handoffs/pending — researcher-chain handoff envelope sweep
  // (added 2026-05-23, handoff-file contract for researcher → dealbreaker)
  // Returns the active handoff envelopes under ~/.claude/agents/runs/_handoffs/
  // that are status:pending. Includes age + staleness flag (>24h) so the
  // dashboard panel can colour-code stale entries the same way the daily
  // system-maintainer sweep does.
  if (url === '/api/handoffs/pending') {
    try {
      const handoffDir = join(homedir(), '.claude', 'agents', 'runs', '_handoffs');
      if (!existsSync(handoffDir)) {
        return json({ ok: true, pending: [], stale_count: 0, generated_at: new Date().toISOString() });
      }
      const STALE_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const entries = readdirSync(handoffDir);
      const pending = [];
      for (const f of entries) {
        if (!f.startsWith('dealbreaker-') || !f.endsWith('.json')) continue;
        const p = join(handoffDir, f);
        try {
          const h = JSON.parse(readFileSync(p, 'utf8'));
          if (h.status !== 'pending') continue;
          const createdMs = Date.parse(h.created_at);
          const ageMs = Number.isFinite(createdMs) ? now - createdMs : 0;
          pending.push({
            file: f,
            path: p,
            created_at: h.created_at,
            age_hours: Math.round(ageMs / 3.6e6),
            stale: ageMs > STALE_MS,
            mode: h.mode || 'unknown',
            source_agent: h.source_agent || 'unknown',
            ceiling_usd: h.ceiling_usd ?? null,
            audit_items_count: Array.isArray(h.audit_items) ? h.audit_items.length : 0,
            original_question: (h.original_question || '').slice(0, 240),
            report_path: h.report_path || null,
          });
        } catch { /* skip malformed envelope */ }
      }
      pending.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      const stale_count = pending.filter(p => p.stale).length;
      return json({ ok: true, pending, stale_count, generated_at: new Date().toISOString() });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // POST /api/handoffs/dispatch — GAP-RES-14 (2026-05-24)
  // Returns a ready-to-paste Claude Code prompt for a given context (a specific
  // pending handoff envelope OR a row from the apply-pack queue). The client
  // copies the returned text to clipboard via navigator.clipboard.writeText —
  // user pastes into a fresh Claude Code session. Paste-to-clipboard chosen
  // over spawn-via-launchd (Tahoe KeepAlive quirks) and spawn-via-MCP (no
  // existing Claude-spawn MCP server) for v1; both alternatives can be added
  // later without breaking the clipboard path.
  if (url === '/api/handoffs/dispatch' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 16 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch {
        return json({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      try {
        const mode = String(parsed.mode || 'row').toLowerCase();
        let prompt = '';
        let context = {};
        if (mode === 'handoff') {
          const file = String(parsed.file || '').trim();
          if (!/^dealbreaker-[\w.-]+\.json$/.test(file)) {
            return json({ ok: false, error: 'invalid handoff file name' }, 400);
          }
          const handoffPath = join(homedir(), '.claude', 'agents', 'runs', '_handoffs', file);
          if (!existsSync(handoffPath)) {
            return json({ ok: false, error: 'handoff envelope not found' }, 404);
          }
          const envelope = JSON.parse(readFileSync(handoffPath, 'utf8'));
          context = {
            file,
            mode: envelope.mode || 'unknown',
            source_agent: envelope.source_agent || 'unknown',
            ceiling_usd: envelope.ceiling_usd ?? null,
            report_path: envelope.report_path || null,
            original_question: envelope.original_question || '',
            audit_items_count: Array.isArray(envelope.audit_items) ? envelope.audit_items.length : 0,
          };
          prompt = buildHandoffDispatchPrompt(envelope, file);
        } else if (mode === 'row') {
          const num = parsed.num != null ? String(parsed.num) : null;
          const slug = parsed.slug ? String(parsed.slug) : null;
          const company = parsed.company ? String(parsed.company) : null;
          const role = parsed.role ? String(parsed.role) : null;
          const focusHint = parsed.focus_hint ? String(parsed.focus_hint).slice(0, 400) : null;
          if (!num && !slug) {
            return json({ ok: false, error: 'row dispatch requires num or slug' }, 400);
          }
          context = { num, slug, company, role, focus_hint: focusHint };
          prompt = buildRowDispatchPrompt({ num, slug, company, role, focusHint });
        } else {
          return json({ ok: false, error: 'unknown mode (expected: handoff | row)' }, 400);
        }
        return json({
          ok: true,
          mode_used: 'paste-to-clipboard',
          mode,
          context,
          prompt,
          dispatched_at: new Date().toISOString(),
          instructions: 'Paste into a fresh Claude Code session at ~/Documents/career-ops/. The prompt is self-contained.',
        });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  const verifyMatch = url.match(/^\/api\/verify\/(.+\.md)$/);
  if (verifyMatch) {
    const payload = buildVerifyPayload(verifyMatch[1]);
    if (!payload) { res.writeHead(404); res.end('Report not found'); return; }
    return json(payload);
  }

  if (url === '/api/save-evidence' && req.method === 'POST') {
    // Body-size cap (epsilon Ε.3 2026-05-19): refuse payloads larger than
    // 64 KB. Aligned with EVIDENCE_TEXT_MAX_CHARS=50_000 + JSON wrapper
    // overhead headroom. saveEvidence() does the full input validation.
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 64 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      try {
        const { reportSlug, evidenceText } = JSON.parse(body);
        const result = saveEvidence(reportSlug, evidenceText || '');
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url === '/api/status' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 8 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }
      const result = updateApplicationStatus({
        num:    parsed.num,
        status: parsed.status,
        note:   parsed.note,
      });
      const code = result.ok ? 200 : (result.code || 400);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result.ok
        ? { ok: true, row: result.row, canonicalStatuses: CANONICAL_STATUSES }
        : { ok: false, error: result.error }));
    });
    return;
  }

  if (url === '/api/status' && req.method === 'GET') {
    return json({ canonicalStatuses: CANONICAL_STATUSES });
  }

  if (url === '/api/status/bulk' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 64 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }
      const result = updateApplicationStatusBulk({
        nums:   parsed.nums,
        status: parsed.status,
      });
      const code = result.ok ? 200 : (result.code || 400);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result.ok
        ? { ok: true, updated: result.updated, notFound: result.notFound, canonicalStatuses: CANONICAL_STATUSES }
        : { ok: false, error: result.error }));
    });
    return;
  }

  if (url === '/api/pipeline/add' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 8 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (_) {
        return json({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      const result = quickAddToPipeline(parsed.url);
      const code = result.ok ? 200 : (result.code || 400);
      return json(result, code);
    });
    return;
  }

  // /api/notes/add (POST) + /api/notes/:num (GET) routes removed 2026-05-19.
  // The Notes & Activity card was removed from the row drawer; these routes
  // had no other callers. Status-change auto-logging into data/row-notes.json
  // continues via appendRowEvent() in the /mark and bulk-mark code paths.

  // ── Stale pipeline items (>=N days) — Feature 1 (item-list-pop-out) ───
  // GET /api/pipeline/stale-items?days=30
  // Returns the subset of detailPending() items whose daysInQueue >= threshold,
  // formatted for the stale-pipeline modal. Sorted oldest-first.
  if (url === '/api/pipeline/stale-items') {
    try {
      const daysRaw = parseInt(query.days, 10);
      const days = (!isNaN(daysRaw) && daysRaw >= 1 && daysRaw <= 3650) ? daysRaw : 30;
      // 2026-05-18 — load active defers and filter them out. Defers older
      // than their defer_until date are ignored (treat as expired).
      const defersFp = join(ROOT, 'data/stale-defers.json');
      let activeDefers = new Set();
      if (existsSync(defersFp)) {
        try {
          const state = JSON.parse(readFileSync(defersFp, 'utf-8'));
          const now = Date.now();
          for (const [url, d] of Object.entries(state.defers || {})) {
            if (!d?.defer_until) continue;
            if (Date.parse(d.defer_until) > now) activeDefers.add(url);
          }
        } catch (_) { /* corrupt file → no filtering */ }
      }
      const pending = detailPending();
      const items = (pending.items || [])
        .filter(it => it && it.daysInQueue != null && it.daysInQueue >= days)
        .filter(it => !activeDefers.has(it.url || ''))
        .sort((a, b) => (b.daysInQueue || 0) - (a.daysInQueue || 0))
        .map(it => ({
          url:        it.url || '',
          title:      it.role || '',
          company:    it.company || '',
          source:     it.platform || 'Unknown',
          tier:       it.tier || null,
          age_days:   it.daysInQueue,
          scraped_at: it.dateAdded || null,
          already_discarded: !!it.alreadyDiscarded,
        }));
      return json({
        ok: true,
        days_threshold: days,
        count: items.length,
        items,
        deferred_count: activeDefers.size,
      });
    } catch (err) {
      console.error('[stale-items] error:', err);
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // POST /api/pipeline/remove-url — Feature 1 "Trash" action.
  // Removes a single pipeline.md row by URL match. Body: { url }.
  // Atomic write via tmp + rename. Idempotent: not-found returns 200.
  if (url === '/api/pipeline/remove-url' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 4 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'Invalid JSON body' }, 400); }
      const target = String(parsed.url || '').trim();
      if (!target) return json({ ok: false, error: 'url is required' }, 400);
      if (target.length > 2048) return json({ ok: false, error: 'URL too long' }, 400);
      const path = join(ROOT, 'data/pipeline.md');
      if (!existsSync(path)) return json({ ok: false, error: 'pipeline.md not found' }, 500);
      const content = readFileSync(path, 'utf8');
      const lines = content.split('\n');
      let removed = 0;
      const keep = lines.filter(l => {
        if (!l.startsWith('- [ ]')) return true;
        const rest = l.replace(/^- \[ \]\s*/, '').trim();
        const firstCell = (rest.split('|')[0] || '').trim();
        if (firstCell === target) { removed++; return false; }
        return true;
      });
      if (removed === 0) {
        return json({ ok: true, removed: 0, note: 'URL not found in pipeline.md (already removed?)' });
      }
      const tmp = path + '.tmp.' + process.pid + '.' + Date.now();
      try {
        writeFileSync(tmp, keep.join('\n'));
        renameSync(tmp, path);
      } catch (err) {
        return json({ ok: false, error: 'Atomic write failed: ' + err.message }, 500);
      }
      return json({ ok: true, removed });
    });
    return;
  }

  // POST /api/pipeline/defer-url — 2026-05-18 "Defer" action.
  // Records a deferral in data/stale-defers.json: { url, deferred_at,
  // defer_until }. Default snooze = 14 days. The /api/pipeline/stale-items
  // endpoint filters out items whose defer_until is still in the future.
  // Body: { url, days? (default 14) }. Idempotent: same URL updates the
  // deferral instead of duplicating.
  if (url === '/api/pipeline/defer-url' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > 4 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'Invalid JSON body' }, 400); }
      const target = String(parsed.url || '').trim();
      if (!target) return json({ ok: false, error: 'url is required' }, 400);
      if (target.length > 2048) return json({ ok: false, error: 'URL too long' }, 400);
      const daysRaw = parseInt(parsed.days, 10);
      const days = (!isNaN(daysRaw) && daysRaw >= 1 && daysRaw <= 365) ? daysRaw : 14;
      const fp = join(ROOT, 'data/stale-defers.json');
      let state = { defers: {} };
      try {
        if (existsSync(fp)) state = JSON.parse(readFileSync(fp, 'utf-8'));
        if (!state.defers || typeof state.defers !== 'object') state.defers = {};
      } catch (_) { /* corrupt file → start fresh */ }
      const now = new Date();
      const until = new Date(now.getTime() + days * 86400000);
      state.defers[target] = {
        deferred_at: now.toISOString(),
        defer_until: until.toISOString(),
        days,
      };
      try {
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, fp);
      } catch (err) {
        return json({ ok: false, error: 'Atomic write failed: ' + err.message }, 500);
      }
      return json({
        ok: true,
        deferred_until: until.toISOString().slice(0, 10),
        days,
      });
    });
    return;
  }

  // ── Scan activity — bottom-strip click-through (2026-05-17) ──────────
  // GET /api/scan-activity?limit=20
  // Lists the most recent scan events from data/scan-history.tsv with
  // a per-portal rollup (jobs found, jobs new, first-seen-on-this-scan,
  // age). Data source = parseScanHistory() (which returns one row per URL),
  // grouped by portal+date, sorted newest-first, capped at `limit` groups.
  if (url === '/api/scan-activity') {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(query.limit || '20', 10) || 20));
      const rows = parseScanHistory();
      // Group by (portal, first_seen date) — that's how scans appear in
      // the TSV. Per group: jobs_found = entries, jobs_new = entries marked
      // 'new' or where status begins 'pending'.
      const groups = new Map();
      for (const r of rows) {
        if (!r.portal) continue;
        const dateKey = (r.first_seen || '').slice(0, 10);
        const key = r.portal + '|' + dateKey;
        if (!groups.has(key)) {
          groups.set(key, {
            portal: r.portal,
            date: dateKey,
            jobs_found: 0,
            jobs_new: 0,
            sample_companies: new Set(),
          });
        }
        const g = groups.get(key);
        g.jobs_found++;
        // 'new' is the most common status for fresh URLs in scan-history.tsv
        const s = (r.status || '').toLowerCase();
        if (s === 'new' || s.startsWith('pending')) g.jobs_new++;
        if (r.company && g.sample_companies.size < 5) g.sample_companies.add(r.company);
      }
      const list = Array.from(groups.values())
        .map(g => ({
          portal: g.portal,
          date:   g.date,
          jobs_found: g.jobs_found,
          jobs_new:   g.jobs_new,
          sample_companies: Array.from(g.sample_companies),
        }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, limit);
      return json({ ok: true, events: list, total_groups: groups.size, generated_at: new Date().toISOString() });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
      return;
    }
  }

  // ── System health — bottom-strip click-through (2026-05-17) ──────────
  // GET /api/system-health
  // Lists launchd jobs (career-ops.*), cloudflared tunnel state, dashboard
  // server uptime, and tail of data/errors.log. Best-effort — any check
  // that fails returns null/false rather than aborting the whole payload.
  if (url === '/api/system-health') {
    // 2026-05-18 — Refactored from synchronous execSync (which blocked the
    // event loop ~150ms per call) to async execFile via Promise wrapper.
    // Both spawn calls now run in PARALLEL via Promise.all. Plus: errors.log
    // lines now parsed into structured { ts, severity, source, code, message }
    // shape so the system-health modal can render rows in a table (not raw
    // text). Closes two deferred items from prior session.
    (async () => {
      try {
        const _runProc = (cmd, args, timeoutMs) => new Promise((resolve) => {
          import('child_process').then(({ execFile }) => {
            execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
              if (err) return resolve('');
              resolve(stdout || '');
            });
          }).catch(() => resolve(''));
        });

        const [launchctlOut, pgrepOut] = await Promise.all([
          _runProc('launchctl', ['list'], 4000),
          _runProc('pgrep', ['-af', 'cloudflared'], 2000),
        ]);

        const jobs = launchctlOut.split('\n')
          .filter(l => l && /career-ops|careerops/i.test(l))
          .map(l => {
            const cols = l.split(/\t+/);
            return {
              pid:    cols[0] && cols[0] !== '-' ? parseInt(cols[0], 10) : null,
              status: cols[1] && cols[1] !== '-' ? parseInt(cols[1], 10) : null,
              label:  cols[2] || '',
            };
          });

        const tunnel = { running: false, info: '' };
        const tunOut = pgrepOut.trim();
        if (tunOut) {
          tunnel.running = true;
          tunnel.info = tunOut.split('\n')[0].slice(0, 240);
        }

        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const server = {
          uptime_seconds: Math.round(process.uptime()),
          node_version:   process.version,
          pid:            process.pid,
          memory_mb:      memMB,
        };

        // Raw errors.log → structured rows. Each line is parsed into:
        //   { ts, raw, severity, source, worker_id, exit_code, message }
        // The dashboard's system-health modal can now render this as a
        // table with sortable columns instead of grepping for substrings.
        const errLogPath = join(ROOT, 'data/errors.log');
        let errors = [];
        if (existsSync(errLogPath)) {
          try {
            const txt = readFileSync(errLogPath, 'utf-8');
            const lines = txt.split('\n').filter(l => l && l.trim()).slice(-20).reverse();
            errors = lines.map(parseErrorLine);
          } catch (_) {}
        }

        return json({
          ok: true,
          jobs,
          tunnel,
          server,
          errors,
          generated_at: new Date().toISOString(),
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── GET /api/job-runs-status ─────────────────────────────────────────
  // P1-5 scraper health widget data source.
  // Returns one entry per TRACKED_JOBS job with state derivation:
  //   green   — last_status='ok', finished within 1.0× cadence, urls_found > 0
  //   yellow  — past 1.0× cadence but not yet 2.0×
  //   red     — past 2.0× cadence
  //   purple  — last_status='ok' but urls_found == 0
  //   skipped — last_status='skipped'
  //   unknown — no ledger entries yet
  if (url === '/api/job-runs-status') {
    try {
      const nowMs = Date.now();
      const jobs = _trackedJobs().map(({ name, expected_cadence_minutes }) => {
        const last = lastFinishedRun(name);
        if (!last) {
          return { name, expected_cadence_minutes, last_finished_at: null, last_status: null, last_urls_found: null, state: 'unknown' };
        }
        const cadenceMs = expected_cadence_minutes * 60 * 1000;
        const finishedMs = last.finished_at ? new Date(last.finished_at).getTime() : 0;
        const ageMs = nowMs - finishedMs;
        let state;
        if (last.status === 'skipped') {
          state = 'skipped';
        } else if (last.status === 'ok' && (last.urls_found ?? 0) === 0) {
          state = 'purple';
        } else if (last.status === 'ok' && ageMs <= cadenceMs) {
          state = 'green';
        } else if (ageMs <= cadenceMs * 2) {
          state = 'yellow';
        } else {
          state = 'red';
        }
        return {
          name,
          expected_cadence_minutes,
          last_finished_at: last.finished_at || null,
          last_status: last.status,
          last_urls_found: last.urls_found ?? null,
          state,
        };
      });
      return json({ jobs });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // ── GET /api/job-runs-history?job=<name>&limit=<n> ───────────────────
  // Returns the last N runs for a single job (used by the widget's detail modal).
  if (url === '/api/job-runs-history') {
    try {
      const jobName = String(query.job || '').trim();
      const limit = Math.min(parseInt(query.limit || '10', 10) || 10, 100);
      if (!jobName) return json({ ok: false, error: 'job param required' }, 400);
      const rows = recentRuns(jobName, limit);
      return json({ ok: true, job: jobName, rows });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // ── GET /api/hang-watchdog/status ────────────────────────────────────
  // Surfaces hang-watchdog state for the dashboard system-health widget.
  // Reads data/hang-watchdog-state.json + tail of data/logs/hang-watchdog.out
  // (last NDJSON pass-complete event) + checks launchctl list for plist load.
  if (url === '/api/hang-watchdog/status') {
    (async () => {
      try {
        const statePath = join(ROOT, 'data', 'hang-watchdog-state.json');
        const logPath = join(ROOT, 'data', 'logs', 'hang-watchdog.out');
        let state = null;
        if (existsSync(statePath)) {
          try { state = JSON.parse(readFileSync(statePath, 'utf-8')); } catch {}
        }
        let lastPassComplete = null;
        const recentEvents = [];
        if (existsSync(logPath)) {
          try {
            const txt = readFileSync(logPath, 'utf-8');
            const lines = txt.split('\n').filter(l => l.startsWith('{')).slice(-50);
            for (const ln of lines) {
              try {
                const obj = JSON.parse(ln);
                if (obj.event === 'pass-complete') lastPassComplete = obj;
                if (obj.event === 'pass-complete' || obj.event === 'postmortem' || obj.event === 'kill-attempt') {
                  recentEvents.push(obj);
                }
              } catch {}
            }
          } catch {}
        }
        const _runProc = (cmd, args, timeoutMs) => new Promise((resolve) => {
          import('child_process').then(({ execFile }) => {
            execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
              if (err) return resolve('');
              resolve(stdout || '');
            });
          }).catch(() => resolve(''));
        });
        const listOut = await _runProc('launchctl', ['list'], 3000);
        const plistLoaded = /com\.mitchell\.career-ops\.hang-watchdog/.test(listOut);
        const dataDir = join(ROOT, 'data');
        let postmortems = [];
        try {
          postmortems = readdirSync(dataDir)
            .filter(f => /^hang-postmortem-\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
            .sort()
            .slice(-10)
            .map(f => ({ name: f, path: `data/${f}` }));
        } catch {}
        return json({
          ok: true,
          plist_loaded: plistLoaded,
          state: state ? {
            last_run: state.lastRun || null,
            pids_tracked: Object.keys(state.pidFlags || {}).length,
            history_count: (state.history || []).length,
            recent_history: (state.history || []).slice(-5),
          } : null,
          last_pass_complete: lastPassComplete,
          recent_events: recentEvents.slice(-10),
          postmortems,
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  // ── All-Evaluations bucket — Feature 2 (item-list-pop-out) ───────────
  // GET /api/all-evaluations/bucket?key={bucketKey}
  // Bucket keys: score-450-up, score-400-449, score-350-399, score-300-349,
  // score-below-300, status-evaluated, status-skip, status-discarded, plus
  // additional status keys for completeness.
  if (url === '/api/all-evaluations/bucket') {
    try {
      const key = String(query.key || '').trim();
      const BUCKET_FILTERS = {
        'score-450-up':     { label: 'Score 4.5+',     test: r => r.score >= 4.5 },
        'score-400-449':    { label: 'Score 4.0-4.4',  test: r => r.score >= 4.0 && r.score < 4.5 },
        'score-350-399':    { label: 'Score 3.5-3.9',  test: r => r.score >= 3.5 && r.score < 4.0 },
        'score-300-349':    { label: 'Score 3.0-3.4',  test: r => r.score >= 3.0 && r.score < 3.5 },
        'score-below-300':  { label: 'Score <3.0',     test: r => r.score < 3.0 },
        'status-evaluated': { label: 'Status: Evaluated',
          test: r => (r.status || '').toLowerCase() === 'evaluated' },
        'status-skip':      { label: 'Status: SKIP',
          test: r => (r.status || '').toLowerCase() === 'skip' },
        'status-discarded': { label: 'Status: Discarded',
          test: r => (r.status || '').toLowerCase() === 'discarded' },
        'status-applied':   { label: 'Status: Applied',
          test: r => (r.status || '').toLowerCase() === 'applied' },
        'status-rejected':  { label: 'Status: Rejected',
          test: r => (r.status || '').toLowerCase() === 'rejected' },
        'status-interview': { label: 'Status: Interview',
          test: r => (r.status || '').toLowerCase() === 'interview' },
        'status-offer':     { label: 'Status: Offer',
          test: r => (r.status || '').toLowerCase() === 'offer' },
        'status-responded': { label: 'Status: Responded',
          test: r => (r.status || '').toLowerCase() === 'responded' },
      };
      const filter = BUCKET_FILTERS[key];
      if (!filter) {
        return json({ ok: false, error: 'unknown bucket key', valid_keys: Object.keys(BUCKET_FILTERS) }, 400);
      }
      const apps = parseApplications();
      const matched = apps.filter(filter.test);
      // Sort: highest score first, then most recent eval (highest num).
      matched.sort((a, b) => (b.score - a.score) || (b.num - a.num));
      const rows = matched.slice(0, 500)
        .map(r => ({ ...r, reportSummary: r.report ? parseReportSummary(r.report) : {} }));
      return json({
        ok: true,
        bucket: { key, label: filter.label, count: matched.length },
        items: rows,
      });
    } catch (err) {
      console.error('[bucket] error:', err);
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── D25: Wave H1 new endpoints ────────────────────────────────────────────

  // Shared error logger for all D25 endpoints
  function _d25Log(msg) {
    const logsDir = join(ROOT, 'data/logs');
    try {
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      appendFileSync(join(logsDir, 'dashboard-server.log'),
        `${new Date().toISOString()} ${msg}\n`);
    } catch (_) {}
    console.error(msg);
  }

  // Helper: parse POST body as JSON with a byte cap
  function _readBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      let total = 0;
      req.on('data', c => {
        total += c.length;
        if (total > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
        body += c;
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // ── POST /api/finalize-apply-pack ─────────────────────────────────────────
  // 2026-05-18 — backend half of the Wave D apply-pack flow. The five
  // /api/build-pack-stage agents write to data/apply-packs/<num>-<company>-<role>/
  // sequentially. Once they're all done, the frontend calls this endpoint to
  // (a) zip that directory, (b) write the archive to ~/Documents/Apply Packs/
  // under the council+dealbreaker-adjudicated filename
  // (Company — Role (YYYY-MM-DD).zip with em-dash + surrounding spaces), and
  // (c) call `mdimport` so Spotlight picks up the new file immediately even
  // on macOS Tahoe where the daemon sometimes lags.
  //
  // body: { rowId, company, role, date? }
  // returns: { ok, packPath, sourceDir, fileSizeBytes }
  if (url === '/api/finalize-apply-pack' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        const { rowId, company, role } = body || {};
        const date = body?.date || new Date().toISOString().slice(0, 10);
        if (!rowId || !company || !role) {
          return json({ ok: false, error: 'rowId, company, and role are required' }, 400);
        }
        const padded = String(rowId).padStart(3, '0');
        const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const slug = `${padded}-${slugify(company)}-${slugify(role)}`;
        // E1 fix (2026-05-21): CREATE writes to apply-pack/<slug>/ (singular,
        // canonical artifact home), POLISH ALSO writes to data/apply-packs/<slug>/
        // (working dir for quarantine + polish-trace metadata) and mirrors
        // confidence≥target files back to apply-pack/. Previously this endpoint
        // ONLY looked in data/apply-packs/, so freshly-created (un-polished) packs
        // returned 404 on download. Fix: prefer apply-pack/<slug>/ as the primary
        // source, and when both exist, merge so polish-only artifacts
        // (impact-doc / references / referrals before mirror) still ship.
        const createDir = join(ROOT, 'apply-pack', slug);
        const polishDir = join(ROOT, 'data', 'apply-packs', slug);
        const haveCreate = existsSync(createDir);
        const havePolish = existsSync(polishDir);
        if (!haveCreate && !havePolish) {
          return json({
            ok: false,
            error: `No pack found at apply-pack/${slug}/ or data/apply-packs/${slug}/`,
            tried: [createDir, polishDir],
          }, 404);
        }
        const { execFile } = await import('child_process');
        const execFileP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
          execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${cmd} failed: ${err.message}${stderr ? ' · ' + stderr.toString().slice(0, 240) : ''}`));
            else resolve({ stdout, stderr });
          });
        });
        // Determine the zip source dir. Single source → zip directly. Both
        // exist → stage a temp merge dir so apply-pack/ wins on conflict and
        // polish-only artifacts (impact-doc, references, referrals before
        // mirroring) still ship in the zip.
        let zipSourceDir;
        let tempDirToCleanup = null;
        if (haveCreate && havePolish) {
          const tmpRoot = join(ROOT, 'data', 'tmp');
          mkdirSync(tmpRoot, { recursive: true });
          tempDirToCleanup = join(tmpRoot, `zip-merge-${slug}-${Date.now()}`);
          mkdirSync(tempDirToCleanup, { recursive: true });
          // 1) Copy polish artifacts first.
          await execFileP('cp', ['-R', `${polishDir}/.`, tempDirToCleanup]);
          // 2) Overlay CREATE files — they win on filename collision per spec.
          await execFileP('cp', ['-R', `${createDir}/.`, tempDirToCleanup]);
          zipSourceDir = tempDirToCleanup;
        } else if (haveCreate) {
          zipSourceDir = createDir;
        } else {
          zipSourceDir = polishDir;
        }
        const sourceDir = zipSourceDir;  // preserved for response payload
        const home = process.env.HOME || homedir();
        const destDir = join(home, 'Documents', 'Apply Packs');
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        // Council+dealbreaker filename (adjudicated 2026-05-18):
        //   "{Company} - {Role} ({YYYY-MM-DD}).zip"
        // ASCII hyphen with surrounding spaces per convention. Strip
        // apostrophes/accents so the filename is safe on all filesystems.
        const _sanitizeZip = (s) => String(s)
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[''`]/g, '')
          .replace(/[^A-Za-z0-9 \-.,&()]/g, '')
          .trim();
        const zipName = `${_sanitizeZip(company)} - ${_sanitizeZip(role)} (${date}).zip`;
        const zipPath = join(destDir, zipName);
        // zip -r {destZip} . — run inside zipSourceDir so the archive contains
        // the pack files at the top level.
        try {
          await execFileP('zip', ['-r', '-q', zipPath, '.'], { cwd: zipSourceDir });
        } finally {
          // Clean up any merge tempdir even if zip failed.
          if (tempDirToCleanup) {
            try { await execFileP('rm', ['-rf', tempDirToCleanup]); } catch {}
          }
        }
        // Force Spotlight to index the new file immediately. Best-effort —
        // mdimport returns 0 on success, but we don't block on it.
        try {
          execFile('mdimport', [zipPath], { timeout: 5000 }, () => { /* fire and forget */ });
        } catch (_) { /* mdimport is best-effort */ }
        const stat = statSync(zipPath);
        _d25Log(`[finalize-apply-pack] wrote ${zipPath} (${stat.size} bytes)`);
        return json({
          ok: true,
          packPath: zipPath,
          packPathDisplay: zipPath.replace(home, '~'),
          sourceDir,
          fileSizeBytes: stat.size,
        });
      } catch (err) {
        _d25Log(`[finalize-apply-pack] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── Closure G (2026-05-22) E2 — per-artifact manifest + download ─────────
  // Two endpoints power the drawer's per-file download links:
  //   GET /api/artifact-manifest?slug=<slug> — list files in the pack
  //   GET /api/artifact?slug=<slug>&file=<relPath> — stream one file
  // Both endpoints honor the same E1-fix merge logic (apply-pack/ wins on
  // collision, falls back to data/apply-packs/), and refuse paths that try
  // to escape the pack directory.
  if (url.startsWith('/api/artifact-manifest') && req.method === 'GET') {
    (async () => {
      try {
        // The `url` at top-of-handler has the query string stripped — use the
        // pre-parsed `query` object that handleRequest already populated.
        let slug = String(query.slug || '').trim();
        // Row-based lookup — find the pack dir starting with the padded row num.
        if (!slug) {
          const rowParam = String(query.row || '').trim();
          if (rowParam && /^[0-9]{1,4}$/.test(rowParam)) {
            const padded = rowParam.padStart(3, '0');
            const { readdirSync: _rd } = await import('node:fs');
            const dirs = [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')];
            for (const d of dirs) {
              if (!existsSync(d)) continue;
              let entries;
              try { entries = _rd(d, { withFileTypes: true }); } catch (_) { continue; }
              const hit = entries.find(e => e.isDirectory() && e.name.startsWith(padded + '-'));
              if (hit) { slug = hit.name; break; }
            }
          }
        }
        if (!slug || !/^[A-Za-z0-9_.-]+$/.test(slug)) {
          return json({ ok: false, error: 'no pack found for row/slug' }, 404);
        }
        const createDir = join(ROOT, 'apply-pack', slug);
        const polishDir = join(ROOT, 'data', 'apply-packs', slug);
        const haveCreate = existsSync(createDir);
        const havePolish = existsSync(polishDir);
        if (!haveCreate && !havePolish) {
          return json({ ok: false, error: `No pack found for ${slug}` }, 404);
        }
        // Build a unified file list across both dirs. apply-pack/ wins on
        // collision (same merge order as the zip endpoint).
        const fileMap = new Map();  // relPath → { source, size }
        const { readdirSync, statSync: _statSync } = await import('node:fs');
        function _walk(baseDir, rel = '') {
          const fullDir = rel ? join(baseDir, rel) : baseDir;
          let entries;
          try { entries = readdirSync(fullDir, { withFileTypes: true }); }
          catch (_) { return; }
          for (const e of entries) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { _walk(baseDir, childRel); continue; }
            if (!e.isFile()) continue;
            // Skip junk + dotfiles.
            if (e.name.startsWith('.')) continue;
            try {
              const st = _statSync(join(baseDir, childRel));
              // apply-pack/ wins on collision — only set if not already present
              // from a higher-priority source.
              if (!fileMap.has(childRel)) {
                fileMap.set(childRel, { source: baseDir === createDir ? 'create' : 'polish', size: st.size });
              }
            } catch (_) { /* skip unreadable */ }
          }
        }
        // Walk create first (it wins), then polish (for polish-only files).
        if (haveCreate) _walk(createDir);
        if (havePolish) _walk(polishDir);
        const files = Array.from(fileMap.entries())
          .map(([rel, meta]) => ({ rel, size: meta.size, source: meta.source }))
          .sort((a, b) => a.rel.localeCompare(b.rel));
        return json({ ok: true, slug, files, count: files.length });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  if (url.startsWith('/api/artifact') && url.indexOf('/api/artifact-manifest') !== 0 && req.method === 'GET') {
    (async () => {
      try {
        const slug = String(query.slug || '').trim();
        const relFile = String(query.file || '').trim();
        if (!slug || !/^[A-Za-z0-9_.-]+$/.test(slug)) {
          return json({ ok: false, error: 'invalid slug' }, 400);
        }
        if (!relFile) {
          return json({ ok: false, error: 'missing file param' }, 400);
        }
        // Path-traversal defense: reject any segment that contains ..
        // or starts with /, and reject absolute paths.
        const normalized = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
        if (normalized.split('/').some(seg => seg === '..' || seg === '' || seg === '.')) {
          return json({ ok: false, error: 'invalid file path' }, 400);
        }
        const createDir = join(ROOT, 'apply-pack', slug);
        const polishDir = join(ROOT, 'data', 'apply-packs', slug);
        // Try create first (it wins on collision), then polish.
        const candidates = [join(createDir, normalized), join(polishDir, normalized)];
        let resolved = null;
        for (const c of candidates) {
          // Final guard — c must remain inside its base dir after join.
          const base = c.startsWith(createDir) ? createDir : polishDir;
          const rel  = c.slice(base.length + 1);
          if (rel.indexOf('..') !== -1) continue;
          if (existsSync(c)) { resolved = c; break; }
        }
        if (!resolved) {
          return json({ ok: false, error: 'file not found in pack' }, 404);
        }
        const stat = statSync(resolved);
        if (!stat.isFile()) {
          return json({ ok: false, error: 'not a regular file' }, 400);
        }
        // Pick a sensible Content-Type by extension.
        const ext = normalized.split('.').pop().toLowerCase();
        const contentTypeMap = {
          'md': 'text/markdown; charset=utf-8',
          'txt': 'text/plain; charset=utf-8',
          'json': 'application/json; charset=utf-8',
          'pdf': 'application/pdf',
          'html': 'text/html; charset=utf-8',
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
        };
        const ct = contentTypeMap[ext] || 'application/octet-stream';
        const downloadName = normalized.split('/').pop();
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${downloadName.replace(/"/g, '')}"`,
          'Cache-Control': 'private, max-age=60',
        });
        const { createReadStream } = await import('node:fs');
        createReadStream(resolved).pipe(res);
      } catch (err) {
        try { return json({ ok: false, error: err.message }, 500); } catch (_) {}
      }
    })();
    return;
  }

  // ── GET /api/apply-pack-zip?slug=<slug> ──────────────────────────────────
  // 09 Part 2 Item B (2026-05-22) — stream a fresh zip of every artifact in
  // an apply-pack as a single download. The browser fires a download with
  // filename `<company>-<role>-<YYYY-MM-DD>.zip` containing every file in
  // the pack. Reuses the same E1 merge logic as /api/finalize-apply-pack
  // (apply-pack/ wins on collision, falls back to data/apply-packs/).
  if (url.startsWith('/api/apply-pack-zip') && req.method === 'GET') {
    (async () => {
      try {
        const slug = String(query.slug || '').trim();
        if (!slug || !/^[A-Za-z0-9_.-]+$/.test(slug)) {
          return json({ ok: false, error: 'invalid slug' }, 400);
        }
        const createDir = join(ROOT, 'apply-pack', slug);
        const polishDir = join(ROOT, 'data', 'apply-packs', slug);
        const haveCreate = existsSync(createDir);
        const havePolish = existsSync(polishDir);
        if (!haveCreate && !havePolish) {
          return json({ ok: false, error: 'pack not found at apply-pack/' + slug + ' or data/apply-packs/' + slug }, 404);
        }
        const { execFile } = await import('child_process');
        const execFileP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
          execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${cmd} failed: ${err.message}${stderr ? ' · ' + stderr.toString().slice(0, 240) : ''}`));
            else resolve({ stdout, stderr });
          });
        });

        // Stage temp merge dir same way as /api/finalize-apply-pack does.
        let zipSourceDir;
        let tempDirToCleanup = null;
        if (haveCreate && havePolish) {
          const tmpRoot = join(ROOT, 'data', 'tmp');
          mkdirSync(tmpRoot, { recursive: true });
          tempDirToCleanup = join(tmpRoot, `zip-stream-${slug}-${Date.now()}`);
          mkdirSync(tempDirToCleanup, { recursive: true });
          await execFileP('cp', ['-R', `${polishDir}/.`, tempDirToCleanup]);
          await execFileP('cp', ['-R', `${createDir}/.`, tempDirToCleanup]);
          zipSourceDir = tempDirToCleanup;
        } else if (haveCreate) {
          zipSourceDir = createDir;
        } else {
          zipSourceDir = polishDir;
        }

        // Build the zip in a temp file, then stream it.
        const tmpRoot2 = join(ROOT, 'data', 'tmp');
        mkdirSync(tmpRoot2, { recursive: true });
        const tmpZip = join(tmpRoot2, `pack-${slug}-${Date.now()}.zip`);
        try {
          await execFileP('zip', ['-r', '-q', tmpZip, '.'], { cwd: zipSourceDir });
        } finally {
          if (tempDirToCleanup) {
            try { await execFileP('rm', ['-rf', tempDirToCleanup]); } catch {}
          }
        }
        if (!existsSync(tmpZip)) {
          return json({ ok: false, error: 'zip creation failed' }, 500);
        }
        const stat = statSync(tmpZip);
        // Derive download filename: slug is num-company-role; strip the
        // num prefix to make the download name cleaner.
        const date = new Date().toISOString().slice(0, 10);
        const downloadName = `${slug}-${date}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${downloadName}"`,
          'Cache-Control': 'private, no-cache',
        });
        const { createReadStream } = await import('node:fs');
        const stream = createReadStream(tmpZip);
        stream.on('end', () => {
          try { unlinkSync(tmpZip); } catch (_) {}
        });
        stream.on('error', () => {
          try { unlinkSync(tmpZip); } catch (_) {}
        });
        stream.pipe(res);
      } catch (err) {
        try { return json({ ok: false, error: err.message }, 500); } catch (_) {}
      }
    })();
    return;
  }

  // ── GET /api/ai-detection/signal-quality ─────────────────────────────────
  // DELTA P2 — exposes the current calibrated thresholds + signal-quality
  // summary so the dashboard can render an honest "Detection signal quality"
  // section instead of asking the user to interpret a 99% GPTZero score as
  // a real failure when the calibration baseline shows it's a known FPR.
  if (url === '/api/ai-detection/signal-quality' && req.method === 'GET') {
    (async () => {
      try {
        const thresholdsPath = join(ROOT, 'data', 'ai-detection-calibration', 'current-thresholds.json');
        const baselineGlob = join(ROOT, 'data', 'ai-detection-calibration');
        let thresholds = null;
        if (existsSync(thresholdsPath)) {
          thresholds = JSON.parse(readFileSync(thresholdsPath, 'utf-8'));
        }
        // Find most recent baseline summary file
        const { readdirSync } = await import('node:fs');
        const baselineFiles = existsSync(baselineGlob)
          ? readdirSync(baselineGlob).filter(f => f.startsWith('baseline-') && f.endsWith('.json')).sort().reverse()
          : [];
        const latestBaseline = baselineFiles[0]
          ? JSON.parse(readFileSync(join(baselineGlob, baselineFiles[0]), 'utf-8'))
          : null;

        function signalQualityFor(det) {
          const gap = (det?.CRIT?.min ?? 1) - (det?.CLEAR?.max ?? 0);
          return {
            clear_ceiling: det?.CLEAR?.max ?? null,
            crit_floor: det?.CRIT?.min ?? null,
            gap,
            signal_quality: gap >= 0.20 ? 'GOOD' : gap >= 0.05 ? 'WEAK' : 'USELESS',
          };
        }
        const summary = thresholds ? {
          calibrated_at: thresholds.derived_at,
          gptzero: signalQualityFor(thresholds.gptzero),
          originality: signalQualityFor(thresholds.originality),
          pangram: signalQualityFor(thresholds.pangram),
        } : null;

        const qualities = summary
          ? [summary.gptzero.signal_quality, summary.originality.signal_quality, summary.pangram.signal_quality]
          : [];
        const anyGood = qualities.includes('GOOD');
        const allUseless = qualities.length > 0 && qualities.every(q => q === 'USELESS');

        return json({
          ok: true,
          thresholds,
          summary,
          baseline_sample_counts: latestBaseline?.summary?.sample_counts ?? null,
          baseline_file: baselineFiles[0] ?? null,
          interpretation: !summary
            ? 'No calibration baseline present yet. The AI-detection bands cannot be evaluated until the baseline is built — re-calibrate the voice corpus to populate it.'
            : allUseless
              ? 'All three detectors are calibrated USELESS against Mitchell\'s voice baseline. The gate cannot distinguish authentic Mitchell prose from generic AI text. Artifacts surface as ADVISORY only — no blocking. Re-calibration after a voice-corpus refresh or Pangram API key add may change this.'
              : anyGood
                ? `Signal quality: GPTZero=${summary.gptzero.signal_quality}, Originality=${summary.originality.signal_quality}, Pangram=${summary.pangram.signal_quality}. At least one detector has GOOD signal — the gate WILL block artifacts in band=CRIT.`
                : `Signal quality: GPTZero=${summary.gptzero.signal_quality}, Originality=${summary.originality.signal_quality}, Pangram=${summary.pangram.signal_quality}. No GOOD-signal detector — the gate surfaces findings as ADVISORY only.`,
        });
      } catch (err) {
        _d25Log(`[ai-detection/signal-quality] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 1. POST /api/build-pack-stage ─────────────────────────────────────────
  // body: { rowId, stage: 'cv-tailor'|'cover-letter'|'why-statement'|'linkedin-dm'|'form-fields'|'impact-doc'|'references'|'referrals', config? }
  // Invokes scripts/agents/{stage}.mjs and returns SubAgentOutput JSON.
  //
  // Slug-resolution fix (2026-05-25 Worker C): resolveRowToPackInput()
  // resolves rowId → full SubAgentInput shape with pack.jd.{company,role} +
  // pack.meta.{row_id,company,role} populated from apply-now-queue.json
  // (preferred) or applications.md (fallback). Without this resolution,
  // cv-tailor's defaults ('Unknown', 0) write to
  // data/apply-packs/000-unknown-unknown/ — the bug being fixed here.
  if (url === '/api/build-pack-stage' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        const { rowId, stage, config } = body || {};
        // PR-07 (apply-now UX audit 2026-05-25): added impact-doc / references /
        // referrals so the build-pack-stage endpoint reaches every artifact the
        // apply-pack-polish loop expects. Pre-PR-07, the dashboard could regenerate
        // 5 of 8 polished artifacts via this endpoint; the remaining 3 were
        // documented-but-unbuilt at the HTTP surface even though the agent scripts
        // (scripts/agents/impact-doc.mjs etc) exist on disk.
        const VALID_STAGES = new Set(['cv-tailor', 'cover-letter', 'why-statement', 'linkedin-dm', 'form-fields', 'impact-doc', 'references', 'referrals']);
        if (!rowId) return json({ ok: false, error: 'rowId is required' }, 400);
        if (!stage || !VALID_STAGES.has(stage)) {
          return json({ ok: false, error: `stage must be one of: ${[...VALID_STAGES].join(', ')}` }, 400);
        }
        // Resolve rowId → SubAgentInput shape. Returns 400 if rowId is not
        // numeric or 404 if not found in queue/applications.
        const resolved = resolveRowToPackInput(rowId, { root: ROOT });
        if (!resolved.ok) {
          const code = /not found/i.test(resolved.error) ? 404 : 400;
          _d25Log(`[build-pack-stage] slug-resolution-failed rowId=${rowId}: ${resolved.error}`);
          return json({ ok: false, error: resolved.error, rowId, stage }, code);
        }
        const stagePath = join(ROOT, 'scripts/agents', stage + '.mjs');
        if (!existsSync(stagePath)) {
          return json({ ok: false, error: `agent script not found: ${stagePath}` }, 404);
        }
        const mod = await import(stagePath);
        // Each agent exports runXxx(input) — map stage name to exported function
        const fnMap = {
          'cv-tailor':    'runCvTailor',
          'cover-letter': 'runCoverLetter',
          'why-statement': 'runWhyStatement',
          'linkedin-dm':  'runLinkedinDm',
          'form-fields':  'runFormFields',
          // PR-07 (2026-05-25): impact-doc / references / referrals dispatch.
          // Exports verified at scripts/agents/{impact-doc,references,referrals}.mjs
          // — runImpactDoc, runReferences, runReferrals.
          'impact-doc':   'runImpactDoc',
          'references':   'runReferences',
          'referrals':    'runReferrals',
        };
        const fnName = fnMap[stage];
        const fn = mod[fnName];
        if (typeof fn !== 'function') {
          return json({ ok: false, error: `agent module missing export ${fnName}` }, 500);
        }
        const result = await fn({
          pack: resolved.packInput.pack,
          context: {},
          config: { dryRun: true, ...(config || {}) },
        });
        // DELTA P1 — surface band-aware AI-detection state in the response
        // so the dashboard client can render the Editing Priority callout
        // without parsing nested SubAgentOutput shapes. Merged with HEAD's
        // ok=(status !== 'error') propagation so legacy "error" results
        // don't get reported as ok=true.
        const apiDet = result?.output?.api_detection ?? null;
        const editingPriority = computeEditingPriority(apiDet, result);
        const isError = result?.status === 'error';
        if (isError) {
          const errMsg = result?.error || '(no error message on result)';
          _d25Log(`[build-pack-stage] stage=${stage} rowId=${rowId} status=error: ${errMsg}`);
          // Also append a parser-formatted line to data/errors.log so the
          // existing batch-failures widget (parseErrorLine at line ~222) +
          // system-health tail come back to life. Best-effort: never throw
          // out of an error-logging path.
          try {
            const errLogLine = `[${new Date().toISOString()}] BUILDPACK FAIL id=${rowId} exit=1: ${stage}: ${String(errMsg).replace(/\r?\n/g, ' ').slice(0, 400)}\n`;
            appendFileSync(join(ROOT, 'data/errors.log'), errLogLine);
          } catch (_) { /* logging errors must never break the response */ }
        }
        const respPayload = {
          ok: !isError,
          stage,
          rowId,
          // Hoist agent error to top-level so the client doesn't need to dig
          // into result.error. Prevents the "Error: 200" UX bug where the
          // client's `data.error || resp.status` fallback surfaced HTTP 200
          // as if it were the error code.
          error: isError ? (result?.error || 'agent returned status=error with no message') : null,
          result,
          // top-level convenience fields read by build-dashboard.mjs client code
          ai_detection_failed: apiDet?.gateBlocks === true,
          ai_detection_band: apiDet?.band ?? null,
          gpt_zero_score:    apiDet?.gptzero_prob   != null ? Math.round(apiDet.gptzero_prob   * 100) : null,
          originality_score: apiDet?.originality_prob != null ? Math.round(apiDet.originality_prob * 100) : null,
          pangram_score: apiDet?.pangram_prob != null ? Math.round(apiDet.pangram_prob * 100) : null,
          ai_detection_signal_quality: {
            gptzero:     apiDet?.gptzero_signal_quality     ?? null,
            originality: apiDet?.originality_signal_quality ?? null,
            pangram:     apiDet?.pangram_signal_quality     ?? null,
          },
          editing_priority: editingPriority,
          ai_detection_retry_status: result?.diagnostics?.api_detection_retry_status ?? null,
          ai_detection_retry_stages: result?.diagnostics?.api_detection_retry_stages ?? 0,
        };
        return json(respPayload);
      } catch (err) {
        _d25Log(`[build-pack-stage] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 2. GET /api/drill/metric/{rowId}/{key} ─────────────────────────────────
  // Returns rendered provenance card HTML via lib/decision-provenance.mjs
  const drillMetricMatch = url.match(/^\/api\/drill\/metric\/([^/]+)\/([^/]+)$/);
  if (drillMetricMatch) {
    (async () => {
      try {
        const { getProvenance, renderProvenanceCard } = await import(join(ROOT, 'lib/decision-provenance.mjs'));
        const rowId = decodeURIComponent(drillMetricMatch[1]);
        const key   = decodeURIComponent(drillMetricMatch[2]);
        const prov = getProvenance(rowId, key);
        const html = renderProvenanceCard(prov);
        return json({ ok: true, rowId, key, html, provenance: prov });
      } catch (err) {
        _d25Log(`[drill/metric] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 2b. GET /api/gate-info/{gateId}/{rowId} ────────────────────────────────
  // PR #3 H-chip click popout (2026-05-26): returns the small-popout HTML
  // for a single H-gate at a single row — gate definition, your verdict +
  // rationale, alignment narrative, recommended action, and hyperlinks to
  // anticipated next-clicks. Drives the click-into-H-chip UI surface.
  const gateInfoMatch = url.match(/^\/api\/gate-info\/([^/]+)\/([^/]+)$/);
  if (gateInfoMatch) {
    (async () => {
      try {
        const { getGateInfo, renderGateInfoCard } = await import(join(ROOT, 'lib/decision-provenance.mjs'));
        const gateId = decodeURIComponent(gateInfoMatch[1]);
        const rowId  = decodeURIComponent(gateInfoMatch[2]);
        const info = getGateInfo(rowId, gateId);
        const html = renderGateInfoCard(info);
        return json({ ok: true, gateId, rowId, html, info });
      } catch (err) {
        _d25Log(`[gate-info] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 3. GET /api/drill/percentage/{rowId}/{key} ─────────────────────────────
  // Returns rendered strategy card HTML via lib/strategy-ceiling.mjs.
  //
  // 2026-05-23 B3 row hydration: previously called computeStrategyCeiling with
  // hardcoded empty role/company/hmIntel — defeated the lib/ground-prompt.mjs
  // RAG grounding entirely. Now hydrates from data/applications.md (role+company
  // by rowId) and data/hm-intel/<slug>.json (HM intel context).
  //
  // Endpoint-level dotenv re-load with override:true is belt-and-suspenders to
  // the top-of-file dotenv (B4) — preserves the existing endpoint pattern.
  // Path-only match; query string parsed separately so ?refresh=1 works.
  const drillPctPath = url.split('?')[0];
  const drillPctQuery = url.includes('?') ? url.split('?')[1] : '';
  const drillPctMatch = drillPctPath.match(/^\/api\/drill\/percentage\/([^/]+)\/([^/]+)$/);
  if (drillPctMatch) {
    (async () => {
      try {
        try {
          const dotenv = await import('dotenv');
          dotenv.config({ path: join(ROOT, '.env'), override: true });
        } catch (_) { /* dotenv soft-fail */ }

        const { getCachedStrategy, computeStrategyCeiling, renderStrategyCard } = await import(join(ROOT, 'lib/strategy-ceiling.mjs'));
        const rowId = decodeURIComponent(drillPctMatch[1]);
        const key   = decodeURIComponent(drillPctMatch[2]);
        // 2026-05-25 popout-action-completed-mode — ?refresh=1 forces cache miss
        // so the data-first gap-fallback's "Generate now" button produces a
        // fresh synthesis. maxAgeMs=0 makes computeStrategyCeiling skip cache read.
        const refreshRequested = /(^|&)refresh=1(&|$)/.test(drillPctQuery || '');

        let role = '', company = '', hmIntel = null;
        // 2026-05-31 FIX 1 — sidebar-value reconciliation.
        // The sidebar percentage for each metric comes from scoreAlignmentCached
        // (alignment-scorer.mjs). If we pass currentValue: null, the LLM receives
        // no anchor and the strategy card can render a "Current: 0%" headline that
        // disagrees with the sidebar value the user just clicked. Fix: derive the
        // exact sidebar value here and pass it as currentValue so both renderers
        // (legacy + data-first) display the identical number the sidebar shows.
        // KEY_MAP mirrors the normalize table in build-dashboard.mjs _drillInRegister.
        const SIDEBAR_KEY_MAP = {
          alignment:  'alignment',
          interview:  'interview',
          hmNoticing: 'hmNoticing',
          hm:         'hmNoticing',
          profile:    'alignment',
          profile_alignment:    'alignment',
          interview_likelihood: 'interview',
          hm_noticing_chance:   'hmNoticing',
          hm_noticing:          'hmNoticing',
        };
        let currentValue = null;
        let rowReportPath = null;
        try {
          const apps = parseApplications();
          const row = apps.find(r => String(r.num) === String(rowId));
          if (row) {
            role = row.role || '';
            company = row.company || '';
            rowReportPath = row.report || row.reportPath || null;
            if (company && role) {
              const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
              const hmIntelPath = join(ROOT, 'data', 'hm-intel', `${slug(company)}-${slug(role)}.json`);
              if (existsSync(hmIntelPath)) {
                try { hmIntel = JSON.parse(readFileSync(hmIntelPath, 'utf-8')); } catch { /* malformed JSON → null */ }
              }
            }
            // Derive sidebar value from alignment-scorer (same source as build-dashboard.mjs bar).
            const alignField = SIDEBAR_KEY_MAP[key] || null;
            if (alignField && rowReportPath) {
              try {
                const { scoreAlignmentCached } = await import(join(ROOT, 'lib', 'alignment-scorer.mjs'));
                const absReportPath = rowReportPath.startsWith('/') ? rowReportPath : join(ROOT, rowReportPath);
                if (existsSync(absReportPath)) {
                  const align = scoreAlignmentCached({ reportPath: absReportPath, companyName: company });
                  if (!align.unavailable && typeof align[alignField] === 'number') {
                    currentValue = align[alignField];
                  }
                }
              } catch (alignErr) {
                _d25Log(`[drill/percentage] sidebar-value hydration soft-failed: ${alignErr.message}`);
              }
            }
          }
        } catch (e) {
          _d25Log(`[drill/percentage] hydration soft-failed: ${e.message}`);
        }

        // computeStrategyCeiling now derives cacheKey from buildGroundedPrompt
        // (corpus-mtime aware) — no need to compute it separately here.
        const result = await computeStrategyCeiling({
          rowId, metricKey: key, role, company,
          currentValue, jdText: '', hmIntel,
          opts: refreshRequested ? { maxAgeMs: 0 } : {},
        });
        const html = renderStrategyCard(result);
        return json({ ok: true, rowId, key, html, strategy: result, refresh: refreshRequested });
      } catch (err) {
        _d25Log(`[drill/percentage] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 4. POST /api/inline-update ────────────────────────────────────────────
  // body: { rowId, field: 'status'|'notes', value }
  // Writes to data/applications.md; optimistic-update pattern.
  if (url === '/api/inline-update' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        const { rowId, field, value } = body || {};
        if (!rowId) return json({ ok: false, error: 'rowId is required' }, 400);
        if (field !== 'status' && field !== 'notes') {
          return json({ ok: false, error: "field must be 'status' or 'notes'" }, 400);
        }
        if (value === undefined || value === null) return json({ ok: false, error: 'value is required' }, 400);
        // Parse row ID — strip 'apply-' prefix if present (row IDs are sometimes 'apply-{num}')
        const numStr = String(rowId).replace(/^apply-/, '');
        const num = parseInt(numStr, 10);
        if (Number.isNaN(num)) return json({ ok: false, error: `invalid rowId: ${rowId}` }, 400);
        let result;
        if (field === 'status') {
          result = updateApplicationStatus({ num, status: value });
        } else {
          // notes field update — use same atomic-write mechanism
          result = updateApplicationStatus({ num, status: undefined, note: String(value).slice(0, 600) });
          // updateApplicationStatus requires a valid status; for notes-only updates, re-read
          // current status first
          if (!result.ok && result.error && result.error.includes('status is required')) {
            const apps = parseApplications();
            const row = apps.find(r => String(r.num) === String(num));
            if (!row) return json({ ok: false, error: `row #${num} not found` }, 404);
            result = updateApplicationStatus({ num, status: row.status, note: String(value).slice(0, 600) });
          }
        }
        const code = result.ok ? 200 : (result.code || 400);
        return json(result.ok ? { ok: true, rowId, field, value, row: result.row } : { ok: false, error: result.error }, code);
      } catch (err) {
        _d25Log(`[inline-update] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 5. POST /api/weekly-update ────────────────────────────────────────────
  // body: { week: 'YYYY-Www', content, highlights?, tpgm_evidence?, artifacts?, skills?, courses? }
  // Appends to data/skill-tracker/{YYYY-Www}.md (creates from _TEMPLATE.md if missing).
  if (url === '/api/weekly-update' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        const { week, content, highlights, tpgm_evidence, artifacts, skills, courses } = body || {};
        if (!week || !/^\d{4}-W\d{2}$/.test(week)) {
          return json({ ok: false, error: 'week is required in YYYY-Www format (e.g. 2026-W20)' }, 400);
        }
        const trackerDir = join(ROOT, 'data/skill-tracker');
        if (!existsSync(trackerDir)) mkdirSync(trackerDir, { recursive: true });
        const weekFile = join(trackerDir, `${week}.md`);
        const templateFile = join(trackerDir, '_TEMPLATE.md');
        let existing = '';
        if (existsSync(weekFile)) {
          existing = readFileSync(weekFile, 'utf8');
        } else if (existsSync(templateFile)) {
          // Create from template — substitute week placeholders
          const [year, weekNum] = week.split('-W');
          const weekStart = (() => {
            // ISO week start (Monday) for year + weekNum
            const d = new Date(parseInt(year, 10), 0, 1);
            const dayOfWeek = d.getDay() || 7;
            d.setDate(d.getDate() + (1 - dayOfWeek) + (parseInt(weekNum, 10) - 1) * 7);
            return d.toISOString().slice(0, 10);
          })();
          const weekEnd = (() => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() + 6);
            return d.toISOString().slice(0, 10);
          })();
          existing = readFileSync(templateFile, 'utf8')
            .replace(/YYYY-MM-DD/g, weekStart)
            .replace(/YYYY-WNN/, week)
            .replace('week_end: ' + weekStart, 'week_end: ' + weekEnd)
            .replace('created_at: YYYY-MM-DDTHH:MM:SS-07:00',
              `created_at: ${new Date().toISOString().replace('Z', '-07:00')}`);
        } else {
          // No template — create minimal file
          existing = `---\nweek_index: ${week}\ncreated_at: ${new Date().toISOString()}\n---\n\n`;
        }

        // Append sections from submitted body
        const ts = new Date().toISOString();
        const appendix = [];
        if (content) appendix.push(`\n<!-- Ingest via /api/weekly-update ${ts} -->\n${content}`);
        if (highlights) appendix.push(`\n# Highlights\n\n${highlights}`);
        if (tpgm_evidence) appendix.push(`\n# TPgM Evidence\n\n${tpgm_evidence}`);
        if (artifacts) appendix.push(`\n# Artifacts\n\n${artifacts}`);
        if (skills) appendix.push(`\n# Skills\n\n${skills}`);
        if (courses) appendix.push(`\n# Courses & Certifications\n\n${courses}`);

        if (!appendix.length) {
          return json({ ok: false, error: 'no content provided — include at least one of: content, highlights, tpgm_evidence, artifacts, skills, courses' }, 400);
        }

        const finalContent = existing + appendix.join('\n');
        // Atomic write
        const tmpPath = weekFile + '.tmp.' + process.pid + '.' + Date.now();
        writeFileSync(tmpPath, finalContent);
        renameSync(tmpPath, weekFile);

        return json({ ok: true, week, file: weekFile, sections_written: appendix.length });
      } catch (err) {
        _d25Log(`[weekly-update] ${err.message}`);
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── 6. POST /api/career-update — Update Drawer (Inventory B5 MVP, 2026-05-18)
  //   body: { tag: 'project'|'cert'|'training'|'1:1'|'note', text: string, date?: 'YYYY-MM-DD' }
  //   1. Validate
  //   2. Append { ts, date, tag, text } to data/career-updates.jsonl (atomic via
  //      appendFile — JSONL tolerates partial writes line-by-line)
  //   3. Spawn scripts/merge-career-updates.mjs as a detached child so the
  //      response returns immediately; the merger updates corpus + commits via
  //      agent-commit.mjs on its own clock. UPDATE_MERGER_DISABLED=1 env var
  //      short-circuits the spawn (useful for tests).
  //   Response: { ok: true, ts, file }
  if (url === '/api/career-update' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        const VALID_TAGS = new Set(['project', 'cert', 'training', '1:1', 'note']);
        const tag = (body && typeof body.tag === 'string') ? body.tag.trim() : '';
        const text = (body && typeof body.text === 'string') ? body.text.trim() : '';
        if (!VALID_TAGS.has(tag)) {
          return json({ ok: false, error: `tag must be one of: ${[...VALID_TAGS].join(', ')}` }, 400);
        }
        if (!text || text.length < 1) {
          return json({ ok: false, error: 'text is required' }, 400);
        }
        if (text.length > 5000) {
          return json({ ok: false, error: 'text exceeds 5000 chars' }, 400);
        }
        // Date — accept caller's YYYY-MM-DD or default to today (PDT)
        let date = (body && typeof body.date === 'string') ? body.date.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          date = new Date().toISOString().slice(0, 10);
        }
        const ts = new Date().toISOString();
        const entry = { ts, date, tag, text };
        const jsonlPath = join(ROOT, 'data/career-updates.jsonl');
        // Ensure the data/ dir exists (it does by default, but tolerate fresh clones)
        try { if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true }); } catch (_) {}
        appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');

        // Spawn the merger detached + unref so it runs out-of-band.
        if (process.env.UPDATE_MERGER_DISABLED !== '1') {
          try {
            const child = _spawn(
              'node',
              [join(ROOT, 'scripts/merge-career-updates.mjs'), '--limit', '10'],
              { cwd: ROOT, stdio: 'ignore', detached: true },
            );
            child.unref();
          } catch (e) {
            // Merge failure must not block the user's save. Log and move on.
            console.error('[career-update] merger spawn failed:', e.message);
          }
        }
        return json({ ok: true, ts, date, tag, file: 'data/career-updates.jsonl' });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // GET /api/career-update/recent?limit=N — returns last N entries (newest first)
  //   Default limit 5; capped at 50. Used by the drawer's recent-updates list
  //   and the sidebar widget. Cache-Control: no-store so writes show instantly.
  if (url === '/api/career-update/recent' && req.method === 'GET') {
    try {
      const jsonlPath = join(ROOT, 'data/career-updates.jsonl');
      if (!existsSync(jsonlPath)) return json({ ok: true, entries: [] });
      const limitRaw = parseInt(query.limit || '5', 10);
      const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 5));
      const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
      const entries = lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).reverse();
      return json({ ok: true, entries });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── 7. Calibration prompt state (Inventory B6 MVP, 2026-05-18) ──────────────
  //   GET /api/calibration/state
  //     Returns the parsed data/calibration-state.json + the latest prompt
  //     metadata (filename, date, age in days, content for clipboard).
  //   POST /api/calibration/answered
  //     Body: { date?: 'YYYY-MM-DD' } — defaults to today.
  //     Writes data/calibration-state.json { last_prompt_answered: date } so
  //     the dashboard card auto-hides on next rebuild. Does NOT delete the
  //     prompt file itself; that survives for audit.
  if (url === '/api/calibration/state' && req.method === 'GET') {
    try {
      const statePath = join(ROOT, 'data/calibration-state.json');
      let state = {
        last_prompt_generated: null,
        last_prompt_path: null,
        last_prompt_questions: 0,
        last_prompt_answered: null,
        history: [],
      };
      if (existsSync(statePath)) {
        try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf-8')) }; } catch {}
      }
      // Locate the most recent prompt file (defensively — state may be stale)
      let latestFile = null;
      let latestPath = null;
      let latestContent = '';
      let latestDate = null;
      let ageDays = null;
      try {
        const files = readdirSync(join(ROOT, 'data'))
          .filter(f => /^weekly-calibration-prompt-\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .sort((a, b) => b.localeCompare(a));
        if (files.length > 0) {
          latestFile = files[0];
          latestPath = join(ROOT, 'data', latestFile);
          const stat = statSync(latestPath);
          ageDays = Math.round((Date.now() - stat.mtimeMs) / 86400000);
          const m = latestFile.match(/(\d{4}-\d{2}-\d{2})/);
          latestDate = m ? m[1] : null;
          latestContent = readFileSync(latestPath, 'utf-8');
        }
      } catch (_) { /* fall through */ }
      // Extract just the Gemini prompt block for clipboard-friendly copy.
      // Match at start-of-line so we skip the docs reference at the top of
      // the file (which has the markers inside backticks).
      let promptBlock = '';
      if (latestContent) {
        const startMatch = latestContent.match(/^=== GEMINI PROMPT START ===$/m);
        const endMatch = latestContent.match(/^=== GEMINI PROMPT END ===$/m);
        if (startMatch && endMatch && endMatch.index > startMatch.index) {
          promptBlock = latestContent.slice(startMatch.index, endMatch.index + endMatch[0].length);
        }
      }
      const answered = state.last_prompt_answered && latestDate
        ? state.last_prompt_answered >= latestDate
        : false;
      return json({
        ok: true,
        state,
        latest: latestFile ? {
          file:      latestFile,
          path:      'data/' + latestFile,
          date:      latestDate,
          age_days:  ageDays,
          questions: state.last_prompt_questions || 0,
          answered,
          prompt_block: promptBlock,
        } : null,
      });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  if (url === '/api/calibration/answered' && req.method === 'POST') {
    (async () => {
      try {
        const body = await _readBody(req);
        let date = (body && typeof body.date === 'string') ? body.date.trim() : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          date = new Date().toISOString().slice(0, 10);
        }
        const statePath = join(ROOT, 'data/calibration-state.json');
        let state = {
          last_prompt_generated: null,
          last_prompt_path: null,
          last_prompt_questions: 0,
          last_prompt_answered: null,
          history: [],
        };
        if (existsSync(statePath)) {
          try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf-8')) }; } catch {}
          if (!Array.isArray(state.history)) state.history = [];
        }
        state.last_prompt_answered = date;
        // Annotate the matching history entry so audit trail is complete
        const entry = state.history.find(h => h && h.date === state.last_prompt_generated);
        if (entry) entry.answered = date;
        writeFileSync(statePath, JSON.stringify(state, null, 2));
        return json({ ok: true, last_prompt_answered: date });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── /api/detail/* ──────────────────────────────────────────────────────────
  const detailMatch = url.match(/^\/api\/detail\/(.+)$/);
  if (detailMatch) {
    const fn = DETAIL_FNS[detailMatch[1]];
    if (fn) {
      try {
        return json(fn());
      } catch (err) {
        console.error(`[detail/${detailMatch[1]}] error:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }
    res.writeHead(404); res.end('Unknown category');
    return;
  }

  const reportMatch = url.match(/^\/api\/report\/(.+\.md)$/);
  if (reportMatch) {
    const summary = parseReportSummary('reports/' + reportMatch[1]);
    return json(summary);
  }

  // ── /draft/{rowId} — Apply-pack draft preview page ───────────────────────
  // GET /draft/{rowId}
  // Returns a full child-page HTML document for the apply-pack draft review UX:
  //   • Tabbed: CV | Cover Letter | Why Statement | LinkedIn DM | Form Fields
  //   • Floating AI risk badge per artifact (reads humanize-check sidecar JSON)
  //   • Side-by-side diff toggle (uses lib/diff-renderer.mjs)
  //   • Action buttons: Approve / Request revision / Mark applied
  //   • Wires to POST /api/build-pack-stage for revision triggers
  const draftMatch = url.match(/^\/draft\/(\d+)$/);
  if (draftMatch) {
    const rowId  = draftMatch[1];
    const padded = String(rowId).padStart(3, '0');

    // Locate the apply-pack directory for this row (first match: data/apply-packs/ or apply-pack/)
    const PACK_ROOTS = [
      join(ROOT, 'data/apply-packs'),
      join(ROOT, 'apply-pack'),
    ];
    let packDir = null;
    let packDirRel = null;
    for (const root of PACK_ROOTS) {
      if (!existsSync(root)) continue;
      const entries = readdirSync(root);
      const match = entries.find(e => e.startsWith(padded + '-'));
      if (match) { packDir = join(root, match); packDirRel = `${root.replace(ROOT + '/', '')}/${match}`; break; }
    }

    // Find row metadata from applications.md
    const apps = parseApplications();
    const row  = apps.find(r => String(r.num) === String(rowId));
    const company = row?.company || `Row #${rowId}`;
    const role    = row?.role    || '';
    const score   = row?.score   || null;
    const status  = row?.status  || '';

    // R4 fix (2026-05-18): when no apply-pack exists for this row, render a
    // single friendly hero page with a build CTA instead of 5 identical
    // "No CV artifact found" tabs. Mitchell hit this on /draft/840 (Cursor).
    if (!packDir) {
      const slug = (company + '-' + role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      const emptyHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build apply-pack · ${company.replace(/</g,'&lt;')} · career-ops</title><style>
:root{--bg:#f8f9fb;--surface:#fff;--surface-2:#f4f4f6;--border:#e5e7eb;--text:#111827;--text-2:#374151;--text-3:#6b7280;--action:#15803d;--action-hover:#166534;--link:#0969da;--link-hover:#0550ae;--radius-sm:6px;--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--font-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#06070d;--surface:#11131c;--surface-2:#181b27;--border:#232737;--text:#fafafa;--text-2:#e4e4e7;--text-3:#b8b8c0;--action:#238636;--action-hover:#2a7f3f;--link:#58a6ff;--link-hover:#79c0ff}}
*{box-sizing:border-box}body{font-family:var(--font-sans);max-width:680px;margin:64px auto;padding:0 24px;color:var(--text);background:var(--bg);font-size:15px;line-height:1.55}
.crumbs{font-size:12px;color:var(--text-3);font-family:var(--font-mono);margin:0 0 24px}.crumbs a{color:var(--link);text-decoration:none}.crumbs a:hover{color:var(--link-hover);text-decoration:underline}
h1{font-size:24px;font-weight:600;margin:0 0 6px;letter-spacing:-0.011em}.subtitle{font-size:15px;color:var(--text-3);margin:0 0 24px}
.empty-hero{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px 32px;margin:0 0 24px}
.empty-icon{display:inline-flex;width:48px;height:48px;align-items:center;justify-content:center;background:color-mix(in srgb,var(--action) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--action) 30%,var(--border));border-radius:50%;font-size:24px;color:var(--action);margin:0 0 14px}
.empty-hero h2{font-size:18px;font-weight:600;margin:0 0 8px}.empty-hero p{font-size:14px;color:var(--text-2);margin:0 0 14px}
.cta{display:inline-flex;align-items:center;gap:8px;background:var(--action);color:#fff;border:1px solid var(--action);border-radius:var(--radius-sm);padding:9px 18px;font-size:14px;font-weight:600;text-decoration:none;transition:background .12s,border-color .12s}.cta:hover{background:var(--action-hover);border-color:var(--action-hover)}
code,kbd{font-family:var(--font-mono);font-size:13px;background:var(--surface-2);padding:2px 7px;border-radius:4px;border:1px solid var(--border)}
.fact-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:24px 0}.fact{padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)}.fact-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin:0 0 4px}.fact-value{font-size:15px;font-weight:600;color:var(--text)}
.what-builds{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:18px 22px;margin:0 0 24px}.what-builds h3{font-size:13px;font-weight:600;margin:0 0 10px;color:var(--text)}.what-builds ul{margin:0;padding-left:20px;font-size:13px;color:var(--text-2)}.what-builds li{margin:4px 0}
.note{font-size:12px;color:var(--text-3);margin:0 0 24px;padding:12px 14px;background:var(--surface-2);border-left:3px solid var(--action);border-radius:var(--radius-sm)}
</style></head><body>
<p class="crumbs"><a href="/dashboard/">← back to dashboard</a> · row #${rowId}</p>
<h1>${company.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</h1>
<p class="subtitle">${role.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>

<div class="empty-hero">
  <div class="empty-icon">📦</div>
  <h2>No apply-pack exists for this row yet</h2>
  <p>An apply-pack bundles the tailored CV, cover letter, why statement, LinkedIn DM, and pre-filled form-field answers for a single role. Generation runs the 5 sub-agents in <code>scripts/agents/</code> against the row's evaluation report and writes outputs to <code>apply-pack/${padded}-{slug}/</code>.</p>
  <a class="cta" href="javascript:void(0)" onclick="generatePack();return false;">Generate this apply-pack →</a>
  <p style="margin-top:14px;font-size:12px;color:var(--text-3)">Estimated cost: ~$2-5 · wall-clock: 3-5 min · every artifact is reviewed by you before submission.</p>
</div>

<div class="fact-grid">
  <div class="fact"><div class="fact-label">Row</div><div class="fact-value">#${rowId}</div></div>
  <div class="fact"><div class="fact-label">Score</div><div class="fact-value">${score != null ? score.toFixed(1) + ' / 5' : '—'}</div></div>
  <div class="fact"><div class="fact-label">Status</div><div class="fact-value">${status || '—'}</div></div>
  <div class="fact"><div class="fact-label">Expected output</div><div class="fact-value" style="font-family:var(--font-mono);font-size:12px">apply-pack/${padded}-${slug.slice(0,30)}/</div></div>
</div>

<div class="what-builds">
  <h3>What gets generated</h3>
  <ul>
    <li><strong>cv-tailored.md</strong> — CV rewritten against the JD's must-haves</li>
    <li><strong>cover-letter.md</strong> — 200-300 word letter with company-specific hook</li>
    <li><strong>why-statement.md</strong> — short narrative for application "why this role" prompts</li>
    <li><strong>linkedin-dm.md</strong> — 60-90 second outreach DM to the hiring manager</li>
    <li><strong>form-fields.md</strong> — pre-filled answers for application form free-text questions</li>
  </ul>
</div>

<p class="note">Once generation completes, this page will hot-reload into the 5-tab review UI.</p>

<script>
async function generatePack(){
  const btn = document.querySelector('.cta');
  btn.style.opacity='0.6';btn.textContent='Building... (3-5 min)';
  try {
    const res = await fetch('/api/drawer/build-apply-pack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rowNum:${rowId}})});
    const data = await res.json().catch(()=>({}));
    if (res.ok && data.ok) {
      btn.textContent='Build started — reloading in 4 min…';
      setTimeout(()=>location.reload(), 240000);
    } else if (res.status === 409 && data.already_exists) {
      btn.textContent='Pack already exists — reload?';
      btn.onclick = ()=>location.reload();
      btn.style.opacity='1';
    } else {
      btn.textContent='Failed: ' + (data.error || res.status);
      btn.style.background='var(--red-fg,#dc2626)';btn.style.borderColor='var(--red-fg,#dc2626)';
    }
  } catch(e) {
    btn.textContent='Error: ' + e.message;
    btn.style.background='var(--red-fg,#dc2626)';btn.style.borderColor='var(--red-fg,#dc2626)';
  }
}
</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(emptyHtml);
      return;
    }

    // Define artifact tabs
    const ARTIFACT_TABS = [
      { label: 'CV',            files: ['cv-tailored.md', 'cv.md']                 },
      { label: 'Cover Letter',  files: ['cover-letter.md']                         },
      { label: 'Why Statement', files: ['why-statement.md', 'why.md']              },
      { label: 'LinkedIn DM',   files: ['linkedin-dm.md', 'outreach.md']           },
      { label: 'Form Fields',   files: ['form-fields.md', 'form-answers.md']       },
    ];

    function readArtifact(baseName) {
      if (!packDir) return null;
      const p = join(packDir, baseName);
      if (existsSync(p)) return readFileSync(p, 'utf-8');
      return null;
    }

    function readAnyArtifact(fileList) {
      for (const f of fileList) {
        const c = readArtifact(f);
        if (c != null) return { content: c, file: f };
      }
      return null;
    }

    // Read AI detection sidecar JSON. Checks two conventions:
    //   1. {artifact}.md.ai-detection.json  — written by lib/ai-detection-gate.mjs checkArtifact()
    //   2. {artifact}.humanize.json         — legacy name (nothing currently writes this)
    function readHumanizeSidecar(artifactFile) {
      if (!packDir) return null;
      const candidates = [
        join(packDir, artifactFile + '.ai-detection.json'),
        join(packDir, artifactFile.replace(/\.md$/, '.humanize.json')),
      ];
      for (const p of candidates) {
        if (existsSync(p)) {
          try {
            const raw = JSON.parse(readFileSync(p, 'utf-8'));
            // Normalise to { score, consensusScore } shape the badge reader expects
            if (raw.gptzero_prob != null || raw.originality_prob != null) {
              const gz   = raw.gptzero_prob    != null ? raw.gptzero_prob    * 100 : null;
              const orig = raw.originality_prob != null ? raw.originality_prob * 100 : null;
              const both = [gz, orig].filter(v => v != null);
              raw.score = both.length ? Math.round(both.reduce((a, b) => a + b, 0) / both.length) : null;
            }
            return raw;
          } catch { /* try next */ }
        }
      }
      return null;
    }

    // AI risk badge HTML (green / amber / red per staleness-nudge color pattern)
    function aiBadgeHtml(score) {
      if (score == null) return '';
      const pct = Math.round(score);
      let color, label;
      if (pct <= 20)      { color = 'var(--green-fg-dark, #166534)'; label = 'LOW'; }
      else if (pct <= 45) { color = 'var(--amber-fg-dark, #6b5430)'; label = 'MED'; }
      else if (pct <= 70) { color = 'var(--amber-fg,     #a87b48)'; label = 'HIGH'; }
      else                { color = 'var(--red-fg-dark,  #991b1b)'; label = 'CRIT'; }
      return `<span style="
        display:inline-flex;align-items:center;gap:4px;
        font-size:10px;font-weight:700;letter-spacing:.04em;
        color:${color};
        background:var(--surface-2,#f4f4f6);
        border:1px solid currentColor;
        border-radius:4px;padding:2px 7px;
        vertical-align:middle;">AI ${pct}% ${label}</span>`;
    }

    // Build tab content (HTML) for a single artifact
    function buildTabContent(tabLabel, artifactRes) {
      if (!artifactRes) {
        return `<p style="color:var(--text-3);font-style:italic;padding:16px 0;">
          No ${tabLabel} artifact found in <code>${packDirRel || `apply-pack/${padded}-*`}</code>.
          Click the green <strong>Generate apply pack</strong> button above to build materials for this row.
        </p>`;
      }

      const { content, file } = artifactRes;
      const sidecar = readHumanizeSidecar(file);
      const aiScore = sidecar?.score ?? sidecar?.consensusScore ?? null;
      const badgeHtml = aiBadgeHtml(aiScore);

      // Render markdown to HTML for display
      let rendered = '';
      try { rendered = marked.parse(content); } catch { rendered = `<pre>${content.replace(/</g, '&lt;')}</pre>`; }

      // Diff toggle — reads .prev version if it exists (artifact.prev.md)
      const prevFile = file.replace(/\.md$/, '.prev.md');
      const prevContent = readArtifact(prevFile);
      let diffHtml = '';
      if (prevContent != null) {
        const sbsDiff = renderSideBySideDiff(prevContent, content);
        diffHtml = `
          <details style="margin-top:16px;">
            <summary style="cursor:pointer;font-size:12px;color:var(--accent,#5a76a6);font-weight:600;padding:4px 0;">
              Show diff vs. previous version
            </summary>
            <div style="margin-top:8px;">${sbsDiff}</div>
          </details>`;
      }

      return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);">${packDirRel || ''}/${file}</span>
          ${badgeHtml}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px 20px;font-size:13px;line-height:1.6;">
          ${rendered}
        </div>
        ${diffHtml}`;
    }

    // Build all tab panels
    const tabPanels = ARTIFACT_TABS.map(tab => {
      const res = readAnyArtifact(tab.files);
      return {
        id:      tab.label.toLowerCase().replace(/\s+/g, '-'),
        label:   tab.label,
        content: buildTabContent(tab.label, res),
      };
    });

    // Build tab JS + HTML structure
    const tabNavItems = tabPanels.map((t, i) =>
      `<button class="draft-tab${i === 0 ? ' active' : ''}" data-tab="${t.id}" type="button">${t.label}</button>`
    ).join('\n      ');

    const tabPanelDivs = tabPanels.map((t, i) =>
      `<div class="draft-panel${i === 0 ? ' active' : ''}" id="panel-${t.id}">${t.content}</div>`
    ).join('\n      ');

    // Floating score + status badge
    const scoreBadge = score != null
      ? `<span style="font-size:18px;font-weight:700;color:var(--green-fg-dark,#166534)">${score}</span>`
      : '';

    // Action buttons
    const actionBar = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;">
        <button onclick="triggerAction('approve')" style="
          padding:8px 18px;border-radius:6px;border:none;cursor:pointer;
          background:var(--green-bg,#dcfce7);color:var(--green-fg-dark,#166534);
          font-weight:600;font-size:13px;">Approve</button>
        <button onclick="triggerAction('revision')" style="
          padding:8px 18px;border-radius:6px;border:none;cursor:pointer;
          background:var(--amber-bg,#f4ede1);color:var(--amber-fg-dark,#6b5430);
          font-weight:600;font-size:13px;">Request revision</button>
        <button onclick="triggerAction('mark-applied')" style="
          padding:8px 18px;border-radius:6px;border:none;cursor:pointer;
          background:var(--blue-bg,#e8edf4);color:var(--blue-fg-dark,#3d4f6b);
          font-weight:600;font-size:13px;">Mark applied</button>
      </div>`;

    const draftCss = `
      <style>
        .draft-tabs {
          display:flex;gap:2px;border-bottom:2px solid var(--border,#e5e7eb);
          margin-bottom:20px;
        }
        .draft-tab {
          padding:7px 16px;font-size:13px;font-weight:500;
          background:transparent;border:none;border-bottom:2px solid transparent;
          margin-bottom:-2px;cursor:pointer;color:var(--text-3,#6b7280);
          border-radius:4px 4px 0 0;
          transition:color .15s,border-color .15s,background .15s;
        }
        .draft-tab:hover { color:var(--text-2,#374151);background:var(--surface-2,#f4f4f6); }
        .draft-tab.active {
          color:var(--accent,#5a76a6);
          border-bottom-color:var(--accent,#5a76a6);
          font-weight:600;
        }
        .draft-panel { display:none; }
        .draft-panel.active { display:block; }
      </style>
      <script>
        function switchTab(id) {
          document.querySelectorAll('.draft-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
          document.querySelectorAll('.draft-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + id));
        }
        document.addEventListener('DOMContentLoaded', () => {
          document.querySelectorAll('.draft-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
        });
        function triggerAction(action) {
          fetch('/api/build-pack-stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ row_id: '${rowId}', action }),
          }).then(r => r.json()).then(d => {
            if (d.ok) { alert('Action "' + action + '" recorded.'); }
            else { alert('Error: ' + (d.error || 'unknown')); }
          }).catch(e => alert('Network error: ' + e.message));
        }
      </script>`;

    const packStatus = packDir
      ? `<p style="font-size:12px;color:var(--text-3);margin-bottom:4px;">Pack: <code>${packDirRel}</code></p>`
      : `<p style="font-size:12px;color:var(--amber-fg,#a87b48);margin-bottom:4px;">
           No apply-pack found for row ${rowId}. Click <strong>Generate apply pack</strong> on the row drawer to build it.
         </p>`;

    const pageTitle = `Draft — ${company}${role ? ` · ${role}` : ''}`;

    const pageHtml = renderChildPageHTML({
      title: pageTitle,
      breadcrumbs: [
        { label: 'Dashboard', href: '/' },
      ],
      side_nav: tabPanels.map(t => ({ label: t.label, href: `#panel-${t.id}` })),
      sections: [
        {
          heading: 'Overview',
          kind: 'card',
          body: `
            <div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
              ${scoreBadge}
              <span style="font-size:13px;color:var(--text-3)">Score</span>
              <span style="font-size:13px;font-weight:600;color:var(--text-2)">${status}</span>
            </div>
            ${packStatus}
            ${actionBar}
          `,
        },
        {
          heading: 'Materials',
          kind: 'default',
          body: `${draftCss}
            <div class="draft-tabs">
              ${tabNavItems}
            </div>
            ${tabPanelDivs}`,
        },
      ],
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(pageHtml);
    return;
  }

  // ── POST /api/build-pack-stage — revision/approve/mark-applied actions ────
  // Wired to the draft page action buttons. Lightweight stub that records the
  // action and returns ok; full orchestration is handled by the orchestrator.
  if (url === '/api/build-pack-stage' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { row_id, action } = JSON.parse(body || '{}');
        if (!row_id || !action) return json({ ok: false, error: 'row_id and action are required' }, 400);
        const valid = ['approve', 'revision', 'mark-applied'];
        if (!valid.includes(action)) return json({ ok: false, error: `invalid action — must be one of: ${valid.join(', ')}` }, 400);
        // Record to a lightweight log; full orchestration wired in a future wave
        const logDir = join(ROOT, 'data/draft-actions');
        mkdirSync(logDir, { recursive: true });
        const logFile = join(logDir, `${String(row_id).padStart(3, '0')}-actions.jsonl`);
        const entry = JSON.stringify({ ts: new Date().toISOString(), row_id: String(row_id), action }) + '\n';
        appendFileSync(logFile, entry, 'utf-8');
        return json({ ok: true, recorded: { row_id, action } });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    });
    return; // end handled in 'end' event
  }

  // ── α ALPHA 2026-05-19: apply-pack-polish + intel-refresh + rebuild ──────
  // Three new endpoint families wired by ALPHA's overnight haul. All three
  // spawn a long-running child process, log NDJSON progress to /tmp, and
  // expose an SSE stream for the dashboard buttons.

  // In-process job registry for the new spawners. Keys = jobId.
  // Survives only as long as the dashboard-server process.
  if (typeof globalThis.__alphaJobs === 'undefined') globalThis.__alphaJobs = {};
  const alphaJobs = globalThis.__alphaJobs;

  function _alphaSpawn({ kind, args, env = {} }) {
    const jobId = `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const logPath = `/tmp/alpha-${jobId}.log`;
    // Open the log file synchronously so SSE can tail it from the get-go
    // Use existing imported `_spawn` (child_process) + native fs APIs.
    import('fs').then((fs) => {
      const fd = fs.openSync(logPath, 'w');
      const proc = _spawn('node', args, {
        cwd: ROOT,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      proc.on('exit', (code) => {
        const j = alphaJobs[jobId];
        if (j) { j.exit_code = code; j.completed_at = new Date().toISOString(); }
        try { fs.closeSync(fd); } catch (_) {}
      });
      proc.unref();
      alphaJobs[jobId] = { jobId, kind, pid: proc.pid, logPath, args, started_at: new Date().toISOString(), exit_code: null };
    }).catch(err => {
      alphaJobs[jobId] = { jobId, kind, error: String(err.message || err), started_at: new Date().toISOString() };
    });
    return { jobId, logPath };
  }

  function _alphaSSEStream(req, res, logPath) {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let lastSize = 0;
    let closed = false;
    function readAndSend() {
      if (closed) return;
      try {
        if (!existsSync(logPath)) return;
        const st = statSync(logPath);
        if (st.size <= lastSize) return;
        const chunk = readFileSync(logPath, 'utf-8').slice(lastSize);
        lastSize = st.size;
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try { res.write(`event: progress\ndata: ${line}\n\n`); } catch (_) { closed = true; }
        }
      } catch (_) { /* file may not exist yet */ }
    }
    readAndSend();
    const interval = setInterval(readAndSend, 750);
    const onClose = () => { closed = true; clearInterval(interval); try { res.end(); } catch (_) {} };
    req.on('close', onClose);
    req.on('error', onClose);
  }

  // ── POST /api/apply-pack-polish — kick off polish on a row ──
  //   body: { row: 044, artifacts?: ['cv','cover','impact'], targetConfidence?: 0.99, costCap?: 500, noCache?: false }
  //   returns: { ok, jobId, stream_url, log_path }
  if (url === '/api/apply-pack-polish' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
      const row = parsed.row;
      if (!row || !/^\d+$/.test(String(row))) return json({ ok: false, error: 'row (numeric) required' }, 400);

      // 2026-05-27 — Pre-check: refuse polish on packs with no .md sources.
      // Without this, the polish loop produces a misleading REJECTED summary
      // with 5+ skipped artifacts because there's nothing to polish. The fix
      // is to surface the upstream gap (no pack built yet) instead of spending
      // money on a no-op polish run. Bypass via { force: true } if the caller
      // really wants to polish whatever's there. AGENTS.md bug-class:
      // polish-with-no-md-sources-produces-misleading-REJECTED.
      const POLISH_ARTIFACT_FILES = ['cv-tailored.md', 'tailored-cv.md', 'cover-letter.md', 'form-fields.md', 'impact-doc.md', 'references.md', 'referrals.md'];
      const padded = String(row).padStart(3, '0') + '-';
      let resolvedPackDir = null;
      for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
        if (!existsSync(base)) continue;
        try {
          const hit = readdirSync(base).find(n => n.startsWith(padded));
          if (hit) { resolvedPackDir = join(base, hit); break; }
        } catch (_) {}
      }
      if (!resolvedPackDir) {
        return json({
          ok: false,
          error: `No apply-pack found for row ${row}. Click "Build Pack" first to generate the pack scaffolding.`,
          code: 'no-pack',
          row,
        }, 404);
      }
      const presentSources = POLISH_ARTIFACT_FILES.filter(f => existsSync(join(resolvedPackDir, f)));
      if (presentSources.length < 2 && parsed.force !== true) {
        return json({
          ok: false,
          error: `Only ${presentSources.length} of 6 artifacts have .md sources in ${resolvedPackDir.replace(ROOT + '/', '')}. Click "Build Pack" first to generate scaffolding before polishing.`,
          code: 'no-md-sources',
          row,
          pack_dir: resolvedPackDir.replace(ROOT + '/', ''),
          sources_present: presentSources,
          sources_expected: POLISH_ARTIFACT_FILES,
        }, 409);
      }

      const args = [join(ROOT, 'scripts/agents/apply-pack-polish.mjs'), '--row', String(row)];
      if (Array.isArray(parsed.artifacts) && parsed.artifacts.length) {
        args.push('--artifacts', parsed.artifacts.filter(a => /^[a-z]+$/.test(a)).join(','));
      }
      if (Number.isFinite(Number(parsed.targetConfidence))) args.push('--target-confidence', String(Number(parsed.targetConfidence)));
      if (Number.isFinite(Number(parsed.costCap))) args.push('--cost-cap', String(Number(parsed.costCap)));
      if (parsed.noCache === true) args.push('--no-cache');
      // 2026-05-19 — extension: dashboard polish drawer's "Re-polish (force full)"
      // action passes force_full_burn=true to disable the cost-saving early-abandon
      // policy. Also accepts the more explicit no_early_abandon flag.
      if (parsed.force_full_burn === true || parsed.no_early_abandon === true) {
        args.push('--no-early-abandon');
      }
      const { jobId, logPath } = _alphaSpawn({ kind: 'polish', args });
      return json({ ok: true, jobId, log_path: logPath, stream_url: `/api/apply-pack-polish-stream/${jobId}` });
    });
    return;
  }

  // ── GET /api/apply-pack-polish-stream/{jobId} — SSE of NDJSON progress ──
  const polishStreamMatch = url.match(/^\/api\/apply-pack-polish-stream\/([\w-]+)$/);
  if (polishStreamMatch) {
    const jobId = polishStreamMatch[1];
    // Tolerate "job hasn't appeared yet" race — fall back to expected logPath
    const job = alphaJobs[jobId];
    const logPath = job?.logPath || `/tmp/alpha-${jobId}.log`;
    return _alphaSSEStream(req, res, logPath);
  }

  // ── POST /api/apply-pack/jobs/:jobId/cancel — cancel an in-flight alpha-spawned job ──
  // P0.6 (2026-05-20) — per dealbreaker-adjudicated researcher report at
  // data/p06-popout-actions-ux-FINAL-2026-05-20.md. SIGTERM the child; if
  // still alive after 5s, SIGKILL. The popout's "Stopping…" disabled-button
  // state covers the 5s window. Returns the cancel state for the client to
  // surface in the error/abort panel.
  //   body: (none required)
  //   returns: { ok, jobId, signalSent, exitState }
  const polishCancelMatch = url.match(/^\/api\/apply-pack\/jobs\/([\w-]+)\/cancel$/);
  if (polishCancelMatch && req.method === 'POST') {
    const jobId = polishCancelMatch[1];
    const job = alphaJobs[jobId];
    if (!job) return json({ ok: false, error: 'unknown job' }, 404);
    if (job.exitCode != null) return json({ ok: true, jobId, signalSent: null, exitState: 'already-exited', exitCode: job.exitCode });
    const pid = job.pid;
    if (!pid) return json({ ok: false, error: 'job has no pid (race condition; retry in 1s)' }, 409);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      return json({ ok: false, error: 'SIGTERM failed: ' + (e?.message || 'unknown') }, 500);
    }
    // Schedule a SIGKILL fallback after 5s in case the child ignores SIGTERM.
    setTimeout(() => {
      const j = alphaJobs[jobId];
      if (j && j.exitCode == null) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ }
      }
    }, 5000);
    return json({ ok: true, jobId, signalSent: 'SIGTERM', exitState: 'cancel-requested' });
  }

  // ── A4 (2026-05-22) — intel-chips popout data aggregator ──────────────────
  // Single endpoint backs all 3 A4 chip popouts (team health / interview
  // likelihood / HM visibility). Reads from existing data sources, never
  // fires LLM calls — the interview-likelihood JSON is generated out-of-band
  // by scripts/generate-interview-likelihood.mjs.
  if (url.startsWith('/api/intel-chips') && req.method === 'GET') {
    (async () => {
      try {
        // Slug preferred; row fallback.
        let slug = String(query.slug || '').trim();
        let packDir = null;
        if (!slug) {
          const rowParam = String(query.row || '').trim();
          if (rowParam && /^[0-9]{1,4}$/.test(rowParam)) {
            const padded = rowParam.padStart(3, '0') + '-';
            for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
              if (!existsSync(base)) continue;
              try {
                const hit = readdirSync(base).find(n => n.startsWith(padded));
                if (hit) { slug = hit; packDir = join(base, hit); break; }
              } catch {}
            }
          }
        } else {
          if (!/^[A-Za-z0-9_.-]+$/.test(slug)) return json({ ok: false, error: 'invalid slug' }, 400);
          for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
            const d = join(base, slug);
            if (existsSync(d)) { packDir = d; break; }
          }
        }
        if (!slug) return json({ ok: false, error: 'slug or row required' }, 400);

        // Derive company-slug + role-slug from the pack slug (NNN-company-role).
        const slugParts = slug.split('-');
        const numPart = slugParts.shift(); // 048 etc.
        // Company slug is everything up to the first segment that diverges — we
        // can't perfectly reverse the join, so use a coarse 1-2 word prefix
        // heuristic and let the file existence check confirm.
        let companySlug = slugParts[0] || '';
        // Try 2-word company first (e.g., "cursor-anysphere"), fall back to 1-word.
        const companyTry2 = slugParts.slice(0, 2).join('-');
        if (existsSync(join(ROOT, 'data', 'company-toxicity-cache', companyTry2 + '.json'))) {
          companySlug = companyTry2;
        }
        const roleSlug = slug.replace(/^[0-9]+-/, '');  // strip the NNN- prefix

        // ─── team_health ───
        // Three signal sources, in priority order:
        //   1. data/role-enrichment/<num>-<slug>.json (sentiment + benefits)
        //   2. data/company-toxicity-cache/<company>.json (composite + drivers)
        //   3. data/company-health/<slug>.json (Glassdoor scrape if it exists)
        function _readJsonSafe(p) {
          try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null; }
          catch { return null; }
        }
        const enrich = _readJsonSafe(join(ROOT, 'data', 'role-enrichment', slug + '.json'));
        const toxCache = _readJsonSafe(join(ROOT, 'data', 'company-toxicity-cache', companySlug + '.json'));
        const companyHealth = _readJsonSafe(join(ROOT, 'data', 'company-health', roleSlug + '.json'));
        let team_health = { source: 'absent', reason: 'no role-enrichment or toxicity cache' };
        if (enrich?.sentiment || enrich?.benefits || toxCache) {
          team_health = {
            source: enrich ? 'role-enrichment' : 'toxicity-cache',
            company: enrich?.company || toxCache?.company || '',
            blind_score: enrich?.sentiment?.blind_score || null,
            glassdoor_summary: enrich?.sentiment?.glassdoor || enrich?.sentiment?.glassdoor_summary || null,
            toxicity_grade: enrich?.sentiment?.team_toxicity_grade || null,
            composite_score: toxCache?.composite_score || null,
            composite_band: toxCache?.composite_band || null,
            drivers: Array.isArray(toxCache?.drivers) ? toxCache.drivers.slice(0, 6) : [],
            blockers: Array.isArray(toxCache?.blockers) ? toxCache.blockers.slice(0, 4) : [],
            highlights: Array.isArray(enrich?.sentiment?.recent_highlights) ? enrich.sentiment.recent_highlights.slice(0, 3) : [],
            concerns: Array.isArray(enrich?.sentiment?.recent_concerns) ? enrich.sentiment.recent_concerns.slice(0, 3) : [],
            as_of: enrich?._meta?.as_of || toxCache?.as_of || null,
          };
        }
        if (companyHealth?.glassdoor) {
          team_health.source = 'company-health';
          Object.assign(team_health, {
            rating: companyHealth.glassdoor.rating ?? team_health.blind_score,
            ratingCount: companyHealth.glassdoor.ratingCount ?? null,
            recommend: companyHealth.glassdoor.recommend ?? null,
            ceo_approval: companyHealth.glassdoor.ceo_approval ?? null,
            scraped_at: companyHealth.scrapedAt || null,
          });
          if (Array.isArray(companyHealth.glassdoor.recentHighlights)) team_health.highlights = companyHealth.glassdoor.recentHighlights.slice(0, 3);
          if (Array.isArray(companyHealth.glassdoor.recentConcerns)) team_health.concerns = companyHealth.glassdoor.recentConcerns.slice(0, 3);
        }

        // ─── interview_likelihood ───
        const ilJsonRole = _readJsonSafe(join(ROOT, 'data', 'interview-likelihood', slug + '.json'));
        const ilJsonPack = packDir ? _readJsonSafe(join(packDir, 'interview-likelihood.json')) : null;
        const il = ilJsonRole || ilJsonPack;
        let interview_likelihood;
        if (il && typeof il.likelihood_pct === 'number') {
          // Phase 5.2 enhancement: surface the actual method (council-adjudicated
          // v1 from scripts/agents/interview-likelihood.mjs vs the older sonnet-only
          // scripts/generate-interview-likelihood.mjs). Renderer in build-dashboard.mjs
          // treats both as "present" for chip coloring (see _stateCls there).
          const ilSource = (il.method && String(il.method).startsWith('council-adjudicated')) ? 'council-adjudicated' : 'sonnet';
          interview_likelihood = {
            source: ilSource,
            likelihood_pct: il.likelihood_pct,
            confidence: il.confidence || 'medium',
            top_strengths: Array.isArray(il.top_strengths) ? il.top_strengths.slice(0, 3) : [],
            real_gaps: Array.isArray(il.real_gaps) ? il.real_gaps.slice(0, 3) : [],
            opening_talking_point: il.opening_talking_point || '',
            competitive_edge: il.competitive_edge || '',
            // Phase 5.2 enrichments — surface to chip popout when present.
            reason_bullets: Array.isArray(il.reason_bullets) ? il.reason_bullets.slice(0, 5) : [],
            citations: Array.isArray(il.citations) ? il.citations.slice(0, 8) : [],
            models_used: Array.isArray(il.models_used) ? il.models_used : [],
            generated_at: il.generated_at || null,
          };
        } else {
          // PR-03 (2026-05-25): replace CLI hint with auto-enrich CTA metadata.
          // Client renders <button class="cta-generate" data-auto-enrich="interview-likelihood" data-row-id="N">…
          interview_likelihood = {
            source: 'absent',
            reason: 'no scored analysis yet — click Generate to run council research',
            auto_enrich_available: {
              slot: 'interview-likelihood',
              est_cost_usd: 1.20,
              eta_seconds: 120,
              cta_label: 'Generate Interview Likelihood (~$1.20)',
              requires_confirmation: true,
            },
          };
        }

        // ─── hm_visibility ───
        const hmIntel = _readJsonSafe(join(ROOT, 'data', 'hm-intel', roleSlug + '.json'));
        // PR-03 (2026-05-25): replace CLI hint with auto-enrich CTA metadata.
        let hm_visibility = {
          source: 'absent',
          reason: 'no HM intel cached for this role yet',
          auto_enrich_available: {
            slot: 'hm-intel',
            est_cost_usd: 0.50,
            eta_seconds: 300,
            cta_label: 'Generate HM Intel (~$0.50)',
            requires_confirmation: false,
          },
        };
        if (hmIntel?.hiring_managers?.length) {
          const primary = hmIntel.hiring_managers[0];
          const otherHMs = hmIntel.hiring_managers.slice(1, 3).map(h => ({ name: h.name, title: h.title, linkedin_url: h.linkedin_url }));
          // Visibility level: HIGH if 1st-degree, MEDIUM if 2nd, LOW if none.
          // Read connections from data/linkedin-network or hm intel network field; for
          // now default LOW unless we find a signal.
          let connection_level = 'LOW';
          if (primary?.connection_level) connection_level = String(primary.connection_level).toUpperCase();
          else if (hmIntel?.linkedin_network?.first_degree?.length) connection_level = 'HIGH';
          else if (hmIntel?.linkedin_network?.second_degree?.length) connection_level = 'MEDIUM';
          // Derive priorities from team_gap_analysis + role_summary (string fields).
          const priorities = [];
          if (typeof hmIntel.team_gap_analysis === 'string' && hmIntel.team_gap_analysis.length) {
            // Pull first 1-2 sentences as the priority signal.
            const sentences = hmIntel.team_gap_analysis.split(/(?<=[.!?])\s+/).slice(0, 3);
            for (const s of sentences) if (s.length > 10) priorities.push(s.trim());
          }
          // Competitive edges: fit_evidence shape varies. Could be an array
          // of strings/objects OR an object whose values are strings/arrays.
          let fitArr = [];
          if (Array.isArray(hmIntel.fit_evidence)) {
            fitArr = hmIntel.fit_evidence;
          } else if (hmIntel.fit_evidence && typeof hmIntel.fit_evidence === 'object') {
            // Flatten the object's leaf strings.
            for (const v of Object.values(hmIntel.fit_evidence)) {
              if (typeof v === 'string') fitArr.push(v);
              else if (Array.isArray(v)) fitArr.push(...v);
            }
          }
          const competitive_edges = fitArr
            .map(f => typeof f === 'string' ? f : (f?.evidence || f?.claim || f?.point || ''))
            .filter(s => s && s.length > 20)
            .slice(0, 4);
          hm_visibility = {
            source: 'hm-intel',
            hm_name: primary?.name || '',
            hm_title: primary?.title || '',
            linkedin_url: primary?.linkedin_url || '',
            why_owns_req: primary?.why_owns_this_req || '',
            outreach_hook: primary?.outreach_hook || '',
            confidence: primary?.confidence || hmIntel?.confidence || 'MEDIUM',
            connection_level,
            priorities: priorities.slice(0, 3),
            competitive_edges: competitive_edges.filter(Boolean).slice(0, 4),
            other_hms: otherHMs.filter(h => h.name),
            synthesized_at: hmIntel.synthesized_at || hmIntel.retrieved_at || null,
          };
        }

        // ─── hm_chance (Phase 5.3) ───
        // Council-adjudicated "chance HM will see the application" with
        // competitive-edges-first framing (Q-8.53.32). Populated out-of-band by
        // scripts/agents/hm-chance.mjs (3d cache TTL).
        const hcJsonRole = _readJsonSafe(join(ROOT, 'data', 'hm-chance', slug + '.json'));
        const hcJsonPack = packDir ? _readJsonSafe(join(packDir, 'hm-chance.json')) : null;
        const hc = hcJsonRole || hcJsonPack;
        let hm_chance;
        if (hc && typeof hc.visibility_pct === 'number') {
          hm_chance = {
            source: 'council-adjudicated',
            visibility_pct: hc.visibility_pct,
            confidence: hc.confidence || 'medium',
            competitive_edges_first: Array.isArray(hc.competitive_edges_first) ? hc.competitive_edges_first.slice(0, 5) : [],
            visibility_factors: Array.isArray(hc.visibility_factors) ? hc.visibility_factors.slice(0, 6) : [],
            reason_bullets: Array.isArray(hc.reason_bullets) ? hc.reason_bullets.slice(0, 5) : [],
            best_path_to_hm: hc.best_path_to_hm || '',
            candidate_volume_estimate: hc.candidate_volume_estimate || '',
            citations: Array.isArray(hc.citations) ? hc.citations.slice(0, 8) : [],
            models_used: Array.isArray(hc.models_used) ? hc.models_used : [],
            generated_at: hc.generated_at || null,
          };
        } else {
          // PR-03 (2026-05-25): replace CLI hint with auto-enrich CTA metadata.
          hm_chance = {
            source: 'absent',
            reason: 'no HM-chance analysis yet — click Generate to run council research',
            auto_enrich_available: {
              slot: 'hm-chance',
              est_cost_usd: 0.80,
              eta_seconds: 90,
              cta_label: 'Generate HM Chance (~$0.80)',
              requires_confirmation: false,
            },
          };
        }

        // PR-E Phase 2 (2026-05-27) — surface disk-derived refresh status as
        // additive payload so the chip drawer can color-band a "partial" state
        // without requiring a second round-trip to /api/intel-refresh-status.
        // Falls back to null when row lookup fails (e.g. slug-only request
        // without a matching apply-now row) — never blocks the primary payload.
        let refresh_status = null;
        try {
          const rowParam = String(query.row || '').trim();
          if (rowParam && /^[0-9]{1,5}$/.test(rowParam)) {
            refresh_status = _intelGetRefreshStatus(rowParam);
          } else if (slug) {
            const m = String(slug).match(/^(\d+)-/);
            if (m) refresh_status = _intelGetRefreshStatus(m[1]);
          }
        } catch { /* best-effort, never block */ }

        return json({ ok: true, slug, team_health, interview_likelihood, hm_visibility, hm_chance, refresh_status });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── PR-E Phase 2 (2026-05-27) — disk-derived intel-refresh status ─────────
  // GET /api/intel-refresh-status?row=N
  //
  // Disk-derived per-slot completeness for one apply-now row. Returns:
  //   { ok, rowId, status, slots_done[], slots_failed[], slots_missing[],
  //     last_refresh, slot_files }
  // where status ∈ 'never-refreshed' | 'partial' | 'complete' | 'stale'.
  //
  // Disk is the source of truth. state.json contributes only the informational
  // last_refresh ISO + the slots_failed annotations (so we can distinguish
  // "missing & known-failed" from "missing & never-attempted"). Deleting
  // state.json would NOT lose information about what work has been done.
  if (url.startsWith('/api/intel-refresh-status') && req.method === 'GET') {
    try {
      const rowParam = String(query.row || query.rowId || '').trim();
      if (!rowParam || !/^[0-9]{1,5}$/.test(rowParam)) {
        return json({ ok: false, error: 'row query param required (numeric)' }, 400);
      }
      const result = _intelGetRefreshStatus(rowParam);
      return json({ ok: !result.error, rowId: rowParam, ...result });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── Phase 5.2 (2026-05-22) — Interview Likelihood detail endpoint ─────────
  // Serves the FULL council-adjudicated JSON (versus intel-chips which trims).
  // Used by the dedicated modal renderer when Mitchell wants the dealbreaker
  // classification + model_estimates surface alongside the rendered bullets.
  if (url.startsWith('/api/interview-likelihood') && req.method === 'GET') {
    (async () => {
      try {
        let slug = String(query.slug || '').trim();
        if (!slug) {
          const rowParam = String(query.row || '').trim();
          if (rowParam && /^[0-9]{1,4}$/.test(rowParam)) {
            const padded = rowParam.padStart(3, '0') + '-';
            for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
              if (!existsSync(base)) continue;
              try {
                const hit = readdirSync(base).find(n => n.startsWith(padded));
                if (hit) { slug = hit; break; }
              } catch {}
            }
          }
        }
        if (!slug) return json({ ok: false, error: 'slug or row required' }, 400);
        if (!/^[A-Za-z0-9_.-]+$/.test(slug)) return json({ ok: false, error: 'invalid slug' }, 400);
        const p = join(ROOT, 'data', 'interview-likelihood', slug + '.json');
        if (!existsSync(p)) return json({
          ok: false,
          error: 'not-found',
          slug,
          reason: 'no scored analysis yet — click Generate to run council research',
          auto_enrich_available: {
            slot: 'interview-likelihood',
            est_cost_usd: 1.20,
            eta_seconds: 120,
            cta_label: 'Generate Interview Likelihood (~$1.20)',
            requires_confirmation: true,
          },
        }, 404);
        const j = JSON.parse(readFileSync(p, 'utf-8'));
        const ageMs = j.generated_at ? Date.now() - Date.parse(j.generated_at) : null;
        const ageDays = ageMs != null ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;
        return json({ ok: true, slug, age_days: ageDays, stale: ageDays != null && ageDays > 3, data: j });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── Phase 5.3 (2026-05-22) — HM Chance detail endpoint ────────────────────
  if (url.startsWith('/api/hm-chance') && req.method === 'GET') {
    (async () => {
      try {
        let slug = String(query.slug || '').trim();
        if (!slug) {
          const rowParam = String(query.row || '').trim();
          if (rowParam && /^[0-9]{1,4}$/.test(rowParam)) {
            const padded = rowParam.padStart(3, '0') + '-';
            for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
              if (!existsSync(base)) continue;
              try {
                const hit = readdirSync(base).find(n => n.startsWith(padded));
                if (hit) { slug = hit; break; }
              } catch {}
            }
          }
        }
        if (!slug) return json({ ok: false, error: 'slug or row required' }, 400);
        if (!/^[A-Za-z0-9_.-]+$/.test(slug)) return json({ ok: false, error: 'invalid slug' }, 400);
        const p = join(ROOT, 'data', 'hm-chance', slug + '.json');
        if (!existsSync(p)) return json({
          ok: false,
          error: 'not-found',
          slug,
          reason: 'no HM-chance analysis yet — click Generate to run council research',
          auto_enrich_available: {
            slot: 'hm-chance',
            est_cost_usd: 0.80,
            eta_seconds: 90,
            cta_label: 'Generate HM Chance (~$0.80)',
            requires_confirmation: false,
          },
        }, 404);
        const j = JSON.parse(readFileSync(p, 'utf-8'));
        const ageMs = j.generated_at ? Date.now() - Date.parse(j.generated_at) : null;
        const ageDays = ageMs != null ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;
        return json({ ok: true, slug, age_days: ageDays, stale: ageDays != null && ageDays > 3, data: j });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── Phase 5.1 (Closure 4, 2026-05-23) — Team Health detail endpoint ───────
  // Backs the full-modal _openTeamHealthPopout renderer in build-dashboard.mjs.
  // Reads data/team-health/<company-slug>.json (composite produced by Phase 1.5
  // role-enrichment toxicity-derived pipeline OR future Chrome MCP scrape via
  // lib/team-health.mjs synthesizeTeamHealth path). Returns the raw cache file
  // plus an age_days + stale flag against the lib's 3-day TTL.
  if (url.startsWith('/api/team-health') && req.method === 'GET') {
    (async () => {
      try {
        let slug = String(query.slug || '').trim().toLowerCase();
        if (!slug) {
          const company = String(query.company || '').trim();
          if (company) {
            slug = company.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
          }
        }
        if (!slug) return json({ ok: false, error: 'slug or company required' }, 400);
        if (!/^[a-z0-9._-]+$/.test(slug)) return json({ ok: false, error: 'invalid slug' }, 400);
        const p = join(ROOT, 'data', 'team-health', slug + '.json');
        if (!existsSync(p)) return json({
          ok: false,
          error: 'not-found',
          slug,
          reason: 'No team-health synthesis cached yet. Click Generate to run corpus-grounded synthesis (~$0.30, uses existing hm-intel + Mitchell\'s personality + profile corpus — no scrapers).',
          // PR-04 (2026-05-25): synthesis is now live via
          // lib/team-health-synthesis.mjs. Auto-enrich routes through the
          // generic /api/drawer/auto-enrich endpoint (PR-03 dispatcher).
          // No deferred flag — synthesis fires immediately on Generate click.
          auto_enrich_available: {
            slot: 'team-health',
            est_cost_usd: 0.30,
            eta_seconds: 60,
            cta_label: 'Generate Team Health synthesis (~$0.30)',
            requires_confirmation: false,
            synthesis_mode: 'corpus-grounded',
          },
        }, 404);
        const j = JSON.parse(readFileSync(p, 'utf-8'));
        const synthAt = j.synthesized_at || (j._meta && j._meta.source_as_of) || null;
        const ageMs = synthAt ? Date.now() - Date.parse(synthAt) : null;
        const ageDays = ageMs != null ? Math.floor(ageMs / (1000 * 60 * 60 * 24)) : null;
        return json({ ok: true, slug, age_days: ageDays, stale: ageDays != null && ageDays > 3, data: j });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    })();
    return;
  }

  // ── E4 (2026-05-22) — 3 polish modes (lite/smart/heavy) + Drive push ──────
  // Lightweight alternative to /api/apply-pack-polish. The existing endpoint
  // spawns a 4-round critic/author/adjudicator loop (heavy spend); /api/polish
  // runs 1-3 inline passes with mode-gated corpus retrieval and Drive push.
  // Streams NDJSON. Hang-prevention: AbortSignal.timeout on every Anthropic
  // call, NDJSON heartbeat every 30s, all body reads via lib/safe-fetch.mjs.
  if (url === '/api/polish' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
      const POLISH_MODES = {
        lite:  { model: 'claude-haiku-4-5',  passes: 1, topK: 0  },
        smart: { model: 'claude-sonnet-4-6', passes: 2, topK: 10 },
        heavy: { model: 'claude-opus-4-7',   passes: 3, topK: 20 },
      };
      const POLISH_CONSUMER_FILES = [
        'cover-letter.md',
        'form-fields.md',
        'one-pager.md',
        'interview-prep-teaser.md',
        'references.md',
        'referrals.md',
        'impact-doc.md',
      ];
      const slug = String(parsed.slug || '').trim();
      const row  = parsed.row;
      const mode = String(parsed.mode || 'lite').trim();
      if (!POLISH_MODES[mode]) return json({ ok: false, error: 'mode must be lite|smart|heavy' }, 400);
      // Lazy-load dotenv — the launchd-wrapped dashboard-server doesn't source
      // .env at startup. Idempotent + low-cost on repeated calls.
      // override:true is REQUIRED: Mitchell's shell pre-sets ANTHROPIC_API_KEY
      // to empty, so dotenv without override would skip the real .env value.
      // See ~/.claude/projects/.../memory/reference_env_secrets.md.
      try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: join(ROOT, '.env'), override: true });
      } catch {}
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return json({ ok: false, error: 'ANTHROPIC_API_KEY not set' }, 500);

      // Resolve pack dir (slug preferred, row fallback).
      function _findPackDirForSlug(s) {
        const cd = join(ROOT, 'apply-pack', s);
        const pd = join(ROOT, 'data', 'apply-packs', s);
        if (existsSync(cd)) return cd;
        if (existsSync(pd)) return pd;
        return null;
      }
      function _findPackDirForRow(r) {
        const padded = String(r).padStart(3, '0') + '-';
        for (const base of [join(ROOT, 'apply-pack'), join(ROOT, 'data', 'apply-packs')]) {
          if (!existsSync(base)) continue;
          try {
            const hit = readdirSync(base).find(n => n.startsWith(padded));
            if (hit) return join(base, hit);
          } catch {}
        }
        return null;
      }
      let packDir = null;
      if (slug && /^[A-Za-z0-9_.-]+$/.test(slug)) packDir = _findPackDirForSlug(slug);
      if (!packDir && row && /^\d+$/.test(String(row))) packDir = _findPackDirForRow(row);
      if (!packDir) return json({ ok: false, error: 'pack not found for slug or row' }, 404);
      const realSlug = basename(packDir);

      // Read JD text + consumer artifacts.
      function _readJdTextFromPack(d) {
        const candidates = ['jd.txt', 'jd.md', 'JD.md', 'job-description.md', 'README.md'];
        for (const f of candidates) {
          const p = join(d, f);
          if (existsSync(p)) { try { return readFileSync(p, 'utf-8'); } catch {} }
        }
        return '';
      }
      const jdText = _readJdTextFromPack(packDir);
      const artifacts = [];
      for (const name of POLISH_CONSUMER_FILES) {
        const p = join(packDir, name);
        if (existsSync(p)) {
          try { artifacts.push({ name, content: readFileSync(p, 'utf-8') }); } catch {}
        }
      }
      if (artifacts.length === 0) {
        return json({ ok: false, error: 'no consumer artifacts to polish in ' + packDir.replace(ROOT + '/', '') }, 404);
      }

      const cfg = POLISH_MODES[mode];
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      const writeLine = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };
      writeLine({ slug: realSlug, mode, artifactCount: artifacts.length, passes: cfg.passes, model: cfg.model });

      // Mode-gated corpus retrieval (smart/heavy only).
      let corpus = [];
      if (cfg.topK > 0 && jdText) {
        try {
          writeLine({ phase: 'corpus', topK: cfg.topK });
          const { indexQuery } = await import('./lib/corpus-index.mjs');
          corpus = await indexQuery({
            query: jdText.slice(0, 6000),
            topK: cfg.topK,
            filter: { sources: ['cv', 'brain', 'corpus'] },
          });
          writeLine({ phase: 'corpus_done', hits: corpus.length });
        } catch (e) {
          writeLine({ phase: 'corpus_failed', error: e.message });
          corpus = [];
        }
      }

      // Heartbeat: emit every 30s to keep connection alive.
      const heartbeatId = setInterval(() => {
        writeLine({ heartbeat: true, ts: new Date().toISOString() });
      }, 30_000);

      // polishPass: one round of polish across all artifacts.
      async function polishPass({ artifacts: arts, adversarial }) {
        const { fetchJson } = await import('./lib/safe-fetch.mjs');
        const polished = [];
        for (const a of arts) {
          const sysParts = [
            "You are a polish editor for Mitchell Williams's job-application artifacts.",
            "Improve clarity, voice consistency, and ATS alignment WITHOUT changing factual claims.",
            "Preserve markdown structure. Return ONLY the polished artifact text — no preamble, no commentary, no code fences.",
          ];
          if (adversarial) {
            sysParts.push("ADVERSARIAL PASS: Be skeptical. Find weasel words, unsupported claims, and voice drift. Strengthen the text against a hostile reader.");
          } else {
            sysParts.push("Apply Mitchell's direct, evidence-backed voice. Cut hedge words. Tighten run-on sentences.");
          }
          const systemPrompt = sysParts.join('\n');
          const userParts = [
            '# Job description',
            (jdText && jdText.slice(0, 12000)) || '(JD unavailable)',
          ];
          if (corpus && corpus.length) {
            userParts.push('', '# Corpus snippets (most relevant from Mitchell\'s career corpus)');
            for (let i = 0; i < corpus.slice(0, 20).length; i++) {
              const c = corpus[i];
              userParts.push('## Snippet ' + (i + 1) + ' (' + (c.source || 'unknown') + ')', c.text || '');
            }
          }
          userParts.push('', '# Artifact to polish: ' + a.name, a.content);
          const userPrompt = userParts.join('\n');

          const j = await fetchJson('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: AbortSignal.timeout(180_000),
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: cfg.model,
              max_tokens: 4096,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
            }),
          }, { bodyTimeoutMs: 120_000, errPrefix: 'anthropic-polish' });

          const content = (j.content && j.content[0] && j.content[0].text) || a.content;
          polished.push({ name: a.name, content, confidence: 0.9 });
        }
        return polished;
      }

      let polished = artifacts;
      try {
        for (let pass = 0; pass < cfg.passes; pass++) {
          const isAdversarial = mode === 'heavy' && pass === cfg.passes - 1;
          writeLine({ pass: pass + 1, total: cfg.passes, isAdversarial });
          polished = await polishPass({ artifacts: polished, adversarial: isAdversarial });
          writeLine({ pass: pass + 1, status: 'done' });
        }

        // Write polished artifacts to disk under polished/<ISO-ts>/.
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const polishedDir = join(packDir, 'polished', ts);
        mkdirSync(polishedDir, { recursive: true });
        for (const a of polished) {
          writeFileSync(join(polishedDir, a.name), a.content);
        }
        writeLine({ phase: 'write_done', dir: polishedDir.replace(ROOT + '/', '') });

        // Drive push (guarded by driveEnabled()).
        let driveResult = { skipped: 'drive_disabled' };
        try {
          const { pushPolishedArtifacts, driveEnabled } = await import('./lib/drive-sync.mjs');
          if (driveEnabled()) {
            writeLine({ phase: 'drive_push' });
            const files = polished.map(a => ({ path: join(polishedDir, a.name), confidence: a.confidence ?? 0.9 }));
            driveResult = await pushPolishedArtifacts({ slug: realSlug, files, target: 0.92 });
          }
        } catch (e) {
          driveResult = { skipped: 'drive_error', error: e.message };
        }

        const avgConfidence = polished.length
          ? polished.reduce((s, p) => s + (p.confidence || 0), 0) / polished.length
          : 0;
        writeLine({
          done: true,
          confidence: Number(avgConfidence.toFixed(3)),
          polishedDir: polishedDir.replace(ROOT + '/', ''),
          driveResult,
        });
      } catch (e) {
        writeLine({ done: true, error: e.message });
      } finally {
        clearInterval(heartbeatId);
        try { res.end(); } catch {}
      }
    });
    return;
  }

  // ── POST /api/intel-refresh — refresh cached intel slots for a row ──
  //   body: { rowId: 044, slots?: ['hm-intel','toxicity','strategy','positioning','all'] }
  if (url === '/api/intel-refresh' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
      const rowId = parsed.rowId || parsed.row;
      if (!rowId || !/^\d+$/.test(String(rowId))) return json({ ok: false, error: 'rowId (numeric) required' }, 400);
      const args = [join(ROOT, 'scripts/agents/intel-refresh.mjs'), '--row', String(rowId)];
      if (Array.isArray(parsed.slots) && parsed.slots.length) {
        args.push('--slots', parsed.slots.filter(s => /^[a-z-]+$/.test(s)).join(','));
      }
      const { jobId, logPath } = _alphaSpawn({ kind: 'intel', args });
      return json({ ok: true, jobId, log_path: logPath, stream_url: `/api/intel-refresh-stream/${jobId}` });
    });
    return;
  }
  const intelStreamMatch = url.match(/^\/api\/intel-refresh-stream\/([\w-]+)$/);
  if (intelStreamMatch) {
    const jobId = intelStreamMatch[1];
    const job = alphaJobs[jobId];
    const logPath = job?.logPath || `/tmp/alpha-${jobId}.log`;
    return _alphaSSEStream(req, res, logPath);
  }

  // ── POST /api/refresh-deep — refresh-master Phase 3 Deep Research CTA ──
  //   body: { rowId: <num> }
  //   Fires a Layer-3 deep refresh on demand. Confirmation modal upstream
  //   shows projected cost (~$25-$50). Uses full council (council_size=7)
  //   per refresh-master Phase 3 deliverable 6.
  if (url === '/api/refresh-deep' && req.method === 'POST') {
    let body = '';
    let total = 0;
    req.on('data', c => { total += c.length; if (total > 8 * 1024) { req.destroy(); return; } body += c; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json({ ok: false, error: 'invalid JSON body' }, 400); }
      const rowId = parsed.rowId || parsed.row;
      if (!rowId || !/^\d+$/.test(String(rowId))) return json({ ok: false, error: 'rowId (numeric) required' }, 400);
      // Phase 4.2 (2026-05-23): --slots all now hits all 7 slots
      // (hm-intel + toxicity + strategy-ceiling + positioning + liveness + ats-detection + role-enrichment)
      // matching the button label's "liveness + JD scrape + HM research + corpus reindex + rebuild" promise.
      // --force bypasses 3-day TTLs on every cache. --mode flag retained for downstream consumers but
      // intel-refresh's CLI parser ignores unknown flags safely.
      const args = [join(ROOT, 'scripts/agents/intel-refresh.mjs'), '--row', String(rowId), '--slots', 'all', '--force', '--mode', 'deep-council-7'];
      const { jobId, logPath } = _alphaSpawn({ kind: 'refresh-deep', args });
      // 2026-05-25: projected_cost_usd bumped 50 → 105 to reflect companion-agent slots
      // wired into intel-refresh.mjs (PR #216). Breakdown: 7 internal slots ~$50 +
      // hm-chance --max-cost-usd 30 + interview-likelihood --max-cost-usd 25. The
      // modal text shows "$25-$105" instead of "$25-$50" so users aren't surprised.
      return json({ ok: true, jobId, log_path: logPath, stream_url: `/api/refresh-deep-stream/${jobId}`, projected_cost_usd: 105, council_size: 7, slots: 'all' });
    });
    return;
  }
  const refreshDeepStreamMatch = url.match(/^\/api\/refresh-deep-stream\/([\w-]+)$/);
  if (refreshDeepStreamMatch) {
    const jobId = refreshDeepStreamMatch[1];
    const job = alphaJobs[jobId];
    const logPath = job?.logPath || `/tmp/alpha-${jobId}.log`;
    return _alphaSSEStream(req, res, logPath);
  }

  // ── POST /api/rebuild — kick a dashboard rebuild ──
  //   Returns { ok, jobId, stream_url } so the ↻ mini-buttons on baked widgets
  //   can stream progress instead of hanging the click.
  if (url === '/api/rebuild' && req.method === 'POST') {
    const args = [join(ROOT, 'scripts/build-dashboard.mjs')];
    const { jobId, logPath } = _alphaSpawn({ kind: 'rebuild', args });
    return json({ ok: true, jobId, log_path: logPath, stream_url: `/api/rebuild-stream/${jobId}` });
  }
  const rebuildStreamMatch = url.match(/^\/api\/rebuild-stream\/([\w-]+)$/);
  if (rebuildStreamMatch) {
    const jobId = rebuildStreamMatch[1];
    const job = alphaJobs[jobId];
    const logPath = job?.logPath || `/tmp/alpha-${jobId}.log`;
    return _alphaSSEStream(req, res, logPath);
  }

  // ── GET /api/alpha-job/{jobId} — poll one job's exit state (for non-SSE clients) ──
  const alphaJobMatch = url.match(/^\/api\/alpha-job\/([\w-]+)$/);
  if (alphaJobMatch) {
    const jobId = alphaJobMatch[1];
    const job = alphaJobs[jobId];
    if (!job) return json({ ok: false, error: 'unknown job' }, 404);
    return json({ ok: true, job });
  }

  // ── GET /api/alpha-jobs — list all tracked jobs for the Jobs-in-flight panel ──
  //   Query params:
  //     ?include_completed=true  — include all jobs incl. those completed >1h ago
  //   Returns: { ok, jobs: [{ jobId, kind, pid, started_at, completed_at,
  //                           exit_code, logPath, lastLine, elapsed_s }] }
  if (url === '/api/alpha-jobs' && req.method === 'GET') {
    const includeCompleted = query.include_completed === 'true';
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const jobs = Object.values(alphaJobs).filter(j => {
      if (!j.completed_at) return true; // running — always include
      if (includeCompleted) return true;
      return new Date(j.completed_at).getTime() > oneHourAgo;
    }).map(j => {
      let lastLine = null;
      try {
        if (j.logPath && existsSync(j.logPath)) {
          const content = readFileSync(j.logPath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          if (lines.length > 0) {
            const raw = lines[lines.length - 1];
            try { lastLine = JSON.parse(raw); } catch (_) { lastLine = raw; }
          }
        }
      } catch (_) { /* file may be mid-write */ }
      const startMs = j.started_at ? new Date(j.started_at).getTime() : 0;
      const endMs = j.completed_at ? new Date(j.completed_at).getTime() : Date.now();
      const elapsed_s = startMs > 0 ? Math.round((endMs - startMs) / 1000) : null;
      return { ...j, lastLine, elapsed_s };
    }).sort((a, b) => {
      const aRunning = a.exit_code == null && !a.error ? 1 : 0;
      const bRunning = b.exit_code == null && !b.error ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (b.started_at || '').localeCompare(a.started_at || '');
    });
    return json({ ok: true, jobs });
  }

  // ── POST /api/alpha-job/{jobId}/cancel — SIGTERM the job's process ──
  const cancelJobMatch = url.match(/^\/api\/alpha-job\/([\w-]+)\/cancel$/);
  if (cancelJobMatch && req.method === 'POST') {
    const jobId = cancelJobMatch[1];
    const job = alphaJobs[jobId];
    if (!job) return json({ ok: false, signaled: false, reason: 'unknown job' }, 404);
    if (job.completed_at || job.exit_code != null) {
      return json({ ok: true, signaled: false, reason: 'job already completed' });
    }
    if (!job.pid) return json({ ok: false, signaled: false, reason: 'job has no pid' }, 400);
    try {
      process.kill(job.pid, 'SIGTERM');
      job.cancelled_at = new Date().toISOString();
      return json({ ok: true, signaled: true, reason: 'SIGTERM sent to pid ' + job.pid });
    } catch (err) {
      const reason = (err.code === 'ESRCH')
        ? 'process not found (may have already exited)'
        : String(err.message || err);
      return json({ ok: true, signaled: false, reason });
    }
  }

  // Share-token middleware: when ?share=<token> is on the dashboard request,
  // validate before serving the HTML. Expired → 410 Gone. Invalid → 401.
  if (url === '/' && query.share) {
    const result = lookupShareToken(query.share);
    if (result.status === 'expired') {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Share link expired</title><body style="font-family:system-ui;padding:40px;max-width:520px;margin:0 auto"><h1>Share link expired</h1><p>This read-only dashboard share link has expired. Ask Mitchell for a fresh link.</p></body>');
      return;
    }
    if (result.status !== 'valid') {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Invalid share link</title><body style="font-family:system-ui;padding:40px;max-width:520px;margin:0 auto"><h1>Invalid share link</h1><p>This share token is not recognized.</p></body>');
      return;
    }
  }

  // ── Autobiography Phase 2 interview (2026-05-19) ────────────────────────
  // Surfaces today's question, accepts answers, and reports per-tentpole progress.
  // Backed by scripts/agents/interview-curator.mjs (generator) +
  // scripts/agents/interview-scorer.mjs (scorer). Widget at /dashboard/autobiography-interview.html.
  if (url === '/api/interview/today') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const queueFile = join(ROOT, 'data/autobiography-project/interview-transcripts/queue', `${today}.md`);
      if (!existsSync(queueFile)) return json({ date: today, question: null });
      const content = readFileSync(queueFile, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      const fm = {};
      if (fmMatch) {
        for (const line of fmMatch[1].split('\n')) {
          const kv = line.match(/^(\w+):\s*(.+)$/);
          if (kv) {
            let v = kv[2].trim();
            try { v = JSON.parse(v); } catch { /* keep raw */ }
            fm[kv[1]] = v;
          }
        }
      }
      let scored = null;
      if (fm.status === 'complete') {
        const scoredPath = join(ROOT, 'data/autobiography-project/interview-transcripts', `${today}.md`);
        if (existsSync(scoredPath)) {
          const sc = readFileSync(scoredPath, 'utf-8');
          const scFm = sc.match(/^---\n([\s\S]*?)\n---\n/);
          if (scFm) {
            scored = {};
            for (const line of scFm[1].split('\n')) {
              const kv = line.match(/^(\w+):\s*(.+)$/);
              if (kv) {
                let v = kv[2].trim();
                try { v = JSON.parse(v); } catch { /* keep raw */ }
                scored[kv[1]] = v;
              }
            }
          }
        }
      }
      return json({
        date: today,
        question: fm.question || null,
        context: fm.context || '',
        tentpole: fm.tentpole || '',
        axis: fm.axis || '',
        status: fm.status || 'pending',
        notes_for_future_claude: fm.notes_for_future_claude || '',
        scored,
      });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  if (url === '/api/interview/answer' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const answer = String(parsed.answer || '').trim();
        if (!answer) return json({ ok: false, error: 'empty answer' }, 400);
        const today = new Date().toISOString().slice(0, 10);
        const queueFile = join(ROOT, 'data/autobiography-project/interview-transcripts/queue', `${today}.md`);
        if (!existsSync(queueFile)) return json({ ok: false, error: 'no queued question for today' }, 404);
        // Inject answer into queue file
        const content = readFileSync(queueFile, 'utf-8');
        const updated = content.replace(/\*\[Answer goes here[\s\S]*?\]\*/, answer);
        writeFileSync(queueFile, updated);
        // Spawn scorer (uses _spawn imported at top of file)
        const child = _spawn('node', [join(ROOT, 'scripts/agents/interview-scorer.mjs'), '--date', today], {
          cwd: ROOT, env: process.env, detached: true, stdio: 'ignore',
        });
        child.unref();
        return json({ ok: true, message: 'Answer received, scoring in background' });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (url === '/api/interview/skip' && req.method === 'POST') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const queueFile = join(ROOT, 'data/autobiography-project/interview-transcripts/queue', `${today}.md`);
      if (existsSync(queueFile)) {
        const content = readFileSync(queueFile, 'utf-8');
        writeFileSync(queueFile, content.replace(/^status: pending$/m, 'status: skipped'));
      }
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  if (url === '/api/interview/progress') {
    try {
      const dir = join(ROOT, 'data/autobiography-project/interview-transcripts');
      const tentpoles = {};
      for (let i = 0; i < 9; i++) tentpoles[String(i).padStart(2, '0')] = { answered: 0, total: 4 };
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/));
        for (const f of files) {
          const content = readFileSync(join(dir, f), 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
          if (!fmMatch) continue;
          const tpMatch = fmMatch[1].match(/^tentpole:\s*"?(\d+)"?$/m);
          if (tpMatch) {
            const tp = String(tpMatch[1]).padStart(2, '0');
            if (tentpoles[tp]) tentpoles[tp].answered++;
          }
        }
      }
      // Latest session-resume notes
      let sessionResume = '';
      const resumeLog = join(ROOT, 'data/autobiography-project/SESSION-RESUME.md');
      if (existsSync(resumeLog)) {
        const text = readFileSync(resumeLog, 'utf-8');
        const latest = text.match(/## \d{4}-\d{2}-\d{2}\n\n([\s\S]+?)\n\n---/);
        if (latest) sessionResume = latest[1].trim();
      }
      return json({ tentpoles, session_resume: sessionResume });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── Phase D (2026-05-19) — evening-digest health endpoint ─────────────────
  // Surfaces the last evening archive's mtime so the dashboard widget can show
  // "last evening digest sent: <ts>" — exposes the 18:00 PT silent-failure mode.
  if (url === '/api/evening-digest/last-sent') {
    try {
      const archiveDir = join(ROOT, 'data', 'heartbeat-archive');
      let files = [];
      if (existsSync(archiveDir)) {
        files = readdirSync(archiveDir)
          .filter(f => f.startsWith('heartbeat-evening-') && f.endsWith('.html'))
          .sort((a, b) => b.localeCompare(a));
      }
      if (!files.length) {
        return json({ ok: true, present: false, message: 'No evening digest archives yet' });
      }
      const latest = files[0];
      const stat = statSync(join(archiveDir, latest));
      const dateMatch = latest.match(/(\d{4}-\d{2}-\d{2})/);
      return json({
        ok: true,
        present: true,
        filename: latest,
        date: dateMatch ? dateMatch[1] : null,
        mtime_iso: stat.mtime.toISOString(),
        open_url: `/data/heartbeat-archive/${latest}`,
      });
    } catch (err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── A1 (2026-05-21) — drawer lifecycle row state ─────────────────────────
  // Reports per-slug pipeline state: pack_exists / drive_synced / polished /
  // applied. Client renders the 5-button lifecycle row (Create / Sync edits /
  // Pre-apply / Polish / Apply) using these booleans for enabled/done state.
  //
  // The slug accepted is either the apply-pack folder name (e.g.
  // "048-anthropic-engineering-editorial-lead") OR a row num (we resolve to
  // the matching apply-pack dir prefix by reading apply-pack/*).
  if (url === '/api/lifecycle-state') {
    try {
      const slugParam = query.slug || '';
      const numParam = query.num || '';
      let resolvedSlug = slugParam;
      if (!resolvedSlug && numParam) {
        const packsDir = join(ROOT, 'apply-pack');
        if (existsSync(packsDir)) {
          const padded = String(numParam).padStart(3, '0');
          const found = readdirSync(packsDir).find(d => d.startsWith(padded + '-'));
          if (found) resolvedSlug = found;
        }
      }
      if (!resolvedSlug) {
        return json({ ok: false, error: 'slug or num required', states: emptyLifecycleStates() });
      }
      const packDir = join(ROOT, 'apply-pack', resolvedSlug);
      const pack_exists = existsSync(packDir);
      let drive_synced = false;
      try {
        const cachePath = join(ROOT, 'data/drive-folder-cache.json');
        if (existsSync(cachePath)) {
          const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
          drive_synced = !!(cache && cache[resolvedSlug]);
        }
      } catch { /* drive cache absent or malformed — treat as not-synced */ }
      let polished = false;
      if (pack_exists) {
        polished = existsSync(join(packDir, 'polished'));
        if (!polished) {
          const metaPath = join(packDir, '_meta.json');
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
              polished = !!(meta && meta.polished_at);
            } catch { /* meta unreadable — treat as not-polished */ }
          }
        }
      }
      let applied = false;
      try {
        const numFromSlug = (resolvedSlug.match(/^(\d{1,4})-/) || [])[1];
        const numToCheck = numParam || numFromSlug;
        if (numToCheck) {
          const tracker = readFileSync(join(ROOT, 'data/applications.md'), 'utf-8');
          const re = new RegExp('^\\|\\s*' + Number(numToCheck) + '\\s*\\|[^|]*\\|[^|]*\\|[^|]*\\|[^|]*\\|\\s*(Applied|Responded|Interview|Offer)\\b', 'm');
          applied = re.test(tracker);
        }
      } catch { /* applications.md absent in this env — leave applied=false */ }
      return json({
        ok: true,
        slug: resolvedSlug,
        states: { pack_exists, drive_synced, polished, applied },
        drive_enabled: process.env.DRIVE_SYNC_ENABLED === 'true',
      });
    } catch (err) {
      return json({ ok: false, error: err.message, states: emptyLifecycleStates() }, 500);
    }
  }

  // Phase 4.5a (2026-05-22) — Pre-Apply Check.
  // Inspects an apply-pack's artifacts (local disk + Drive when enabled),
  // scores readiness across 7 dimensions, returns a gap list + can_polish
  // hint + an optional Gemini-generated narrative "why" when readiness is
  // below the polish threshold. Cached 30 min keyed by pack mtime.
  // Top-level handler is non-async; the Gemini fetch lives inside an async
  // IIFE so we can await it without making the handler async.
  // Step 7 (2026-05-25): pre-apply daily spend display. Returns today's
  // bucket: { day, total_usd, call_count, warn, threshold }. Used by the
  // dashboard header to surface running spend + amber-warn at $2/day.
  // Spend bucket separate from polish-loop's own cost-confirmation modal.
  if (url === '/api/pre-apply-spend' && req.method === 'GET') {
    (async () => {
      try {
        const tracker = await import('./lib/pre-apply-spend-tracker.mjs');
        const dayOverride = query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : null;
        const result = tracker.getDailySpend(ROOT, dayOverride);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ ok: false, error: String(err && err.message || err) }, 500);
      }
    })();
    return;
  }

  if (url === '/api/pre-apply-check' && req.method === 'GET') {
    (async () => {
    try {
      const slugParam = query.slug || '';
      const numParam = query.num || query.row || '';
      let resolvedSlug = slugParam;
      if (!resolvedSlug && numParam) {
        const packsDir = join(ROOT, 'apply-pack');
        if (existsSync(packsDir)) {
          const padded = String(numParam).padStart(3, '0');
          const found = readdirSync(packsDir).find(d => d.startsWith(padded + '-'));
          if (found) resolvedSlug = found;
        }
      }
      if (!resolvedSlug) {
        return json({ ok: false, error: 'slug or num required' }, 400);
      }
      const packDir = join(ROOT, 'apply-pack', resolvedSlug);
      if (!existsSync(packDir)) {
        return json({
          ok: true,
          slug: resolvedSlug,
          ready: false,
          reason: 'pack_missing',
          readiness_pct: 0,
          gap_list: ['Apply pack has not been generated yet — click Create Apply Pack first.'],
          can_polish: false,
          drive_status: 'pack_missing',
        });
      }
      // Cache key: pack dir mtime + meta mtime
      const packStat = statSync(packDir);
      let cacheKey = String(packStat.mtimeMs);
      const metaPath = join(packDir, '_meta.json');
      if (existsSync(metaPath)) {
        try { cacheKey = cacheKey + ':' + statSync(metaPath).mtimeMs; } catch {}
      }
      const cacheDir = join(ROOT, 'data', 'pre-apply-check-cache');
      const cachePath = join(cacheDir, resolvedSlug + '.json');
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
          if (cached && cached._cache_key === cacheKey && (Date.now() - (cached._cached_at || 0)) < 30 * 60 * 1000) {
            return json({ ...cached, _from_cache: true });
          }
        } catch { /* malformed — recompute */ }
      }
      // Step 4 (2026-05-25): replace the 7-dim file-existence rubric with
      // the orchestrator-based 3-sub-check content evaluation per dealbreaker
      // spec. The orchestrator composes hm-match-check + ats-check +
      // voice-retention-check via Promise.allSettled with HM-required-for-ready
      // hard rule. The endpoint still surfaces dimensions[] + gap_list for
      // backwards compat with the existing modal renderer, mapped from the
      // 3 sub-check results. New fields (overall_status, readiness_score,
      // checks, suggestions) added at top level for new consumers.
      let artifacts = {};
      try {
        const cvCandidate = ['tailored-cv.md', 'cv-tailored.md']
          .map(f => join(packDir, f))
          .find(p => existsSync(p));
        if (cvCandidate) artifacts.cv = readFileSync(cvCandidate, 'utf-8');
        const clPath = join(packDir, 'cover-letter.md');
        if (existsSync(clPath)) artifacts.cover_letter = readFileSync(clPath, 'utf-8');
      } catch { /* artifacts may be partial; orchestrator handles missing */ }

      let jdText = '';
      try {
        const jdPath = join(packDir, 'jd.md');
        if (existsSync(jdPath)) {
          jdText = readFileSync(jdPath, 'utf-8');
        } else {
          const metaPath2 = join(packDir, '_meta.json');
          if (existsSync(metaPath2)) {
            const meta = JSON.parse(readFileSync(metaPath2, 'utf-8'));
            jdText = meta.jd_text || meta.jd || meta.job_description || '';
          }
        }
      } catch { /* jdText empty; orchestrator marks ATS unavailable */ }

      const { composePreApplyCheck } = await import('./lib/pre-apply-orchestrator.mjs');
      const orchestratorResult = await composePreApplyCheck({
        slug: resolvedSlug,
        jdText,
        artifacts,
        opts: { deep: query.deep === 'true' },
      });

      // Step 7 (2026-05-25): record per-call spend estimate into the daily
      // bucket. Pre-apply has its own spend bucket separate from polish-loop.
      // Non-fatal — spend tracking failure should never break the endpoint.
      try {
        const tracker = await import('./lib/pre-apply-spend-tracker.mjs');
        const callCost = tracker.estimatePreApplyCost(orchestratorResult);
        if (callCost > 0) {
          tracker.recordSpend(ROOT, callCost, {
            slug: resolvedSlug,
            deep: query.deep === 'true',
            overall_status: orchestratorResult.overall_status,
          });
        }
      } catch (_) { /* spend tracking is informational only */ }

      const readiness_pct = Math.round(orchestratorResult.readiness_score * 100);
      const checks = orchestratorResult.checks;

      function _dimGap(check) {
        if (check.status === 'unavailable' || check.status === 'error') {
          return check.error || (check.status + ' — re-run prerequisite');
        }
        return null;
      }
      function _hmGap(hm) {
        const base = _dimGap(hm);
        if (base) return base;
        if (Array.isArray(hm.gaps) && hm.gaps.length) return hm.gaps.slice(0, 2).join('; ');
        return null;
      }
      function _atsGap(ats) {
        const base = _dimGap(ats);
        if (base) return base;
        if (Array.isArray(ats.missing_keywords) && ats.missing_keywords.length) {
          return 'Missing: ' + ats.missing_keywords.slice(0, 4).join(', ');
        }
        return null;
      }
      function _voiceGap(voice) {
        const base = _dimGap(voice);
        if (base) return base;
        if (Array.isArray(voice.rule_failures) && voice.rule_failures.length) {
          return voice.rule_failures.slice(0, 2).map(f => (f && (f.rule || f.name)) || String(f)).join('; ');
        }
        return null;
      }

      const dimensions = [
        {
          label: 'HM-persona match',
          score: typeof checks.hm.score === 'number' ? checks.hm.score : 0,
          gap: _hmGap(checks.hm),
        },
        {
          label: 'ATS keyword match',
          score: typeof checks.ats.score === 'number' ? checks.ats.score : 0,
          gap: _atsGap(checks.ats),
        },
        {
          label: 'Voice retention',
          score: typeof checks.voice.score === 'number' ? checks.voice.score : 0,
          gap: _voiceGap(checks.voice),
        },
      ];
      const gap_list = Array.isArray(orchestratorResult.suggestions)
        ? orchestratorResult.suggestions.map(s => s.action)
        : [];
      const driveEnabled = process.env.DRIVE_SYNC_ENABLED === 'true';
      let drive_status = 'disabled';
      if (driveEnabled) {
        try {
          const cachePathDrive = join(ROOT, 'data/drive-folder-cache.json');
          if (existsSync(cachePathDrive)) {
            const cache = JSON.parse(readFileSync(cachePathDrive, 'utf-8'));
            drive_status = (cache && cache[resolvedSlug]) ? 'synced' : 'missing-folder';
          } else {
            drive_status = 'missing-folder';
          }
        } catch { drive_status = 'unknown'; }
      }
      // Step 4 (2026-05-25): can_polish gates the Polish CTA in the modal.
      // Polish makes sense when there's room to improve (not perfect score)
      // AND content has cleared a minimum bar (don't waste polish on garbage).
      const can_polish = readiness_pct >= 30 && readiness_pct < 100;
      // Lazy-load dotenv (the launchd-wrapped dashboard-server doesn't source
      // .env at startup) so GEMINI_API_KEY is available. override:true is REQUIRED
      // — Mitchell's shell pre-sets GEMINI_API_KEY to empty, so dotenv without
      // override skips the real .env value. Same pattern as /api/polish.
      try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: join(ROOT, '.env'), override: true });
      } catch {}
      // Optional Gemini narrative "why" when readiness is in the polish-able band
      let why = null;
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey && readiness_pct >= 20 && readiness_pct < 95) {
        try {
          const prompt = 'You are reviewing a job-application apply-pack readiness check. The pack scored ' + readiness_pct + '%. The gaps are:\n' + gap_list.map(g => '- ' + g).join('\n') + '\n\nIn 1-2 sentences, write a calm, factual "why" explaining what is most-load-bearing to fix next. Direct, no emojis, no preamble. Address Mitchell in second person.';
          const gReq = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
          };
          const gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(geminiKey);
          const gRes = await fetch(gUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(gReq),
            signal: AbortSignal.timeout(15_000),
          });
          if (gRes.ok) {
            const gJson = await gRes.json();
            const text = (gJson.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
            if (text) why = text;
          }
        } catch { /* silent — why is optional */ }
      }
      const result = {
        ok: true,
        slug: resolvedSlug,
        ready: orchestratorResult.overall_status === 'ready',
        readiness_pct,
        gap_list,
        dimensions,
        can_polish,
        drive_status,
        drive_enabled: driveEnabled,
        why,
        // Step 4 typed-contract additions (dealbreaker spec). Existing UI
        // consumers ignore these; new consumers (e.g., the per-sub-check
        // popouts in scripts/build-dashboard.mjs) read them directly.
        overall_status: orchestratorResult.overall_status,
        readiness_score: orchestratorResult.readiness_score,
        checks: orchestratorResult.checks,
        suggestions: orchestratorResult.suggestions,
        _cache_key: cacheKey,
        _cached_at: Date.now(),
      };
      try {
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(result, null, 2));
      } catch { /* cache write failures are not fatal */ }
      return json(result);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
    })();
    return;
  }

  // ── A1 — contextual note for the drawer ──────────────────────────────────
  // Stubbed in Part 1 closure (2026-05-21). The full implementation pipes
  // corpus snippets (lib/corpus-index.mjs indexQuery) through a 150-token
  // /api/context-note?num=<row-num>
  // A1 contextual gap-analysis note — wired 2026-05-22 (Closure 3.01 gap audit).
  // Pulls the row from data/apply-now-queue.json, queries the sqlite-vec
  // corpus index (lib/corpus-index.mjs) for the top-10 chunks most relevant
  // to the role title + company, and asks Sonnet for a 1-2 sentence
  // contextual note grounded in the cited chunks. Cached to
  // data/context-notes/<num>.json with 24h TTL to keep cost flat (~$0.005/call,
  // ~$0.10/day at 19 apply-now rows × hot-reload variance).
  if (url === '/api/context-note') {
    const num = String(query.num || '').trim();
    if (!num) return json({ ok: false, error: 'num required' }, 400);
    (async () => {
    try {
      const cacheDir = join(ROOT, 'data', 'context-notes');
      try { mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
      const cachePath = join(cacheDir, num + '.json');
      const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
          if (cached.cachedAt && (Date.now() - Date.parse(cached.cachedAt)) < CACHE_TTL_MS) {
            return json({ ok: true, note: cached.note, citations: cached.citations || [], cached: true });
          }
        } catch (_) { /* refall through to regen */ }
      }
      // Look up the row by num. apply-now-queue.json wraps rows in .ranked[].
      const queuePath = join(ROOT, 'data', 'apply-now-queue.json');
      if (!existsSync(queuePath)) return json({ ok: false, error: 'apply-now-queue not found' }, 404);
      const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
      const numInt = parseInt(num, 10);
      const rows = Array.isArray(queue) ? queue : (queue.ranked || queue.queue || []);
      const row = rows.find(r => parseInt(r.num, 10) === numInt);
      if (!row) return json({ ok: true, note: '(row not found in apply-now-queue — context unavailable)', citations: [], stub: true });
      // Lazy-load .env so launchd-spawned servers (which don't source shell
      // rc files) still have ANTHROPIC_API_KEY available. override:true is
      // required because Mitchell's shell pre-sets ANTHROPIC_API_KEY to empty
      // — without override the .env value never wins. See memory
      // ~/.claude/projects/.../memory/feedback_env_secrets.md.
      if (!process.env.ANTHROPIC_API_KEY) {
        try {
          const dotenv = await import('dotenv');
          dotenv.config({ path: join(ROOT, '.env'), override: true });
        } catch (_) { /* dotenv optional */ }
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // PR-08 (2026-05-25) — degraded-useful fallback instead of raw error stub.
        // Spec: composeFallbackContextNote() in lib/context-note-fallback.mjs.
        const { composeFallbackContextNote } = await import('./lib/context-note-fallback.mjs');
        const fb = composeFallbackContextNote({ rowNum: numInt, role: row.role, company: row.company });
        return json({ ok: true, note: fb.note, citations: fb.citations, stub: fb.stub, fallback_tier: fb.tier });
      }
      // Query the corpus index for the role + company.
      const queryStr = `${row.role || ''} at ${row.company || ''} — what makes Mitchell distinctively qualified, and what gaps should he address?`;
      let chunks = [];
      try {
        const { indexQuery } = await import('./lib/corpus-index.mjs');
        chunks = await indexQuery({ query: queryStr, topK: 10 });
      } catch (e) {
        // PR-08 (2026-05-25) — degraded-useful fallback.
        const { composeFallbackContextNote } = await import('./lib/context-note-fallback.mjs');
        const fb = composeFallbackContextNote({ rowNum: numInt, role: row.role, company: row.company });
        return json({ ok: true, note: fb.note, citations: fb.citations, stub: fb.stub, fallback_tier: fb.tier });
      }
      if (!chunks || chunks.length === 0) {
        // PR-08 (2026-05-25) — degraded-useful fallback.
        const { composeFallbackContextNote } = await import('./lib/context-note-fallback.mjs');
        const fb = composeFallbackContextNote({ rowNum: numInt, role: row.role, company: row.company });
        return json({ ok: true, note: fb.note, citations: fb.citations, stub: fb.stub, fallback_tier: fb.tier });
      }
      const snippetText = chunks.slice(0, 8).map((c, i) =>
        '## Snippet ' + (i + 1) + ' [source: ' + (c.source || 'unknown') + ']\n' + ((c.text || '').slice(0, 600))
      ).join('\n\n');
      // 09 Part 1 Item A (2026-05-22) — switch to "Screen for / Lead with"
      // format per the user's ask. The note appears above the Next-move CTA
      // cluster and tells Mitchell what to focus on as he applies.
      const systemPrompt = "You are Mitchell's career strategist. Given a target role and the most relevant chunks from his career corpus (cv.md, article-digest.md, project stories), write a contextual note in EXACTLY this two-line format:\n\n  Screen for: <3-5 word phrase that captures what makes Mitchell distinctively qualified for this role>.\n  Lead with: <a specific story or proof point from the corpus to open with>.\n\nGround both lines in the provided corpus chunks. Cite source files inline like [cv.md] or [article-digest.md]. Maximum 240 characters total. No preamble, no extra lines.";
      const userPrompt = `# Role\n${row.company || ''} — ${row.role || ''}\n\n# Corpus chunks (top-${chunks.length})\n${snippetText}`;
      let note = '';
      let citations = [];
      try {
        const { fetchJson } = await import('./lib/safe-fetch.mjs');
        const j = await fetchJson('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        }, { bodyTimeoutMs: 12000, errPrefix: 'context-note' });
        note = (j.content && j.content[0] && j.content[0].text || '').trim();
        const sources = new Set();
        for (const c of chunks.slice(0, 8)) if (c.source) sources.add(c.source);
        citations = Array.from(sources);
      } catch (e) {
        // PR-08 (2026-05-25) — degraded-useful fallback instead of raw error stub.
        const { composeFallbackContextNote } = await import('./lib/context-note-fallback.mjs');
        const fb = composeFallbackContextNote({ rowNum: numInt, role: row.role, company: row.company });
        return json({ ok: true, note: fb.note, citations: fb.citations, stub: fb.stub, fallback_tier: fb.tier });
      }
      const payload = {
        cachedAt: new Date().toISOString(),
        num: numInt,
        company: row.company || '',
        role: row.role || '',
        note,
        citations,
        chunkCount: chunks.length,
      };
      try { writeFileSync(cachePath, JSON.stringify(payload, null, 2)); } catch (_) {}
      return json({ ok: true, note, citations, cached: false });
    } catch (e) {
      return json({ ok: false, error: e.message || 'unknown', note: '(context-note error — see server log)', citations: [] }, 500);
    }
    })();
    return;
  }

  // ── Scanner status + control endpoints (Phase 5E, 2026-05-26 · enable added 2026-05-27) ─
  // GET /api/scanner/status → scanner inventory from data/pipeline-ingress-state.json
  // POST /api/scanner/refresh/:name → launchctl kickstart (immediate trigger)
  // POST /api/scanner/reboot/:name  → launchctl kickstart -k (force-restart)
  // POST /api/scanner/disable/:name → launchctl bootout (remove from schedule)
  // POST /api/scanner/enable/:name  → launchctl enable + bootstrap (restore from disable)

  if (url === '/api/scanner/status' && req.method === 'GET') {
    const fp = join(ROOT, 'data', 'pipeline-ingress-state.json');
    if (!existsSync(fp)) return json({ ok: false, error: 'pipeline-ingress-state.json not generated yet' }, 404);
    try {
      const state = JSON.parse(readFileSync(fp, 'utf8'));
      return json({ ok: true, generated_at: state.generated_at, summary: state.summary, scanners: state.scanners || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  const scannerRefreshM = url.match(/^\/api\/scanner\/refresh\/([^/?]+)$/);
  const scannerRebootM  = url.match(/^\/api\/scanner\/reboot\/([^/?]+)$/);
  const scannerDisableM = url.match(/^\/api\/scanner\/disable\/([^/?]+)$/);
  const scannerEnableM  = url.match(/^\/api\/scanner\/enable\/([^/?]+)$/);

  if ((scannerRefreshM || scannerRebootM || scannerDisableM || scannerEnableM) && req.method === 'POST') {
    const action = scannerRefreshM ? 'refresh'
                 : scannerRebootM  ? 'reboot'
                 : scannerDisableM ? 'disable'
                 : 'enable';
    const scannerName = decodeURIComponent((scannerRefreshM || scannerRebootM || scannerDisableM || scannerEnableM)[1]);

    const fp = join(ROOT, 'data', 'pipeline-ingress-state.json');
    if (!existsSync(fp)) return json({ ok: false, error: 'pipeline-ingress-state.json not found' }, 404);
    const state = JSON.parse(readFileSync(fp, 'utf8'));
    const scanner = (state.scanners || []).find(s => s.name === scannerName);
    if (!scanner) return json({ ok: false, error: `scanner not found: ${scannerName}` }, 404);

    const label = scanner.label;
    if (!label) return json({ ok: false, error: `no launchd label for scanner: ${scannerName}` }, 422);

    const uid = process.getuid ? process.getuid() : 501;
    const domain = `gui/${uid}`;
    const svcPath = `${domain}/${label}`;

    try {
      let cmd, note;
      if (action === 'refresh') {
        // kickstart (no -k) — starts a new instance without stopping a running one
        cmd = `launchctl kickstart ${svcPath}`;
        note = `Triggered scan for ${scannerName}`;
      } else if (action === 'reboot') {
        // kickstart -k — stops + restarts
        cmd = `launchctl kickstart -k ${svcPath}`;
        note = `Rebooted ${scannerName}`;
      } else if (action === 'disable') {
        // disable + bootout — removes from schedule until re-enabled
        cmd = `launchctl disable ${svcPath} && launchctl bootout ${svcPath} 2>/dev/null; true`;
        note = `Disabled ${scannerName}`;
      } else {
        // enable: undo a prior disable by re-enabling the service + bootstrapping
        // the plist back into the schedule. `enable` clears the disabled flag set
        // by `launchctl disable`; `bootstrap` re-registers the agent so it fires
        // on its next CalendarInterval / StartInterval tick.
        const plistPath = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
        if (!existsSync(plistPath)) {
          return json({ ok: false, action, scanner: scannerName, label, error: `plist not found at ${plistPath}` }, 404);
        }
        cmd = `launchctl enable ${svcPath} 2>/dev/null; launchctl bootstrap ${domain} ${plistPath}`;
        note = `Re-enabled ${scannerName}`;
      }
      _execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      return json({ ok: true, action, scanner: scannerName, label, note });
    } catch (e) {
      return json({ ok: false, action, scanner: scannerName, label, error: e.message?.slice(0, 240) || 'launchctl failed' });
    }
  }

  // Static files from dashboard/
  // Normalize: /dashboard/ and /dashboard are aliases for /
  const normalUrl = (url === '/dashboard' || url === '/dashboard/') ? '/' : url;
  // Strip /dashboard prefix so bookmarks to /dashboard/... still resolve
  const strippedUrl = normalUrl.startsWith('/dashboard/') ? normalUrl.slice('/dashboard'.length) : normalUrl;
  let filePath = strippedUrl === '/' ? '/dashboard/index.html' : `/dashboard${strippedUrl}`;
  filePath = join(ROOT, filePath);
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  if (statSync(filePath).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
  // Default cache policy: HTML is rebuilt by build-dashboard.mjs on every change,
  // so the browser must revalidate on every load (no-cache forces ETag round-trip
  // but no full re-download when content unchanged). Without this, every UI fix
  // requires the user to hard-refresh (Cmd-Shift-R) to see new HTML/inline CSS+JS.
  // Static assets (PNG, JSON, manifest) get a 5-min cache so revisits are fast.
  if (ext === '.html' || strippedUrl === '/' || strippedUrl === '/index.html') {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  } else if (url === '/manifest.json') {
    headers['Content-Type'] = 'application/manifest+json';
    headers['Cache-Control'] = 'public, max-age=300';
  } else if (url === '/service-worker.js') {
    headers['Content-Type'] = 'application/javascript';
    headers['Service-Worker-Allowed'] = '/';
    headers['Cache-Control'] = 'no-cache';
  } else {
    // Static assets (PNG, ICO, etc.) — short cache for snappy revisits.
    headers['Cache-Control'] = 'public, max-age=300';
  }
  res.writeHead(200, headers);
  res.end(readFileSync(filePath));
});

server.listen(PORT, () => {
  console.log(`Dashboard → http://localhost:${PORT}`);
});
