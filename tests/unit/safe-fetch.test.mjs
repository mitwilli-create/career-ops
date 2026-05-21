import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, readText, readBuffer, fetchJson } from '../../lib/safe-fetch.mjs';

function makeStalledResponse() {
  let cancelled = false;
  const stallStream = new ReadableStream({
    start(controller) {
      // never enqueue anything — the read will hang forever without timeout
    },
    cancel() { cancelled = true; },
  });
  const r = new Response(stallStream, { status: 200, headers: { 'content-type': 'application/json' } });
  r.__cancelled = () => cancelled;
  return r;
}

function makeJsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeTextResponse(txt, status = 200) {
  return new Response(txt, { status, headers: { 'content-type': 'text/plain' } });
}

test('readJson resolves when body parses normally', async () => {
  const r = makeJsonResponse({ ok: true, n: 7 });
  const out = await readJson(r, 5_000);
  assert.deepEqual(out, { ok: true, n: 7 });
});

test('readJson times out on stalled body and rejects with timeout message', async () => {
  const r = makeStalledResponse();
  const t0 = Date.now();
  await assert.rejects(() => readJson(r, 200, 'unit-test'), /unit-test body-read timeout after 200ms/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 180 && elapsed < 1_500, `elapsed ${elapsed}ms should be ~200ms, was outside [180,1500]`);
});

test('readText resolves when body reads normally', async () => {
  const r = makeTextResponse('hello world');
  const out = await readText(r, 5_000);
  assert.equal(out, 'hello world');
});

test('readText times out on stalled body', async () => {
  const r = makeStalledResponse();
  await assert.rejects(() => readText(r, 150), /body-read timeout after 150ms/);
});

test('readBuffer resolves with ArrayBuffer for normal body', async () => {
  const r = makeTextResponse('abc');
  const buf = await readBuffer(r, 5_000);
  assert.equal(buf.byteLength, 3);
  assert.equal(new TextDecoder().decode(buf), 'abc');
});

test('readBuffer times out on stalled body', async () => {
  const r = makeStalledResponse();
  await assert.rejects(() => readBuffer(r, 150), /body-read timeout/);
});

test('fetchJson throws HTTP error with body excerpt on non-2xx', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => makeTextResponse('upstream blew up', 503);
  try {
    await assert.rejects(() => fetchJson('https://example/api', {}, { errPrefix: 't1' }), /HTTP 503: upstream blew up/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchJson returns parsed body on 2xx', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => makeJsonResponse({ id: 'abc' });
  try {
    const out = await fetchJson('https://example/api', {});
    assert.deepEqual(out, { id: 'abc' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchJson honors bodyTimeoutMs override', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => makeStalledResponse();
  try {
    await assert.rejects(
      () => fetchJson('https://example/api', {}, { bodyTimeoutMs: 100, errPrefix: 'override-test' }),
      /override-test body-read timeout after 100ms/
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('clamps absurd timeout values to a sane range', async () => {
  const r = makeJsonResponse({ ok: 1 });
  // negative / zero / NaN should fall back to default
  const out = await readJson(r, -5);
  assert.deepEqual(out, { ok: 1 });
});
