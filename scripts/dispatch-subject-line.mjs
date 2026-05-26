#!/usr/bin/env node
/**
 * scripts/dispatch-subject-line.mjs — Phase F-3 dynamic subject-line system.
 *
 * Replaces today's static "[career-ops] heartbeat · 2026-05-20" with a per-day
 * Haiku-generated subject anchored to the day's hero event. 12 fallback
 * templates kick in if Haiku is unreachable or returns malformed JSON.
 *
 * Voice contract (see prompt below):
 *   - sounds like Mitchell wrote it, not a SaaS notification
 *   - lowercase preferred; em-dash and middle-dot fine; no colons
 *   - no "[career-ops]" / "heartbeat" / "dispatch" tags
 *   - no urgency bait, no cheerleader voice, no emojis
 *   - 65-char target, 78-char hard cap (Gmail truncates ~78)
 *
 * Ribbon prefixes (stack, F-TEST outermost):
 *   - HEARTBEAT_TEST_MODE=true   → "[F-TEST] " prepended (verification sends)
 *   - heroEvent.fallbackTriggered → "[fallback] " prepended (rollback signal)
 *   Combined: "[F-TEST] [fallback] <subject>"
 *
 * Usage:
 *   import { generateSubject } from './dispatch-subject-line.mjs';
 *   const { subject, source, cost } = await generateSubject(heroEvent);
 *
 * CLI smoke:
 *   node scripts/dispatch-subject-line.mjs \
 *     --hero-event='{"surface":"morning","date":"2026-05-20","queueDepth":0,"outreachTouches":{"sent":0,"target":10}}'
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Best-effort dotenv load. Heartbeat callers may have already loaded it; this
// is idempotent because override:true respects whatever .env declares.
try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: resolve(__dirname, '..', '.env'), override: true });
} catch { /* dotenv optional */ }

const HAIKU_MODEL = process.env.ANTHROPIC_MODEL_HAIKU || 'claude-haiku-4-5-20251001';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Pricing for cost telemetry — Haiku 4.5: $0.25 input / $1.25 output per 1M tokens.
const HAIKU_PRICING = { input: 0.25, output: 1.25 };

// 78-char Gmail hard cap. We aim for 65 in the prompt; the cap is the safety net.
const HARD_CAP = 78;

// 10s Haiku timeout per hang-prevention rules. Subject lines are short; we
// never expect more than a couple of seconds of latency.
const HAIKU_TIMEOUT_MS = 10_000;

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a dispatch-email subject line for the given hero event.
 *
 * @param {object} heroEvent
 * @param {'morning'|'evening'} heroEvent.surface
 * @param {string} heroEvent.date                      YYYY-MM-DD
 * @param {number} heroEvent.queueDepth                # of apply-ready roles
 * @param {{company:string, role:string, score:number, closesIn?:string}} [heroEvent.topPendingAction]
 * @param {{from:string, company?:string}} [heroEvent.recentReply]
 * @param {{sent:number, target:number}} [heroEvent.outreachTouches]
 * @param {number} [heroEvent.errors]
 * @param {boolean} [heroEvent.fallbackTriggered]      true → prepend [fallback]
 * @param {object} [options]
 * @param {boolean} [options.quiet=false]              suppress fallback warn log
 * @param {boolean} [options.forceFallback=false]      skip Haiku call (tests)
 * @returns {Promise<{subject:string, source:'haiku'|'fallback', cost?:number, tokenCount?:number}>}
 */
export async function generateSubject(heroEvent, options = {}) {
  const { quiet = false, forceFallback = false } = options;

  if (!heroEvent || typeof heroEvent !== 'object') {
    throw new Error('generateSubject: heroEvent is required');
  }

  if (forceFallback) {
    const subject = pickFallback(heroEvent);
    return wrapSubject(subject, heroEvent, 'fallback', 0);
  }

  try {
    const result = await callHaiku(heroEvent);
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const pickIdx = Number.isInteger(result.pick) ? result.pick : 0;
    const raw = candidates[pickIdx] ?? candidates[0];

    if (!raw || typeof raw !== 'string') {
      throw new Error('Haiku returned no usable candidates');
    }

    const cleaned = sanitizeSubject(raw);
    return wrapSubject(cleaned, heroEvent, 'haiku', result.cost, result.tokenCount);
  } catch (err) {
    if (!quiet) {
      console.warn(`[dispatch-subject-line] Haiku failed, using fallback: ${err.message}`);
    }
    const subject = pickFallback(heroEvent);
    return wrapSubject(subject, heroEvent, 'fallback', 0);
  }
}

// =============================================================================
// Ribbon + final-shape wrapper
// =============================================================================

