// tests/staging-host-gate.test.mjs
//
// Verifies lib/staging-host-gate.mjs — the origin Host-gate that closes the
// no-auth staging dashboard exposure (2026-07-09, PR #418):
//   - non-staging Hosts (prod, localhost) always pass
//   - staging Hosts require a configured secret AND a matching token
//   - fail-closed when no secret is configured
//   - timing-safe compare rejects wrong / short / long / empty / non-string tokens
//   - both staging-dashboard.* and staging-origin.* are gated (shared chokepoint)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStagingHost,
  safeTokenEquals,
  isStagingRequestAuthorized,
} from '../lib/staging-host-gate.mjs';

const SECRET = 'a'.repeat(64);

describe('isStagingHost', () => {
  test('matches both staging hostnames (case-insensitive)', () => {
    assert.equal(isStagingHost('staging-dashboard.careers-ops.com'), true);
    assert.equal(isStagingHost('staging-origin.careers-ops.com'), true);
    assert.equal(isStagingHost('STAGING-Dashboard.careers-ops.com'), true);
  });
  test('does not match prod / localhost / missing', () => {
    assert.equal(isStagingHost('dashboard.careers-ops.com'), false);
    assert.equal(isStagingHost('localhost:3097'), false);
    assert.equal(isStagingHost('127.0.0.1:3097'), false);
    assert.equal(isStagingHost(undefined), false);
    assert.equal(isStagingHost(''), false);
  });
});

describe('safeTokenEquals', () => {
  test('true only on exact equal-length match', () => {
    assert.equal(safeTokenEquals(SECRET, SECRET), true);
  });
  test('false on mismatch / length diff / empty / non-string', () => {
    assert.equal(safeTokenEquals(SECRET, 'b'.repeat(64)), false);
    assert.equal(safeTokenEquals(SECRET, SECRET + 'x'), false); // unequal length must not throw
    assert.equal(safeTokenEquals(SECRET, 'short'), false);      // short token
    assert.equal(safeTokenEquals('', ''), false);
    assert.equal(safeTokenEquals(SECRET, ''), false);
    assert.equal(safeTokenEquals(undefined, SECRET), false);
    assert.equal(safeTokenEquals(SECRET, undefined), false);
    assert.equal(safeTokenEquals(null, null), false);
    // Non-string inputs must be rejected without throwing or coercing.
    assert.equal(safeTokenEquals(SECRET, 12345), false);
    assert.equal(safeTokenEquals(12345, 12345), false);
    assert.equal(safeTokenEquals(SECRET, { toString: () => SECRET }), false);
    assert.equal(safeTokenEquals(SECRET, Buffer.from(SECRET)), false);
  });
});

describe('isStagingRequestAuthorized', () => {
  test('non-staging Hosts always pass, regardless of token/secret', () => {
    assert.equal(isStagingRequestAuthorized('dashboard.careers-ops.com', undefined, undefined), true);
    assert.equal(isStagingRequestAuthorized('localhost:3097', undefined, SECRET), true);
    assert.equal(isStagingRequestAuthorized('localhost:3097', 'anything', SECRET), true);
  });

  test('fail-closed: staging Host with no configured secret is refused', () => {
    assert.equal(isStagingRequestAuthorized('staging-dashboard.careers-ops.com', SECRET, undefined), false);
    assert.equal(isStagingRequestAuthorized('staging-dashboard.careers-ops.com', SECRET, ''), false);
  });

  test('staging Host: correct token authorizes, wrong/missing does not (both hostnames)', () => {
    for (const host of ['staging-dashboard.careers-ops.com', 'staging-origin.careers-ops.com']) {
      assert.equal(isStagingRequestAuthorized(host, SECRET, SECRET), true, `${host} correct token`);
      assert.equal(isStagingRequestAuthorized(host, 'wrong', SECRET), false, `${host} wrong token`);
      assert.equal(isStagingRequestAuthorized(host, undefined, SECRET), false, `${host} missing token`);
      assert.equal(isStagingRequestAuthorized(host, '', SECRET), false, `${host} empty token`);
    }
  });
});
