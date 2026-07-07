import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/accounts/passwords.js';

test('hash and verify round trip succeeds', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
});

test('wrong password returns false', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('wrong password!!', stored), false);
});

test('two hashes of the same password differ (random salt)', async () => {
  const a = await hashPassword('same-password-here');
  const b = await hashPassword('same-password-here');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-here', a), true);
  assert.equal(await verifyPassword('same-password-here', b), true);
});

test('hashPassword rejects with 400 for non-string', async () => {
  await assert.rejects(() => hashPassword(12345678), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'password must be a string');
    return true;
  });
});

test('hashPassword rejects with 400 for empty string', async () => {
  await assert.rejects(() => hashPassword(''), (err) => err.statusCode === 400 && err.message === 'password must not be empty');
});

test('hashPassword rejects with 400 for too-short password', async () => {
  await assert.rejects(() => hashPassword('short'), (err) => err.statusCode === 400 && err.message === 'password must be at least 8 characters');
});

test('verifyPassword returns false for non-string plain', async () => {
  const stored = await hashPassword('valid-password-1');
  assert.equal(await verifyPassword(null, stored), false);
});

test('verifyPassword returns false for non-string stored', async () => {
  assert.equal(await verifyPassword('valid-password-1', null), false);
});

test('verifyPassword returns false for wrong field count', async () => {
  assert.equal(await verifyPassword('valid-password-1', 'scrypt$16384$8$1'), false);
});

test('verifyPassword returns false for wrong prefix', async () => {
  const stored = await hashPassword('valid-password-1');
  const bad = stored.replace(/^scrypt/, 'bcrypt');
  assert.equal(await verifyPassword('valid-password-1', bad), false);
});

test('verifyPassword returns false for bad base64 in salt or hash', async () => {
  const parts = (await hashPassword('valid-password-1')).split('$');
  parts[4] = 'not*valid*base64';
  assert.equal(await verifyPassword('valid-password-1', parts.join('$')), false);
});

test('verifyPassword returns false for hash-length mismatch', async () => {
  const parts = (await hashPassword('valid-password-1')).split('$');
  parts[5] = Buffer.from('too-short').toString('base64url');
  assert.equal(await verifyPassword('valid-password-1', parts.join('$')), false);
});