function wrapSubject(subject, heroEvent, source, cost, tokenCount) {
  let final = subject;
  // [fallback] is the inner ribbon — it indicates rollback was triggered.
  if (heroEvent.fallbackTriggered === true) {
    final = `[fallback] ${final}`;
  }
  // [F-TEST] is the outer ribbon — distinguishes overnight verification sends.
  if (process.env.HEARTBEAT_TEST_MODE === 'true') {
    final = `[F-TEST] ${final}`;
  }
  // Gmail truncates at ~78 chars; hard cap.
  if (final.length > HARD_CAP) final = final.slice(0, HARD_CAP);
  const out = { subject: final, source };
  if (typeof cost === 'number') out.cost = cost;
  if (typeof tokenCount === 'number') out.tokenCount = tokenCount;
  return out;
}

// =============================================================================
// Sanitization — strip anything Haiku might smuggle past the voice rules
// =============================================================================

function sanitizeSubject(raw) {
  let s = String(raw).trim();
  // Strip surrounding quotes the model sometimes adds.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Strip leading "Subject:" prefix if model includes it.
  s = s.replace(/^subject\s*:\s*/i, '').trim();
  // Strip emoji (safe approximation: most pictograph + symbol blocks).
  // We do this here as a belt-and-suspenders defense against the voice prompt being ignored.
  s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
       .replace(/[\u{2600}-\u{27BF}]/gu, '')
       .replace(/\s{2,}/g, ' ')
       .trim();
  return s;
}

// =============================================================================
// Haiku call
// =============================================================================

async function callHaiku(heroEvent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const prompt = buildPrompt(heroEvent);

  const body = {
    model: HAIKU_MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  };

  // Hang-prevention: AbortSignal.timeout on the fetch.
  const signal = AbortSignal.timeout(HAIKU_TIMEOUT_MS);

  const r = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!r.ok) {
    const txt = (await r.text()).slice(0, 240);
    throw new Error(`Haiku HTTP ${r.status}: ${txt}`);
  }

  const j = await r.json();
  const content = (j.content || []).map(c => c.text || '').join('');
  const usage = j.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cost =
    (inputTokens / 1_000_000) * HAIKU_PRICING.input +
    (outputTokens / 1_000_000) * HAIKU_PRICING.output;

  const parsed = parseHaikuJson(content);
  return { ...parsed, cost, tokenCount: inputTokens + outputTokens };
}

function parseHaikuJson(content) {
  // Haiku usually returns clean JSON, but sometimes wraps it in ```json blocks.
  let txt = String(content).trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) txt = fence[1].trim();
  // Find the first { … last } — Haiku occasionally prepends commentary.
  const first = txt.indexOf('{');
  const last = txt.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`Haiku returned non-JSON: ${txt.slice(0, 120)}`);
  }
  const json = txt.slice(first, last + 1);
  const obj = JSON.parse(json);
  if (!Array.isArray(obj.candidates) || obj.candidates.length === 0) {
    throw new Error('Haiku JSON missing candidates array');
  }
  return obj;
}

function buildPrompt(heroEvent) {
  return `You write subject lines for Mitchell Williams' personal career-ops dispatch newsletter. This is his daily morning + evening briefing on his AI job search.

Voice rules:
- Sounds like a real person, not a system notification
- Specific to today's hero event, not generic
- Lead with the conclusion or the concrete fact
- Em-dashes (—) and middle-dots (·) are fine; avoid colons
- Lowercase preferred unless a proper noun (OpenAI, Anthropic) appears
- No "[career-ops]" tags, no "heartbeat", no "dispatch", no "newsletter"
- No urgency-bait (no "ACT NOW", no "🚨", no "URGENT")
- No assistant-cheerleader (no "you've got this", no "let's go!")
- No emojis
- Under 65 characters

Today's hero event:
${JSON.stringify(heroEvent, null, 2)}

Write 3 candidate subject lines. Return as JSON: { "candidates": ["...", "...", "..."], "pick": 0 }
The "pick" field is the index (0-2) of your strongest choice.`;
}

// =============================================================================
// Fallback templates — deterministic, no model required
// =============================================================================

