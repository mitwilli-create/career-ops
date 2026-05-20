/**
 * scripts/dispatch-subject-line.test.mjs — Phase F-3 test suite.
 *
 * Tests the deterministic fallback path + ribbon prefixes + sanitization.
 * Haiku is never called in these tests (we force fallback) so the suite is
 * fully offline and deterministic.
 *
 * Run: node --test scripts/dispatch-subject-line.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateSubject, __test } from './dispatch-subject-line.mjs';

const { pickFallback, wrapSubject, sanitizeSubject, parseHaikuJson, HARD_CAP } = __test;

// =============================================================================
// Test isolation — clear env mutations between tests
// =============================================================================

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// =============================================================================
// 1. Morning queue empty + runway past-floor
// =============================================================================

test('morning queue empty + past-floor → outreach push subject', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 0,
    runwayState: 'past-floor',
    outreachTouches: { sent: 0, target: 10 },
  };
  const out = await generateSubject(hero, { forceFallback: true });
  assert.equal(out.source, 'fallback');
  assert.equal(out.subject, 'the queue is empty · push outreach today');
  assert.ok(out.subject.length <= HARD_CAP);
});

// =============================================================================
// 2. Morning top role 4.6/5
// =============================================================================

test('morning top role ≥4.5 → company role score subject', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 3,
    runwayState: 'stretched',
    topPendingAction: { company: 'OpenAI', role: 'FDE', score: 4.6 },
    outreachTouches: { sent: 5, target: 10 },
  };
  const out = await generateSubject(hero, { forceFallback: true });
  assert.equal(out.source, 'fallback');
  assert.equal(out.subject, 'OpenAI FDE · 4.6/5 ready');
});

// =============================================================================
// 3. Morning recent reply
// =============================================================================

test('morning with recent reply → person replied subject', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 2,
    runwayState: 'healthy',
    recentReply: { from: 'Brandon', company: 'Anthropic' },
  };
  const out = await generateSubject(hero, { forceFallback: true });
  assert.equal(out.source, 'fallback');
  assert.equal(out.subject, 'Brandon replied · the path opens');
});

// =============================================================================
// 4. Evening reply landed
// =============================================================================

test('evening with recent reply → person replied at time subject', async () => {
  const hero = {
    surface: 'evening',
    date: '2026-05-20',
    queueDepth: 4,
    runwayState: 'stretched',
    recentReply: { from: 'Sarah', time: '3pm' },
  };
  const out = await generateSubject(hero, { forceFallback: true });
  assert.equal(out.source, 'fallback');
  assert.equal(out.subject, 'Sarah replied at 3pm · path open');
});

// =============================================================================
// 5. Evening quiet (no special signals)
// =============================================================================

test('evening quiet → end of day subject with weekday name', async () => {
  const hero = {
    surface: 'evening',
    date: '2026-05-20', // a Wednesday (2026-05-20)
    queueDepth: 12,
    runwayState: 'stretched',
  };
  const out = await generateSubject(hero, { forceFallback: true });
  assert.equal(out.source, 'fallback');
  // 2026-05-20 is a Wednesday (verified)
  assert.ok(
    out.subject.startsWith('end of wednesday · 12 tracked'),
    `expected weekday-prefixed subject, got: ${out.subject}`
  );
});

// =============================================================================
// 6. Fallback triggered prepends [fallback]
// =============================================================================

test('fallbackTriggered=true → [fallback] prefix', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 0,
    runwayState: 'past-floor',
    outreachTouches: { sent: 0, target: 10 },
    fallbackTriggered: true,
  };
  await withEnv({ HEARTBEAT_TEST_MODE: undefined }, async () => {
    const out = await generateSubject(hero, { forceFallback: true });
    assert.ok(
      out.subject.startsWith('[fallback] '),
      `expected [fallback] prefix, got: ${out.subject}`
    );
  });
});

// =============================================================================
// 7. Test mode prepends [F-TEST]
// =============================================================================

test('HEARTBEAT_TEST_MODE=true → [F-TEST] prefix', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 0,
    runwayState: 'past-floor',
    outreachTouches: { sent: 0, target: 10 },
  };
  await withEnv({ HEARTBEAT_TEST_MODE: 'true' }, async () => {
    const out = await generateSubject(hero, { forceFallback: true });
    assert.ok(
      out.subject.startsWith('[F-TEST] '),
      `expected [F-TEST] prefix, got: ${out.subject}`
    );
  });
});

// =============================================================================
// 8. Both prefixes stack: [F-TEST] [fallback] ...
// =============================================================================

test('test mode + fallbackTriggered → both prefixes stack ([F-TEST] [fallback] ...)', async () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 0,
    runwayState: 'past-floor',
    outreachTouches: { sent: 0, target: 10 },
    fallbackTriggered: true,
  };
  await withEnv({ HEARTBEAT_TEST_MODE: 'true' }, async () => {
    const out = await generateSubject(hero, { forceFallback: true });
    assert.ok(
      out.subject.startsWith('[F-TEST] [fallback] '),
      `expected stacked prefixes, got: ${out.subject}`
    );
  });
});

// =============================================================================
// 9. Hard cap enforced (78 chars)
// =============================================================================

test('subject longer than 78 chars is truncated to HARD_CAP', () => {
  const longText = 'a'.repeat(120);
  const result = wrapSubject(longText, { surface: 'morning' }, 'haiku', 0);
  assert.equal(result.subject.length, HARD_CAP);
});

// =============================================================================
// 10. sanitizeSubject strips quotes + "Subject:" + emoji
// =============================================================================

test('sanitizeSubject strips wrapping quotes, Subject: prefix, and emoji', () => {
  assert.equal(sanitizeSubject('"hello world"'), 'hello world');
  assert.equal(sanitizeSubject("'hello world'"), 'hello world');
  assert.equal(sanitizeSubject('Subject: the day begins'), 'the day begins');
  assert.equal(sanitizeSubject('subject:  trimmed  '), 'trimmed');
  assert.equal(sanitizeSubject('OpenAI FDE 🚀 4.6/5'), 'OpenAI FDE 4.6/5');
});

// =============================================================================
// 11. Morning errors take priority over reply / role / etc.
// =============================================================================

test('morning errors take priority over queue + reply', () => {
  const hero = {
    surface: 'morning',
    date: '2026-05-20',
    queueDepth: 5,
    runwayState: 'healthy',
    errors: 3,
    recentReply: { from: 'Brandon' },
    topPendingAction: { company: 'OpenAI', role: 'FDE', score: 4.8 },
  };
  const subject = pickFallback(hero);
  assert.equal(subject, '3 system errors · check before noon');
});

// =============================================================================
// 12. Evening past-floor (no reply / errors) → floor-breached subject
// =============================================================================

test('evening past-floor without reply → floor breached subject', () => {
  const hero = {
    surface: 'evening',
    date: '2026-05-20',
    queueDepth: 2,
    runwayState: 'past-floor',
    outreachTouches: { sent: 3, target: 10 },
  };
  const subject = pickFallback(hero);
  assert.equal(subject, 'floor still breached · 3 of 10 this week');
});

// =============================================================================
// 13. Universal generic fallback when nothing else applies
// =============================================================================

test('unknown surface falls through to universal generic template', () => {
  const hero = {
    surface: 'unknown',
    date: '2026-05-20',
  };
  const subject = pickFallback(hero);
  // shortDate emits "may 20" for 2026-05-20.
  assert.equal(subject, "the day's count · may 20");
});

// =============================================================================
// 14. parseHaikuJson handles fenced JSON
// =============================================================================

test('parseHaikuJson strips ```json fence', () => {
  const raw = '```json\n{ "candidates": ["a","b","c"], "pick": 1 }\n```';
  const obj = parseHaikuJson(raw);
  assert.equal(obj.candidates[1], 'b');
  assert.equal(obj.pick, 1);
});

test('parseHaikuJson handles preamble before JSON', () => {
  const raw = 'Here are three candidates:\n{ "candidates": ["x","y","z"], "pick": 0 }';
  const obj = parseHaikuJson(raw);
  assert.equal(obj.candidates[0], 'x');
});

test('parseHaikuJson throws on no JSON', () => {
  assert.throws(() => parseHaikuJson('just plain text'), /non-JSON/);
});

test('parseHaikuJson throws on missing candidates', () => {
  assert.throws(() => parseHaikuJson('{ "foo": 1 }'), /missing candidates/);
});

// =============================================================================
// 15. generateSubject throws on missing heroEvent
// =============================================================================

test('generateSubject throws when heroEvent missing', async () => {
  await assert.rejects(() => generateSubject(null), /heroEvent is required/);
  await assert.rejects(() => generateSubject(undefined), /heroEvent is required/);
});
