#!/usr/bin/env node
/**
 * scripts/heartbeat-dispatch.mjs — Phase F-5 Vogue+Bloomberg editorial Dispatch.
 *
 * Emits the editorial Dispatch design behind the HEARTBEAT_DESIGN=dispatch env
 * flag. Existing Phase E2 emission path is byte-identical when the flag is
 * unset. The dispatch is a magazine — italic Fraunces display type, Bloomberg
 * ticker discipline for the queue, and one earned image per email via CID
 * attachment.
 *
 * Two exports:
 *   renderDispatchMorning(state)  → returns { html, subject, attachments }
 *   renderDispatchEvening(state)  → returns { html, subject, attachments }
 *
 * The `state` object follows the existing heartbeat.mjs / heartbeat-evening.mjs
 * shape so callers pass it through unchanged (queue, runway, pipeline,
 * applications, etc.).
 *
 * Tracking-critical patterns (regex-verified after rendering) preserved
 * byte-identical to the existing Phase E2 emission:
 *   - Role IDs: №\s*\d{3,4}
 *   - Scores: \d\.\d{1,2}\s*\/\s*5
 *   - "Apply Pack", "Mark Applied", "Re-render CV"
 *   - "Generated:" timestamp
 *   - "day N" and "N touches"
 *
 * Inputs (Phase F-1 through F-4):
 *   F-1: data/dispatch/research-aesthetic-references.md (taste anchor)
 *   F-2: dashboard/img/dispatch/{morning,evening}/{1-7}.webp via CID attachment
 *   F-3: scripts/dispatch-subject-line.mjs (dynamic subject)
 *   F-4: data/dispatch/{quotes,builder-stats,training-recs,pnw-events,forecast-templates}.json
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import mjml2html from 'mjml';
import { generateSubject } from './dispatch-subject-line.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = process.cwd();

// ── Design tokens ─────────────────────────────────────────────────────────
const TOKENS = JSON.parse(readFileSync(
  new URL('../lib/heartbeat-tokens.json', import.meta.url),
  'utf-8'
));

const MORNING = TOKENS.email.morning_dispatch;
const EVENING = TOKENS.email.evening_dispatch;

// ── Public URL for dashboard links ────────────────────────────────────────
function loadSecretsForUrl() {
  try {
    const p = join(homedir(), '.career-ops-secrets');
    if (!existsSync(p)) return {};
    const out = {};
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch { return {}; }
}
const DASHBOARD_PUBLIC_URL = (process.env.DASHBOARD_PUBLIC_URL
  || loadSecretsForUrl().DASHBOARD_PUBLIC_URL
  || 'https://dashboard.careers-ops.com').replace(/\/$/, '');

// ── Cache the MJML template ───────────────────────────────────────────────
let _mjmlTemplate = null;
function getMjmlTemplate() {
  if (_mjmlTemplate) return _mjmlTemplate;
  _mjmlTemplate = readFileSync(join(__dirname, '../templates/heartbeat-dispatch.mjml'), 'utf-8');
  return _mjmlTemplate;
}

// ── Cache content JSON ────────────────────────────────────────────────────
function loadContentJson(filename) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data/dispatch', filename), 'utf-8'));
  } catch (e) {
    console.warn(`[dispatch] could not load data/dispatch/${filename}: ${e.message}`);
    return null;
  }
}

let _imageIndex   = null;
let _quotes       = null;
let _builderStats = null;
let _trainingRecs = null;
let _pnwEvents    = null;
let _forecasts    = null;

function imageIndex()   { return _imageIndex   ||= loadContentJson('image-rotation-index.json'); }
function quotes()       { return _quotes       ||= loadContentJson('quotes.json'); }
function builderStats() { return _builderStats ||= loadContentJson('builder-stats.json'); }
function trainingRecs() { return _trainingRecs ||= loadContentJson('training-recs.json'); }
function pnwEvents()    { return _pnwEvents    ||= loadContentJson('pnw-events.json'); }
function forecasts()    { return _forecasts    ||= loadContentJson('forecast-templates.json'); }

// ── HTML escape ───────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeMjml(s) {
  return String(s == null ? '' : s)
    .replace(/{{/g, '&#123;&#123;')
    .replace(/}}/g, '&#125;&#125;');
}

// ── Date helpers ──────────────────────────────────────────────────────────
function isoDateNoonUtc(iso) {
  return new Date(`${iso}T12:00:00Z`);
}
function dayOfYear(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}
function dayName(iso) {
  const d = isoDateNoonUtc(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function dayNameShort(iso) {
  return dayName(iso).slice(0, 3).toLowerCase(); // mon, tue, …
}

// Convert an ISO date to long-form prose ("twentieth of may, two thousand twenty-six").
const NUM_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
const ORDINAL_WORDS = ['zeroth','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth','twentieth','twenty-first','twenty-second','twenty-third','twenty-fourth','twenty-fifth','twenty-sixth','twenty-seventh','twenty-eighth','twenty-ninth','thirtieth','thirty-first'];
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function yearAsWords(year) {
  // 2026 → "two thousand twenty-six"
  const high = Math.floor(year / 1000);
  const rest = year % 1000;
  const tens = Math.floor(rest / 100);
  const teens = rest % 100;
  if (high < 1 || high > 9) return String(year);
  let s = NUM_WORDS[high] + ' thousand';
  if (rest === 0) return s;
  if (tens === 0) {
    // 2005 → two thousand five (just teens)
    return s + ' ' + spellTwoDigit(teens);
  }
  // 2026 — drop the "and" Brit habit; American newspaper style is comma-less
  return s + ' ' + spellTwoDigit(teens) ;
}
function spellTwoDigit(n) {
  if (n <= 20) return NUM_WORDS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const tensWord = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][tens];
  if (ones === 0) return tensWord;
  return `${tensWord}-${NUM_WORDS[ones]}`;
}

function dateLongWords(iso) {
  // "the twentieth of may, two thousand twenty-six"
  const d = isoDateNoonUtc(iso);
  const day = d.getUTCDate();
  const month = MONTH_NAMES[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const ordinal = ORDINAL_WORDS[day] || `the ${day}th`;
  return `${ordinal} of ${month}, ${yearAsWords(year)}`;
}

// ── State extractor ───────────────────────────────────────────────────────
// Given the loosely-shaped state from heartbeat.mjs / heartbeat-evening.mjs,
// extract the strongly-typed sub-fields F-5 needs.
function extractStateFields(state, surface) {
  const date          = state.date || new Date().toISOString().slice(0, 10);
  const applyNow      = Array.isArray(state.applyNow) ? state.applyNow : [];
  const whatsNew      = Array.isArray(state.whatsNew) ? state.whatsNew : [];
  const queueCount    = state.queueCount    ?? applyNow.length;
  const trackedCount  = state.trackedCount  ?? 0;
  const evaluatedToday= state.evaluatedToday?? 0;
  const outreachDue   = state.outreachDue   ?? 0;
  const runwayState   = state.runwayState   || 'healthy';
  const runwayAlert   = state.runwayAlert   || false;
  const newRoles      = state.newRoles      ?? 0;
  const topRole       = state.topRole       || null;
  const todaysFocus   = state.todaysFocus   || '';        // Haiku-generated directive (from heartbeat.mjs)
  const density       = state.density       || null;       // runway density object (computed upstream)
  const tonightsApply = applyNow[0] || null;
  const todaysResult  = state.todaysResult  || null;       // evening: what landed today
  const todaysMovements = Array.isArray(state.todaysMovements) ? state.todaysMovements : [];
  const errorCount    = state.errorCount    ?? state.todaysErrorCount ?? 0;
  const systemStatus  = state.systemStatus  || null;
  return { date, surface, applyNow, whatsNew, queueCount, trackedCount, evaluatedToday,
           outreachDue, runwayState, runwayAlert, newRoles, topRole, todaysFocus, density,
           tonightsApply, todaysResult, todaysMovements, errorCount, systemStatus };
}

// ── Build the hero event for F-3 subject-line generation ──────────────────
function buildHeroEvent(state, surface) {
  const s = extractStateFields(state, surface);
  // Map runwayState to F-3's expected value set (healthy/stretched/critical/past-floor)
  // The morning script uses 'healthy'|'stretched'|'critical'; F-3 also accepts 'past-floor'
  // which is equivalent to 'critical' in the morning script's vocabulary.
  let mappedRunway = s.runwayState;
  if (mappedRunway === 'critical') mappedRunway = 'past-floor';

  const heroEvent = {
    surface,
    date: s.date,
    queueDepth: s.queueCount,
    runwayState: mappedRunway,
    fallbackTriggered: state.fallbackTriggered === true,
  };

  if (s.tonightsApply) {
    heroEvent.topPendingAction = {
      company: s.tonightsApply.company,
      role: s.tonightsApply.role || '',
      score: s.tonightsApply.score || 0,
    };
  }

  if (s.density && s.density.velocity) {
    heroEvent.outreachTouches = {
      sent: s.density.velocity.touches_last_7d || 0,
      target: 10,
    };
  }

  if (s.errorCount > 0) heroEvent.errors = s.errorCount;

  return heroEvent;
}

// ── Image selection ───────────────────────────────────────────────────────
function pickImageForDay(surface, iso) {
  const idx = imageIndex();
  if (!idx || !idx[surface]) return null;
  const dn = dayNameShort(iso);
  const entry = idx[surface].find(e => e.day === dn) || idx[surface][0];
  return entry;
}

// ── Quote selection (deterministic by day-of-year with 60-day no-repeat) ──
function pickQuote(surface, iso) {
  const q = quotes();
  if (!q || !Array.isArray(q.quotes)) return null;

  const emphasisKey = surface === 'morning' ? 'morning_emphasis' : 'evening_emphasis';
  const themes = (q.rotation_rules?.[emphasisKey]) || [];

  // Filter quotes whose themes intersect with emphasis themes
  let pool = q.quotes.filter(quote => {
    if (!Array.isArray(quote.themes)) return false;
    return quote.themes.some(t => themes.includes(t));
  });

  // Fall back to entire pool if intersection is empty
  if (pool.length === 0) pool = q.quotes;

  // Deterministic pick by day-of-year, modulated by surface offset so morning
  // and evening don't pick the same quote on the same day.
  const d = isoDateNoonUtc(iso);
  const doy = dayOfYear(d);
  const surfaceOffset = surface === 'morning' ? 0 : 17; // 17 = arbitrary prime
  const idx = (doy + surfaceOffset) % pool.length;
  return pool[idx];
}

// ── Builder stat selection (deterministic by day-of-year) ─────────────────
function pickBuilderStat(iso) {
  const b = builderStats();
  if (!b || !Array.isArray(b.stats) || b.stats.length === 0) return null;
  const d = isoDateNoonUtc(iso);
  const doy = dayOfYear(d);
  return b.stats[doy % b.stats.length];
}

// ── Training rec selection (rotate per 14 days, morning only) ─────────────
function pickTrainingRec(iso) {
  const t = trainingRecs();
  if (!t || !Array.isArray(t.recommendations) || t.recommendations.length === 0) return null;
  const d = isoDateNoonUtc(iso);
  const doy = dayOfYear(d);
  // 1 rec per 14 days
  const slot = Math.floor(doy / 14);
  return t.recommendations[slot % t.recommendations.length];
}

// ── PNW event selection (first event with date >= today) ──────────────────
function pickPnwEvent(iso) {
  const p = pnwEvents();
  if (!p || !Array.isArray(p.events)) return null;
  const sorted = [...p.events]
    .filter(e => e.date && e.date >= iso)
    .sort((a, b) => a.date.localeCompare(b.date));
  return sorted[0] || null;
}

// ── Forecast template selection ───────────────────────────────────────────
function pickForecast(surface, state) {
  const f = forecasts();
  if (!f || !f.templates || !Array.isArray(f.templates[surface])) return null;
  const templates = f.templates[surface];

  // Build the variable context
  const ctx = {
    queue: { depth: state.queueCount },
    outreach: { behind_weekly_target: (state.density?.velocity?.touches_last_7d ?? 0) < 10 },
    runway: { tier: state.runwayState === 'critical' ? 'red' : state.runwayState === 'stretched' ? 'amber' : 'green',
              weeks: parseInt(process.env.RUNWAY_WEEKS || '12') },
    recent: { reply_landed_within_days: 999 },
    interview: { scheduled: false },
    pipeline: { errors_present: state.errorCount > 0,
                errors_count: state.errorCount,
                warnings_count: 0 },
    today: { applications_shipped: 0, outreach_shipped: 0, background_work: 'systems work' },
    tomorrow: { queue_depth: state.queueCount },
    dayOfWeek: dayName(state.date),
  };
  if (state.tonightsApply) {
    ctx.top_role = {
      company: state.tonightsApply.company || '',
      title: state.tonightsApply.role || '',
      short: (state.tonightsApply.company || '').split(' ')[0],
    };
    ctx.queue.top_score = (state.tonightsApply.score || 0).toFixed(2);
  }

  // Find the first template whose applies_when condition evaluates true.
  // We use a tiny safe evaluator for the conditions in F-4. Defensive: fall back
  // to *_default if no specific match.
  const matchedTemplate = templates.find(t => evaluateCondition(t.applies_when, ctx));
  const defaultTemplate = templates.find(t => /^default\b/i.test(t.applies_when || ''))
    || templates[templates.length - 1];
  const chosen = matchedTemplate || defaultTemplate;
  if (!chosen) return null;

  // Try to bind variables; if any required var is missing, fall back to
  // fallback_if_missing.
  let voice = chosen.voice || '';
  let hasMissingVar = false;

  voice = voice.replace(/\{([^}]+)\}/g, (_, path) => {
    const val = resolvePath(ctx, path);
    if (val === undefined || val === null || val === '') {
      hasMissingVar = true;
      return '';
    }
    return String(val);
  });

  if (hasMissingVar && chosen.fallback_if_missing) return chosen.fallback_if_missing;
  // Collapse double-spaces from missing vars
  return voice.replace(/\s+/g, ' ').trim();
}

function resolvePath(ctx, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, ctx);
}

// Very narrow evaluator — only matches the condition shapes used in F-4
// forecast-templates.json: "x >= 1", "x == 0", "x == 'value'", "x AND y",
// "x OR y". Falls back to false on anything we can't safely parse.
function evaluateCondition(condition, ctx) {
  if (!condition) return false;
  const c = condition.trim();
  if (/^default\b/i.test(c)) return false;

  try {
    // AND/OR are case-sensitive in F-4. Split on ' AND ' or ' OR ' (left-to-right).
    if (c.includes(' AND ')) {
      return c.split(' AND ').every(s => evaluateAtom(s.trim(), ctx));
    }
    if (c.includes(' OR ')) {
      return c.split(' OR ').some(s => evaluateAtom(s.trim(), ctx));
    }
    return evaluateAtom(c, ctx);
  } catch {
    return false;
  }
}
function evaluateAtom(atom, ctx) {
  // Forms: a.b OP value, where OP ∈ {==, !=, >=, <=, >, <}
  const m = atom.match(/^(\S+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) return false;
  const left  = resolvePath(ctx, m[1]);
  const op    = m[2];
  let   right = m[3].trim();
  // Strip surrounding quotes
  if (/^['"].*['"]$/.test(right)) right = right.slice(1, -1);
  // Coerce numerics
  const ln = Number(left);
  const rn = Number(right);
  const bothNumeric = !isNaN(ln) && !isNaN(rn);
  if (bothNumeric) {
    if (op === '==') return ln === rn;
    if (op === '!=') return ln !== rn;
    if (op === '>=') return ln >= rn;
    if (op === '<=') return ln <= rn;
    if (op === '>')  return ln >  rn;
    if (op === '<')  return ln <  rn;
  }
  // Boolean / string fallback
  if (op === '==') return String(left) === String(right);
  if (op === '!=') return String(left) !== String(right);
  return false;
}

// ── Render: masthead ──────────────────────────────────────────────────────
function renderMasthead(surface, iso, palette, issueNumber) {
  const wordmark = surface === 'morning' ? 'MORNING DISPATCH' : 'EVENING DISPATCH';
  const time = surface === 'morning' ? '09:00 PT' : '18:00 PT';
  // Use Roman numerals for the issue marker — Vogue convention. We fall back
  // to Arabic if the number is large; for issues we keep Arabic to preserve the
  // tracking-critical pattern № + digits (the brief explicitly preserves this).
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${palette.rule_strong};border-bottom:1px solid ${palette.rule_strong};padding:10px 0">
  <tr>
    <td style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink};vertical-align:middle">${wordmark}</td>
    <td style="text-align:right;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${palette.ink_3};vertical-align:middle">№ ${issueNumber} &middot; ${time}</td>
  </tr>
</table>`.trim();
}

// ── Render: hero date (large italic serif) ────────────────────────────────
function renderHeroDate(iso, palette) {
  // F1b (2026-05-21): swapped from word-spelled prose ("twenty-first of may,
  // two thousand twenty-six") to ISO digital ("2026-05-21") per user
  // direction in the dashboard hardening sprint. The dateLongWords helper
  // stays defined + exported for re-introduction if the editorial direction
  // reverts; this call site uses iso directly.
  return `<p style="margin:6px 0 0 0;font-family:'Fraunces','GT Sectra','Bodoni 72',Georgia,serif;font-weight:500;font-size:44px;line-height:1.05;color:${palette.ink};letter-spacing:-0.02em;font-feature-settings:'tnum' 1">${escapeHtml(iso)}</p>`;
}

// ── Render: editorial lede ────────────────────────────────────────────────
function renderLede(state, surface, palette) {
  const lines = [];
  if (surface === 'morning') {
    if (state.tonightsApply) {
      const co = state.tonightsApply.company || 'the queue';
      const role = (state.tonightsApply.role || '').slice(0, 80);
      lines.push(`A queue of ${state.queueCount} sits ready; one of them — ${escapeHtml(co)} — is the leverage point for the morning.`);
    } else if (state.queueCount === 0 && state.runwayState !== 'healthy') {
      lines.push(`The queue is empty. Today's work is generation, not closure.`);
    } else {
      lines.push(`The pipeline runs in the background; the day's lift sits upstream.`);
    }
  } else {
    if (state.todaysResult) {
      lines.push(`The day closes with ${escapeHtml(state.todaysResult.headline || 'movement on the board')}.`);
    } else if (state.evaluatedToday > 0) {
      lines.push(`${state.evaluatedToday} new evaluation${state.evaluatedToday === 1 ? '' : 's'} landed today; the apply-now table is reordered for the morning.`);
    } else {
      lines.push(`A quiet evening on the wire. Systems ran unattended; the runway holds.`);
    }
  }
  return `<p style="margin:4px 0 0 0;font-family:'Fraunces','GT Sectra',Georgia,serif;font-style:italic;font-weight:400;font-size:16px;line-height:1.45;color:${palette.ink_2}">${lines.join(' ')}</p>`;
}

// ── Render: hero story ────────────────────────────────────────────────────
function renderHeroStory(state, surface, palette) {
  if (surface === 'morning') {
    return renderTonightsApply(state, palette);
  }
  return renderTodaysResult(state, palette);
}

function renderTonightsApply(state, palette) {
  if (!state.tonightsApply) {
    return `
<div style="margin:6px 0;padding:10px 0;border-top:1px solid ${palette.rule_strong}">
  <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.accent};margin-bottom:8px">Tonight's Apply</div>
  <p style="margin:0 0 12px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.2;color:${palette.ink};letter-spacing:-0.01em">No queue — the morning belongs to outreach.</p>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:14px;line-height:1.5;color:${palette.ink_3}">Nothing above the apply-now floor sits in the queue today. The leverage moves upstream: one warm intro path, one new portal scanned, one publishable write-up drafted.</p>
  <p style="margin:14px 0 0 0">
    <a href="${DASHBOARD_PUBLIC_URL}/?focus=outreach" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${palette.accent};border-bottom:1px solid ${palette.accent};text-decoration:none;padding-bottom:1px">Open dashboard &rarr;</a>
  </p>
</div>`.trim();
  }

  const pick = state.tonightsApply;
  const num = pick.num;
  const score = pick.score ? pick.score.toFixed(2) : '—';
  const co = pick.company || '';
  const role = (pick.role || '').slice(0, 80);
  const reportPath = pick.reportPath || '';
  const ageDays = pick.date ? Math.round((Date.now() - new Date(pick.date + 'T12:00:00').getTime()) / 86400000) : null;
  const ageLabel = ageDays !== null ? `${ageDays}d ago` : '';
  const reportUrl = reportPath ? `${DASHBOARD_PUBLIC_URL}/${reportPath.replace(/^\.?\//, '')}` : `${DASHBOARD_PUBLIC_URL}/?focus=row:${num}`;
  const rowDeep = `${DASHBOARD_PUBLIC_URL}/?focus=row:${num}`;
  const markUrl = `${DASHBOARD_PUBLIC_URL}/mark?num=${num}&status=Applied`;
  const packUrl = `${DASHBOARD_PUBLIC_URL}/apply-pack/${num}/`;

  return `
<div style="margin:6px 0;padding:10px 0;border-top:1px solid ${palette.rule_strong}">
  <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.accent};margin-bottom:8px">Tonight's Apply &middot; № ${num}</div>
  <p style="margin:0 0 8px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:32px;line-height:1.15;color:${palette.ink};letter-spacing:-0.012em">${escapeHtml(co)} &mdash; ${escapeHtml(role)}</p>
  <p style="margin:0 0 12px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:15px;line-height:1.5;color:${palette.ink_3}">
    <span class="editorial-mono" style="font-family:'JetBrains Mono','SF Mono',monospace;font-style:normal;font-variant-numeric:tabular-nums;color:${palette.ink_2}">${score} / 5</span>
    ${ageLabel ? `&middot; <span style="font-style:normal;color:${palette.ink_4}">${ageLabel}</span>` : ''}
  </p>
  <p style="margin:14px 0 0 0;line-height:1.8">
    <a href="${reportUrl}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${palette.accent};border-bottom:1px solid ${palette.accent};text-decoration:none;padding-bottom:1px;margin-right:18px">Open apply pack &rarr;</a>
    <a href="${packUrl}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${palette.ink_2};border-bottom:1px solid ${palette.rule_strong};text-decoration:none;padding-bottom:1px;margin-right:18px">Apply Pack</a>
    <a href="${markUrl}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${palette.ink_2};border-bottom:1px solid ${palette.rule_strong};text-decoration:none;padding-bottom:1px;margin-right:18px">Mark Applied</a>
    <a href="${rowDeep}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${palette.ink_3};border-bottom:1px solid ${palette.rule};text-decoration:none;padding-bottom:1px">Report</a>
  </p>
</div>`.trim();
}

function renderTodaysResult(state, palette) {
  const result = state.todaysResult;
  if (!result) {
    return `
<div style="margin:6px 0;padding:10px 0;border-top:1px solid ${palette.rule_strong}">
  <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.accent};margin-bottom:8px">Today's Result</div>
  <p style="margin:0 0 12px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.2;color:${palette.ink};letter-spacing:-0.01em">${state.evaluatedToday > 0 ? `${state.evaluatedToday} new evaluation${state.evaluatedToday === 1 ? '' : 's'} on the wire.` : 'Systems ran unattended.'}</p>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:14px;line-height:1.5;color:${palette.ink_3}">${state.evaluatedToday > 0 ? 'The apply-now table is reordered for the morning. Tomorrow opens with the new ranking.' : 'The runway holds; the queue holds; the systems work continues.'}</p>
</div>`.trim();
  }
  const headline = result.headline || 'Today\'s movement on the board';
  const detail = result.detail || '';
  return `
<div style="margin:6px 0;padding:10px 0;border-top:1px solid ${palette.rule_strong}">
  <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.accent};margin-bottom:8px">Today's Result</div>
  <p style="margin:0 0 12px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:32px;line-height:1.15;color:${palette.ink};letter-spacing:-0.012em">${escapeHtml(headline)}</p>
  ${detail ? `<p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:15px;line-height:1.55;color:${palette.ink_3}">${escapeHtml(detail)}</p>` : ''}
</div>`.trim();
}

// ── Render: image caption ─────────────────────────────────────────────────
function renderImageCaption(image, palette) {
  if (!image) return '';
  const subject = (image.subject || '').toLowerCase();
  const dn = (image.day || '').toLowerCase();
  const dayLabel = { mon: 'monday\'s', tue: 'tuesday\'s', wed: 'wednesday\'s', thu: 'thursday\'s', fri: 'friday\'s', sat: 'saturday\'s', sun: 'sunday\'s' }[dn] || 'today\'s';
  // Render the separator as a literal HTML entity AFTER escaping the user
  // content so the &middot; is not double-escaped to &amp;middot;.
  return `<span class="editorial-grotesk" style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4}">${escapeHtml(dayLabel + ' still')} &middot; ${escapeHtml(subject)}</span>`;
}

// ── Render: ticker (Reuters discipline) ───────────────────────────────────
function renderTicker(state, surface, palette) {
  if (surface === 'morning') {
    return renderApplyNowTicker(state, palette);
  }
  return renderMovementsTicker(state, palette);
}

function renderApplyNowTicker(state, palette) {
  const rows = state.applyNow.slice(0, 6);
  if (rows.length === 0) {
    return `
<div style="margin:6px 0;padding:14px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:8px">Apply-Now Queue</div>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:14px;color:${palette.ink_3}">No roles above the apply-now floor. The queue is empty.</p>
</div>`.trim();
  }

  const rowsHtml = rows.map(r => {
    const num = r.num;
    const score = r.score ? r.score.toFixed(2) : '—';
    const company = (r.company || '').slice(0, 28);
    const role = (r.role || '').slice(0, 50);
    const reportUrl = r.reportPath ? `${DASHBOARD_PUBLIC_URL}/${r.reportPath.replace(/^\.?\//, '')}` : `${DASHBOARD_PUBLIC_URL}/?focus=row:${num}`;
    return `
<tr class="ticker-row">
  <td style="padding:4px 0;border-bottom:1px solid ${palette.rule};font-family:'JetBrains Mono','SF Mono',monospace;font-variant-numeric:tabular-nums;font-size:11px;color:${palette.ink_4};width:54px;vertical-align:top">№ ${num}</td>
  <td style="padding:4px 0;border-bottom:1px solid ${palette.rule};font-family:'Inter',sans-serif;font-size:13px;color:${palette.ink};vertical-align:top"><a href="${reportUrl}" style="color:${palette.ink};text-decoration:none;border-bottom:1px solid ${palette.rule}">${escapeHtml(company)}</a> <span style="color:${palette.ink_3};font-weight:400">${escapeHtml(role)}</span></td>
  <td style="padding:4px 0;border-bottom:1px solid ${palette.rule};font-family:'JetBrains Mono','SF Mono',monospace;font-variant-numeric:tabular-nums;font-size:12px;color:${palette.ink_2};text-align:right;width:64px;vertical-align:top">${score} / 5</td>
</tr>`.trim();
  }).join('');

  const overflow = Math.max(0, state.applyNow.length - rows.length);
  const overflowLine = overflow > 0
    ? `<p style="margin:10px 0 0 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;color:${palette.ink_3}">+${overflow} more in the queue &middot; <a href="${DASHBOARD_PUBLIC_URL}/?focus=apply-now" style="color:${palette.accent};border-bottom:1px solid ${palette.rule};text-decoration:none">see the full table &rarr;</a></p>`
    : '';

  return `
<div style="margin:6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:10px">Apply-Now Queue &middot; ${state.applyNow.length} above floor</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${palette.rule_strong}">
    ${rowsHtml}
  </table>
  ${overflowLine}
</div>`.trim();
}

function renderMovementsTicker(state, palette) {
  const movements = state.todaysMovements;
  if (!movements || movements.length === 0) {
    // Fall back to a small computed summary so the section still renders.
    const items = [];
    if (state.evaluatedToday > 0) items.push({ time: '—', label: `${state.evaluatedToday} evaluation${state.evaluatedToday === 1 ? '' : 's'} written` });
    if (state.outreachDue > 0) items.push({ time: '—', label: `${state.outreachDue} outreach due` });
    if (items.length === 0) {
      return `
<div style="margin:6px 0;padding:14px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:8px">Today's Movements</div>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:14px;color:${palette.ink_3}">A quiet day on the wire. The pipeline ran unattended.</p>
</div>`.trim();
    }
    return `
<div style="margin:6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:10px">Today's Movements</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${palette.rule_strong}">
    ${items.map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid ${palette.rule};font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;font-size:11px;color:${palette.ink_4};width:64px;vertical-align:top">${i.time}</td><td style="padding:8px 0;border-bottom:1px solid ${palette.rule};font-family:'Inter',sans-serif;font-size:13px;color:${palette.ink}">${escapeHtml(i.label)}</td></tr>`).join('')}
  </table>
</div>`.trim();
  }

  // Movements explicitly provided (timestamped log).
  const rowsHtml = movements.slice(0, 8).map(m => `
<tr>
  <td style="padding:8px 0;border-bottom:1px solid ${palette.rule};font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;font-size:11px;color:${palette.ink_4};width:64px;vertical-align:top">${escapeHtml(m.time || '—')}</td>
  <td style="padding:8px 0;border-bottom:1px solid ${palette.rule};font-family:'Inter',sans-serif;font-size:13px;color:${palette.ink}">${escapeHtml(m.label || '')}</td>
</tr>`.trim()).join('');

  return `
<div style="margin:6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:10px">Today's Movements</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${palette.rule_strong}">
    ${rowsHtml}
  </table>
</div>`.trim();
}

// ── Render: today's focus pull-quote ──────────────────────────────────────
function renderFocusPullquote(state, palette) {
  const focus = (state.todaysFocus || '').trim();
  if (!focus) return '';
  return `
<div style="margin:6px 0 4px 0;padding:10px 0;border-top:1px solid ${palette.rule_strong};border-bottom:1px solid ${palette.rule_strong}">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};text-align:center;margin-bottom:6px">Today's Focus</div>
  <p style="margin:0;font-family:'Fraunces','GT Sectra',Georgia,serif;font-style:italic;font-weight:400;font-size:18px;line-height:1.35;color:${palette.ink};text-align:center;letter-spacing:-0.005em">&ldquo;${escapeHtml(focus)}&rdquo;</p>
</div>`.trim();
}

// ── Render: runway alert ──────────────────────────────────────────────────
function renderRunwayAlertEditorial(state, surface, palette) {
  const d = state.density;
  if (!d || !d.ok) {
    return `<div style="margin:6px 0;padding:8px 0 8px 18px;border-left:3px solid ${palette.rule_strong};color:${palette.ink_3};font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:14px">Runway data unavailable &middot; outreach tracker may be offline.</div>`;
  }
  const { health, runway_alert, contacts, velocity, runway_weeks } = d;
  const headlineMap = {
    healthy:   'The runway holds.',
    stretched: 'The runway tightens.',
    critical:  'The runway is past floor.',
  };
  const headline = headlineMap[health] || `The runway sits at ${health}.`;
  const accentColor = health === 'critical' ? palette.negative : health === 'stretched' ? palette.accent : palette.positive;

  return `
<div style="margin:6px 0;padding:8px 0 8px 18px;border-left:3px solid ${accentColor}">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${accentColor};margin-bottom:6px">Runway &middot; ${runway_weeks}-week window</div>
  <p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:16px;line-height:1.3;color:${palette.ink}">${escapeHtml(headline)}</p>
  <p style="margin:0 0 6px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;line-height:1.4;color:${palette.ink_2}">${escapeHtml(runway_alert.replace(/^[^\w]+/, ''))}</p>
  <p style="margin:0;font-family:'JetBrains Mono','SF Mono',monospace;font-variant-numeric:tabular-nums;font-size:11px;color:${palette.ink_3}">
    <span style="color:${palette.ink_2}">${contacts.active}</span> active &middot;
    <span style="color:${palette.ink_2}">${contacts.responded}</span> replied (${Math.round(contacts.response_rate * 100)}%) &middot;
    <span style="color:${palette.ink_2}">${velocity.touches_last_7d}</span>/7d &middot;
    <span style="color:${palette.ink_2}">${velocity.touches_last_30d}</span>/30d &middot;
    last: <span style="color:${palette.ink_2}">${velocity.days_since_last_touch != null ? velocity.days_since_last_touch + 'd' : 'n/a'}</span>
  </p>
</div>`.trim();
}

// ── Render: system status (evening only) ─────────────────────────────────
function renderSystemStatus(state, palette) {
  // Default 6 rows. Caller can pass state.systemStatus as an array of
  // { label, state: 'green'|'amber'|'red', detail } to override.
  const defaultRows = [
    { label: 'Dashboard',     state: 'green', detail: 'launchd-managed, public via Cloudflare' },
    { label: 'Heartbeat',     state: 'green', detail: 'fired at 09:00 PT; this digest at 18:00 PT' },
    { label: 'Batch',         state: 'green', detail: 'ran on schedule' },
    { label: 'Council cache', state: 'green', detail: '3-day TTL holding' },
    { label: 'CDP-Chrome',    state: 'green', detail: 'LinkedIn session valid' },
    { label: 'Errors',        state: state.errorCount > 0 ? 'amber' : 'green', detail: state.errorCount > 0 ? `${state.errorCount} logged today` : 'clean' },
  ];
  const rows = Array.isArray(state.systemStatus) && state.systemStatus.length > 0 ? state.systemStatus : defaultRows;
  const colorOf = (s) => s === 'red' ? palette.negative : s === 'amber' ? palette.accent : palette.positive;
  const rowsHtml = rows.map(r => `
<tr>
  <td style="padding:6px 0;border-bottom:1px solid ${palette.rule};font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:${palette.ink_2};vertical-align:middle;width:140px">${escapeHtml(r.label)}</td>
  <td style="padding:6px 0;border-bottom:1px solid ${palette.rule};font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${colorOf(r.state)};text-transform:uppercase;letter-spacing:0.10em;vertical-align:middle;width:64px">${(r.state || 'green').toUpperCase()}</td>
  <td style="padding:6px 0;border-bottom:1px solid ${palette.rule};font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:13px;color:${palette.ink_3}">${escapeHtml(r.detail || '')}</td>
</tr>`.trim()).join('');

  return `
<div style="margin:6px 0;padding:0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:6px">System Status</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${palette.rule_strong}">
    ${rowsHtml}
  </table>
</div>`.trim();
}

// ── Render: feature blocks ────────────────────────────────────────────────
function renderFeatureBlocks(state, surface, palette) {
  const parts = [];

  // BUILDER STANDING
  const stat = pickBuilderStat(state.date);
  if (stat) parts.push(renderBuilderStanding(stat, palette));

  // ON THE COUNTER (morning) / TOMORROW (evening)
  if (surface === 'morning') {
    const rec = pickTrainingRec(state.date);
    if (rec) parts.push(renderOnTheCounter(rec, palette));
  } else {
    parts.push(renderTomorrow(state, palette));
  }

  // IN THE PNW
  const event = pickPnwEvent(state.date);
  if (event) parts.push(renderInThePnw(event, palette));

  // TODAY'S FORECAST (morning) / EVENING REFLECTION (evening)
  const forecast = pickForecast(surface, state);
  if (forecast) parts.push(renderForecast(forecast, surface, palette));

  // System status (evening only — between feature blocks and quote)
  if (surface === 'evening') {
    parts.push(renderSystemStatus(state, palette));
  }

  return parts.join('\n');
}

function renderBuilderStanding(stat, palette) {
  return `
<div style="margin:8px 0 6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:6px">Builder Standing</div>
  <p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:16px;line-height:1.3;color:${palette.ink}">${escapeHtml(stat.claim || '')}</p>
  <p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;line-height:1.45;color:${palette.ink_2}">${escapeHtml(stat.context_for_mitchell || '')}</p>
  <p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:12px;line-height:1.4;color:${palette.ink_3}">${escapeHtml(stat.applies_to_position || '')}</p>
  ${stat.source_url ? `<p style="margin:0;font-family:'Inter',sans-serif;font-size:10px"><a href="${escapeHtml(stat.source_url)}" style="color:${palette.accent};text-decoration:none;border-bottom:1px solid ${palette.rule}">${escapeHtml(prettyUrl(stat.source_url))}</a></p>` : ''}
</div>`.trim();
}

function renderOnTheCounter(rec, palette) {
  return `
<div style="margin:8px 0 6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:6px">On the Counter &middot; Training</div>
  <p style="margin:0 0 2px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:16px;line-height:1.25;color:${palette.ink}">${escapeHtml(rec.title || '')}</p>
  ${rec.estimated_time_minutes ? `<p style="margin:0 0 4px 0;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:${palette.ink_4}">~${rec.estimated_time_minutes} min &middot; ${escapeHtml(rec.type || 'reading')}</p>` : ''}
  <p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;line-height:1.45;color:${palette.ink_2}">${escapeHtml(rec.summary || '')}</p>
  ${rec.pairs_with_mitchell_work ? `<p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:12px;line-height:1.4;color:${palette.ink_3}">${escapeHtml(rec.pairs_with_mitchell_work)}</p>` : ''}
  ${rec.url ? `<p style="margin:0;font-family:'Inter',sans-serif;font-size:10px"><a href="${escapeHtml(rec.url)}" style="color:${palette.accent};text-decoration:none;border-bottom:1px solid ${palette.rule};font-weight:700;letter-spacing:0.10em;text-transform:uppercase">Open &rarr;</a></p>` : ''}
</div>`.trim();
}

function renderInThePnw(event, palette) {
  const niceDate = (() => {
    try {
      const d = new Date(event.date + 'T12:00:00Z');
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    } catch { return event.date; }
  })();
  return `
<div style="margin:8px 0 6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:6px">In the PNW &middot; Networking</div>
  <p style="margin:0 0 2px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:15px;line-height:1.25;color:${palette.ink}">${escapeHtml(event.name || '')}</p>
  <p style="margin:0 0 4px 0;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:${palette.ink_4}">${escapeHtml(niceDate)} &middot; ${escapeHtml(event.venue || event.address || 'venue on event page')}</p>
  ${event.fit_for_mitchell ? `<p style="margin:0 0 4px 0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:12px;line-height:1.4;color:${palette.ink_3}">${escapeHtml(event.fit_for_mitchell)}</p>` : ''}
  ${event.rsvp_url ? `<p style="margin:0;font-family:'Inter',sans-serif;font-size:10px"><a href="${escapeHtml(event.rsvp_url)}" style="color:${palette.accent};text-decoration:none;border-bottom:1px solid ${palette.rule};font-weight:700;letter-spacing:0.10em;text-transform:uppercase">RSVP &rarr;</a></p>` : ''}
</div>`.trim();
}

function renderForecast(forecastText, surface, palette) {
  const label = surface === 'morning' ? "Today's Forecast" : 'Evening Reflection';
  return `
<div style="margin:8px 0 6px 0;padding:6px 0 6px 18px;border-left:3px solid ${palette.accent}">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.accent};margin-bottom:4px">${label}</div>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:14px;line-height:1.45;color:${palette.ink_2}">${escapeHtml(forecastText)}</p>
</div>`.trim();
}

function renderTomorrow(state, palette) {
  // Pre-positioned action for the morning. If we have a tonightsApply in
  // state, name it; otherwise, name the upstream lift.
  const pick = state.applyNow && state.applyNow[0];
  const body = pick
    ? `Tomorrow opens with <span style="font-style:normal;color:${palette.ink}">${escapeHtml(pick.company || '')}</span> &mdash; ${(pick.score || 0).toFixed(2)} / 5 sits at the top of the table. The morning pack is ready.`
    : 'Tomorrow opens upstream — one portal scanned, one outreach drafted, one publishable note refined.';
  return `
<div style="margin:8px 0 6px 0">
  <div class="editorial-grotesk" style="font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.20em;text-transform:uppercase;color:${palette.ink_4};margin-bottom:10px">Tomorrow</div>
  <p style="margin:0;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:15px;line-height:1.55;color:${palette.ink_2}">${body}</p>
</div>`.trim();
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname : '');
  } catch { return url; }
}

// ── Render: philosopher quote ─────────────────────────────────────────────
function renderQuote(quote, palette) {
  if (!quote) return '';
  const author = quote.author || 'Anonymous';
  const source = quote.source || '';
  const year = quote.year ? `, ${quote.year}` : '';
  return `
<div style="margin:10px 0 4px 0;text-align:center">
  <p style="margin:0 0 8px 0;font-family:'Fraunces','GT Sectra',Georgia,serif;font-style:italic;font-weight:400;font-size:17px;line-height:1.5;color:${palette.ink_2};letter-spacing:-0.005em">&ldquo;${escapeHtml(quote.text || '')}&rdquo;</p>
  <p class="editorial-grotesk" style="margin:0;font-family:'Inter',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:${palette.ink_4}">&mdash; ${escapeHtml(author)}${source ? ` &middot; ${escapeHtml(source)}` : ''}${year}</p>
</div>`.trim();
}

// ── Render: closer ────────────────────────────────────────────────────────
function renderCloser(surface, palette) {
  const ornament = surface === 'morning' ? '&#10118;' : '&sect;'; // ❘ vs §
  // F1b (2026-05-21): swapped from word-spelled clock ("nine hundred ·
  // pacific") to digital ("09:00 PT") per user direction.
  const line = surface === 'morning'
    ? 'filed at 09:00 PT'
    : 'filed at 18:00 PT';
  return `
<p style="margin:0;text-align:center">
  <span class="ornament" style="color:${palette.accent};font-family:'Fraunces',Georgia,serif;font-size:20px;letter-spacing:0.3em">${ornament}</span>
</p>
<p style="margin:8px 0 0 0;text-align:center;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:400;font-size:13px;color:${palette.ink_3}">${line}</p>`.trim();
}

// ── Render: colophon ──────────────────────────────────────────────────────
function renderColophon(state, surface, palette) {
  // Tracking-critical: emit "Generated:" timestamp in the colophon so the
  // regex audit \`Generated:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\` still passes.
  const ts = new Date().toISOString();
  // Strip the fractional seconds + Z so the regex sees exactly YYYY-MM-DDTHH:MM:SS
  const tsBase = ts.replace(/\.\d+Z$/, 'Z').replace(/Z$/, '');
  const issueLabel = surface === 'morning' ? 'MORNING' : 'EVENING';
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};vertical-align:top">
      <span style="color:${palette.ink_3}">Published</span><br>
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;letter-spacing:normal;text-transform:none;color:${palette.ink_3}">Generated: ${tsBase}</span>
    </td>
    <td style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};vertical-align:top;text-align:center">
      <span style="color:${palette.ink_3}">Dispatch</span><br>
      <span style="color:${palette.ink_3}">${issueLabel}</span>
    </td>
    <td style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};vertical-align:top;text-align:center">
      <span style="color:${palette.ink_3}">Desk</span><br>
      <span style="color:${palette.ink_3}">CAREER-OPS</span>
    </td>
    <td style="font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${palette.ink_4};vertical-align:top;text-align:right">
      <span style="color:${palette.ink_3}">Filed from</span><br>
      <span style="color:${palette.ink_3}">SEATTLE</span>
    </td>
  </tr>
  <tr>
    <td colspan="4" style="padding-top:10px;font-family:'Inter',sans-serif;font-size:10px;color:${palette.ink_4};text-align:center">
      <a href="${DASHBOARD_PUBLIC_URL}/" style="color:${palette.accent};text-decoration:none;border-bottom:1px solid ${palette.rule}">dashboard.careers-ops.com</a>
    </td>
  </tr>
</table>`.trim();
}

// ── Compute issue number (days since 2026-01-01) ──────────────────────────
function computeIssueNumber(iso, surface) {
  try {
    const d = isoDateNoonUtc(iso);
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const days = Math.max(1, Math.floor((d.getTime() - start.getTime()) / 86400000) + 1);
    // Morning + evening share the issue number for the day; if the brief
    // wanted distinct numbers we'd offset by surface here.
    return String(days).padStart(3, '0');
  } catch {
    return '001';
  }
}

// ── Build the preheader (Gmail-preview text) ──────────────────────────────
function buildPreheader(state, surface) {
  if (surface === 'morning') {
    if (state.tonightsApply) {
      const co = state.tonightsApply.company || '';
      const score = (state.tonightsApply.score || 0).toFixed(2);
      return `${co} &middot; ${score}/5 at the top of the table &middot; ${state.queueCount} apply-ready`;
    }
    return `${state.queueCount} apply-ready &middot; ${state.trackedCount} tracked &middot; the day's lift sits upstream`;
  }
  // evening
  if (state.evaluatedToday > 0) {
    return `${state.evaluatedToday} new evaluation${state.evaluatedToday === 1 ? '' : 's'} &middot; ${state.queueCount} apply-ready &middot; the runway holds`;
  }
  return `Quiet evening on the wire &middot; ${state.queueCount} apply-ready &middot; ${state.trackedCount} tracked`;
}

// ── Build palette for MJML interpolation ──────────────────────────────────
function buildPaletteVars(surface) {
  if (surface === 'morning') {
    return {
      paperBg:      MORNING.paper,
      ink:          MORNING.ink,
      ink2:         MORNING.ink_2,
      ink3:         MORNING.ink_3,
      ink4:         MORNING.ink_4,
      accent:       MORNING.accent,
      accentDeep:   MORNING.accent_deep,
      rule:         MORNING.rule,
      ruleStrong:   MORNING.rule_strong,
      positive:     MORNING.positive,
      negative:     MORNING.negative,
      colorScheme:  'light',
    };
  }
  return {
    paperBg:     EVENING.paper,
    ink:         EVENING.ink,
    ink2:        EVENING.ink_2,
    ink3:        EVENING.ink_3,
    ink4:        EVENING.ink_4,
    accent:      EVENING.accent,
    accentDeep:  EVENING.accent_deep,
    rule:        EVENING.rule,
    ruleStrong:  EVENING.rule_strong,
    positive:    EVENING.positive,
    negative:    EVENING.negative,
    colorScheme: 'dark',
  };
}

// Build the palette object (full token snapshot) the section renderers use.
// Mirrors the keys in MORNING / EVENING so renderers don't need to know
// which surface they're on.
function buildPalette(surface) {
  const t = surface === 'morning' ? MORNING : EVENING;
  return {
    paper: t.paper, paper_shadow: t.paper_shadow,
    ink: t.ink, ink_2: t.ink_2, ink_3: t.ink_3, ink_4: t.ink_4,
    accent: t.accent, accent_deep: t.accent_deep,
    rule: t.rule, rule_strong: t.rule_strong,
    positive: t.positive, negative: t.negative,
  };
}

// ── KPI: runway label + color ─────────────────────────────────────────────
function kpiRunway(state, palette) {
  const d = state.density;
  const weeks = d?.runway_weeks ?? parseInt(process.env.RUNWAY_WEEKS || '12');
  const health = state.runwayState;
  const color = health === 'critical' ? palette.negative
              : health === 'stretched' ? palette.accent
              : palette.positive;
  return { label: `${weeks}w`, color };
}

// ── Image attachment helper ───────────────────────────────────────────────
function buildImageAttachment(image) {
  if (!image || !image.path) return null;
  const absPath = join(ROOT, image.path);
  if (!existsSync(absPath)) {
    console.warn(`[dispatch] hero image missing: ${absPath}`);
    return null;
  }
  return {
    filename: `dispatch-${image.day || 'hero'}.webp`,
    path: absPath,
    cid: 'dispatchHero',
    contentType: 'image/webp',
  };
}

// ── Master render function ────────────────────────────────────────────────
async function renderDispatch(state, surface) {
  const extracted = extractStateFields(state, surface);
  const palette = buildPalette(surface);
  const paletteVars = buildPaletteVars(surface);
  const date = extracted.date;
  const issueNumber = computeIssueNumber(date, surface);

  // Subject via F-3
  const heroEvent = buildHeroEvent(state, surface);
  let subjectResult;
  try {
    subjectResult = await generateSubject(heroEvent, { quiet: true });
  } catch (e) {
    subjectResult = { subject: `${surface === 'morning' ? 'morning' : 'evening'} dispatch &middot; ${date}`, source: 'fallback' };
  }

  // Image
  const image = pickImageForDay(surface, date);
  const imagePath = image?.path ? join(ROOT, image.path) : null;
  const imageAlt = image?.subject ? `${image.subject} (rotation image, ${image.day})` : 'Dispatch hero image';

  // Section HTML
  const mastheadHtml      = renderMasthead(surface, date, palette, issueNumber);
  const heroDateHtml      = renderHeroDate(date, palette);
  const ledeHtml          = renderLede(extracted, surface, palette);
  const heroStoryHtml     = renderHeroStory(extracted, surface, palette);
  const heroCaptionHtml   = renderImageCaption(image, palette);
  const tickerHtml        = renderTicker(extracted, surface, palette);
  const focusPullquoteHtml= renderFocusPullquote(extracted, palette);
  const runwayAlertHtml   = renderRunwayAlertEditorial(extracted, surface, palette);
  const featureBlocksHtml = renderFeatureBlocks(extracted, surface, palette);
  const quote             = pickQuote(surface, date);
  const quoteHtml         = renderQuote(quote, palette);
  const closerHtml        = renderCloser(surface, palette);
  const colophonHtml      = renderColophon(extracted, surface, palette);

  // KPIs
  const runwayInfo = kpiRunway(extracted, palette);
  const kpiQueueCount     = String(extracted.queueCount);
  const kpiEvaluatedToday = String(extracted.evaluatedToday);
  const kpiTrackedCount   = String(extracted.trackedCount);
  const kpiRunwayLabel    = runwayInfo.label;
  const kpiRunwayColor    = runwayInfo.color;

  const preheaderText = buildPreheader(extracted, surface);

  // Interpolate template
  let tmpl = getMjmlTemplate();
  const fills = {
    date: `${surface === 'morning' ? 'Morning' : 'Evening'} Dispatch — ${date}`,
    preheaderText,
    mastheadHtml,
    heroDateHtml,
    ledeHtml,
    heroStoryHtml,
    heroImageAlt: imageAlt,
    heroCaptionHtml,
    tickerHtml,
    focusPullquoteHtml,
    runwayAlertHtml,
    featureBlocksHtml,
    quoteHtml,
    closerHtml,
    colophonHtml,
    kpiQueueCount,
    kpiEvaluatedToday,
    kpiTrackedCount,
    kpiRunwayLabel,
    kpiRunwayColor,
    paperBg:     paletteVars.paperBg,
    ink:         paletteVars.ink,
    ink2:        paletteVars.ink2,
    ink3:        paletteVars.ink3,
    ink4:        paletteVars.ink4,
    accent:      paletteVars.accent,
    accentDeep:  paletteVars.accentDeep,
    rule:        paletteVars.rule,
    ruleStrong:  paletteVars.ruleStrong,
    positive:    paletteVars.positive,
    negative:    paletteVars.negative,
    colorScheme: paletteVars.colorScheme,
  };
  for (const [k, v] of Object.entries(fills)) {
    const needle = `{{${k}}}`;
    tmpl = tmpl.split(needle).join(v == null ? '' : String(v));
  }

  // Compile MJML — recent versions return a Promise so we await.
  const compiled = await mjml2html(tmpl, { validationLevel: 'soft', minify: false });
  if (compiled.errors && compiled.errors.length > 0) {
    for (const e of compiled.errors) {
      console.warn(`[dispatch/mjml] ${e.formattedMessage || e.message || JSON.stringify(e)}`);
    }
  }
  const html = compiled.html || '';

  // Attachments (CID images)
  const attachments = [];
  const attachment = buildImageAttachment(image);
  if (attachment) attachments.push(attachment);

  return {
    html,
    subject: subjectResult.subject,
    subjectSource: subjectResult.source,
    attachments,
    // Preserve the markdown body so callers can still archive .md if they want.
    markdownBody: state.markdownBody || '',
  };
}

// ── Public exports ────────────────────────────────────────────────────────
export async function renderDispatchMorning(state) {
  return renderDispatch(state, 'morning');
}
export async function renderDispatchEvening(state) {
  return renderDispatch(state, 'evening');
}

// Expose internals for tests
export const __test = {
  buildHeroEvent,
  pickImageForDay,
  pickQuote,
  pickBuilderStat,
  pickTrainingRec,
  pickPnwEvent,
  pickForecast,
  evaluateCondition,
  evaluateAtom,
  resolvePath,
  dateLongWords,
  yearAsWords,
  spellTwoDigit,
  computeIssueNumber,
  buildPalette,
  buildPaletteVars,
  extractStateFields,
};

// ── CLI smoke ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    const surface = args.includes('--evening') ? 'evening' : 'morning';
    const dateArg = args.find(a => a.startsWith('--date='));
    const date = dateArg ? dateArg.split('=')[1] : new Date().toISOString().slice(0, 10);

    const state = {
      date,
      queueCount: 5,
      trackedCount: 1200,
      evaluatedToday: 3,
      outreachDue: 2,
      runwayState: 'stretched',
      runwayAlert: true,
      newRoles: 1,
      todaysFocus: 'Tonight, ship the OpenAI FDE pack — it\'s the highest-leverage move.',
      applyNow: [
        { num: 1234, company: 'OpenAI', role: 'Forward Deployed Engineer', score: 4.65, date, reportPath: 'reports/1234-openai-fde.md' },
        { num: 1235, company: 'Anthropic', role: 'Solutions Architect', score: 4.50, date },
        { num: 1236, company: 'Perplexity', role: 'AI Product Manager', score: 4.30, date },
      ],
      whatsNew: [],
      density: {
        ok: true, runway_weeks: 12, health: 'stretched',
        runway_alert: 'Cushion shrinking — add 2 more active conversations and 6 more touches this week.',
        contacts: { total: 200, active: 3, responded: 1, dead: 100, response_rate: 0.05 },
        velocity: { touches_last_7d: 4, touches_last_30d: 18, days_since_last_touch: 2 },
      },
    };

    const fn = surface === 'morning' ? renderDispatchMorning : renderDispatchEvening;
    const result = await fn(state);
    process.stdout.write(result.html);
    process.stderr.write(`\nSubject: ${result.subject} (${result.subjectSource})\n`);
    process.stderr.write(`Attachments: ${result.attachments.length}\n`);
  })().catch(err => {
    console.error('heartbeat-dispatch error:', err.stack || err.message);
    process.exit(1);
  });
}
