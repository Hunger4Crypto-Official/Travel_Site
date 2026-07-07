import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../../src/accounts/sessions.js';

const SECRET = 'test-secret-key';

test('factory throws when secret is missing', () => {
  assert.throws(() => createSessionManager({}), /secret must be a non-empty string/);
});

test('factory throws when secret is an empty string', () => {
  assert.throws(() => createSessionManager({ secret: '' }), /secret must be a non-empty string/);
});

test('issue rejects a non-string userId with a 400', () => {
  const mgr = createSessionManager({ secret: SECRET });
  assert.throws(() => mgr.issue(42), (err) => err.statusCode === 400);
});

test('issue rejects an empty userId with a 400', () => {
  const mgr = createSessionManager({ secret: SECRET });
  assert.throws(() => mgr.issue(''), (err) => err.statusCode === 400);
});

test('round-trip issue then verify returns the userId and exp', () => {
  const mgr = createSessionManager({ secret: SECRET, ttlMs: 1000, now: () => 5000 });
  const token = mgr.issue('user-1');
  const claims = mgr.verify(token);
  assert.deepEqual(claims, { userId: 'user-1', exp: 6000 });
});

test('verify returns null for a tampered payload', () => {
  const mgr = createSessionManager({ secret: SECRET });
  const token = mgr.issue('user-1');
  const [payloadB64, sigB64] = token.split('.');
  const flipped = (payloadB64[0] === 'e' ? 'f' : 'e') + payloadB64.slice(1);
  assert.equal(mgr.verify(`${flipped}.${sigB64}`), null);
});

test('verify returns null for a tampered signature of equal length', () => {
  const mgr = createSessionManager({ secret: SECRET });
  const token = mgr.issue('user-1');
  const [payloadB64, sigB64] = token.split('.');
  const flipped = (sigB64[0] === 'A' ? 'B' : 'A') + sigB64.slice(1);
  assert.equal(mgr.verify(`${payloadB64}.${flipped}`), null);
});

test('verify returns null when the part count is wrong', () => {
  const mgr = createSessionManager({ secret: SECRET });
  assert.equal(mgr.verify('a.b.c'), null);
  assert.equal(mgr.verify('onlyonepart'), null);
});

test('verify returns null for a non-string token', () => {
  const mgr = createSessionManager({ secret: SECRET });
  assert.equal(mgr.verify(null), null);
  assert.equal(mgr.verify(123), null);
});

test('verify returns null for an expired token', () => {
  let clock = 1000;
  const mgr = createSessionManager({ secret: SECRET, ttlMs: 500, now: () => clock });
  const token = mgr.issue('user-1');
  clock = 2000; // now() > exp (1500)
  assert.equal(mgr.verify(token), null);
});

test('verify returns null when signature lengths differ', () => {
  const mgr = createSessionManager({ secret: SECRET });
  // "b" is far shorter than a real base64url sha256 signature.
  assert.equal(mgr.verify('a.b'), null);
});

test('verify returns null for a payload that is not valid JSON', () => {
  const mgr = createSessionManager({ secret: SECRET });
  // Sign a payload that decodes to non-JSON bytes so the signature passes but
  // JSON.parse throws.
  const payloadB64 = Buffer.from('not json', 'utf8').toString('base64url');
  const sigB64 = createSig(payloadB64);
  assert.equal(mgr.verify(`${payloadB64}.${sigB64}`), null);
});

test('verify returns null when the payload is missing uid', () => {
  const mgr = createSessionManager({ secret: SECRET });
  const payloadB64 = Buffer.from(JSON.stringify({ exp: 9e15 }), 'utf8').toString('base64url');
  const sigB64 = createSig(payloadB64);
  assert.equal(mgr.verify(`${payloadB64}.${sigB64}`), null);
});

test('verify returns null when the payload is missing exp', () => {
  const mgr = createSessionManager({ secret: SECRET });
  const payloadB64 = Buffer.from(JSON.stringify({ uid: 'user-1' }), 'utf8').toString('base64url');
  const sigB64 = createSig(payloadB64);
  assert.equal(mgr.verify(`${payloadB64}.${sigB64}`), null);
});

// Helper mirroring the module's signing so tests can forge validly-signed
// payloads with hostile contents.
import { createHmac } from 'node:crypto';
function createSig(payloadB64) {
  return createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}
