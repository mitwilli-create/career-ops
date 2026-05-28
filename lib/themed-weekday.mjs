// Themed weekday content selector for the AM heartbeat.
//
// Per Mitchell's Q3 locked decision (2026-05-27 interview): each weekday
// surfaces a different content theme as the focus module, with apply queue
// + reminders always-present.
//
//   Mon: convos     — Reddit (via Perplexity) + X (via Grok-4)
//   Tue: events     — lu.ma + AI Tinkerers + Meetup (PNW-first cascade)
//   Wed: articles   — HN + dev.to + Substack + LinkedIn AI posts
//   Thu: tips       — Gemini DRM weekly tips synthesis (PR-C scope)
//   Fri: digest     — consolidated Mon+Tue+Wed+Thu cache + week recap
//   Sat: no email   — per Q10 locked (weekend = build mode)
//   Sun: no email
//
// Reads from data/dispatch/{convos,articles,tips,reminders}.json populated
// by scripts/agents/content-ingest.mjs (the daily 03:00 PT cron). Events
// continue to flow through the existing pnw-events.json + PR-A liveness
// filter; this module simply tags Tuesday as the "feature" day for events.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const DISPATCH_DIR = join(ROOT, 'data/dispatch');

export const THEMES = {
  0: { id: 'no-email', label: null }, // Sun
  1: { id: 'convos',   label: 'Monday · Builder Convos' },
  2: { id: 'events',   label: 'Tuesday · PNW Events' },
  3: { id: 'articles', label: 'Wednesday · Articles' },
  4: { id: 'tips',     label: 'Thursday · Tips & Tricks' },
  5: { id: 'digest',   label: 'Friday · Week Digest + Weekend Build Queue' },
  6: { id: 'no-email', label: null }, // Sat
};

export function getThemeForIso(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const dow = d.getUTCDay();
  return THEMES[dow];
}

function loadJsonSafe(filename) {
  const path = join(DISPATCH_DIR, filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadThemeContent(theme) {
  switch (theme.id) {
    case 'convos':
      return loadJsonSafe('convos.json');
    case 'articles':
      return loadJsonSafe('articles.json');
    case 'tips':
      return loadJsonSafe('tips.json');
    case 'events':
      // Events have their own dispatch path via heartbeat-dispatch.mjs's
      // existing pickPnwEvent() — no new file needed.
      return { source: 'pnw-events.json', delegate: 'pickPnwEvent' };
    case 'digest':
      return {
        convos:   loadJsonSafe('convos.json'),
        articles: loadJsonSafe('articles.json'),
        tips:     loadJsonSafe('tips.json'),
      };
    default:
      return null;
  }
}

// Returns the top N items from theme content, normalized to a common shape
// { title, url, summary, source, posted_at, score } for easy rendering.
export function pickThemeItems(theme, content, { maxItems = 3 } = {}) {
  if (!content) return [];
  if (theme.id === 'convos') {
    const items = [];
    // Reddit items first (deeper context), then X items (faster signal)
    if (Array.isArray(content.reddit?.items)) {
      items.push(...content.reddit.items.map(i => ({ ...i, source: 'reddit' })));
    }
    if (Array.isArray(content.x?.items)) {
      items.push(...content.x.items.map(i => ({ ...i, source: 'x' })));
    }
    return items.slice(0, maxItems);
  }
  if (theme.id === 'articles') {
    const items = [];
    if (Array.isArray(content.hn?.items)) {
      items.push(...content.hn.items.map(i => ({ ...i, source: 'hn' })));
    }
    if (Array.isArray(content.github?.items)) {
      items.push(...content.github.items.map(i => ({
        title: i.name,
        url: i.url,
        summary: i.description,
        source: 'github-trending',
        posted_at: null,
        score: i.total_stars,
      })));
    }
    return items.slice(0, maxItems);
  }
  if (theme.id === 'tips' && Array.isArray(content.items)) {
    return content.items.slice(0, maxItems);
  }
  if (theme.id === 'digest') {
    const items = [];
    for (const key of ['convos', 'articles', 'tips']) {
      const sub = content[key];
      if (sub?.reddit?.items?.[0]) items.push({ ...sub.reddit.items[0], source: 'reddit', day: key });
      if (sub?.x?.items?.[0])      items.push({ ...sub.x.items[0],      source: 'x',      day: key });
      if (sub?.hn?.items?.[0])     items.push({ ...sub.hn.items[0],     source: 'hn',     day: key });
      if (sub?.items?.[0])         items.push({ ...sub.items[0],        source: 'tips',   day: key });
    }
    return items.slice(0, maxItems);
  }
  return [];
}
