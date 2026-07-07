import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService, publicUser } from '../../src/accounts/accountService.js';

// Deterministic fake session manager: the token encodes the user id and the
// token generation, so revocation can be exercised without real crypto.
function fakeSessions() {
  return {
    issue(userId, gen = 0) { return `tok:${userId}:${gen}`; },
    verify(token) {
      if (typeof token !== 'string' || !token.startsWith('tok:')) return null;
      const rest = token.slice(4);
      const idx = rest.lastIndexOf(':');
      return { userId: rest.slice(0, idx), gen: Number(rest.slice(idx + 1)), exp: 999 };
    }
  };
}

function makeService() {
  let n = 0;
  const store = new AccountStore({ now: () => 1000, idFactory: () => `u${++n}` });
  return { service: new AccountService({ store, sessions: fakeSessions() }), store };
}

test('signup normalizes email, hashes password, issues a session', async () => {
  const { service, store } = makeService();
  const { user, token } = await service.signup({ email: '  Ada@Example.COM ', password: 'correct-horse' });
  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.tier, 'free');
  assert.equal(user.role, 'member');
  assert.equal(user.memberRates, false);
  assert.ok(Array.isArray(user.benefits));
  assert.equal(token, `tok:${user.id}:0`);
  assert.equal(user.passwordHash, undefined, 'public user never leaks the hash');
  assert.notEqual(store.get(user.id).passwordHash, 'correct-horse');
});

test('signup rejects a malformed email and a weak password', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.signup({ email: 'nope', password: 'correct-horse' }), (e) => e.statusCode === 400);
  await assert.rejects(() => service.signup({ email: 123, password: 'correct-horse' }), (e) => e.statusCode === 400);
  await assert.rejects(() => service.signup({ email: 'a@b.com', password: 'short' }), (e) => e.statusCode === 400);
});

test('signup surfaces the duplicate-email conflict', async () => {
  const { service } = makeService();
  await service.signup({ email: 'dup@x.com', password: 'correct-horse' });
  await assert.rejects(() => service.signup({ email: 'dup@x.com', password: 'another-one' }), (e) => e.statusCode === 409);
});

test('login succeeds with the right password and issues a session', async () => {
  const { service } = makeService();
  const created = await service.signup({ email: 'log@x.com', password: 'correct-horse' });
  const { user, token } = await service.login({ email: 'LOG@x.com', password: 'correct-horse' });
  assert.equal(user.id, created.user.id);
  assert.equal(token, `tok:${user.id}:0`);
});

test('login fails for unknown user, wrong password, and missing password', async () => {
  const { service } = makeService();
  await service.signup({ email: 'log2@x.com', password: 'correct-horse' });
  await assert.rejects(() => service.login({ email: 'ghost@x.com', password: 'correct-horse' }), (e) => e.statusCode === 401);
  await assert.rejects(() => service.login({ email: 'log2@x.com', password: 'wrong-password' }), (e) => e.statusCode === 401);
  await assert.rejects(() => service.login({ email: 'log2@x.com' }), (e) => e.statusCode === 401);
  await assert.rejects(() => service.login({ email: 'bad' }), (e) => e.statusCode === 400);
});

test('identify resolves a valid token, and is null for invalid or vanished user', async () => {
  const { service, store } = makeService();
  const { user, token } = await service.signup({ email: 'id@x.com', password: 'correct-horse' });
  const found = service.identify(token);
  assert.equal(found.user.id, user.id);
  assert.equal(found.session.userId, user.id);
  assert.equal(service.identify('garbage'), null);
  assert.equal(service.identify(null), null);
  store.byId.delete(user.id);
  assert.equal(service.identify(token), null);
});

test('logout invalidates existing tokens (generation bump)', async () => {
  const { service } = makeService();
  const { user, token } = await service.signup({ email: 'out@x.com', password: 'correct-horse' });
  assert.ok(service.identify(token), 'the token is valid before logout');
  service.logout(user);
  assert.equal(service.identify(token), null, 'the old token no longer verifies after logout');
  // A fresh login mints a token at the new generation, which does verify.
  const relogin = await service.login({ email: 'out@x.com', password: 'correct-horse' });
  assert.ok(service.identify(relogin.token));
});

test('identify and logout tolerate a legacy user without a tokenGeneration field', () => {
  const { service, store } = makeService();
  store.byId.set('legacy', { id: 'legacy', email: 'l@x.com', passwordHash: 'h', tier: 'free', role: 'member' });
  assert.ok(service.identify('tok:legacy:0'), 'a generation-less user verifies at generation 0');
  service.logout(store.get('legacy'));
  assert.equal(store.get('legacy').tokenGeneration, 1);
  assert.equal(service.identify('tok:legacy:0'), null, 'the old token is now stale');
});

test('me returns the public shape', async () => {
  const { service } = makeService();
  const { user } = await service.signup({ email: 'me@x.com', password: 'correct-horse' });
  const full = service.store.get(user.id);
  assert.deepEqual(service.me(full), publicUser(full));
});

test('setTier updates a known tier, rejects unknown, and is null for a missing user', async () => {
  const { service } = makeService();
  const { user } = await service.signup({ email: 'tier@x.com', password: 'correct-horse' });
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
