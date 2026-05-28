// Runtime liveness helpers for community-event pages consumed by the heartbeat
// IN-THE-PNW section. Three layers:
//   isCurationFresh(event, todayIso) — sync check vs `retrieved` field; default 7d window
//   checkEventUrlLive(url, opts)     — async HTTP probe with browser UA + "event ended" pattern match
//   stripDayOfWeekParenthetical(name) — sync display-name cleanup that strips "(Friday)" / "(Saturday)" / etc
//
// Wired into scripts/heartbeat-dispatch.mjs pickPnwEvent (filter) + renderInThePnw (display).
// See AGENTS.md "Bug class: heartbeat-event-liveness-stale-source-url" for context.

const FRESHNESS_WINDOW_DAYS = 7;

const EVENT_ENDED_PATTERNS = [
  /event ended/i,
  /event has already taken place/i,
  /this event is over/i,
  /past event/i,
  /event cancelled/i,
  /event canceled/i,
  /registration is closed/i,
  /event has passed/i,
];

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

export function isCurationFresh(event, todayIso) {
  if (!event || !event.retrieved || !todayIso) return false;
  try {
    const retrieved = new Date(event.retrieved + 'T00:00:00Z');
    const today = new Date(todayIso + 'T00:00:00Z');
    const daysOld = (today - retrieved) / (1000 * 60 * 60 * 24);
    return daysOld >= 0 && daysOld <= FRESHNESS_WINDOW_DAYS;
  } catch {
    return false;
  }
}

export async function checkEventUrlLive(url, { timeoutMs = 8000 } = {}) {
  if (!url || typeof url !== 'string') {
    return { alive: false, reason: 'invalid_url' };
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { alive: false, reason: `http_${res.status}`, status: res.status };
    }
    const body = await res.text();
    for (const pattern of EVENT_ENDED_PATTERNS) {
      if (pattern.test(body)) {
        return { alive: false, reason: `matched_pattern:${pattern.source}`, status: res.status, finalUrl: res.url };
      }
    }
    return { alive: true, status: res.status, finalUrl: res.url };
  } catch (err) {
    return { alive: false, reason: `fetch_error:${err.name || 'unknown'}`, error: err.message };
  }
}

const WEEKDAY_PARENTHETICAL = /\s*\((?:Mon|Tues?|Wednes|Thurs|Fri|Satur|Sun)(?:day)?\)\s*/gi;

export function stripDayOfWeekParenthetical(name) {
  if (!name || typeof name !== 'string') return name;
  return name.replace(WEEKDAY_PARENTHETICAL, ' ').replace(/\s+/g, ' ').trim();
}

export const _internals = { FRESHNESS_WINDOW_DAYS, EVENT_ENDED_PATTERNS, BROWSER_UA, WEEKDAY_PARENTHETICAL };