// Each template is { id, applies(heroEvent), build(heroEvent) }.
// Priority order: the FIRST applicable template wins. Order chosen to surface
// the most-actionable signal first.
const FALLBACK_TEMPLATES = [
  // ---- Morning templates ----
  {
    id: 'morning:errors',
    surface: 'morning',
    applies: e => e.surface === 'morning' && Number(e.errors) > 0,
    build: e => `${e.errors} system errors · check before noon`,
  },
  {
    id: 'morning:reply',
    surface: 'morning',
    applies: e => e.surface === 'morning' && e.recentReply?.from,
    build: e => `${e.recentReply.from} replied · the path opens`,
  },
  {
    id: 'morning:top-role',
    surface: 'morning',
    applies: e => e.surface === 'morning' && e.topPendingAction
      && Number(e.topPendingAction.score) >= 4.5,
    build: e => {
      const score = Number(e.topPendingAction.score).toFixed(1);
      return `${e.topPendingAction.company} ${e.topPendingAction.role} · ${score}/5 ready`;
    },
  },
  // (morning:empty-past-floor template was retired 2026-05-25 alongside
  // the runway-coupling sweep — heroEvent.runwayState is no longer passed.)
  {
    id: 'morning:outreach-behind',
    surface: 'morning',
    applies: e => e.surface === 'morning' && e.outreachTouches
      && Number(e.outreachTouches.sent) < Number(e.outreachTouches.target),
    build: e => `${e.outreachTouches.sent} of ${e.outreachTouches.target} touches · push outreach`,
  },
  {
    id: 'morning:empty-healthy',
    surface: 'morning',
    applies: e => e.surface === 'morning' && Number(e.queueDepth) === 0,
    build: () => "queue's clear · take the morning",
  },

  // ---- Evening templates ----
  {
    id: 'evening:errors',
    surface: 'evening',
    applies: e => e.surface === 'evening' && Number(e.errors) > 0,
    build: e => `${e.errors} system warnings · see digest`,
  },
  {
    id: 'evening:reply',
    surface: 'evening',
    applies: e => e.surface === 'evening' && e.recentReply?.from,
    build: e => {
      const time = e.recentReply.time || 'today';
      return `${e.recentReply.from} replied at ${time} · path open`;
    },
  },
  // (evening:past-floor template was retired 2026-05-25 alongside the
  // runway-coupling sweep — heroEvent.runwayState is no longer passed.)
  {
    id: 'evening:touch-landed',
    surface: 'evening',
    applies: e => e.surface === 'evening' && Number(e.queueDepth) > 0
      && e.outreachTouches && Number(e.outreachTouches.sent) > 0,
    build: e => `one touch landed · ${e.queueDepth} new in the queue`,
  },
  {
    id: 'evening:quiet',
    surface: 'evening',
    applies: e => e.surface === 'evening',
    build: e => {
      const dayName = dayNameFromIsoDate(e.date);
      const tracked = e.queueDepth ?? 0;
      return `end of ${dayName} · ${tracked} tracked`;
    },
  },

  // ---- Universal last-resort ----
  {
    id: 'universal:generic',
    surface: 'any',
    applies: () => true,
    build: e => `the day's count · ${shortDate(e.date)}`,
  },
];

function pickFallback(heroEvent) {
  for (const tpl of FALLBACK_TEMPLATES) {
    try {
      if (tpl.applies(heroEvent)) return tpl.build(heroEvent);
    } catch {
      // Defensive: skip a template that throws on a malformed shape.
    }
  }
  // Should be unreachable thanks to universal:generic, but be defensive.
  return `the day's count · ${shortDate(heroEvent.date)}`;
}

function dayNameFromIsoDate(iso) {
  if (!iso || typeof iso !== 'string') return 'today';
  // Use noon UTC to avoid timezone edge cases shifting the weekday.
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return 'today';
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase();
}

function shortDate(iso) {
  if (!iso || typeof iso !== 'string') return 'today';
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toLowerCase();
}

// =============================================================================
// Exports for tests
// =============================================================================

export const __test = {
  pickFallback,
  wrapSubject,
  sanitizeSubject,
  FALLBACK_TEMPLATES,
  dayNameFromIsoDate,
  shortDate,
  parseHaikuJson,
  HARD_CAP,
};

// =============================================================================
// CLI entry
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    let heroEventJson = null;
    let forceFallback = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--hero-event=')) {
        heroEventJson = a.slice('--hero-event='.length);
      } else if (a === '--hero-event') {
        heroEventJson = args[++i];
      } else if (a === '--fallback') {
        forceFallback = true;
      } else if (a === '--help' || a === '-h') {
        console.log(`Usage: node scripts/dispatch-subject-line.mjs --hero-event='<json>' [--fallback]`);
        process.exit(0);
      }
    }

    if (!heroEventJson) {
      console.error('Missing --hero-event=<json>');
      process.exit(2);
    }

    let heroEvent;
    try {
      heroEvent = JSON.parse(heroEventJson);
    } catch (err) {
      console.error(`Invalid --hero-event JSON: ${err.message}`);
      process.exit(2);
    }

    try {
      const out = await generateSubject(heroEvent, { forceFallback });
      console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      console.error(`generateSubject failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
