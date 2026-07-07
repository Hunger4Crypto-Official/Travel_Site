import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/accounts/passwords.js';

test('hash and verify round trip succeeds', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
});

test('wrong password returns false', () => {
  const stored = hashPassword('correct horse battery');
  assert.equal(verifyPassword('wrong password!!', stored), false);
});

test('two hashes of the same password differ (random salt)', () => {
  const a = hashPassword('same-password-here');
  const b = hashPassword('same-password-here');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same-password-here', a), true);
  assert.equal(verifyPassword('same-password-here', b), true);
});

test('hashPassword throws 400 for non-string', () => {
  assert.throws(() => hashPassword(12345678), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'password must be a string');
    return true;
  });
});

test('hashPassword throws 400 for empty string', () => {
  assert.throws(() => hashPassword(''), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'password must not be empty');
    return true;
  });
});

test('hashPassword throws 400 for too-short password', () => {
  assert.throws(() => hashPassword('short'), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'password must be at least 8 characters');
    return true;
  });
});

test('verifyPassword returns false for non-string plain', () => {
  const stored = hashPassword('valid-password-1');
  assert.equal(verifyPassword(null, stored), false);
});

test('verifyPassword returns false for non-string stored', () => {
  assert.equal(verifyPassword('valid-password-1', null), false);
});

test('verifyPassword returns false for wrong field count', () => {
  assert.equal(verifyPassword('valid-password-1', 'scrypt$16384$8$1'), false);
});

test('verifyPassword returns false for wrong prefix', () => {
  const stored = hashPassword('valid-password-1');
  const bad = stored.replace(/^scrypt/, 'bcrypt');
  assert.equal(verifyPassword('valid-password-1', bad), false);
});

test('verifyPassword returns false for bad base64 in salt or hash', () => {
  const parts = hashPassword('valid-password-1').split('$');
  parts[4] = 'not*valid*base64';
  assert.equal(verifyPassword('valid-password-1', parts.join('$')), false);
});

test('verifyPassword returns false for hash-length mismatch', () => {
  const parts = hashPassword('valid-password-1').split('$');
  parts[5] = Buffer.from('too-short').toString('base64url');
  assert.equal(verifyPassword('valid-password-1', parts.join('$')), false);
});
