import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService, publicUser } from '../../src/accounts/accountService.js';

// Deterministic fake session manager: token encodes the user id.
function fakeSessions() {
  return {
    issued: [],
    issue(userId) { this.issued.push(userId); return `tok:${userId}`; },
    verify(token) {
      return typeof token === 'string' && token.startsWith('tok:')
        ? { userId: token.slice(4), exp: 999 }
        : null;
    }
  };
}

function makeService() {
  let n = 0;
  const store = new AccountStore({ now: () => 1000, idFactory: () => `u${++n}` });
  const sessions = fakeSessions();
  return { service: new AccountService({ store, sessions }), store, sessions };
}

test('signup normalizes email, hashes password, issues a session', () => {
  const { service, store } = makeService();
  const { user, token } = service.signup({ email: '  Ada@Example.COM ', password: 'correct-horse' });
  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.tier, 'free');
  assert.equal(user.role, 'member');
  assert.equal(user.memberRates, false);
  assert.ok(Array.isArray(user.benefits));
  assert.equal(token, `tok:${user.id}`);
  assert.equal(user.passwordHash, undefined, 'public user never leaks the hash');
  // The stored record does carry a hash, and it is not the plaintext.
  assert.notEqual(store.get(user.id).passwordHash, 'correct-horse');
});

test('signup rejects a malformed email and a weak password', () => {
  const { service } = makeService();
  assert.throws(() => service.signup({ email: 'nope', password: 'correct-horse' }), (e) => e.statusCode === 400);
  assert.throws(() => service.signup({ email: 123, password: 'correct-horse' }), (e) => e.statusCode === 400);
  assert.throws(() => service.signup({ email: 'a@b.com', password: 'short' }), (e) => e.statusCode === 400);
});

test('signup surfaces the duplicate-email conflict', () => {
  const { service } = makeService();
  service.signup({ email: 'dup@x.com', password: 'correct-horse' });
  assert.throws(() => service.signup({ email: 'dup@x.com', password: 'another-one' }), (e) => e.statusCode === 409);
});

test('login succeeds with the right password and issues a session', () => {
  const { service } = makeService();
  const created = service.signup({ email: 'log@x.com', password: 'correct-horse' });
  const { user, token } = service.login({ email: 'LOG@x.com', password: 'correct-horse' });
  assert.equal(user.id, created.user.id);
  assert.equal(token, `tok:${user.id}`);
});

test('login fails for unknown user, wrong password, and missing password', () => {
  const { service } = makeService();
  service.signup({ email: 'log2@x.com', password: 'correct-horse' });
  assert.throws(() => service.login({ email: 'ghost@x.com', password: 'correct-horse' }), (e) => e.statusCode === 401);
  assert.throws(() => service.login({ email: 'log2@x.com', password: 'wrong-password' }), (e) => e.statusCode === 401);
  assert.throws(() => service.login({ email: 'log2@x.com' }), (e) => e.statusCode === 401);
  assert.throws(() => service.login({ email: 'bad' }), (e) => e.statusCode === 400);
});

test('identify resolves a valid token, and is null for invalid or vanished user', () => {
  const { service, store } = makeService();
  const { user } = service.signup({ email: 'id@x.com', password: 'correct-horse' });
  const found = service.identify(`tok:${user.id}`);
  assert.equal(found.user.id, user.id);
  assert.equal(found.session.userId, user.id);
  assert.equal(service.identify('garbage'), null);
  assert.equal(service.identify(null), null);
  // Valid signature but the user no longer exists.
  store.byId.delete(user.id);
  assert.equal(service.identify(`tok:${user.id}`), null);
});

test('me returns the public shape', () => {
  const { service } = makeService();
  const { user } = service.signup({ email: 'me@x.com', password: 'correct-horse' });
  const full = service.store.get(user.id);
  assert.deepEqual(service.me(full), publicUser(full));
});

test('setTier updates a known tier, rejects unknown, and is null for a missing user', () => {
  const { service } = makeService();
  const { user } = service.signup({ email: 'tier@x.com', password: 'correct-horse' });
  const upgraded = service.setTier(user.id, 'gold');
  assert.equal(upgraded.tier, 'gold');
  assert.equal(upgraded.memberRates, true);
  assert.throws(() => service.setTier(user.id, 'platinum-plus'), (e) => e.statusCode === 400);
  assert.equal(service.setTier('missing-user', 'gold'), null);
});

test('publicUser falls back to the default tier and default loyalty when unknown', () => {
  const shaped = publicUser({ id: 'z', email: 'z@x.com', role: 'member', tier: 'bogus', createdAt: 1 });
  assert.equal(shaped.tier, 'free', 'unknown tier falls back to the default');
  assert.equal(shaped.loyaltyPoints, 0, 'missing loyaltyPoints defaults to 0');
  assert.equal(shaped.subscriptionStatus, null, 'no subscription defaults to null');
  assert.equal(shaped.subscriptionTier, null);
});
