// Time-sensitive reminders for the always-present AM heartbeat section.
//
// Per Mitchell's Q7 locked decision (2026-05-27 interview): surface only
// items bound to TODAY — postings expiring in <48h, follow-ups due today,
// cooldowns breaking today. Minimum signal, highest urgency-to-noise ratio.
// No comprehensive scans, no banner fatigue.
//
// Reads from existing local state files (no new scrapes):
//   data/apply-now-queue.json    — ranked roles with expires_at / score
//   data/applications.md         — tracker for status + last-touched timestamps
//   data/follow-ups.md           — cadence-tracked follow-ups (if present)
//   data/dispatch/reminders.json — overflow/custom reminders staged by other agents
//
// Returns shape: { ts, items: [...] } where each item is
// { kind, label, detail, deadline, urgency, action_url }.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

const URGENCY_LEVELS = { critical: 0, high: 1, medium: 2 };

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

function readTextSafe(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf-8'); }
  catch { return null; }
}

function hoursUntil(targetIso, nowIso) {
  try {
    const target = new Date(targetIso);
    const now = new Date(nowIso);
    if (Number.isNaN(target.getTime()) || Number.isNaN(now.getTime())) return null;
    return (target - now) / (1000 * 3600);
  } catch { return null; }
}

// 1. Apply-now postings expiring in <48h
function postingsExpiringSoon(iso) {
  const queue = readJsonSafe(join(ROOT, 'data/apply-now-queue.json'));
  if (!queue || !Array.isArray(queue.ranked)) return [];
  const items = [];
  for (const r of queue.ranked) {
    if (!r.expires_at) continue;
    const h = hoursUntil(r.expires_at, iso);
    if (h === null || h < 0 || h > 48) continue;
    items.push({
      kind: 'posting-expiring',
      label: `${r.company} — ${r.role}`,
      detail: `Posting closes in ${Math.round(h)}h (${r.score || '?'}/5)`,
      deadline: r.expires_at,
      urgency: h < 12 ? 'critical' : h < 24 ? 'high' : 'medium',
      action_url: r.url || null,
      row: r.num,
    });
  }
  return items;
}

// 2. Follow-ups due today (parse data/follow-ups.md if it exists)
function followUpsDueToday(iso) {
  const md = readTextSafe(join(ROOT, 'data/follow-ups.md'));
  if (!md) return [];
  const today = iso.slice(0, 10);
  const items = [];
  for (const line of md.split('\n')) {
    // Match lines like "| 2026-05-28 | Company | Person | follow-up note |"
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const [, dueDate, company, person, note] = m;
    if (dueDate !== today) continue;
    items.push({
      kind: 'followup-due',
      label: `${company.trim()} — ${person.trim()}`,
      detail: note.trim(),
      deadline: dueDate,
      urgency: 'high',
      action_url: null,
    });
  }
  return items;
}

// 3. Cooldowns breaking today (read from any cooldown-context cache if present)
function cooldownsBreakingToday(iso) {
  const path = join(ROOT, 'data/cooldown-state.json');
  const state = readJsonSafe(path);
  if (!state || !Array.isArray(state.cooldowns)) return [];
  const today = iso.slice(0, 10);
  return state.cooldowns
    .filter(c => c.breaks_on === today)
    .map(c => ({
      kind: 'cooldown-breaking',
      label: `${c.company || 'Unknown'} — ${c.role || 'cooldown'} ending`,
      detail: c.note || 'Cooldown window ends today — re-engagement window opens',
      deadline: today,
      urgency: 'medium',
      action_url: c.url || null,
    }));
}

// 4. Custom reminders staged by other agents (data/dispatch/reminders.json)
function customReminders(iso) {
  const r = readJsonSafe(join(ROOT, 'data/dispatch/reminders.json'));
  if (!r || !Array.isArray(r.items)) return [];
  const today = iso.slice(0, 10);
  return r.items
    .filter(i => !i.show_on || i.show_on === today)
    .map(i => ({
      kind: i.kind || 'custom',
      label: i.label,
      detail: i.detail || '',
      deadline: i.deadline || null,
      urgency: i.urgency || 'medium',
      action_url: i.action_url || null,
    }));
}

export function getReminders(iso) {
  const all = [
    ...postingsExpiringSoon(iso),
    ...followUpsDueToday(iso),
    ...cooldownsBreakingToday(iso),
    ...customReminders(iso),
  ];
  all.sort((a, b) => (URGENCY_LEVELS[a.urgency] ?? 9) - (URGENCY_LEVELS[b.urgency] ?? 9));
  return { ts: new Date().toISOString(), items: all };
}
