#!/usr/bin/env node
/**
 * tests/connection-close-fetch.test.mjs — unit tests for the Phase 0
 * connection-close fetch wrapper (lib/connection-close-fetch.mjs) that
 * replaced the apply-pack-polish globalThis.fetch monkey-patch.
 *
 * $0 — no network, no LLM. Mocked fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapFetchConnectionClose, normalizeHeaders } from '../lib/connection-close-fetch.mjs';

function mockFetch(calls) {
  return (input, init) => {
    calls.push({ input, init });
    return Promise.resolve({ ok: true });
  };
}

test('disabled mode is a pass-through — args forwarded untouched', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => false);
  const init = { method: 'POST', headers: { 'x-a': '1' }, body: 'b' };
  await f('https://example.test/', init);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init, init); // same object reference — no clone, no mutation
  assert.equal(calls[0].init.headers['Connection'], undefined);
  assert.equal(calls[0].init.keepalive, undefined);
});

test('enabled mode adds Connection: close + keepalive:false, preserves headers', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/', { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' } });
  const init = calls[0].init;
  assert.equal(init.headers.Connection, 'close');
  assert.equal(init.headers['x-api-key'], 'k');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.keepalive, false);
  assert.equal(init.method, 'POST');
});

test('enabled mode with no init still adds the header', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/');
  assert.equal(calls[0].init.headers.Connection, 'close');
  assert.equal(calls[0].init.keepalive, false);
});

test('Headers instance is normalized (old monkey-patch silently dropped these)', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/', { headers: new Headers({ 'X-Api-Key': 'secret' }) });
  const h = calls[0].init.headers;
  assert.equal(h.Connection, 'close');
  // Headers normalizes key case to lowercase
  assert.equal(h['x-api-key'], 'secret');
});

test('array-of-pairs headers are normalized', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/', { headers: [['a', '1'], ['b', '2']] });
  const h = calls[0].init.headers;
  assert.equal(h.Connection, 'close');
  assert.equal(h.a, '1');
  assert.equal(h.b, '2');
});

test('pre-existing lowercase connection header (plain object) is replaced, not duplicated', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/', { headers: { connection: 'keep-alive', 'x-a': '1' } });
  const h = calls[0].init.headers;
  const connKeys = Object.keys(h).filter(k => k.toLowerCase() === 'connection');
  assert.deepEqual(connKeys, ['Connection'], `exactly one canonical Connection key expected, got: ${connKeys.join(', ')}`);
  assert.equal(h.Connection, 'close');
  assert.equal(h['x-a'], '1');
});

test('pre-existing connection header via Headers instance is replaced, not duplicated', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  // Headers normalizes key case to lowercase 'connection' — the wrapper must
  // still end with exactly one canonical key set to close.
  await f('https://example.test/', { headers: new Headers({ Connection: 'keep-alive', 'X-B': '2' }) });
  const h = calls[0].init.headers;
  const connKeys = Object.keys(h).filter(k => k.toLowerCase() === 'connection');
  assert.deepEqual(connKeys, ['Connection']);
  assert.equal(h.Connection, 'close');
  assert.equal(h['x-b'], '2');
});

test('weird-cased CONNECTION key is also collapsed to the single canonical key', async () => {
  const calls = [];
  const f = wrapFetchConnectionClose(mockFetch(calls), () => true);
  await f('https://example.test/', { headers: { CONNECTION: 'upgrade' } });
  const h = calls[0].init.headers;
  assert.deepEqual(Object.keys(h).filter(k => k.toLowerCase() === 'connection'), ['Connection']);
  assert.equal(h.Connection, 'close');
});

test('isEnabled is evaluated per-request (mode can flip mid-process)', async () => {
  const calls = [];
  let on = false;
  const f = wrapFetchConnectionClose(mockFetch(calls), () => on);
  await f('https://example.test/');
  on = true;
  await f('https://example.test/');
  assert.equal(calls[0].init.headers?.Connection, undefined);
  assert.equal(calls[1].init.headers.Connection, 'close');
});

test('normalizeHeaders edge cases', () => {
  assert.deepEqual(normalizeHeaders(null), {});
  assert.deepEqual(normalizeHeaders(undefined), {});
  assert.deepEqual(normalizeHeaders({ a: '1' }), { a: '1' });
  assert.deepEqual(normalizeHeaders([['a', '1']]), { a: '1' });
  assert.deepEqual(normalizeHeaders('bogus'), {});
});

test('constructor guards throw on bad args', () => {
  assert.throws(() => wrapFetchConnectionClose(null, () => true), TypeError);
  assert.throws(() => wrapFetchConnectionClose(() => {}, null), TypeError);
});

test('council.mjs exports setConnectionCloseMode/isConnectionCloseMode and mode round-trips', async () => {
  const council = await import('../lib/council.mjs');
  assert.equal(typeof council.setConnectionCloseMode, 'function');
  assert.equal(typeof council.isConnectionCloseMode, 'function');
  const before = council.isConnectionCloseMode();
  council.setConnectionCloseMode(true);
  assert.equal(council.isConnectionCloseMode(), true);
  council.setConnectionCloseMode(false);
  assert.equal(council.isConnectionCloseMode(), false);
  council.setConnectionCloseMode(before);
});

test('no globalThis.fetch monkey-patch remains in lib/ or scripts/ (Phase 0 exit-gate grep)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let out = '';
  try {
    // Match assignment forms: `globalThis.fetch =` (not reads/comments mentioning it)
    out = execFileSync('grep', ['-rEn', String.raw`globalThis\.fetch\s*=[^=]`, 'lib', 'scripts', 'dashboard-server.mjs'], {
      cwd: root, encoding: 'utf-8',
    });
  } catch (err) {
    // grep exits 1 on no matches — that is the PASS condition
    if (err.status === 1) out = '';
    else throw err;
  }
  assert.equal(out.trim(), '', `globalThis.fetch assignment found:\n${out}`);
});
